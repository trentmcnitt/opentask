/**
 * Pure computation helper for mark-done logic
 *
 * Computes the state changes needed for marking a task done without
 * performing any database operations. Used by both single and bulk
 * mark-done operations.
 */

import type { Task } from '@/types'
import { computeNextOccurrence, isRecurring } from '@/core/recurrence'
import { advanceDeadline, capAtDeadline } from '@/lib/task-segments'
import { isTracked } from '@/lib/track'
import { TARGET_SET_FIELD } from '../target-set'

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
   * The next SCHEDULED occurrence (§6, 2026-10-12) — `nextDueAt` before the
   * deadline cap. The new `occurrence_at`.
   */
  nextOccurrenceAt: string | null
  /** The deadline moved with the occurrence (`advanceDeadline`); unchanged when none. */
  nextDeadlineAt: string | null
  prevDueAt: string | null
  /** The occurrence this completion closes (`completions.occurrence_at_was`). */
  prevOccurrenceAt: string | null
  stats: MarkDoneStats
  fieldsChanged: string[]
}

export interface OneOffComputation {
  type: 'one_off'
  stats: MarkDoneStats
  fieldsChanged: string[]
}

export type MarkDoneComputation = RecurringComputation | OneOffComputation

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
    const prevOccurrence = task.occurrence_at ?? task.due_at
    const nextOccurrence = isTracked(task)
      ? null
      : computeNextOccurrence({
          rrule: task.rrule!,
          recurrenceMode: task.recurrence_mode,
          anchorTime: task.anchor_time,
          timezone: userTimezone,
          completedAt,
          prevDueAt: prevOccurrence ? new Date(prevOccurrence) : null,
        })

    const nextOccurrenceAt = nextOccurrence?.toISOString() ?? null
    const nextDeadlineAt = advanceDeadline(task, nextOccurrenceAt, userTimezone)
    // The new target is the occurrence, never past its deadline (§8.2).
    const nextDueAt = nextOccurrenceAt
      ? capAtDeadline(nextOccurrenceAt, nextDeadlineAt, completedAt)
      : null
    return {
      type: 'recurring',
      nextDueAt,
      nextOccurrenceAt,
      nextDeadlineAt,
      prevDueAt: task.due_at,
      prevOccurrenceAt: task.occurrence_at,
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
        // Upcoming (2026-10-12): the advance sets the next occurrence's
        // target, so its wait counts from the completion.
        TARGET_SET_FIELD,
        // §7: done resets attempts (the completion row keeps the count).
        'attempts',
        'attempts_counted_through',
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
      ],
    }
  }
}
