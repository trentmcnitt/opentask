/**
 * Behavioral tests for Undo/Redo (UR-001 through UR-012)
 *
 * These tests verify the surgical undo/redo functionality.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { getDb, resetDb } from '@/core/db'
import {
  logAction,
  createTaskSnapshot,
  executeUndo,
  executeRedo,
  canUndo,
  canRedo,
  countUndoable,
  countRedoable,
  getLatestUndoId,
  executeBatchUndo,
  executeBatchRedo,
} from '@/core/undo'
import { nowUtc } from '@/core/recurrence'
import { setupTestDb } from '../helpers/setup'

function createTestTask(overrides: Record<string, unknown> = {}) {
  const db = getDb()
  const defaults = {
    user_id: 1,
    project_id: 1,
    title: 'Test Task',
    done: 0,
    priority: 0,
    due_at: '2026-01-31T14:00:00Z',
    rrule: 'FREQ=DAILY;BYHOUR=8;BYMINUTE=0',
    recurrence_mode: 'from_due',
    anchor_time: '08:00',
    original_due_at: null,
    labels: '[]',
    ...overrides,
  }

  const result = db
    .prepare(
      `INSERT INTO tasks (user_id, project_id, title, done, priority, due_at, rrule, recurrence_mode, anchor_time, original_due_at, labels)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      defaults.user_id,
      defaults.project_id,
      defaults.title,
      defaults.done,
      defaults.priority,
      defaults.due_at,
      defaults.rrule,
      defaults.recurrence_mode,
      defaults.anchor_time,
      defaults.original_due_at,
      defaults.labels,
    )

  return Number(result.lastInsertRowid)
}

function getTask(taskId: number) {
  const row = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as {
    id: number
    due_at: string | null
    original_due_at: string | null
    done: number
    done_at: string | null
    archived_at: string | null
    title: string
    priority: number
  }
  return {
    ...row,
    done: row.done === 1,
  }
}

describe('UR-001: Undo Mark Done (Recurring)', () => {
  beforeEach(() => {
    setupTestDb()
  })

  afterEach(() => {
    resetDb()
  })

  test('undoing a recurring mark-done restores due_at and original_due_at', () => {
    // Create a recurring task
    const taskId = createTestTask({
      due_at: '2026-01-31T14:00:00Z', // Today at 8 AM Chicago
      original_due_at: null,
      rrule: 'FREQ=DAILY;BYHOUR=8;BYMINUTE=0',
    })

    const beforeTask = getTask(taskId)
    expect(beforeTask.due_at).toBe('2026-01-31T14:00:00Z')
    expect(beforeTask.original_due_at).toBeNull()

    // Simulate mark done - advance due_at
    const newDueAt = '2026-02-01T14:00:00Z' // Tomorrow at 8 AM
    getDb().prepare('UPDATE tasks SET due_at = ? WHERE id = ?').run(newDueAt, taskId)

    const afterTask = getTask(taskId)

    // Log the action
    logAction(
      1,
      'done',
      'Marked task done',
      ['due_at', 'original_due_at'],
      [createTaskSnapshot(beforeTask, afterTask, ['due_at', 'original_due_at'])],
    )

    // Verify after state
    const taskAfterDone = getTask(taskId)
    expect(taskAfterDone.due_at).toBe('2026-02-01T14:00:00Z')

    // Execute undo
    const result = executeUndo(1)

    expect(result).not.toBeNull()
    expect(result!.undone_action).toBe('done')
    expect(result!.tasks_affected).toBe(1)

    // Verify task is restored
    const taskAfterUndo = getTask(taskId)
    expect(taskAfterUndo.due_at).toBe('2026-01-31T14:00:00Z')
    expect(taskAfterUndo.original_due_at).toBeNull()
  })
})

describe('UR-002: Undo Mark Done (One-Off)', () => {
  beforeEach(() => {
    setupTestDb()
  })

  afterEach(() => {
    resetDb()
  })

  test('undoing a one-off mark-done restores done=0, clears done_at and archived_at', () => {
    // Create a one-off task (no rrule)
    const taskId = createTestTask({
      rrule: null,
      recurrence_mode: 'from_due',
      anchor_time: null,
    })

    const beforeTask = getTask(taskId)
    expect(beforeTask.done).toBe(false)
    expect(beforeTask.done_at).toBeNull()
    expect(beforeTask.archived_at).toBeNull()

    // Simulate mark done
    const now = nowUtc()
    getDb()
      .prepare('UPDATE tasks SET done = 1, done_at = ?, archived_at = ? WHERE id = ?')
      .run(now, now, taskId)

    const afterTask = getTask(taskId)

    // Log the action
    logAction(
      1,
      'done',
      'Marked task done',
      ['done', 'done_at', 'archived_at'],
      [createTaskSnapshot(beforeTask, afterTask, ['done', 'done_at', 'archived_at'])],
    )

    // Execute undo
    const result = executeUndo(1)

    expect(result).not.toBeNull()

    // Verify task is restored
    const taskAfterUndo = getTask(taskId)
    expect(taskAfterUndo.done).toBe(false)
    expect(taskAfterUndo.done_at).toBeNull()
    expect(taskAfterUndo.archived_at).toBeNull()
  })
})

describe('UR-003: Undo Snooze', () => {
  beforeEach(() => {
    setupTestDb()
  })

  afterEach(() => {
    resetDb()
  })

  test('undoing a snooze restores due_at and original_due_at', () => {
    const taskId = createTestTask({
      due_at: '2026-01-31T14:00:00Z', // 8 AM Chicago
      original_due_at: null,
    })

    const beforeTask = getTask(taskId)

    // Simulate snooze
    getDb().prepare('UPDATE tasks SET due_at = ?, original_due_at = ? WHERE id = ?').run(
      '2026-01-31T20:00:00Z', // Snoozed to 2 PM
      '2026-01-31T14:00:00Z', // Original 8 AM
      taskId,
    )

    const afterTask = getTask(taskId)

    // Log the action
    logAction(
      1,
      'snooze',
      'Snoozed task',
      ['due_at', 'original_due_at'],
      [createTaskSnapshot(beforeTask, afterTask, ['due_at', 'original_due_at'])],
    )

    // Execute undo
    const result = executeUndo(1)

    expect(result).not.toBeNull()

    // Verify task is restored
    const taskAfterUndo = getTask(taskId)
    expect(taskAfterUndo.due_at).toBe('2026-01-31T14:00:00Z')
    expect(taskAfterUndo.original_due_at).toBeNull()
  })
})

describe('UR-004: Undo Is Surgical', () => {
  beforeEach(() => {
    setupTestDb()
  })

  afterEach(() => {
    resetDb()
  })

  test('undo only restores changed fields, preserves other edits', () => {
    const taskId = createTestTask({
      title: 'Original Title',
      due_at: '2026-01-31T14:00:00Z',
      original_due_at: null,
    })

    const beforeTask = getTask(taskId)

    // Action 1: Mark done (changes due_at, original_due_at)
    getDb().prepare('UPDATE tasks SET due_at = ? WHERE id = ?').run('2026-02-01T14:00:00Z', taskId)

    const afterDone = getTask(taskId)

    logAction(
      1,
      'done',
      'Marked task done',
      ['due_at', 'original_due_at'],
      [createTaskSnapshot(beforeTask, afterDone, ['due_at', 'original_due_at'])],
    )

    // Action 2: Edit title (separate edit, not logged to undo for this test)
    getDb().prepare('UPDATE tasks SET title = ? WHERE id = ?').run('New Title', taskId)

    // Verify title changed
    expect(getTask(taskId).title).toBe('New Title')

    // Undo Action 1
    const result = executeUndo(1)

    expect(result).not.toBeNull()

    // Verify: due_at restored, but title stays "New Title"
    const taskAfterUndo = getTask(taskId)
    expect(taskAfterUndo.due_at).toBe('2026-01-31T14:00:00Z')
    expect(taskAfterUndo.title).toBe('New Title') // Title was NOT affected
  })
})

describe('UR-005: Undo Bulk Done', () => {
  beforeEach(() => {
    setupTestDb()
  })

  afterEach(() => {
    resetDb()
  })

  test('undoing a bulk-done reverses all tasks with a single undo', () => {
    // Create 5 tasks
    const taskIds: number[] = []
    const beforeTasks: Array<{ id: number; due_at: string }> = []

    for (let i = 0; i < 5; i++) {
      const id = createTestTask({
        title: `Task ${i + 1}`,
        due_at: `2026-01-3${i + 1}T14:00:00Z`,
      })
      taskIds.push(id)
      beforeTasks.push({ id, due_at: `2026-01-3${i + 1}T14:00:00Z` })
    }

    // Simulate bulk done - advance all due_at
    const snapshots: Array<{ task_id: number; before_state: object; after_state: object }> = []

    for (let i = 0; i < 5; i++) {
      const newDueAt = `2026-02-0${i + 1}T14:00:00Z`
      getDb().prepare('UPDATE tasks SET due_at = ? WHERE id = ?').run(newDueAt, taskIds[i])

      snapshots.push({
        task_id: taskIds[i],
        before_state: { id: taskIds[i], due_at: beforeTasks[i].due_at, original_due_at: null },
        after_state: { id: taskIds[i], due_at: newDueAt, original_due_at: null },
      })
    }

    // Log as single bulk action
    logAction(1, 'bulk_done', 'Marked 5 tasks done', ['due_at', 'original_due_at'], snapshots)

    // Single undo should reverse all
    const result = executeUndo(1)

    expect(result).not.toBeNull()
    expect(result!.tasks_affected).toBe(5)
    expect(result!.undone_action).toBe('bulk_done')

    // Verify all tasks restored
    for (let i = 0; i < 5; i++) {
      const task = getTask(taskIds[i])
      expect(task.due_at).toBe(beforeTasks[i].due_at)
    }
  })
})

describe('UR-006: Redo After Undo', () => {
  beforeEach(() => {
    setupTestDb()
  })

  afterEach(() => {
    resetDb()
  })

  test('after undoing, redo re-applies the action', () => {
    const taskId = createTestTask({
      due_at: '2026-01-31T14:00:00Z',
    })

    const beforeTask = getTask(taskId)

    // Mark done
    const newDueAt = '2026-02-01T14:00:00Z'
    getDb().prepare('UPDATE tasks SET due_at = ? WHERE id = ?').run(newDueAt, taskId)

    const afterTask = getTask(taskId)

    logAction(
      1,
      'done',
      'Marked task done',
      ['due_at', 'original_due_at'],
      [createTaskSnapshot(beforeTask, afterTask, ['due_at', 'original_due_at'])],
    )

    // Undo
    executeUndo(1)
    expect(getTask(taskId).due_at).toBe('2026-01-31T14:00:00Z')

    // Redo
    const result = executeRedo(1)

    expect(result).not.toBeNull()
    expect(result!.redone_action).toBe('done')

    // Verify task is back to done state
    expect(getTask(taskId).due_at).toBe('2026-02-01T14:00:00Z')
  })
})

describe('UR-007: New Action Clears Redo Stack', () => {
  beforeEach(() => {
    setupTestDb()
  })

  afterEach(() => {
    resetDb()
  })

  test('after undoing, performing a new action clears redo', () => {
    const taskId = createTestTask()

    const beforeTask = getTask(taskId)

    // Action 1: Mark done
    getDb().prepare('UPDATE tasks SET due_at = ? WHERE id = ?').run('2026-02-01T14:00:00Z', taskId)
    const afterTask = getTask(taskId)
    logAction(
      1,
      'done',
      'Action 1',
      ['due_at', 'original_due_at'],
      [createTaskSnapshot(beforeTask, afterTask, ['due_at', 'original_due_at'])],
    )

    // Undo action 1
    executeUndo(1)
    expect(canRedo(1)).toBe(true)

    // New action: Snooze
    const taskBeforeSnooze = getTask(taskId)
    getDb()
      .prepare('UPDATE tasks SET due_at = ?, original_due_at = ? WHERE id = ?')
      .run('2026-01-31T20:00:00Z', '2026-01-31T14:00:00Z', taskId)
    const taskAfterSnooze = getTask(taskId)
    logAction(
      1,
      'snooze',
      'Snooze action',
      ['due_at', 'original_due_at'],
      [createTaskSnapshot(taskBeforeSnooze, taskAfterSnooze, ['due_at', 'original_due_at'])],
    )

    // Redo should no longer be available (new action cleared it)
    expect(canRedo(1)).toBe(false)
  })
})

describe('UR-008: Per-User Isolation', () => {
  beforeEach(() => {
    setupTestDb()

    // Create second user
    getDb()
      .prepare(
        `INSERT INTO users (email, name, password_hash, timezone)
       VALUES ('test2@example.com', 'Test User 2', 'hash', 'America/Chicago')`,
      )
      .run()

    // Create project for user 2
    getDb()
      .prepare(
        `INSERT INTO projects (name, owner_id, shared, sort_order)
       VALUES ('Test Project 2', 2, 0, 0)`,
      )
      .run()
  })

  afterEach(() => {
    resetDb()
  })

  test('user A undo history is independent of user B', () => {
    // Create task for user 1
    const task1Id = createTestTask({ user_id: 1, project_id: 1 })

    // Create task for user 2
    const task2Id = createTestTask({ user_id: 2, project_id: 2 })

    // User 1 marks their task done
    const before1 = getTask(task1Id)
    getDb().prepare('UPDATE tasks SET due_at = ? WHERE id = ?').run('2026-02-01T14:00:00Z', task1Id)
    const after1 = getTask(task1Id)
    logAction(
      1,
      'done',
      'User 1 action',
      ['due_at', 'original_due_at'],
      [createTaskSnapshot(before1, after1, ['due_at', 'original_due_at'])],
    )

    // User 2 marks their task done
    const before2 = getTask(task2Id)
    getDb().prepare('UPDATE tasks SET due_at = ? WHERE id = ?').run('2026-02-02T14:00:00Z', task2Id)
    const after2 = getTask(task2Id)
    logAction(
      2,
      'done',
      'User 2 action',
      ['due_at', 'original_due_at'],
      [createTaskSnapshot(before2, after2, ['due_at', 'original_due_at'])],
    )

    // User 1 can undo their action
    expect(canUndo(1)).toBe(true)

    // User 2 can undo their action
    expect(canUndo(2)).toBe(true)

    // User 1's undo only affects their task
    executeUndo(1)
    expect(getTask(task1Id).due_at).toBe('2026-01-31T14:00:00Z') // Restored
    expect(getTask(task2Id).due_at).toBe('2026-02-02T14:00:00Z') // Unchanged

    // User 2's undo only affects their task
    executeUndo(2)
    expect(getTask(task2Id).due_at).toBe('2026-01-31T14:00:00Z') // Restored
  })
})

describe('UR-009: Undo Task Creation (soft delete)', () => {
  beforeEach(() => {
    setupTestDb()
  })

  afterEach(() => {
    resetDb()
  })

  test('undoing a task creation soft-deletes the task', () => {
    // Create a task and log the create action
    const taskId = createTestTask({ rrule: null, title: 'New Task' })
    const task = getTask(taskId)

    logAction(
      1,
      'create',
      'Created "New Task"',
      ['title', 'project_id', 'priority', 'due_at'],
      [
        createTaskSnapshot(
          { id: taskId },
          {
            id: taskId,
            title: task.title,
            priority: task.priority,
            due_at: task.due_at,
          },
          ['title', 'project_id', 'priority', 'due_at'],
        ),
      ],
    )

    // Verify the task exists and is not deleted
    expect(getTask(taskId).title).toBe('New Task')
    const beforeUndo = getDb().prepare('SELECT deleted_at FROM tasks WHERE id = ?').get(taskId) as {
      deleted_at: string | null
    }
    expect(beforeUndo.deleted_at).toBeNull()

    // Undo the creation
    const result = executeUndo(1)
    expect(result).not.toBeNull()
    expect(result!.undone_action).toBe('create')

    // Verify the task was soft-deleted, not permanently removed
    const afterUndo = getDb().prepare('SELECT deleted_at FROM tasks WHERE id = ?').get(taskId) as {
      deleted_at: string | null
    }
    expect(afterUndo).not.toBeUndefined()
    expect(afterUndo.deleted_at).not.toBeNull()
  })
})

describe('UR-010: Count and Watermark Functions', () => {
  beforeEach(() => {
    setupTestDb()
  })

  afterEach(() => {
    resetDb()
  })

  test('countUndoable returns correct count', () => {
    expect(countUndoable(1)).toBe(0)

    // Create 3 logged actions
    for (let i = 0; i < 3; i++) {
      const taskId = createTestTask({ title: `Task ${i}` })
      const before = getTask(taskId)
      getDb().prepare('UPDATE tasks SET priority = ? WHERE id = ?').run(2, taskId)
      const after = getTask(taskId)
      logAction(
        1,
        'edit',
        `Edit ${i}`,
        ['priority'],
        [createTaskSnapshot(before, after, ['priority'])],
      )
    }

    expect(countUndoable(1)).toBe(3)

    // Undo one
    executeUndo(1)
    expect(countUndoable(1)).toBe(2)
  })

  test('countRedoable returns correct count', () => {
    expect(countRedoable(1)).toBe(0)

    const taskId = createTestTask()
    const before = getTask(taskId)
    getDb().prepare('UPDATE tasks SET priority = ? WHERE id = ?').run(2, taskId)
    const after = getTask(taskId)
    logAction(1, 'edit', 'Edit', ['priority'], [createTaskSnapshot(before, after, ['priority'])])

    // Undo it
    executeUndo(1)
    expect(countRedoable(1)).toBe(1)

    // Redo it
    executeRedo(1)
    expect(countRedoable(1)).toBe(0)
  })

  test('getLatestUndoId returns correct ID', () => {
    // No entries yet
    expect(getLatestUndoId(1)).toBeNull()

    // Create an action
    const taskId = createTestTask()
    const before = getTask(taskId)
    getDb().prepare('UPDATE tasks SET priority = ? WHERE id = ?').run(2, taskId)
    const after = getTask(taskId)
    logAction(1, 'edit', 'Edit 1', ['priority'], [createTaskSnapshot(before, after, ['priority'])])

    const id1 = getLatestUndoId(1)
    expect(id1).not.toBeNull()
    expect(typeof id1).toBe('number')

    // Create another action - ID should increase
    const before2 = getTask(taskId)
    getDb().prepare('UPDATE tasks SET priority = ? WHERE id = ?').run(3, taskId)
    const after2 = getTask(taskId)
    logAction(
      1,
      'edit',
      'Edit 2',
      ['priority'],
      [createTaskSnapshot(before2, after2, ['priority'])],
    )

    const id2 = getLatestUndoId(1)
    expect(id2).not.toBeNull()
    expect(id2!).toBeGreaterThan(id1!)
  })
})

describe('UR-011: Batch Undo', () => {
  beforeEach(() => {
    setupTestDb()
  })

  afterEach(() => {
    resetDb()
  })

  test('executeBatchUndo undoes multiple entries atomically', () => {
    // Create 5 actions
    const taskIds: number[] = []
    for (let i = 0; i < 5; i++) {
      const taskId = createTestTask({ title: `Task ${i}`, priority: 0 })
      taskIds.push(taskId)
      const before = getTask(taskId)
      getDb()
        .prepare('UPDATE tasks SET priority = ? WHERE id = ?')
        .run(i + 1, taskId)
      const after = getTask(taskId)
      logAction(
        1,
        'edit',
        `Edit ${i}`,
        ['priority'],
        [createTaskSnapshot(before, after, ['priority'])],
      )
    }

    expect(countUndoable(1)).toBe(5)

    // Batch undo all
    const result = executeBatchUndo(1, { count: 5 })
    expect(result.count).toBe(5)
    expect(result.remaining_undoable).toBe(0)
    expect(result.remaining_redoable).toBe(5)

    // All tasks should be back to priority 0
    for (const taskId of taskIds) {
      expect(getTask(taskId).priority).toBe(0)
    }
  })

  test('executeBatchUndo respects sessionStartId boundary', () => {
    // Create 2 "pre-session" actions
    for (let i = 0; i < 2; i++) {
      const taskId = createTestTask({ title: `Pre ${i}`, priority: 0 })
      const before = getTask(taskId)
      getDb().prepare('UPDATE tasks SET priority = ? WHERE id = ?').run(1, taskId)
      const after = getTask(taskId)
      logAction(
        1,
        'edit',
        `Pre ${i}`,
        ['priority'],
        [createTaskSnapshot(before, after, ['priority'])],
      )
    }

    // Record the session watermark
    const sessionStartId = getLatestUndoId(1)!

    // Create 3 "in-session" actions
    const sessionTaskIds: number[] = []
    for (let i = 0; i < 3; i++) {
      const taskId = createTestTask({ title: `Session ${i}`, priority: 0 })
      sessionTaskIds.push(taskId)
      const before = getTask(taskId)
      getDb().prepare('UPDATE tasks SET priority = ? WHERE id = ?').run(2, taskId)
      const after = getTask(taskId)
      logAction(
        1,
        'edit',
        `Session ${i}`,
        ['priority'],
        [createTaskSnapshot(before, after, ['priority'])],
      )
    }

    expect(countUndoable(1)).toBe(5) // 2 pre + 3 session

    // Batch undo with session boundary — should only undo 3 session actions
    const result = executeBatchUndo(1, { sessionStartId })
    expect(result.count).toBe(3)
    expect(result.remaining_undoable).toBe(2) // pre-session actions remain

    // Session tasks should be restored
    for (const taskId of sessionTaskIds) {
      expect(getTask(taskId).priority).toBe(0)
    }
  })

  test('executeBatchUndo with throughId undoes down to specific entry', () => {
    const taskIds: number[] = []
    for (let i = 0; i < 5; i++) {
      const taskId = createTestTask({ title: `Task ${i}`, priority: 0 })
      taskIds.push(taskId)
      const before = getTask(taskId)
      getDb()
        .prepare('UPDATE tasks SET priority = ? WHERE id = ?')
        .run(i + 1, taskId)
      const after = getTask(taskId)
      logAction(
        1,
        'edit',
        `Edit ${i}`,
        ['priority'],
        [createTaskSnapshot(before, after, ['priority'])],
      )
    }

    // Get the ID of the 3rd entry (middle one)
    const entries = getDb()
      .prepare('SELECT id FROM undo_log WHERE user_id = ? ORDER BY id ASC')
      .all(1) as { id: number }[]
    const thirdEntryId = entries[2].id

    // Undo through the 3rd entry — should undo entries 3, 4, 5 (the 3rd and above)
    const result = executeBatchUndo(1, { throughId: thirdEntryId })
    expect(result.count).toBe(3)
    expect(result.remaining_undoable).toBe(2)
  })
})

describe('UR-012: Batch Redo', () => {
  beforeEach(() => {
    setupTestDb()
  })

  afterEach(() => {
    resetDb()
  })

  test('executeBatchRedo redoes multiple entries atomically', () => {
    // Create 3 actions and undo them all
    const taskIds: number[] = []
    for (let i = 0; i < 3; i++) {
      const taskId = createTestTask({ title: `Task ${i}`, priority: 0 })
      taskIds.push(taskId)
      const before = getTask(taskId)
      getDb()
        .prepare('UPDATE tasks SET priority = ? WHERE id = ?')
        .run(i + 1, taskId)
      const after = getTask(taskId)
      logAction(
        1,
        'edit',
        `Edit ${i}`,
        ['priority'],
        [createTaskSnapshot(before, after, ['priority'])],
      )
    }

    // Undo all 3
    executeBatchUndo(1, { count: 3 })
    expect(countRedoable(1)).toBe(3)

    // Batch redo all
    const result = executeBatchRedo(1, { count: 3 })
    expect(result.count).toBe(3)
    expect(result.remaining_undoable).toBe(3)
    expect(result.remaining_redoable).toBe(0)

    // All tasks should have their new priorities
    for (let i = 0; i < 3; i++) {
      expect(getTask(taskIds[i]).priority).toBe(i + 1)
    }
  })

  test('executeBatchRedo with throughId redoes up to specific entry', () => {
    // Create 5 actions and undo them all
    for (let i = 0; i < 5; i++) {
      const taskId = createTestTask({ title: `Task ${i}`, priority: 0 })
      const before = getTask(taskId)
      getDb()
        .prepare('UPDATE tasks SET priority = ? WHERE id = ?')
        .run(i + 1, taskId)
      const after = getTask(taskId)
      logAction(
        1,
        'edit',
        `Edit ${i}`,
        ['priority'],
        [createTaskSnapshot(before, after, ['priority'])],
      )
    }

    executeBatchUndo(1, { count: 5 })
    expect(countRedoable(1)).toBe(5)

    // Get the ID of the 3rd entry
    const entries = getDb()
      .prepare('SELECT id FROM undo_log WHERE user_id = ? ORDER BY id ASC')
      .all(1) as { id: number }[]
    const thirdEntryId = entries[2].id

    // Redo through the 3rd entry — should redo entries 1, 2, 3
    const result = executeBatchRedo(1, { throughId: thirdEntryId })
    expect(result.count).toBe(3)
    expect(result.remaining_redoable).toBe(2)
  })
})
