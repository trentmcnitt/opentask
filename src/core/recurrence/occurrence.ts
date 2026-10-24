/**
 * Read-time occurrence derivation — and the rule for recurring tasks
 * (REDESIGN-V03 §4.6, AMENDED 2026-09-07 by Trent)
 *
 * THE RULE, as it stands now
 *
 * A recurring TASK carries debt. Its `due_at` is the truth, past or future:
 *   - in the future, it is the next occurrence or an explicit snooze target
 *     ("it's due at the time it was snoozed to");
 *   - in the past, it has been overdue SINCE THEN, and stays overdue — nagged
 *     at its priority cadence, through midnight, into the next day and the
 *     one after — until it is done. Completing it moves `due_at` to the next
 *     scheduled occurrence after the completion (compute-next.ts, from_due:
 *     `after(max(prevDue, completedAt))`), so a Mon/Thu task finished on a
 *     Tuesday next lands on Thursday. The schedule is respected; the debt is
 *     kept.
 *   - only when there is NO `due_at` at all is today's occurrence derived from
 *     the rrule.
 *
 * A REMINDER rolls forward. It has no debt by design (§6): a missed one is
 * not re-shown until its next occurrence. Reminders are evaluated on their own
 * surface through `todaysOccurrence`, never through `effectiveDueAt`.
 *
 * One-offs are untouched: `due_at` was always the whole truth for them.
 *
 * HISTORY — why the rule was briefly the other way, and who changed it back
 *
 * §4.6 as first written (07-27-26, AI-authored, no attribution) made EVERY
 * recurring item roll forward: a past-dated recurring task was "not due" unless
 * the rrule produced an occurrence today, and it stopped being overdue at
 * midnight. That closed a real trap — in July all ~217 recurring items were
 * tasks, kept current only by the daily bulk sweep, so killing the nagging
 * would have frozen ~175 never-completed protocol items at "overdue by 40
 * days" forever. Rolling everything forward was the only lever available
 * before the Reminders surface existed.
 *
 * It also contradicted the user's own recorded rule of 07-22-26 — "if missed
 * today, does it need making up? no → rhythm (rolls forward), yes → task
 * (STAYS OVERDUE)" — for the whole "yes" branch. Once reminders existed and
 * took the rhythm population, the reason for it on tasks was gone. Trent,
 * 2026-09-07, on discovering the behaviour: "there's no intuitiveness to me
 * about how something at midnight magically stops being overdue and is
 * waiting for its next recurrence... How else am I going to make sure that
 * it gets done? It's been overdue ever since I didn't get it done." He asked
 * whether there was a record of him wanting the July behaviour. There was not.
 *
 * ONE EVALUATOR: `todaysOccurrence` reuses `computeNextOccurrence`, which
 * prefers `anchor_time` over BYHOUR (§4.6) — 29 of the rrules carry no BYHOUR,
 * so for those `anchor_time` is the only carrier of time-of-day.
 */

import { DateTime } from 'luxon'
import { computeNextOccurrence } from './compute-next'
import { openTaskDaySpan } from '@/lib/opentask-day'

/** The subset of a task this module needs. */
export interface OccurrenceTask {
  due_at: string | null
  rrule: string | null
  recurrence_mode?: 'from_due' | 'from_completion' | null
  anchor_time: string | null
  /** The scheduled occurrence: anchors a floating rule's grid (every N or bare; compute-next `phaseFloats`, `gridDtstart`). */
  occurrence_at?: string | null
  /**
   * On deck (2026-10-20): a decked task is never due — not over target, not
   * in the badge, never swept, never notified (docs/TASK-MODEL.md § On deck).
   */
  on_deck_day?: string | null
  /**
   * 2026-10-21: a DEADLINE-ANCHORED repeat's schedule walks its deadline, not
   * its target, so the no-target fallback below must never derive one.
   */
  repeat_anchor?: 'target' | 'deadline' | null
}

/** The occurrence a floating rule's grid (every N, or bare) is anchored at, if the item has one. */
function anchorOf(task: OccurrenceTask): Date | null {
  const iso = task.occurrence_at ?? task.due_at
  return iso ? new Date(iso) : null
}

/**
 * The occurrence scheduled for today, or null if the item has none today.
 *
 * Returns null for non-recurring items (they have no schedule) and for
 * `from_completion` items — those genuinely have no scheduled occurrence until
 * they are completed, so asserting one would invent a schedule they don't have.
 *
 * "Today" is `day`: the caller's OpenTask day (`openTaskDaySpan` — the
 * Reminders screen since 2026-10-23, the overdue fallback below since "Day
 * starts at" PR 2), so with the day starting at 3:00 a 2:00 AM occurrence
 * belongs to the evening before. With the task queue off it is the calendar
 * day (`CALENDAR_DAY_START`).
 */
export function todaysOccurrence(
  task: OccurrenceTask,
  timezone: string,
  day: { start: Date; end: Date },
): Date | null {
  if (!task.rrule) return null
  if (task.recurrence_mode === 'from_completion') return null

  // Search from just before the day's start so the first result is today's
  // occurrence if one exists.
  const justBeforeToday = new Date(day.start.getTime() - 1)

  let next: Date
  try {
    next = computeNextOccurrence({
      rrule: task.rrule,
      recurrenceMode: 'from_due',
      anchorTime: task.anchor_time,
      timezone,
      completedAt: justBeforeToday,
      prevDueAt: justBeforeToday,
      // A floating rule (every N, or bare) runs on the item's own grid (its scheduled
      // occurrence, else its date); without either, the fixed epoch.
      anchorAt: anchorOf(task),
    })
  } catch {
    // An unevaluable schedule must not make the item invisible or permanently
    // overdue — callers fall back to due_at.
    return null
  }

  if (!DateTime.fromJSDate(next).setZone(timezone).isValid) return null
  return next.getTime() < day.end.getTime() ? next : null
}

/**
 * The time this item should be treated as due, as of `now`.
 *
 * Returns null when the item is not due at all today — which for a recurring
 * item is a real answer, not a missing one. `dayStart`: the owner's day
 * boundary (`dayBoundaryForUser`) — "today" for the no-target fallback is the
 * OpenTask day.
 */
export function effectiveDueAt(
  task: OccurrenceTask,
  timezone: string,
  dayStart: string,
  now: Date = new Date(),
): Date | null {
  // ON DECK never nags (2026-10-20). A REPEATING task on deck has `due_at`
  // NULL with its occurrence kept, and without this the schedule fallback
  // below would derive today's occurrence and nag it. Every "due now" reader
  // (the badge, the notifier, each project's overdue_count, `?overdue=true`,
  // the snooze-overdue sweep, the day simulator) goes through here, so they
  // all agree. A deck WITH a target is a one-off's deadline automatic target
  // (the deadline protects regardless, A1's belt and braces): that target is
  // the truth, as below.
  if (task.on_deck_day && !task.due_at) return null

  // One-offs: due_at is the whole truth.
  if (!task.rrule) {
    return task.due_at ? new Date(task.due_at) : null
  }

  // A deadline-anchored repeat (2026-10-21) always has a target off deck
  // (`occurrenceDates`), and its rule walks the DEADLINE: today's occurrence
  // of it is no target, so with none there is nothing due.
  if (task.repeat_anchor === 'deadline') {
    return task.due_at ? new Date(task.due_at) : null
  }

  // from_completion items have no derivable schedule, so due_at is all we have.
  if (task.recurrence_mode === 'from_completion') {
    return task.due_at ? new Date(task.due_at) : null
  }

  // A recurring TASK carries debt (Trent, 2026-09-07 — see the header). Its
  // due_at is the truth whether it is ahead of us (the next occurrence, or an
  // explicit snooze) or behind us (overdue since then, and staying so until
  // done). Nothing about a new day changes that.
  if (task.due_at) {
    const due = new Date(task.due_at)
    if (!Number.isNaN(due.getTime())) return due
  }

  // No due_at at all: ask the schedule whether there is an occurrence today.
  // (A task that has never carried a date has nothing to be overdue from.)
  return todaysOccurrence(task, timezone, openTaskDaySpan(now, timezone, dayStart))
}

/**
 * Whether the item is due or overdue right now.
 *
 * The predicate the notifier, the badge, and the sweep all need.
 */
export function isCurrentlyDue(
  task: OccurrenceTask,
  timezone: string,
  dayStart: string,
  now: Date = new Date(),
): boolean {
  const due = effectiveDueAt(task, timezone, dayStart, now)
  return due !== null && due.getTime() <= now.getTime()
}
