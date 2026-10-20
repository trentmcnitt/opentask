/**
 * Mark done operation
 *
 * Handles both recurring (advance in place) and one-off (archive) tasks.
 */

import { attemptsRolloverTime } from './rollover-time'
import { advanceDeadline, putBackCountedThrough } from '@/lib/task-segments'
import { getDb, withTransaction } from '@/core/db'
import type { Task } from '@/types'
import { nowUtc, isRecurring } from '@/core/recurrence'
import { logAction, createTaskSnapshot } from '@/core/undo'
import { logActivity } from '@/core/activity'
import { emitSyncEvent } from '@/lib/sync-events'
import { dispatchWebhookEvent } from '@/core/webhooks/dispatch'
import { dismissNotificationsForTasks } from '@/core/notifications/dismiss'
import { formatTaskResponse } from '@/lib/format-task'
import { incrementDailyStat } from '@/core/stats'
import { ValidationError } from '@/core/errors'
import { getTaskById } from './read'
import { loadTaskForMutation } from './access'
import { computeMarkDone, executeMarkDone } from './helpers'
import { isTracked } from '@/lib/track'
import { QUOTA_DONE_MESSAGE } from '@/core/validation'
import { QUEUE_CLEAR_SQL, TARGET_SET_FIELD, queueStateToClear } from './target-set'
import { DECK_CLEAR_SQL } from './deck-clear'

export interface MarkDoneOptions {
  userId: number
  userTimezone: string
  taskId: number
  /**
   * §5: required to complete a quota. Completing one closes its period early
   * and resets its count to 0 — see the refusal in `markDone`.
   */
  closePeriod?: boolean
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
  const { userId, userTimezone, taskId, closePeriod = false } = options

  const task = loadTaskForMutation(userId, taskId, {
    trashed: { reject: 'Cannot mark trashed task done' },
  })

  // §5: `done` on a quota closes its period early and resets the count to 0
  // (`computeMarkDone`'s period reset) — silently losing whatever was logged
  // this period. Nothing in the app sends a quota here (its surfaces only log
  // progress; see progress.ts), so an API caller doing it almost certainly
  // meant +1. Refuse with the way out, unless the caller opts in explicitly.
  if (isTracked(task) && !closePeriod) {
    throw new ValidationError(QUOTA_DONE_MESSAGE)
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
  // The task is handled, so its banner goes on every device (and the badge follows).
  dismissNotificationsForTasks(userId, [taskId])
  dispatchWebhookEvent(userId, 'task.completed', {
    task: formatTaskResponse(result.task, userTimezone),
  })
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

  // 'allow': putting back a completion has never checked the trash.
  const task = loadTaskForMutation(userId, taskId, { trashed: 'allow' })

  // §5: a quota's completions are written by the period rollover, not by a
  // done tap — a met period IS the completion (`period-rollover.ts`). Putting
  // one "back" deleted that rollover row and decremented `completion_count`
  // without touching the period it recorded, so history lost a met week while
  // the count, anchor and `progress_periods` all still said it happened. It was
  // reachable from the widgets' "show completed" DONE list, which lists quota
  // completions and offers /undone on every row. Nothing can reopen a closed
  // period, so refuse: progress is corrected with a −1, not by un-completing.
  if (isTracked(task)) {
    throw new ValidationError(
      'This is a quota — its completions record closed periods and cannot be put back. Correct the count with POST /api/tasks/{id}/progress (delta: -1)',
    )
  }

  if (isRecurring(task.rrule)) {
    return putBackLatestOccurrence(task, userId, options.userTimezone)
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
    'attempts',
    'attempts_counted_through',
  ]

  // §7: the attempts come back from the completion row it deletes (done
  // reset them), checkpointed so the days it sat done don't count.
  const completion = getDb()
    .prepare(
      `SELECT completed_at, due_at_was, attempts FROM completions
        WHERE task_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(taskId, userId) as
    | { completed_at: string; due_at_was: string | null; attempts: number | null }
    | undefined
  const restoredAttempts = completion?.attempts ?? 0
  const restoredThrough = completion
    ? putBackCountedThrough(
        completion.completed_at,
        completion.due_at_was,
        options.userTimezone,
        new Date(),
        attemptsRolloverTime(task.user_id),
      )
    : null

  // Execute update and undo log in a transaction
  const updatedTask = withTransaction((tx) => {
    // Update task: clear done, done_at, archived_at, restore completion stats
    tx.prepare(
      `
      UPDATE tasks
      SET done = 0, done_at = NULL, archived_at = NULL,
          completion_count = ?, first_completed_at = ?, last_completed_at = ?,
          attempts = ?, attempts_counted_through = ?,
          updated_at = ?
      WHERE id = ?
    `,
    ).run(
      restoredCount,
      restoredFirstCompleted,
      restoredLastCompleted,
      restoredAttempts,
      restoredThrough,
      nowStr,
      taskId,
    )

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
        attempts: task.attempts,
        attempts_counted_through: task.attempts_counted_through,
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
        attempts: restoredAttempts,
        attempts_counted_through: restoredThrough,
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
  occurrence_at_was: string | null
  attempts: number | null
}

/**
 * Reverse a recurring task's most recent completion.
 *
 * The completion row remembers the due date it advanced from (`due_at_was`)
 * and to (`due_at_next`), and the occurrence it closed (`occurrence_at_was`,
 * §6), which is all a clean reversal needs. It refuses if the task's
 * schedule has moved since — its occurrence is no longer the one the
 * completion advanced to — and if there is no completion to put back. A move
 * of the target alone since the completion does not refuse it (the target is
 * not the schedule); the put-back restores the old target either way.
 */
function putBackLatestOccurrence(task: Task, userId: number, userTimezone: string): Task {
  const db = getDb()
  const latest = db
    .prepare(
      `SELECT id, completed_at, due_at_was, due_at_next, occurrence_at_was, attempts FROM completions
        WHERE task_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(task.id, userId) as CompletionRow | undefined
  if (!latest) {
    throw new ValidationError('Nothing to put back')
  }
  // `due_at_next` is the target the completion set: the occurrence itself,
  // or — rarely — the occurrence capped at its deadline (then the target is
  // still there unless moved).
  if (task.occurrence_at !== latest.due_at_next && task.due_at !== latest.due_at_next) {
    throw new ValidationError('Task changed since it was completed')
  }
  // The occurrence it closed; a row from before the column reads the target.
  const restoredOccurrence = latest.occurrence_at_was ?? latest.due_at_was
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
  // The deadline goes back with the occurrence, by the same offset it moved.
  const restoredDeadline = advanceDeadline(task, restoredOccurrence, userTimezone)
  // §7: the occurrence's attempts come back from its completion row.
  const restoredAttempts = latest.attempts ?? 0
  const restoredThrough = putBackCountedThrough(
    latest.completed_at,
    latest.due_at_was,
    userTimezone,
    new Date(),
    attemptsRolloverTime(task.user_id),
  )
  const queueClear = queueStateToClear(task)
  const fieldsChanged = [
    'due_at',
    'occurrence_at',
    'original_due_at',
    'deadline_at',
    'completion_count',
    'first_completed_at',
    'last_completed_at',
    // Upcoming (2026-10-12): the put-back sets the target again (normally an
    // occurrence already arrived, so over target, never Upcoming).
    TARGET_SET_FIELD,
    'attempts',
    'attempts_counted_through',
    // The task queue (2026-10-19): setting the target again clears the queue
    // state (normally already clear: done cleared it).
    ...queueClear.fields,
  ]

  const updatedTask = withTransaction((tx) => {
    tx.prepare(
      `UPDATE tasks
        SET due_at = ?, occurrence_at = ?, original_due_at = ?, deadline_at = ?,
            ${TARGET_SET_FIELD} = ?, attempts = ?, attempts_counted_through = ?,
            completion_count = ?, first_completed_at = ?, last_completed_at = ?,
            ${QUEUE_CLEAR_SQL}, ${DECK_CLEAR_SQL}, updated_at = ?
        WHERE id = ?`,
    ).run(
      latest.due_at_was,
      restoredOccurrence,
      latest.due_at_was,
      restoredDeadline,
      nowStr,
      restoredAttempts,
      restoredThrough,
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
        ...queueClear.before,
        id: task.id,
        title: task.title,
        due_at: task.due_at,
        occurrence_at: task.occurrence_at,
        original_due_at: task.original_due_at,
        deadline_at: task.deadline_at,
        target_set_at: task.target_set_at,
        attempts: task.attempts,
        attempts_counted_through: task.attempts_counted_through,
        completion_count: task.completion_count,
        first_completed_at: task.first_completed_at,
        last_completed_at: task.last_completed_at,
      },
      {
        ...queueClear.after,
        id: task.id,
        title: task.title,
        due_at: latest.due_at_was,
        occurrence_at: restoredOccurrence,
        original_due_at: latest.due_at_was,
        deadline_at: restoredDeadline,
        target_set_at: nowStr,
        attempts: restoredAttempts,
        attempts_counted_through: restoredThrough,
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
        occurrence_at_was: latest.occurrence_at_was,
        attempts: latest.attempts,
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
