/**
 * Skip an occurrence (REDESIGN-V03 §7.5)
 *
 * "Not doing this occurrence — advance without recording a completion."
 *
 * WHY THIS EXISTS: today the user has exactly two ways to clear an item, and
 * both corrupt the record. Marking it done is a lie that inflates
 * `completion_count`; snoozing is a deferral that re-dates something they have
 * actually decided not to do. Skip protects `completion_count`'s honesty, which
 * matters because adherence history is the one signal the app can trust (L1 —
 * the only trustworthy adherence signal is an explicit completion).
 *
 * NAMING (§6.0 terminology guard): the API action is `skip-occurrence`, not
 * `skip`. `review/execute` already uses "skip" for a no-op review
 * acknowledgment — a different operation entirely.
 *
 * NOTHING MAY BE BUILT ON SKIP PATTERNS. Bulk-skipping is expected, and per L1
 * a clearing gesture carries no information about intent. `skip_count` exists so
 * that completions stay honest, NOT so anyone can infer avoidance from it.
 */

import { occurrenceDates } from '@/lib/task-segments'
import { withTransaction } from '@/core/db'
import { logAction, createTaskSnapshot } from '@/core/undo'
import { logActivity } from '@/core/activity'
import { nowUtc, computeNextOccurrence, isRecurring } from '@/core/recurrence'
import { ValidationError } from '@/core/errors'
import { dispatchWebhookEvent } from '@/core/webhooks/dispatch'
import { dismissNotificationsForTasks } from '@/core/notifications/dismiss'
import { formatTaskResponse } from '@/lib/format-task'
import { emitSyncEvent } from '@/lib/sync-events'
import { isTracked } from '@/lib/track'
import { loadTaskForMutation } from './access'
import type Database from 'better-sqlite3'
import type { Task } from '@/types'
import { QUEUE_CLEAR_SQL, TARGET_SET_FIELD, queueStateToClear } from './target-set'
import { DECK_CLEAR_SQL } from './deck-clear'

export interface SkipOccurrenceOptions {
  userId: number
  userTimezone: string
  taskId: number
}

export interface SkipOccurrenceResult {
  task: Task
  wasRecurring: boolean
  description: string
}

/**
 * Skip one occurrence.
 *
 * Recurring: advance `due_at` to the next occurrence, leaving
 * `completion_count` untouched and incrementing `skip_count`.
 *
 * One-off: equivalent to archiving without completion — the task leaves the
 * active list but is never recorded as done.
 */
export function skipOccurrence(options: SkipOccurrenceOptions): SkipOccurrenceResult {
  const { userId, userTimezone, taskId } = options

  const task = loadTaskForMutation(userId, taskId, {
    trashed: { reject: 'Cannot skip a trashed task' },
  })
  // §6: a reminder has no occurrence to skip. A missed one already rolls
  // forward on its own (`effectiveDueAt`), and clearing one is "Considered"
  // (done), which is the whole interaction — the same reason `snoozeTask`
  // refuses it. Skipping would re-date a recurring reminder behind the
  // user's back, or archive a one-off without it ever being considered. No
  // app surface offers skip on a reminder; this closes the API path.
  if (task.is_reminder) {
    throw new ValidationError(
      'Reminders cannot be skipped — a missed one rolls forward on its own; complete it to mark it considered',
    )
  }
  if (task.done && !isRecurring(task.rrule)) {
    throw new ValidationError('Task is already done')
  }

  const nowStr = nowUtc()
  const skipCount = (task.skip_count ?? 0) + 1
  const recurring = isRecurring(task.rrule)

  const result = withTransaction((tx) => {
    let after: Task
    let fieldsChanged: string[]

    if (recurring) {
      // §5: a quota has no date to advance — see the same guard in
      // `computeMarkDone`. Skipping one is still a period boundary, so the
      // progress reset in `writeRecurringSkip` stands.
      const nextOccurrenceAt = isTracked(task) ? null : nextOccurrenceAfterSkip(task, userTimezone)
      const write = writeRecurringSkip(tx, {
        task,
        nextOccurrenceAt,
        skipsAdded: 1,
        nowStr,
        timezone: userTimezone,
      })
      after = write.after
      fieldsChanged = write.fieldsChanged
    } else {
      // Archived, never completed. done stays 0 — that is the entire point.
      tx.prepare(
        `UPDATE tasks SET archived_at = ?, skip_count = ?, updated_at = ? WHERE id = ?`,
      ).run(nowStr, skipCount, nowStr, taskId)

      after = { ...task, archived_at: nowStr, skip_count: skipCount }
      fieldsChanged = ['archived_at', 'skip_count']
    }

    logAction(userId, 'skip', `Skipped "${task.title}"`, fieldsChanged, [
      createTaskSnapshot(task, after, fieldsChanged),
    ])

    logActivity({
      userId,
      taskId,
      action: 'skip',
      fields: fieldsChanged,
      before: { id: taskId, due_at: task.due_at, skip_count: task.skip_count },
      after: { id: taskId, due_at: after.due_at, skip_count: skipCount },
      metadata: { recurring },
    })

    return after
  })

  emitSyncEvent(userId)
  // The occurrence is gone either way, so its notification should be too.
  dismissNotificationsForTasks(userId, [taskId])

  // §7.5: a skip is NOT a completion. Anything downstream that counts
  // completions must never see this as one.
  dispatchWebhookEvent(userId, 'task.skipped', { task: formatTaskResponse(result, userTimezone) })

  return {
    task: result,
    wasRecurring: recurring,
    description: recurring ? `Skipped "${task.title}"` : `Skipped and archived "${task.title}"`,
  }
}

/**
 * The occurrence one skip lands on: the next one after the SCHEDULED
 * occurrence, like done (§6, 2026-10-12) — a moved target never drags the
 * schedule. Counted from now when the occurrence has already passed, so an
 * over-target task lands on its next one still ahead (the rule's
 * `max(prevDueAt, completedAt)`). Not for a quota (no date to advance).
 */
export function nextOccurrenceAfterSkip(
  task: Pick<Task, 'rrule' | 'recurrence_mode' | 'anchor_time' | 'occurrence_at' | 'due_at'>,
  timezone: string,
  now: Date = new Date(),
): string {
  const prevOccurrence = task.occurrence_at ?? task.due_at
  return computeNextOccurrence({
    rrule: task.rrule!,
    recurrenceMode: task.recurrence_mode,
    anchorTime: task.anchor_time,
    timezone,
    completedAt: now,
    prevDueAt: prevOccurrence ? new Date(prevOccurrence) : null,
    // A floating rule's grid (every N, or bare) runs from the task's own occurrence.
    anchorAt: prevOccurrence ? new Date(prevOccurrence) : null,
  }).toISOString()
}

export interface RecurringSkipWrite {
  task: Task
  /** The occurrence the task lands on; null for a quota (no date to advance). */
  nextOccurrenceAt: string | null
  /** How many occurrences this skip passes over (`skip_count` += it). One for skip-occurrence. */
  skipsAdded: number
  nowStr: string
  timezone: string
  /**
   * Skip until only (designer ruling, 2026-10-21): the task is on deck for a
   * day ON or AFTER the skip-until date, so the deck stays — it now refers to
   * the landing occurrence. The target stays NULL (a decked repeating task
   * has none) while the occurrence, deadline and counts move as in any skip.
   * Every other skip clears the deck.
   */
  keepDeck?: boolean
}

/**
 * THE WRITE OF A REPEATING TASK'S SKIP, shared by `skipOccurrence` (one
 * occurrence) and `skipUntil` (one or many at once): inside the caller's
 * transaction, it moves the occurrence and the target to `nextOccurrenceAt`
 * and returns the after-state and the fields for the undo snapshot. The
 * caller logs the undo entry and the activity row.
 */
export function writeRecurringSkip(
  tx: Database.Database,
  { task, nextOccurrenceAt, skipsAdded, nowStr, timezone, keepDeck = false }: RecurringSkipWrite,
): { after: Task; fieldsChanged: string[] } {
  const keep = keepDeck && !!task.on_deck_day
  const skipCount = (task.skip_count ?? 0) + skipsAdded
  // The landing occurrence's dates (2026-10-21, `occurrenceDates`): its
  // derived target and, on a deadline-anchored repeat, its deadline.
  const next = nextOccurrenceAt ? occurrenceDates(task, nextOccurrenceAt, timezone) : null
  const nextDeadlineAt = next ? next.deadlineAt : task.deadline_at
  const nextTarget = next?.targetAt ?? null
  // A kept deck keeps the task without a target; `original_due_at` still gets
  // the landing occurrence's target, as taking it off deck later would give it.
  const nextDueAt = keep ? null : nextTarget

  const deckClear = keep ? '' : `, ${DECK_CLEAR_SQL}`

  // §5: advancing the occurrence is a period boundary, so a tracked task's
  // progress resets here exactly as it would on completion.
  tx.prepare(
    `UPDATE tasks
        SET due_at = ?, occurrence_at = ?, original_due_at = ?, deadline_at = ?, skip_count = ?,
            progress_current = 0, ${TARGET_SET_FIELD} = ?,
            attempts = 0, attempts_counted_through = NULL, ${QUEUE_CLEAR_SQL}${deckClear},
            updated_at = ?
      WHERE id = ?`,
  ).run(nextDueAt, nextOccurrenceAt, nextTarget, nextDeadlineAt, skipCount, nowStr, nowStr, task.id)

  const queue = queueStateToClear(task)
  const after: Task = {
    ...task,
    due_at: nextDueAt,
    occurrence_at: nextOccurrenceAt,
    original_due_at: nextTarget,
    deadline_at: nextDeadlineAt,
    skip_count: skipCount,
    progress_current: 0,
    // Upcoming (2026-10-12): the next occurrence's wait counts from the skip.
    target_set_at: nowStr,
    // §7: a new occurrence starts its attempts afresh.
    attempts: 0,
    attempts_counted_through: null,
    // The task queue (2026-10-19): the new target clears the queue state.
    ...queue.after,
    // On deck (2026-10-20, ruling E): skipping takes the task off deck — the
    // occurrence it was decked for is gone. Undo restores the deck. A kept
    // deck (skip until, a deck day on or after the date) stays.
    on_deck_day: keep ? task.on_deck_day : null,
  }
  const fieldsChanged = [
    'due_at',
    'occurrence_at',
    'original_due_at',
    'deadline_at',
    'skip_count',
    'progress_current',
    TARGET_SET_FIELD,
    'attempts',
    'attempts_counted_through',
    ...queue.fields,
    ...(task.on_deck_day && !keep ? ['on_deck_day'] : []),
  ]
  return { after, fieldsChanged }
}
