/**
 * Demo user seed script for OpenTask
 *
 * Creates a demo user with realistic generic professional tasks.
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

// Day-of-week constants (0=Mon..6=Sun)
const MON = 0,
  TUE = 1,
  WED = 2,
  THU = 3,
  FRI = 4,
  SAT = 5

const WEEKDAYS = [MON, TUE, WED, THU, FRI]

// Priority constants
const UNSET = 0,
  LOW = 1,
  MED = 2,
  HIGH = 3,
  URGENT = 4

interface DemoTaskDef {
  title: string
  project: 'Inbox' | 'Work' | 'Personal' | 'Home' | 'Side Projects'
  rrule?: string
  dueOffset?: number // days from today (negative = overdue)
  hour?: number
  min?: number
  priority?: number
  labels?: string
  done?: boolean
  deleted?: boolean
  completionCount?: number
  snoozeCount?: number
  notes?: string
}

// ── Task definitions ──────────────────────────────────

const WORK_TASKS: DemoTaskDef[] = [
  {
    title: 'Daily standup',
    project: 'Work',
    rrule: RRulePatterns.weekly(WEEKDAYS, 9, 0),
    dueOffset: 0,
    priority: HIGH,
    labels: '["daily"]',
    completionCount: 45,
  },
  {
    title: 'Weekly team sync',
    project: 'Work',
    rrule: RRulePatterns.weekly([TUE], 10, 0),
    dueOffset: 1,
    priority: MED,
    labels: '["weekly"]',
    completionCount: 12,
  },
  {
    title: 'Review pull requests',
    project: 'Work',
    rrule: RRulePatterns.weekly(WEEKDAYS, 14, 0),
    dueOffset: 0,
    priority: MED,
    labels: '["daily"]',
    completionCount: 30,
  },
  {
    title: 'Submit weekly status report',
    project: 'Work',
    rrule: RRulePatterns.weekly([FRI], 16, 0),
    dueOffset: 3,
    priority: MED,
    labels: '["weekly"]',
    completionCount: 8,
  },
  {
    title: 'Monthly expense report',
    project: 'Work',
    rrule: RRulePatterns.monthly(1, 9, 0),
    dueOffset: 5,
    labels: '["monthly"]',
    completionCount: 6,
  },
  {
    title: 'Prepare Q2 presentation slides',
    project: 'Work',
    dueOffset: 3,
    hour: 10,
    priority: HIGH,
  },
  {
    title: 'Update project documentation',
    project: 'Work',
    dueOffset: 5,
    hour: 14,
    priority: LOW,
  },
  {
    title: 'Schedule 1:1 with new team member',
    project: 'Work',
    dueOffset: 1,
    hour: 11,
    priority: MED,
  },
  {
    title: 'Review and approve vendor contract',
    project: 'Work',
    dueOffset: 2,
    hour: 10,
    priority: URGENT,
    notes: 'Legal needs this signed by end of week',
  },
  {
    title: 'Finalize hiring criteria for backend role',
    project: 'Work',
    dueOffset: 4,
    hour: 15,
    priority: MED,
  },
  {
    title: 'Respond to client feedback email',
    project: 'Work',
    dueOffset: -1,
    hour: 9,
    priority: HIGH,
    snoozeCount: 1,
  },
  {
    title: 'Fix broken CI pipeline',
    project: 'Work',
    dueOffset: 0,
    hour: 11,
    priority: URGENT,
  },
]

const PERSONAL_TASKS: DemoTaskDef[] = [
  {
    title: 'Morning workout',
    project: 'Personal',
    rrule: RRulePatterns.weekly([MON, WED, FRI], 7, 0),
    dueOffset: 0,
    priority: MED,
    labels: '["health"]',
    completionCount: 20,
  },
  {
    title: 'Take daily vitamins',
    project: 'Personal',
    rrule: RRulePatterns.daily(8, 0),
    dueOffset: 0,
    labels: '["health","daily"]',
    completionCount: 55,
  },
  {
    title: 'Read for 30 minutes',
    project: 'Personal',
    rrule: RRulePatterns.daily(21, 0),
    dueOffset: -1,
    priority: LOW,
    labels: '["evening"]',
    completionCount: 18,
    snoozeCount: 3,
  },
  {
    title: 'Schedule dentist appointment',
    project: 'Personal',
    dueOffset: 2,
    hour: 10,
    priority: MED,
  },
  {
    title: 'Renew gym membership',
    project: 'Personal',
    dueOffset: 7,
    hour: 9,
    priority: LOW,
    snoozeCount: 2,
  },
  {
    title: 'Call insurance about claim',
    project: 'Personal',
    dueOffset: 1,
    hour: 14,
    priority: HIGH,
  },
  {
    title: 'Weekly meal prep',
    project: 'Personal',
    rrule: RRulePatterns.weekly([SAT], 10, 0),
    dueOffset: 2,
    labels: '["weekly"]',
    completionCount: 10,
  },
  {
    title: 'Budget review',
    project: 'Personal',
    rrule: RRulePatterns.monthly(15, 19, 0),
    dueOffset: 8,
    labels: '["monthly"]',
    completionCount: 4,
  },
]

const HOME_TASKS: DemoTaskDef[] = [
  {
    title: 'Take out trash and recycling',
    project: 'Home',
    rrule: RRulePatterns.weekly([WED], 7, 0),
    dueOffset: -1,
    labels: '["weekly"]',
    completionCount: 22,
    snoozeCount: 1,
  },
  {
    title: 'Water plants',
    project: 'Home',
    rrule: RRulePatterns.weekly([SAT], 9, 0),
    dueOffset: 2,
    labels: '["weekly"]',
    completionCount: 15,
  },
  {
    title: 'Replace HVAC filter',
    project: 'Home',
    rrule: RRulePatterns.everyNMonths(3, 1, 10, 0),
    dueOffset: 20,
    labels: '["quarterly"]',
    completionCount: 2,
  },
  {
    title: 'Fix leaky kitchen faucet',
    project: 'Home',
    dueOffset: 4,
    hour: 10,
    priority: MED,
    snoozeCount: 3,
  },
  {
    title: 'Clean out garage',
    project: 'Home',
    dueOffset: 10,
    hour: 9,
    priority: LOW,
  },
  {
    title: 'Schedule lawn service for spring',
    project: 'Home',
    dueOffset: 6,
    hour: 9,
  },
  {
    title: 'Replace smoke detector batteries',
    project: 'Home',
    dueOffset: 3,
    hour: 10,
    priority: HIGH,
  },
  {
    title: 'Organize kitchen pantry',
    project: 'Home',
    dueOffset: 8,
    hour: 14,
    priority: LOW,
    snoozeCount: 2,
  },
  {
    title: 'Check gutters before storm season',
    project: 'Home',
    dueOffset: 12,
    hour: 10,
    priority: MED,
  },
  {
    title: 'Deep clean bathroom',
    project: 'Home',
    rrule: RRulePatterns.everyNWeeks(2, [SAT], 10, 0),
    dueOffset: 5,
    labels: '["biweekly"]',
    completionCount: 6,
  },
]

const SIDE_PROJECT_TASKS: DemoTaskDef[] = [
  {
    title: 'Set up project repo and CI',
    project: 'Side Projects',
    dueOffset: 5,
    hour: 19,
    priority: MED,
    labels: '["coding"]',
  },
  {
    title: 'Design landing page mockup',
    project: 'Side Projects',
    dueOffset: 7,
    hour: 20,
    priority: LOW,
    labels: '["design"]',
  },
  {
    title: 'Research hosting options',
    project: 'Side Projects',
    dueOffset: 3,
    hour: 20,
    labels: '["research"]',
  },
  {
    title: 'Write blog post draft',
    project: 'Side Projects',
    dueOffset: 10,
    hour: 20,
    priority: LOW,
    labels: '["writing"]',
  },
  {
    title: 'Review analytics dashboard design',
    project: 'Side Projects',
    dueOffset: 6,
    hour: 20,
    labels: '["design"]',
  },
  {
    title: 'Set up automated backups',
    project: 'Side Projects',
    dueOffset: 8,
    hour: 19,
    priority: MED,
    labels: '["devops"]',
  },
]

const INBOX_TASKS: DemoTaskDef[] = [
  {
    title: 'Look into that podcast recommendation',
    project: 'Inbox',
    dueOffset: 1,
    hour: 19,
  },
  {
    title: 'Send thank you note to Sarah',
    project: 'Inbox',
    dueOffset: 0,
    hour: 12,
    priority: MED,
  },
  {
    title: 'Check warranty on dishwasher',
    project: 'Inbox',
    dueOffset: 3,
    hour: 10,
  },
  {
    title: 'Find a good recipe for dinner party',
    project: 'Inbox',
    dueOffset: 4,
    hour: 18,
  },
  {
    title: 'Reply to apartment building survey',
    project: 'Inbox',
    dueOffset: 2,
    hour: 11,
  },
]

const COMPLETED_TASKS: DemoTaskDef[] = [
  {
    title: 'File taxes',
    project: 'Personal',
    done: true,
    dueOffset: -14,
    hour: 10,
    priority: URGENT,
    completionCount: 1,
  },
  {
    title: 'Order new desk chair',
    project: 'Home',
    done: true,
    dueOffset: -7,
    hour: 14,
    completionCount: 1,
  },
  {
    title: 'Update resume',
    project: 'Work',
    done: true,
    dueOffset: -10,
    hour: 20,
    completionCount: 1,
  },
  {
    title: 'Return library books',
    project: 'Personal',
    done: true,
    dueOffset: -5,
    hour: 11,
    completionCount: 1,
  },
  {
    title: 'Cancel streaming trial',
    project: 'Personal',
    done: true,
    dueOffset: -3,
    hour: 9,
    completionCount: 1,
  },
  {
    title: 'Submit conference talk proposal',
    project: 'Work',
    done: true,
    dueOffset: -8,
    hour: 15,
    priority: HIGH,
    completionCount: 1,
  },
  {
    title: 'Set up automatic bill pay',
    project: 'Personal',
    done: true,
    dueOffset: -12,
    hour: 10,
    completionCount: 1,
  },
]

const TRASHED_TASKS: DemoTaskDef[] = [
  {
    title: 'Old project idea - shelved',
    project: 'Side Projects',
    deleted: true,
    dueOffset: -10,
    hour: 20,
  },
  {
    title: 'Duplicate entry - weekly review',
    project: 'Work',
    deleted: true,
    dueOffset: -5,
    hour: 16,
  },
]

const ALL_DEMO_TASKS: DemoTaskDef[] = [
  ...WORK_TASKS,
  ...PERSONAL_TASKS,
  ...HOME_TASKS,
  ...SIDE_PROJECT_TASKS,
  ...INBOX_TASKS,
  ...COMPLETED_TASKS,
  ...TRASHED_TASKS,
]

// ── Helpers ──────────────────────────────────

function localToUtcIso(daysOffset: number, hour: number, minute: number): string {
  const local = DateTime.now()
    .setZone(TIMEZONE)
    .plus({ days: daysOffset })
    .set({ hour, minute, second: 0, millisecond: 0 })
  return localToUtc(local)
}

type ProjectName = 'Inbox' | 'Work' | 'Personal' | 'Home' | 'Side Projects'
type ProjectMap = Record<ProjectName, number>

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
  let inserted = 0

  for (let i = 0; i < ALL_DEMO_TASKS.length; i++) {
    const task = ALL_DEMO_TASKS[i]
    const projectId = projectMap[task.project]
    const priority = task.priority ?? UNSET
    const labels = task.labels ?? '[]'
    const completionCount = task.completionCount ?? 0
    const snoozeCount = task.snoozeCount ?? 0
    const notes = task.notes ?? null

    const offset = task.dueOffset ?? 0
    let h = task.hour ?? 9
    let m = task.min ?? 0
    if (task.rrule && task.hour === undefined) {
      const components = parseRRule(task.rrule)
      if (components.byhour !== undefined) h = components.byhour
      if (components.byminute !== undefined) m = components.byminute
    }
    const dueAt = localToUtcIso(offset, h, m)
    const anchors = deriveAnchorFields(task.rrule ?? null, dueAt, TIMEZONE)

    const done = task.done ? 1 : 0
    const doneAt = task.done ? dueAt : null
    const archivedAt = task.done ? dueAt : null
    const deletedAt = task.deleted ? now : null
    const originalDueAt = snoozeCount > 0 ? localToUtcIso(offset - 1, h, m) : null
    const firstCompleted = completionCount > 0 ? localToUtcIso(-30, h, m) : null
    const lastCompleted = completionCount > 0 ? localToUtcIso(-1, h, m) : null
    const createdAt = localToUtcIso(-60 + i, 10, 0)

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
      originalDueAt,
      deletedAt,
      archivedAt,
      labels,
      notes,
      completionCount,
      snoozeCount,
      firstCompleted,
      lastCompleted,
      createdAt,
      now,
    )
    inserted++
  }

  return inserted
}

// ── Exported seed function ──────────────────

/**
 * Seed demo user data into the database.
 * Creates the demo user, projects, token, and tasks.
 * Does NOT touch any other users' data.
 *
 * @returns The demo user's ID
 */
export async function seedDemoUser(db: Database.Database): Promise<number> {
  // Create demo user
  const passwordHash = await bcrypt.hash('demo', SALT_ROUNDS)
  const userResult = db
    .prepare(
      `INSERT INTO users (email, name, password_hash, timezone, notifications_enabled)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run('demo@opentask.app', 'demo', passwordHash, TIMEZONE, 0)
  const userId = Number(userResult.lastInsertRowid)
  console.log(`  Demo user created (ID: ${userId})`)

  // Create projects
  const insertProject = db.prepare(
    `INSERT INTO projects (name, owner_id, shared, sort_order, color) VALUES (?, ?, 0, ?, ?)`,
  )
  const projects: { name: ProjectName; order: number; color: string }[] = [
    { name: 'Inbox', order: 0, color: 'blue' },
    { name: 'Work', order: 1, color: 'orange' },
    { name: 'Personal', order: 2, color: 'green' },
    { name: 'Home', order: 3, color: 'purple' },
    { name: 'Side Projects', order: 4, color: 'pink' },
  ]

  const projectMap = {} as ProjectMap
  for (const p of projects) {
    const result = insertProject.run(p.name, userId, p.order, p.color)
    projectMap[p.name] = Number(result.lastInsertRowid)
    console.log(`  Project: ${p.name} (ID: ${result.lastInsertRowid})`)
  }

  // Create API token (for demo API access)
  const rawToken = 'demo-token-' + '0'.repeat(53) // 64 chars
  const hashed = hashToken(rawToken)
  const preview = tokenPreview(rawToken)
  db.prepare(
    `INSERT INTO api_tokens (user_id, token, token_preview, name) VALUES (?, ?, ?, ?)`,
  ).run(userId, hashed, preview, 'Demo Token')
  console.log(`  API token created`)

  // Seed tasks
  const inserted = seedDemoTasks(db, userId, projectMap)
  console.log(`  Inserted ${inserted} tasks`)

  return userId
}

// ── CLI entrypoint ──────────────────────────

async function main(): Promise<void> {
  console.log('Seeding demo user...')
  const db = getDb()

  // Check if demo user already exists
  const existing = db.prepare('SELECT id FROM users WHERE name = ? COLLATE NOCASE').get('demo') as
    | { id: number }
    | undefined

  if (existing) {
    console.error('Demo user already exists (ID: ' + existing.id + '). Use db:reset-demo instead.')
    closeDb()
    process.exit(1)
  }

  await seedDemoUser(db)

  // Print summary
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
