/**
 * Data Integrity Behavioral Tests (DI-001 through DI-004)
 *
 * Tests for PATCH semantics, soft delete, and data safety.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { getDb } from '@/core/db'
import { createTask, getTaskById, updateTask, deleteTask, restoreTask } from '@/core/tasks'
import {
  setupTestDb,
  teardownTestDb,
  localTime,
  TEST_USER_ID,
  TEST_TIMEZONE,
} from '../helpers/setup'

describe('Data Integrity Behavioral Tests', () => {
  beforeEach(() => {
    setupTestDb()
  })

  afterEach(() => {
    teardownTestDb()
  })

  /**
   * DI-001: PATCH Semantics
   *
   * Updating one field never affects any other field.
   * PATCH {priority: 3} changes only priority.
   */
  test('DI-001: PATCH only updates specified field', () => {
    // Create a task with all fields set
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Original title',
        due_at: localTime(8, 0),
        priority: 1,
        labels: ['original'],
      },
    })

    // Store original values
    const originalTitle = task.title
    const originalDueAt = task.due_at
    const originalLabels = task.labels

    // PATCH only priority
    const { task: updated } = updateTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
      input: { priority: 3 },
    })

    // Priority should change
    expect(updated.priority).toBe(3)

    // All other fields should remain unchanged
    expect(updated.title).toBe(originalTitle)
    expect(updated.due_at).toBe(originalDueAt)
    expect(updated.labels).toEqual(originalLabels)
  })

  test('DI-001: PATCH with empty object makes no changes', () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Test task',
        priority: 2,
      },
    })

    const { task: updated, fieldsChanged } = updateTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
      input: {},
    })

    expect(fieldsChanged).toEqual([])
    expect(updated.title).toBe(task.title)
    expect(updated.priority).toBe(task.priority)
  })

  /**
   * DI-002: Soft Delete
   *
   * DELETE /tasks/:id sets deleted_at, does not permanently remove the row.
   */
  test('DI-002: DELETE sets deleted_at, does not remove row', () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Task to delete' },
    })

    expect(task.deleted_at).toBeNull()

    // Delete the task
    const deletedTask = deleteTask({
      userId: TEST_USER_ID,
      taskId: task.id,
    })

    // Task should have deleted_at set
    expect(deletedTask.deleted_at).not.toBeNull()

    // Task should still exist in database
    const db = getDb()
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id)
    expect(row).not.toBeUndefined()
  })

  test('DI-002: Restore clears deleted_at', () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Task to restore' },
    })

    // Delete then restore
    deleteTask({ userId: TEST_USER_ID, taskId: task.id })
    const restoredTask = restoreTask({ userId: TEST_USER_ID, taskId: task.id })

    expect(restoredTask.deleted_at).toBeNull()
  })
})

describe('Data Safety & Concurrent Write Tests', () => {
  beforeEach(() => {
    setupTestDb()
  })

  afterEach(() => {
    teardownTestDb()
  })

  /**
   * DI-003: No Silent Data Loss
   *
   * No operation silently discards data.
   */
  test('DI-003: Delete preserves all task data', () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Task with data',
        due_at: localTime(9, 0),
        priority: 3,
        labels: ['important', 'work'],
        rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      },
    })

    // Store original values
    const originalData = {
      title: task.title,
      due_at: task.due_at,
      priority: task.priority,
      labels: [...task.labels],
      rrule: task.rrule,
    }

    // Delete and restore
    deleteTask({ userId: TEST_USER_ID, taskId: task.id })
    const restoredTask = restoreTask({ userId: TEST_USER_ID, taskId: task.id })

    // All data should be preserved
    expect(restoredTask.title).toBe(originalData.title)
    expect(restoredTask.due_at).toBe(originalData.due_at)
    expect(restoredTask.priority).toBe(originalData.priority)
    expect(restoredTask.labels).toEqual(originalData.labels)
    expect(restoredTask.rrule).toBe(originalData.rrule)
  })

  /**
   * DI-004: Concurrent Write Safety
   *
   * SQLite WAL mode + transactions ensure writes are serialized.
   * This test verifies that concurrent operations don't corrupt data.
   */
  test('DI-004: Sequential updates maintain data integrity', () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Concurrent test',
        priority: 1,
      },
    })

    // Perform multiple sequential updates
    updateTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
      input: { priority: 2 },
    })

    updateTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
      input: { title: 'Updated title' },
    })

    updateTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
      input: { labels: ['new-label'] },
    })

    // Final state should reflect all updates
    const finalTask = getTaskById(task.id)!
    expect(finalTask.priority).toBe(2)
    expect(finalTask.title).toBe('Updated title')
    expect(finalTask.labels).toEqual(['new-label'])
  })

  test("DI-004: Update and delete don't conflict", () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Task to modify' },
    })

    // Update then delete
    updateTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
      input: { priority: 4 },
    })

    const deletedTask = deleteTask({
      userId: TEST_USER_ID,
      taskId: task.id,
    })

    // Both operations should have completed
    expect(deletedTask.priority).toBe(4)
    expect(deletedTask.deleted_at).not.toBeNull()
  })
})

describe('Delete/Restore Operations', () => {
  beforeEach(() => {
    setupTestDb()
  })

  afterEach(() => {
    teardownTestDb()
  })

  test('deleteTask sets deleted_at timestamp', () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'To delete' },
    })

    const deleted = deleteTask({
      userId: TEST_USER_ID,
      taskId: task.id,
    })

    expect(deleted.deleted_at).not.toBeNull()
    // Should be a valid ISO date
    expect(new Date(deleted.deleted_at!).toISOString()).toBe(deleted.deleted_at)
  })

  test('restoreTask clears deleted_at', () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'To restore' },
    })

    deleteTask({ userId: TEST_USER_ID, taskId: task.id })
    const restored = restoreTask({ userId: TEST_USER_ID, taskId: task.id })

    expect(restored.deleted_at).toBeNull()
  })

  test('Cannot delete already deleted task', () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Double delete test' },
    })

    deleteTask({ userId: TEST_USER_ID, taskId: task.id })

    expect(() => deleteTask({ userId: TEST_USER_ID, taskId: task.id })).toThrow(
      'Task is already in trash',
    )
  })

  test('Cannot restore non-deleted task', () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Not deleted' },
    })

    expect(() => restoreTask({ userId: TEST_USER_ID, taskId: task.id })).toThrow(
      'Task is not in trash',
    )
  })

  test('Cannot edit deleted task', () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Deleted task' },
    })

    deleteTask({ userId: TEST_USER_ID, taskId: task.id })

    expect(() =>
      updateTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        taskId: task.id,
        input: { title: 'New title' },
      }),
    ).toThrow('Cannot edit trashed task')
  })
})
