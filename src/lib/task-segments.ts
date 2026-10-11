/**
 * Task segments and the target age — the pure rules of the 2026-10-10 task
 * model (docs/TASK-MODEL.md § Deadline, target, horizon). Shared by the server
 * (`src/core/tasks/task-segments.ts`) and the web UI, so both read a task the
 * same way.
 *
 * THE MODEL IN ONE PARAGRAPH. A task's `due_at` is its TARGET: when nagging
 * starts. `deadline_at` is the real cutoff. `horizon` is how soon it should get
 * done. Before its target arrives (or with no target) a task sits in a TASK
 * SEGMENT on the reminders screen, for awareness; once the target arrives it
 * leaves the segment and is "over target" — today's overdue under a new name,
 * nagged on the dashboard, in notifications and in the badge. Never both.
 *
 * ONE SEGMENT PER HORIZON, each on its own day (Trent, 10-10): days every day,
 * weeks every Saturday, months the first Saturday of the month, eventually the
 * first Saturday of each quarter (Jan, Apr, Jul, Oct — quarterly per Trent; the
 * month is this build's call). A task the user has not considered since its
 * segment last came round keeps showing, day after day, until it is — "anything
 * not considered shows again the next day until it is".
 */

import { DateTime } from 'luxon'

export const HORIZON_ORDER = ['days', 'weeks', 'months', 'eventually'] as const
export type HorizonValue = (typeof HORIZON_ORDER)[number]

/** Unset reads as weeks — but is never reported as set (`task.horizon` stays null). */
export const UNSET_HORIZON: HorizonValue = 'weeks'

/** A segment this big asks for Process or AI help instead of a tap-through. */
export const SEGMENT_NUDGE_THRESHOLD = 50

/**
 * How close a deadline must be to pull the horizon in. "About 2–3 weeks out it
 * counts as weeks, about 1 week out as days" (spec §2); 90 days for months is
 * this build's call, so a deadline months away still surfaces monthly even on
 * an "eventually" task.
 */
const DEADLINE_PULL_DAYS: [number, HorizonValue][] = [
  [7, 'days'],
  [21, 'weeks'],
  [90, 'months'],
]

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * A task with a deadline and no target starts nagging this many days before
 * the deadline, at every priority (Trent, 10-10: "maybe 4 days early for all
 * priorities" — tentative, tune here). Computed, never stored, so nothing
 * drifts; `deadline_nag_off` (what remove-target sets) turns it off.
 */
export const DEADLINE_LEAD_DAYS = 4

/** The fields that decide a task's target. */
export interface TargetFields {
  due_at: string | null
  deadline_at: string | null
  deadline_nag_off?: boolean
  rrule?: string | null
}

/**
 * Whose clock the implied target is read on: the deadline's lead day starts at
 * the user's MORNING (`users.morning_time`), not at the deadline's own time of
 * day — an end-of-day deadline must not first nag at 23:59 four days out.
 * Server code always passes it (every user has their own); the browser sets
 * its one user's once (`setClientTargetContext`). Without one the lead is a
 * plain DEADLINE_LEAD_DAYS × 24h.
 */
export interface TargetContext {
  timezone: string
  morningTime: string
}

let clientContext: TargetContext | null = null

/** Browser only: the signed-in user's clock, for every implied target read. */
export function setClientTargetContext(ctx: TargetContext | null): void {
  clientContext = ctx
}

/**
 * The deadline's implied target, when it applies (2026-10-10, rulings A2/B2):
 * the morning of the day DEADLINE_LEAD_DAYS before the deadline, for a one-off
 * with a deadline whose implied nag isn't off, and which has either no target
 * or a target AFTER the deadline — a target set past its own deadline never
 * hides the deadline. A target at or before the deadline is honoured as set.
 */
export function impliedTargetAt(
  task: TargetFields,
  ctx: TargetContext | null = clientContext,
): string | null {
  if (task.deadline_at === null || task.deadline_nag_off || task.rrule) return null
  if (task.due_at !== null && Date.parse(task.due_at) <= Date.parse(task.deadline_at)) return null
  const deadline = DateTime.fromISO(task.deadline_at, { zone: 'utc' })
  if (!ctx) return deadline.minus({ days: DEADLINE_LEAD_DAYS }).toISO()!
  const [hour, minute] = ctx.morningTime.split(':').map(Number)
  return deadline
    .setZone(ctx.timezone)
    .minus({ days: DEADLINE_LEAD_DAYS })
    .set({ hour, minute, second: 0, millisecond: 0 })
    .toUTC()
    .toISO()!
}

/**
 * The target the task nags from: the earlier of its own and the deadline's
 * implied one (which only exists when there is no target, or the target is
 * past the deadline).
 */
export function effectiveTargetAt(
  task: TargetFields,
  ctx: TargetContext | null = clientContext,
): string | null {
  const implied = impliedTargetAt(task, ctx)
  if (task.due_at === null) return implied
  if (implied === null) return task.due_at
  return Date.parse(implied) < Date.parse(task.due_at) ? implied : task.due_at
}

/** The horizon a deadline implies on its own, or null when it is far enough away to imply none. */
export function deadlineHorizon(deadlineAt: string | null, now: Date): HorizonValue | null {
  if (!deadlineAt) return null
  const daysLeft = (Date.parse(deadlineAt) - now.getTime()) / DAY_MS
  for (const [limit, horizon] of DEADLINE_PULL_DAYS) {
    if (daysLeft <= limit) return horizon
  }
  return null
}

function sooner(a: HorizonValue, b: HorizonValue | null): HorizonValue {
  if (b === null) return a
  return HORIZON_ORDER.indexOf(b) < HORIZON_ORDER.indexOf(a) ? b : a
}

/**
 * The soonest of the set horizon (unset = weeks) and what the deadline implies.
 * A deadline only ever pulls a horizon IN; nothing here grows one — growth is
 * Process asking, and the user saying yes.
 */
export function effectiveHorizon(
  task: { horizon: string | null; deadline_at: string | null },
  now: Date,
): HorizonValue {
  const set = (HORIZON_ORDER as readonly string[]).includes(task.horizon ?? '')
    ? (task.horizon as HorizonValue)
    : UNSET_HORIZON
  return sooner(set, deadlineHorizon(task.deadline_at, now))
}

const SATURDAY = 6

function firstSaturdayOf(month: DateTime): DateTime {
  const first = month.startOf('month')
  return first.plus({ days: (SATURDAY - first.weekday + 7) % 7 })
}

/**
 * The most recent day, on or before `today`, that this horizon's segment comes
 * round. `today` is a local start-of-day DateTime.
 */
export function latestSegmentDay(horizon: HorizonValue, today: DateTime): DateTime {
  switch (horizon) {
    case 'days':
      return today
    case 'weeks':
      return today.minus({ days: (today.weekday - SATURDAY + 7) % 7 })
    case 'months': {
      const thisMonth = firstSaturdayOf(today)
      return thisMonth <= today ? thisMonth : firstSaturdayOf(today.minus({ months: 1 }))
    }
    case 'eventually': {
      const quarterStart = today.startOf('quarter')
      const thisQuarter = firstSaturdayOf(quarterStart)
      return thisQuarter <= today ? thisQuarter : firstSaturdayOf(quarterStart.minus({ months: 3 }))
    }
  }
}

/** The fields the segment rules read. */
export interface SegmentTaskFields {
  due_at: string | null
  deadline_at: string | null
  deadline_nag_off?: boolean
  horizon: string | null
  last_considered_at: string | null
  segment_deferred_at: string | null
  created_at: string
}

export type SegmentState = 'waiting' | 'considered' | 'deferred'

function localDay(iso: string, timezone: string): DateTime {
  return DateTime.fromISO(iso, { zone: 'utc' }).setZone(timezone).startOf('day')
}

/**
 * Whether the task's target has arrived for segment purposes: any target on
 * today or earlier. A target later TODAY already counts — "target today" is a
 * commitment for today, so the task leaves the segment the moment it is set
 * rather than showing in both places until the hour comes.
 */
export function targetIsToday(dueAt: string | null, timezone: string, now: Date): boolean {
  if (!dueAt) return false
  const today = DateTime.fromJSDate(now).setZone(timezone).startOf('day')
  return localDay(dueAt, timezone) <= today
}

/**
 * Where this task stands in today's segment, or null when it does not appear
 * today. Assumes the caller already chose a segment-eligible task (open,
 * one-off, not a reminder or quota — `src/core/tasks/task-segments.ts`).
 *
 * - Considered today → 'considered' (shown ticked, so the segment can go green).
 * - Otherwise it appears when its segment has come round since it was last
 *   seen. "Seen" is the later of its last consider and its creation: writing a
 *   task down is seeing it, so a weeks task added on Tuesday waits for
 *   Saturday instead of appearing the moment it exists.
 * - Deferred today (Defer All) → 'deferred': off today's list, back tomorrow.
 */
export function segmentState(
  task: SegmentTaskFields,
  timezone: string,
  now: Date,
  ctx: TargetContext | null = clientContext,
): { horizon: HorizonValue; state: SegmentState } | null {
  if (targetIsToday(effectiveTargetAt(task, ctx), timezone, now)) return null
  const today = DateTime.fromJSDate(now).setZone(timezone).startOf('day')
  const horizon = effectiveHorizon(task, now)

  if (task.last_considered_at && +localDay(task.last_considered_at, timezone) === +today) {
    return { horizon, state: 'considered' }
  }
  const seen = [task.last_considered_at, task.created_at]
    .filter((v): v is string => v !== null)
    .map((v) => localDay(v, timezone))
    .reduce((a, b) => (a > b ? a : b))
  if (latestSegmentDay(horizon, today) <= seen) return null

  if (task.segment_deferred_at && +localDay(task.segment_deferred_at, timezone) === +today) {
    return { horizon, state: 'deferred' }
  }
  return { horizon, state: 'waiting' }
}

/** Target-age color steps (spec §4; placeholders Trent may tune). */
export const TARGET_AGE_AMBER_DAYS = 3
export const TARGET_AGE_RED_DAYS = 7
/** Process's one-tap "remove targets aged 7d+" threshold. */
export const STALE_TARGET_DAYS = 7

/**
 * Whole local days since the task's FIRST target (`original_due_at`, which a
 * snooze keeps and a deliberate re-target resets), or null when the task has
 * no target, its target has not arrived, or it is the target day itself — the
 * badge is blank then (Trent, 10-10: "no word on the badge for the target day").
 */
export function targetAgeDays(
  task: TargetFields & { original_due_at: string | null; created_at?: string },
  timezone: string,
  now: Date,
  ctx: TargetContext | null = clientContext,
): number | null {
  const target = effectiveTargetAt(task, ctx)
  if (!target || Date.parse(target) > now.getTime()) return null
  // Its own target counts from its first one; an implied target from itself.
  // Never from before the task existed (2026-10-11): a task created with a
  // deadline 3 days out has an implied target a day BEFORE it was created, and
  // its age is how long it has been on the list, not "1d" on its first day.
  const from = target === task.due_at ? (task.original_due_at ?? task.due_at) : target
  const first =
    task.created_at && Date.parse(task.created_at) > Date.parse(from) ? task.created_at : from
  const today = DateTime.fromJSDate(now).setZone(timezone).startOf('day')
  const days = Math.round(today.diff(localDay(first, timezone), 'days').days)
  return days > 0 ? days : null
}

export type TargetAgeTone = 'gray' | 'amber' | 'red'

export function targetAgeTone(days: number): TargetAgeTone {
  if (days >= TARGET_AGE_RED_DAYS) return 'red'
  if (days >= TARGET_AGE_AMBER_DAYS) return 'amber'
  return 'gray'
}

/** Whether a deadline has passed — the over-target row's past-deadline marker. */
export function isPastDeadline(deadlineAt: string | null, now: Date): boolean {
  return deadlineAt !== null && Date.parse(deadlineAt) < now.getTime()
}

/**
 * Whether snoozing a task's target to `until` is capped by its deadline: the
 * deadline is still ahead and `until` is past it. Once a deadline has passed
 * the cap is off — snooze works as it always did and the row carries the
 * past-deadline marker; nagging continues (Trent, 10-10). PROVISIONAL.
 */
export function crossesDeadline(
  deadlineAt: string | null,
  until: string,
  now: Date = new Date(),
): boolean {
  if (deadlineAt === null) return false
  const deadline = Date.parse(deadlineAt)
  return deadline > now.getTime() && Date.parse(until) > deadline
}

/**
 * A recurring task's deadline for its next occurrence (2026-10-10, spec §4):
 * the same distance from the new occurrence as it was from the current one, so
 * the weekly Upwork lock moves with the week. Left alone on a stale one, a
 * deadline would cap every later snooze. Measured from the occurrence ORIGIN
 * (`original_due_at`), not a snoozed `due_at`, so snoozing never shifts it.
 */
export function advanceDeadline(
  task: { deadline_at: string | null; due_at: string | null; original_due_at: string | null },
  nextDueAt: string | null,
  timezone: string,
): string | null {
  const origin = task.original_due_at ?? task.due_at
  if (!task.deadline_at || !nextDueAt || !origin) return task.deadline_at
  // In LOCAL WALL-CLOCK time, so a DST change between occurrences doesn't
  // shift it by an hour: the same number of calendar days after the
  // occurrence, at the deadline's own local time of day.
  const from = DateTime.fromISO(origin, { zone: 'utc' }).setZone(timezone)
  const deadline = DateTime.fromISO(task.deadline_at, { zone: 'utc' }).setZone(timezone)
  const days = Math.round(deadline.startOf('day').diff(from.startOf('day'), 'days').days)
  return DateTime.fromISO(nextDueAt, { zone: 'utc' })
    .setZone(timezone)
    .plus({ days })
    .set({
      hour: deadline.hour,
      minute: deadline.minute,
      second: deadline.second,
      millisecond: deadline.millisecond,
    })
    .toUTC()
    .toISO()!
}
