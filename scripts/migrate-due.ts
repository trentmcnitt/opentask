#!/usr/bin/env tsx
/**
 * Due App → OpenTask Migration Script
 *
 * Migrates tasks from Due app export (JSON) to OpenTask database.
 *
 * Usage:
 *   npx tsx scripts/migrate-due.ts [--input PATH] [--dry-run] [--clear]
 *
 * Options:
 *   --input PATH   Path to Due export JSON (default: latest in ~/working_dir/todo-manager/data/)
 *   --dry-run      Preview changes without writing to database
 *   --clear        Clear existing tasks before import (use with caution!)
 */

import * as fs from 'fs'
import * as path from 'path'
import { DateTime } from 'luxon'
import { getDb } from '@/core/db'
import { RRule, Weekday } from 'rrule'

// Types for Due export format
interface DueReminder {
  title: string
  due_date: string // ISO 8601 with timezone
  created: string
  modified: string
  original_uuid: string
  snooze_interval_seconds: number
  recurrence?: {
    frequency: 'daily' | 'weekly' | 'monthly' | 'yearly'
    interval: number
    days?: string[] // ["MO", "TU", etc.] for weekly
  }
  critical?: boolean
}

interface DueExport {
  exported_at: string
  source: string
  stats: {
    total: number
    recurring: number
    one_offs: number
    critical: number
  }
  categories: Record<string, number>
  reminders: DueReminder[]
}

// Prefix to label mapping
const PREFIX_LABELS: Record<string, string> = {
  M: 'morning',
  A: 'afternoon',
  E: 'evening',
  N: 'night',
  EM: 'early-morning',
  LM: 'late-morning',
  EE: 'early-evening',
  W: 'weekly',
  Weekend: 'weekend',
  Weekly: 'weekly',
  Monthly: 'monthly',
  'Tri-Monthly': 'tri-monthly',
}

// User timezone (from config/user settings)
const USER_TIMEZONE = 'America/Chicago'

interface MigrationResult {
  imported: number
  skipped: number
  errors: string[]
}

/**
 * Extract prefix and clean title
 * "[M] Take vitamins" → { prefix: "M", title: "Take vitamins" }
 */
function parseTitle(title: string): { prefix: string | null; cleanTitle: string } {
  const match = title.match(/^\[([^\]]+)\]\s*(.*)$/)
  if (match) {
    return { prefix: match[1], cleanTitle: match[2] }
  }
  return { prefix: null, cleanTitle: title }
}

/**
 * Convert Due recurrence to RRULE string
 */
function convertToRRule(recurrence: DueReminder['recurrence'], dueDate: DateTime): string | null {
  if (!recurrence) return null

  const { frequency, interval, days } = recurrence

  // Map frequency to RRule constant
  const freqMap: Record<string, number> = {
    daily: RRule.DAILY,
    weekly: RRule.WEEKLY,
    monthly: RRule.MONTHLY,
    yearly: RRule.YEARLY,
  }

  const freq = freqMap[frequency]
  if (freq === undefined) {
    console.warn(`Unknown frequency: ${frequency}`)
    return null
  }

  const options: Partial<{
    freq: number
    interval: number
    byhour: number[]
    byminute: number[]
    byweekday: Weekday[]
    bymonthday: number[]
    tzid: string
  }> = {
    freq,
    interval: interval || 1,
    byhour: [dueDate.hour],
    byminute: [dueDate.minute],
    tzid: USER_TIMEZONE,
  }

  // Handle weekly with specific days
  if (frequency === 'weekly' && days && days.length > 0) {
    const dayMap: Record<string, Weekday> = {
      MO: RRule.MO,
      TU: RRule.TU,
      WE: RRule.WE,
      TH: RRule.TH,
      FR: RRule.FR,
      SA: RRule.SA,
      SU: RRule.SU,
    }
    options.byweekday = days.map((d) => dayMap[d]).filter(Boolean)
  }

  // Handle monthly - add BYMONTHDAY
  if (frequency === 'monthly') {
    options.bymonthday = [dueDate.day]
  }

  // Build RRULE
  const rule = new RRule(options as ConstructorParameters<typeof RRule>[0])
  return rule.toString().replace('RRULE:', '')
}

/**
 * Derive anchor fields from due date
 */
function deriveAnchors(dueDate: DateTime): {
  anchor_time: string
  anchor_dow: number | null
  anchor_dom: number | null
} {
  return {
    anchor_time: dueDate.toFormat('HH:mm'),
    anchor_dow: dueDate.weekday - 1, // luxon: 1=Mon, we want 0=Mon
    anchor_dom: dueDate.day,
  }
}

/**
 * Find the latest Due export file
 */
function findLatestExport(): string | null {
  const dataDir = path.join(process.env.HOME || '', 'working_dir/todo-manager/data')

  if (!fs.existsSync(dataDir)) {
    return null
  }

  const files = fs
    .readdirSync(dataDir)
    .filter((f) => f.startsWith('due-export-') && f.endsWith('.json'))
    .sort()
    .reverse()

  return files.length > 0 ? path.join(dataDir, files[0]) : null
}

/**
 * Parse command line arguments
 */
function parseArgs(): { input: string | null; dryRun: boolean; clear: boolean } {
  const args = process.argv.slice(2)
  let input: string | null = null
  let dryRun = false
  let clear = false

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' && args[i + 1]) {
      input = args[++i]
    } else if (args[i] === '--dry-run') {
      dryRun = true
    } else if (args[i] === '--clear') {
      clear = true
    }
  }

  return { input, dryRun, clear }
}

/**
 * Main migration function
 */
async function migrate(): Promise<MigrationResult> {
  const { input, dryRun, clear } = parseArgs()

  // Find input file
  const inputPath = input || findLatestExport()
  if (!inputPath) {
    console.error('No Due export file found. Use --input to specify path.')
    process.exit(1)
  }

  console.log(`Reading Due export from: ${inputPath}`)
  const exportData: DueExport = JSON.parse(fs.readFileSync(inputPath, 'utf-8'))

  console.log(`\nExport stats:`)
  console.log(`  Total: ${exportData.stats.total}`)
  console.log(`  Recurring: ${exportData.stats.recurring}`)
  console.log(`  One-offs: ${exportData.stats.one_offs}`)
  console.log(`  Critical: ${exportData.stats.critical}`)

  if (dryRun) {
    console.log('\n--- DRY RUN MODE ---\n')
  }

  // Get database (initializes automatically)
  const db = getDb()

  // Get default user and inbox project
  const user = db.prepare('SELECT id, timezone FROM users LIMIT 1').get() as
    | { id: number; timezone: string }
    | undefined
  if (!user) {
    console.error('No user found. Run seed script first.')
    process.exit(1)
  }

  const inbox = db
    .prepare('SELECT id FROM projects WHERE owner_id = ? AND name = ?')
    .get(user.id, 'Inbox') as { id: number } | undefined
  if (!inbox) {
    console.error('No inbox project found. Run seed script first.')
    process.exit(1)
  }

  // Clear existing tasks if requested
  if (clear && !dryRun) {
    console.log('Clearing existing tasks...')
    db.prepare('DELETE FROM tasks WHERE user_id = ?').run(user.id)
    db.prepare('DELETE FROM undo_log WHERE user_id = ?').run(user.id)
    db.prepare('DELETE FROM completions WHERE user_id = ?').run(user.id)
  }

  const result: MigrationResult = {
    imported: 0,
    skipped: 0,
    errors: [],
  }

  // Prepare insert statement
  const insertStmt = db.prepare(`
    INSERT INTO tasks (
      user_id, project_id, title, done, priority, due_at,
      rrule, recurrence_mode, anchor_time, anchor_dow, anchor_dom,
      labels, created_at, updated_at
    ) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  // Process each reminder
  for (const reminder of exportData.reminders) {
    try {
      // Parse due date
      const dueDate = DateTime.fromISO(reminder.due_date, { zone: USER_TIMEZONE })
      if (!dueDate.isValid) {
        result.errors.push(`Invalid due date for "${reminder.title}": ${reminder.due_date}`)
        result.skipped++
        continue
      }

      // Parse title and extract prefix
      const { prefix } = parseTitle(reminder.title)

      // Build labels array
      const labels: string[] = []
      if (prefix && PREFIX_LABELS[prefix]) {
        labels.push(PREFIX_LABELS[prefix])
      } else if (prefix) {
        // Keep unknown prefixes as labels too
        labels.push(prefix.toLowerCase())
      }
      if (reminder.critical) {
        labels.push('critical')
      }

      // Convert recurrence to RRULE
      const rrule = convertToRRule(reminder.recurrence, dueDate)

      // Derive anchor fields
      const anchors = rrule
        ? deriveAnchors(dueDate)
        : { anchor_time: null, anchor_dow: null, anchor_dom: null }

      // Priority: critical = 4, others = 0
      const priority = reminder.critical ? 4 : 0

      // Keep original title with prefix for now (can strip later if desired)
      const title = reminder.title

      // Timestamps
      const createdAt = DateTime.fromISO(reminder.created).toISO()
      const updatedAt = DateTime.fromISO(reminder.modified).toISO()
      const dueAt = dueDate.toUTC().toISO()

      if (dryRun) {
        console.log(`\nWould import: "${title}"`)
        console.log(`  Due: ${dueAt}`)
        console.log(`  RRULE: ${rrule || '(one-off)'}`)
        console.log(`  Labels: ${JSON.stringify(labels)}`)
        console.log(`  Priority: ${priority}`)
        result.imported++
      } else {
        insertStmt.run(
          user.id,
          inbox.id,
          title,
          priority,
          dueAt,
          rrule,
          'from_due', // default recurrence mode
          anchors.anchor_time,
          anchors.anchor_dow,
          anchors.anchor_dom,
          JSON.stringify(labels),
          createdAt,
          updatedAt,
        )
        result.imported++
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      result.errors.push(`Error importing "${reminder.title}": ${msg}`)
      result.skipped++
    }
  }

  return result
}

// Run migration
migrate()
  .then((result) => {
    console.log('\n=== Migration Complete ===')
    console.log(`Imported: ${result.imported}`)
    console.log(`Skipped: ${result.skipped}`)

    if (result.errors.length > 0) {
      console.log(`\nErrors (${result.errors.length}):`)
      result.errors.forEach((e) => console.log(`  - ${e}`))
    }
  })
  .catch((err) => {
    console.error('Migration failed:', err)
    process.exit(1)
  })
