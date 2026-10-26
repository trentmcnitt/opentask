/**
 * Global setup for E2E tests
 *
 * Seeds a dedicated E2E database with known tasks.
 * The production server Playwright starts (`next start`, see
 * playwright.config.ts) will use this DB.
 *
 * No route warm-up is needed here: a production build compiles every route up
 * front, so there is no first-visit compile for a spec to pay for inside its
 * own timeouts (the cause of the old dev-server "first visit" flakes).
 */

import Database from 'better-sqlite3'
import bcrypt from 'bcrypt'
import fs from 'fs'
import path from 'path'
import { DateTime } from 'luxon'
import { hashToken, tokenPreview } from '../../src/core/auth/token-hash'
import { seedOccurrenceAt } from '../../src/core/db/occurrence-seed'

const DB_PATH = path.join(process.cwd(), 'data', 'test-e2e.db')
const SCHEMA_PATH = path.join(process.cwd(), 'src', 'core', 'db', 'schema.sql')

export default async function globalSetup() {
  // Clean up any previous E2E DB
  for (const suffix of ['', '-wal', '-shm']) {
    const f = DB_PATH + suffix
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }

  // Ensure data directory exists
  const dataDir = path.dirname(DB_PATH)
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true })
  }

  // Create and seed DB directly
  const db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  // Read and apply schema
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf-8')
  db.exec(schema)

  await seedE2eDatabase(db)

  db.close()
  console.log('[e2e] Database seeded at', DB_PATH)
}

/**
 * Everything the E2E database holds, written into `db` (schema applied).
 * Exported for the seed guard test (tests/behavioral/seed-occurrence-guard.test.ts).
 */
export async function seedE2eDatabase(db: Database.Database): Promise<void> {
  // The seeded user's timezone. Slot/reminder assignment is done entirely in
  // this zone (server-side via `user.timezone`, and in specs via each file's
  // own `TEST_TZ` constant) — never via the process's `TZ` env var, which
  // Luxon's explicit `.setZone(...)` calls ignore (verified: `TZ` has zero
  // effect on `DateTime.fromJSDate(now).setZone('America/Chicago')`).
  //
  // Overridable via `E2E_TZ` so a real IANA zone that is CURRENTLY at the
  // point in the day under test (just after local midnight, just after the
  // last time slot, etc.) can be substituted without waiting for real
  // America/Chicago wall-clock time to reach it — e.g.
  // `E2E_TZ=Pacific/Kiritimati npm run test:e2e -- dashboard-reminders-panel`.
  // Defaults to America/Chicago so an ordinary run is unaffected.
  const seededUserTz = process.env.E2E_TZ || 'America/Chicago'

  // Create test user
  const passwordHash = await bcrypt.hash('testpass123', 4)
  db.prepare(
    `
    INSERT INTO users (id, email, name, password_hash, timezone)
    VALUES (?, ?, ?, ?, ?)
  `,
  ).run(1, 'test@opentask.local', 'Test User', passwordHash, seededUserTz)

  // Create projects
  db.prepare(
    `
    INSERT INTO projects (id, name, owner_id, shared, sort_order)
    VALUES (?, ?, ?, ?, ?)
  `,
  ).run(1, 'Inbox', 1, 0, 0)

  db.prepare(
    `
    INSERT INTO projects (id, name, owner_id, shared, sort_order)
    VALUES (?, ?, ?, ?, ?)
  `,
  ).run(2, 'Routine', 1, 0, 1)

  db.prepare(
    `
    INSERT INTO projects (id, name, owner_id, shared, sort_order)
    VALUES (?, ?, ?, ?, ?)
  `,
  ).run(3, 'Work', 1, 0, 2)

  // Create API token (stored as SHA-256 hash, matching production pattern)
  const rawToken = 'a'.repeat(64)
  db.prepare(
    `
    INSERT INTO api_tokens (user_id, token, token_preview, name)
    VALUES (?, ?, ?, ?)
  `,
  ).run(1, hashToken(rawToken), tokenPreview(rawToken), 'E2E Token')

  // Create tasks with specific dates
  // All dates use future times to ensure tests are time-agnostic (pass at any time of day)
  const tz = seededUserTz
  const tomorrow = DateTime.now()
    .setZone(tz)
    .plus({ days: 1 })
    .set({ hour: 9, minute: 0, second: 0, millisecond: 0 })
    .toUTC()
    .toISO()!

  const tomorrowEvening = DateTime.now()
    .setZone(tz)
    .plus({ days: 1 })
    .set({ hour: 21, minute: 0, second: 0, millisecond: 0 })
    .toUTC()
    .toISO()!

  const tomorrowMorning = DateTime.now()
    .setZone(tz)
    .plus({ days: 1 })
    .set({ hour: 7, minute: 0, second: 0, millisecond: 0 })
    .toUTC()
    .toISO()!

  const tomorrow5pm = DateTime.now()
    .setZone(tz)
    .plus({ days: 1 })
    .set({ hour: 17, minute: 0, second: 0, millisecond: 0 })
    .toUTC()
    .toISO()!

  const threeDays = DateTime.now()
    .setZone(tz)
    .plus({ days: 3 })
    .set({ hour: 9, minute: 0, second: 0, millisecond: 0 })
    .toUTC()
    .toISO()!

  const nextMonday = DateTime.now()
    .setZone(tz)
    .plus({ weeks: 1 })
    .set({ weekday: 1, hour: 10, minute: 0, second: 0, millisecond: 0 })
    .toUTC()
    .toISO()!

  // One-off: "Buy groceries" due tomorrow
  db.prepare(
    `
    INSERT INTO tasks (id, user_id, project_id, title, due_at, priority)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(1, 1, 1, 'Buy groceries', tomorrow, 2)

  // Recurring daily: "Morning routine" at 7 AM
  db.prepare(
    `
    INSERT INTO tasks (id, user_id, project_id, title, due_at, rrule, recurrence_mode, priority)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(2, 1, 2, 'Morning routine', tomorrowMorning, 'FREQ=DAILY', 'from_due', 1)

  // Recurring daily: "Evening review" at 9 PM
  db.prepare(
    `
    INSERT INTO tasks (id, user_id, project_id, title, due_at, rrule, recurrence_mode, priority)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(3, 1, 2, 'Evening review', tomorrowEvening, 'FREQ=DAILY', 'from_due', 1)

  // Recurring weekly: "Weekly standup" Mon 10 AM
  db.prepare(
    `
    INSERT INTO tasks (id, user_id, project_id, title, due_at, rrule, recurrence_mode, priority)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(4, 1, 3, 'Weekly standup', nextMonday, 'FREQ=WEEKLY;BYDAY=MO', 'from_due', 1)

  // One-off: "Review PRs" due tomorrow 5pm
  db.prepare(
    `
    INSERT INTO tasks (id, user_id, project_id, title, due_at, priority)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(5, 1, 3, 'Review PRs', tomorrow5pm, 3)

  // One-off: "Prepare slides" due +3 days
  db.prepare(
    `
    INSERT INTO tasks (id, user_id, project_id, title, due_at, priority)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(6, 1, 1, 'Prepare slides', threeDays, 2)

  // Overdue: "Reply to email" due 2 hours ago (for testing swipe-to-snooze on overdue tasks)
  const twoHoursAgo = DateTime.now().setZone(tz).minus({ hours: 2 }).toUTC().toISO()!
  db.prepare(
    `
    INSERT INTO tasks (id, user_id, project_id, title, due_at, priority)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(7, 1, 1, 'Reply to email', twoHoursAgo, 2)

  // Raw rows, not createTask: the specs pin these ids, the database is opened
  // here (not through getDb), and the stamps below are set by hand. So the
  // repeats get `occurrence_at` from the startup data step's own UPDATE —
  // which the server would otherwise apply at its start.
  seedOccurrenceAt(db)

  // Seeded tasks are not "just added": created a day ago. Left at the schema
  // default (now), every seeded task would also be previewed at the top of
  // the dashboard for the run's first 10 minutes (`src/lib/just-added.ts`).
  // Shifting all of them by the same day keeps their order.
  db.exec(`UPDATE tasks SET created_at = strftime('%Y-%m-%dT%H:%M:%SZ', created_at, '-1 day')`)

  // Task segments (2026-10-10): a task created before today whose target
  // hasn't arrived shows in its horizon's segment on the reminders surfaces —
  // which would put "Buy groceries" on screen twice for every spec that looks
  // for it, on whichever weekday the run happens. The seeded one-offs are made
  // "eventually" (first Saturday of a quarter) and stamped considered a day
  // AHEAD, so they stay out of today's segments; tests/e2e/tm-task-segments.spec.ts
  // makes its own. Not "now": a task considered TODAY is still in its segment,
  // as a considered row, and since 2026-10-11 every segment is a page of the
  // dashboard panel's pager — a "Quarterly 3 of 3" page after the
  // slots that every pager spec would have to step over. A day ahead is never
  // "today" and is past every segment day, so the segment never forms.
  //
  // Upcoming (2026-10-12): a targeted task shows on its heads-up days, counted
  // from `target_set_at` — null reads as created_at, a day back, which would
  // put "Buy groceries" (tomorrow) and the daily tasks in today's Upcoming.
  // Stamped now, as the API would have: a heads-up day is always after the day
  // the target was set, so none of them is ever today.
  db.exec(`UPDATE tasks SET target_set_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`)
  db.exec(
    `UPDATE tasks SET horizon = 'eventually',
       last_considered_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '+1 day')
     WHERE rrule IS NULL`,
  )

  // THE TASK QUEUE'S OWN USER (task-queue PR 3, tests/e2e/tq-queue-panels.spec.ts).
  // That spec runs the rollover through the test route, and a rollover strips
  // every below-High one-off left on a previous day's target — for the shared
  // user that would take the targets off tasks other specs rely on. So the
  // queue spec signs in as this user, with nothing seeded but an Inbox, and
  // runs the rollover for this user only (`user_id`). Its periods are the
  // defaults (`backfillTimeSlots` at startup).
  db.prepare(
    `INSERT INTO users (id, email, name, password_hash, timezone) VALUES (?, ?, ?, ?, ?)`,
  ).run(2, 'queue@opentask.local', 'Queue User', passwordHash, seededUserTz)
  db.prepare(
    `INSERT INTO projects (id, name, owner_id, shared, sort_order) VALUES (?, ?, ?, ?, ?)`,
  ).run(4, 'Inbox', 2, 0, 0)
}
