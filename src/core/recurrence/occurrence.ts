/**
 * Read-time occurrence derivation (REDESIGN-V03 §4.6)
 *
 * THE TRAP THIS EXISTS TO CLOSE
 *
 * Today, a recurring item's `due_at` stays fresh only because the user's daily
 * bulk sweep re-dates it — roughly 100,000 snoozes that are, functionally, a
 * hand-cranked roll-forward. Every change in this redesign that reduces nagging
 * also reduces sweeping, and the moment sweeping stops, `due_at` on a
 * never-completed recurring item freezes at its last value.
 *
 * A frozen `due_at` is not merely stale, it is actively harmful: the item looks
 * more and more overdue forever, monopolises the notifier's limited per-tick
 * slots (§4.5), and quotes a date from months ago. A weekly task would nag
 * every single day.
 *
 * So: **for a recurring item, the schedule is the source of truth for whether
 * it is due today — never `due_at` freshness.** One-offs are unaffected; their
 * `due_at` is a real fact about them and stays authoritative.
 *
 * THE RULE
 *
 * A recurring item's effective due time today is:
 *   1. `due_at` if it is still in the future — a forward-looking target is
 *      never a stale artifact. This is what makes an explicit snooze win for
 *      the rest of the day; tomorrow the schedule reasserts itself.
 *   2. otherwise today's occurrence derived from the rrule, if there is one.
 *   3. otherwise nothing — the item is simply not due today, no matter what a
 *      frozen `due_at` claims. This is the case that stops the endless nagging.
 *
 * Deriving from the schedule rather than mutating rows is deliberate: §10
 * rejects a nightly roll-forward cron that rewrites user-visible due dates.
 * What it permits is exactly this — computing the answer at read time.
 *
 * ONE EVALUATOR: this reuses `computeNextOccurrence`, which already prefers
 * `anchor_time` over BYHOUR (§4.6 — for the many rrules with no BYHOUR,
 * `anchor_time` is the only carrier of time-of-day). Writing a second rrule
 * evaluator here would let the two drift.
 */

import { DateTime } from 'luxon'
import { computeNextOccurrence } from './compute-next'

/** The subset of a task this module needs. */
export interface OccurrenceTask {
  due_at: string | null
  rrule: string | null
  recurrence_mode?: 'from_due' | 'from_completion' | null
  anchor_time: string | null
}

/**
 * The occurrence scheduled for today, or null if the item has none today.
 *
 * Returns null for non-recurring items (they have no schedule) and for
 * `from_completion` items — those genuinely have no scheduled occurrence until
 * they are completed, so asserting one would invent a schedule they don't have.
 */
export function todaysOccurrence(
  task: OccurrenceTask,
  timezone: string,
  now: Date = new Date(),
): Date | null {
  if (!task.rrule) return null
  if (task.recurrence_mode === 'from_completion') return null

  const localNow = DateTime.fromJSDate(now).setZone(timezone)
  if (!localNow.isValid) return null

  // Search from just before midnight local so the first result is today's
  // occurrence if one exists.
  const justBeforeToday = localNow.startOf('day').minus({ milliseconds: 1 }).toJSDate()

  let next: Date
  try {
    next = computeNextOccurrence({
      rrule: task.rrule,
      recurrenceMode: 'from_due',
      anchorTime: task.anchor_time,
      timezone,
      completedAt: justBeforeToday,
      prevDueAt: justBeforeToday,
    })
  } catch {
    // An unevaluable schedule must not make the item invisible or permanently
    // overdue — callers fall back to due_at.
    return null
  }

  const localNext = DateTime.fromJSDate(next).setZone(timezone)
  if (!localNext.isValid) return null

  return localNext.hasSame(localNow, 'day') ? next : null
}

/**
 * The time this item should be treated as due, as of `now`.
 *
 * Returns null when the item is not due at all today — which for a recurring
 * item is a real answer, not a missing one.
 */
export function effectiveDueAt(
  task: OccurrenceTask,
  timezone: string,
  now: Date = new Date(),
): Date | null {
  // One-offs: due_at is the whole truth (§4.6).
  if (!task.rrule) {
    return task.due_at ? new Date(task.due_at) : null
  }

  // from_completion items have no derivable schedule, so due_at is all we have.
  if (task.recurrence_mode === 'from_completion') {
    return task.due_at ? new Date(task.due_at) : null
  }

  // A due_at in the future is a deliberate forward-looking target — an explicit
  // snooze, or simply the next occurrence already recorded. Honour it. This is
  // what lets a snooze win for the rest of the day.
  if (task.due_at) {
    const due = new Date(task.due_at)
    if (!Number.isNaN(due.getTime()) && due.getTime() > now.getTime()) return due
  }

  // Past-dated: ignore it entirely and ask the schedule.
  const occurrence = todaysOccurrence(task, timezone, now)
  if (occurrence) return occurrence

  // No occurrence today. If the rrule couldn't be evaluated at all we still owe
  // the user their notification, so fall back to due_at; otherwise the item is
  // genuinely not due today.
  if (!isEvaluableSchedule(task, timezone, now)) {
    return task.due_at ? new Date(task.due_at) : null
  }
  return null
}

/**
 * Whether the item is due or overdue right now.
 *
 * The predicate the notifier, the badge, and the sweep all need.
 */
export function isCurrentlyDue(
  task: OccurrenceTask,
  timezone: string,
  now: Date = new Date(),
): boolean {
  const due = effectiveDueAt(task, timezone, now)
  return due !== null && due.getTime() <= now.getTime()
}

/**
 * Can this item's schedule be evaluated at all?
 *
 * Distinguishes "no occurrence today" (a real answer) from "the rrule is
 * broken" (where falling back to due_at is safer than going silent — L2's
 * failure-asymmetry rule: silence fails dangerous).
 */
function isEvaluableSchedule(task: OccurrenceTask, timezone: string, now: Date): boolean {
  if (!task.rrule) return false
  try {
    const probe = DateTime.fromJSDate(now).setZone(timezone).startOf('day').toJSDate()
    computeNextOccurrence({
      rrule: task.rrule,
      recurrenceMode: 'from_due',
      anchorTime: task.anchor_time,
      timezone,
      completedAt: probe,
      prevDueAt: probe,
    })
    return true
  } catch {
    return false
  }
}
