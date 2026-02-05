/**
 * Mark done operation
 *
 * Handles both recurring (advance in place) and one-off (archive) tasks.
 */

import { withTransaction } from '@/core/db'
import type { Task } from '@/types'
import { nowUtc, isRecurring } from '@/core/recurrence'
import { logAction, createTaskSnapshot } from '@/core/undo'
import { incrementDailyStat } from '@/core/stats'
import { getTaskById } from './create'
import { canUserAccessTask } from './update'
import { computeMarkDone, executeMarkDone } from './helpers'

export interface MarkDoneOptions {
  userId: number
  userTimezone: string
  taskId: number
}

export interface MarkDoneResult {
  task: Task
  wasRecurring: boolean
  nextDueAt?: string | null
}

/**
 * Mark a task as done
 *
 * For recurring tasks: advances due_at to next occurrence, clears original_due_at
 * For one-off tasks: sets done=1, archived_at=now
 */
export function markDone(options: MarkDoneOptions): MarkDoneResult {
  const { userId, userTimezone, taskId } = options

  // Get current task state
  const task = getTaskById(taskId)
  if (!task) {
    throw new Error('Task not found')
  }

  // Verify user has access
  if (!canUserAccessTask(userId, task)) {
    throw new Error('Access denied')
  }

  // Cannot mark trashed task done
  if (task.deleted_at) {
    throw new Error('Cannot mark trashed task done')
  }

  // Cannot mark already done one-off task done again
  if (task.done && !isRecurring(task.rrule)) {
    throw new Error('Task is already done')
  }

  const completedAt = new Date()
  const nowStr = nowUtc()

  // Compute state changes
  const computation = computeMarkDone(task, userTimezone, completedAt, nowStr)

  return withTransaction((tx) => {
    // Execute database operations
    const { snapshot } = executeMarkDone(tx, task, computation, userId, nowStr)

    // Log to undo
    logAction(userId, 'done', `Marked "${task.title}" done`, computation.fieldsChanged, [snapshot])

    // Increment daily stats
    incrementDailyStat(userId, 'completions', userTimezone)

    // Return updated task
    const updatedTask = getTaskById(task.id)
    if (!updatedTask) {
      throw new Error('Failed to retrieve updated task')
    }

    if (computation.type === 'recurring') {
      return {
        task: updatedTask,
        wasRecurring: true,
        nextDueAt: computation.nextDueAt,
      }
    } else {
      return {
        task: updatedTask,
        wasRecurring: false,
      }
    }
  })
}

/**
 * Mark a one-off task as undone (reopen)
 *
 * Only works for one-off tasks that are done.
 * For recurring tasks, use undo instead.
 */
export function markUndone(options: MarkDoneOptions): Task {
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

  // Cannot undone a recurring task (use undo instead)
  if (isRecurring(task.rrule)) {
    throw new Error('Cannot mark recurring task undone - use undo instead')
  }

  // Must be done
  if (!task.done) {
    throw new Error('Task is not done')
  }

  const nowStr = nowUtc()

  // Execute update and undo log in a transaction
  return withTransaction((tx) => {
    // Update task: clear done, done_at, archived_at
    tx.prepare(
      `
      UPDATE tasks
      SET done = 0, done_at = NULL, archived_at = NULL, updated_at = ?
      WHERE id = ?
    `,
    ).run(nowStr, taskId)

    // Log to undo
    const snapshot = createTaskSnapshot(
      { id: taskId, done: true, done_at: task.done_at, archived_at: task.archived_at },
      { id: taskId, done: false, done_at: null, archived_at: null },
      ['done', 'done_at', 'archived_at'],
    )
    logAction(
      userId,
      'undone',
      `Reopened "${task.title}"`,
      ['done', 'done_at', 'archived_at'],
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
