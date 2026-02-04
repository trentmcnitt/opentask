/**
 * Behavioral tests for Undo/Redo (UR-001 through UR-008)
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
} from '@/core/undo'
import { nowUtc } from '@/core/recurrence'
import bcrypt from 'bcrypt'

// Test setup helpers
async function setupTestDb() {
  resetDb()
  const db = getDb()

  // Create test user
  const passwordHash = await bcrypt.hash('test', 10)
  db.prepare(
    `INSERT INTO users (email, name, password_hash, timezone)
     VALUES ('test@example.com', 'Test User', ?, 'America/Chicago')`,
  ).run(passwordHash)

  // Create test project
  db.prepare(
    `INSERT INTO projects (name, owner_id, shared, sort_order)
     VALUES ('Test Project', 1, 0, 0)`,
  ).run()

  return db
}

function createTestTask(db: ReturnType<typeof getDb>, overrides: Record<string, unknown> = {}) {
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

function getTask(db: ReturnType<typeof getDb>, taskId: number) {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as {
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
  let db: ReturnType<typeof getDb>

  beforeEach(async () => {
    db = await setupTestDb()
  })

  afterEach(() => {
    resetDb()
  })

  test('undoing a recurring mark-done restores due_at and original_due_at', () => {
    // Create a recurring task
    const taskId = createTestTask(db, {
      due_at: '2026-01-31T14:00:00Z', // Today at 8 AM Chicago
      original_due_at: null,
      rrule: 'FREQ=DAILY;BYHOUR=8;BYMINUTE=0',
    })

    const beforeTask = getTask(db, taskId)
    expect(beforeTask.due_at).toBe('2026-01-31T14:00:00Z')
    expect(beforeTask.original_due_at).toBeNull()

    // Simulate mark done - advance due_at
    const newDueAt = '2026-02-01T14:00:00Z' // Tomorrow at 8 AM
    db.prepare('UPDATE tasks SET due_at = ? WHERE id = ?').run(newDueAt, taskId)

    const afterTask = getTask(db, taskId)

    // Log the action
    logAction(
      1,
      'done',
      'Marked task done',
      ['due_at', 'original_due_at'],
      [createTaskSnapshot(beforeTask, afterTask, ['due_at', 'original_due_at'])],
    )

    // Verify after state
    const taskAfterDone = getTask(db, taskId)
    expect(taskAfterDone.due_at).toBe('2026-02-01T14:00:00Z')

    // Execute undo
    const result = executeUndo(1)

    expect(result).not.toBeNull()
    expect(result!.undone_action).toBe('done')
    expect(result!.tasks_affected).toBe(1)

    // Verify task is restored
    const taskAfterUndo = getTask(db, taskId)
    expect(taskAfterUndo.due_at).toBe('2026-01-31T14:00:00Z')
    expect(taskAfterUndo.original_due_at).toBeNull()
  })
})

describe('UR-002: Undo Mark Done (One-Off)', () => {
  let db: ReturnType<typeof getDb>

  beforeEach(async () => {
    db = await setupTestDb()
  })

  afterEach(() => {
    resetDb()
  })

  test('undoing a one-off mark-done restores done=0, clears done_at and archived_at', () => {
    // Create a one-off task (no rrule)
    const taskId = createTestTask(db, {
      rrule: null,
      recurrence_mode: 'from_due',
      anchor_time: null,
    })

    const beforeTask = getTask(db, taskId)
    expect(beforeTask.done).toBe(false)
    expect(beforeTask.done_at).toBeNull()
    expect(beforeTask.archived_at).toBeNull()

    // Simulate mark done
    const now = nowUtc()
    db.prepare('UPDATE tasks SET done = 1, done_at = ?, archived_at = ? WHERE id = ?').run(
      now,
      now,
      taskId,
    )

    const afterTask = getTask(db, taskId)

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
    const taskAfterUndo = getTask(db, taskId)
    expect(taskAfterUndo.done).toBe(false)
    expect(taskAfterUndo.done_at).toBeNull()
    expect(taskAfterUndo.archived_at).toBeNull()
  })
})

describe('UR-003: Undo Snooze', () => {
  let db: ReturnType<typeof getDb>

  beforeEach(async () => {
    db = await setupTestDb()
  })

  afterEach(() => {
    resetDb()
  })

  test('undoing a snooze restores due_at and original_due_at', () => {
    const taskId = createTestTask(db, {
      due_at: '2026-01-31T14:00:00Z', // 8 AM Chicago
      original_due_at: null,
    })

    const beforeTask = getTask(db, taskId)

    // Simulate snooze
    db.prepare('UPDATE tasks SET due_at = ?, original_due_at = ? WHERE id = ?').run(
      '2026-01-31T20:00:00Z', // Snoozed to 2 PM
      '2026-01-31T14:00:00Z', // Original 8 AM
      taskId,
    )

    const afterTask = getTask(db, taskId)

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
    const taskAfterUndo = getTask(db, taskId)
    expect(taskAfterUndo.due_at).toBe('2026-01-31T14:00:00Z')
    expect(taskAfterUndo.original_due_at).toBeNull()
  })
})

describe('UR-004: Undo Is Surgical', () => {
  let db: ReturnType<typeof getDb>

  beforeEach(async () => {
    db = await setupTestDb()
  })

  afterEach(() => {
    resetDb()
  })

  test('undo only restores changed fields, preserves other edits', () => {
    const taskId = createTestTask(db, {
      title: 'Original Title',
      due_at: '2026-01-31T14:00:00Z',
      original_due_at: null,
    })

    const beforeTask = getTask(db, taskId)

    // Action 1: Mark done (changes due_at, original_due_at)
    db.prepare('UPDATE tasks SET due_at = ? WHERE id = ?').run('2026-02-01T14:00:00Z', taskId)

    const afterDone = getTask(db, taskId)

    logAction(
      1,
      'done',
      'Marked task done',
      ['due_at', 'original_due_at'],
      [createTaskSnapshot(beforeTask, afterDone, ['due_at', 'original_due_at'])],
    )

    // Action 2: Edit title (separate edit, not logged to undo for this test)
    db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run('New Title', taskId)

    // Verify title changed
    expect(getTask(db, taskId).title).toBe('New Title')

    // Undo Action 1
    const result = executeUndo(1)

    expect(result).not.toBeNull()

    // Verify: due_at restored, but title stays "New Title"
    const taskAfterUndo = getTask(db, taskId)
    expect(taskAfterUndo.due_at).toBe('2026-01-31T14:00:00Z')
    expect(taskAfterUndo.title).toBe('New Title') // Title was NOT affected
  })
})

describe('UR-005: Undo Bulk Done', () => {
  let db: ReturnType<typeof getDb>

  beforeEach(async () => {
    db = await setupTestDb()
  })

  afterEach(() => {
    resetDb()
  })

  test('undoing a bulk-done reverses all tasks with a single undo', () => {
    // Create 5 tasks
    const taskIds: number[] = []
    const beforeTasks: Array<{ id: number; due_at: string }> = []

    for (let i = 0; i < 5; i++) {
      const id = createTestTask(db, {
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
      db.prepare('UPDATE tasks SET due_at = ? WHERE id = ?').run(newDueAt, taskIds[i])

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
      const task = getTask(db, taskIds[i])
      expect(task.due_at).toBe(beforeTasks[i].due_at)
    }
  })
})

describe('UR-006: Redo After Undo', () => {
  let db: ReturnType<typeof getDb>

  beforeEach(async () => {
    db = await setupTestDb()
  })

  afterEach(() => {
    resetDb()
  })

  test('after undoing, redo re-applies the action', () => {
    const taskId = createTestTask(db, {
      due_at: '2026-01-31T14:00:00Z',
    })

    const beforeTask = getTask(db, taskId)

    // Mark done
    const newDueAt = '2026-02-01T14:00:00Z'
    db.prepare('UPDATE tasks SET due_at = ? WHERE id = ?').run(newDueAt, taskId)

    const afterTask = getTask(db, taskId)

    logAction(
      1,
      'done',
      'Marked task done',
      ['due_at', 'original_due_at'],
      [createTaskSnapshot(beforeTask, afterTask, ['due_at', 'original_due_at'])],
    )

    // Undo
    executeUndo(1)
    expect(getTask(db, taskId).due_at).toBe('2026-01-31T14:00:00Z')

    // Redo
    const result = executeRedo(1)

    expect(result).not.toBeNull()
    expect(result!.redone_action).toBe('done')

    // Verify task is back to done state
    expect(getTask(db, taskId).due_at).toBe('2026-02-01T14:00:00Z')
  })
})

describe('UR-007: New Action Clears Redo Stack', () => {
  let db: ReturnType<typeof getDb>

  beforeEach(async () => {
    db = await setupTestDb()
  })

  afterEach(() => {
    resetDb()
  })

  test('after undoing, performing a new action clears redo', () => {
    const taskId = createTestTask(db)

    const beforeTask = getTask(db, taskId)

    // Action 1: Mark done
    db.prepare('UPDATE tasks SET due_at = ? WHERE id = ?').run('2026-02-01T14:00:00Z', taskId)
    const afterTask = getTask(db, taskId)
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
    const taskBeforeSnooze = getTask(db, taskId)
    db.prepare('UPDATE tasks SET due_at = ?, original_due_at = ? WHERE id = ?').run(
      '2026-01-31T20:00:00Z',
      '2026-01-31T14:00:00Z',
      taskId,
    )
    const taskAfterSnooze = getTask(db, taskId)
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
  let db: ReturnType<typeof getDb>

  beforeEach(async () => {
    db = await setupTestDb()

    // Create second user
    const passwordHash = await bcrypt.hash('test2', 10)
    db.prepare(
      `INSERT INTO users (email, name, password_hash, timezone)
       VALUES ('test2@example.com', 'Test User 2', ?, 'America/Chicago')`,
    ).run(passwordHash)

    // Create project for user 2
    db.prepare(
      `INSERT INTO projects (name, owner_id, shared, sort_order)
       VALUES ('Test Project 2', 2, 0, 0)`,
    ).run()
  })

  afterEach(() => {
    resetDb()
  })

  test('user A undo history is independent of user B', () => {
    // Create task for user 1
    const task1Id = createTestTask(db, { user_id: 1, project_id: 1 })

    // Create task for user 2
    const task2Id = createTestTask(db, { user_id: 2, project_id: 2 })

    // User 1 marks their task done
    const before1 = getTask(db, task1Id)
    db.prepare('UPDATE tasks SET due_at = ? WHERE id = ?').run('2026-02-01T14:00:00Z', task1Id)
    const after1 = getTask(db, task1Id)
    logAction(
      1,
      'done',
      'User 1 action',
      ['due_at', 'original_due_at'],
      [createTaskSnapshot(before1, after1, ['due_at', 'original_due_at'])],
    )

    // User 2 marks their task done
    const before2 = getTask(db, task2Id)
    db.prepare('UPDATE tasks SET due_at = ? WHERE id = ?').run('2026-02-02T14:00:00Z', task2Id)
    const after2 = getTask(db, task2Id)
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
    expect(getTask(db, task1Id).due_at).toBe('2026-01-31T14:00:00Z') // Restored
    expect(getTask(db, task2Id).due_at).toBe('2026-02-02T14:00:00Z') // Unchanged

    // User 2's undo only affects their task
    executeUndo(2)
    expect(getTask(db, task2Id).due_at).toBe('2026-01-31T14:00:00Z') // Restored
  })
})

describe('UR-009: Undo Task Creation (soft delete)', () => {
  let db: ReturnType<typeof getDb>

  beforeEach(async () => {
    db = await setupTestDb()
  })

  afterEach(() => {
    resetDb()
  })

  test('undoing a task creation soft-deletes the task', () => {
    // Create a task and log the create action
    const taskId = createTestTask(db, { rrule: null, title: 'New Task' })
    const task = getTask(db, taskId)

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
    expect(getTask(db, taskId).title).toBe('New Task')
    const beforeUndo = db.prepare('SELECT deleted_at FROM tasks WHERE id = ?').get(taskId) as {
      deleted_at: string | null
    }
    expect(beforeUndo.deleted_at).toBeNull()

    // Undo the creation
    const result = executeUndo(1)
    expect(result).not.toBeNull()
    expect(result!.undone_action).toBe('create')

    // Verify the task was soft-deleted, not permanently removed
    const afterUndo = db.prepare('SELECT deleted_at FROM tasks WHERE id = ?').get(taskId) as {
      deleted_at: string | null
    }
    expect(afterUndo).not.toBeUndefined()
    expect(afterUndo.deleted_at).not.toBeNull()
  })
})
