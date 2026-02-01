/**
 * Task deletion (soft delete to trash)
 */

import { getDb, withTransaction } from '@/core/db'
import type { Task } from '@/types'
import { nowUtc } from '@/core/recurrence'
import { logAction, createTaskSnapshot } from '@/core/undo'
import { getTaskById } from './create'
import { canUserAccessTask } from './update'

export interface DeleteTaskOptions {
  userId: number
  taskId: number
}

export interface RestoreTaskOptions {
  userId: number
  taskId: number
}

/**
 * Soft delete a task (move to trash)
 */
export function deleteTask(options: DeleteTaskOptions): Task {
  const { userId, taskId } = options

  // Get current task state
  const task = getTaskById(taskId)
  if (!task) {
    throw new Error('Task not found')
  }

  // Verify user has access
  if (!canUserAccessTask(userId, task)) {
    throw new Error('Access denied')
  }

  // Cannot delete already trashed task
  if (task.deleted_at) {
    throw new Error('Task is already in trash')
  }

  const now = nowUtc()

  // Execute delete and undo log in a transaction
  return withTransaction((db) => {
    // Soft delete
    db.prepare('UPDATE tasks SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, taskId)

    // Log to undo
    const snapshot = createTaskSnapshot(
      { id: taskId, deleted_at: null },
      { id: taskId, deleted_at: now },
      ['deleted_at']
    )
    logAction(userId, 'delete', `Deleted "${task.title}"`, ['deleted_at'], [snapshot])

    // Return updated task
    const deletedTask = getTaskById(taskId)
    if (!deletedTask) {
      throw new Error('Failed to retrieve deleted task')
    }

    return deletedTask
  })
}

/**
 * Restore a task from trash
 */
export function restoreTask(options: RestoreTaskOptions): Task {
  const { userId, taskId } = options

  // Get current task state
  const task = getTaskById(taskId)
  if (!task) {
    throw new Error('Task not found')
  }

  // Verify user has access
  if (!canUserAccessTask(userId, task)) {
    throw new Error('Access denied')
  }

  // Cannot restore non-trashed task
  if (!task.deleted_at) {
    throw new Error('Task is not in trash')
  }

  const now = nowUtc()

  // Execute restore and undo log in a transaction
  return withTransaction((db) => {
    // Restore from trash
    db.prepare('UPDATE tasks SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(now, taskId)

    // Log to undo
    const snapshot = createTaskSnapshot(
      { id: taskId, deleted_at: task.deleted_at },
      { id: taskId, deleted_at: null },
      ['deleted_at']
    )
    logAction(userId, 'restore', `Restored "${task.title}"`, ['deleted_at'], [snapshot])

    // Return updated task
    const restoredTask = getTaskById(taskId)
    if (!restoredTask) {
      throw new Error('Failed to retrieve restored task')
    }

    return restoredTask
  })
}

/**
 * Permanently delete a task (from trash)
 * This is irreversible!
 */
export function permanentlyDeleteTask(options: DeleteTaskOptions): void {
  const { userId, taskId } = options

  // Get current task state
  const task = getTaskById(taskId)
  if (!task) {
    throw new Error('Task not found')
  }

  // Verify user has access
  if (!canUserAccessTask(userId, task)) {
    throw new Error('Access denied')
  }

  // Can only permanently delete trashed tasks
  if (!task.deleted_at) {
    throw new Error('Can only permanently delete trashed tasks')
  }

  // Execute all deletes in a transaction
  withTransaction((tx) => {
    // Delete completions for this task
    tx.prepare('DELETE FROM completions WHERE task_id = ?').run(taskId)

    // Delete notes for this task
    tx.prepare('DELETE FROM notes WHERE task_id = ?').run(taskId)

    // Permanently delete the task
    tx.prepare('DELETE FROM tasks WHERE id = ?').run(taskId)
  })

  // No undo for permanent delete
}

/**
 * Empty trash for a user (permanently delete all trashed tasks)
 */
export function emptyTrash(userId: number): number {
  const db = getDb()

  // Get all trashed tasks for this user
  const trashedTasks = db
    .prepare(
      `
    SELECT tasks.id
    FROM tasks
    INNER JOIN projects ON tasks.project_id = projects.id
    WHERE tasks.deleted_at IS NOT NULL
      AND (tasks.user_id = ? OR projects.shared = 1)
  `
    )
    .all(userId) as { id: number }[]

  if (trashedTasks.length === 0) {
    return 0
  }

  // Delete all tasks and their related records in a transaction
  withTransaction((tx) => {
    for (const task of trashedTasks) {
      tx.prepare('DELETE FROM completions WHERE task_id = ?').run(task.id)
      tx.prepare('DELETE FROM notes WHERE task_id = ?').run(task.id)
      tx.prepare('DELETE FROM tasks WHERE id = ?').run(task.id)
    }
  })

  return trashedTasks.length
}
