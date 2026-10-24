/**
 * Snooze Behavioral Tests (SN-001 through SN-027)
 *
 * Tests the snooze system with original_due_at tracking.
 *
 * SN-001 to SN-005: Core snooze behavior
 * SN-006 to SN-010: Snooze tracking and undo
 * SN-011 to SN-012: Snooze tracking cleared on rrule change
 */

import { CALENDAR_DAY_START } from '@/lib/opentask-day'
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { getDb, resetDb } from '@/core/db'
import { createTask, getTaskById, markDone, updateTask } from '@/core/tasks'
import { snoozeTask } from '@/core/tasks/snooze'
import { executeUndo, getUndoHistory } from '@/core/undo'
import { computeSnoozeTime, snapToHour } from '@/lib/snooze'
import { DateTime } from 'luxon'
import { setupTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

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
    setupTestDb()
  })

  afterEach(() => {
    resetDb()
  })

  /**
   * SN-001: First Snooze Preserves Original
   *
   * original_due_at is set at creation time (eager). First snooze preserves it.
   *
   * Task: due_at=tomorrow 08:00, original_due_at=tomorrow 08:00
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

    // original_due_at is set eagerly at creation time
    expect(task.original_due_at).toBe(originalDueAt)

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
   * SN-003: Done Resets Original to New Occurrence
   *
   * Marking a snoozed recurring task done advances due_at and resets
   * original_due_at to the new occurrence's due_at.
   *
   * Task: due_at=tomorrow 14:00, original_due_at=tomorrow 08:00, recurring
   * Action: Mark done
   * Result: due_at=day after tomorrow 08:00, original_due_at=day after tomorrow 08:00
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

    // Verify original_due_at is reset to the new occurrence's due_at
    expect(result.task.original_due_at).toBe(result.task.due_at)

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
    test('Cannot defer done task', () => {
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
      ).toThrow('Cannot defer done task')
    })

    test('Cannot defer trashed task', () => {
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
      ).toThrow('Cannot defer trashed task')
    })
  })

  /**
   * SN-006: snooze_count increments on EVERY snooze
   *
   * Since 2026-10-12 (§6) a snooze is just a move of the target: nothing is
   * counted, and the first-target date is kept however many times it moves.
   */
  test('SN-006: every snooze is a move — the target moves, the first-target date stays', () => {
    const first = futureTime(1)
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Test task',
        due_at: first,
      },
    })

    // No snooze state since 2026-10-12 (§6): no count, no snoozed flag.
    expect(task).not.toHaveProperty('snooze_count')
    expect(task).not.toHaveProperty('is_snoozed')

    for (const hours of [2, 3, 4]) {
      const until = futureTime(hours)
      snoozeTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        taskId: task.id,
        until,
      })
      const after = getTaskById(task.id)!
      expect(after.due_at).toBe(until)
      expect(after.original_due_at).toBe(first)
    }
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

    // original_due_at is set eagerly at creation time
    expect(task.original_due_at).toBe(originalDueAt)

    // Update due_at via PATCH
    const { task: updatedTask, description } = updateTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
      input: { due_at: futureTime(3) },
    })

    // A move: original_due_at preserved from creation, worded as a snooze
    expect(updatedTask.original_due_at).toBe(originalDueAt)
    expect(description).toMatch(/^Deferred to/)
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
    expect(editEntry!.fields_changed).not.toContain('snooze_count')
    // original_due_at is NOT in fields_changed because it was already set at creation time
    expect(editEntry!.fields_changed).not.toContain('original_due_at')
  })

  /**
   * SN-009: undo puts the target back (there is no snooze count to restore)
   */
  test('SN-009: undo of a snooze restores the target and the origin', () => {
    const first = futureTime(1)
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Test task',
        due_at: first,
      },
    })

    // Snooze the task
    const until = futureTime(3)
    snoozeTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
      until,
    })
    expect(getTaskById(task.id)!.due_at).toBe(until)

    // Undo
    executeUndo(TEST_USER_ID)

    const restored = getTaskById(task.id)!
    expect(restored.due_at).toBe(first)
    expect(restored.original_due_at).toBe(first)
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

    // Update with both rrule and due_at
    const when = futureTime(3)
    const { task: updatedTask, description } = updateTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
      input: { rrule: 'FREQ=DAILY', due_at: when },
    })

    // A re-schedule, not a move: the date is honored, the old origin dropped,
    // and the description does not call it a snooze.
    expect(updatedTask.due_at).toBe(when)
    expect(updatedTask.original_due_at).toBeNull()
    expect(description).not.toMatch(/defer/i)
  })

  /**
   * SN-011: Snoozed (moved) task + rrule change keeps its target and origin
   *
   * PR 4a (2026-10-22, ruling A1): a target moved this occurrence is the
   * user's own, so a schedule change keeps it — and its origin with it (the
   * age clock: still the same occurrence). An occurrence on its schedule
   * still drops the origin with the new rule (RD-018, TR-028).
   *
   * Task: snoozed twice (original_due_at set)
   * Action: Change rrule
   * Result: due_at and original_due_at kept, anchors re-derived
   */
  test('SN-011: Snoozed (moved) task + rrule change keeps its target and origin', () => {
    // Create recurring task
    const originalDueAt = futureLocalTime(8, 0, 1)
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Daily task',
        due_at: originalDueAt,
        rrule: 'FREQ=DAILY;BYHOUR=8;BYMINUTE=0',
      },
    })

    // Snooze twice
    snoozeTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
      until: futureLocalTime(14, 0, 1),
    })
    snoozeTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
      until: futureLocalTime(16, 0, 1),
    })

    // Verify snoozed state
    const snoozedTask = getTaskById(task.id)!
    expect(snoozedTask.original_due_at).toBe(originalDueAt)

    // Change rrule from daily to weekly
    const { task: updatedTask } = updateTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
      input: { rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0' },
    })

    // The moved target and its origin stay with the occurrence (PR 4a)
    expect(updatedTask.due_at).toBe(futureLocalTime(16, 0, 1))
    expect(updatedTask.original_due_at).toBe(originalDueAt)

    // Anchors should be re-derived from new rrule
    expect(updatedTask.anchor_time).toBe('09:00')
    expect(updatedTask.anchor_dow).toBe(0) // Monday
  })

  /**
   * SN-012: Add rrule to snoozed one-off task clears snooze tracking
   *
   * When converting a snoozed one-off task to recurring by adding an rrule,
   * the snooze tracking is cleared and due_at is computed to next occurrence.
   *
   * Task: one-off, snoozed (original_due_at set)
   * Action: Add rrule to make it recurring
   * Result: original_due_at=NULL, due_at computed to next occurrence
   */
  test('SN-012: Add rrule to snoozed one-off task clears snooze tracking', () => {
    // Create one-off task
    const originalDueAt = futureLocalTime(8, 0, 1)
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'One-off task',
        due_at: originalDueAt,
      },
    })

    expect(task.rrule).toBeNull()

    // Snooze the task
    snoozeTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
      until: futureLocalTime(14, 0, 1),
    })

    // Verify snoozed state
    const snoozedTask = getTaskById(task.id)!
    expect(snoozedTask.original_due_at).toBe(originalDueAt)

    // Add rrule to convert to recurring
    const { task: updatedTask } = updateTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
      input: { rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0' },
    })

    // Snooze tracking should be cleared (converting to recurring = new baseline)
    expect(updatedTask.original_due_at).toBeNull()

    // Task is now recurring
    expect(updatedTask.rrule).toBe('FREQ=DAILY;BYHOUR=9;BYMINUTE=0')
    expect(updatedTask.anchor_time).toBe('09:00')

    // due_at should be auto-computed to next occurrence
    // (not the snoozed 2 PM, but computed from rrule)
    const dueAtDt = DateTime.fromISO(updatedTask.due_at!).setZone(TEST_TIMEZONE)
    expect(dueAtDt.hour).toBe(9)
    expect(dueAtDt.minute).toBe(0)
  })

  /**
   * SN-013: Clearing due_at to null is NOT a snooze
   *
   * When a user clears the due date (sets due_at to null), it is not a move:
   * no "Snoozed to" description, and original_due_at goes with the date.
   */
  test('SN-013: clearing due_at to null is not a snooze and clears the origin', () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Task with due date',
        due_at: futureLocalTime(14, 0),
      },
    })

    expect(task.due_at).not.toBeNull()
    // original_due_at is set eagerly at creation time
    expect(task.original_due_at).toBe(task.due_at)

    // Clear due_at and rrule to null
    const { task: updated, description } = updateTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
      input: { due_at: null, rrule: null },
    })

    expect(updated.due_at).toBeNull()
    expect(description).not.toMatch(/defer/i)
    expect(updated.original_due_at).toBeNull()
  })

  /**
   * SN-014: Clearing due_at on a previously-snoozed task does not add another snooze
   *
   * A moved task keeps its first-target date — until the target is cleared,
   * which takes the origin with it.
   */
  test('SN-014: clearing due_at on a moved task clears its origin too', () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Snoozed task',
        due_at: futureLocalTime(9, 0),
      },
    })

    // Snooze once (move to a new date)
    const { task: snoozed } = updateTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
      input: { due_at: futureLocalTime(14, 0) },
    })

    expect(snoozed.original_due_at).toBe(task.due_at)

    // Now clear due_at
    const { task: cleared } = updateTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: snoozed.id,
      input: { due_at: null, rrule: null },
    })

    expect(cleared.due_at).toBeNull()
    expect(cleared.original_due_at).toBeNull()
  })
})

describe('Reset original_due_at', () => {
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
   * SN-025: on an ordinary task `reset_original_due_at` is accepted and
   * IGNORED since 2026-10-12 (§6, ruling Q4: a move is a move) — the
   * first-target date stays.
   */
  test('SN-025: reset_original_due_at on a task changes nothing', () => {
    const originalDueAt = futureLocalTime(8, 0, 1)
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Snoozed task',
        due_at: originalDueAt,
      },
    })

    // Snooze twice
    snoozeTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
      until: futureLocalTime(14, 0, 1),
    })
    snoozeTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
      until: futureLocalTime(16, 0, 1),
    })

    const snoozedTask = getTaskById(task.id)!
    expect(snoozedTask.original_due_at).toBe(originalDueAt)

    // Reset origin — ignored
    const { task: resetTask, fieldsChanged } = updateTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
      input: { reset_original_due_at: true },
    })

    expect(fieldsChanged).toEqual([])
    expect(resetTask.original_due_at).toBe(originalDueAt)
    expect(resetTask.due_at).toBe(snoozedTask.due_at)
  })

  /**
   * SN-026: on a REMINDER the flag still means an explicit reschedule (a
   * period move sends it): the new date becomes the origin, and undo restores
   * both.
   */
  test('SN-026: a reminder reschedule sets the origin; undo restores both', () => {
    const originalDueAt = futureLocalTime(8, 0, 1)
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Take the bins out',
        due_at: originalDueAt,
        is_reminder: true,
      },
    })
    expect(task.original_due_at).toBe(originalDueAt)

    const newDate = futureLocalTime(14, 0, 1)
    const { task: moved } = updateTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
      input: { reset_original_due_at: true, due_at: newDate },
    })
    expect(moved.due_at).toBe(newDate)
    expect(moved.original_due_at).toBe(newDate)

    // Undo
    executeUndo(TEST_USER_ID)

    const restored = getTaskById(task.id)!
    expect(restored.due_at).toBe(originalDueAt)
    expect(restored.original_due_at).toBe(originalDueAt)
  })

  /**
   * SN-027: reset on a task that never moved is a no-op too
   */
  test('SN-027: reset on un-snoozed task is a no-op', () => {
    const dueAt = futureLocalTime(8, 0, 1)
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Fresh task',
        due_at: dueAt,
      },
    })

    expect(task.original_due_at).toBe(dueAt)

    const { task: resetTask, fieldsChanged } = updateTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
      input: { reset_original_due_at: true },
    })

    // No fields should have changed
    expect(fieldsChanged).toEqual([])
    expect(resetTask.original_due_at).toBe(dueAt)
  })
})

describe('computeSnoozeTime rounding', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  /**
   * SN-015: Snooze +1h at :45 rounds UP to the next hour
   *
   * At 8:45 AM, snoozing +1h computes 9:45 AM. Since 45 >= 35,
   * it should round up to 10:00 AM (not truncate to 9:00 AM).
   */
  test('SN-015: +1h at :45 rounds up (minutes >= 35 threshold)', () => {
    // Freeze time to 8:45 AM UTC
    vi.setSystemTime(new Date('2026-01-15T08:45:00Z'))

    const result = computeSnoozeTime('60', 'UTC', '09:00', CALENDAR_DAY_START)
    const d = new Date(result)

    // 8:45 + 60m = 9:45 → 45 >= 35 → rounds up to 10:00
    expect(d.getUTCHours()).toBe(10)
    expect(d.getUTCMinutes()).toBe(0)
    expect(d.getUTCSeconds()).toBe(0)
  })

  /**
   * SN-016: Snooze +1h at :20 truncates DOWN to the current hour
   *
   * At 8:20 AM, snoozing +1h computes 9:20 AM. Since 20 < 35,
   * it should truncate to 9:00 AM.
   */
  test('SN-016: +1h at :20 truncates down (minutes < 35 threshold)', () => {
    vi.setSystemTime(new Date('2026-01-15T08:20:00Z'))

    const result = computeSnoozeTime('60', 'UTC', '09:00', CALENDAR_DAY_START)
    const d = new Date(result)

    // 8:20 + 60m = 9:20 → 20 < 35 → truncates to 9:00
    expect(d.getUTCHours()).toBe(9)
    expect(d.getUTCMinutes()).toBe(0)
    expect(d.getUTCSeconds()).toBe(0)
  })

  /**
   * SN-017: Snooze +2h at :35 rounds up (boundary case)
   *
   * At 8:35 AM, snoozing +2h computes 10:35 AM. Since 35 >= 35,
   * it should round up to 11:00 AM.
   */
  test('SN-017: +2h at :35 rounds up (exact boundary)', () => {
    vi.setSystemTime(new Date('2026-01-15T08:35:00Z'))

    const result = computeSnoozeTime('120', 'UTC', '09:00', CALENDAR_DAY_START)
    const d = new Date(result)

    // 8:35 + 120m = 10:35 → 35 >= 35 → rounds up to 11:00
    expect(d.getUTCHours()).toBe(11)
    expect(d.getUTCMinutes()).toBe(0)
  })

  /**
   * SN-018: Snooze +1h at :34 truncates (just below threshold)
   */
  test('SN-018: +1h at :34 truncates (just below threshold)', () => {
    vi.setSystemTime(new Date('2026-01-15T08:34:00Z'))

    const result = computeSnoozeTime('60', 'UTC', '09:00', CALENDAR_DAY_START)
    const d = new Date(result)

    // 8:34 + 60m = 9:34 → 34 < 35 → truncates to 9:00
    expect(d.getUTCHours()).toBe(9)
    expect(d.getUTCMinutes()).toBe(0)
  })

  /**
   * SN-019: Snooze +1h at :00 stays on the hour (no rounding needed)
   */
  test('SN-019: +1h at :00 stays on the hour', () => {
    vi.setSystemTime(new Date('2026-01-15T08:00:00Z'))

    const result = computeSnoozeTime('60', 'UTC', '09:00', CALENDAR_DAY_START)
    const d = new Date(result)

    // 8:00 + 60m = 9:00 → 0 < 35 → truncates to 9:00 (same result)
    expect(d.getUTCHours()).toBe(9)
    expect(d.getUTCMinutes()).toBe(0)
  })

  /**
   * SN-020: Sub-hour snooze (e.g., 30min) uses exact time, no rounding
   */
  test('SN-020: sub-hour snooze uses exact time', () => {
    vi.setSystemTime(new Date('2026-01-15T08:45:00Z'))

    const result = computeSnoozeTime('30', 'UTC', '09:00', CALENDAR_DAY_START)
    const d = new Date(result)

    // 8:45 + 30m = 9:15 — no rounding for sub-hour
    expect(d.getUTCHours()).toBe(9)
    expect(d.getUTCMinutes()).toBe(15)
  })

  /**
   * SN-021: 'tomorrow' option uses morningTime, not rounding
   */
  test('SN-021: tomorrow option uses morningTime', () => {
    vi.setSystemTime(new Date('2026-01-15T08:45:00Z'))

    const result = computeSnoozeTime('tomorrow', 'America/Chicago', '09:00', CALENDAR_DAY_START)
    const d = DateTime.fromISO(result).setZone('America/Chicago')

    expect(d.hour).toBe(9)
    expect(d.minute).toBe(0)
    expect(d.day).toBe(16) // Tomorrow
  })
})

/**
 * SN-022..024: the default snooze option "next_period" (Settings → Default
 * snooze, 2026-10-10). The row's snooze tap and the swipe resolve it with the
 * user's periods: the next period to start — later today, or tomorrow's first
 * once the day's last has begun (the same target as the snooze menu's and the
 * notification's "Next period"). Only with no periods at all does it fall back
 * to +1 hour (rounded like any hour snooze).
 */
describe('computeSnoozeTime: next_period', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  const slots = [{ start_time: '07:00' }, { start_time: '12:00' }, { start_time: '17:30' }]

  test('SN-022: the next period later today', () => {
    // 10:15 Chicago
    vi.setSystemTime(new Date('2026-01-15T16:15:00Z'))
    const d = DateTime.fromISO(
      computeSnoozeTime('next_period', 'America/Chicago', '09:00', CALENDAR_DAY_START, slots),
    ).setZone('America/Chicago')
    expect(d.toFormat('dd HH:mm')).toBe('15 12:00')
  })

  test("SN-023: after the day's last period has begun, the top of the next hour (amendment 17)", () => {
    // 21:10 Chicago
    vi.setSystemTime(new Date('2026-01-16T03:10:00Z'))
    const d = DateTime.fromISO(
      computeSnoozeTime('next_period', 'America/Chicago', '09:00', CALENDAR_DAY_START, slots),
    ).setZone('America/Chicago')
    expect(d.toFormat('dd HH:mm')).toBe('15 22:00')
  })

  test('SN-024: no periods → the top of the next hour', () => {
    vi.setSystemTime(new Date('2026-01-15T08:45:00Z'))
    expect(computeSnoozeTime('next_period', 'UTC', '09:00', CALENDAR_DAY_START, [])).toBe(
      '2026-01-15T09:00:00.000Z',
    )
  })
})

describe('snapToHour', () => {
  test('rounds up when minutes >= 35', () => {
    const result = snapToHour(new Date('2026-01-15T08:45:00Z'))
    expect(result.getUTCHours()).toBe(9)
    expect(result.getUTCMinutes()).toBe(0)
    expect(result.getUTCSeconds()).toBe(0)
    expect(result.getUTCMilliseconds()).toBe(0)
  })

  test('truncates down when minutes < 35', () => {
    const result = snapToHour(new Date('2026-01-15T08:20:00Z'))
    expect(result.getUTCHours()).toBe(8)
    expect(result.getUTCMinutes()).toBe(0)
    expect(result.getUTCSeconds()).toBe(0)
  })

  test('rounds up at exact boundary (35 minutes)', () => {
    const result = snapToHour(new Date('2026-01-15T08:35:00Z'))
    expect(result.getUTCHours()).toBe(9)
    expect(result.getUTCMinutes()).toBe(0)
  })

  test('truncates at 34 minutes (just below threshold)', () => {
    const result = snapToHour(new Date('2026-01-15T08:34:00Z'))
    expect(result.getUTCHours()).toBe(8)
    expect(result.getUTCMinutes()).toBe(0)
  })

  test('keeps exact hour unchanged (0 minutes)', () => {
    const result = snapToHour(new Date('2026-01-15T08:00:00Z'))
    expect(result.getUTCHours()).toBe(8)
    expect(result.getUTCMinutes()).toBe(0)
  })

  test('does not mutate the input date', () => {
    const input = new Date('2026-01-15T08:45:00Z')
    const originalTime = input.getTime()
    snapToHour(input)
    expect(input.getTime()).toBe(originalTime)
  })
})
