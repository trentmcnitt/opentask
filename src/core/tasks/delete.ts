/**
 * Task deletion (soft delete to trash)
 */

import { getDb, withTransaction } from '@/core/db'
import type { Task } from '@/types'
import { nowUtc } from '@/core/recurrence'
import { logAction, createTaskSnapshot } from '@/core/undo'
import { logActivity } from '@/core/activity'
import { NotFoundError, ForbiddenError, ValidationError } from '@/core/errors'
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
    throw new NotFoundError('Task not found')
  }

  // Verify user has access
  if (!canUserAccessTask(userId, task)) {
    throw new ForbiddenError('Access denied')
  }

  // Cannot delete already trashed task
  if (task.deleted_at) {
    throw new ValidationError('Task is already in trash')
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
      ['deleted_at'],
    )
    logAction(userId, 'delete', `Deleted "${task.title}"`, ['deleted_at'], [snapshot])

    logActivity({
      userId,
      taskId,
      action: 'delete',
      fields: ['deleted_at'],
      before: snapshot.before_state,
      after: snapshot.after_state,
    })

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
    throw new NotFoundError('Task not found')
  }

  // Verify user has access
  if (!canUserAccessTask(userId, task)) {
    throw new ForbiddenError('Access denied')
  }

  // Cannot restore non-trashed task
  if (!task.deleted_at) {
    throw new ValidationError('Task is not in trash')
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
      ['deleted_at'],
    )
    logAction(userId, 'restore', `Restored "${task.title}"`, ['deleted_at'], [snapshot])

    logActivity({
      userId,
      taskId,
      action: 'restore',
      fields: ['deleted_at'],
      before: snapshot.before_state,
      after: snapshot.after_state,
    })

    // Return updated task
    const restoredTask = getTaskById(taskId)
    if (!restoredTask) {
      throw new Error('Failed to retrieve restored task')
    }

    return restoredTask
  })
}

/**
 * Empty trash for a user (permanently delete all trashed tasks)
 */
export function emptyTrash(userId: number): number {
  const db = getDb()

  // Get all trashed tasks owned by this user
  const trashedTasks = db
    .prepare(
      `
    SELECT tasks.id
    FROM tasks
    WHERE tasks.deleted_at IS NOT NULL
      AND tasks.user_id = ?
  `,
    )
    .all(userId) as { id: number }[]

  if (trashedTasks.length === 0) {
    return 0
  }

  // Batch delete all tasks and their related records in a transaction
  const ids = trashedTasks.map((t) => t.id)
  const placeholders = ids.map(() => '?').join(',')
  withTransaction((tx) => {
    tx.prepare(`DELETE FROM ai_insights_results WHERE task_id IN (${placeholders})`).run(...ids)
    tx.prepare(`DELETE FROM completions WHERE task_id IN (${placeholders})`).run(...ids)
    tx.prepare(`DELETE FROM tasks WHERE id IN (${placeholders})`).run(...ids)
    // Note: undo_log entries referencing these task IDs are intentionally NOT cleaned up.
    // Task IDs are embedded in the JSON `snapshot` column (not a direct column), so there's
    // no simple DELETE WHERE task_id IN (...). This is harmless: executeUndo() handles missing
    // tasks gracefully (the UPDATE is a no-op on non-existent rows), and orphaned entries are
    // just stale data that don't affect correctness.
  })

  return trashedTasks.length
}
