/**
 * Snooze Behavioral Tests (SN-001 through SN-005)
 *
 * Tests the snooze system with snoozed_from tracking.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { getDb, resetDb } from '@/core/db'
import { createTask, getTaskById, markDone } from '@/core/tasks'
import { snoozeTask } from '@/core/tasks/snooze'
import { DateTime } from 'luxon'

const TEST_TIMEZONE = 'America/Chicago'
const TEST_USER_ID = 1

// Helper to create a future time (always in the future)
function futureTime(hoursFromNow: number = 1): string {
  return DateTime.now()
    .setZone(TEST_TIMEZONE)
    .plus({ hours: hoursFromNow })
    .toUTC()
    .toISO()!
}

// Helper to create a time in the future at a specific hour (tomorrow)
function futureLocalTime(hour: number, minute: number = 0, daysFromNow: number = 1): string {
  return DateTime.now()
    .setZone(TEST_TIMEZONE)
    .plus({ days: daysFromNow })
    .set({ hour, minute, second: 0, millisecond: 0 })
    .toUTC()
    .toISO()!
}

describe('Snooze Behavioral Tests', () => {
  beforeEach(() => {
    resetDb()
    const db = getDb()

    // Seed test user
    db.prepare(`
      INSERT INTO users (id, email, name, password_hash, timezone)
      VALUES (?, ?, ?, ?, ?)
    `).run(TEST_USER_ID, 'test@example.com', 'Test User', 'hash', TEST_TIMEZONE)

    // Seed inbox project
    db.prepare(`
      INSERT INTO projects (id, name, owner_id, shared, sort_order)
      VALUES (1, 'Inbox', ?, 0, 0)
    `).run(TEST_USER_ID)
  })

  afterEach(() => {
    resetDb()
  })

  /**
   * SN-001: First Snooze Captures Original
   *
   * First snooze saves original `due_at` to `snoozed_from`.
   *
   * Task: due_at=tomorrow 08:00, snoozed_from=NULL
   * Action: Snooze to 14:00
   * Result: due_at=tomorrow 14:00, snoozed_from=tomorrow 08:00
   */
  test('SN-001: First snooze captures original due_at in snoozed_from', () => {
    // Create task due at 8:00 AM tomorrow (guaranteed future)
    const originalDueAt = futureLocalTime(8, 0, 1)
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Test task',
        due_at: originalDueAt,
      },
    })

    expect(task.snoozed_from).toBeNull()

    // Snooze to 2:00 PM tomorrow (also future, later than original)
    const snoozeTo = futureLocalTime(14, 0, 1)
    const result = snoozeTask({
      userId: TEST_USER_ID,
      taskId: task.id,
      until: snoozeTo,
    })

    // Verify due_at changed
    expect(result.task.due_at).toBe(snoozeTo)

    // Verify snoozed_from captures original
    expect(result.task.snoozed_from).toBe(originalDueAt)
    expect(result.snoozedFrom).toBe(originalDueAt)
  })

  /**
   * SN-002: Re-Snooze Preserves Original
   *
   * Subsequent snoozes keep the original `snoozed_from`.
   *
   * Task: due_at=tomorrow 14:00, snoozed_from=tomorrow 08:00
   * Action: Snooze to 16:00
   * Result: due_at=tomorrow 16:00, snoozed_from=tomorrow 08:00 (not 14:00)
   */
  test('SN-002: Re-snooze preserves original snoozed_from', () => {
    // Create task due at 8:00 AM tomorrow
    const originalDueAt = futureLocalTime(8, 0, 1)
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Test task',
        due_at: originalDueAt,
      },
    })

    // First snooze to 2:00 PM tomorrow
    const firstSnoozeTime = futureLocalTime(14, 0, 1)
    snoozeTask({
      userId: TEST_USER_ID,
      taskId: task.id,
      until: firstSnoozeTime,
    })

    // Verify state after first snooze
    const snoozedTask = getTaskById(task.id)!
    expect(snoozedTask.due_at).toBe(firstSnoozeTime)
    expect(snoozedTask.snoozed_from).toBe(originalDueAt)

    // Second snooze to 4:00 PM tomorrow
    const secondSnoozeTime = futureLocalTime(16, 0, 1)
    const result = snoozeTask({
      userId: TEST_USER_ID,
      taskId: task.id,
      until: secondSnoozeTime,
    })

    // Verify due_at updated to new snooze time
    expect(result.task.due_at).toBe(secondSnoozeTime)

    // Verify snoozed_from still preserves ORIGINAL (8:00 AM), not intermediate (2:00 PM)
    expect(result.task.snoozed_from).toBe(originalDueAt)
  })

  /**
   * SN-003: Done Clears Snooze
   *
   * Marking a snoozed recurring task done clears `snoozed_from`.
   *
   * Task: due_at=tomorrow 14:00, snoozed_from=tomorrow 08:00, recurring
   * Action: Mark done
   * Result: due_at=day after tomorrow 08:00, snoozed_from=NULL
   */
  test('SN-003: Marking done on snoozed recurring task clears snoozed_from', () => {
    // Create recurring task due at 8:00 AM tomorrow
    const originalDueAt = futureLocalTime(8, 0, 1)
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: '[M] Test recurring task',
        due_at: originalDueAt,
        rrule: 'FREQ=DAILY;BYHOUR=8;BYMINUTE=0',
      },
    })

    expect(task.rrule).not.toBeNull()

    // Snooze to 2:00 PM tomorrow
    const snoozeTo = futureLocalTime(14, 0, 1)
    snoozeTask({
      userId: TEST_USER_ID,
      taskId: task.id,
      until: snoozeTo,
    })

    // Verify task is snoozed
    const snoozedTask = getTaskById(task.id)!
    expect(snoozedTask.due_at).toBe(snoozeTo)
    expect(snoozedTask.snoozed_from).toBe(originalDueAt)

    // Mark done
    const result = markDone({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
    })

    // Verify snoozed_from is cleared (THE KEY ASSERTION for SN-003)
    expect(result.task.snoozed_from).toBeNull()

    // Verify due_at advanced to next occurrence at anchor time
    // The exact date depends on when the test runs, but it should be at 8:00 AM
    const nextDueAt = DateTime.fromISO(result.task.due_at!).setZone(TEST_TIMEZONE)
    expect(nextDueAt.hour).toBe(8)
    expect(nextDueAt.minute).toBe(0)

    // Verify the task is no longer at the snoozed time (2:00 PM)
    expect(result.task.due_at).not.toBe(snoozeTo)
  })

  /**
   * SN-004: Snooze Rejects Past Time
   *
   * Snoozing to a time in the past returns 400 error.
   */
  test('SN-004: Snooze rejects past time', () => {
    // Create task
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Test task',
        due_at: futureTime(2),
      },
    })

    // Try to snooze to past time
    const pastTime = DateTime.now()
      .setZone(TEST_TIMEZONE)
      .minus({ hours: 1 })
      .toUTC()
      .toISO()!

    expect(() =>
      snoozeTask({
        userId: TEST_USER_ID,
        taskId: task.id,
        until: pastTime,
      })
    ).toThrow('Snooze target must be in the future')
  })

  /**
   * SN-005: Only Active Tasks Can Be Snoozed
   *
   * Cannot snooze done or trashed tasks. Returns 400 error.
   */
  describe('SN-005: Only active tasks can be snoozed', () => {
    test('Cannot snooze done task', () => {
      // Create and complete a one-off task
      const task = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: {
          title: 'One-off task',
          due_at: futureTime(2),
        },
      })

      // Mark done
      markDone({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        taskId: task.id,
      })

      // Verify task is done
      const doneTask = getTaskById(task.id)!
      expect(doneTask.done).toBe(true)

      // Try to snooze done task
      expect(() =>
        snoozeTask({
          userId: TEST_USER_ID,
          taskId: task.id,
          until: futureTime(3),
        })
      ).toThrow('Cannot snooze done task')
    })

    test('Cannot snooze trashed task', () => {
      // Create task
      const task = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: {
          title: 'Test task',
          due_at: futureTime(2),
        },
      })

      // Trash the task directly
      const db = getDb()
      const now = DateTime.now().toUTC().toISO()
      db.prepare('UPDATE tasks SET deleted_at = ? WHERE id = ?').run(now, task.id)

      // Verify task is trashed
      const trashedTask = getTaskById(task.id)!
      expect(trashedTask.deleted_at).not.toBeNull()

      // Try to snooze trashed task
      expect(() =>
        snoozeTask({
          userId: TEST_USER_ID,
          taskId: task.id,
          until: futureTime(3),
        })
      ).toThrow('Cannot snooze trashed task')
    })
  })
})
