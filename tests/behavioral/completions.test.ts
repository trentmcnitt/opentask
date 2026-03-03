/**
 * Completions Behavioral Tests (CM-001 through CM-014c)
 *
 * Verifies that one-off and recurring task completions create correct
 * completion records, and that undo/redo properly manages those records.
 * Also verifies that undo/redo snapshots always include the task title
 * for activity display purposes.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { getDb } from '@/core/db'
import {
  createTask,
  markDone,
  markUndone,
  deleteTask,
  restoreTask,
  updateTask,
  emptyTrash,
} from '@/core/tasks'
import { bulkDone } from '@/core/tasks/bulk'
import { executeUndo, executeRedo } from '@/core/undo'
import {
  setupTestDb,
  teardownTestDb,
  localTime,
  TEST_USER_ID,
  TEST_TIMEZONE,
} from '../helpers/setup'

interface CompletionRow {
  id: number
  task_id: number
  user_id: number
  completed_at: string
  due_at_was: string | null
  due_at_next: string | null
}

interface UndoLogRow {
  id: number
  user_id: number
  action: string
  snapshot: string
}

function getCompletions(taskId: number): CompletionRow[] {
  return getDb()
    .prepare('SELECT * FROM completions WHERE task_id = ? ORDER BY id')
    .all(taskId) as CompletionRow[]
}

function getAllCompletions(): CompletionRow[] {
  return getDb().prepare('SELECT * FROM completions ORDER BY id').all() as CompletionRow[]
}

function getUndoSnapshots(userId: number): UndoLogRow[] {
  return getDb()
    .prepare('SELECT * FROM undo_log WHERE user_id = ? ORDER BY id DESC')
    .all(userId) as UndoLogRow[]
}

describe('Completions', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-01-15T16:00:00Z'))
    setupTestDb()
  })

  afterEach(() => {
    vi.useRealTimers()
    teardownTestDb()
  })

  describe('CM-001: One-off task completion records', () => {
    test('completing a one-off task creates a completion record', () => {
      const task = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Buy groceries', due_at: localTime(17, 0, 1) },
      })

      markDone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: task.id })

      const completions = getCompletions(task.id)
      expect(completions).toHaveLength(1)

      const record = completions[0]
      expect(record.task_id).toBe(task.id)
      expect(record.user_id).toBe(TEST_USER_ID)
      expect(record.completed_at).toBeDefined()
      expect(record.due_at_was).toBe(task.due_at)
      expect(record.due_at_next).toBeNull()
    })

    test('one-off task without due_at has null due_at_was', () => {
      const task = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'No due date task' },
      })

      markDone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: task.id })

      const completions = getCompletions(task.id)
      expect(completions).toHaveLength(1)
      expect(completions[0].due_at_was).toBeNull()
      expect(completions[0].due_at_next).toBeNull()
    })
  })

  describe('CM-002: Recurring task completion records', () => {
    test('completing a recurring task creates a completion record with next due_at', () => {
      const task = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: {
          title: 'Daily standup',
          due_at: localTime(9, 0),
          rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
        },
      })

      const originalDueAt = task.due_at

      markDone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: task.id })

      const completions = getCompletions(task.id)
      expect(completions).toHaveLength(1)

      const record = completions[0]
      expect(record.task_id).toBe(task.id)
      expect(record.user_id).toBe(TEST_USER_ID)
      expect(record.due_at_was).toBe(originalDueAt)
      expect(record.due_at_next).not.toBeNull()
      // The next occurrence should be later than the original
      expect(new Date(record.due_at_next!).getTime()).toBeGreaterThan(
        new Date(originalDueAt!).getTime(),
      )
    })
  })

  describe('CM-003: markUndone deletes completion record', () => {
    test('markUndone on a one-off task deletes the most recent completion record', () => {
      const task = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Undoable task', due_at: localTime(14, 0) },
      })

      markDone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: task.id })

      // Verify completion exists
      expect(getCompletions(task.id)).toHaveLength(1)

      markUndone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: task.id })

      // Completion should be deleted
      expect(getCompletions(task.id)).toHaveLength(0)
    })

    test('markUndone restores completion stats to pre-completion values', () => {
      const task = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Stats reset task' },
      })

      markDone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: task.id })

      // Stats should be updated after completion
      const doneTask = getDb()
        .prepare(
          'SELECT completion_count, first_completed_at, last_completed_at FROM tasks WHERE id = ?',
        )
        .get(task.id) as {
        completion_count: number
        first_completed_at: string | null
        last_completed_at: string | null
      }
      expect(doneTask.completion_count).toBe(1)
      expect(doneTask.first_completed_at).not.toBeNull()
      expect(doneTask.last_completed_at).not.toBeNull()

      markUndone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: task.id })

      // Stats should be restored
      const undoneTask = getDb()
        .prepare(
          'SELECT completion_count, first_completed_at, last_completed_at FROM tasks WHERE id = ?',
        )
        .get(task.id) as {
        completion_count: number
        first_completed_at: string | null
        last_completed_at: string | null
      }
      expect(undoneTask.completion_count).toBe(0)
      expect(undoneTask.first_completed_at).toBeNull()
      expect(undoneTask.last_completed_at).toBeNull()
    })
  })

  describe('CM-004: Undo/redo for one-off completions', () => {
    test('undo of one-off completion deletes the completion record and restores task state', () => {
      const task = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Undo me', due_at: localTime(10, 0) },
      })

      markDone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: task.id })

      // Verify completion exists and task is done
      expect(getCompletions(task.id)).toHaveLength(1)
      const doneTask = getDb()
        .prepare('SELECT done, done_at, archived_at FROM tasks WHERE id = ?')
        .get(task.id) as {
        done: number
        done_at: string | null
        archived_at: string | null
      }
      expect(doneTask.done).toBe(1)
      expect(doneTask.done_at).not.toBeNull()
      expect(doneTask.archived_at).not.toBeNull()

      // Undo the completion
      const result = executeUndo(TEST_USER_ID)
      expect(result).not.toBeNull()
      expect(result!.undone_action).toBe('done')

      // Completion record should be deleted
      expect(getCompletions(task.id)).toHaveLength(0)

      // Task state should be restored
      const undoneTask = getDb()
        .prepare('SELECT done, done_at, archived_at FROM tasks WHERE id = ?')
        .get(task.id) as {
        done: number
        done_at: string | null
        archived_at: string | null
      }
      expect(undoneTask.done).toBe(0)
      expect(undoneTask.done_at).toBeNull()
      expect(undoneTask.archived_at).toBeNull()
    })

    test('redo after undo recreates the completion record with the same ID', () => {
      const task = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Redo me', due_at: localTime(10, 0) },
      })

      markDone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: task.id })

      const completionsBefore = getCompletions(task.id)
      expect(completionsBefore).toHaveLength(1)
      const originalCompletionId = completionsBefore[0].id
      const originalDueAtWas = completionsBefore[0].due_at_was

      // Undo
      executeUndo(TEST_USER_ID)
      expect(getCompletions(task.id)).toHaveLength(0)

      // Redo
      const result = executeRedo(TEST_USER_ID)
      expect(result).not.toBeNull()
      expect(result!.redone_action).toBe('done')

      // Completion should be recreated with the same ID
      const completionsAfter = getCompletions(task.id)
      expect(completionsAfter).toHaveLength(1)
      expect(completionsAfter[0].id).toBe(originalCompletionId)
      expect(completionsAfter[0].due_at_was).toBe(originalDueAtWas)
      expect(completionsAfter[0].due_at_next).toBeNull()
    })

    test('full cycle: complete -> undo -> redo -> undo leaves no orphaned completions', () => {
      const task = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Full cycle task', due_at: localTime(12, 0) },
      })

      // Step 1: Complete
      markDone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: task.id })
      expect(getCompletions(task.id)).toHaveLength(1)

      // Step 2: Undo
      executeUndo(TEST_USER_ID)
      expect(getCompletions(task.id)).toHaveLength(0)

      // Step 3: Redo
      executeRedo(TEST_USER_ID)
      expect(getCompletions(task.id)).toHaveLength(1)

      // Step 4: Undo again
      executeUndo(TEST_USER_ID)
      expect(getCompletions(task.id)).toHaveLength(0)

      // Task should be in its original undone state
      const finalTask = getDb().prepare('SELECT done FROM tasks WHERE id = ?').get(task.id) as {
        done: number
      }
      expect(finalTask.done).toBe(0)
    })
  })

  describe('CM-005: Undo/redo for recurring completions', () => {
    test('undo of recurring completion deletes the completion record', () => {
      const task = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: {
          title: 'Daily recurring',
          due_at: localTime(9, 0),
          rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
        },
      })

      const originalDueAt = task.due_at

      markDone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: task.id })
      expect(getCompletions(task.id)).toHaveLength(1)

      // Undo
      const result = executeUndo(TEST_USER_ID)
      expect(result).not.toBeNull()
      expect(result!.undone_action).toBe('done')

      // Completion should be removed
      expect(getCompletions(task.id)).toHaveLength(0)

      // due_at should be restored to original
      const restoredTask = getDb()
        .prepare('SELECT due_at FROM tasks WHERE id = ?')
        .get(task.id) as {
        due_at: string | null
      }
      expect(restoredTask.due_at).toBe(originalDueAt)
    })

    test('redo of recurring completion recreates the completion record', () => {
      const task = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: {
          title: 'Weekly recurring',
          due_at: localTime(9, 0),
          rrule: 'FREQ=WEEKLY;BYDAY=TH;BYHOUR=9;BYMINUTE=0',
        },
      })

      markDone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: task.id })

      const completions = getCompletions(task.id)
      expect(completions).toHaveLength(1)
      const originalId = completions[0].id
      const originalDueAtWas = completions[0].due_at_was
      const originalDueAtNext = completions[0].due_at_next

      // Undo then redo
      executeUndo(TEST_USER_ID)
      expect(getCompletions(task.id)).toHaveLength(0)

      executeRedo(TEST_USER_ID)

      const restored = getCompletions(task.id)
      expect(restored).toHaveLength(1)
      expect(restored[0].id).toBe(originalId)
      expect(restored[0].due_at_was).toBe(originalDueAtWas)
      expect(restored[0].due_at_next).toBe(originalDueAtNext)
    })
  })

  describe('CM-006: Snapshot title preservation', () => {
    test('mark-done (one-off) snapshot includes title in before_state', () => {
      const task = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Important one-off task', due_at: localTime(10, 0) },
      })

      markDone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: task.id })

      const undoLogs = getUndoSnapshots(TEST_USER_ID)
      // Most recent entry is the done action
      const doneEntry = undoLogs.find((e) => e.action === 'done')
      expect(doneEntry).toBeDefined()

      const snapshots = JSON.parse(doneEntry!.snapshot)
      expect(snapshots).toHaveLength(1)
      expect(snapshots[0].before_state.title).toBe('Important one-off task')
    })

    test('mark-done (recurring) snapshot includes title in before_state', () => {
      const task = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: {
          title: 'Recurring with title',
          due_at: localTime(9, 0),
          rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
        },
      })

      markDone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: task.id })

      const undoLogs = getUndoSnapshots(TEST_USER_ID)
      const doneEntry = undoLogs.find((e) => e.action === 'done')
      expect(doneEntry).toBeDefined()

      const snapshots = JSON.parse(doneEntry!.snapshot)
      expect(snapshots[0].before_state.title).toBe('Recurring with title')
    })

    test('markUndone snapshot includes title in before_state and after_state', () => {
      const task = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Undone title check' },
      })

      markDone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: task.id })
      markUndone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: task.id })

      const undoLogs = getUndoSnapshots(TEST_USER_ID)
      const undoneEntry = undoLogs.find((e) => e.action === 'undone')
      expect(undoneEntry).toBeDefined()

      const snapshots = JSON.parse(undoneEntry!.snapshot)
      expect(snapshots[0].before_state.title).toBe('Undone title check')
      expect(snapshots[0].after_state.title).toBe('Undone title check')
    })

    test('delete snapshot includes title in before_state and after_state', () => {
      const task = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Delete title check' },
      })

      deleteTask({ userId: TEST_USER_ID, taskId: task.id })

      const undoLogs = getUndoSnapshots(TEST_USER_ID)
      const deleteEntry = undoLogs.find((e) => e.action === 'delete')
      expect(deleteEntry).toBeDefined()

      const snapshots = JSON.parse(deleteEntry!.snapshot)
      expect(snapshots[0].before_state.title).toBe('Delete title check')
      expect(snapshots[0].after_state.title).toBe('Delete title check')
    })

    test('restore snapshot includes title in before_state and after_state', () => {
      const task = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Restore title check' },
      })

      deleteTask({ userId: TEST_USER_ID, taskId: task.id })
      restoreTask({ userId: TEST_USER_ID, taskId: task.id })

      const undoLogs = getUndoSnapshots(TEST_USER_ID)
      const restoreEntry = undoLogs.find((e) => e.action === 'restore')
      expect(restoreEntry).toBeDefined()

      const snapshots = JSON.parse(restoreEntry!.snapshot)
      expect(snapshots[0].before_state.title).toBe('Restore title check')
      expect(snapshots[0].after_state.title).toBe('Restore title check')
    })

    test('snooze via updateTask snapshot includes title', () => {
      const task = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Snooze title check', due_at: localTime(8, 0) },
      })

      updateTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        taskId: task.id,
        input: { due_at: localTime(14, 0) },
      })

      const undoLogs = getUndoSnapshots(TEST_USER_ID)
      const editEntry = undoLogs.find((e) => e.action === 'edit')
      expect(editEntry).toBeDefined()

      const snapshots = JSON.parse(editEntry!.snapshot)
      expect(snapshots[0].before_state.title).toBe('Snooze title check')
      expect(snapshots[0].after_state.title).toBe('Snooze title check')
    })

    test('priority-only edit snapshot includes title', () => {
      const task = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Priority title check', priority: 0 },
      })

      updateTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        taskId: task.id,
        input: { priority: 3 },
      })

      const undoLogs = getUndoSnapshots(TEST_USER_ID)
      const editEntry = undoLogs.find((e) => e.action === 'edit')
      expect(editEntry).toBeDefined()

      const snapshots = JSON.parse(editEntry!.snapshot)
      expect(snapshots[0].before_state.title).toBe('Priority title check')
      expect(snapshots[0].after_state.title).toBe('Priority title check')
    })

    test('edit that changes title has old title in before_state, new in after_state', () => {
      const task = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Original title' },
      })

      updateTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        taskId: task.id,
        input: { title: 'Updated title' },
      })

      const undoLogs = getUndoSnapshots(TEST_USER_ID)
      const editEntry = undoLogs.find((e) => e.action === 'edit')
      expect(editEntry).toBeDefined()

      const snapshots = JSON.parse(editEntry!.snapshot)
      expect(snapshots[0].before_state.title).toBe('Original title')
      expect(snapshots[0].after_state.title).toBe('Updated title')
    })
  })

  describe('CM-007: Bulk mark-done creates completion records', () => {
    test('bulk mark-done creates a completion record for each one-off task', () => {
      const task1 = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Bulk 1', due_at: localTime(8, 0) },
      })
      const task2 = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Bulk 2', due_at: localTime(9, 0) },
      })
      const task3 = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Bulk 3' },
      })

      bulkDone({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        taskIds: [task1.id, task2.id, task3.id],
      })

      // Each task should have a completion record
      expect(getCompletions(task1.id)).toHaveLength(1)
      expect(getCompletions(task2.id)).toHaveLength(1)
      expect(getCompletions(task3.id)).toHaveLength(1)

      // Total completions should be 3
      expect(getAllCompletions()).toHaveLength(3)

      // Verify correct data
      const comp1 = getCompletions(task1.id)[0]
      expect(comp1.due_at_was).toBe(task1.due_at)
      expect(comp1.due_at_next).toBeNull() // one-off

      // Task with no due_at should have null due_at_was
      const comp3 = getCompletions(task3.id)[0]
      expect(comp3.due_at_was).toBeNull()
      expect(comp3.due_at_next).toBeNull()
    })

    test('bulk mark-done creates completion records for mixed recurring and one-off tasks', () => {
      const oneOff = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'One-off in bulk', due_at: localTime(10, 0) },
      })
      const recurring = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: {
          title: 'Recurring in bulk',
          due_at: localTime(10, 0),
          rrule: 'FREQ=DAILY;BYHOUR=10;BYMINUTE=0',
        },
      })

      const recurringOriginalDueAt = recurring.due_at

      bulkDone({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        taskIds: [oneOff.id, recurring.id],
      })

      expect(getAllCompletions()).toHaveLength(2)

      // One-off completion
      const oneOffComp = getCompletions(oneOff.id)[0]
      expect(oneOffComp.due_at_next).toBeNull()

      // Recurring completion
      const recurringComp = getCompletions(recurring.id)[0]
      expect(recurringComp.due_at_was).toBe(recurringOriginalDueAt)
      expect(recurringComp.due_at_next).not.toBeNull()
    })
  })

  describe('CM-008: Undo bulk done cleans up all completion records', () => {
    test('undoing a bulk done deletes all completion records from that bulk operation', () => {
      const task1 = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Bulk undo 1', due_at: localTime(8, 0) },
      })
      const task2 = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Bulk undo 2', due_at: localTime(9, 0) },
      })

      bulkDone({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        taskIds: [task1.id, task2.id],
      })

      expect(getAllCompletions()).toHaveLength(2)

      // Undo the bulk done
      const result = executeUndo(TEST_USER_ID)
      expect(result).not.toBeNull()
      expect(result!.undone_action).toBe('bulk_done')
      expect(result!.tasks_affected).toBe(2)

      // All completion records should be deleted
      expect(getAllCompletions()).toHaveLength(0)

      // Tasks should be restored
      const t1 = getDb().prepare('SELECT done FROM tasks WHERE id = ?').get(task1.id) as {
        done: number
      }
      const t2 = getDb().prepare('SELECT done FROM tasks WHERE id = ?').get(task2.id) as {
        done: number
      }
      expect(t1.done).toBe(0)
      expect(t2.done).toBe(0)
    })
  })

  describe('CM-008b: Redo bulk done recreates all completion records', () => {
    test('redoing a bulk done recreates completion records with correct data', () => {
      const task1 = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Bulk redo 1', due_at: localTime(8, 0) },
      })
      const task2 = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Bulk redo 2', due_at: localTime(9, 0) },
      })

      bulkDone({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        taskIds: [task1.id, task2.id],
      })

      expect(getAllCompletions()).toHaveLength(2)

      // Capture completion data for comparison after redo
      const comp1 = getCompletions(task1.id)[0]
      const comp2 = getCompletions(task2.id)[0]

      // Undo the bulk done
      executeUndo(TEST_USER_ID)
      expect(getAllCompletions()).toHaveLength(0)

      // Redo the bulk done
      const result = executeRedo(TEST_USER_ID)
      expect(result).not.toBeNull()
      expect(result!.redone_action).toBe('bulk_done')
      expect(result!.tasks_affected).toBe(2)

      // Completion records should be recreated with matching data
      expect(getAllCompletions()).toHaveLength(2)

      const redoneComp1 = getCompletions(task1.id)[0]
      const redoneComp2 = getCompletions(task2.id)[0]
      expect(redoneComp1.id).toBe(comp1.id)
      expect(redoneComp1.completed_at).toBe(comp1.completed_at)
      expect(redoneComp1.due_at_was).toBe(comp1.due_at_was)
      expect(redoneComp1.due_at_next).toBeNull()
      expect(redoneComp2.id).toBe(comp2.id)
      expect(redoneComp2.completed_at).toBe(comp2.completed_at)
      expect(redoneComp2.due_at_was).toBe(comp2.due_at_was)
      expect(redoneComp2.due_at_next).toBeNull()

      // Tasks should be done and archived again
      const t1 = getDb()
        .prepare('SELECT done, done_at, archived_at, completion_count FROM tasks WHERE id = ?')
        .get(task1.id) as {
        done: number
        done_at: string | null
        archived_at: string | null
        completion_count: number
      }
      const t2 = getDb()
        .prepare('SELECT done, done_at, archived_at, completion_count FROM tasks WHERE id = ?')
        .get(task2.id) as {
        done: number
        done_at: string | null
        archived_at: string | null
        completion_count: number
      }
      expect(t1.done).toBe(1)
      expect(t1.done_at).not.toBeNull()
      expect(t1.archived_at).not.toBeNull()
      expect(t1.completion_count).toBe(1)
      expect(t2.done).toBe(1)
      expect(t2.done_at).not.toBeNull()
      expect(t2.archived_at).not.toBeNull()
      expect(t2.completion_count).toBe(1)
    })
  })

  describe('CM-009: emptyTrash cleans up completion records', () => {
    test('emptyTrash deletes completion records for trashed tasks', () => {
      const task = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Trash with completions', due_at: localTime(10, 0) },
      })

      markDone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: task.id })
      expect(getCompletions(task.id)).toHaveLength(1)

      // markUndone to reopen, then delete
      markUndone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: task.id })

      // Complete again so we have a completion record
      markDone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: task.id })
      expect(getCompletions(task.id)).toHaveLength(1)

      // Delete the task (soft delete)
      deleteTask({ userId: TEST_USER_ID, taskId: task.id })

      // Completions still exist (soft delete doesn't remove them)
      expect(getCompletions(task.id)).toHaveLength(1)

      // Empty trash (hard delete)
      emptyTrash(TEST_USER_ID)

      // Completions should be cleaned up
      expect(getCompletions(task.id)).toHaveLength(0)

      // Task should be gone
      const row = getDb().prepare('SELECT id FROM tasks WHERE id = ?').get(task.id)
      expect(row).toBeUndefined()
    })
  })

  describe('CM-010: Completion stats are updated correctly', () => {
    test('one-off completion updates completion_count and timestamps', () => {
      const task = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Stats check' },
      })

      const beforeTask = getDb()
        .prepare(
          'SELECT completion_count, first_completed_at, last_completed_at FROM tasks WHERE id = ?',
        )
        .get(task.id) as {
        completion_count: number
        first_completed_at: string | null
        last_completed_at: string | null
      }
      expect(beforeTask.completion_count).toBe(0)
      expect(beforeTask.first_completed_at).toBeNull()
      expect(beforeTask.last_completed_at).toBeNull()

      markDone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: task.id })

      const afterTask = getDb()
        .prepare(
          'SELECT completion_count, first_completed_at, last_completed_at FROM tasks WHERE id = ?',
        )
        .get(task.id) as {
        completion_count: number
        first_completed_at: string | null
        last_completed_at: string | null
      }
      expect(afterTask.completion_count).toBe(1)
      expect(afterTask.first_completed_at).not.toBeNull()
      expect(afterTask.last_completed_at).not.toBeNull()
    })

    test('undo of one-off completion restores original stats', () => {
      const task = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Undo stats check' },
      })

      markDone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: task.id })
      executeUndo(TEST_USER_ID)

      const restoredTask = getDb()
        .prepare(
          'SELECT completion_count, first_completed_at, last_completed_at FROM tasks WHERE id = ?',
        )
        .get(task.id) as {
        completion_count: number
        first_completed_at: string | null
        last_completed_at: string | null
      }
      expect(restoredTask.completion_count).toBe(0)
      expect(restoredTask.first_completed_at).toBeNull()
      expect(restoredTask.last_completed_at).toBeNull()
    })
  })

  describe('CM-011: One-off completion snapshot includes _completion for redo', () => {
    test('one-off done snapshot after_state contains _completion data', () => {
      const task = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Check _completion', due_at: localTime(15, 0) },
      })

      markDone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: task.id })

      const undoLogs = getUndoSnapshots(TEST_USER_ID)
      const doneEntry = undoLogs.find((e) => e.action === 'done')
      expect(doneEntry).toBeDefined()

      const snapshots = JSON.parse(doneEntry!.snapshot)
      expect(snapshots).toHaveLength(1)

      // after_state should include _completion for redo to recreate the record
      const afterState = snapshots[0].after_state
      expect(afterState._completion).toBeDefined()
      expect(afterState._completion.user_id).toBe(TEST_USER_ID)
      expect(afterState._completion.completed_at).toBeDefined()
      expect(afterState._completion.due_at_was).toBe(task.due_at)
      expect(afterState._completion.due_at_next).toBeNull()

      // completion_id should be set on the snapshot
      expect(snapshots[0].completion_id).toBeDefined()
      expect(typeof snapshots[0].completion_id).toBe('number')
    })
  })

  describe('CM-012: Recurring completion multiple cycles', () => {
    test('completing a recurring task multiple times creates multiple completion records', () => {
      const task = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: {
          title: 'Multi complete',
          due_at: localTime(9, 0),
          rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
        },
      })

      // Complete 3 times
      markDone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: task.id })
      vi.setSystemTime(new Date('2026-01-16T16:00:00Z'))
      markDone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: task.id })
      vi.setSystemTime(new Date('2026-01-17T16:00:00Z'))
      markDone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: task.id })

      const completions = getCompletions(task.id)
      expect(completions).toHaveLength(3)

      // Each completion should have a unique ID
      const ids = completions.map((c) => c.id)
      expect(new Set(ids).size).toBe(3)

      // Each completion's due_at_next should be the next one's due_at_was
      for (let i = 0; i < completions.length - 1; i++) {
        expect(completions[i].due_at_next).toBe(completions[i + 1].due_at_was)
      }
    })
  })

  describe('CM-013: Undo recurring completion with multiple completions', () => {
    test('undo removes only the most recent completion from a recurring task', () => {
      const task = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: {
          title: 'Multi undo',
          due_at: localTime(9, 0),
          rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
        },
      })

      // Complete twice
      markDone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: task.id })
      vi.setSystemTime(new Date('2026-01-16T16:00:00Z'))
      markDone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: task.id })

      expect(getCompletions(task.id)).toHaveLength(2)

      // Undo the most recent completion
      executeUndo(TEST_USER_ID)

      // Should have 1 completion left (the first one)
      const remaining = getCompletions(task.id)
      expect(remaining).toHaveLength(1)
    })
  })

  describe('CM-014a: Complete → undone → complete → undone cycle', () => {
    test('full complete/undone cycle maintains consistent state', () => {
      const task = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Cycle task', due_at: localTime(10, 0) },
      })

      // Cycle 1: complete → undone
      markDone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: task.id })
      expect(getCompletions(task.id)).toHaveLength(1)

      let taskRow = getDb()
        .prepare(
          'SELECT done, completion_count, first_completed_at, last_completed_at FROM tasks WHERE id = ?',
        )
        .get(task.id) as {
        done: number
        completion_count: number
        first_completed_at: string | null
        last_completed_at: string | null
      }
      expect(taskRow.completion_count).toBe(1)

      markUndone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: task.id })
      expect(getCompletions(task.id)).toHaveLength(0)

      taskRow = getDb()
        .prepare(
          'SELECT done, completion_count, first_completed_at, last_completed_at FROM tasks WHERE id = ?',
        )
        .get(task.id) as typeof taskRow
      expect(taskRow.completion_count).toBe(0)
      expect(taskRow.first_completed_at).toBeNull()
      expect(taskRow.last_completed_at).toBeNull()
      expect(taskRow.done).toBe(0)

      // Cycle 2: complete again → undone again
      vi.setSystemTime(new Date('2026-01-15T17:00:00Z'))
      markDone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: task.id })
      expect(getCompletions(task.id)).toHaveLength(1)

      taskRow = getDb()
        .prepare(
          'SELECT done, completion_count, first_completed_at, last_completed_at FROM tasks WHERE id = ?',
        )
        .get(task.id) as typeof taskRow
      expect(taskRow.completion_count).toBe(1)

      markUndone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: task.id })
      expect(getCompletions(task.id)).toHaveLength(0)

      taskRow = getDb()
        .prepare(
          'SELECT done, completion_count, first_completed_at, last_completed_at FROM tasks WHERE id = ?',
        )
        .get(task.id) as typeof taskRow
      expect(taskRow.completion_count).toBe(0)
      expect(taskRow.first_completed_at).toBeNull()
      expect(taskRow.last_completed_at).toBeNull()
      expect(taskRow.done).toBe(0)
    })
  })

  describe('CM-014b: Undo/redo of markUndone', () => {
    test('undo of markUndone restores task to done state with correct stats', () => {
      const task = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Undo undone task', due_at: localTime(10, 0) },
      })

      markDone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: task.id })
      markUndone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: task.id })

      // Undo the markUndone — should restore to done state
      const result = executeUndo(TEST_USER_ID)
      expect(result).not.toBeNull()
      expect(result!.undone_action).toBe('undone')

      const taskRow = getDb()
        .prepare(
          'SELECT done, done_at, archived_at, completion_count, first_completed_at, last_completed_at FROM tasks WHERE id = ?',
        )
        .get(task.id) as {
        done: number
        done_at: string | null
        archived_at: string | null
        completion_count: number
        first_completed_at: string | null
        last_completed_at: string | null
      }
      expect(taskRow.done).toBe(1)
      expect(taskRow.done_at).not.toBeNull()
      expect(taskRow.archived_at).not.toBeNull()
      expect(taskRow.completion_count).toBe(1)
      expect(taskRow.first_completed_at).not.toBeNull()
      expect(taskRow.last_completed_at).not.toBeNull()

      // Known limitation: completion record is NOT restored by undo of markUndone
      // (the 'undone' snapshot doesn't track _completion data for recreation)
      expect(getCompletions(task.id)).toHaveLength(0)
    })

    test('redo of markUndone re-applies the undone state', () => {
      const task = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Redo undone task', due_at: localTime(10, 0) },
      })

      markDone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: task.id })
      markUndone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: task.id })

      // Undo the markUndone (back to done)
      executeUndo(TEST_USER_ID)

      // Redo the markUndone (back to undone)
      const result = executeRedo(TEST_USER_ID)
      expect(result).not.toBeNull()
      expect(result!.redone_action).toBe('undone')

      const taskRow = getDb()
        .prepare(
          'SELECT done, done_at, archived_at, completion_count, first_completed_at, last_completed_at FROM tasks WHERE id = ?',
        )
        .get(task.id) as {
        done: number
        done_at: string | null
        archived_at: string | null
        completion_count: number
        first_completed_at: string | null
        last_completed_at: string | null
      }
      expect(taskRow.done).toBe(0)
      expect(taskRow.done_at).toBeNull()
      expect(taskRow.archived_at).toBeNull()
      expect(taskRow.completion_count).toBe(0)
      expect(taskRow.first_completed_at).toBeNull()
      expect(taskRow.last_completed_at).toBeNull()
    })
  })

  describe('CM-014c: Bulk done snapshot titles', () => {
    test('bulk done snapshots include title in before_state for each task', () => {
      const task1 = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Bulk title A', due_at: localTime(8, 0) },
      })
      const task2 = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Bulk title B', due_at: localTime(9, 0) },
      })

      bulkDone({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        taskIds: [task1.id, task2.id],
      })

      const undoLogs = getUndoSnapshots(TEST_USER_ID)
      const bulkDoneEntry = undoLogs.find((e) => e.action === 'bulk_done')
      expect(bulkDoneEntry).toBeDefined()

      const snapshots = JSON.parse(bulkDoneEntry!.snapshot)
      expect(snapshots).toHaveLength(2)

      // Find snapshots by task_id
      const snap1 = snapshots.find((s: { task_id: number }) => s.task_id === task1.id)
      const snap2 = snapshots.find((s: { task_id: number }) => s.task_id === task2.id)

      expect(snap1.before_state.title).toBe('Bulk title A')
      expect(snap2.before_state.title).toBe('Bulk title B')
    })
  })
})
