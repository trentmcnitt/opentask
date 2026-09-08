/**
 * Pure computation helper for mark-done logic
 *
 * Computes the state changes needed for marking a task done without
 * performing any database operations. Used by both single and bulk
 * mark-done operations.
 */

import type { Task } from '@/types'
import { computeNextOccurrence, isRecurring } from '@/core/recurrence'
import { isTracked } from '@/lib/track'

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
  prevDueAt: string | null
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
    const nextOccurrence = isTracked(task)
      ? null
      : computeNextOccurrence({
          rrule: task.rrule!,
          recurrenceMode: task.recurrence_mode,
          anchorTime: task.anchor_time,
          timezone: userTimezone,
          completedAt,
          prevDueAt: task.due_at ? new Date(task.due_at) : null,
        })

    return {
      type: 'recurring',
      nextDueAt: nextOccurrence?.toISOString() ?? null,
      prevDueAt: task.due_at,
      stats,
      fieldsChanged: [
        'due_at',
        'original_due_at',
        // §5: the period boundary resets tracked progress, so it must be in
        // fieldsChanged or undo would restore due_at without restoring the
        // count that went with it.
        'progress_current',
        'completion_count',
        'first_completed_at',
        'last_completed_at',
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
      ],
    }
  }
}
