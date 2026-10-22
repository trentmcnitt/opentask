/**
 * Snooze guard evaluation (REDESIGN-V03 §4.3)
 *
 * Two situations where an interactive single-task snooze probably isn't what
 * the user meant. In both, the app **warns and never silently reinterprets**:
 * the user's explicit instruction is always still available as the first
 * choice. Silent clamping was considered and rejected in design — an app that
 * quietly rewrites an instruction is one the user stops being able to predict.
 *
 * 1. `past-next-occurrence` — the snooze target lands at or beyond the task's
 *    next scheduled occurrence, so the snooze would swallow an occurrence
 *    entirely. Offering "snooze to next occurrence" makes the usually-intended
 *    outcome one tap away without imposing it.
 *
 * 2. `no-due-date` — the task has no due date, so "snoozing" it actually
 *    *creates* one. That is frequently an accident (a mis-tap on a row that
 *    happened to be under the finger), and it silently converts an undated
 *    task into one that will start notifying.
 *
 * SCOPE — load-bearing, see §4.3: these guards apply to the **single-task
 * interactive snooze UI only.** Bulk paths (`bulk/snooze`, `snooze-overdue`)
 * must never modal-block. A per-item prompt inside a sweep would rebuild the
 * exact friction this redesign exists to remove, and per L1 it would treat
 * sweep participation as a deliberate per-task decision, which it is not — the
 * user sweeps small batches without reading them. Bulk applies and reports
 * counts instead.
 *
 * This module is pure (no DB, no fetch) so it runs identically on the client
 * and under behavioral test.
 */

import { computeNextOccurrence } from '@/core/recurrence/compute-next'
import {
  isDeadlineAnchored,
  occurrenceDates,
  repeatEndOf,
  repeatStep,
  scheduleBase,
} from '@/lib/task-segments'
import type { Task } from '@/types'

export type SnoozeGuard =
  | {
      kind: 'past-next-occurrence'
      /** UTC ISO string of the occurrence the snooze would skip past */
      nextOccurrence: string
    }
  | { kind: 'no-due-date' }

/** The subset of a task the guard needs. Keeps callers free of full Task objects in tests. */
export type SnoozeGuardTask = Pick<Task, 'due_at' | 'rrule' | 'recurrence_mode' | 'anchor_time'> &
  Partial<
    Pick<
      Task,
      | 'occurrence_at'
      | 'repeat_anchor'
      | 'target_days_before'
      | 'target_time'
      | 'repeat_count'
      | 'repeat_count_used'
      | 'repeat_until'
    >
  >

/**
 * Compute a task's next scheduled occurrence strictly after its current due_at.
 *
 * Returns null when the task has no deterministic upcoming occurrence:
 * - non-recurring tasks have none by definition
 * - `from_completion` tasks genuinely have none until they are completed, so
 *   "the next occurrence" is not a fact about them yet. Guessing one would
 *   invent a schedule the task does not have.
 * - a malformed rrule should never block a snooze the user asked for
 * - (repeat ends, 2026-10-22) the current occurrence is the series' last:
 *   there is no next one to pass (`repeatStep`)
 *
 * Reuses `computeNextOccurrence` rather than re-deriving the schedule — §4.6 is
 * explicit that there must be exactly one rrule evaluator, and that it must
 * honour anchor_time over BYHOUR.
 */
export function nextScheduledOccurrence(task: SnoozeGuardTask, timezone: string): Date | null {
  if (!task.rrule || !task.due_at) return null
  if (task.recurrence_mode === 'from_completion') return null

  const dueAt = new Date(task.due_at)
  if (Number.isNaN(dueAt.getTime())) return null

  try {
    // A DEADLINE-ANCHORED repeat (2026-10-21): its rule walks the deadline,
    // so the next occurrence comes after the scheduled one, and the moment
    // that matters is that occurrence's own TARGET (`occurrenceDates`).
    if (isDeadlineAnchored({ rrule: task.rrule, repeat_anchor: task.repeat_anchor ?? null })) {
      const occurrence = new Date(
        scheduleBase(
          {
            rrule: task.rrule,
            repeat_anchor: task.repeat_anchor ?? null,
            recurrence_mode: task.recurrence_mode,
            anchor_time: task.anchor_time,
            occurrence_at: task.occurrence_at,
            due_at: task.due_at,
          },
          timezone,
        )!,
      )
      const next = computeNextOccurrence({
        rrule: task.rrule,
        recurrenceMode: 'from_due',
        anchorTime: task.anchor_time,
        timezone,
        completedAt: occurrence,
        prevDueAt: occurrence,
        anchorAt: occurrence,
      })
      if (repeatStep(repeatEndOf(task), next.toISOString(), 1, timezone).ended) return null
      const schedule = {
        rrule: task.rrule,
        repeat_anchor: task.repeat_anchor ?? null,
        target_days_before: task.target_days_before ?? null,
        target_time: task.target_time ?? null,
      }
      // No target of its own (L1): the occurrence (its deadline) is the limit.
      return new Date(occurrenceDates(schedule, next.toISOString(), timezone).targetAt ?? next)
    }
    const next = computeNextOccurrence({
      rrule: task.rrule,
      recurrenceMode: 'from_due',
      anchorTime: task.anchor_time,
      timezone,
      completedAt: dueAt,
      prevDueAt: dueAt,
      // A floating rule's grid (every N, or bare) runs from the scheduled occurrence, never
      // from a moved target.
      anchorAt: new Date(task.occurrence_at ?? task.due_at),
    })
    return repeatStep(repeatEndOf(task), next.toISOString(), 1, timezone).ended ? null : next
  } catch {
    // A schedule we can't evaluate is not grounds for blocking the user.
    return null
  }
}

/**
 * Decide whether an interactive single-task snooze warrants a confirmation.
 *
 * @param task    the task being snoozed
 * @param until   the proposed snooze target (UTC ISO string)
 * @param timezone the user's IANA timezone
 * @returns the guard to show, or null to snooze immediately
 */
export function evaluateSnoozeGuard(
  task: SnoozeGuardTask,
  until: string,
  timezone: string,
): SnoozeGuard | null {
  if (!task.due_at) return { kind: 'no-due-date' }

  const target = new Date(until)
  if (Number.isNaN(target.getTime())) return null

  const next = nextScheduledOccurrence(task, timezone)
  if (!next) return null

  // At-or-after, not strictly after: landing exactly on the next occurrence
  // still means this snooze consumed it.
  if (target.getTime() >= next.getTime()) {
    return { kind: 'past-next-occurrence', nextOccurrence: next.toISOString() }
  }

  return null
}
