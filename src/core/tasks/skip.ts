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

import {
  nextOrEnd,
  occurrenceDates,
  repeatEndOf,
  seriesEndWords,
  seriesEndedBySkip,
  type AdvanceTask,
} from '@/lib/task-segments'
import { dayBoundaryForUser, leadContextFor } from './rollover-time'
import { withTransaction } from '@/core/db'
import { logAction, createTaskSnapshot } from '@/core/undo'
import { logActivity } from '@/core/activity'
import { nowUtc, isRecurring } from '@/core/recurrence'
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
import { REPEAT_ENDED_MESSAGE } from './mark-done'

/**
 * A1 — SKIPPING THE LAST OCCURRENCE of a series with an end (repeat ends,
 * 2026-10-22; PENDING Trent). false (the recommendation): the series ends
 * ARCHIVED with done=0 — the one-off skip's write: a skip is never a
 * completion. true: it ends done=1 (done_at set) like a done of the last,
 * still without a completion row or completion_count. Flipping this is the
 * whole change: `writeSeriesEndSkip` is the one writer of that end
 * (`skipOccurrence` and `skipUntil` both call it; the rollover never ends a
 * series).
 */
export const SKIPPED_LAST_MARKS_DONE = false

export interface SkipOccurrenceOptions {
  userId: number
  userTimezone: string
  taskId: number
}

export interface SkipOccurrenceResult {
  task: Task
  wasRecurring: boolean
  description: string
  /** Repeat ends (2026-10-22): the skip closed the series' last occurrence. */
  seriesEnded: boolean
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
  // A done task — a one-off, or (repeat ends, 2026-10-22) a repeat whose
  // series has ended — has nothing to skip; nor does a series ended by a skip.
  if (task.done) {
    throw new ValidationError('Task is already done')
  }
  const recurring = isRecurring(task.rrule)
  if (seriesEndedBySkip(task)) throw new ValidationError(REPEAT_ENDED_MESSAGE)

  const nowStr = nowUtc()
  const skipCount = (task.skip_count ?? 0) + 1
  // §5: a quota has no date to advance — see the same guard in
  // `computeMarkDone`. Skipping one is still a period boundary, so the
  // progress reset in `writeRecurringSkip` stands. Repeat ends: the landing
  // is judged by `nextOrEnd`; skipping the last occurrence ends the series.
  const step =
    recurring && !isTracked(task)
      ? nextOrEnd(task, userTimezone, {
          completedAt: new Date(),
          dayStart: dayBoundaryForUser(userId),
        })
      : null
  const seriesEnded = step?.ended === true

  const description = seriesEnded
    ? seriesEndSkipWords(task)
    : recurring
      ? `Skipped "${task.title}"`
      : `Skipped and archived "${task.title}"`

  const result = withTransaction((tx) => {
    let after: Task
    let fieldsChanged: string[]

    if (step?.ended) {
      const write = writeSeriesEndSkip(tx, { task, skipsAdded: step.consumed, nowStr })
      after = write.after
      fieldsChanged = write.fieldsChanged
    } else if (recurring) {
      const write = writeRecurringSkip(tx, {
        task,
        nextOccurrenceAt: step ? step.occurrenceAt : null,
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

    logAction(userId, 'skip', description, fieldsChanged, [
      createTaskSnapshot(task, after, fieldsChanged),
    ])

    logActivity({
      userId,
      taskId,
      action: 'skip',
      fields: fieldsChanged,
      before: { id: taskId, due_at: task.due_at, skip_count: task.skip_count },
      after: { id: taskId, due_at: after.due_at, skip_count: skipCount },
      metadata: { recurring, ...(seriesEnded ? { series_ended: true } : {}) },
    })

    return after
  })

  emitSyncEvent(userId)
  // The occurrence is gone either way, so its notification should be too.
  dismissNotificationsForTasks(userId, [taskId])

  // §7.5: a skip is NOT a completion. Anything downstream that counts
  // completions must never see this as one.
  dispatchWebhookEvent(userId, 'task.skipped', {
    task: formatTaskResponse(result, userTimezone),
    ...(seriesEnded ? { series_ended: true } : {}),
  })

  return { task: result, wasRecurring: recurring, description, seriesEnded }
}

/** "Skipped "X" — the last of 6; the repeat has ended" / "… — the last; it ended Dec 31". */
export function seriesEndSkipWords(task: Task): string {
  const words = seriesEndWords(task)
  const tail = task.repeat_count !== null ? '; the repeat has ended' : ''
  return `Skipped "${task.title}" — ${words}${tail}`
}

/**
 * The occurrence one skip lands on: the next one after the SCHEDULED
 * occurrence, like done (§6, 2026-10-12) — a moved target never drags the
 * schedule. Counted from now when the occurrence has already passed, so an
 * over-target task lands on its next one still ahead (the rule's
 * `max(prevDueAt, completedAt)`). Not for a quota (no date to advance).
 * REPEAT ENDS (2026-10-22): null when the skip would END the series — the
 * current occurrence is the last (`nextOrEnd`).
 */
export function nextOccurrenceAfterSkip(
  task: AdvanceTask,
  timezone: string,
  now: Date,
  /** The user's day boundary: a from_completion rule counts from now's OpenTask date. */
  dayStart: string,
): string | null {
  const step = nextOrEnd(task, timezone, { completedAt: now, dayStart })
  return step.ended ? null : step.occurrenceAt
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
  // A target-less deadline-anchored repeat (the deadlines page, 2026-10-22)
  // gets the landing occurrence's lead day too — a deferral never carries over.
  const lead = leadContextFor(task)
  const next = nextOccurrenceAt ? occurrenceDates(task, nextOccurrenceAt, timezone, lead) : null
  const nextDeadlineAt = next ? next.deadlineAt : task.deadline_at
  const nextLeadFrom = next ? next.leadFrom : task.lead_from
  const nextTarget = next?.targetAt ?? null
  // A kept deck keeps the task without a target; `original_due_at` still gets
  // the landing occurrence's target, as taking it off deck later would give it.
  const nextDueAt = keep ? null : nextTarget

  const deckClear = keep ? '' : `, ${DECK_CLEAR_SQL}`

  // §5: advancing the occurrence is a period boundary, so a tracked task's
  // progress resets here exactly as it would on completion.
  // Repeat ends (2026-10-22): every occurrence passed over is closed.
  const used = repeatEndOf(task).repeat_count_used + skipsAdded
  tx.prepare(
    `UPDATE tasks
        SET due_at = ?, occurrence_at = ?, original_due_at = ?, deadline_at = ?, lead_from = ?,
            skip_count = ?, repeat_count_used = ?, progress_current = 0, ${TARGET_SET_FIELD} = ?,
            attempts = 0, attempts_counted_through = NULL, ${QUEUE_CLEAR_SQL}${deckClear},
            updated_at = ?
      WHERE id = ?`,
  ).run(
    nextDueAt,
    nextOccurrenceAt,
    nextTarget,
    nextDeadlineAt,
    nextLeadFrom,
    skipCount,
    used,
    nowStr,
    nowStr,
    task.id,
  )

  const queue = queueStateToClear(task)
  const after: Task = {
    ...task,
    due_at: nextDueAt,
    occurrence_at: nextOccurrenceAt,
    original_due_at: nextTarget,
    deadline_at: nextDeadlineAt,
    lead_from: nextLeadFrom,
    skip_count: skipCount,
    repeat_count_used: used,
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
    'repeat_count_used',
    'progress_current',
    TARGET_SET_FIELD,
    'attempts',
    'attempts_counted_through',
    ...queue.fields,
    ...(task.on_deck_day && !keep ? ['on_deck_day'] : []),
    ...(nextLeadFrom !== task.lead_from ? ['lead_from'] : []),
  ]
  return { after, fieldsChanged }
}

/**
 * THE SKIP THAT ENDS A SERIES (repeat ends, 2026-10-22): the current
 * occurrence was the last (or skip until passed the end). The one-off skip's
 * write — archived, `skip_count` += the occurrences closed, never a
 * completion — plus `repeat_count_used`. The occurrence, target, deadline
 * and any deck stay, so undo restores them exactly. done=0 or done=1 is A1:
 * `SKIPPED_LAST_MARKS_DONE`, the one place it is decided.
 */
export function writeSeriesEndSkip(
  tx: Database.Database,
  { task, skipsAdded, nowStr }: { task: Task; skipsAdded: number; nowStr: string },
): { after: Task; fieldsChanged: string[] } {
  const skipCount = (task.skip_count ?? 0) + skipsAdded
  const used = repeatEndOf(task).repeat_count_used + skipsAdded
  const done = SKIPPED_LAST_MARKS_DONE
  tx.prepare(
    `UPDATE tasks
        SET archived_at = ?, skip_count = ?, repeat_count_used = ?, done = ?, done_at = ?,
            updated_at = ?
      WHERE id = ?`,
  ).run(nowStr, skipCount, used, done ? 1 : 0, done ? nowStr : null, nowStr, task.id)
  const after: Task = {
    ...task,
    archived_at: nowStr,
    skip_count: skipCount,
    repeat_count_used: used,
    ...(done ? { done: true, done_at: nowStr } : {}),
  }
  const fieldsChanged = [
    'archived_at',
    'skip_count',
    'repeat_count_used',
    ...(done ? ['done', 'done_at'] : []),
  ]
  return { after, fieldsChanged }
}
