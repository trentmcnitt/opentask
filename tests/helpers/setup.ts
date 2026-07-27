/**
 * Shared test utilities for OpenTask behavioral tests
 */

import { getDb, resetDb } from '@/core/db'
import { seedSystemLabels, createLabel } from '@/core/labels'
import { seedDefaultTimeSlots } from '@/core/time-slots'
import { DateTime } from 'luxon'

export const TEST_TIMEZONE = 'America/Chicago'
export const TEST_USER_ID = 1
export const TEST_USER_EMAIL = 'test@example.com'

/**
 * Create a test date in local timezone
 */
export function localTime(hour: number, minute: number = 0, daysFromNow: number = 0): string {
  return DateTime.now()
    .setZone(TEST_TIMEZONE)
    .plus({ days: daysFromNow })
    .set({ hour, minute, second: 0, millisecond: 0 })
    .toUTC()
    .toISO()!
}

/**
 * Seed the test database with a user and default project
 */
export function seedTestUser(
  userId: number = TEST_USER_ID,
  email: string = TEST_USER_EMAIL,
  timezone: string = TEST_TIMEZONE,
): void {
  const db = getDb()

  db.prepare(
    `
    INSERT INTO users (id, email, name, password_hash, timezone)
    VALUES (?, ?, ?, ?, ?)
  `,
  ).run(userId, email, 'Test User', 'hash', timezone)

  // Register the system label vocabulary (§7.2). The startup backfill runs at
  // schema-init, before this user exists, so it can't cover them.
  seedSystemLabels(userId)
  seedDefaultTimeSlots(userId)
}

/**
 * Register domain labels for a test user.
 *
 * §7.2 makes creating a label a discrete act, so task writes reject unknown
 * labels. Tests that exercise *other* behavior (bulk label ops, enrichment,
 * data integrity) operate on a user who already has a taxonomy — that is the
 * realistic state — and should not have to opt into label creation at every
 * call site. Tests that exercise the gating itself deliberately use names that
 * are NOT seeded here.
 */
export function seedTestLabels(names: string[], userId: number = TEST_USER_ID): void {
  for (const name of names) createLabel(userId, name)
}

/**
 * Seed a project for testing
 */
export function seedTestProject(
  projectId: number = 1,
  name: string = 'Inbox',
  ownerId: number = TEST_USER_ID,
  shared: boolean = false,
): void {
  const db = getDb()

  db.prepare(
    `
    INSERT INTO projects (id, name, owner_id, shared, sort_order)
    VALUES (?, ?, ?, ?, 0)
  `,
  ).run(projectId, name, ownerId, shared ? 1 : 0)
}

/**
 * Setup a clean test database with a user and inbox project
 */
export function setupTestDb(): void {
  resetDb()
  seedTestUser()
  seedTestProject()
}

/**
 * Clean up the test database
 */
export function teardownTestDb(): void {
  resetDb()
}
