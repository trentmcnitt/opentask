/**
 * Bulk Operations Behavioral Tests (BO-001 through BO-005, BE-001 through BE-004)
 *
 * Tests bulk operations with atomicity and undo integration.
 * BE tests focus on bulkEdit snooze and recurrence behavior.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { getDb } from '@/core/db'
import { createTask, getTaskById } from '@/core/tasks'
import { bulkDone, bulkSnooze, bulkEdit, type BulkEditChanges } from '@/core/tasks/bulk'
import { snoozeTask } from '@/core/tasks/snooze'
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
   * BS-003: Relative snooze skips tasks with null due_at
   */
  test('BS-003: Relative snooze skips tasks with null due_at', () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Task with no due date',
        // No due_at
      },
    })

    expect(task.due_at).toBeNull()

    // Snooze by +60 minutes — should skip since task has no due_at
    const result = bulkSnooze({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskIds: [task.id],
      deltaMinutes: 60,
    })

    expect(result.tasksAffected).toBe(0)
    expect(result.noDueDateSkipped).toBe(1)
    expect(result.tasksSkipped).toBe(1)

    // Task should be unchanged
    const updatedTask = getTaskById(task.id)!
    expect(updatedTask.due_at).toBeNull()
    expect(updatedTask.original_due_at).toBeNull()
  })

  /**
   * BS-003b: Relative snooze processes tasks with due_at, skips those without
   */
  test('BS-003b: Mixed due-date selection — relative snooze only affects tasks with due_at', () => {
    const taskWithDue = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Has due date',
        due_at: localTime(8, 0),
      },
    })
    const taskWithout = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'No due date',
      },
    })

    const result = bulkSnooze({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskIds: [taskWithDue.id, taskWithout.id],
      deltaMinutes: 60,
    })

    expect(result.tasksAffected).toBe(1)
    expect(result.noDueDateSkipped).toBe(1)

    // Task with due date was snoozed
    const updatedWithDue = getTaskById(taskWithDue.id)!
    const expectedDueAt = new Date(new Date(localTime(8, 0)).getTime() + 60 * 60 * 1000)
    expect(new Date(updatedWithDue.due_at!).getTime()).toBe(expectedDueAt.getTime())

    // Task without due date is unchanged
    const updatedWithout = getTaskById(taskWithout.id)!
    expect(updatedWithout.due_at).toBeNull()
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
    expect(bulkSnoozeEntries[0].description).toBe('Snoozed 2 tasks (+1h)')

    // Undo should revert both
    expect(canUndo(TEST_USER_ID)).toBe(true)
    const undoResult = executeUndo(TEST_USER_ID)
    expect(undoResult!.tasks_affected).toBe(2)

    // Verify both reverted
    const revertedTask1 = getTaskById(task1.id)!
    const revertedTask2 = getTaskById(task2.id)!

    expect(revertedTask1.due_at).toBe(task1Original)
    expect(revertedTask2.due_at).toBe(task2Original)
    // original_due_at was set at creation and preserved through snooze/undo
    expect(revertedTask1.original_due_at).toBe(task1Original)
    expect(revertedTask2.original_due_at).toBe(task2Original)
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

/**
 * Bulk Edit Snooze and Recurrence Tests (BE-001 through BE-004)
 *
 * Tests bulkEdit behavior with due_at and rrule changes,
 * verifying snooze logic and recurrence handling.
 */
describe('Bulk Edit Snooze & Recurrence', () => {
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
   * BE-001: bulkEdit with due_at changes applies snooze logic
   *
   * When bulkEdit is called with only due_at changes (no rrule change),
   * snooze logic is applied: original_due_at is set, snooze_count incremented.
   *
   * Action: bulkEdit with { due_at: tomorrow } on multiple tasks
   * Result: original_due_at set, snooze_count incremented for each
   */
  test('BE-001: bulkEdit with due_at changes applies snooze logic', () => {
    // Create multiple tasks with different due dates
    const task1 = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Task 1',
        due_at: localTime(8, 0), // Today 8 AM
      },
    })

    const task2 = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Task 2',
        due_at: localTime(14, 0), // Today 2 PM
      },
    })

    // Verify initial state — original_due_at is set eagerly at creation time
    expect(task1.original_due_at).toBe(task1.due_at)
    expect(task1.snooze_count).toBe(0)
    expect(task2.original_due_at).toBe(task2.due_at)
    expect(task2.snooze_count).toBe(0)

    const originalTask1DueAt = task1.due_at
    const originalTask2DueAt = task2.due_at

    // Bulk edit with due_at change (this is effectively a snooze)
    const newDueAt = localTime(18, 0, 1) // Tomorrow 6 PM
    const result = bulkEdit({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskIds: [task1.id, task2.id],
      changes: { due_at: newDueAt },
    })

    expect(result.tasksAffected).toBe(2)

    // Verify snooze logic was applied
    const updatedTask1 = getTaskById(task1.id)!
    const updatedTask2 = getTaskById(task2.id)!

    // due_at changed
    expect(updatedTask1.due_at).toBe(newDueAt)
    expect(updatedTask2.due_at).toBe(newDueAt)

    // original_due_at captured the original values
    expect(updatedTask1.original_due_at).toBe(originalTask1DueAt)
    expect(updatedTask2.original_due_at).toBe(originalTask2DueAt)

    // snooze_count incremented
    expect(updatedTask1.snooze_count).toBe(1)
    expect(updatedTask2.snooze_count).toBe(1)
  })

  /**
   * BE-002: bulkEdit with due_at + rrule does NOT apply snooze logic
   *
   * When bulkEdit includes both due_at and rrule changes, snooze logic
   * is NOT applied because rrule change takes precedence (schedule change).
   *
   * Action: bulkEdit with { due_at: tomorrow, rrule: 'FREQ=DAILY' }
   * Result: snooze_count NOT incremented (rrule takes precedence)
   */
  test('BE-002: bulkEdit with due_at + rrule does NOT apply snooze logic', () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'One-off task',
        due_at: localTime(8, 0), // Today 8 AM
      },
    })

    expect(task.snooze_count).toBe(0)

    // Bulk edit with both due_at and rrule
    const result = bulkEdit({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskIds: [task.id],
      changes: {
        due_at: localTime(18, 0, 1), // Tomorrow 6 PM
        rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      },
    })

    expect(result.tasksAffected).toBe(1)

    const updatedTask = getTaskById(task.id)!

    // rrule change takes precedence - snooze logic NOT applied
    expect(updatedTask.snooze_count).toBe(0)

    // Task is now recurring
    expect(updatedTask.rrule).toBe('FREQ=DAILY;BYHOUR=9;BYMINUTE=0')
  })

  /**
   * BE-003: bulkEdit rrule change clears snooze tracking
   *
   * When bulkEdit changes rrule on snoozed tasks, snooze tracking
   * (original_due_at) is cleared since the schedule change establishes
   * a new baseline.
   *
   * Task: multiple snoozed tasks
   * Action: bulkEdit with { rrule: 'FREQ=WEEKLY;BYDAY=MO' }
   * Result: original_due_at=NULL for all
   */
  test('BE-003: bulkEdit rrule change clears snooze tracking', () => {
    // Create recurring tasks and snooze them
    const task1 = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Daily task 1',
        due_at: localTime(8, 0, 1), // Tomorrow 8 AM
        rrule: 'FREQ=DAILY;BYHOUR=8;BYMINUTE=0',
      },
    })

    const task2 = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Daily task 2',
        due_at: localTime(9, 0, 1), // Tomorrow 9 AM
        rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      },
    })

    // Snooze both tasks
    snoozeTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task1.id,
      until: localTime(14, 0, 1), // Tomorrow 2 PM
    })
    snoozeTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task2.id,
      until: localTime(15, 0, 1), // Tomorrow 3 PM
    })

    // Verify snoozed state
    const snoozedTask1 = getTaskById(task1.id)!
    const snoozedTask2 = getTaskById(task2.id)!
    expect(snoozedTask1.original_due_at).not.toBeNull()
    expect(snoozedTask2.original_due_at).not.toBeNull()
    expect(snoozedTask1.snooze_count).toBe(1)
    expect(snoozedTask2.snooze_count).toBe(1)

    // Bulk edit to change rrule
    const result = bulkEdit({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskIds: [task1.id, task2.id],
      changes: { rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=10;BYMINUTE=0' },
    })

    expect(result.tasksAffected).toBe(2)

    // Snooze tracking should be cleared
    const updatedTask1 = getTaskById(task1.id)!
    const updatedTask2 = getTaskById(task2.id)!

    expect(updatedTask1.original_due_at).toBeNull()
    expect(updatedTask2.original_due_at).toBeNull()

    // snooze_count preserved (lifetime stat)
    expect(updatedTask1.snooze_count).toBe(1)
    expect(updatedTask2.snooze_count).toBe(1)

    // New rrule applied
    expect(updatedTask1.rrule).toBe('FREQ=WEEKLY;BYDAY=MO;BYHOUR=10;BYMINUTE=0')
    expect(updatedTask2.rrule).toBe('FREQ=WEEKLY;BYDAY=MO;BYHOUR=10;BYMINUTE=0')
  })

  /**
   * BE-004: bulkEdit rrule change on overdue tasks preserves due_at
   *
   * When bulkEdit changes rrule on overdue tasks, due_at is preserved
   * (not auto-computed) so tasks remain overdue.
   *
   * Task: multiple overdue tasks
   * Action: bulkEdit with { rrule: 'FREQ=WEEKLY;BYDAY=MO' }
   * Result: due_at unchanged (all still overdue)
   */
  test('BE-004: bulkEdit rrule change on overdue tasks preserves due_at', () => {
    // Create overdue tasks (due yesterday)
    const yesterdayDueAt1 = localTime(8, 0, -1) // Yesterday 8 AM
    const yesterdayDueAt2 = localTime(9, 0, -1) // Yesterday 9 AM

    const task1 = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Overdue task 1',
        due_at: yesterdayDueAt1,
        rrule: 'FREQ=DAILY;BYHOUR=8;BYMINUTE=0',
      },
    })

    const task2 = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Overdue task 2',
        due_at: yesterdayDueAt2,
        rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      },
    })

    // Verify tasks are overdue
    expect(new Date(task1.due_at!).getTime()).toBeLessThan(Date.now())
    expect(new Date(task2.due_at!).getTime()).toBeLessThan(Date.now())

    // Bulk edit to change rrule
    const result = bulkEdit({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskIds: [task1.id, task2.id],
      changes: { rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=10;BYMINUTE=0' },
    })

    expect(result.tasksAffected).toBe(2)

    // due_at should be UNCHANGED (still overdue)
    const updatedTask1 = getTaskById(task1.id)!
    const updatedTask2 = getTaskById(task2.id)!

    expect(updatedTask1.due_at).toBe(yesterdayDueAt1)
    expect(updatedTask2.due_at).toBe(yesterdayDueAt2)

    // Still overdue
    expect(new Date(updatedTask1.due_at!).getTime()).toBeLessThan(Date.now())
    expect(new Date(updatedTask2.due_at!).getTime()).toBeLessThan(Date.now())

    // New rrule and anchors applied
    expect(updatedTask1.rrule).toBe('FREQ=WEEKLY;BYDAY=MO;BYHOUR=10;BYMINUTE=0')
    expect(updatedTask1.anchor_time).toBe('10:00')
    expect(updatedTask1.anchor_dow).toBe(0) // Monday
  })
})

/**
 * Bulk Edit Labels — Additive/Subtractive Tests (BL-001 through BL-007)
 *
 * Tests labels_add and labels_remove in bulkEdit, verifying case-insensitive
 * dedup, proper undo snapshots, and interaction with full labels replacement.
 */
describe('Bulk Edit Labels (labels_add/labels_remove)', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-01-15T16:00:00Z'))
    setupTestDb()
  })

  afterEach(() => {
    vi.useRealTimers()
    teardownTestDb()
  })

  /**
   * BL-001: labels_add adds labels to tasks
   */
  test('BL-001: labels_add adds labels to multiple tasks', () => {
    const task1 = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Task 1', labels: ['Work'] },
    })
    const task2 = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Task 2', labels: ['Personal'] },
    })

    const result = bulkEdit({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskIds: [task1.id, task2.id],
      changes: { labels_add: ['Urgent'] } as BulkEditChanges,
    })

    expect(result.tasksAffected).toBe(2)

    const updated1 = getTaskById(task1.id)!
    const updated2 = getTaskById(task2.id)!

    // Each task retains its existing labels and gets the new one
    expect(updated1.labels).toEqual(['Work', 'Urgent'])
    expect(updated2.labels).toEqual(['Personal', 'Urgent'])
  })

  /**
   * BL-002: labels_add is case-insensitive (no duplicates)
   */
  test('BL-002: labels_add skips labels already present (case-insensitive)', () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Task', labels: ['Work', 'Personal'] },
    })

    const result = bulkEdit({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskIds: [task.id],
      changes: { labels_add: ['work', 'New'] } as BulkEditChanges,
    })

    // Only 'New' should be added since 'work' matches 'Work' case-insensitively
    expect(result.tasksAffected).toBe(1)

    const updated = getTaskById(task.id)!
    expect(updated.labels).toEqual(['Work', 'Personal', 'New'])
  })

  /**
   * BL-003: labels_remove removes matching labels (case-insensitive)
   */
  test('BL-003: labels_remove removes labels case-insensitively', () => {
    const task1 = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Task 1', labels: ['Work', 'Personal', 'Urgent'] },
    })
    const task2 = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Task 2', labels: ['work', 'Other'] },
    })

    const result = bulkEdit({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskIds: [task1.id, task2.id],
      changes: { labels_remove: ['Work'] } as BulkEditChanges,
    })

    expect(result.tasksAffected).toBe(2)

    const updated1 = getTaskById(task1.id)!
    const updated2 = getTaskById(task2.id)!

    expect(updated1.labels).toEqual(['Personal', 'Urgent'])
    expect(updated2.labels).toEqual(['Other']) // 'work' removed case-insensitively
  })

  /**
   * BL-004: labels_add and labels_remove combined
   */
  test('BL-004: labels_add and labels_remove combined in single operation', () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Task', labels: ['Work', 'Low'] },
    })

    const result = bulkEdit({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskIds: [task.id],
      changes: { labels_add: ['Urgent'], labels_remove: ['Low'] } as BulkEditChanges,
    })

    expect(result.tasksAffected).toBe(1)

    const updated = getTaskById(task.id)!
    expect(updated.labels).toEqual(['Work', 'Urgent'])
  })

  /**
   * BL-005: Full labels replacement takes precedence over labels_add/labels_remove
   *
   * When `labels` is provided alongside labels_add/labels_remove,
   * the full replacement wins (labels_add/labels_remove are in an else-if branch).
   */
  test('BL-005: Full labels replacement takes precedence', () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Task', labels: ['Work', 'Personal'] },
    })

    const result = bulkEdit({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskIds: [task.id],
      changes: {
        labels: ['New'],
        labels_add: ['Extra'],
      } as BulkEditChanges,
    })

    expect(result.tasksAffected).toBe(1)

    const updated = getTaskById(task.id)!
    // Full replacement wins - labels_add ignored
    expect(updated.labels).toEqual(['New'])
  })

  /**
   * BL-006: Proper undo snapshots for labels_add
   */
  test('BL-006: Undo restores original labels after labels_add', () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Task', labels: ['Work'] },
    })

    bulkEdit({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskIds: [task.id],
      changes: { labels_add: ['Urgent'] } as BulkEditChanges,
    })

    // Verify label was added
    expect(getTaskById(task.id)!.labels).toEqual(['Work', 'Urgent'])

    // Undo
    expect(canUndo(TEST_USER_ID)).toBe(true)
    const undoResult = executeUndo(TEST_USER_ID)
    expect(undoResult).not.toBeNull()
    expect(undoResult!.tasks_affected).toBe(1)

    // Labels should be restored
    expect(getTaskById(task.id)!.labels).toEqual(['Work'])
  })

  /**
   * BL-007: No-op when adding labels already present on all tasks
   */
  test('BL-007: No-op when all labels already present', () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Task', labels: ['Work', 'Personal'] },
    })

    const result = bulkEdit({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskIds: [task.id],
      changes: { labels_add: ['Work', 'Personal'] } as BulkEditChanges,
    })

    // No actual changes - tasksAffected should be 0
    expect(result.tasksAffected).toBe(0)

    // Labels unchanged
    expect(getTaskById(task.id)!.labels).toEqual(['Work', 'Personal'])
  })
})

/**
 * Bulk Snooze Priority Filter Tests (SP-001 through SP-008)
 *
 * Only P4 (Urgent) tasks are excluded from bulk snooze. P0-P3 are all eligible.
 * Urgent tasks must be snoozed individually.
 */
describe('Bulk Snooze Priority Filter', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-01-15T16:00:00Z'))
    setupTestDb()
  })

  afterEach(() => {
    vi.useRealTimers()
    teardownTestDb()
  })

  /**
   * SP-001: Mixed P0-P4 selection — P0-P3 snoozed, P4 skipped
   */
  test('SP-001: Mixed selection — P0-P3 snoozed, P4 skipped', () => {
    const lowTask = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Low task', due_at: localTime(8, 0), priority: 1 },
    })
    const medTask = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Med task', due_at: localTime(9, 0), priority: 2 },
    })
    const highTask = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'High task', due_at: localTime(10, 0), priority: 3 },
    })
    const urgentTask = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Urgent task', due_at: localTime(11, 0), priority: 4 },
    })

    const result = bulkSnooze({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskIds: [lowTask.id, medTask.id, highTask.id, urgentTask.id],
      until: localTime(18, 0),
    })

    expect(result.tasksAffected).toBe(3)
    expect(result.tasksSkipped).toBe(1)
    expect(result.urgentSkipped).toBe(1)

    // P1, P2, P3 were all snoozed
    expect(getTaskById(lowTask.id)!.due_at).toBe(localTime(18, 0))
    expect(getTaskById(medTask.id)!.due_at).toBe(localTime(18, 0))
    expect(getTaskById(highTask.id)!.due_at).toBe(localTime(18, 0))

    // P4 was NOT snoozed
    expect(getTaskById(urgentTask.id)!.due_at).toBe(localTime(11, 0))
  })

  /**
   * SP-002: All urgent selection — all skipped
   */
  test('SP-002: All urgent tasks are skipped', () => {
    const urgent1 = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Urgent 1', due_at: localTime(8, 0), priority: 4 },
    })
    const urgent2 = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Urgent 2', due_at: localTime(9, 0), priority: 4 },
    })

    const result = bulkSnooze({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskIds: [urgent1.id, urgent2.id],
      until: localTime(18, 0),
    })

    expect(result.tasksAffected).toBe(0)
    expect(result.tasksSkipped).toBe(2)
    expect(result.urgentSkipped).toBe(2)

    // Tasks were NOT snoozed
    expect(getTaskById(urgent1.id)!.due_at).toBe(localTime(8, 0))
    expect(getTaskById(urgent2.id)!.due_at).toBe(localTime(9, 0))
  })

  /**
   * SP-003: P0/P1/P2/P3 mix — all snoozed (no P4 present)
   */
  test('SP-003: P0-P3 mix with no P4 — all snoozed', () => {
    const unsetTask = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Unset task', due_at: localTime(8, 0) },
    })
    const lowTask = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Low task', due_at: localTime(9, 0), priority: 1 },
    })
    const medTask = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Med task', due_at: localTime(10, 0), priority: 2 },
    })
    const highTask = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'High task', due_at: localTime(10, 30), priority: 3 },
    })

    const result = bulkSnooze({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskIds: [unsetTask.id, lowTask.id, medTask.id, highTask.id],
      until: localTime(18, 0),
    })

    expect(result.tasksAffected).toBe(4)
    expect(result.tasksSkipped).toBe(0)
    expect(result.urgentSkipped).toBe(0)

    expect(getTaskById(unsetTask.id)!.due_at).toBe(localTime(18, 0))
    expect(getTaskById(lowTask.id)!.due_at).toBe(localTime(18, 0))
    expect(getTaskById(medTask.id)!.due_at).toBe(localTime(18, 0))
    expect(getTaskById(highTask.id)!.due_at).toBe(localTime(18, 0))
  })

  /**
   * SP-004: Single urgent task — skipped
   */
  test('SP-004: Single urgent task is skipped from bulk snooze', () => {
    const urgentTask = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Urgent task', due_at: localTime(8, 0), priority: 4 },
    })

    const result = bulkSnooze({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskIds: [urgentTask.id],
      until: localTime(18, 0),
    })

    expect(result.tasksAffected).toBe(0)
    expect(result.tasksSkipped).toBe(1)
    expect(result.urgentSkipped).toBe(1)

    expect(getTaskById(urgentTask.id)!.due_at).toBe(localTime(8, 0))
  })

  /**
   * SP-005: bulkEdit with due_at — P0-P3 snoozed, P4 skipped
   */
  test('SP-005: bulkEdit with due_at applies priority filter — P3 snoozed, P4 skipped', () => {
    const highTask = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'High task', due_at: localTime(8, 0), priority: 3 },
    })
    const urgentTask = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Urgent task', due_at: localTime(9, 0), priority: 4 },
    })

    const newDueAt = localTime(18, 0, 1) // Tomorrow 6 PM
    const result = bulkEdit({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskIds: [highTask.id, urgentTask.id],
      changes: { due_at: newDueAt },
    })

    expect(result.tasksAffected).toBe(1)
    expect(result.tasksSkipped).toBe(1)

    // High task was updated (P3 is eligible now)
    expect(getTaskById(highTask.id)!.due_at).toBe(newDueAt)

    // Urgent task was NOT updated
    expect(getTaskById(urgentTask.id)!.due_at).toBe(localTime(9, 0))
  })

  /**
   * SP-006: bulkEdit with non-snooze changes ignores priority filtering
   */
  test('SP-006: bulkEdit with non-snooze changes does not skip urgent', () => {
    const lowTask = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Low task', due_at: localTime(8, 0), priority: 1 },
    })
    const urgentTask = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Urgent task', due_at: localTime(9, 0), priority: 4 },
    })

    // Changing priority (not a snooze) — should NOT skip
    const result = bulkEdit({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskIds: [lowTask.id, urgentTask.id],
      changes: { priority: 2 },
    })

    expect(result.tasksAffected).toBe(2)
    expect(result.tasksSkipped).toBe(0)

    expect(getTaskById(lowTask.id)!.priority).toBe(2)
    expect(getTaskById(urgentTask.id)!.priority).toBe(2)
  })

  /**
   * SP-007: bulkEdit with due_at when all tasks are urgent — all skipped
   */
  test('SP-007: bulkEdit with due_at skips all-urgent selection', () => {
    const urgent1 = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Urgent 1', due_at: localTime(8, 0), priority: 4 },
    })
    const urgent2 = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Urgent 2', due_at: localTime(9, 0), priority: 4 },
    })

    const newDueAt = localTime(18, 0, 1) // Tomorrow 6 PM
    const result = bulkEdit({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskIds: [urgent1.id, urgent2.id],
      changes: { due_at: newDueAt },
    })

    expect(result.tasksAffected).toBe(0)
    expect(result.tasksSkipped).toBe(2)

    expect(getTaskById(urgent1.id)!.due_at).toBe(localTime(8, 0))
    expect(getTaskById(urgent2.id)!.due_at).toBe(localTime(9, 0))
  })

  /**
   * SP-008: bulkEdit with due_at + rrule bypasses priority filtering
   */
  test('SP-008: bulkEdit with due_at + rrule does not apply snooze protection', () => {
    const lowTask = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Low task', due_at: localTime(8, 0), priority: 1 },
    })
    const urgentTask = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Urgent task', due_at: localTime(9, 0), priority: 4 },
    })

    const result = bulkEdit({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskIds: [lowTask.id, urgentTask.id],
      changes: {
        due_at: localTime(18, 0, 1),
        rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      },
    })

    // Since rrule is present, isSnoozeEdit=false, so all tasks proceed
    expect(result.tasksAffected).toBe(2)
    expect(result.tasksSkipped).toBe(0)
  })
})

/**
 * Bulk Snooze Urgent Exclusion Tests (BS-001 through BS-005)
 *
 * Only P4 (Urgent) is excluded from bulk snooze. P0-P3 are all eligible
 * in a single pass — no tiers.
 */
describe('Bulk Snooze Urgent Exclusion', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-01-15T16:00:00Z'))
    setupTestDb()
  })

  afterEach(() => {
    vi.useRealTimers()
    teardownTestDb()
  })

  /**
   * BS-001: Full priority mix — P0-P3 all snoozed, P4 excluded
   */
  test('BS-001: P0-P3 snoozed in single pass, P4 excluded', () => {
    const p0 = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Unset', due_at: localTime(8, 0), priority: 0 },
    })
    const p1 = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Low', due_at: localTime(8, 30), priority: 1 },
    })
    const p2 = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Medium', due_at: localTime(9, 0), priority: 2 },
    })
    const p3 = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'High', due_at: localTime(9, 30), priority: 3 },
    })
    const p4 = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Urgent', due_at: localTime(10, 0), priority: 4 },
    })

    const result = bulkSnooze({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskIds: [p0.id, p1.id, p2.id, p3.id, p4.id],
      until: localTime(18, 0),
    })

    expect(result.tasksAffected).toBe(4)
    expect(result.tasksSkipped).toBe(1)
    expect(result.urgentSkipped).toBe(1)

    // P0-P3 all snoozed
    expect(getTaskById(p0.id)!.due_at).toBe(localTime(18, 0))
    expect(getTaskById(p1.id)!.due_at).toBe(localTime(18, 0))
    expect(getTaskById(p2.id)!.due_at).toBe(localTime(18, 0))
    expect(getTaskById(p3.id)!.due_at).toBe(localTime(18, 0))

    // P4 untouched
    expect(getTaskById(p4.id)!.due_at).toBe(localTime(10, 0))
  })

  /**
   * BS-002: All P4 batch — nothing snoozed
   */
  test('BS-002: All P4 batch returns zero affected', () => {
    const p4a = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Urgent A', due_at: localTime(8, 0), priority: 4 },
    })
    const p4b = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Urgent B', due_at: localTime(9, 0), priority: 4 },
    })

    const result = bulkSnooze({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskIds: [p4a.id, p4b.id],
      until: localTime(18, 0),
    })

    expect(result.tasksAffected).toBe(0)
    expect(result.urgentSkipped).toBe(2)
  })

  /**
   * BS-003: P0-P3 only — all snoozed, zero skipped
   */
  test('BS-003: P0-P3 only batch — all snoozed', () => {
    const p0 = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'P0', due_at: localTime(8, 0), priority: 0 },
    })
    const p3 = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'P3', due_at: localTime(9, 0), priority: 3 },
    })

    const result = bulkSnooze({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskIds: [p0.id, p3.id],
      until: localTime(18, 0),
    })

    expect(result.tasksAffected).toBe(2)
    expect(result.tasksSkipped).toBe(0)
    expect(result.urgentSkipped).toBe(0)

    expect(getTaskById(p0.id)!.due_at).toBe(localTime(18, 0))
    expect(getTaskById(p3.id)!.due_at).toBe(localTime(18, 0))
  })

  /**
   * BS-004: urgentSkipped count accurate with multiple P4 tasks
   */
  test('BS-004: urgentSkipped count is accurate', () => {
    const p1 = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'P1', due_at: localTime(8, 0), priority: 1 },
    })
    const p4a = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'P4a', due_at: localTime(9, 0), priority: 4 },
    })
    const p4b = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'P4b', due_at: localTime(10, 0), priority: 4 },
    })
    const p4c = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'P4c', due_at: localTime(11, 0), priority: 4 },
    })

    const result = bulkSnooze({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskIds: [p1.id, p4a.id, p4b.id, p4c.id],
      until: localTime(18, 0),
    })

    expect(result.tasksAffected).toBe(1)
    expect(result.urgentSkipped).toBe(3)
  })

  /**
   * BS-005: Undo works correctly after simplified bulk snooze
   */
  test('BS-005: Undo restores all snoozed tasks', () => {
    const p0 = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'P0', due_at: localTime(8, 0), priority: 0 },
    })
    const p3 = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'P3', due_at: localTime(9, 0), priority: 3 },
    })
    const p4 = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'P4', due_at: localTime(10, 0), priority: 4 },
    })

    bulkSnooze({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskIds: [p0.id, p3.id, p4.id],
      until: localTime(18, 0),
    })

    // P0 and P3 snoozed, P4 untouched
    expect(getTaskById(p0.id)!.due_at).toBe(localTime(18, 0))
    expect(getTaskById(p3.id)!.due_at).toBe(localTime(18, 0))
    expect(getTaskById(p4.id)!.due_at).toBe(localTime(10, 0))

    // Undo
    expect(canUndo(TEST_USER_ID)).toBe(true)
    executeUndo(TEST_USER_ID)

    // P0 and P3 restored, P4 unchanged
    expect(getTaskById(p0.id)!.due_at).toBe(localTime(8, 0))
    expect(getTaskById(p3.id)!.due_at).toBe(localTime(9, 0))
    expect(getTaskById(p4.id)!.due_at).toBe(localTime(10, 0))
  })
})
