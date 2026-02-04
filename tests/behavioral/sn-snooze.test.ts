/**
 * Snooze Behavioral Tests (SN-001 through SN-010)
 *
 * Tests the snooze system with original_due_at tracking.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { getDb, resetDb } from '@/core/db'
import { createTask, getTaskById, markDone, updateTask } from '@/core/tasks'
import { snoozeTask } from '@/core/tasks/snooze'
import { executeUndo, getUndoHistory } from '@/core/undo'
import { DateTime } from 'luxon'

const TEST_TIMEZONE = 'America/Chicago'
const TEST_USER_ID = 1

// Helper to create a future time (always in the future)
function futureTime(hoursFromNow: number = 1): string {
  return DateTime.now().setZone(TEST_TIMEZONE).plus({ hours: hoursFromNow }).toUTC().toISO()!
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
    db.prepare(
      `
      INSERT INTO users (id, email, name, password_hash, timezone)
      VALUES (?, ?, ?, ?, ?)
    `,
    ).run(TEST_USER_ID, 'test@example.com', 'Test User', 'hash', TEST_TIMEZONE)

    // Seed inbox project
    db.prepare(
      `
      INSERT INTO projects (id, name, owner_id, shared, sort_order)
      VALUES (1, 'Inbox', ?, 0, 0)
    `,
    ).run(TEST_USER_ID)
  })

  afterEach(() => {
    resetDb()
  })

  /**
   * SN-001: First Snooze Captures Original
   *
   * First snooze saves original `due_at` to `original_due_at`.
   *
   * Task: due_at=tomorrow 08:00, original_due_at=NULL
   * Action: Snooze to 14:00
   * Result: due_at=tomorrow 14:00, original_due_at=tomorrow 08:00
   */
  test('SN-001: First snooze captures original due_at in original_due_at', () => {
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

    expect(task.original_due_at).toBeNull()

    // Snooze to 2:00 PM tomorrow (also future, later than original)
    const snoozeTo = futureLocalTime(14, 0, 1)
    const result = snoozeTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
      until: snoozeTo,
    })

    // Verify due_at changed
    expect(result.task.due_at).toBe(snoozeTo)

    // Verify original_due_at captures original
    expect(result.task.original_due_at).toBe(originalDueAt)
    expect(result.originalDueAt).toBe(originalDueAt)
  })

  /**
   * SN-002: Re-Snooze Preserves Original
   *
   * Subsequent snoozes keep the original `original_due_at`.
   *
   * Task: due_at=tomorrow 14:00, original_due_at=tomorrow 08:00
   * Action: Snooze to 16:00
   * Result: due_at=tomorrow 16:00, original_due_at=tomorrow 08:00 (not 14:00)
   */
  test('SN-002: Re-snooze preserves original original_due_at', () => {
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
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
      until: firstSnoozeTime,
    })

    // Verify state after first snooze
    const snoozedTask = getTaskById(task.id)!
    expect(snoozedTask.due_at).toBe(firstSnoozeTime)
    expect(snoozedTask.original_due_at).toBe(originalDueAt)

    // Second snooze to 4:00 PM tomorrow
    const secondSnoozeTime = futureLocalTime(16, 0, 1)
    const result = snoozeTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
      until: secondSnoozeTime,
    })

    // Verify due_at updated to new snooze time
    expect(result.task.due_at).toBe(secondSnoozeTime)

    // Verify original_due_at still preserves ORIGINAL (8:00 AM), not intermediate (2:00 PM)
    expect(result.task.original_due_at).toBe(originalDueAt)
  })

  /**
   * SN-003: Done Clears Snooze
   *
   * Marking a snoozed recurring task done clears `original_due_at`.
   *
   * Task: due_at=tomorrow 14:00, original_due_at=tomorrow 08:00, recurring
   * Action: Mark done
   * Result: due_at=day after tomorrow 08:00, original_due_at=NULL
   */
  test('SN-003: Marking done on snoozed recurring task clears original_due_at', () => {
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
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
      until: snoozeTo,
    })

    // Verify task is snoozed
    const snoozedTask = getTaskById(task.id)!
    expect(snoozedTask.due_at).toBe(snoozeTo)
    expect(snoozedTask.original_due_at).toBe(originalDueAt)

    // Mark done
    const result = markDone({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
    })

    // Verify original_due_at is cleared (THE KEY ASSERTION for SN-003)
    expect(result.task.original_due_at).toBeNull()

    // Verify due_at advanced to next occurrence at anchor time
    // The exact date depends on when the test runs, but it should be at 8:00 AM
    const nextDueAt = DateTime.fromISO(result.task.due_at!).setZone(TEST_TIMEZONE)
    expect(nextDueAt.hour).toBe(8)
    expect(nextDueAt.minute).toBe(0)

    // Verify the task is no longer at the snoozed time (2:00 PM)
    expect(result.task.due_at).not.toBe(snoozeTo)
  })
})

describe('Snooze Validation Tests', () => {
  beforeEach(() => {
    resetDb()
    const db = getDb()

    db.prepare(
      `
      INSERT INTO users (id, email, name, password_hash, timezone)
      VALUES (?, ?, ?, ?, ?)
    `,
    ).run(TEST_USER_ID, 'test@example.com', 'Test User', 'hash', TEST_TIMEZONE)

    db.prepare(
      `
      INSERT INTO projects (id, name, owner_id, shared, sort_order)
      VALUES (1, 'Inbox', ?, 0, 0)
    `,
    ).run(TEST_USER_ID)
  })

  afterEach(() => {
    resetDb()
  })

  /**
   * SN-004: Snooze Allows Past Time
   *
   * Snoozing to a time in the past is allowed - the task will appear overdue.
   * This enables users to freely adjust due dates using increment/decrement controls.
   */
  test('SN-004: Snooze allows past time (task appears overdue)', () => {
    // Create task
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Test task',
        due_at: futureTime(2),
      },
    })

    // Snooze to past time - should succeed
    const pastTime = DateTime.now().setZone(TEST_TIMEZONE).minus({ hours: 1 }).toUTC().toISO()!

    const result = snoozeTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
      until: pastTime,
    })

    // Task should be snoozed to the past time
    expect(result.task.due_at).toBe(pastTime)
    // And it's now overdue
    expect(new Date(result.task.due_at!).getTime()).toBeLessThan(Date.now())
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
          userTimezone: TEST_TIMEZONE,
          taskId: task.id,
          until: futureTime(3),
        }),
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
          userTimezone: TEST_TIMEZONE,
          taskId: task.id,
          until: futureTime(3),
        }),
      ).toThrow('Cannot snooze trashed task')
    })
  })

  /**
   * SN-006: snooze_count increments on EVERY snooze
   *
   * The new behavior increments snooze_count every time a task is snoozed,
   * not just on the first snooze.
   */
  test('SN-006: snooze_count increments on EVERY snooze', () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Test task',
        due_at: futureTime(1),
      },
    })

    expect(task.snooze_count).toBe(0)

    // First snooze
    snoozeTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
      until: futureTime(2),
    })
    expect(getTaskById(task.id)!.snooze_count).toBe(1)

    // Second snooze - should increment
    snoozeTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
      until: futureTime(3),
    })
    expect(getTaskById(task.id)!.snooze_count).toBe(2)

    // Third snooze - should increment again
    snoozeTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
      until: futureTime(4),
    })
    expect(getTaskById(task.id)!.snooze_count).toBe(3)
  })

  /**
   * SN-007: PATCH with due_at change applies snooze logic
   *
   * When updating a task via PATCH with a due_at change (and no rrule change),
   * snooze logic is applied automatically.
   */
  test('SN-007: PATCH with due_at change applies snooze logic', () => {
    const originalDueAt = futureTime(1)
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Test task',
        due_at: originalDueAt,
      },
    })

    expect(task.original_due_at).toBeNull()
    expect(task.snooze_count).toBe(0)

    // Update due_at via PATCH
    const { task: updatedTask } = updateTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
      input: { due_at: futureTime(3) },
    })

    // Snooze logic should have been applied
    expect(updatedTask.original_due_at).toBe(originalDueAt)
    expect(updatedTask.snooze_count).toBe(1)
  })

  /**
   * SN-008: PATCH with due_at + priority = single undo entry
   *
   * When changing multiple fields including due_at in one PATCH,
   * a single undo entry is created with all changes.
   */
  test('SN-008: PATCH with due_at + priority = single undo entry', () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Test task',
        due_at: futureTime(1),
        priority: 2,
      },
    })

    // Update both due_at and priority in one PATCH
    updateTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
      input: { due_at: futureTime(3), priority: 4 },
    })

    // Get the most recent undo entry
    const history = getUndoHistory(TEST_USER_ID, 10)
    const editEntry = history.find((e) => e.action === 'edit')

    expect(editEntry).toBeDefined()
    expect(editEntry!.fields_changed).toContain('due_at')
    expect(editEntry!.fields_changed).toContain('priority')
    expect(editEntry!.fields_changed).toContain('snooze_count')
    expect(editEntry!.fields_changed).toContain('original_due_at')
  })

  /**
   * SN-009: undo restores snooze_count correctly
   */
  test('SN-009: undo restores snooze_count correctly', () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Test task',
        due_at: futureTime(1),
      },
    })

    expect(task.snooze_count).toBe(0)

    // Snooze the task
    snoozeTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
      until: futureTime(3),
    })
    expect(getTaskById(task.id)!.snooze_count).toBe(1)

    // Undo
    executeUndo(TEST_USER_ID)

    // snooze_count should be restored to 0
    expect(getTaskById(task.id)!.snooze_count).toBe(0)
  })

  /**
   * SN-010: PATCH with rrule change does NOT apply snooze logic
   *
   * When changing rrule, the snooze logic should not be applied even if due_at changes,
   * because changing the recurrence rule is a different operation than snoozing.
   */
  test('SN-010: PATCH with rrule change does NOT apply snooze logic', () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Test task',
        due_at: futureTime(1),
      },
    })

    expect(task.snooze_count).toBe(0)

    // Update with both rrule and due_at
    const { task: updatedTask } = updateTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
      input: { rrule: 'FREQ=DAILY', due_at: futureTime(3) },
    })

    // Snooze logic should NOT have been applied
    expect(updatedTask.snooze_count).toBe(0)
  })
})
