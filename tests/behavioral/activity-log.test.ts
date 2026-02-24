/**
 * Activity Log Behavioral Tests
 *
 * Verifies that every task mutation produces the correct activity_log entries
 * with proper action types, before/after diffs, batch IDs, and metadata.
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
import { snoozeTask } from '@/core/tasks/snooze'
import { reprocessTask } from '@/core/tasks/reprocess'
import { bulkDone, bulkSnooze, bulkEdit, bulkDelete } from '@/core/tasks/bulk'
import {
  setupTestDb,
  teardownTestDb,
  localTime,
  TEST_USER_ID,
  TEST_TIMEZONE,
} from '../helpers/setup'

interface ActivityRow {
  id: number
  user_id: number
  task_id: number
  action: string
  source: string
  batch_id: string | null
  fields: string | null
  before: string | null
  after: string | null
  metadata: string | null
  created_at: string
}

function getActivityRows(taskId?: number): ActivityRow[] {
  const db = getDb()
  if (taskId !== undefined) {
    return db
      .prepare('SELECT * FROM activity_log WHERE task_id = ? ORDER BY id')
      .all(taskId) as ActivityRow[]
  }
  return db.prepare('SELECT * FROM activity_log ORDER BY id').all() as ActivityRow[]
}

function getAllActivityRows(): ActivityRow[] {
  return getActivityRows()
}

describe('Activity Log', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-01-15T16:00:00Z'))
    setupTestDb()
  })

  afterEach(() => {
    vi.useRealTimers()
    teardownTestDb()
  })

  describe('single operations', () => {
    test('logs task creation', () => {
      const task = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Buy groceries', priority: 2, due_at: localTime(17, 0, 1) },
      })

      const rows = getActivityRows(task.id)
      expect(rows).toHaveLength(1)

      const row = rows[0]
      expect(row.action).toBe('create')
      expect(row.source).toBe('single')
      expect(row.batch_id).toBeNull()
      expect(row.user_id).toBe(TEST_USER_ID)
      expect(row.task_id).toBe(task.id)

      const fields = JSON.parse(row.fields!)
      expect(fields).toContain('title')
      expect(fields).toContain('priority')
      expect(fields).not.toContain('id')

      // Create has no before state
      expect(row.before).toBeNull()

      const after = JSON.parse(row.after!)
      expect(after.title).toBe('Buy groceries')
      expect(after.priority).toBe(2)
    })

    test('logs task edit', () => {
      const task = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Test task', priority: 0 },
      })

      updateTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        taskId: task.id,
        input: { priority: 3 },
      })

      const rows = getActivityRows(task.id)
      expect(rows).toHaveLength(2) // create + edit

      const editRow = rows[1]
      expect(editRow.action).toBe('edit')
      expect(editRow.source).toBe('single')

      const fields = JSON.parse(editRow.fields!)
      expect(fields).toContain('priority')

      const before = JSON.parse(editRow.before!)
      expect(before.priority).toBe(0)

      const after = JSON.parse(editRow.after!)
      expect(after.priority).toBe(3)
    })

    test('logs snooze via updateTask with snooze action', () => {
      const task = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Snooze me', due_at: localTime(8, 0) },
      })

      const newDueAt = localTime(14, 0)
      updateTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        taskId: task.id,
        input: { due_at: newDueAt },
      })

      const rows = getActivityRows(task.id)
      expect(rows).toHaveLength(2) // create + snooze

      const snoozeRow = rows[1]
      expect(snoozeRow.action).toBe('snooze')

      const metadata = JSON.parse(snoozeRow.metadata!)
      expect(metadata.snooze_detected).toBe(true)
    })

    test('logs snooze via snoozeTask endpoint', () => {
      const task = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Snooze endpoint test', due_at: localTime(8, 0) },
      })

      snoozeTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        taskId: task.id,
        until: localTime(14, 0),
      })

      const rows = getActivityRows(task.id)
      expect(rows).toHaveLength(2) // create + snooze

      const snoozeRow = rows[1]
      expect(snoozeRow.action).toBe('snooze')
      expect(snoozeRow.metadata).not.toBeNull()
    })

    test('logs one-off task completion', () => {
      const task = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'One-off task', due_at: localTime(8, 0) },
      })

      markDone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: task.id })

      const rows = getActivityRows(task.id)
      expect(rows).toHaveLength(2) // create + complete

      const completeRow = rows[1]
      expect(completeRow.action).toBe('complete')

      const metadata = JSON.parse(completeRow.metadata!)
      expect(metadata.recurring).toBe(false)

      const fields = JSON.parse(completeRow.fields!)
      expect(fields).toContain('done')
      expect(fields).toContain('done_at')
    })

    test('logs recurring task completion with next_due_at', () => {
      const task = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: {
          title: 'Daily standup',
          due_at: localTime(9, 0),
          rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
        },
      })

      markDone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: task.id })

      const rows = getActivityRows(task.id)
      const completeRow = rows[rows.length - 1]
      expect(completeRow.action).toBe('complete')

      const metadata = JSON.parse(completeRow.metadata!)
      expect(metadata.recurring).toBe(true)
      expect(metadata.next_due_at).toBeDefined()
    })

    test('logs uncomplete (mark undone)', () => {
      const task = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Reopen me' },
      })

      markDone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: task.id })
      markUndone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: task.id })

      const rows = getActivityRows(task.id)
      expect(rows).toHaveLength(3) // create + complete + uncomplete

      const uncompleteRow = rows[2]
      expect(uncompleteRow.action).toBe('uncomplete')

      const fields = JSON.parse(uncompleteRow.fields!)
      expect(fields).toContain('done')
      expect(fields).toContain('done_at')
      expect(fields).toContain('archived_at')
    })

    test('logs delete and restore', () => {
      const task = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Delete me' },
      })

      deleteTask({ userId: TEST_USER_ID, taskId: task.id })

      let rows = getActivityRows(task.id)
      expect(rows).toHaveLength(2) // create + delete

      const deleteRow = rows[1]
      expect(deleteRow.action).toBe('delete')
      const deleteFields = JSON.parse(deleteRow.fields!)
      expect(deleteFields).toContain('deleted_at')

      restoreTask({ userId: TEST_USER_ID, taskId: task.id })

      rows = getActivityRows(task.id)
      expect(rows).toHaveLength(3) // create + delete + restore

      const restoreRow = rows[2]
      expect(restoreRow.action).toBe('restore')
    })

    test('logs reprocess', () => {
      const task = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'AI failed task', labels: ['ai-failed'] },
      })

      reprocessTask({ userId: TEST_USER_ID, taskId: task.id })

      const rows = getActivityRows(task.id)
      const reprocessRow = rows[rows.length - 1]
      expect(reprocessRow.action).toBe('reprocess')

      const fields = JSON.parse(reprocessRow.fields!)
      expect(fields).toContain('labels')
    })
  })

  describe('bulk operations', () => {
    test('bulk done links entries with batch_id', () => {
      const task1 = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Task 1', due_at: localTime(8, 0) },
      })
      const task2 = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Task 2', due_at: localTime(9, 0) },
      })

      bulkDone({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        taskIds: [task1.id, task2.id],
      })

      const allRows = getAllActivityRows().filter((r) => r.action === 'complete')
      expect(allRows).toHaveLength(2)

      // All entries share the same batch_id
      expect(allRows[0].batch_id).not.toBeNull()
      expect(allRows[0].batch_id).toBe(allRows[1].batch_id)

      // All marked as bulk source
      expect(allRows[0].source).toBe('bulk')
      expect(allRows[1].source).toBe('bulk')
    })

    test('bulk snooze logs with tier metadata', () => {
      const task1 = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Low pri', priority: 0, due_at: localTime(8, 0) },
      })
      const task2 = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Also low', priority: 1, due_at: localTime(9, 0) },
      })

      bulkSnooze({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        taskIds: [task1.id, task2.id],
        until: localTime(17, 0),
      })

      const snoozeRows = getAllActivityRows().filter((r) => r.action === 'snooze')
      expect(snoozeRows).toHaveLength(2)

      // Batch ID links them
      expect(snoozeRows[0].batch_id).not.toBeNull()
      expect(snoozeRows[0].batch_id).toBe(snoozeRows[1].batch_id)

      // Metadata present
      const metadata0 = JSON.parse(snoozeRows[0].metadata!)
      expect(metadata0).toBeDefined()
    })

    test('bulk edit logs with correct action per task', () => {
      const task1 = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Edit me', priority: 0 },
      })
      const task2 = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Edit me too', priority: 1 },
      })

      bulkEdit({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        taskIds: [task1.id, task2.id],
        changes: { priority: 3 },
      })

      const editRows = getAllActivityRows().filter((r) => r.action === 'edit')
      expect(editRows).toHaveLength(2)

      // Shared batch_id
      expect(editRows[0].batch_id).not.toBeNull()
      expect(editRows[0].batch_id).toBe(editRows[1].batch_id)

      // source is bulk
      expect(editRows[0].source).toBe('bulk')
    })

    test('bulk delete logs with batch_id', () => {
      const task1 = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Delete 1' },
      })
      const task2 = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Delete 2' },
      })

      bulkDelete({
        userId: TEST_USER_ID,
        taskIds: [task1.id, task2.id],
      })

      const deleteRows = getAllActivityRows().filter((r) => r.action === 'delete')
      expect(deleteRows).toHaveLength(2)

      expect(deleteRows[0].batch_id).not.toBeNull()
      expect(deleteRows[0].batch_id).toBe(deleteRows[1].batch_id)
      expect(deleteRows[0].source).toBe('bulk')
    })
  })

  describe('data integrity', () => {
    test('before/after only contains changed fields', () => {
      const task = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Focused diff', priority: 1, due_at: localTime(8, 0) },
      })

      updateTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        taskId: task.id,
        input: { priority: 4 },
      })

      const editRow = getAllActivityRows().filter((r) => r.action === 'edit')[0]
      const before = JSON.parse(editRow.before!)
      const after = JSON.parse(editRow.after!)

      // Should only have id + changed fields, not the entire task
      expect(Object.keys(before)).toContain('priority')
      expect(Object.keys(after)).toContain('priority')

      // Should NOT include unchanged fields like title or due_at
      expect(before.title).toBeUndefined()
      expect(after.title).toBeUndefined()
    })

    test('snooze via due_at edit uses snooze action, not edit', () => {
      const task = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Snooze detection', due_at: localTime(8, 0) },
      })

      updateTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        taskId: task.id,
        input: { due_at: localTime(14, 0) },
      })

      const rows = getActivityRows(task.id)
      const lastRow = rows[rows.length - 1]
      expect(lastRow.action).toBe('snooze')
    })

    test('non-snooze due_at change (with rrule) uses edit action', () => {
      const task = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: {
          title: 'Recurrence change',
          due_at: localTime(9, 0),
          rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
        },
      })

      updateTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        taskId: task.id,
        input: { rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0' },
      })

      const rows = getActivityRows(task.id)
      const lastRow = rows[rows.length - 1]
      expect(lastRow.action).toBe('edit')
    })

    test('activity log entries have correct timestamps', () => {
      createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Timestamp check' },
      })

      const rows = getAllActivityRows()
      expect(rows.length).toBeGreaterThan(0)
      expect(rows[0].created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    })

    test('full lifecycle produces correct sequence', () => {
      // Create → snooze → complete → full lifecycle
      const task = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Lifecycle task', due_at: localTime(8, 0) },
      })

      snoozeTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        taskId: task.id,
        until: localTime(14, 0),
      })

      markDone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: task.id })

      const rows = getActivityRows(task.id)
      expect(rows).toHaveLength(3)
      expect(rows[0].action).toBe('create')
      expect(rows[1].action).toBe('snooze')
      expect(rows[2].action).toBe('complete')
    })

    test('no-op update produces no activity log entry', () => {
      const task = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'No-op test', priority: 2 },
      })

      // Update with the same priority — no fields change
      updateTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        taskId: task.id,
        input: { priority: 2 },
      })

      const rows = getActivityRows(task.id)
      expect(rows).toHaveLength(1) // only the create
    })

    test('each bulk operation gets a unique batch_id', () => {
      const task1 = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Batch A', due_at: localTime(8, 0) },
      })
      const task2 = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Batch B', due_at: localTime(9, 0) },
      })

      bulkSnooze({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        taskIds: [task1.id, task2.id],
        until: localTime(12, 0),
      })

      bulkSnooze({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        taskIds: [task1.id, task2.id],
        until: localTime(17, 0),
      })

      const snoozeRows = getAllActivityRows().filter((r) => r.action === 'snooze')
      expect(snoozeRows).toHaveLength(4)

      // First pair shares one batch_id, second pair shares a different one
      const batch1 = snoozeRows[0].batch_id
      const batch2 = snoozeRows[2].batch_id
      expect(batch1).not.toBeNull()
      expect(batch2).not.toBeNull()
      expect(batch1).not.toBe(batch2)
      expect(snoozeRows[0].batch_id).toBe(snoozeRows[1].batch_id)
      expect(snoozeRows[2].batch_id).toBe(snoozeRows[3].batch_id)
    })

    test('bulk edit with due_at uses snooze action per task', () => {
      const task1 = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Bulk snooze edit 1', priority: 0, due_at: localTime(8, 0) },
      })
      const task2 = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Bulk snooze edit 2', priority: 1, due_at: localTime(9, 0) },
      })

      bulkEdit({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        taskIds: [task1.id, task2.id],
        changes: { due_at: localTime(17, 0) },
      })

      const snoozeRows = getAllActivityRows().filter((r) => r.action === 'snooze')
      expect(snoozeRows).toHaveLength(2)
      expect(snoozeRows[0].source).toBe('bulk')
      // No 'edit' rows should be produced for a due_at-only bulk change
      const editRows = getAllActivityRows().filter(
        (r) => r.action === 'edit' && r.source === 'bulk',
      )
      expect(editRows).toHaveLength(0)
    })
  })

  describe('persistence across hard delete', () => {
    test('activity log entries survive emptyTrash', () => {
      const task = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Will be hard deleted', due_at: localTime(8, 0) },
      })
      const taskId = task.id

      // Build some history: snooze, then delete
      snoozeTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        taskId,
        until: localTime(14, 0),
      })
      deleteTask({ userId: TEST_USER_ID, taskId })

      // Verify rows exist before hard delete
      const rowsBefore = getActivityRows(taskId)
      expect(rowsBefore).toHaveLength(3) // create + snooze + delete

      // Hard-delete via emptyTrash
      emptyTrash(TEST_USER_ID)

      // Task row is gone
      const db = getDb()
      const taskRow = db.prepare('SELECT id FROM tasks WHERE id = ?').get(taskId)
      expect(taskRow).toBeUndefined()

      // Activity log rows survive
      const rowsAfter = getActivityRows(taskId)
      expect(rowsAfter).toHaveLength(3)
      expect(rowsAfter[0].action).toBe('create')
      expect(rowsAfter[1].action).toBe('snooze')
      expect(rowsAfter[2].action).toBe('delete')
    })

    test('activity log entries for multiple tasks survive bulk emptyTrash', () => {
      const task1 = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Trash 1' },
      })
      const task2 = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Trash 2' },
      })

      deleteTask({ userId: TEST_USER_ID, taskId: task1.id })
      deleteTask({ userId: TEST_USER_ID, taskId: task2.id })
      emptyTrash(TEST_USER_ID)

      // Both tasks' activity logs survive
      const rows1 = getActivityRows(task1.id)
      const rows2 = getActivityRows(task2.id)
      expect(rows1).toHaveLength(2) // create + delete
      expect(rows2).toHaveLength(2) // create + delete
    })
  })

  describe('volume', () => {
    test('bulk done with 100 tasks produces 100 linked activity entries', () => {
      const taskIds: number[] = []
      for (let i = 0; i < 100; i++) {
        const task = createTask({
          userId: TEST_USER_ID,
          userTimezone: TEST_TIMEZONE,
          input: { title: `Bulk task ${i}`, due_at: localTime(8, 0) },
        })
        taskIds.push(task.id)
      }

      bulkDone({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        taskIds,
      })

      const completeRows = getAllActivityRows().filter((r) => r.action === 'complete')
      expect(completeRows).toHaveLength(100)

      // All share the same batch_id
      const batchId = completeRows[0].batch_id
      expect(batchId).not.toBeNull()
      expect(completeRows.every((r) => r.batch_id === batchId)).toBe(true)

      // All marked as bulk
      expect(completeRows.every((r) => r.source === 'bulk')).toBe(true)

      // Each entry references a unique task_id
      const uniqueTaskIds = new Set(completeRows.map((r) => r.task_id))
      expect(uniqueTaskIds.size).toBe(100)
    })

    test('rapid sequential operations on same task produce ordered entries', () => {
      const task = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Rapid ops', priority: 0, due_at: localTime(8, 0) },
      })

      // 10 rapid edits
      for (let i = 1; i <= 10; i++) {
        const mins = String(i).padStart(2, '0')
        vi.setSystemTime(new Date(`2026-01-15T16:${mins}:00Z`))
        updateTask({
          userId: TEST_USER_ID,
          userTimezone: TEST_TIMEZONE,
          taskId: task.id,
          input: { priority: i % 5 },
        })
      }

      const rows = getActivityRows(task.id)
      // create + up to 10 edits (some may be no-ops if priority didn't change)
      expect(rows.length).toBeGreaterThan(1)

      // IDs are monotonically increasing (insertion order preserved)
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i].id).toBeGreaterThan(rows[i - 1].id)
      }
    })

    test('mixed bulk operations produce correct total row count', () => {
      const tasks = Array.from({ length: 5 }, (_, i) =>
        createTask({
          userId: TEST_USER_ID,
          userTimezone: TEST_TIMEZONE,
          input: { title: `Mixed ${i}`, priority: 0, due_at: localTime(8, 0) },
        }),
      )
      const ids = tasks.map((t) => t.id)

      // 5 creates already done
      // Bulk snooze all 5
      bulkSnooze({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        taskIds: ids,
        until: localTime(14, 0),
      })

      // Bulk edit priority on all 5
      bulkEdit({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        taskIds: ids,
        changes: { priority: 2 },
      })

      // Bulk done all 5
      bulkDone({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        taskIds: ids,
      })

      const allRows = getAllActivityRows()
      // 5 creates + 5 snoozes + 5 edits + 5 completes = 20
      expect(allRows).toHaveLength(20)

      // Verify action distribution
      const actions = allRows.map((r) => r.action)
      expect(actions.filter((a) => a === 'create')).toHaveLength(5)
      expect(actions.filter((a) => a === 'snooze')).toHaveLength(5)
      expect(actions.filter((a) => a === 'edit')).toHaveLength(5)
      expect(actions.filter((a) => a === 'complete')).toHaveLength(5)
    })
  })
})
