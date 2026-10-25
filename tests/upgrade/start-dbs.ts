/**
 * The upgrade test's starting databases (2026-10-24): built with plain
 * better-sqlite3, never with the app's code, so they are what an OLDER
 * release left on disk.
 *
 *  - `base`: the schema.sql of the release before this change — `git show
 *    <ref>:src/core/db/schema.sql`, ref from UPGRADE_BASE_REF (CI: the PR's
 *    base sha, or the push's parent), else `origin/main`.
 *  - `prod-shape`: tests/fixtures/schema/prod-shape.sql, a schema replayed
 *    through every release since 2026-02 (columns appended by ALTER, old
 *    column orders) — see scripts/regen-prod-shape-schema.ts.
 *
 * Each is then seeded with a few synthetic rows through `insertRow`, which
 * keeps only the columns the starting schema HAS — so one seed fits both and
 * any future base — giving the startup data steps (backfills, stamps) real
 * rows to work on.
 */

import Database from 'better-sqlite3'
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { DateTime } from 'luxon'

export type StartKind = 'base' | 'prod-shape'

const ROOT = path.resolve(__dirname, '..', '..')
export const TZ = 'America/Chicago'
export const USER_A = 1
/** No periods of its own: `backfillTimeSlots` gives it the defaults. */
export const USER_B = 2

export function baseRef(): string {
  return process.env.UPGRADE_BASE_REF || 'origin/main'
}

function startSchema(kind: StartKind): string {
  if (kind === 'prod-shape') {
    return fs.readFileSync(path.join(ROOT, 'tests/fixtures/schema/prod-shape.sql'), 'utf8')
  }
  const ref = baseRef()
  try {
    return execFileSync('git', ['show', `${ref}:src/core/db/schema.sql`], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 16 << 20,
    })
  } catch (err) {
    throw new Error(
      `cannot read the base schema at ${ref} (a shallow clone? CI needs fetch-depth: 0): ${String(err)}`,
    )
  }
}

/** INSERT the values whose column exists in this database's `table`. */
export function insertRow(db: Database.Database, table: string, values: Record<string, unknown>) {
  const have = new Set((db.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name))
  const cols = Object.keys(values).filter((c) => have.has(c))
  db.prepare(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
  ).run(...cols.map((c) => values[c]))
}

function iso(dt: DateTime): string {
  return dt.toUTC().toISO({ suppressMilliseconds: true })!
}

function seedUsers(db: Database.Database, today: DateTime): void {
  const user = (id: number, name: string) => ({
    id,
    email: `${name}@example.test`,
    name,
    password_hash: 'not-a-hash',
    timezone: TZ,
    // A retired grouping: `restoreProjectGrouping` rewrites it.
    default_grouping: 'time',
    // A label styled but on no task: `backfillLabelRegistry` registers it.
    label_config: JSON.stringify([{ name: 'styled-only', color: 'blue' }]),
    // Two days ago, so today's task rollover has a day to run.
    last_rollover_date: today.minus({ days: 2 }).toISODate(),
  })
  insertRow(db, 'users', user(USER_A, 'upgrade-a'))
  insertRow(db, 'users', { ...user(USER_B, 'upgrade-b'), last_rollover_date: null })
  insertRow(db, 'projects', { id: 1, name: 'Inbox', owner_id: USER_A, sort_order: 0 })
  insertRow(db, 'projects', { id: 2, name: 'Inbox', owner_id: USER_B, sort_order: 0 })
  insertRow(db, 'time_slots', { user_id: USER_A, label: 'Morning', start_time: '09:00' })
  insertRow(db, 'time_slots', {
    user_id: USER_A,
    label: 'Evening',
    start_time: '20:00',
    sort_order: 1,
  })
}

function seedTasks(db: Database.Database, today: DateTime): void {
  const at9 = today.set({ hour: 9, minute: 0, second: 0, millisecond: 0 })
  const created = iso(today.minus({ days: 30 }))
  const task = (id: number, title: string, extra: Record<string, unknown>) =>
    insertRow(db, 'tasks', {
      id,
      user_id: USER_A,
      project_id: 1,
      title,
      labels: '[]',
      created_at: created,
      updated_at: created,
      ...extra,
    })
  // A one-off left on yesterday's target, with a label on no registry row.
  task(1, 'Return the library books', {
    due_at: iso(at9.minus({ days: 1 })),
    original_due_at: iso(at9.minus({ days: 1 })),
    labels: JSON.stringify(['errand']),
    priority: 1,
  })
  // A deadline one-off with no target.
  task(2, 'File the quarterly report', { deadline_at: iso(at9.plus({ days: 10 })), priority: 2 })
  // A daily repeat, done yesterday.
  task(3, 'Water the plants', {
    due_at: iso(at9),
    rrule: 'FREQ=DAILY',
    anchor_time: '09:00',
    last_completed_at: iso(at9.minus({ days: 1 })),
    completion_count: 1,
  })
  // A weekly quota with a stray due date (`clearQuotaDueDates`) and an ended
  // period (`rolloverTrackedPeriods`).
  task(4, 'Go for a run', {
    due_at: iso(at9),
    rrule: 'FREQ=WEEKLY',
    is_tracked: 1,
    progress_target: 3,
    progress_current: 1,
    progress_period_start: iso(today.minus({ days: 15 }).startOf('day')),
  })
  // A daily reminder.
  task(5, 'Take vitamins', {
    due_at: iso(at9),
    rrule: 'FREQ=DAILY',
    anchor_time: '09:00',
    is_reminder: 1,
  })
  // A weekly repeat with a deadline.
  task(6, 'Pay the cleaner', {
    due_at: iso(at9.plus({ days: 1 })),
    deadline_at: iso(at9.plus({ days: 2 })),
    rrule: 'FREQ=WEEKLY',
    anchor_time: '09:00',
  })
  insertRow(db, 'completions', {
    task_id: 3,
    user_id: USER_A,
    completed_at: iso(at9.minus({ days: 1 })),
    due_at_was: iso(at9.minus({ days: 1 })),
    due_at_next: iso(at9),
  })
}

/** Build the starting database at `dbPath`: the older schema, then the seed rows. */
export function buildStartDb(kind: StartKind, dbPath: string, now: Date): void {
  fs.rmSync(dbPath, { force: true })
  const db = new Database(dbPath)
  db.exec(startSchema(kind))
  const today = DateTime.fromJSDate(now).setZone(TZ)
  db.transaction(() => {
    seedUsers(db, today)
    seedTasks(db, today)
  })()
  db.close()
}
