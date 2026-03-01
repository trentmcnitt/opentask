/**
 * Global setup for E2E tests
 *
 * Seeds a dedicated E2E database with known tasks.
 * The dev server started by Playwright will use this DB.
 */

import Database from 'better-sqlite3'
import bcrypt from 'bcrypt'
import fs from 'fs'
import path from 'path'
import { DateTime } from 'luxon'
import { hashToken, tokenPreview } from '../../src/core/auth/token-hash'

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

  // Create test user
  const passwordHash = await bcrypt.hash('testpass123', 4)
  db.prepare(
    `
    INSERT INTO users (id, email, name, password_hash, timezone)
    VALUES (?, ?, ?, ?, ?)
  `,
  ).run(1, 'test@opentask.local', 'Test User', passwordHash, 'America/Chicago')

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
  const tz = 'America/Chicago'
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

  db.close()
  console.log('[e2e] Database seeded at', DB_PATH)
}
