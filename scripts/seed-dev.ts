/**
 * Development seed script for OpenTask
 *
 * Creates a dev user with ~25 realistic tasks covering all features:
 * overdue tasks, recurring tasks, priorities P0-P4, labels, archived,
 * trashed, notes, and no-due-date tasks. Designed to give contributors
 * a fully-populated app from the first login.
 *
 * Usage: npm run db:seed-dev
 */

import bcrypt from 'bcrypt'
import { DateTime } from 'luxon'
import { seedSystemLabels } from '../src/core/labels'
import { seedDefaultTimeSlots } from '../src/core/time-slots'
import { getDb, closeDb } from '../src/core/db'
import { hashToken, tokenPreview } from '../src/core/auth/token-hash'
import { RRulePatterns, parseRRule } from '../src/core/recurrence/rrule-builder'
import { localToUtcIso, daysUntilWeekday, seedTasks, type SeedTaskRow } from './seed-utils'

const TIMEZONE = 'America/Chicago'
const SALT_ROUNDS = 10

// Day-of-week constants (0=Mon..6=Sun) used by RRulePatterns
const MON = 0,
  TUE = 1,
  WED = 2,
  THU = 3,
  FRI = 4

// Priority constants
const UNSET = 0,
  LOW = 1,
  MED = 2,
  HIGH = 3,
  URGENT = 4

type ProjectName = 'Inbox' | 'Personal' | 'Work' | 'Errands'
type ProjectMap = Record<ProjectName, number>

interface DevTaskDef {
  title: string
  project: ProjectName
  rrule?: string
  /** Days from today for due date. Ignored when noDue is true. */
  dueOffset?: number
  hour?: number
  min?: number
  priority?: number
  labels?: string[]
  notes?: string
  done?: boolean
  trashed?: boolean
  /** When true, skip due date computation entirely (task has no due date) */
  noDue?: boolean
  /** How many days ago the task was created (for realistic created_at). Default: 5 */
  createdDaysAgo?: number
}

// Task definitions are split into category arrays and merged at the end.
// Each category covers a different feature area so contributors see all
// UI states on first login.

const OVERDUE: DevTaskDef[] = [
  {
    title: 'Review quarterly budget spreadsheet',
    project: 'Work',
    dueOffset: -1,
    hour: 9,
    priority: HIGH,
    labels: ['finance'],
    createdDaysAgo: 4,
    notes: 'Q2 numbers are in. Compare against projections and flag any variances over 10%.',
  },
  {
    title: 'Schedule annual checkup',
    project: 'Personal',
    dueOffset: -2,
    hour: 10,
    priority: MED,
    labels: ['health'],
    createdDaysAgo: 7,
  },
  {
    title: 'Return library books',
    project: 'Errands',
    dueOffset: -1,
    hour: 14,
    priority: LOW,
    createdDaysAgo: 5,
  },
  {
    title: 'Submit expense report',
    project: 'Work',
    dueOffset: 0,
    hour: 8,
    priority: URGENT,
    labels: ['finance'],
    createdDaysAgo: 3,
    notes: 'Hard deadline — reimbursement window closes today.',
  },
]

const UPCOMING: DevTaskDef[] = [
  {
    title: 'Prepare slides for team meeting',
    project: 'Work',
    dueOffset: 1,
    hour: 10,
    priority: HIGH,
    createdDaysAgo: 3,
  },
  { title: 'Pick up dry cleaning', project: 'Errands', dueOffset: 1, hour: 17, createdDaysAgo: 2 },
  {
    title: 'Call insurance about claim',
    project: 'Personal',
    dueOffset: 2,
    hour: 9,
    priority: MED,
    labels: ['finance'],
    createdDaysAgo: 5,
    notes: 'Reference claim #847293. Appeal deadline approaching.',
  },
  {
    title: 'Update project README',
    project: 'Work',
    dueOffset: 2,
    hour: 14,
    priority: LOW,
    createdDaysAgo: 6,
  },
  { title: 'Grocery shopping', project: 'Errands', dueOffset: 3, hour: 11, createdDaysAgo: 1 },
  {
    title: 'Research new running shoes',
    project: 'Personal',
    dueOffset: 3,
    hour: 19,
    priority: LOW,
    labels: ['health'],
    createdDaysAgo: 8,
  },
  {
    title: 'Review pull request from contractor',
    project: 'Work',
    dueOffset: 1,
    hour: 15,
    priority: HIGH,
    createdDaysAgo: 1,
  },
  { title: 'Plan weekend trip', project: 'Personal', dueOffset: 4, hour: 20, createdDaysAgo: 3 },
]

const RECURRING: DevTaskDef[] = [
  {
    title: 'Morning workout',
    project: 'Personal',
    rrule: RRulePatterns.daily(7, 0),
    dueOffset: 1,
    priority: MED,
    labels: ['health'],
    createdDaysAgo: 30,
  },
  {
    title: 'Team standup',
    project: 'Work',
    rrule: RRulePatterns.weekly([MON, TUE, WED, THU, FRI], 9, 30),
    dueOffset: daysUntilWeekday([1, 2, 3, 4, 5]),
    priority: LOW,
    createdDaysAgo: 14,
  },
  {
    title: 'Weekly review',
    project: 'Work',
    rrule: RRulePatterns.weekly([FRI], 16, 0),
    dueOffset: daysUntilWeekday(5),
    priority: MED,
    createdDaysAgo: 21,
    notes: 'Review completed tasks, plan next week, update project boards.',
  },
  {
    title: 'Water plants',
    project: 'Personal',
    rrule: RRulePatterns.weekly([WED], 8, 0),
    dueOffset: daysUntilWeekday(3),
    createdDaysAgo: 60,
  },
]

const NO_DUE: DevTaskDef[] = [
  {
    title: 'Look into home automation options',
    project: 'Personal',
    noDue: true,
    priority: LOW,
    createdDaysAgo: 15,
    notes: 'Compare Home Assistant vs Apple Home for lights and thermostat.',
  },
]

const COMPLETED: DevTaskDef[] = [
  {
    title: 'Set up development environment',
    project: 'Work',
    done: true,
    dueOffset: -3,
    hour: 10,
    createdDaysAgo: 7,
  },
  {
    title: 'File tax extension',
    project: 'Personal',
    done: true,
    dueOffset: -2,
    hour: 14,
    priority: HIGH,
    labels: ['finance'],
    createdDaysAgo: 10,
  },
  {
    title: 'Oil change',
    project: 'Errands',
    done: true,
    dueOffset: -4,
    hour: 9,
    createdDaysAgo: 8,
  },
]

const TRASHED: DevTaskDef[] = [
  {
    title: 'Cancel old subscription (already done)',
    project: 'Personal',
    trashed: true,
    dueOffset: -5,
    hour: 12,
    createdDaysAgo: 10,
  },
]

function getDevTasks(): DevTaskDef[] {
  return [...OVERDUE, ...UPCOMING, ...RECURRING, ...NO_DUE, ...COMPLETED, ...TRASHED]
}

function seedDevTasks(userId: number, projectMap: ProjectMap): number {
  const now = DateTime.utc().toISO()!
  const tasks = getDevTasks()

  // Through createTask (`seedTasks`, scripts/seed-utils.ts), then aged.
  const rows: SeedTaskRow[] = tasks.map((task) => {
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
    return {
      input: {
        title: task.title,
        project_id: projectMap[task.project],
        priority: task.priority ?? UNSET,
        due_at: dueAt,
        rrule: task.rrule ?? null,
        labels: task.labels ?? [],
        // The dev labels are not in a new user's registry: registered as the
        // tasks are made (the raw rows waited for the startup backfill).
        create_label: true,
        notes: task.notes ?? null,
      },
      createdAt: localToUtcIso(-(task.createdDaysAgo ?? 5), 10, 0),
      updatedAt: now,
      doneAt: task.done ? dueAt : null,
      archivedAt: task.done ? dueAt : null,
      deletedAt: task.trashed ? now : null,
    }
  })
  seedTasks(userId, TIMEZONE, rows)
  return tasks.length
}

async function main(): Promise<void> {
  console.log('Seeding development user...')
  const db = getDb()

  // Check if dev user already exists
  const existing = db.prepare('SELECT id FROM users WHERE name = ? COLLATE NOCASE').get('dev') as
    | { id: number }
    | undefined

  if (existing) {
    console.error(
      'Dev user already exists (ID: ' +
        existing.id +
        '). Delete data/tasks.db and re-run to start fresh.',
    )
    closeDb()
    process.exit(1)
  }

  await seedDevUser(db)
  closeDb()
  console.log(`\nDev seed complete! Login with username "dev", password "dev".`)
}

/**
 * The dev user and everything it owns, into the open database (`getDb()`).
 * Exported for the seed guard test (tests/behavioral/seed-occurrence-guard.test.ts).
 *
 * @returns The user's ID
 */
export async function seedDevUser(db: ReturnType<typeof getDb>): Promise<number> {
  // Create dev user
  const passwordHash = await bcrypt.hash('dev', SALT_ROUNDS)
  const userResult = db
    // default_sort is explicit: a database created before 2026-10-11 still
    // carries the column's old 'due_date' default (as in create-user.ts).
    .prepare(
      `INSERT INTO users (email, name, password_hash, timezone, default_sort)
       VALUES (?, ?, ?, ?, 'horizon')`,
    )
    .run('dev@opentask.local', 'dev', passwordHash, TIMEZONE)
  const userId = Number(userResult.lastInsertRowid)
  console.log(`  User "dev" created (ID: ${userId})`)

  // Register the system label vocabulary (§7.2)
  seedSystemLabels(userId)
  seedDefaultTimeSlots(userId)

  // Create projects
  const insertProject = db.prepare(
    `INSERT INTO projects (name, owner_id, shared, sort_order, color) VALUES (?, ?, 0, ?, ?)`,
  )
  const projects: { name: ProjectName; order: number; color: string }[] = [
    { name: 'Inbox', order: 0, color: 'blue' },
    { name: 'Personal', order: 1, color: 'green' },
    { name: 'Work', order: 2, color: 'purple' },
    { name: 'Errands', order: 3, color: 'orange' },
  ]

  const projectMap = {} as ProjectMap
  for (const p of projects) {
    const result = insertProject.run(p.name, userId, p.order, p.color)
    projectMap[p.name] = Number(result.lastInsertRowid)
    console.log(`  Project: ${p.name} (ID: ${result.lastInsertRowid})`)
  }

  // Create API token
  const rawToken = 'dev-token-' + '0'.repeat(54)
  const hashed = hashToken(rawToken)
  const preview = tokenPreview(rawToken)
  db.prepare(
    `INSERT INTO api_tokens (user_id, token, token_preview, name) VALUES (?, ?, ?, ?)`,
  ).run(userId, hashed, preview, 'Dev Token')
  console.log(`  API token created`)

  // Seed tasks
  const count = seedDevTasks(userId, projectMap)
  console.log(`  Inserted ${count} tasks`)
  return userId
}

// Only run main() when executed directly (not when imported by the seed guard
// test, tests/behavioral/seed-occurrence-guard.test.ts).
const isDirectRun =
  process.argv[1]?.endsWith('seed-dev.ts') || process.argv[1]?.endsWith('seed-dev.js')
if (isDirectRun) {
  main().catch((err) => {
    console.error('Dev seed failed:', err)
    process.exit(1)
  })
}
