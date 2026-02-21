/**
 * Deterministic test seed for OpenTask
 *
 * Creates known users, projects, tokens, and tasks for integration/E2E tests.
 * Uses hardcoded IDs and tokens so test helpers can reference them without coordination files.
 *
 * Usage: imported by test reset endpoint and E2E globalSetup
 */

import bcrypt from 'bcrypt'
import { getDb } from '../src/core/db'
import { DateTime } from 'luxon'

// Fast bcrypt for tests
const SALT_ROUNDS = 4

// Deterministic tokens (64 hex chars each)
export const TOKEN_A = 'a'.repeat(64)
export const TOKEN_B = 'b'.repeat(64)

export const TEST_USER_A = {
  email: 'test@opentask.local',
  name: 'Test User A',
  password: 'testpass123',
  timezone: 'America/Chicago',
}

export const TEST_USER_B = {
  email: 'test2@opentask.local',
  name: 'Test User B',
  password: 'testpass456',
  timezone: 'America/New_York',
}

/**
 * Seed the test database with deterministic data.
 * Expects a fresh (empty but schema-initialized) database.
 */
export async function seedTestData(): Promise<void> {
  const db = getDb()

  // Hash passwords
  const hashA = await bcrypt.hash(TEST_USER_A.password, SALT_ROUNDS)
  const hashB = await bcrypt.hash(TEST_USER_B.password, SALT_ROUNDS)

  // Insert users
  db.prepare(
    `
    INSERT INTO users (id, email, name, password_hash, timezone)
    VALUES (?, ?, ?, ?, ?)
  `,
  ).run(1, TEST_USER_A.email, TEST_USER_A.name, hashA, TEST_USER_A.timezone)

  db.prepare(
    `
    INSERT INTO users (id, email, name, password_hash, timezone)
    VALUES (?, ?, ?, ?, ?)
  `,
  ).run(2, TEST_USER_B.email, TEST_USER_B.name, hashB, TEST_USER_B.timezone)

  // Insert projects for User A
  db.prepare(
    `
    INSERT INTO projects (id, name, owner_id, shared, sort_order, color)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(1, 'Inbox', 1, 0, 0, 'blue')

  db.prepare(
    `
    INSERT INTO projects (id, name, owner_id, shared, sort_order, color)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(2, 'Routine', 1, 0, 1, 'green')

  db.prepare(
    `
    INSERT INTO projects (id, name, owner_id, shared, sort_order, color)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(3, 'Work', 1, 0, 2, 'orange')

  // Insert project for User B
  db.prepare(
    `
    INSERT INTO projects (id, name, owner_id, shared, sort_order, color)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(4, 'Inbox', 2, 0, 0, 'blue')

  // Shared project (owned by User A)
  db.prepare(
    `
    INSERT INTO projects (id, name, owner_id, shared, sort_order, color)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(5, 'Family', 1, 1, 4, 'pink')

  // Insert API tokens
  db.prepare(
    `
    INSERT INTO api_tokens (user_id, token, name)
    VALUES (?, ?, ?)
  `,
  ).run(1, TOKEN_A, 'Test Token A')

  db.prepare(
    `
    INSERT INTO api_tokens (user_id, token, name)
    VALUES (?, ?, ?)
  `,
  ).run(2, TOKEN_B, 'Test Token B')

  // Insert some baseline tasks for User A
  // Use future dates to ensure tests are time-agnostic (pass at any time of day)
  const tomorrow = DateTime.now()
    .setZone(TEST_USER_A.timezone)
    .plus({ days: 1 })
    .set({ hour: 9, minute: 0, second: 0, millisecond: 0 })
    .toUTC()
    .toISO()!

  // Use tomorrow 7am for "morning" tasks to ensure they're always upcoming
  const tomorrowMorning = DateTime.now()
    .setZone(TEST_USER_A.timezone)
    .plus({ days: 1 })
    .set({ hour: 7, minute: 0, second: 0, millisecond: 0 })
    .toUTC()
    .toISO()!

  // One-off task due tomorrow
  db.prepare(
    `
    INSERT INTO tasks (id, user_id, project_id, title, due_at, priority)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(1, 1, 1, 'Buy groceries', tomorrow, 2)

  // Recurring daily task
  db.prepare(
    `
    INSERT INTO tasks (id, user_id, project_id, title, due_at, rrule, recurrence_mode, priority)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(2, 1, 2, 'Morning routine', tomorrowMorning, 'FREQ=DAILY', 'from_due', 1)

  // Task for User B (isolation test)
  db.prepare(
    `
    INSERT INTO tasks (id, user_id, project_id, title, due_at, priority)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(3, 2, 4, 'User B task', tomorrow, 0)

  // Additional tasks for User A for bulk/search tests
  db.prepare(
    `
    INSERT INTO tasks (id, user_id, project_id, title, due_at, priority, labels)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(4, 1, 3, 'Review PRs', tomorrowMorning, 3, '["work","dev"]')

  db.prepare(
    `
    INSERT INTO tasks (id, user_id, project_id, title, due_at, priority)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(5, 1, 1, 'Prepare slides', tomorrow, 2)

  // Recurring weekly task
  db.prepare(
    `
    INSERT INTO tasks (id, user_id, project_id, title, due_at, rrule, recurrence_mode, priority)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(6, 1, 3, 'Weekly standup', tomorrow, 'FREQ=WEEKLY;BYDAY=MO', 'from_due', 1)

  // Extra tasks for bulk operations
  db.prepare(
    `
    INSERT INTO tasks (id, user_id, project_id, title, due_at, priority)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(7, 1, 1, 'Clean desk', tomorrow, 0)

  db.prepare(
    `
    INSERT INTO tasks (id, user_id, project_id, title, due_at, priority)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(8, 1, 1, 'Call dentist', tomorrow, 1)
}
