/**
 * Mark done operation
 *
 * Handles both recurring (advance in place) and one-off (archive) tasks.
 */

import {
  attemptsRolloverTime,
  dayBoundaryForUser,
  leadContextFor,
  rolloverTimeForUser,
} from './rollover-time'
import { autoTargetToLead } from './auto-target-lead'
import { rederiveOnReopen } from './relative-target'
import {
  occurrenceDates,
  putBackCountedThrough,
  seriesEndedBySkip,
  seriesEndWords,
} from '@/lib/task-segments'
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

/** A series ended by skipping its last occurrence (repeat ends, 2026-10-22). */
export const REPEAT_ENDED_MESSAGE = 'This repeat has ended'

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
  /** Repeat ends (2026-10-22): this completion closed the last occurrence. */
  seriesEnded: boolean
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

  // Cannot mark a done task done again — a one-off, or a repeat whose series
  // has ended (repeat ends, 2026-10-22: an ended series is done=1, and
  // advancing it would start it again).
  if (task.done) {
    throw new ValidationError('Task is already done')
  }
  // A series ended by skipping its last occurrence is archived, not done.
  if (seriesEndedBySkip(task)) {
    throw new ValidationError(REPEAT_ENDED_MESSAGE)
  }

  const completedAt = new Date()
  const nowStr = nowUtc()

  // Compute state changes
  const computation = computeMarkDone(
    task,
    userTimezone,
    completedAt,
    nowStr,
    dayBoundaryForUser(userId),
    () => rolloverTimeForUser(task.user_id),
  )

  const result = withTransaction((tx) => {
    // Execute database operations
    const { snapshot } = executeMarkDone(tx, task, computation, userId, nowStr)

    // Log to undo
    const ended = computation.type === 'series_end'
    const description = ended
      ? `Marked "${task.title}" done — ${seriesEndWords(task)}`
      : `Marked "${task.title}" done`
    logAction(userId, 'done', description, computation.fieldsChanged, [snapshot])

    logActivity({
      userId,
      taskId: task.id,
      action: 'complete',
      fields: computation.fieldsChanged,
      before: snapshot.before_state,
      after: snapshot.after_state,
      metadata: {
        recurring: computation.type !== 'one_off',
        ...(computation.type === 'recurring' ? { next_due_at: computation.nextDueAt } : {}),
        ...(ended ? { series_ended: true } : {}),
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
        seriesEnded: false,
      }
    } else if (ended) {
      // The series ended: no next occurrence.
      return { task: updatedTask, wasRecurring: true, nextDueAt: null, seriesEnded: true }
    } else {
      return {
        task: updatedTask,
        wasRecurring: false,
        seriesEnded: false,
      }
    }
  })

  emitSyncEvent(userId)
  // The task is handled, so its banner goes on every device (and the badge follows).
  dismissNotificationsForTasks(userId, [taskId])
  dispatchWebhookEvent(userId, 'task.completed', {
    task: formatTaskResponse(result.task, userTimezone),
    ...(result.seriesEnded ? { series_ended: true } : {}),
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

  // REPEAT ENDS (2026-10-22): an open repeat puts back its latest
  // completion; a DONE one is an ended series, reopened by the one-off branch
  // below on the occurrence it ended on (done kept its dates).
  const recurring = isRecurring(task.rrule)
  if (recurring && !task.done) {
    // A series ended by SKIPPING its last occurrence is archived, not done:
    // nothing to put back (undo reverses the skip).
    if (seriesEndedBySkip(task)) throw new ValidationError('Task is not done')
    return putBackLatestOccurrence(task, userId, options.userTimezone)
  }

  // Must be done
  if (!task.done) {
    throw new ValidationError('Task is not done')
  }

  const nowStr = nowUtc()

  // The completion this reopen deletes: the latest row, read in full so the
  // undo snapshot can carry it (`_completion` + `completion_id`) — undo then
  // re-inserts it with its id and redo deletes it by id, exactly as the
  // recurring put-back does. (Before 2026-10-22 this deleted "the latest row"
  // blind and carried nothing: undo lost the row, and the next reopen deleted
  // an EARLIER completion — harmless on a one-off's single row, not on an
  // ended series with one row per occurrence.)
  const completion = getDb()
    .prepare(
      `SELECT id, completed_at, due_at_was, due_at_next, occurrence_at_was, occurrence_at_next, attempts
         FROM completions WHERE task_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(taskId, userId) as CompletionRow | undefined
  const previous = completion
    ? (getDb()
        .prepare(
          `SELECT completed_at FROM completions
            WHERE task_id = ? AND user_id = ? AND id < ? ORDER BY id DESC LIMIT 1`,
        )
        .get(taskId, userId, completion.id) as { completed_at: string } | undefined)
    : undefined

  // Compute restored completion stats. `last_completed_at` comes from the
  // completion before the deleted one, as the recurring put-back does.
  const restoredCount = Math.max(0, task.completion_count - 1)
  const restoredFirstCompleted = restoredCount === 0 ? null : task.first_completed_at
  const restoredLastCompleted = restoredCount === 0 ? null : (previous?.completed_at ?? null)

  // An ended series reopens on its last occurrence, which it uses again.
  const restoredUsed = recurring ? Math.max(0, task.repeat_count_used - 1) : task.repeat_count_used
  const fieldsChanged = [
    'done',
    'done_at',
    'archived_at',
    'completion_count',
    'first_completed_at',
    'last_completed_at',
    'attempts',
    'attempts_counted_through',
    ...(recurring ? ['repeat_count_used'] : []),
  ]
  // A pre-migration automatic target reopened (the deadlines page, switch
  // on): converted in the same write (`autoTargetToLead`). A relative one-off
  // (2026-10-24) re-derives its target from its offsets in the same write
  // (`rederiveOnReopen`): a period retime while it was done moved only its
  // `target_time`. The two never meet (a relative target is never automatic).
  const conv = autoTargetToLead(task) ?? rederiveOnReopen(task)
  if (conv) fieldsChanged.push(...conv.fields)

  // §7: the attempts come back from the completion row it deletes (done
  // reset them), checkpointed so the days it sat done don't count.
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
          attempts = ?, attempts_counted_through = ?, repeat_count_used = ?,
          ${conv ? `${conv.sql},` : ''} updated_at = ?
      WHERE id = ?
    `,
    ).run(
      restoredCount,
      restoredFirstCompleted,
      restoredLastCompleted,
      restoredAttempts,
      restoredThrough,
      restoredUsed,
      ...(conv ? conv.values : []),
      nowStr,
      taskId,
    )

    // Delete the completion record created when the task was marked done
    if (completion) tx.prepare('DELETE FROM completions WHERE id = ?').run(completion.id)

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
        repeat_count_used: task.repeat_count_used,
        ...conv?.before,
      },
      {
        ...conv?.after,
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
        repeat_count_used: restoredUsed,
      },
      fieldsChanged,
      completion?.id,
    )
    if (completion) {
      snapshot.before_state = {
        ...snapshot.before_state,
        _completion: completionCopy(userId, completion),
      } as typeof snapshot.before_state
    }
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
  occurrence_at_next: string | null
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
      `SELECT id, completed_at, due_at_was, due_at_next, occurrence_at_was, occurrence_at_next, attempts
         FROM completions
        WHERE task_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(task.id, userId) as CompletionRow | undefined
  if (!latest) {
    throw new ValidationError('Nothing to put back')
  }
  // The schedule must still be on the occurrence the completion advanced to
  // (`occurrence_at_next`, 2026-10-21) — a move of the target since does not
  // matter. A row from before that column compares `due_at_next`, the target
  // it set (then the occurrence itself, or the occurrence capped at its
  // deadline: still the target unless moved).
  const changed =
    latest.occurrence_at_next !== null
      ? task.occurrence_at !== latest.occurrence_at_next
      : task.occurrence_at !== latest.due_at_next && task.due_at !== latest.due_at_next
  if (changed) {
    throw new ValidationError('Task changed since it was completed')
  }
  // The occurrence it closed; a row from before the column reads the target.
  const restoredOccurrence = latest.occurrence_at_was ?? latest.due_at_was
  // Its dates (`occurrenceDates`): the deadline it had, and its derived target.
  const restored = restoredOccurrence
    ? occurrenceDates(task, restoredOccurrence, userTimezone, leadContextFor(task))
    : null
  // The target it closed. A DECKED occurrence (2026-10-20) had none — its
  // `due_at_was` is NULL — so it comes back as debt on its occurrence's
  // target, never as a target-less repeating row (no deck to put back: done
  // cleared it).
  const restoredTarget = latest.due_at_was ?? restored?.targetAt ?? null
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
  // The deadline goes back with the occurrence (a deadline-anchored repeat's
  // occurrence IS its deadline; a target-anchored one has none).
  const restoredDeadline = restored ? restored.deadlineAt : task.deadline_at
  // The deadlines page (2026-10-22): the restored occurrence's lead day.
  const restoredLead = restored ? restored.leadFrom : task.lead_from
  // §7: the occurrence's attempts come back from its completion row.
  const restoredAttempts = latest.attempts ?? 0
  const restoredUsed = Math.max(0, task.repeat_count_used - 1)
  const restoredThrough = putBackCountedThrough(
    latest.completed_at,
    restoredTarget,
    userTimezone,
    new Date(),
    attemptsRolloverTime(task.user_id),
  )
  const queueClear = queueStateToClear(task)
  const fieldsChanged = [
    ...putBackFields(task, queueClear.fields),
    ...(restoredLead !== task.lead_from ? ['lead_from'] : []),
  ]

  const updatedTask = withTransaction((tx) => {
    tx.prepare(
      `UPDATE tasks
        SET due_at = ?, occurrence_at = ?, original_due_at = ?, deadline_at = ?, lead_from = ?,
            ${TARGET_SET_FIELD} = ?, attempts = ?, attempts_counted_through = ?,
            completion_count = ?, first_completed_at = ?, last_completed_at = ?,
            repeat_count_used = ?, ${QUEUE_CLEAR_SQL}, ${DECK_CLEAR_SQL}, updated_at = ?
        WHERE id = ?`,
    ).run(
      restoredTarget,
      restoredOccurrence,
      restoredTarget,
      restoredDeadline,
      restoredLead,
      nowStr,
      restoredAttempts,
      restoredThrough,
      restoredCount,
      restoredFirstCompleted,
      restoredLastCompleted,
      restoredUsed,
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
        lead_from: task.lead_from,
        target_set_at: task.target_set_at,
        attempts: task.attempts,
        attempts_counted_through: task.attempts_counted_through,
        completion_count: task.completion_count,
        first_completed_at: task.first_completed_at,
        last_completed_at: task.last_completed_at,
        repeat_count_used: task.repeat_count_used,
        on_deck_day: task.on_deck_day,
      },
      {
        ...queueClear.after,
        id: task.id,
        title: task.title,
        due_at: restoredTarget,
        occurrence_at: restoredOccurrence,
        original_due_at: restoredTarget,
        on_deck_day: null,
        deadline_at: restoredDeadline,
        lead_from: restoredLead,
        target_set_at: nowStr,
        attempts: restoredAttempts,
        attempts_counted_through: restoredThrough,
        completion_count: restoredCount,
        first_completed_at: restoredFirstCompleted,
        last_completed_at: restoredLastCompleted,
        repeat_count_used: restoredUsed,
      },
      fieldsChanged,
      latest.id,
    )
    snapshot.before_state = {
      ...snapshot.before_state,
      _completion: completionCopy(userId, latest),
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

/** What a put-back changes (`putBackLatestOccurrence`). */
function putBackFields(task: Task, queueFields: string[]): string[] {
  return [
    'due_at',
    'occurrence_at',
    'original_due_at',
    'deadline_at',
    'completion_count',
    'first_completed_at',
    'last_completed_at',
    // Repeat ends (2026-10-22): the occurrence comes back, so it is open again.
    'repeat_count_used',
    // Upcoming (2026-10-12): the put-back sets the target again (normally an
    // occurrence already arrived, so over target, never Upcoming).
    TARGET_SET_FIELD,
    'attempts',
    'attempts_counted_through',
    // The task queue (2026-10-19): setting the target again clears the queue
    // state (normally already clear: done cleared it).
    ...queueFields,
    // On deck (2026-10-20): a deck put on the NEXT occurrence since goes with
    // it (DECK_CLEAR_SQL) — undo of the put-back brings it back.
    ...(task.on_deck_day ? ['on_deck_day'] : []),
  ]
}

/** A completion row as an undo snapshot carries it (`reinsertCompletion`). */
function completionCopy(userId: number, row: CompletionRow) {
  return {
    user_id: userId,
    completed_at: row.completed_at,
    due_at_was: row.due_at_was,
    due_at_next: row.due_at_next,
    occurrence_at_was: row.occurrence_at_was,
    occurrence_at_next: row.occurrence_at_next,
    attempts: row.attempts,
  }
}
