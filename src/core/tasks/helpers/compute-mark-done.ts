/**
 * Pure computation helper for mark-done logic
 *
 * Computes the state changes needed for marking a task done without
 * performing any database operations. Used by both single and bulk
 * mark-done operations.
 */

import type { Task } from '@/types'
import { computeNextOccurrence, isRecurring } from '@/core/recurrence'

export interface MarkDoneStats {
  completionCount: number
  firstCompletedAt: string
  lastCompletedAt: string
}

export interface RecurringComputation {
  type: 'recurring'
  nextDueAt: string
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
    const nextOccurrence = computeNextOccurrence({
      rrule: task.rrule!,
      recurrenceMode: task.recurrence_mode,
      anchorTime: task.anchor_time,
      timezone: userTimezone,
      completedAt,
    })

    return {
      type: 'recurring',
      nextDueAt: nextOccurrence.toISOString(),
      prevDueAt: task.due_at,
      stats,
      fieldsChanged: [
        'due_at',
        'original_due_at',
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
