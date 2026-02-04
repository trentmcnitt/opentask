/**
 * Bulk Operations Behavioral Tests (BO-001 through BO-005)
 *
 * Tests bulk operations with atomicity and undo integration.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { getDb } from '@/core/db'
import { createTask, getTaskById } from '@/core/tasks'
import { bulkDone, bulkSnooze } from '@/core/tasks/bulk'
import { executeUndo, canUndo, getUndoHistory } from '@/core/undo'
import { DateTime } from 'luxon'
import {
  setupTestDb,
  teardownTestDb,
  localTime,
  TEST_USER_ID,
  TEST_TIMEZONE,
} from '../helpers/setup'

describe('Bulk Operations Behavioral Tests', () => {
  beforeEach(() => {
    // Freeze time to Jan 15, 2026 at 10am Chicago (16:00 UTC)
    // This ensures localTime(8, 0) creates a time 2 hours in the past
    vi.setSystemTime(new Date('2026-01-15T16:00:00Z'))
    setupTestDb()
  })

  afterEach(() => {
    vi.useRealTimers()
    teardownTestDb()
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
    // Freeze time to Jan 15, 2026 at 10am Chicago (16:00 UTC)
    vi.setSystemTime(new Date('2026-01-15T16:00:00Z'))
    setupTestDb()
  })

  afterEach(() => {
    vi.useRealTimers()
    teardownTestDb()
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

describe('Bulk Snooze Relative Mode', () => {
  beforeEach(() => {
    // Freeze time to Jan 15, 2026 at 10am Chicago (16:00 UTC)
    vi.setSystemTime(new Date('2026-01-15T16:00:00Z'))
    setupTestDb()
  })

  afterEach(() => {
    vi.useRealTimers()
    teardownTestDb()
  })

  /**
   * BS-001: Bulk snooze with delta adds minutes to each task's current due_at
   */
  test('BS-001: Relative snooze adds delta to each task individually', () => {
    // Create tasks with different due dates
    const task1 = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Task 1',
        due_at: localTime(8, 0), // Jan 15, 8:00 AM
      },
    })

    const task2 = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Task 2',
        due_at: localTime(14, 30), // Jan 15, 2:30 PM
      },
    })

    const task1OriginalDueAt = new Date(task1.due_at!)
    const task2OriginalDueAt = new Date(task2.due_at!)

    // Bulk snooze with delta of +90 minutes
    const result = bulkSnooze({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskIds: [task1.id, task2.id],
      deltaMinutes: 90,
    })

    expect(result.tasksAffected).toBe(2)

    // Verify each task was snoozed by 90 minutes from its own due date
    const updatedTask1 = getTaskById(task1.id)!
    const updatedTask2 = getTaskById(task2.id)!

    const task1NewDueAt = new Date(updatedTask1.due_at!)
    const task2NewDueAt = new Date(updatedTask2.due_at!)

    // Task 1: 8:00 AM + 90 min = 9:30 AM
    expect(task1NewDueAt.getTime()).toBe(task1OriginalDueAt.getTime() + 90 * 60 * 1000)

    // Task 2: 2:30 PM + 90 min = 4:00 PM
    expect(task2NewDueAt.getTime()).toBe(task2OriginalDueAt.getTime() + 90 * 60 * 1000)

    // Verify original_due_at was set correctly
    expect(updatedTask1.original_due_at).toBe(task1.due_at)
    expect(updatedTask2.original_due_at).toBe(task2.due_at)
  })

  /**
   * BS-002: Bulk snooze relative handles negative delta (going back in time)
   */
  test('BS-002: Relative snooze supports negative delta', () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Task',
        due_at: localTime(14, 0), // 2:00 PM
      },
    })

    const originalDueAt = new Date(task.due_at!)

    // Snooze backwards by 30 minutes
    const result = bulkSnooze({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskIds: [task.id],
      deltaMinutes: -30,
    })

    expect(result.tasksAffected).toBe(1)

    const updatedTask = getTaskById(task.id)!
    const newDueAt = new Date(updatedTask.due_at!)

    // 2:00 PM - 30 min = 1:30 PM
    expect(newDueAt.getTime()).toBe(originalDueAt.getTime() - 30 * 60 * 1000)
  })

  /**
   * BS-003: Tasks with null due_at use current time as base
   */
  test('BS-003: Relative snooze uses current time for tasks with null due_at', () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Task with no due date',
        // No due_at
      },
    })

    expect(task.due_at).toBeNull()

    // Snooze by +60 minutes
    const result = bulkSnooze({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskIds: [task.id],
      deltaMinutes: 60,
    })

    expect(result.tasksAffected).toBe(1)

    const updatedTask = getTaskById(task.id)!
    const newDueAt = new Date(updatedTask.due_at!)
    const expectedDueAt = new Date('2026-01-15T17:00:00Z') // 16:00 UTC + 60 min

    expect(newDueAt.getTime()).toBe(expectedDueAt.getTime())
    expect(updatedTask.original_due_at).toBeNull() // Original was null
  })

  /**
   * BS-004: Bulk snooze relative creates single undo entry
   */
  test('BS-004: Relative snooze creates single undo entry', () => {
    const task1 = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Task 1',
        due_at: localTime(8, 0),
      },
    })

    const task2 = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Task 2',
        due_at: localTime(9, 0),
      },
    })

    const task1Original = task1.due_at
    const task2Original = task2.due_at

    // Bulk snooze
    bulkSnooze({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskIds: [task1.id, task2.id],
      deltaMinutes: 60,
    })

    // Verify single undo entry
    const history = getUndoHistory(TEST_USER_ID, 20)
    const bulkSnoozeEntries = history.filter((e) => e.action === 'bulk_snooze')
    expect(bulkSnoozeEntries.length).toBe(1)
    expect(bulkSnoozeEntries[0].description).toBe('Snoozed 2 tasks')

    // Undo should revert both
    expect(canUndo(TEST_USER_ID)).toBe(true)
    const undoResult = executeUndo(TEST_USER_ID)
    expect(undoResult!.tasks_affected).toBe(2)

    // Verify both reverted
    const revertedTask1 = getTaskById(task1.id)!
    const revertedTask2 = getTaskById(task2.id)!

    expect(revertedTask1.due_at).toBe(task1Original)
    expect(revertedTask2.due_at).toBe(task2Original)
    expect(revertedTask1.original_due_at).toBeNull()
    expect(revertedTask2.original_due_at).toBeNull()
  })

  /**
   * BS-005: Absolute vs relative mode validation
   */
  test('BS-005: Cannot provide both until and deltaMinutes', () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Task',
        due_at: localTime(8, 0),
      },
    })

    expect(() =>
      bulkSnooze({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        taskIds: [task.id],
        until: localTime(12, 0),
        deltaMinutes: 60,
      }),
    ).toThrow('Cannot provide both until and deltaMinutes')
  })

  /**
   * BS-006: Must provide either until or deltaMinutes
   */
  test('BS-006: Must provide either until or deltaMinutes', () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Task',
        due_at: localTime(8, 0),
      },
    })

    expect(() =>
      bulkSnooze({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        taskIds: [task.id],
        // Neither until nor deltaMinutes provided
      }),
    ).toThrow('Either until or deltaMinutes must be provided')
  })

  /**
   * BS-007: Absolute mode still works
   */
  test('BS-007: Absolute mode sets all tasks to same time', () => {
    const task1 = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Task 1',
        due_at: localTime(8, 0),
      },
    })

    const task2 = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Task 2',
        due_at: localTime(14, 0),
      },
    })

    const targetTime = localTime(18, 0) // 6:00 PM

    const result = bulkSnooze({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskIds: [task1.id, task2.id],
      until: targetTime,
    })

    expect(result.tasksAffected).toBe(2)

    // Both tasks should have the same due_at
    const updatedTask1 = getTaskById(task1.id)!
    const updatedTask2 = getTaskById(task2.id)!

    expect(updatedTask1.due_at).toBe(targetTime)
    expect(updatedTask2.due_at).toBe(targetTime)
  })
})
