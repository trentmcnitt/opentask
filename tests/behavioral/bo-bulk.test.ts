/**
 * Bulk Operations Behavioral Tests (BO-001 through BO-005)
 *
 * Tests bulk operations with atomicity and undo integration.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { getDb, resetDb } from '@/core/db'
import { createTask, getTaskById } from '@/core/tasks'
import { bulkDone } from '@/core/tasks/bulk'
import { executeUndo, canUndo, getUndoHistory } from '@/core/undo'
import { DateTime } from 'luxon'

const TEST_TIMEZONE = 'America/Chicago'
const TEST_USER_ID = 1

// Helper to create a test date in local timezone
function localTime(hour: number, minute: number = 0, daysFromNow: number = 0): string {
  return DateTime.now()
    .setZone(TEST_TIMEZONE)
    .plus({ days: daysFromNow })
    .set({ hour, minute, second: 0, millisecond: 0 })
    .toUTC()
    .toISO()!
}

describe('Bulk Operations Behavioral Tests', () => {
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
   * BO-001: Bulk Done Applies Recurrence Logic
   *
   * All tasks in a bulk-done have their recurrence correctly computed. No shortcuts.
   */
  test('BO-001: Bulk done applies recurrence logic correctly to each task', () => {
    // Create multiple recurring tasks with different RRULEs
    const dailyTask = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: '[M] Daily task',
        due_at: localTime(8, 0),
        rrule: 'FREQ=DAILY;BYHOUR=8;BYMINUTE=0',
      },
    })

    const weeklyTask = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: '[M] Weekly task',
        due_at: localTime(9, 0),
        rrule: 'FREQ=WEEKLY;BYHOUR=9;BYMINUTE=0',
      },
    })

    // Get original due dates
    const dailyOriginal = dailyTask.due_at
    const weeklyOriginal = weeklyTask.due_at

    // Bulk mark done
    const result = bulkDone({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskIds: [dailyTask.id, weeklyTask.id],
    })

    expect(result.tasksAffected).toBe(2)
    expect(result.recurringCount).toBe(2)
    expect(result.oneOffCount).toBe(0)

    // Verify daily task advanced
    const updatedDaily = getTaskById(dailyTask.id)!
    const dailyNextDt = DateTime.fromISO(updatedDaily.due_at!).setZone(TEST_TIMEZONE)
    expect(dailyNextDt.hour).toBe(8)
    expect(dailyNextDt.minute).toBe(0)
    expect(updatedDaily.due_at).not.toBe(dailyOriginal)

    // Verify weekly task advanced
    const updatedWeekly = getTaskById(weeklyTask.id)!
    const weeklyNextDt = DateTime.fromISO(updatedWeekly.due_at!).setZone(TEST_TIMEZONE)
    expect(weeklyNextDt.hour).toBe(9)
    expect(weeklyNextDt.minute).toBe(0)
    expect(updatedWeekly.due_at).not.toBe(weeklyOriginal)
  })

  /**
   * BO-002: Bulk Operations Are Atomic
   *
   * A bulk operation either succeeds entirely or fails entirely (SQL transaction).
   * Invalid IDs cause the entire batch to fail.
   */
  test('BO-002: Bulk operations fail atomically on invalid task ID', () => {
    // Create one valid task
    const validTask = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Valid task',
        due_at: localTime(8, 0),
        rrule: 'FREQ=DAILY;BYHOUR=8;BYMINUTE=0',
      },
    })

    const originalDueAt = validTask.due_at

    // Try bulk done with one valid ID and one invalid ID
    expect(() =>
      bulkDone({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        taskIds: [validTask.id, 99999], // 99999 doesn't exist
      }),
    ).toThrow('Invalid task IDs: 99999')

    // Verify valid task was NOT modified (atomic rollback)
    const unchangedTask = getTaskById(validTask.id)!
    expect(unchangedTask.due_at).toBe(originalDueAt)
  })

  /**
   * BO-003: Bulk Done at Scale
   *
   * 100+ tasks in a single bulk-done without performance degradation or data corruption.
   */
  test('BO-003: Bulk done handles 100+ tasks', () => {
    const taskIds: number[] = []

    // Create 100 recurring tasks
    for (let i = 0; i < 100; i++) {
      const task = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: {
          title: `Task ${i + 1}`,
          due_at: localTime(8, 0),
          rrule: 'FREQ=DAILY;BYHOUR=8;BYMINUTE=0',
        },
      })
      taskIds.push(task.id)
    }

    // Capture original due dates
    const originalDueDates = taskIds.map((id) => getTaskById(id)!.due_at)

    // Bulk mark done
    const startTime = Date.now()
    const result = bulkDone({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskIds,
    })
    const elapsed = Date.now() - startTime

    // Should complete in reasonable time (< 5 seconds for 100 tasks)
    expect(elapsed).toBeLessThan(5000)

    expect(result.tasksAffected).toBe(100)
    expect(result.recurringCount).toBe(100)

    // Verify all tasks were advanced
    for (let i = 0; i < taskIds.length; i++) {
      const updatedTask = getTaskById(taskIds[i])!
      expect(updatedTask.due_at).not.toBe(originalDueDates[i])
      expect(updatedTask.done).toBe(false) // Recurring tasks stay undone

      // Verify correct time
      const nextDt = DateTime.fromISO(updatedTask.due_at!).setZone(TEST_TIMEZONE)
      expect(nextDt.hour).toBe(8)
      expect(nextDt.minute).toBe(0)
    }

    // Verify completions were created for all tasks
    const db = getDb()
    const completionCount = db.prepare('SELECT COUNT(*) as count FROM completions').get() as {
      count: number
    }
    expect(completionCount.count).toBe(100)
  })
})

describe('Bulk Operations Undo & Mixed Types', () => {
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
   * BO-004: Bulk Operations Are Single Undo Entry
   *
   * A bulk-done of 63 tasks is reversed by a single undo action.
   */
  test('BO-004: Bulk done creates single undo entry', () => {
    const taskIds: number[] = []
    const originalDueDates: (string | null)[] = []

    // Create 10 recurring tasks
    for (let i = 0; i < 10; i++) {
      const task = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: {
          title: `Task ${i + 1}`,
          due_at: localTime(8, 0),
          rrule: 'FREQ=DAILY;BYHOUR=8;BYMINUTE=0',
        },
      })
      taskIds.push(task.id)
      originalDueDates.push(task.due_at)
    }

    // Bulk mark done
    bulkDone({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskIds,
    })

    // Verify undo history has exactly one entry for this bulk operation
    const history = getUndoHistory(TEST_USER_ID, 20)
    // Filter to just bulk_done entries (there may be create entries too)
    const bulkDoneEntries = history.filter((e) => e.action === 'bulk_done')
    expect(bulkDoneEntries.length).toBe(1)
    expect(bulkDoneEntries[0].description).toBe('Marked 10 tasks done')

    // Verify can undo
    expect(canUndo(TEST_USER_ID)).toBe(true)

    // Execute single undo
    const undoResult = executeUndo(TEST_USER_ID)
    expect(undoResult).not.toBeNull()
    expect(undoResult!.undone_action).toBe('bulk_done')
    expect(undoResult!.tasks_affected).toBe(10)

    // Verify ALL tasks were reverted
    for (let i = 0; i < taskIds.length; i++) {
      const revertedTask = getTaskById(taskIds[i])!
      expect(revertedTask.due_at).toBe(originalDueDates[i])
    }

    // Verify completions were deleted
    const db = getDb()
    const completionCount = db.prepare('SELECT COUNT(*) as count FROM completions').get() as {
      count: number
    }
    expect(completionCount.count).toBe(0)
  })

  /**
   * BO-005: Bulk Mixed Types
   *
   * Bulk done handles both recurring (advance) and one-off (archive) tasks in the same batch.
   */
  test('BO-005: Bulk done handles mixed recurring and one-off tasks', () => {
    // Create recurring task
    const recurringTask = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: '[M] Recurring task',
        due_at: localTime(8, 0),
        rrule: 'FREQ=DAILY;BYHOUR=8;BYMINUTE=0',
      },
    })

    // Create one-off task
    const oneOffTask = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'One-off task',
        due_at: localTime(9, 0),
      },
    })

    const recurringOriginalDueAt = recurringTask.due_at

    // Bulk mark done both
    const result = bulkDone({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskIds: [recurringTask.id, oneOffTask.id],
    })

    expect(result.tasksAffected).toBe(2)
    expect(result.recurringCount).toBe(1)
    expect(result.oneOffCount).toBe(1)

    // Verify recurring task advanced (not done, but due_at changed)
    const updatedRecurring = getTaskById(recurringTask.id)!
    expect(updatedRecurring.done).toBe(false) // Recurring stays undone
    expect(updatedRecurring.due_at).not.toBe(recurringOriginalDueAt)
    expect(updatedRecurring.archived_at).toBeNull()

    // Verify one-off task is done and archived
    const updatedOneOff = getTaskById(oneOffTask.id)!
    expect(updatedOneOff.done).toBe(true)
    expect(updatedOneOff.done_at).not.toBeNull()
    expect(updatedOneOff.archived_at).not.toBeNull()

    // Verify single undo entry was created
    const history = getUndoHistory(TEST_USER_ID, 20)
    const bulkDoneEntries = history.filter((e) => e.action === 'bulk_done')
    expect(bulkDoneEntries.length).toBe(1)

    // Undo should revert both
    const undoResult = executeUndo(TEST_USER_ID)
    expect(undoResult!.tasks_affected).toBe(2)

    // Verify recurring task reverted
    const revertedRecurring = getTaskById(recurringTask.id)!
    expect(revertedRecurring.due_at).toBe(recurringOriginalDueAt)

    // Verify one-off task reverted to not done
    const revertedOneOff = getTaskById(oneOffTask.id)!
    expect(revertedOneOff.done).toBe(false)
    expect(revertedOneOff.done_at).toBeNull()
    expect(revertedOneOff.archived_at).toBeNull()
  })
})
