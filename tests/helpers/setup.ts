/**
 * Shared test utilities for OpenTask behavioral tests
 */

import { getDb, resetDb } from '@/core/db'
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
