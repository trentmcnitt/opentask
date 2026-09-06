/**
 * Mark done operation
 *
 * Handles both recurring (advance in place) and one-off (archive) tasks.
 */

import { getDb, withTransaction } from '@/core/db'
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
 * Mark a task as undone (reopen / put back).
 *
 * One-off: clears done. Recurring: puts back the latest completion — the
 * occurrence returns to the due date it had, and the counts roll back one.
 * Both are logged as an `undone` action, so this is itself undoable.
 *
 * The recurring case exists for the Reminders surface (2026-09-05): a
 * "considered" thought is a completion, and an accidental tap needs a direct
 * way back that does not depend on the undo stack's order.
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

  if (isRecurring(task.rrule)) {
    return putBackLatestOccurrence(task, userId)
  }

  // Must be done
  if (!task.done) {
    throw new ValidationError('Task is not done')
  }

  const nowStr = nowUtc()

  // Compute restored completion stats
  const restoredCount = Math.max(0, task.completion_count - 1)
  const restoredFirstCompleted = restoredCount === 0 ? null : task.first_completed_at
  const restoredLastCompleted = restoredCount === 0 ? null : task.last_completed_at

  const fieldsChanged = [
    'done',
    'done_at',
    'archived_at',
    'completion_count',
    'first_completed_at',
    'last_completed_at',
  ]

  // Execute update and undo log in a transaction
  const updatedTask = withTransaction((tx) => {
    // Update task: clear done, done_at, archived_at, restore completion stats
    tx.prepare(
      `
      UPDATE tasks
      SET done = 0, done_at = NULL, archived_at = NULL,
          completion_count = ?, first_completed_at = ?, last_completed_at = ?,
          updated_at = ?
      WHERE id = ?
    `,
    ).run(restoredCount, restoredFirstCompleted, restoredLastCompleted, nowStr, taskId)

    // Delete the completion record created when the task was marked done
    tx.prepare(
      `DELETE FROM completions WHERE id = (
        SELECT id FROM completions WHERE task_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1
      )`,
    ).run(taskId, userId)

    const snapshot = createTaskSnapshot(
      {
        id: taskId,
        title: task.title,
        done: true,
        done_at: task.done_at,
        archived_at: task.archived_at,
        completion_count: task.completion_count,
        first_completed_at: task.first_completed_at,
        last_completed_at: task.last_completed_at,
      },
      {
        id: taskId,
        title: task.title,
        done: false,
        done_at: null,
        archived_at: null,
        completion_count: restoredCount,
        first_completed_at: restoredFirstCompleted,
        last_completed_at: restoredLastCompleted,
      },
      fieldsChanged,
    )
    logAction(userId, 'undone', `Reopened "${task.title}"`, fieldsChanged, [snapshot])

    logActivity({
      userId,
      taskId,
      action: 'uncomplete',
      fields: fieldsChanged,
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

interface CompletionRow {
  id: number
  completed_at: string
  due_at_was: string | null
  due_at_next: string | null
}

/**
 * Reverse a recurring task's most recent completion.
 *
 * The completion row remembers the due date it advanced from (`due_at_was`)
 * and to (`due_at_next`), which is all a clean reversal needs. It refuses if
 * the task's due date no longer matches `due_at_next` — a snooze or edit since
 * the completion would otherwise be overwritten — and if there is no
 * completion to put back.
 */
function putBackLatestOccurrence(task: Task, userId: number): Task {
  const db = getDb()
  const latest = db
    .prepare(
      `SELECT id, completed_at, due_at_was, due_at_next FROM completions
        WHERE task_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(task.id, userId) as CompletionRow | undefined
  if (!latest) {
    throw new ValidationError('Nothing to put back')
  }
  if (task.due_at !== latest.due_at_next) {
    throw new ValidationError('Task changed since it was completed')
  }
  const previous = db
    .prepare(
      `SELECT completed_at FROM completions
        WHERE task_id = ? AND user_id = ? AND id < ? ORDER BY id DESC LIMIT 1`,
    )
    .get(task.id, userId, latest.id) as { completed_at: string } | undefined

  const nowStr = nowUtc()
  const restoredCount = Math.max(0, task.completion_count - 1)
  const restoredFirstCompleted = restoredCount === 0 ? null : task.first_completed_at
  const restoredLastCompleted = previous?.completed_at ?? null
  const fieldsChanged = [
    'due_at',
    'original_due_at',
    'completion_count',
    'first_completed_at',
    'last_completed_at',
  ]

  const updatedTask = withTransaction((tx) => {
    tx.prepare(
      `UPDATE tasks
        SET due_at = ?, original_due_at = ?,
            completion_count = ?, first_completed_at = ?, last_completed_at = ?,
            updated_at = ?
        WHERE id = ?`,
    ).run(
      latest.due_at_was,
      latest.due_at_was,
      restoredCount,
      restoredFirstCompleted,
      restoredLastCompleted,
      nowStr,
      task.id,
    )
    tx.prepare('DELETE FROM completions WHERE id = ?').run(latest.id)

    // The snapshot carries the deleted completion row (as a `done` action's
    // carries the created one), so undoing this put-back re-inserts it with
    // the same id and a redo deletes it again — see execute-undo / execute-redo.
    const snapshot = createTaskSnapshot(
      {
        id: task.id,
        title: task.title,
        due_at: task.due_at,
        original_due_at: task.original_due_at,
        completion_count: task.completion_count,
        first_completed_at: task.first_completed_at,
        last_completed_at: task.last_completed_at,
      },
      {
        id: task.id,
        title: task.title,
        due_at: latest.due_at_was,
        original_due_at: latest.due_at_was,
        completion_count: restoredCount,
        first_completed_at: restoredFirstCompleted,
        last_completed_at: restoredLastCompleted,
      },
      fieldsChanged,
      latest.id,
    )
    snapshot.before_state = {
      ...snapshot.before_state,
      _completion: {
        user_id: userId,
        completed_at: latest.completed_at,
        due_at_was: latest.due_at_was,
        due_at_next: latest.due_at_next,
      },
    } as typeof snapshot.before_state
    logAction(userId, 'undone', `Put back "${task.title}"`, fieldsChanged, [snapshot])
    logActivity({
      userId,
      taskId: task.id,
      action: 'uncomplete',
      fields: fieldsChanged,
      before: snapshot.before_state,
      after: snapshot.after_state,
      metadata: { recurring: true },
    })

    const result = getTaskById(task.id)
    if (!result) {
      throw new Error('Failed to retrieve updated task')
    }
    return result
  })

  emitSyncEvent(userId)
  return updatedTask
}
