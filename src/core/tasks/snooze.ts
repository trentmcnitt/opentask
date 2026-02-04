/**
 * Snooze operation
 *
 * Thin wrapper around updateTask that applies snooze-specific validation.
 * The actual snooze logic (original_due_at tracking, snooze_count increment)
 * is handled by updateTask when due_at changes without rrule change.
 */

import { withTransaction } from '@/core/db'
import type { Task } from '@/types'
import { nowUtc } from '@/core/recurrence'
import { logAction, createTaskSnapshot } from '@/core/undo'
import { getTaskById } from './create'
import { canUserAccessTask, updateTask } from './update'

export interface SnoozeTaskOptions {
  userId: number
  userTimezone: string
  taskId: number
  until: string // ISO 8601 datetime
}

export interface SnoozeResult {
  task: Task
  previousDueAt: string | null
  originalDueAt: string | null
}

/**
 * Snooze a task to a future time
 *
 * This is a thin wrapper around updateTask that:
 * 1. Validates snooze-specific preconditions (not done, not trashed)
 * 2. Delegates to updateTask which handles snooze logic internally
 */
export function snoozeTask(options: SnoozeTaskOptions): SnoozeResult {
  const { userId, userTimezone, taskId, until } = options

  // Pre-validation (snooze-specific checks)
  const task = getTaskById(taskId)
  if (!task) {
    throw new Error('Task not found')
  }

  if (!canUserAccessTask(userId, task)) {
    throw new Error('Access denied')
  }

  // Validate snooze target is a valid datetime
  const snoozeTarget = new Date(until)
  if (isNaN(snoozeTarget.getTime())) {
    throw new Error('Invalid snooze target datetime')
  }
  // Note: We allow snoozing to past times - the task will just appear overdue immediately.
  // This lets users adjust due dates freely using the increment/decrement controls.

  // Only active tasks can be snoozed (SN-005)
  if (task.done) {
    throw new Error('Cannot snooze done task')
  }
  if (task.deleted_at) {
    throw new Error('Cannot snooze trashed task')
  }

  const previousDueAt = task.due_at

  // Delegate to updateTask - it handles snooze logic internally
  const { task: updatedTask } = updateTask({
    userId,
    userTimezone,
    taskId,
    input: { due_at: until },
  })

  return {
    task: updatedTask,
    previousDueAt,
    originalDueAt: updatedTask.original_due_at,
  }
}

/**
 * Clear snooze from a task (restore original due_at)
 */
export function clearSnooze(options: { userId: number; taskId: number }): Task {
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

  // Must be snoozed
  if (!task.original_due_at) {
    throw new Error('Task is not snoozed')
  }

  const nowStr = nowUtc()
  const originalDueAt = task.original_due_at

  // Execute update and undo log in a transaction
  return withTransaction((tx) => {
    // Restore original due_at, clear original_due_at
    tx.prepare(
      `
      UPDATE tasks
      SET due_at = ?, original_due_at = NULL, updated_at = ?
      WHERE id = ?
    `,
    ).run(originalDueAt, nowStr, taskId)

    // Log to undo (this is like a reverse snooze)
    const snapshot = createTaskSnapshot(
      { id: taskId, due_at: task.due_at, original_due_at: task.original_due_at },
      { id: taskId, due_at: originalDueAt, original_due_at: null },
      ['due_at', 'original_due_at'],
    )
    logAction(
      userId,
      'snooze',
      `Cleared snooze on "${task.title}"`,
      ['due_at', 'original_due_at'],
      [snapshot],
    )

    // Return updated task
    const updatedTask = getTaskById(taskId)
    if (!updatedTask) {
      throw new Error('Failed to retrieve updated task')
    }

    return updatedTask
  })
}
