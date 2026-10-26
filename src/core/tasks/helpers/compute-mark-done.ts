/**
 * Pure computation helper for mark-done logic
 *
 * Computes the state changes needed for marking a task done without
 * performing any database operations. Used by both single and bulk
 * mark-done operations.
 */

import type { Task } from '@/types'
import { isRecurring } from '@/core/recurrence'
import {
  hasRelativeTarget,
  isDeadlineAnchored,
  nextOrEnd,
  occurrenceDates,
  repeatEndOf,
} from '@/lib/task-segments'
import { isTracked } from '@/lib/track'
import { TARGET_SET_FIELD, queueStateToClear } from '../target-set'

export interface MarkDoneStats {
  completionCount: number
  firstCompletedAt: string
  lastCompletedAt: string
}

export interface RecurringComputation {
  type: 'recurring'
  /**
   * Null for a quota (§5): it has no due date, so the boundary advances
   * nothing. See the tracked branch in `computeMarkDone`.
   */
  nextDueAt: string | null
  /**
   * The next SCHEDULED occurrence (§6, 2026-10-12): the new `occurrence_at`.
   * `nextDueAt` and `nextDeadlineAt` are its dates (`occurrenceDates`).
   */
  nextOccurrenceAt: string | null
  /** The next occurrence's deadline: itself on a deadline-anchored repeat, else null. */
  nextDeadlineAt: string | null
  /**
   * The next occurrence's lead day (the deadlines page, 2026-10-22): on a
   * deadline-anchored repeat with no relative target, re-derived (a deferral
   * never carries over); else null.
   */
  nextLeadFrom: string | null
  prevDueAt: string | null
  /** The occurrence this completion closes (`completions.occurrence_at_was`). */
  prevOccurrenceAt: string | null
  /** Repeat ends (2026-10-22): `repeat_count_used` after this completion. */
  usedAfter: number
  stats: MarkDoneStats
  fieldsChanged: string[]
}

/**
 * REPEAT ENDS (2026-10-22, docs/TASK-MODEL.md § Repeat ends): done on the
 * LAST occurrence of a series with an end. The one-off write (done, archived,
 * stats, attempts, queue mark) plus `repeat_count_used`; the occurrence, its
 * target and any deck stay as they are, so a put-back or an undo restores
 * the occurrence exactly.
 */
export interface SeriesEndComputation {
  type: 'series_end'
  /** The occurrence this completion closes (`completions.occurrence_at_was`). */
  prevOccurrenceAt: string | null
  usedAfter: number
  stats: MarkDoneStats
  fieldsChanged: string[]
}

export interface OneOffComputation {
  type: 'one_off'
  stats: MarkDoneStats
  fieldsChanged: string[]
}

export type MarkDoneComputation = RecurringComputation | SeriesEndComputation | OneOffComputation

/**
 * Compute the state changes needed for marking a task done
 *
 * For recurring tasks: computes next occurrence
 * For one-off tasks: computes done/archived state
 *
 * @param task - The task to mark done
 * @param userTimezone - User's timezone for recurrence calculation
 * @param completedAt - When the task was completed (Date object)
 * @param nowStr - Current timestamp as ISO string for stats
 * @returns Computation result with type and all derived values
 */
export function computeMarkDone(
  task: Task,
  userTimezone: string,
  completedAt: Date,
  nowStr: string,
  /**
   * The user's day boundary (`dayBoundaryForUser`): a from_completion repeat
   * counts from the completion's OpenTask date (`computeFromCompletion`).
   */
  dayStart: string,
  /** The owner's rollover time, read only for a target-less deadline-anchored repeat. */
  rolloverTime: () => string | null = () => null,
): MarkDoneComputation {
  // Compute new stats values (same for both recurring and one-off)
  const stats: MarkDoneStats = {
    completionCount: task.completion_count + 1,
    firstCompletedAt: task.first_completed_at ?? nowStr,
    lastCompletedAt: nowStr,
  }

  if (isRecurring(task.rrule)) {
    // §5: a quota has no due date, so there is no occurrence to advance — the
    // boundary here is only the progress reset below. Asking anyway would be
    // wrong twice over: a quota's rule is a bare period rule ("FREQ=WEEKLY")
    // with no anchor and no previous date, so rrule.js would place the "next
    // occurrence" on an arbitrary weekday and write that date back onto a row
    // that is not supposed to have one.
    //
    // FROM THE OCCURRENCE, NOT THE TARGET (§6, 2026-10-12; red team B1). A
    // moved target (any snooze, Today) no longer drags the schedule: the next
    // occurrence is rrule.after(max(occurrence, completedAt)). Done EARLY
    // (Saturday, for a Sunday occurrence moved to Saturday) → the following
    // Sunday, never tomorrow (no double fire). Done after a target moved PAST
    // the next occurrence (ruling Q3: a weekly moved +10 days) → the next
    // occurrence after now: no catch-up, no double row.
    // From the rule's own instant for this occurrence (`scheduleBase`: a
    // rescheduled deadline never makes a second occurrence in its period).
    // REPEAT ENDS (2026-10-22): the landing is judged by the one end judge
    // (`nextOrEnd` = `scheduleBase` + the engine + `repeatStep`); done on the
    // last occurrence ends the series instead of advancing it.
    const step = isTracked(task) ? null : nextOrEnd(task, userTimezone, { completedAt, dayStart })
    if (step?.ended) return seriesEnd(task, step.used, stats)
    const usedAfter = step ? step.used : repeatEndOf(task).repeat_count_used
    const nextOccurrenceAt = step ? step.occurrenceAt : null
    // The next occurrence's dates (2026-10-21): its derived target and, on a
    // deadline-anchored repeat, its deadline. Nothing a move did carries over.
    const leads = isDeadlineAnchored(task) && !hasRelativeTarget(task)
    const lead = leads ? { rolloverTime: rolloverTime(), now: new Date(nowStr) } : undefined
    const next = nextOccurrenceAt
      ? occurrenceDates(task, nextOccurrenceAt, userTimezone, lead)
      : null
    const nextDueAt = next?.targetAt ?? null
    const nextDeadlineAt = next ? next.deadlineAt : task.deadline_at
    const nextLeadFrom = next ? next.leadFrom : task.lead_from
    return {
      type: 'recurring',
      nextDueAt,
      nextOccurrenceAt,
      nextDeadlineAt,
      nextLeadFrom,
      prevDueAt: task.due_at,
      prevOccurrenceAt: task.occurrence_at,
      usedAfter,
      stats,
      fieldsChanged: [
        'due_at',
        'occurrence_at',
        'original_due_at',
        'deadline_at',
        // §5: the period boundary resets tracked progress, so it must be in
        // fieldsChanged or undo would restore due_at without restoring the
        // count that went with it.
        'progress_current',
        'completion_count',
        'first_completed_at',
        'last_completed_at',
        // Repeat ends (2026-10-22): every completion closes one occurrence.
        'repeat_count_used',
        // Upcoming (2026-10-12): the advance sets the next occurrence's
        // target, so its wait counts from the completion.
        TARGET_SET_FIELD,
        // §7: done resets attempts (the completion row keeps the count).
        'attempts',
        'attempts_counted_through',
        // The task queue (2026-10-19): the advance sets a new target, which
        // clears the queue state — only the fields that were set.
        ...queueStateToClear(task).fields,
        // On deck (2026-10-20): done completes the decked occurrence and the
        // next one is not on deck (DECK_CLEAR_SQL); undo puts the deck back.
        ...(task.on_deck_day ? ['on_deck_day'] : []),
        // The deadlines page (2026-10-22): the next occurrence's lead day.
        ...(nextLeadFrom !== task.lead_from ? ['lead_from'] : []),
      ],
    }
  } else {
    return {
      type: 'one_off',
      stats,
      fieldsChanged: [
        'done',
        'done_at',
        'archived_at',
        'completion_count',
        'first_completed_at',
        'last_completed_at',
        'attempts',
        'attempts_counted_through',
        // The task queue (2026-10-19): a done task is out of every list, so
        // its mark and flag go (only those that were set; undo restores them).
        ...queueStateToClear(task, { includeQueued: false }).fields,
      ],
    }
  }
}

/** Done on the last occurrence: the one-off's fields plus `repeat_count_used`. */
function seriesEnd(task: Task, usedAfter: number, stats: MarkDoneStats): SeriesEndComputation {
  return {
    type: 'series_end',
    prevOccurrenceAt: task.occurrence_at,
    usedAfter,
    stats,
    fieldsChanged: [
      'done',
      'done_at',
      'archived_at',
      'completion_count',
      'first_completed_at',
      'last_completed_at',
      'repeat_count_used',
      'attempts',
      'attempts_counted_through',
      ...queueStateToClear(task, { includeQueued: false }).fields,
    ],
  }
}
