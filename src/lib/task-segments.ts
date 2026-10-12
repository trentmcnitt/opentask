/**
 * THE DATE RULES of the task model — the one module that says, for any task
 * and any local day, where it shows (docs/TASK-MODEL.md § Deadline, target,
 * horizon; § Upcoming). Shared by the server (`src/core/tasks/task-segments.ts`,
 * which `GET /api/reminders` serves to the native apps) and the web UI, so every
 * surface reads a task the same way. Each constant is named here ONCE; nothing
 * else restates one.
 *
 * In order: the deadline's automatic target (`DEADLINE_LEAD_DAYS`) and its
 * pull-in (`DEADLINE_PULL_DAYS`); the effective horizon; the check-in day and
 * the horizon segments' days (`latestSegmentDay`); segment membership and
 * carry-over (`segmentState`); the target age; the deadline cap; the recurring
 * deadline; and UPCOMING — the wait, the heads-up days and their carry-over
 * (`headsUpDays`, `upcomingState`). Batch 2 (attempts, age thresholds, the
 * target ≤ deadline cap) adds its rules here, beside the ones they extend.
 *
 * THE MODEL IN ONE PARAGRAPH. A task's `due_at` is its TARGET: when nagging
 * starts. `deadline_at` is the real cutoff. `horizon` is how soon it should get
 * done. With no target a one-off sits in a TASK SEGMENT on the reminders
 * screen, for awareness; with a target it is quiet until the date, apart from
 * its Upcoming heads-ups (2026-10-12); once the target arrives it
 * leaves the segment and is "over target" — today's overdue under a new name,
 * nagged on the dashboard, in notifications and in the badge. Never both.
 *
 * ONE SEGMENT PER HORIZON, each on its own day (Trent, 10-10): days every day,
 * weeks every check-in day (`users.check_in_day`, Saturday by default — §3,
 * 2026-10-12), months the first check-in day of the month, eventually the
 * first check-in day of each quarter (Jan, Apr, Jul, Oct — quarterly per
 * Trent; the month is this build's call). Since 2026-10-12 a one-off with a
 * target of its own is in none of them: it is quiet until its date, apart from
 * the Upcoming heads-ups (`upcomingState`, below). A task the user has not considered since its
 * segment last came round keeps showing, day after day, until it is — "anything
 * not considered shows again the next day until it is".
 */

import { DateTime } from 'luxon'

export const HORIZON_ORDER = ['days', 'weeks', 'months', 'eventually'] as const
export type HorizonValue = (typeof HORIZON_ORDER)[number]

/**
 * A task segment's identity: a horizon, or Upcoming (2026-10-12, the heads-up
 * segment — `upcomingState`, below). In the API, `horizon: "upcoming"`.
 */
export type SegmentKind = HorizonValue | 'upcoming'

/**
 * The order the screens walk the segments: Upcoming directly after Days and
 * before Weeks, on a check-in day too (spec §2).
 */
export const SEGMENT_ORDER: readonly SegmentKind[] = [
  'days',
  'upcoming',
  'weeks',
  'months',
  'eventually',
]

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
  now: Date = new Date(),
): string | null {
  if (task.deadline_at === null || task.rrule) return null
  const deadlineMs = Date.parse(task.deadline_at)
  // A target of the user's own at or before the deadline is honored as set.
  if (task.due_at !== null && Date.parse(task.due_at) <= deadlineMs) return null
  if (task.deadline_nag_off) {
    // Silenced (remove target, or a snooze past the deadline) — but the nag
    // RE-ARMS on the deadline day itself (ruling A4, Trent 10-11): on its last
    // day a deadline task is silenced only by done, delete or the per-task nag
    // override. A task with a target of its own (a deliberate snooze past the
    // deadline) is left to that target once the deadline has passed, so a
    // snooze after the deadline still holds; with no target it keeps nagging.
    if (task.due_at !== null && deadlineMs <= now.getTime()) return null
    return deadlineDayStart(task.deadline_at, ctx)
  }
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
 * When a silenced deadline re-arms (ruling A4): the user's morning on the
 * deadline's own local day — or the deadline itself if it falls earlier.
 */
function deadlineDayStart(deadlineAt: string, ctx: TargetContext | null): string {
  const deadline = DateTime.fromISO(deadlineAt, { zone: 'utc' })
  if (!ctx) return deadline.startOf('day').toISO()!
  const [hour, minute] = ctx.morningTime.split(':').map(Number)
  const morning = deadline.setZone(ctx.timezone).set({ hour, minute, second: 0, millisecond: 0 })
  return (morning < deadline ? morning : deadline).toUTC().toISO()!
}

/**
 * The target the task nags from: the earlier of its own and the deadline's
 * implied one (which only exists when there is no target, or the target is
 * past the deadline).
 */
export function effectiveTargetAt(
  task: TargetFields,
  ctx: TargetContext | null = clientContext,
  now: Date = new Date(),
): string | null {
  const implied = impliedTargetAt(task, ctx, now)
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

/**
 * The weekday the horizon segments come round on (2026-10-12, spec §3):
 * `users.check_in_day`, in Luxon's numbering — 1 = Monday … 7 = Sunday.
 * Saturday by default, the day the segments always used. Independent of
 * `week_start` (the quota changeover), and no part of Upcoming.
 */
export type CheckInDay = 1 | 2 | 3 | 4 | 5 | 6 | 7
export const CHECK_IN_DAY_DEFAULT: CheckInDay = 6

/** A stored/sent value as a CheckInDay — anything else reads as the default. */
export function coerceCheckInDay(value: unknown): CheckInDay {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 7
    ? (value as CheckInDay)
    : CHECK_IN_DAY_DEFAULT
}

function firstCheckInDayOf(month: DateTime, checkInDay: CheckInDay): DateTime {
  const first = month.startOf('month')
  return first.plus({ days: (checkInDay - first.weekday + 7) % 7 })
}

/**
 * The most recent day, on or before `today`, that this horizon's segment comes
 * round. `today` is a local start-of-day DateTime. Weeks: every check-in day;
 * months: the first check-in day of the month; eventually: the first check-in
 * day of January, April, July and October.
 */
export function latestSegmentDay(
  horizon: HorizonValue,
  today: DateTime,
  checkInDay: CheckInDay = CHECK_IN_DAY_DEFAULT,
): DateTime {
  switch (horizon) {
    case 'days':
      return today
    case 'weeks':
      return today.minus({ days: (today.weekday - checkInDay + 7) % 7 })
    case 'months': {
      const thisMonth = firstCheckInDayOf(today, checkInDay)
      return thisMonth <= today
        ? thisMonth
        : firstCheckInDayOf(today.minus({ months: 1 }), checkInDay)
    }
    case 'eventually': {
      const quarterStart = today.startOf('quarter')
      const thisQuarter = firstCheckInDayOf(quarterStart, checkInDay)
      return thisQuarter <= today
        ? thisQuarter
        : firstCheckInDayOf(quarterStart.minus({ months: 3 }), checkInDay)
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

/** The local start of the day `iso` falls on, in `timezone`. */
export function localDay(iso: string, timezone: string): DateTime {
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
 *   last considered. A task created AFTER its segment's latest shown day waits
 *   for the next one (a weeks task added on Tuesday waits for Saturday); one
 *   created ON a shown day appears that day — a new days task shows today
 *   (Trent's rule, 2026-10-11: anything not considered is reshown until it is).
 * - Deferred today (Defer All) → 'deferred': off today's list, back tomorrow.
 *
 * A TARGET MAKES A TASK QUIET UNTIL ITS DATE (2026-10-12, spec §1): a one-off
 * with a target of its own (`due_at`) is in no horizon segment at all. Before
 * its target arrives it shows only on its Upcoming heads-up days
 * (`upcomingState`, below); after, it is over target. A deadline-only task (no
 * target of its own) stays here, its deadline pulling the horizon in.
 */
export function segmentState(
  task: SegmentTaskFields,
  timezone: string,
  now: Date,
  ctx: TargetContext | null = clientContext,
  checkInDay: CheckInDay = CHECK_IN_DAY_DEFAULT,
): { horizon: HorizonValue; state: SegmentState } | null {
  if (task.due_at !== null) return null
  if (targetIsToday(effectiveTargetAt(task, ctx, now), timezone, now)) return null
  const today = DateTime.fromJSDate(now).setZone(timezone).startOf('day')
  const horizon = effectiveHorizon(task, now)

  if (task.last_considered_at && +localDay(task.last_considered_at, timezone) === +today) {
    return { horizon, state: 'considered' }
  }
  const shownDay = latestSegmentDay(horizon, today, checkInDay)
  // Considered on or after the segment's latest shown day: done with it.
  if (task.last_considered_at && shownDay <= localDay(task.last_considered_at, timezone)) {
    return null
  }
  // Created AFTER that day: it waits for the next one. Created on it — a days
  // task today, a weeks task on a Saturday — it shows today (2026-10-11).
  if (shownDay < localDay(task.created_at, timezone)) return null

  if (task.segment_deferred_at && +localDay(task.segment_deferred_at, timezone) === +today) {
    return { horizon, state: 'deferred' }
  }
  return { horizon, state: 'waiting' }
}

/**
 * Target-age steps (spec §4; thresholds are placeholders Trent may tune). The
 * steps are three depths of ONE calm plum (`--over-target`), never red or
 * amber: an arrived target signals nothing wrong (Trent, 2026-10-11). Red is
 * kept for a passed deadline only.
 */
export const TARGET_AGE_MEDIUM_DAYS = 3
export const TARGET_AGE_STRONG_DAYS = 7
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
  const target = effectiveTargetAt(task, ctx, now)
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

export type TargetAgeTone = 'light' | 'medium' | 'strong'

export function targetAgeTone(days: number): TargetAgeTone {
  if (days >= TARGET_AGE_STRONG_DAYS) return 'strong'
  if (days >= TARGET_AGE_MEDIUM_DAYS) return 'medium'
  return 'light'
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

// ===========================================================================
// UPCOMING — the heads-up segment
// ===========================================================================

/**
 * UPCOMING — the heads-up segment (2026-10-12, spec §2; docs/TASK-MODEL.md
 * § Upcoming). Read by the server (`src/core/tasks/task-segments.ts`) and the web UI.
 *
 * A target makes a task quiet until its date (spec §1). Upcoming is the one
 * exception: a task whose target hasn't arrived shows on at most two heads-up
 * days before it. It holds one-off tasks with a target of their OWN (a
 * deadline-only task stays in its horizon segment, its deadline pulling it in)
 * and repeating tasks' next occurrences — never reminders or quotas.
 *
 * THE RULE. wait = the target's local day − the local day of `target_set_at`
 * (when the target was last set, by any path). Then:
 *   1. the day before the target, if wait ≥ 2 — a task made today for
 *      tomorrow gets none: the day before is the day you made it;
 *   2. if wait > 7, one earlier heads-up: 3 days before when wait < 16,
 *      4 days before when it is 16 or more.
 * LOCAL DAYS throughout (Luxon calendar days in the user's zone) — UTC days or
 * 24-hour math give the wrong wait across DST and late at night.
 *
 * The EFFECTIVE target (`effectiveTargetAt`): a target set after its own
 * deadline counts to the deadline's automatic target.
 *
 * CARRY-OVER. An untapped heads-up shows again the next day — as the same,
 * single row — until it is considered or the target's day comes: it shows
 * while the latest heads-up day on or before today is later than the local day
 * of `last_considered_at`. On the target's day it leaves (it is over target).
 * Never counted over target, never notified. The check-in day plays no part.
 */

/** The day-before heads-up needs at least this wait (in local days). */
export const HEADS_UP_DAY_BEFORE_MIN_WAIT = 2
/** Over this wait, one earlier heads-up as well. */
export const HEADS_UP_EARLY_AFTER_WAIT = 7
/** At or over this wait the earlier heads-up is 4 days out, under it 3. */
export const HEADS_UP_LONG_WAIT = 16
export const HEADS_UP_EARLY_LEAD_DAYS = 3
export const HEADS_UP_LONG_LEAD_DAYS = 4

/** Whole local days from `setDay` to `targetDay` (both local start-of-day). */
export function waitDays(targetDay: DateTime, setDay: DateTime): number {
  return Math.round(targetDay.diff(setDay, 'days').days)
}

/**
 * The heads-up days for a target set on `setDay`, earliest first (0, 1 or 2
 * local start-of-day DateTimes). Calendar arithmetic, so a DST change between
 * them still lands on local midnight.
 */
export function headsUpDays(targetDay: DateTime, setDay: DateTime): DateTime[] {
  const wait = waitDays(targetDay, setDay)
  const days: DateTime[] = []
  if (wait > HEADS_UP_EARLY_AFTER_WAIT) {
    const lead = wait < HEADS_UP_LONG_WAIT ? HEADS_UP_EARLY_LEAD_DAYS : HEADS_UP_LONG_LEAD_DAYS
    days.push(targetDay.minus({ days: lead }))
  }
  if (wait >= HEADS_UP_DAY_BEFORE_MIN_WAIT) days.push(targetDay.minus({ days: 1 }))
  return days
}

/** The fields the Upcoming rule reads. */
export interface UpcomingTaskFields extends TargetFields {
  target_set_at: string | null
  created_at: string
  last_completed_at?: string | null
  last_considered_at: string | null
  segment_deferred_at: string | null
}

/**
 * When the target was set: `target_set_at`, or — for a row from before the
 * column existed — `created_at`, and for a repeating task the later of that
 * and its last completion (the migration's seed, read the same way).
 */
export function targetSetAtOf(task: UpcomingTaskFields): string {
  if (task.target_set_at) return task.target_set_at
  const done = task.rrule ? (task.last_completed_at ?? null) : null
  return done && Date.parse(done) > Date.parse(task.created_at) ? done : task.created_at
}

/**
 * Whether the task belongs in Upcoming at all (whatever today is): a target
 * of its own on a one-off, or a repeating task's occurrence. The caller has
 * already left out reminders, quotas and anything done or deleted.
 */
export function upcomingCandidate(task: Pick<TargetFields, 'due_at' | 'rrule'>): boolean {
  return task.due_at !== null
}

/**
 * Where the task stands in today's Upcoming, or null when it is not there:
 * - its effective target is today or earlier (over target), or there is none;
 * - no heads-up day has come yet;
 * - it was considered on or after the latest heads-up day (but not today).
 * Considered today → 'considered' (listed ticked, so "X of Y" and put-back
 * work); Defer All today → 'deferred'; otherwise 'waiting'. `target` is the
 * effective target the row is ordered by.
 */
export function upcomingState(
  task: UpcomingTaskFields,
  timezone: string,
  now: Date,
  ctx: TargetContext | null = null,
): { state: SegmentState; target: string } | null {
  if (!upcomingCandidate(task)) return null
  const target = effectiveTargetAt(task, ctx ?? undefined, now)
  if (!target) return null
  const today = DateTime.fromJSDate(now).setZone(timezone).startOf('day')
  const targetDay = localDay(target, timezone)
  if (targetDay <= today) return null

  const heads = headsUpDays(targetDay, localDay(targetSetAtOf(task), timezone))
  const latest = [...heads].reverse().find((d) => d <= today)
  if (!latest) return null

  const considered = task.last_considered_at ? localDay(task.last_considered_at, timezone) : null
  if (considered && +considered === +today) return { state: 'considered', target }
  if (considered && considered >= latest) return null
  if (task.segment_deferred_at && +localDay(task.segment_deferred_at, timezone) === +today) {
    return { state: 'deferred', target }
  }
  return { state: 'waiting', target }
}

/**
 * The row's gap text (spec §2): "Target Tue Nov 3 · deadline Sat Nov 7 (+4d)".
 * No deadline: "Target Tue Nov 3". A target of the task's own set AFTER its
 * deadline — the deadline's automatic target is the one that counts — names
 * its own target and says so: "Target Mon Oct 26 · deadline Fri Oct 23
 * (deadline before target)". A deadline the same day as the target: "(same
 * day)". Returned in parts so the row can make the target a chip.
 */
export function upcomingGap(
  task: Pick<TargetFields, 'due_at' | 'deadline_at'>,
  timezone: string,
): { target: string | null; deadline: string | null } {
  const fmt = (iso: string) =>
    DateTime.fromISO(iso, { zone: 'utc' }).setZone(timezone).toFormat('ccc LLL d')
  const target = task.due_at ? `Target ${fmt(task.due_at)}` : null
  if (!task.deadline_at) return { target, deadline: null }
  const deadline = `deadline ${fmt(task.deadline_at)}`
  if (!task.due_at) return { target, deadline }
  const gap = waitDays(localDay(task.deadline_at, timezone), localDay(task.due_at, timezone))
  if (Date.parse(task.deadline_at) < Date.parse(task.due_at) && gap <= 0) {
    return { target, deadline: `${deadline} (deadline before target)` }
  }
  return { target, deadline: gap === 0 ? `${deadline} (same day)` : `${deadline} (+${gap}d)` }
}

/**
 * Whether an Upcoming row offers Today (and its picker) and Remove target
 * (2026-10-12). Today: one-off rows only — target-today skips a repeating
 * task (ruling Q1). Remove target: one-off rows with NO deadline — removing a
 * repeating task's target would take the recurrence with it, and what Remove
 * target does to a deadline task is being redesigned with Trent.
 */
export function upcomingRowActions(row: {
  recurring: boolean
  task: { deadline_at: string | null }
}): { today: boolean; removeTarget: boolean } {
  return { today: !row.recurring, removeTarget: !row.recurring && row.task.deadline_at === null }
}
