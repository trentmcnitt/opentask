/**
 * Mark done operation
 *
 * Handles both recurring (advance in place) and one-off (archive) tasks.
 */

import { withTransaction } from '@/core/db'
import type { Task } from '@/types'
import { nowUtc, isRecurring } from '@/core/recurrence'
import { logAction, createTaskSnapshot } from '@/core/undo'
import { logActivity } from '@/core/activity'
import { emitSyncEvent } from '@/lib/sync-events'
import { dispatchWebhookEvent } from '@/core/webhooks/dispatch'
import { formatTaskResponse } from '@/lib/format-task'
import { incrementDailyStat } from '@/core/stats'
import { NotFoundError, ForbiddenError, ValidationError } from '@/core/errors'
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
    throw new NotFoundError('Task not found')
  }

  // Verify user has access
  if (!canUserAccessTask(userId, task)) {
    throw new ForbiddenError('Access denied')
  }

  // Cannot mark trashed task done
  if (task.deleted_at) {
    throw new ValidationError('Cannot mark trashed task done')
  }

  // Cannot mark already done one-off task done again
  if (task.done && !isRecurring(task.rrule)) {
    throw new ValidationError('Task is already done')
  }

  const completedAt = new Date()
  const nowStr = nowUtc()

  // Compute state changes
  const computation = computeMarkDone(task, userTimezone, completedAt, nowStr)

  const result = withTransaction((tx) => {
    // Execute database operations
    const { snapshot } = executeMarkDone(tx, task, computation, userId, nowStr)

    // Log to undo
    logAction(userId, 'done', `Marked "${task.title}" done`, computation.fieldsChanged, [snapshot])

    logActivity({
      userId,
      taskId: task.id,
      action: 'complete',
      fields: computation.fieldsChanged,
      before: snapshot.before_state,
      after: snapshot.after_state,
      metadata: {
        recurring: computation.type === 'recurring',
        ...(computation.type === 'recurring' ? { next_due_at: computation.nextDueAt } : {}),
      },
    })

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

  emitSyncEvent(userId)
  dispatchWebhookEvent(userId, 'task.completed', { task: formatTaskResponse(result.task) })
  return result
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
    throw new NotFoundError('Task not found')
  }

  // Verify user has access
  if (!canUserAccessTask(userId, task)) {
    throw new ForbiddenError('Access denied')
  }

  // Cannot undone a recurring task (use undo instead)
  if (isRecurring(task.rrule)) {
    throw new ValidationError('Cannot mark recurring task undone - use undo instead')
  }

  // Must be done
  if (!task.done) {
    throw new ValidationError('Task is not done')
  }

  const nowStr = nowUtc()

  // Execute update and undo log in a transaction
  const updatedTask = withTransaction((tx) => {
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

    logActivity({
      userId,
      taskId,
      action: 'uncomplete',
      fields: ['done', 'done_at', 'archived_at'],
      before: snapshot.before_state,
      after: snapshot.after_state,
    })

    // Return updated task
    const result = getTaskById(taskId)
    if (!result) {
      throw new Error('Failed to retrieve updated task')
    }

    return result
  })

  emitSyncEvent(userId)
  return updatedTask
}
