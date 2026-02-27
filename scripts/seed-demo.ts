/**
 * Demo user seed script for OpenTask
 *
 * Creates a demo user with curated portfolio-style tasks:
 * - "Try It" project: interactive onboarding for visitors
 * - "Client Work" project: skill-signaling professional tasks
 * - Inbox: CTA task
 *
 * Does NOT touch other users. Safe to run on a production database.
 *
 * Usage: npm run db:seed-demo
 *
 * The seedDemoUser() function is also used by reset-demo-user.ts
 * to rebuild demo data on a daily cron.
 */

import bcrypt from 'bcrypt'
import Database from 'better-sqlite3'
import { DateTime } from 'luxon'
import { getDb, closeDb } from '../src/core/db'
import { hashToken, tokenPreview } from '../src/core/auth/token-hash'
import { deriveAnchorFields } from '../src/core/recurrence/anchor-derivation'
import { RRulePatterns, parseRRule } from '../src/core/recurrence/rrule-builder'
import { localToUtc } from '../src/core/recurrence/timezone'

const TIMEZONE = 'America/Chicago'
const SALT_ROUNDS = 10

// Day-of-week constants (0=Mon..6=Sun) used by RRulePatterns
const MON = 0,
  THU = 3

// Priority constants
const UNSET = 0,
  LOW = 1,
  MED = 2,
  HIGH = 3

type ProjectName = 'Inbox' | 'Client Work' | 'Try It'
type ProjectMap = Record<ProjectName, number>

interface DemoTaskDef {
  title: string
  project: ProjectName
  rrule?: string
  /** Days from today for due date. Ignored when noDue is true. */
  dueOffset?: number
  hour?: number
  min?: number
  priority?: number
  notes?: string
  done?: boolean
  /** When true, skip due date computation entirely (task has no due date) */
  noDue?: boolean
  /** How many days ago the task was created (for realistic created_at). Default: 3 */
  createdDaysAgo?: number
}

// ── Helpers ──────────────────────────────────

/**
 * Returns the number of days from today until the next occurrence of
 * the given ISO weekday(s) (1=Mon..7=Sun). Always returns at least
 * `minDays` (default 1) so tasks are never due today — prevents
 * accidental overdue after the daily 3 AM reset.
 */
function daysUntilWeekday(isoWeekdays: number | number[], minDays: number = 1): number {
  const weekdays = Array.isArray(isoWeekdays) ? isoWeekdays : [isoWeekdays]
  const today = DateTime.now().setZone(TIMEZONE)
  for (let d = minDays; d <= 7 + minDays; d++) {
    if (weekdays.includes(today.plus({ days: d }).weekday)) return d
  }
  return minDays
}

function localToUtcIso(daysOffset: number, hour: number, minute: number): string {
  const local = DateTime.now()
    .setZone(TIMEZONE)
    .plus({ days: daysOffset })
    .set({ hour, minute, second: 0, millisecond: 0 })
  return localToUtc(local)
}

// ── Task definitions ──────────────────────────────────

function getDemoTasks(): DemoTaskDef[] {
  const TRY_IT_TASKS: DemoTaskDef[] = [
    {
      title:
        "Try adding a task — type 'Set up weekly standup every Monday at 10am' in the box above",
      project: 'Try It',
      noDue: true,
      createdDaysAgo: 3,
      notes:
        'OpenTask uses AI to parse natural language into structured tasks. Try it yourself — type or paste the text above and watch the AI enrich it.',
    },
    {
      title: "Try voice input — say 'Review deployment pipeline Friday afternoon medium priority'",
      project: 'Try It',
      noDue: true,
      createdDaysAgo: 3,
      notes: 'Works with Siri, dictation, or just typing. The AI handles the rest.',
    },
    {
      title: 'Learn about OpenTask',
      project: 'Try It',
      noDue: true,
      createdDaysAgo: 3,
      notes: [
        'Swipe right on a task to snooze, left to complete',
        'Long-press a task for quick actions (priority, snooze presets)',
        'Bulk select: tap the circle on any task, then use the action bar',
        '"What\'s Next" — AI surfaces tasks you might be overlooking',
        'Recurring tasks with natural language ("every weekday at 9am")',
        'Works on iOS, Apple Watch, and as a PWA on any device',
        'Built with Claude Code + Claude Agent SDK',
      ].join('\n'),
    },
    {
      title: 'Try completing this task — swipe right or tap the circle',
      project: 'Try It',
      dueOffset: -1,
      hour: 15,
      createdDaysAgo: 2,
      notes: 'This task is intentionally overdue so you can practice completing it.',
    },
  ]

  const CLIENT_WORK_TASKS: DemoTaskDef[] = [
    {
      title: 'Prepare implementation plan for client onboarding',
      project: 'Client Work',
      dueOffset: 1,
      hour: 10,
      priority: HIGH,
      createdDaysAgo: 4,
    },
    {
      title: 'Build MCP server for client CRM integration',
      project: 'Client Work',
      dueOffset: daysUntilWeekday(5), // next Friday
      hour: 14,
      priority: MED,
      createdDaysAgo: 5,
      notes:
        'Client wants Salesforce contacts synced to internal dashboard. Claude Code + MCP adapter pattern. Need to evaluate whether to use stdio or SSE transport.',
    },
    {
      title: 'Set up Claude Code workflow for automated testing',
      project: 'Client Work',
      dueOffset: daysUntilWeekday(4), // next Thursday
      hour: 15,
      priority: MED,
      createdDaysAgo: 5,
    },
    {
      title: 'Schedule intro call — new AI automation project',
      project: 'Client Work',
      dueOffset: daysUntilWeekday(4), // next Thursday
      hour: 14,
      priority: MED,
      createdDaysAgo: 3,
    },
    {
      // The ONE old task — triggers the `stale` signal in AI Insights (requires 21+ days),
      // giving the feature something meaningful to showcase. Use 22 to avoid edge cases
      // where Math.floor on the age rounds down to 20 depending on time of day.
      title: 'Draft project scope for RAG pipeline integration',
      project: 'Client Work',
      noDue: true,
      priority: LOW,
      createdDaysAgo: 22,
      notes:
        'Vector database evaluation needed — Pinecone vs pgvector. Client processing ~50K docs. Start with proof of concept on a smaller subset.',
    },
    {
      title: 'Review pull request — API authentication updates',
      project: 'Client Work',
      dueOffset: 1, // tomorrow — never overdue on seed day
      hour: 17,
      priority: HIGH,
      createdDaysAgo: 1,
    },
    {
      title: 'Client status update',
      project: 'Client Work',
      rrule: RRulePatterns.weekly([MON, THU], 10, 0),
      dueOffset: daysUntilWeekday([1, 4]), // next Mon or Thu, always future
      priority: LOW,
      createdDaysAgo: 7,
    },
    {
      title: 'Follow up on proposal — workflow automation project',
      project: 'Client Work',
      dueOffset: daysUntilWeekday(3), // next Wednesday
      hour: 9,
      priority: MED,
      createdDaysAgo: 4,
    },
  ]

  const INBOX_TASKS: DemoTaskDef[] = [
    {
      title: 'Want to work together? Reach out to Trent at trent@mcnitt.io',
      project: 'Inbox',
      noDue: true,
      createdDaysAgo: 3,
      notes:
        'AI consultant specializing in Claude Code, MCP, and AI workflow automation. View my work at mcnitt.io',
    },
  ]

  const COMPLETED_TASKS: DemoTaskDef[] = [
    {
      title: 'Deploy staging environment for client demo',
      project: 'Client Work',
      done: true,
      dueOffset: -1,
      hour: 16,
      createdDaysAgo: 5,
    },
    {
      title: 'Configure CI/CD pipeline with automated tests',
      project: 'Client Work',
      done: true,
      dueOffset: -2,
      hour: 16,
      createdDaysAgo: 6,
    },
  ]

  return [...TRY_IT_TASKS, ...CLIENT_WORK_TASKS, ...INBOX_TASKS, ...COMPLETED_TASKS]
}

// ── Task seeding helper ─────────────────────

function seedDemoTasks(db: Database.Database, userId: number, projectMap: ProjectMap): number {
  const insertTask = db.prepare(`
    INSERT INTO tasks (
      user_id, project_id, title, done, done_at, priority, due_at,
      rrule, anchor_time, anchor_dow, anchor_dom,
      original_due_at, deleted_at, archived_at, labels, notes,
      completion_count, snooze_count, first_completed_at, last_completed_at,
      created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?
    )
  `)

  const now = DateTime.utc().toISO()!
  const tasks = getDemoTasks()

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i]
    const projectId = projectMap[task.project]
    const priority = task.priority ?? UNSET
    const notes = task.notes ?? null

    // Due date computation
    let dueAt: string | null = null
    if (!task.noDue) {
      const offset = task.dueOffset ?? 0
      let h = task.hour ?? 9
      let m = task.min ?? 0
      if (task.rrule && task.hour === undefined) {
        const components = parseRRule(task.rrule)
        if (components.byhour !== undefined) h = components.byhour
        if (components.byminute !== undefined) m = components.byminute
      }
      dueAt = localToUtcIso(offset, h, m)
    }

    const anchors = deriveAnchorFields(task.rrule ?? null, dueAt, TIMEZONE)

    const done = task.done ? 1 : 0
    const doneAt = task.done ? dueAt : null
    const archivedAt = task.done ? dueAt : null
    const createdAt = localToUtcIso(-(task.createdDaysAgo ?? 3), 10, 0)

    insertTask.run(
      userId,
      projectId,
      task.title,
      done,
      doneAt,
      priority,
      dueAt,
      task.rrule ?? null,
      anchors.anchor_time,
      anchors.anchor_dow,
      anchors.anchor_dom,
      dueAt, // original_due_at — matches createTask() behavior
      null, // deleted_at
      archivedAt,
      '[]', // labels
      notes,
      0, // completion_count
      0, // snooze_count
      null, // first_completed_at
      null, // last_completed_at
      createdAt,
      now,
    )
  }

  return tasks.length
}

// ── Exported seed functions ─────────────────

export interface SeedDemoOptions {
  username?: string
  password?: string
  email?: string
}

/**
 * Seed projects, API token, and tasks for an existing user.
 * Used by reset-demo-user.ts to re-seed data without recreating the user row
 * (preserving the user ID so JWT sessions stay valid).
 */
export function seedDemoData(
  db: Database.Database,
  userId: number,
  username: string = 'demo',
): void {
  // Create projects
  const insertProject = db.prepare(
    `INSERT INTO projects (name, owner_id, shared, sort_order, color) VALUES (?, ?, 0, ?, ?)`,
  )
  const projects: { name: ProjectName; order: number; color: string }[] = [
    { name: 'Inbox', order: 0, color: 'blue' },
    { name: 'Client Work', order: 1, color: 'orange' },
    { name: 'Try It', order: 2, color: 'green' },
  ]

  const projectMap = {} as ProjectMap
  for (const p of projects) {
    const result = insertProject.run(p.name, userId, p.order, p.color)
    projectMap[p.name] = Number(result.lastInsertRowid)
    console.log(`  Project: ${p.name} (ID: ${result.lastInsertRowid})`)
  }

  // Create API token
  const rawToken = `${username}-token-` + '0'.repeat(64 - username.length - 7)
  const hashed = hashToken(rawToken)
  const preview = tokenPreview(rawToken)
  db.prepare(
    `INSERT INTO api_tokens (user_id, token, token_preview, name) VALUES (?, ?, ?, ?)`,
  ).run(userId, hashed, preview, `${username} Token`)
  console.log(`  API token created`)

  // Set priority display preferences
  const priorityDisplay = JSON.stringify({
    trailingDot: true,
    badgeStyle: 'icons',
    colorTitle: false,
    rightBorder: false,
    colorCheckbox: false,
  })
  db.prepare('UPDATE users SET priority_display = ? WHERE id = ?').run(priorityDisplay, userId)
  console.log(`  Priority display configured`)

  // Seed tasks
  const inserted = seedDemoTasks(db, userId, projectMap)
  console.log(`  Inserted ${inserted} tasks`)
}

/**
 * Seed a complete demo user (user row + data) into the database.
 * Used for initial creation. For daily resets, use seedDemoData() instead.
 *
 * @returns The user's ID
 */
export async function seedDemoUser(
  db: Database.Database,
  options: SeedDemoOptions = {},
): Promise<number> {
  const username = options.username ?? 'demo'
  const password = options.password ?? username
  const email = options.email ?? `${username}@opentask.app`

  // Create user
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS)
  const userResult = db
    .prepare(
      `INSERT INTO users (email, name, password_hash, timezone, notifications_enabled)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(email, username, passwordHash, TIMEZONE, 0)
  const userId = Number(userResult.lastInsertRowid)
  console.log(`  User "${username}" created (ID: ${userId})`)

  seedDemoData(db, userId, username)

  return userId
}

// ── CLI entrypoint ──────────────────────────

async function main(): Promise<void> {
  console.log('Seeding demo user...')
  const db = getDb()

  const existing = db.prepare('SELECT id FROM users WHERE name = ? COLLATE NOCASE').get('demo') as
    | { id: number }
    | undefined

  if (existing) {
    console.error('Demo user already exists (ID: ' + existing.id + '). Use db:reset-demo instead.')
    closeDb()
    process.exit(1)
  }

  await seedDemoUser(db)

  const taskCount = (
    db
      .prepare(
        'SELECT COUNT(*) as c FROM tasks WHERE user_id = (SELECT id FROM users WHERE name = ?)',
      )
      .get('demo') as { c: number }
  ).c
  console.log(`\nDemo seed complete! ${taskCount} tasks created.`)

  closeDb()
}

// Only run main() when executed directly (not when imported by reset-demo-user.ts)
const isDirectRun =
  process.argv[1]?.endsWith('seed-demo.ts') || process.argv[1]?.endsWith('seed-demo.js')
if (isDirectRun) {
  main().catch((err) => {
    console.error('Demo seed failed:', err)
    process.exit(1)
  })
}
