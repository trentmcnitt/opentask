/**
 * THE DATE RULES of the task model — the one module that says, for any task
 * and any local day, where it shows (docs/TASK-MODEL.md § Deadline, target,
 * horizon; § Upcoming). Shared by the server (`src/core/tasks/task-segments.ts`,
 * which `GET /api/reminders` serves to the native apps) and the web UI, so every
 * surface reads a task the same way. Each constant is named here ONCE; nothing
 * else restates one.
 *
 * In order: the deadline pull-in (`DEADLINE_PULL_DAYS`); the deadline's stored
 * automatic target (`autoTargetAt`, §8), the target ≤ deadline cap
 * (`capAtDeadline`) and the picker's "Morning of the deadline"; the effective horizon; the
 * check-in day and the horizon segments' days (`latestSegmentDay`); segment
 * membership and carry-over (`segmentState`); the two badges (§7: the age
 * thresholds, `ageLabel`, and attempts, `effectiveAttempts`); a repeating
 * task's occurrence dates (`occurrenceDates`: the target and the deadline of
 * a deadline-anchored repeat); and UPCOMING — the wait, the one lead table
 * (`deadlineLeadDays`, shared with the auto target and the deadlines page),
 * the Later and Tomorrow days and Later's carry-over (`upcomingDays`,
 * `upcomingState`).
 *
 * THE MODEL IN ONE PARAGRAPH. A task's `due_at` is its TARGET: when nagging
 * starts. `deadline_at` is the real cutoff, and the target never passes it; a
 * deadline with no target the user picked carries a stored AUTOMATIC target
 * (`target_auto`, §8). `horizon` is how soon it should get done. With no
 * picked target a one-off sits in a TASK SEGMENT on the reminders screen, for
 * awareness; with a picked target it is quiet until the date, apart from its
 * Upcoming heads-ups (2026-10-12); once the target arrives it leaves the
 * segment and is "over target" — today's overdue under a new name, nagged on
 * the dashboard, in notifications and in the badge. Never both. A repeating
 * task keeps its scheduled occurrence (`occurrence_at`) apart from its target;
 * a deadline-anchored one's occurrence is its deadline (`occurrenceDates`).
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
import { computeNextOccurrence, ruleTimeOfDay } from '@/core/recurrence/compute-next'
import { formatAnchorTime } from '@/core/recurrence/timezone'
import {
  CALENDAR_DAY_START,
  addDays,
  calendarDateOf,
  isLateNight,
  localMoment,
  openTaskDayOf,
  openTaskLocalDay,
  targetOpenTaskDay,
} from '@/lib/opentask-day'
import { NIGHT_SUFFIX } from '@/lib/night-day'
import type { RepeatAnchor } from '@/types'

export const HORIZON_ORDER = ['days', 'weeks', 'months', 'eventually'] as const
export type HorizonValue = (typeof HORIZON_ORDER)[number]

/**
 * The task queue's two panels (task queue PR 3, 2026-10-19; design rules 6-8,
 * docs/TASK-MODEL.md § The task queue). Code words only — the titles on screen
 * are `QUEUE_PANEL_TITLES` in task-model-words.ts:
 * - `queue_today`: queued at or after the latest rollover ("Today's pulls");
 * - `queue_previous`: queued before it ("Previous pulls").
 * Only with the server switch on (`OPENTASK_TASK_QUEUE`); `queueKind`, below.
 */
export const QUEUE_KINDS = ['queue_today', 'queue_previous'] as const
export type QueueKind = (typeof QUEUE_KINDS)[number]

/**
 * A task segment's identity: a horizon, Upcoming (2026-10-12, the heads-up
 * segment — `upcomingState`, below), one of the queue's two panels, or the
 * DEADLINES page (2026-10-22, `deadlinePlace` below). In the API,
 * `horizon: "upcoming"` / `"queue_today"` / `"queue_previous"` / `"deadlines"`.
 */
export type SegmentKind = HorizonValue | 'upcoming' | QueueKind | 'deadlines'

/** Whether a segment is one of the task queue's panels. */
export function isQueueKind(kind: SegmentKind): kind is QueueKind {
  return kind === 'queue_today' || kind === 'queue_previous'
}

/**
 * Whether the server sends this segment only with the task-queue switch on:
 * the queue's two panels and the deadlines page (2026-10-22). A client that
 * receives one knows the switch is on before its preferences load.
 */
export function onlyWithQueue(kind: SegmentKind): boolean {
  return isQueueKind(kind) || kind === 'deadlines'
}

/**
 * "X of Y" for a segment, the slots' count (Trent, 2026-10-11): X is what was
 * handled today and Y everything that came round today, so the number climbs
 * rather than counting down. ONE rule for every panel (the queue's two,
 * Upcoming, the horizons; /reminders sections and the dashboard pager alike).
 *
 * Since 2026-10-22 (Trent's phone review, "29 of 44" → "29 of 43" after a
 * deck): handled is considered, deferred, AND decked, targeted (Today) or
 * done — a row that leaves the segment that way stays in it as a considered
 * row (`left`, the server's day roster, src/core/tasks/segment-roster.ts), so
 * acting on a row raises X and never shrinks Y. Only a row that left
 * unhandled (trashed, its heads-up over) drops out of Y.
 */
export function segmentCounts(segment: {
  rows: readonly unknown[]
  considered: number
  deferred: number
}): { handled: number; total: number } {
  return { handled: segment.considered + segment.deferred, total: segment.rows.length }
}

/**
 * The order the screens walk the segments: the DEADLINES page first (Trent,
 * 10-22: "the deadlines page is FIRST in the queue carousel" — it is the only
 * queue page that nags), then the queue's two panels (spec rule 6: "the first
 * and foremost thing to handle"), then Upcoming directly after Days and before
 * Weeks, on a check-in day too (spec §2).
 */
export const SEGMENT_ORDER: readonly SegmentKind[] = [
  'deadlines',
  'queue_today',
  'queue_previous',
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

/** The fields that decide a task's target. */
export interface TargetFields {
  due_at: string | null
  deadline_at: string | null
  /**
   * The target is the deadline's AUTOMATIC one (§8, 2026-10-12): stored, not
   * computed, and set by the server whenever a one-off has a deadline and no
   * target the user picked. Absent reads as picked.
   */
  target_auto?: boolean
  rrule?: string | null
}

/**
 * Whose clock a deadline's automatic target is read on: its lead day starts at
 * the user's MORNING (`users.morning_time`), not at the deadline's own time of
 * day — an end-of-day deadline must not first nag at 23:59 days out. Server
 * code always passes it (every user has their own); the browser sets its one
 * user's once (`setClientTargetContext`) for the editor's "auto" preview.
 */
export interface TargetContext {
  timezone: string
  morningTime: string
}

let clientContext: TargetContext | null = null

/** Browser only: the signed-in user's clock, for the editor's auto-target preview. */
export function setClientTargetContext(ctx: TargetContext | null): void {
  clientContext = ctx
}

/**
 * Whether the task has a target the USER picked (§8.5, 2026-10-12): a target
 * that is not the deadline's automatic one. Only a picked target makes a task
 * quiet until its date (no horizon segment, Upcoming heads-ups). An automatic
 * target leaves the task on its horizon rhythm until it arrives, then nags.
 */
export function hasPickedTarget(task: Pick<TargetFields, 'due_at' | 'target_auto'>): boolean {
  return task.due_at !== null && !task.target_auto
}

/** The user's morning on `day` (a local DateTime). */
function morningOn(day: DateTime, ctx: TargetContext): DateTime {
  const [hour, minute] = ctx.morningTime.split(':').map(Number)
  return day.set({ hour, minute, second: 0, millisecond: 0 })
}

/**
 * THE DEADLINE'S AUTOMATIC TARGET (§8.1, 2026-10-12 — replaces the read-time
 * implied target, `deadline_nag_off` and the deadline-day re-arm). Setting a
 * deadline with no target stores a real target, by the WAIT — local days from
 * now (when the deadline is set) to the deadline's day — through the ONE lead
 * table a deadline-anchored repeat's default uses too (`leadTargetFor`,
 * 2026-10-21, Trent: "one rule everywhere"): under 2 days the deadline day at
 * the user's morning (or the deadline's own time if earlier); 2–7 the day
 * before; 8–15 three days before; 16 or more four — at the morning. A moment
 * already past is now (ruling Q10): the task is over target at once. Never
 * after the deadline (target ≤ deadline, §8.2), so a deadline already past
 * gives the deadline itself. Only new or changed deadlines take it: a stored
 * automatic target is re-derived only when its deadline is next written.
 *
 * Example (Chicago, morning 9:00): deadline Fri Oct 23 23:59, set Mon Oct 12 →
 * wait 11, lead 3 → Tue Oct 20, 9:00 AM. Set Sep 30 (wait 23) → lead 4 → Mon
 * Oct 19, 9:00 AM. Set Mon Oct 19 (wait 4) → the day before, Thu Oct 22,
 * 9:00 AM (it was 3 days before until 2026-10-21).
 *
 * "Back to auto" recomputes it from the moment it is pressed: nothing records
 * when the deadline was first set, so it is the auto target for this deadline
 * as of now.
 */
export function autoTargetAt(
  deadlineAt: string,
  ctx: TargetContext | null = clientContext,
  now: Date = new Date(),
): string {
  const deadline = DateTime.fromISO(deadlineAt, { zone: 'utc' })
  if (deadline.toMillis() <= now.getTime()) return deadlineAt
  const zone = ctx?.timezone ?? 'utc'
  const local = deadline.setZone(zone)
  const deadlineDay = local.startOf('day')
  const wait = waitDays(deadlineDay, DateTime.fromJSDate(now).setZone(zone).startOf('day'))
  let at: DateTime
  if (ctx) {
    const lead = leadTargetFor(wait, local.toFormat('HH:mm'), ctx.morningTime)
    const day = deadlineDay.minus({ days: lead.days_before }).toISODate()!
    at = DateTime.fromJSDate(localMoment(day, lead.time, zone)).setZone(zone)
  } else {
    at = deadlineDay.minus({ days: deadlineLeadDays(wait) })
  }
  if (at.toMillis() <= now.getTime()) return now.toISOString()
  return (at < deadline ? at : deadline).toUTC().toISO()!
}

/**
 * TARGET ≤ DEADLINE WHILE THE DEADLINE IS AHEAD (§8.2; Trent's ruling,
 * 2026-10-12). Every move — a single PATCH, a snooze, a quick snooze, a bulk
 * snooze or edit, snooze-overdue, the picker, Today — is capped here while the
 * deadline is still in the future. There is no "past the deadline anyway"
 * while it is ahead: to go later, change or remove the deadline.
 *
 * ONCE THE DEADLINE HAS PASSED the cap is off: any target can be picked, and
 * the row keeps its red "past deadline" marker. A bulk sweep treats such a
 * task like High (`bulkSnoozeTier` in src/core/tasks/bulk.ts), so it is moved
 * only once nothing lower is left in the batch.
 */
export function capAtDeadline(
  dueAt: string,
  deadlineAt: string | null,
  now: Date = new Date(),
): string {
  return capsAt(dueAt, deadlineAt, now) ? deadlineAt! : dueAt
}

/**
 * Whether the cap pulls `dueAt` back: it lies after a deadline that is still
 * ahead of `now`.
 */
export function capsAt(dueAt: string, deadlineAt: string | null, now: Date = new Date()): boolean {
  return (
    deadlineAt !== null &&
    Date.parse(deadlineAt) > now.getTime() &&
    Date.parse(dueAt) > Date.parse(deadlineAt)
  )
}

/** What a write would leave on a task, for `resolveTarget`. */
export interface TargetWrite {
  /** The target the write leaves (its own `due_at`, or the row's if it sends none). */
  dueAt: string | null
  /** The write sets the target itself: a move, a clear, a schedule change. */
  dueWritten: boolean
  /** The row's current `target_auto`. */
  wasAuto: boolean
  /** The deadline the write leaves. */
  deadlineAt: string | null
  /** The write changes the deadline's value. */
  deadlineChanged: boolean
  /**
   * The row the write leaves can carry an automatic target: a one-off (no
   * rule), not a reminder, not a quota. Repeating tasks never do — their
   * occurrence is their target.
   */
  autoEligible: boolean
  /**
   * THE DEADLINES PAGE (2026-10-22; the task-queue switch on — the server
   * passes `taskQueueEnabled()`, plan A1): no automatic target is ever
   * written. A deadline with no target is left target-less: its LEAD day
   * (`lead_from`, `leadFor`) puts it on the deadlines page instead. Off: the
   * automatic target, as before (kept one release, then deleted).
   */
  leads?: boolean
  /**
   * RELATIVE TARGETS (2026-10-24): on a row that stays a one-off
   * (`autoEligible`), the offsets the write leaves — the ones sent merged over
   * the stored ones — or null for none. Omitted: not judged (a repeat; its
   * offsets are the schedule's, `planRepeatSchedule`).
   */
  relative?: RelativeTarget | null
  /** The write sends the offsets or their time (a period retime too): re-derive. */
  relativeWritten?: boolean
}

export interface ResolvedTarget {
  dueAt: string | null
  /** `target_auto` after the write. */
  auto: boolean
  /** The target was pulled back to the deadline (§8.2). */
  capped: boolean
  /**
   * The one-off's relative target after the write (`TargetWrite.relative`):
   * kept, or null — a pick, a clear or a removed deadline made it fixed.
   * Undefined when the write did not ask.
   */
  relative?: RelativeTarget | null
}

/**
 * RELATIVE TARGETS (2026-10-24; docs/TASK-MODEL.md § Relative targets): what a
 * write does to a one-off's relative target, in order —
 *  1. a non-null target written (a pick, any defer, Today) makes it FIXED: the
 *     offsets and the link go, the target is the one sent;
 *  2. `target_at: null` clears everything (Remove target, decking);
 *  3. the deadline set to null makes it fixed where it is (ruling 5);
 *  4. otherwise, when the deadline or the offsets change, the target is
 *     DERIVED (`relativeTargetAt`) — already past is overdue at once (ruling 3).
 * Null when the write leaves no relative target; else the (possibly derived)
 * target.
 */
function resolveRelative(
  w: TargetWrite,
  timezone: string,
): { relative: RelativeTarget | null; derived: string | null } {
  const relative = w.relative ?? null
  if (!relative || w.dueWritten || w.deadlineAt === null) return { relative: null, derived: null }
  // A relative row always carries its target; one without (never written so) derives it.
  const rederive = w.deadlineChanged || w.relativeWritten || w.dueAt === null
  return { relative, derived: rederive ? relativeTargetAt(w.deadlineAt, relative, timezone) : null }
}

/**
 * THE TARGET A WRITE LEAVES (§8, 2026-10-12). Every writer of `due_at` or
 * `deadline_at` on an ordinary task asks this — the single PATCH, bulk edit,
 * bulk snooze and snooze-overdue (all through `collectFieldChanges`), create,
 * and AI enrichment — so the two invariants hold however a task is written:
 *
 *  - A one-off with a deadline always has a target (§8.1): with none, it gets
 *    the deadline's automatic one (`autoTargetAt`, `auto: true`). So clearing
 *    the target of a deadline task — "Back to auto", or an old client's
 *    Remove target — puts the automatic target back (§8.3).
 *  - The target is never after a deadline that is still ahead (§8.2):
 *    `capAtDeadline`. Once the deadline has passed, any target goes.
 *
 * And the automatic target follows its deadline (§8.4): a deadline change
 * re-derives it, removing the deadline removes it. A target the user picked
 * stays put on a deadline change, pulled back if the new deadline is earlier,
 * and survives the deadline's removal. Any target the write sets itself is a
 * picked one (`auto: false`).
 *
 * Once the deadline has PASSED there is no cap (Trent's ruling, 2026-10-12):
 * the target goes where it is sent.
 */
export function resolveTarget(
  w: TargetWrite,
  ctx: TargetContext | null = clientContext,
  now: Date = new Date(),
): ResolvedTarget {
  // Relative targets (2026-10-24): judged first, before the automatic target.
  if (w.relative !== undefined && w.autoEligible) {
    const rel = resolveRelative(w, ctx?.timezone ?? 'utc')
    if (rel.relative) {
      return {
        dueAt: rel.derived ?? w.dueAt,
        auto: false,
        capped: false,
        relative: rel.relative,
      }
    }
    return { ...resolveFixed(w, ctx, now), relative: null }
  }
  return resolveFixed(w, ctx, now)
}

/** `resolveTarget` for a target that is not relative: the automatic one, and the cap. */
function resolveFixed(w: TargetWrite, ctx: TargetContext | null, now: Date): ResolvedTarget {
  let dueAt = w.dueAt
  let auto = w.wasAuto && !w.dueWritten && w.autoEligible
  if (auto && (w.deadlineChanged || w.deadlineAt === null)) {
    dueAt = null
    auto = false
  }
  // The deadlines page (switch on): a deadline with no target stays without
  // one — clearing a target on a deadline task is a real Remove target, and a
  // leftover automatic target (an old undo entry) goes with its deadline.
  if (!w.leads && w.autoEligible && w.deadlineAt !== null && dueAt === null) {
    return { dueAt: autoTargetAt(w.deadlineAt, ctx, now), auto: true, capped: false }
  }
  if (dueAt !== null && capsAt(dueAt, w.deadlineAt, now)) {
    return { dueAt: w.deadlineAt, auto, capped: true }
  }
  return { dueAt, auto, capped: false }
}

/**
 * The picker's "Morning of the deadline" (ruling Q8): the user's morning on the
 * deadline's own local day — or the deadline itself, if that is earlier. L9
 * (part 2, 2026-10-26): a deadline between midnight and a day start at or
 * before 12:00 counts on the evening before ("Deadline Thu night" for Fri
 * 01:00 with a 3:00 AM start), so its morning is Thursday's, not Friday's.
 * With a start after 12:00 there is no night, and the day is the deadline's
 * calendar date as it always was: with an 11 PM start a Tue 23:47 deadline is
 * on Wednesday's list, but its morning is Tuesday 9:00, not Wednesday's (after
 * the deadline, so the pick collapsed to the deadline itself).
 */
export function deadlineDayTarget(
  deadlineAt: string,
  ctx: TargetContext,
  /** The user's day boundary (`useDayStart`). */
  dayStart: string,
): string {
  const deadline = DateTime.fromISO(deadlineAt, { zone: 'utc' })
  const at = deadline.toJSDate()
  const day = isLateNight(at, ctx.timezone, dayStart)
    ? openTaskLocalDay(at, ctx.timezone, dayStart)
    : DateTime.fromISO(calendarDateOf(at, ctx.timezone), { zone: ctx.timezone })
  const morning = morningOn(day, ctx)
  return (morning < deadline ? morning : deadline).toUTC().toISO()!
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
  target_auto?: boolean
  horizon: string | null
  last_considered_at: string | null
  segment_deferred_at: string | null
  created_at: string
  /** On deck (2026-10-20): a deck is a plan, so the task is in no horizon segment. */
  on_deck_day?: string | null
}

export type SegmentState = 'waiting' | 'considered' | 'deferred'

/**
 * How a row that LEFT its segment today was handled (the day roster,
 * src/core/tasks/segment-roster.ts; the API's `segment_left`): done, decked,
 * targeted (Today), considered out of the queue, or — the deadlines page
 * (2026-10-22) — its lead day DEFERRED (Defer is acting: nag-map ruling 3,
 * "silencing = acting"; the row reads "· deferred to Thu" from `lead_from`).
 * Such a row is considered.
 */
export type SegmentLeft = 'done' | 'deck' | 'target' | 'considered' | 'deferred'

/**
 * The OPENTASK day `iso` falls on, as a local start-of-day DateTime in
 * `timezone` ("Day starts at" PR 2, Trent 2026-10-24: everything uses the
 * OpenTask date — `openTaskLocalDay`). `dayStart` is the user's day boundary:
 * `dayBoundaryForUser` on the server, `useDayStart` in the browser —
 * `CALENDAR_DAY_START` (the switch off) is the calendar day. With 3:00 AM,
 * 01:30 belongs to the day before; every rule below does calendar maths on
 * this date.
 */
export function localDay(iso: string, timezone: string, dayStart: string): DateTime {
  return openTaskLocalDay(new Date(iso), timezone, dayStart)
}

/**
 * Whether the task's target has arrived for segment purposes: any target on
 * today or earlier — OpenTask days (`localDay`), so with the day starting at
 * 3:00 a 1:30 AM target is the evening's day. A target later TODAY already
 * counts — "target today" is a commitment for today, so the task leaves the
 * segment the moment it is set rather than showing in both places until the
 * hour comes.
 */
export function targetIsToday(
  dueAt: string | null,
  timezone: string,
  now: Date,
  dayStart: string,
): boolean {
  if (!dueAt) return false
  return localDay(dueAt, timezone, dayStart) <= openTaskLocalDay(now, timezone, dayStart)
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
 * A PICKED TARGET MAKES A TASK QUIET UNTIL ITS DATE (2026-10-12, spec §1, §8.5):
 * a one-off with a target the user picked is in no horizon segment at all.
 * Before its target arrives it shows only on its Upcoming heads-up days
 * (`upcomingState`, below); after, it is over target. A deadline task whose
 * target is the AUTOMATIC one stays here, its deadline pulling the horizon
 * in, until that target's day comes — then it nags.
 */
export function segmentState(
  task: SegmentTaskFields,
  timezone: string,
  now: Date,
  /** The user's day boundary (`localDay`): every "day" here is an OpenTask day. */
  dayStart: string,
  checkInDay: CheckInDay = CHECK_IN_DAY_DEFAULT,
): { horizon: HorizonValue; state: SegmentState } | null {
  if (hasPickedTarget(task)) return null
  // ON DECK is quiet like a picked target (B6): no horizon segment. A future
  // deck shows in Upcoming on its heads-up days, today's in the On deck section.
  if (task.on_deck_day) return null
  if (targetIsToday(task.due_at, timezone, now, dayStart)) return null
  // Today's OpenTask date: the check-in day is that date's weekday, so with
  // the day starting at 3:00, Saturday's segments are still Saturday's at
  // 01:30 on Sunday.
  const today = openTaskLocalDay(now, timezone, dayStart)
  const dayOf = (iso: string) => localDay(iso, timezone, dayStart)
  const horizon = effectiveHorizon(task, now)

  if (task.last_considered_at && +dayOf(task.last_considered_at) === +today) {
    return { horizon, state: 'considered' }
  }
  const shownDay = latestSegmentDay(horizon, today, checkInDay)
  // Considered on or after the segment's latest shown day: done with it.
  if (task.last_considered_at && shownDay <= dayOf(task.last_considered_at)) {
    return null
  }
  // Created AFTER that day: it waits for the next one. Created on it — a days
  // task today, a weeks task on a Saturday — it shows today (2026-10-11).
  if (shownDay < dayOf(task.created_at)) return null

  if (task.segment_deferred_at && +dayOf(task.segment_deferred_at) === +today) {
    return { horizon, state: 'deferred' }
  }
  return { horizon, state: 'waiting' }
}

// ===========================================================================
// THE TWO BADGES (spec §7, 2026-10-12 — Trent: "separate signals")
// ===========================================================================

/**
 * AGE — only a task with NEITHER a target NOR a deadline (truly undated),
 * counted from `created_at`, and shown only past one threshold per horizon
 * (unset reads as weeks). Fixed labels (ruling Q6). The SAME thresholds are
 * Process's growth thresholds (ruling Q7, `growthAsk` in process-rules.ts):
 * one set. They replaced the row's "Xd old" text and Process's 14/60/180-day
 * growth clock.
 */
export const AGE_THRESHOLDS: Record<HorizonValue, { days?: number; months?: number }> = {
  days: { days: 7 },
  weeks: { months: 1 },
  months: { months: 3 },
  eventually: { months: 6 },
}

export const AGE_LABELS: Record<HorizonValue, string> = {
  days: '>1 wk',
  weeks: '>1 mo',
  months: '>3 mo',
  eventually: '>6 mo',
}

/** A stored horizon as a HorizonValue, unset read as weeks. */
export function setHorizonOrUnset(horizon: string | null): HorizonValue {
  return (HORIZON_ORDER as readonly string[]).includes(horizon ?? '')
    ? (horizon as HorizonValue)
    : UNSET_HORIZON
}

/**
 * Whether `since` is past this horizon's threshold at `now` — strictly past:
 * a weeks task is ">1 mo" from one calendar month after `since` (calendar
 * arithmetic in `timezone`, UTC when not given). Shared by the age badge and
 * Process's growth ask.
 */
export function pastAgeThreshold(
  horizon: HorizonValue,
  since: string,
  now: Date,
  timezone = 'utc',
): boolean {
  const limit = DateTime.fromISO(since, { zone: 'utc' })
    .setZone(timezone)
    .plus(AGE_THRESHOLDS[horizon])
  return now.getTime() > limit.toMillis()
}

/** The fields the badges read. */
export interface BadgeTaskFields {
  due_at: string | null
  deadline_at: string | null
  target_auto?: boolean
  rrule?: string | null
  horizon?: string | null
  created_at: string
  target_set_at?: string | null
  last_completed_at?: string | null
  done?: boolean
  deleted_at?: string | null
  is_reminder?: boolean
  is_tracked?: boolean
  progress_target?: number
  attempts?: number
  attempts_counted_through?: string | null
  /** On deck (2026-10-20): a deck is a plan — no age badge (B7). */
  on_deck_day?: string | null
}

function isQuotaOrReminder(task: BadgeTaskFields): boolean {
  return !!task.is_reminder || !!task.is_tracked || (task.progress_target ?? 1) > 1
}

/**
 * The age badge's label (">1 mo"), or null: not undated, a repeating task, a
 * reminder or quota, done, or not yet past its horizon's threshold.
 */
export function ageLabel(task: BadgeTaskFields, now: Date, timezone = 'utc'): string | null {
  if (task.due_at !== null || task.deadline_at !== null || task.rrule) return null
  if (task.on_deck_day) return null
  if (isQuotaOrReminder(task) || task.done) return null
  const horizon = setHorizonOrUnset(task.horizon ?? null)
  return pastAgeThreshold(horizon, task.created_at, now, timezone) ? AGE_LABELS[horizon] : null
}

/**
 * ATTEMPTS — any task that can go over target: an ordinary open task (its own
 * target, a repeating occurrence, or a deadline's automatic target). Never a
 * reminder or a quota, which are never over target.
 *
 * AN ATTEMPT = A LOCAL DAY ON WHICH THE TASK WAS OVER TARGET (rulings Q5, Q10).
 * The day counts the MOMENT the task goes over target ("1×" at once), once per
 * local day: moves the same day add nothing, and days before the target never
 * count — so moving a target that hasn't arrived adds nothing.
 *
 * STORAGE: `attempts` (the count) and `attempts_counted_through` (the last
 * local date, yyyy-MM-dd, already counted). Between two writes the target is
 * constant, and a task over target stays over target, so the days since the
 * checkpoint are exactly the local days from the latest of
 *   - the day after `attempts_counted_through`,
 *   - the target's local day,
 *   - the local day the target was SET (`target_set_at` — before it this
 *     target did not exist, so a target set today to yesterday counts today
 *     only),
 *   - the task's creation day,
 * through today if the target has arrived (else through yesterday). That is
 * `effectiveAttempts`: computed on every read (server `rowToTask`, and the web
 * row at render, so "1×" appears the moment the target passes), persisted by
 * the minute cron (`persistAttempts`) and — the checkpoint — by every write
 * that moves the target, from the row BEFORE the move
 * (`src/core/tasks/target-set.ts`).
 *
 * RESETS only on done, and on each new occurrence of a repeating task (done or
 * skip): attempts 0, checkpoint cleared. Removing the target FREEZES the count
 * (no target, nothing counts); it resumes if the task is retargeted and goes
 * over target again. The badge shows only while the task has a target.
 */
export const ATTEMPTS_OFFER_REMOVE = 3
/** The attempts tab's tones, one calm plum: 1–2 light, 3–6 medium, 7+ strong. */
export const ATTEMPTS_MEDIUM = 3
export const ATTEMPTS_STRONG = 7

/** Whether the task can go over target at all (and so count attempts). */
export function canAttempt(task: BadgeTaskFields): boolean {
  return !isQuotaOrReminder(task) && !task.done && !task.deleted_at
}

/** `attempts_counted_through`'s format: a local calendar date. */
export const ATTEMPTS_DATE_FORMAT = 'yyyy-MM-dd'

/**
 * The task's attempts as of `now`, in the owner's `timezone`: the stored
 * checkpoint plus the over-target local days since it (see above). Pure; no
 * write. With no target, or nothing new to count, the stored values.
 */
export function effectiveAttempts(
  task: BadgeTaskFields,
  timezone: string,
  now: Date,
  /**
   * The owner's rollover time (HH:MM) when the task queue is on (B7,
   * 2026-10-19): every "day" below is then an OPENTASK day, rollover to
   * rollover (`openTaskDayOf`) — 00:00–06:29 belongs to the day before, so a
   * night owl's 2 AM miss is the evening's attempt, not a new one — and
   * `attempts_counted_through` names an OpenTask day (same format). Omitted
   * or null: local calendar days, as before the queue.
   */
  rolloverTime: string | null,
): { attempts: number; countedThrough: string | null } {
  const stored = {
    attempts: task.attempts ?? 0,
    countedThrough: task.attempts_counted_through ?? null,
  }
  if (!task.due_at || !canAttempt(task)) return stored
  const setAt =
    task.target_set_at ??
    (task.rrule && task.last_completed_at && task.last_completed_at > task.created_at
      ? task.last_completed_at
      : task.created_at)
  // A malformed stored date (a hand-written row, an old import) must never
  // take down a read — Luxon throws on one here (`throwOnInvalid`): it counts
  // nothing new.
  const dates = [task.due_at, setAt, task.created_at, stored.countedThrough ?? task.created_at]
  if (dates.some((d) => Number.isNaN(Date.parse(d)))) return stored
  const arrived = Date.parse(task.due_at) <= now.getTime()
  // Calendar days without a rollover time: midnight as a day start.
  const dayStart = rolloverTime ?? CALENDAR_DAY_START
  const dayOf = (iso: string): DateTime => localDay(iso, timezone, dayStart)
  // The target's day: an early-morning pick belongs to its calendar day, not
  // the evening's OpenTask day (`targetOpenTaskDay`, the rollover's spare rule).
  const targetDay = DateTime.fromISO(targetOpenTaskDay(task.due_at, setAt, timezone, dayStart), {
    zone: timezone,
  })
  const today = dayOf(now.toISOString())
  // Arrived, such a target counts at once — before that day's rollover too.
  const end = arrived ? DateTime.max(today, targetDay)! : today.minus({ days: 1 })
  const starts = [targetDay, dayOf(setAt), dayOf(task.created_at)]
  if (stored.countedThrough) {
    starts.push(
      DateTime.fromISO(stored.countedThrough, { zone: timezone }).startOf('day').plus({ days: 1 }),
    )
  }
  const start = DateTime.max(...starts)!
  const added = start <= end ? waitDays(end, start) + 1 : 0
  if (added === 0) return stored
  return {
    attempts: stored.attempts + added,
    countedThrough: end.toFormat(ATTEMPTS_DATE_FORMAT),
  }
}

/**
 * The checkpoint a PUT-BACK restores with the completion's count (§7): the
 * completion day itself if the target had arrived by then (that day was
 * counted), else the day before — but never before yesterday, so the days the
 * task sat done don't count as attempts, and today counts once at most.
 */
export function putBackCountedThrough(
  completedAt: string,
  targetWas: string | null,
  timezone: string,
  now: Date,
  /**
   * The owner's rollover time when the task queue is on (B7): the days are
   * then OPENTASK days, like `effectiveAttempts` — so a put-back between
   * midnight and the rollover checkpoints the right day. Null: calendar days.
   */
  rolloverTime: string | null,
): string {
  const dayOf = (instant: Date): DateTime =>
    openTaskLocalDay(instant, timezone, rolloverTime ?? CALENDAR_DAY_START)
  const completedDay = dayOf(new Date(completedAt))
  const arrived = targetWas !== null && Date.parse(targetWas) <= Date.parse(completedAt)
  const counted = arrived ? completedDay : completedDay.minus({ days: 1 })
  const yesterday = dayOf(now).minus({ days: 1 })
  return DateTime.max(counted, yesterday)!.toFormat(ATTEMPTS_DATE_FORMAT)
}

/** The badge's label ("3×"), or null: no target, or no attempt yet. */
export function attemptsLabel(task: { due_at: string | null; attempts?: number }): string | null {
  return task.due_at !== null && (task.attempts ?? 0) >= 1 ? `${task.attempts}×` : null
}

export type AttemptsTone = 'light' | 'medium' | 'strong'

export function attemptsTone(attempts: number): AttemptsTone {
  if (attempts >= ATTEMPTS_STRONG) return 'strong'
  if (attempts >= ATTEMPTS_MEDIUM) return 'medium'
  return 'light'
}

/**
 * At ATTEMPTS_OFFER_REMOVE (3×) the row and Process OFFER to drop the target
 * — never automatically: "Remove target?" on a one-off whose target the user
 * picked, deadline or not (2026-10-22, the deadlines page: a deadline task
 * with no target goes on the page from its lead day — there is no automatic
 * target to go back to). A repeating task's target goes only with its
 * recurrence (`targetReset`). With the task queue OFF the server still keeps
 * an automatic target (A1, one release), so a deadline task whose deadline
 * has passed offers nothing there: removing the target would only bring back
 * the passed deadline, still overdue.
 */
export function attemptsOffer(
  task: {
    due_at: string | null
    deadline_at: string | null
    target_auto?: boolean
    rrule?: string | null
    attempts?: number
    priority?: number
  },
  now: Date = new Date(),
  /**
   * The task queue is on (server callers pass `taskQueueEnabled()`, the
   * browser the switch from GET /api/user/preferences, `useTaskQueue`). Then
   * "Remove target?" is RETIRED on a strippable task (`queueStrippable`,
   * build-plan resolution 1): the rollover takes its target off on its own,
   * so the queue does the offer's job. High and deadline tasks keep theirs.
   */
  opts: { queue?: boolean } = {},
): 'remove' | null {
  if ((task.attempts ?? 0) < ATTEMPTS_OFFER_REMOVE) return null
  const reset = targetReset(task)
  if (reset === null) return null
  if (opts.queue) return queueStrippable(task) ? null : reset
  return task.deadline_at !== null && isPastDeadline(task.deadline_at, now) ? null : reset
}

/** Priority from which the rollover never strips (High = 3, Urgent = 4). */
export const QUEUE_KEEP_PRIORITY = 3

/**
 * A task whose target the rollover may STRIP (task queue, 2026-10-19; spec
 * rule 2, resolution 3): a one-off below High with no deadline (passed or
 * ahead). The kind test only — the rollover also excludes reminders, quotas,
 * done and deleted tasks (`eligible` in src/core/tasks/task-rollover.ts).
 */
export function queueStrippable(task: {
  rrule?: string | null
  deadline_at: string | null
  priority?: number
}): boolean {
  return !task.rrule && task.deadline_at === null && (task.priority ?? 0) < QUEUE_KEEP_PRIORITY
}

/**
 * THE TASK QUEUE'S PANELS (task queue PR 3, 2026-10-19; spec rules 6-8,
 * resolution 6). Which panel a QUEUED task shows in today, or null when it is
 * not in the queue at all:
 * - not queued (`queued_at` NULL) → null;
 * - a target that has ARRIVED (`due_at` at or before now) → null: it is over
 *   target, on the dashboard. A stripped one-off has no target; a waiting
 *   repeating task's target is its next occurrence, so it leaves the queue
 *   the moment that occurrence comes (the rollover releases it that morning);
 * - queued at or after `latestRolloverAt` (the user's latest rollover moment,
 *   `latestRollover` in opentask-day.ts) → `queue_today`, else
 *   `queue_previous`. A repeating task stays queued after a consider, so one
 *   considered yesterday is in `queue_previous` today (resolution 6).
 *
 * PRECEDENCE (rule 7): a task this returns a kind for is in no horizon
 * segment and not in Upcoming — the caller places it here and nowhere else.
 * Its state (waiting / considered / deferred) is the shared stamps' (rule 7:
 * one considered state), read by `queueRowState`.
 */
export function queueKind(
  task: { queued_at?: string | null; due_at: string | null },
  now: Date,
  latestRolloverAt: Date,
): QueueKind | null {
  if (!task.queued_at) return null
  if (task.due_at !== null && Date.parse(task.due_at) <= now.getTime()) return null
  return Date.parse(task.queued_at) >= latestRolloverAt.getTime() ? 'queue_today' : 'queue_previous'
}

/**
 * A queue row's state today: considered today (listed ticked behind "Show N
 * considered", like a horizon row), deferred today, else waiting. Never
 * hidden: the queue drops nothing (spec rule 6) — a one-off leaves it only by
 * a consider (which clears `queued_at`), a target, done or delete.
 *
 * "Today" is the OPENTASK day (`openTaskDayOf` with the user's rollover
 * time), the day the panels split on — so a repeating row considered at 23:30
 * stays considered at 00:30, inside the same "Today's pulls" panel, until the
 * rollover moves it to "Previous pulls", waiting again. Since "Day starts
 * at" PR 2 (2026-10-24) the horizon segments and Upcoming read the same
 * OpenTask day (`segmentState`, `upcomingState`).
 */
export function queueRowState(
  task: { last_considered_at: string | null; segment_deferred_at: string | null },
  timezone: string,
  now: Date,
  rolloverTime: string,
): SegmentState {
  const today = openTaskDayOf(now, timezone, rolloverTime)
  const isToday = (iso: string | null) =>
    iso !== null && openTaskDayOf(new Date(iso), timezone, rolloverTime) === today
  if (isToday(task.last_considered_at)) return 'considered'
  if (isToday(task.segment_deferred_at)) return 'deferred'
  return 'waiting'
}

/**
 * The queue panels' order (spec "Medium stays in the strip … sorted by
 * priority"; the brief's tie-breaks): priority, highest first; then the OLDER
 * remembered target (`queued_from_due_at`) first, a row without one last;
 * then id. Try Tomorrow rows are NOT lifted to the top (designer, 10-19) —
 * they carry a mark instead.
 */
export function compareQueueRows(
  a: QueueSortFields,
  b: QueueSortFields,
  /**
   * On deck (2026-10-20, B5): a deck the rollover sent to the queue remembers
   * its DAY (`queued_from_deck_day`), not an instant. A row with no remembered
   * target sorts by the rollover moment that started that day — the server
   * passes `dayStartMoment` with the owner's zone and day start. Without
   * it, the day's UTC midnight (enough to order days).
   */
  deckMoment: (day: string) => number = (day) => Date.parse(`${day}T00:00:00Z`),
): number {
  if (a.priority !== b.priority) return b.priority - a.priority
  const key = (r: QueueSortFields) => {
    if (r.queued_from_due_at) return Date.parse(r.queued_from_due_at)
    return r.queued_from_deck_day ? deckMoment(r.queued_from_deck_day) : Infinity
  }
  const fa = key(a)
  const fb = key(b)
  if (fa !== fb) return fa < fb ? -1 : 1
  return a.id - b.id
}

/** The fields the queue order reads. */
export interface QueueSortFields {
  id: number
  priority: number
  queued_from_due_at?: string | null
  queued_from_deck_day?: string | null
}

/** Whether a deadline has passed — the over-target row's past-deadline marker. */
export function isPastDeadline(deadlineAt: string | null, now: Date): boolean {
  return deadlineAt !== null && Date.parse(deadlineAt) < now.getTime()
}

// ===========================================================================
// REPEATING TASKS — what an occurrence's dates are (2026-10-21)
// ===========================================================================

/**
 * DEADLINE-ANCHORED REPEATS (2026-10-21; docs/TASK-MODEL.md § Recurrence
 * Model). A repeating task has exactly ONE scheduled instant, `occurrence_at`,
 * the instant its rule walks. `repeat_anchor` says what that instant is:
 *  - 'target': the occurrence is the target; no deadline (every repeat before);
 *  - 'deadline': the occurrence is the DEADLINE (`deadline_at` mirrors it),
 *    and the target sits a fixed local offset before it —
 *    `target_days_before` local calendar days earlier, at `target_time`.
 * The other dates are never stored as free values: they come from
 * `occurrenceDates`, the one derivation. `due_at` differs from what it derives
 * only when the user moved the target THIS occurrence (`targetMoved`); done
 * and skip always write the next occurrence's derived dates, so nothing a
 * move did carries over. (This replaced `advanceDeadline`, the "same distance
 * after the new occurrence" carry of a target-walking rule.)
 */
export interface RepeatSchedule {
  rrule: string | null
  repeat_anchor: RepeatAnchor | null
  target_days_before: number | null
  target_time: string | null
  /**
   * The deadlines page (2026-10-22): a target-less deadline-anchored repeat's
   * lead override (`lead_days`, series-level), and the rule fields its
   * default lead walks (`defaultLeadDays`). Read only for `leadFrom`.
   */
  lead_days?: number | null
  recurrence_mode?: 'from_due' | 'from_completion' | null
  anchor_time?: string | null
}

/**
 * The dates of one occurrence (UTC ISO). `deadlineAt` is null on a
 * target-anchored one. `targetAt` is null on a deadline-anchored repeat with
 * NO relative target (2026-10-22, plan L1: no fake targets) — its occurrence
 * goes on the deadlines page from `leadFrom` (yyyy-MM-dd, the owner's
 * OpenTask day) instead; `leadFrom` is null on every other occurrence, and
 * when the caller passed no `LeadContext`.
 */
export interface OccurrenceDates {
  occurrenceAt: string
  targetAt: string | null
  deadlineAt: string | null
  leadFrom: string | null
}

/**
 * What `occurrenceDates` needs to derive a lead day: the owner's rollover
 * time (the deadline's OpenTask day, `deadlineDay`) and the write's moment
 * (a lead day is never before the day it is written). Every ADVANCE writer
 * passes it (done, skip, skip until, put-back): each new occurrence gets its
 * lead day re-derived, so a deferral never carries over.
 */
export interface LeadContext {
  rolloverTime: string | null
  now: Date
}

/** Whether a deadline-anchored schedule has a relative target (both offsets). */
export function hasRelativeTarget(
  schedule: Pick<RepeatSchedule, 'target_days_before' | 'target_time'>,
): boolean {
  return schedule.target_days_before !== null && schedule.target_time !== null
}

/** A deadline-anchored repeat's target, relative to its deadline. */
export interface RelativeTarget {
  /** Local calendar days from the deadline's date back to the target's (0 = the same day). */
  days_before: number
  /** The target's local time of day, HH:MM. */
  time: string
}

/** Whether the task is a deadline-anchored repeat (a rule, and the anchor 'deadline'). */
export function isDeadlineAnchored(task: Pick<RepeatSchedule, 'rrule' | 'repeat_anchor'>): boolean {
  return !!task.rrule && task.repeat_anchor === 'deadline'
}

function localHHMM(at: DateTime): string {
  return at.toFormat('HH:mm')
}

/**
 * THE DERIVATION: the dates of one occurrence of a repeating task (pure).
 *  - target-anchored: the occurrence is the target, and there is no deadline;
 *  - deadline-anchored: the occurrence is the deadline; the target is
 *    `target_time` on the deadline's local date minus `target_days_before`
 *    (Luxon calendar days, so a DST change between them never shifts it),
 *    through `localMoment`'s DST rule (a time the clocks skip → the next
 *    valid minute; a repeated one → its first instant), and LAST clamped to
 *    the deadline — the target is never after it (§8.2). Write-time validation
 *    (`relativeTargetProblem`) refuses an offset that would put it there, so
 *    the clamp only ever absorbs a DST hour.
 * A deadline-anchored row with no offsets (2026-10-22, the deadlines page:
 * written with the task-queue switch on) has NO target — `targetAt` null —
 * and, given a `LeadContext`, its lead day (`leadFrom`).
 */
export function occurrenceDates(
  schedule: RepeatSchedule,
  occurrenceAt: string,
  timezone: string,
  lead?: LeadContext,
): OccurrenceDates {
  if (!isDeadlineAnchored(schedule)) {
    return { occurrenceAt, targetAt: occurrenceAt, deadlineAt: null, leadFrom: null }
  }
  // NO RELATIVE TARGET (L1, 2026-10-22): the occurrence has no target at all
  // — never "the deadline itself", which would be a fake target at the
  // deadline. It goes on the deadlines page from its lead day.
  if (!hasRelativeTarget(schedule)) {
    return {
      occurrenceAt,
      targetAt: null,
      deadlineAt: occurrenceAt,
      leadFrom: lead ? repeatLeadFrom(schedule, occurrenceAt, timezone, lead) : null,
    }
  }
  const targetAt = relativeTargetAt(
    occurrenceAt,
    { days_before: schedule.target_days_before!, time: schedule.target_time! },
    timezone,
  )
  return { occurrenceAt, targetAt, deadlineAt: occurrenceAt, leadFrom: null }
}

/**
 * THE RELATIVE TARGET'S ONE DERIVATION (2026-10-24, pulled out of
 * `occurrenceDates`; docs/TASK-MODEL.md § Relative targets): the target that
 * sits `days_before` local CALENDAR days before `deadlineAt` (0 = the same
 * day) at `time` (HH:MM) — Luxon calendar days, so a DST change between them
 * never shifts it — through `localMoment`'s DST rule (a time the clocks skip
 * → the next valid minute; a repeated one → its first instant), and LAST
 * clamped to the deadline: the target is never after it (§8.2). A
 * deadline-anchored repeat's occurrence and a relative ONE-OFF's deadline
 * both go through here, and nothing else does date maths on the offsets
 * (guard RT-G01). Write-time validation refuses a same-day time after the
 * deadline's, so the clamp absorbs only a DST hour or a later deadline move.
 * Derived in the task OWNER's zone.
 */
export function relativeTargetAt(
  deadlineAt: string,
  relative: RelativeTarget,
  timezone: string,
): string {
  const deadline = DateTime.fromISO(deadlineAt, { zone: 'utc' }).setZone(timezone)
  const day = deadline.startOf('day').minus({ days: relative.days_before })
  const target = localMoment(day.toISODate()!, relative.time, timezone)
  return target.getTime() < deadline.toMillis() ? target.toISOString() : deadlineAt
}

/**
 * The inverse direction (a helper, not a derivation): the local DATE
 * (yyyy-MM-dd) `daysBefore` calendar days after the local day of `targetAt` —
 * where a deadline goes for a target to sit `daysBefore` days before it (the
 * every-time editor's first deadline). Here so the offsets' date maths stays
 * in this module (guard RT-G01).
 */
export function deadlineDateFrom(targetAt: string, daysBefore: number, timezone: string): string {
  return DateTime.fromISO(targetAt, { zone: 'utc' })
    .setZone(timezone)
    .plus({ days: daysBefore })
    .toISODate()!
}

/** The fields that make a one-off's target relative (`isRelativeOneOff`). */
export interface RelativeOneOffFields {
  rrule: string | null
  deadline_at: string | null
  target_days_before: number | null
  target_time: string | null
  is_reminder?: boolean
  is_tracked?: boolean
  progress_target?: number
}

/**
 * RELATIVE TARGETS (2026-10-24): whether a ONE-OFF's target is relative — no
 * rule, a deadline, both offsets, and not a reminder or a quota. Its target
 * is then `relativeTargetAt(deadline, offsets)` and is a PICKED one
 * (`target_auto` is never set, so `hasPickedTarget` holds): quiet until its
 * day, never on the deadlines page.
 */
export function isRelativeOneOff(task: RelativeOneOffFields): boolean {
  return (
    !task.rrule &&
    task.deadline_at !== null &&
    task.target_days_before !== null &&
    task.target_time !== null &&
    !task.is_reminder &&
    !task.is_tracked &&
    (task.progress_target ?? 1) <= 1
  )
}

/** The relative target a row carries (both offsets), or null. */
export function relativeOf(task: {
  target_days_before: number | null
  target_time: string | null
}): RelativeTarget | null {
  return task.target_days_before !== null && task.target_time !== null
    ? { days_before: task.target_days_before, time: task.target_time }
    : null
}

/**
 * A ONE-OFF's offsets against its deadline (a 400 at write time, never a
 * clamp): the same day at a time after the deadline's local time is
 * `after_deadline`. A one-off has no previous occurrence to overlap. A later
 * deadline move alone is not judged — `relativeTargetAt` clamps instead.
 */
export function relativeOneOffProblem(
  relative: RelativeTarget,
  deadlineAt: string,
  timezone: string,
): RelativeTargetProblem | null {
  const deadline = DateTime.fromISO(deadlineAt, { zone: 'utc' }).setZone(timezone)
  return relative.days_before === 0 && relative.time > localHHMM(deadline) ? 'after_deadline' : null
}

/**
 * The inverse (a helper, not a derivation): the offset that puts the target at
 * `targetAt` for the deadline `deadlineAt` — for the migration, and a create
 * that sends a first target with its deadline. Null when the target is after
 * the deadline.
 */
export function relativeTargetOf(
  targetAt: string,
  deadlineAt: string,
  timezone: string,
): RelativeTarget | null {
  if (Date.parse(targetAt) > Date.parse(deadlineAt)) return null
  const target = DateTime.fromISO(targetAt, { zone: 'utc' }).setZone(timezone)
  const deadline = DateTime.fromISO(deadlineAt, { zone: 'utc' }).setZone(timezone)
  return {
    days_before: waitDays(deadline.startOf('day'), target.startOf('day')),
    time: localHHMM(target),
  }
}

/**
 * Whether a repeating task's target was MOVED this occurrence: it is not what
 * `occurrenceDates` derives for its scheduled occurrence. False with no target
 * (on deck) or no occurrence.
 */
export function targetMoved(
  task: RepeatSchedule & { due_at: string | null; occurrence_at?: string | null },
  timezone: string,
): boolean {
  if (!task.rrule || !task.due_at || !task.occurrence_at) return false
  const derived = occurrenceDates(task, task.occurrence_at, timezone).targetAt
  // A target on an occurrence that has none of its own (L1) is a pick.
  if (derived === null) return true
  return Date.parse(task.due_at) !== Date.parse(derived)
}

/**
 * What makes a repeating task's CURRENT occurrence its own (PR 4a, 2026-10-22;
 * plan RT-1, ruling A1): it is ON DECK, or its target was MOVED this
 * occurrence. Such an occurrence keeps what it has across a SCHEDULE change
 * (a new rule, mode, anchor or offsets — PATCH and bulk edit alike,
 * `collectFieldChanges`): a moved target stays (capped at the deadline), a
 * deck stays with its occurrence's day re-timed to the new rule — for both
 * anchors. Anything else is on its schedule and moves with it.
 *
 * NOT personal: a repeat WAITING in the task queue (`queued_at`). The rollover
 * moved its target on to the old rule's next occurrence, which `targetMoved`
 * reads as a move — but it is not the user's (B3), so a schedule change still
 * recomputes it and takes it out of the queue. Plain over-target debt is not
 * named here either: the writers keep it by their own older rule (the target
 * stays; a deadline-anchored one keeps its occurrence's day). The editor's
 * "This one keeps its own target and deck" hint reads this, plus those two.
 */
export type PersonalOccurrence = 'deck' | 'moved'

export function occurrenceIsPersonal(
  task: RepeatSchedule & {
    due_at: string | null
    occurrence_at?: string | null
    on_deck_day?: string | null
    queued_at?: string | null
  },
  timezone: string,
): PersonalOccurrence | null {
  if (!task.rrule) return null
  if (task.on_deck_day) return 'deck'
  if (task.queued_at) return null
  return targetMoved(task, timezone) ? 'moved' : null
}

/**
 * An occurrence's local DAY at a (new) rule's time — what a schedule change
 * leaves an occurrence that keeps its day (over-target debt, a deck). The
 * rule's time comes from `ruleTimeOfDay` (BYHOUR/BYMINUTE, else `anchorTime`).
 */
export function occurrenceDayAtRuleTime(
  occurrenceAt: string,
  rule: { rrule: string; anchor_time: string | null },
  timezone: string,
): string {
  const { hour, minute } = ruleTimeOfDay(rule.rrule, rule.anchor_time)
  const day = DateTime.fromISO(occurrenceAt, { zone: 'utc' }).setZone(timezone).toISODate()!
  return localMoment(day, formatAnchorTime(hour, minute), timezone).toISOString()
}

/**
 * The TARGET of a repeating task's current occurrence, as scheduled
 * (`occurrenceDates`; a deadline-anchored repeat's lies before its deadline),
 * for words that name when it nags — skip until's dialog and summary. Falls
 * back to `due_at` with no occurrence.
 */
export function occurrenceTarget(
  task: RepeatSchedule & { occurrence_at?: string | null; due_at: string | null },
  timezone: string,
): string | null {
  if (!task.occurrence_at) return task.due_at
  return occurrenceDates(task, task.occurrence_at, timezone).targetAt
}

/**
 * WHERE AN ADVANCE STARTS (2026-10-21): the occurrence done, skip and skip
 * until advance FROM — the rule's own instant this occurrence stands for.
 *
 * A deadline-anchored repeat's deadline can be RESCHEDULED for one occurrence
 * (a PATCH of `deadline_at`), off its rule. Walking on from the rescheduled
 * date would make a second occurrence in the same period: a Friday deadline
 * pulled to Thursday, done Thursday, would come back that Friday. So the base
 * is the first rule occurrence ON OR AFTER `occurrence_at`, and the advance is
 * the first rule occurrence strictly after max(base, now):
 *  - an occurrence on its rule is its own base — nothing changes;
 *  - pulled earlier (Fri → Thu): the base is that Friday, the next is the
 *    following Friday;
 *  - pushed past the next rule occurrence (Fri → next Mon): the base is the
 *    Friday after, which the pushed one covers, so the next is the one after.
 * A floating rule (every N, bare) runs on a grid anchored at its own
 * occurrence, so its base is the occurrence. from_completion has no schedule
 * to walk and target-anchored repeats are never rescheduled this way: both
 * read `occurrence_at` as before. EVERY advance asks this: `computeMarkDone`,
 * `nextOccurrenceAfterSkip` (skip, skip until, the bulk defer cap) and the
 * snooze guard.
 */
export function scheduleBase(
  task: Pick<RepeatSchedule, 'rrule' | 'repeat_anchor'> & {
    recurrence_mode: 'from_due' | 'from_completion' | null | undefined
    anchor_time: string | null
    occurrence_at?: string | null
    due_at: string | null
  },
  timezone: string,
): string | null {
  const occurrence = task.occurrence_at ?? task.due_at
  if (!occurrence || !isDeadlineAnchored(task) || task.recurrence_mode === 'from_completion') {
    return occurrence
  }
  const at = new Date(occurrence)
  const justBefore = new Date(at.getTime() - 1)
  return computeNextOccurrence({
    rrule: task.rrule!,
    recurrenceMode: 'from_due',
    anchorTime: task.anchor_time,
    timezone,
    completedAt: justBefore,
    prevDueAt: justBefore,
    anchorAt: at,
  }).toISOString()
}

/**
 * REPEAT ENDS (2026-10-22; docs/TASK-MODEL.md § Repeat ends). "Ends: never /
 * after N times / on date" lives in three columns, never in the rule — the
 * stored rrule is end-free (validation lifts a COUNT/UNTIL sent in it):
 *  - `repeat_count`: the occurrences in the series (1..999);
 *  - `repeat_count_used`: occurrences CLOSED since the count was set — done
 *    or skipped, one each (a skip-until passing k occurrences closes k; a
 *    rollover roll closes one). Every writer of `completion_count` or
 *    `skip_count` on a repeating task writes it (guard RE-G01);
 *  - `repeat_until`: the last LOCAL day (yyyy-MM-dd, the owner's zone),
 *    inclusive. An occurrence is in the series when its local date is on or
 *    before it — a deadline-anchored repeat's occurrence is its DEADLINE.
 *
 * ONE JUDGE, `repeatStep`: an advance asks the engine where it would land
 * (`computeNextOccurrence`, which never knows about ends — several callers
 * ask it questions that are not advances: `scheduleBase`, today's
 * occurrence, the deadline walk, the first occurrence) and then asks this
 * whether that landing is still in the series. `nextOrEnd` is the pair for
 * a one-occurrence advance (done, skip, the snooze guard, the defer cap).
 */
export interface RepeatEnd {
  repeat_count: number | null
  repeat_count_used: number
  repeat_until: string | null
}

export type RepeatStep =
  /** The series goes on: land on `occurrenceAt`; `used` is the count after this write. */
  | { ended: false; occurrenceAt: string; used: number }
  /**
   * The series ends with this write. `consumed`: the occurrences that existed
   * to close (≤ `closes` — a skip until past a count closes only what was left).
   */
  | { ended: true; used: number; consumed: number }

/** The end fields as any reader holds them (a row, a task, a client object), each optional. */
export interface RepeatEndFields {
  repeat_count?: number | null
  repeat_count_used?: number | null
  repeat_until?: string | null
}

/** A task's end fields, defaulted (a row or object from before the columns has none). */
export function repeatEndOf(task: RepeatEndFields): RepeatEnd {
  return {
    repeat_count: task.repeat_count ?? null,
    repeat_count_used: task.repeat_count_used ?? 0,
    repeat_until: task.repeat_until ?? null,
  }
}

/** Whether the task's repeat has an end (a count or a date). */
export function hasRepeatEnd(task: RepeatEndFields): boolean {
  return (task.repeat_count ?? null) !== null || (task.repeat_until ?? null) !== null
}

/** The local calendar date (yyyy-MM-dd) of an instant. */
function localDateOf(iso: string, timezone: string): string {
  return DateTime.fromISO(iso, { zone: 'utc' }).setZone(timezone).toISODate()!
}

/**
 * THE END OF A REPEAT (pure): what closing `closes` occurrences leaves.
 * `landing` is the engine's candidate for the next occurrence (null = the
 * rule has none). Ends when `used + closes >= count`, or the landing's LOCAL
 * date is after `until`, or there is no landing.
 */
export function repeatStep(
  end: RepeatEnd,
  landing: string | null,
  closes: number,
  timezone: string,
): RepeatStep {
  const used = end.repeat_count_used
  if (end.repeat_count !== null) {
    const left = Math.max(0, end.repeat_count - used)
    if (closes >= left) {
      const consumed = Math.min(closes, left)
      return { ended: true, used: used + consumed, consumed }
    }
  }
  if (landing === null) return { ended: true, used: used + closes, consumed: closes }
  if (end.repeat_until !== null && localDateOf(landing, timezone) > end.repeat_until) {
    return { ended: true, used: used + closes, consumed: closes }
  }
  return { ended: false, occurrenceAt: landing, used: used + closes }
}

/** What an advance reads of the task: its schedule, and its end. */
export type AdvanceTask = Parameters<typeof scheduleBase>[0] & RepeatEndFields

/**
 * WHERE A ONE-OCCURRENCE ADVANCE LANDS, end-blind: the rule's next occurrence
 * after the scheduled one (`scheduleBase`), counted from `completedAt` when
 * that is later (a from_completion rule: from `completedAt`'s OpenTask date,
 * so `dayStart` — the owner's day boundary, `dayBoundaryForUser`). Done,
 * skip, the defer cap and the snooze guard all ask this — through `nextOrEnd`.
 */
export function nextLanding(
  task: AdvanceTask,
  timezone: string,
  completedAt: Date,
  dayStart: string,
): string {
  const prev = scheduleBase(task, timezone)
  return computeNextOccurrence({
    rrule: task.rrule!,
    recurrenceMode: task.recurrence_mode ?? 'from_due',
    anchorTime: task.anchor_time,
    timezone,
    completedAt,
    dayStart,
    prevDueAt: prev ? new Date(prev) : null,
    // A floating rule's grid (every N, or bare) runs from the task's own occurrence.
    anchorAt: prev ? new Date(prev) : null,
  }).toISOString()
}

/**
 * THE ADVANCE WITH ITS END: `nextLanding` judged by `repeatStep`. A count
 * that ends here never asks the engine (a rule with no next would throw).
 */
export function nextOrEnd(
  task: AdvanceTask,
  timezone: string,
  /** `dayStart`: the owner's day boundary (`nextLanding`). */
  opts: { completedAt: Date; closes?: number; dayStart: string },
): RepeatStep {
  const end = repeatEndOf(task)
  const closes = opts.closes ?? 1
  const countEnds = end.repeat_count !== null && end.repeat_count_used + closes >= end.repeat_count
  const landing = countEnds ? null : nextLanding(task, timezone, opts.completedAt, opts.dayStart)
  return repeatStep(end, landing, closes, timezone)
}

/**
 * Is the CURRENT occurrence the last? Closing it once ends the series — as
 * if done at max(occurrence, now). False with no end, and on a closed row
 * (done, or archived by the skip of the last). Pure.
 *
 * A COUNT is decided by arithmetic alone (`used + 1 >= count`), never the
 * engine: the only thing the engine could add is "the rule has no next
 * occurrence", which validation refuses at write time (`isValidRRule`'s
 * `everOccurs`, 2026-10-21) — on a legacy row that has one, the done itself
 * answers (NEVER_OCCURS). Only a DATE end asks the engine: one call.
 */
export function isLastOccurrence(
  task: AdvanceTask & { done?: boolean; archived_at?: string | null },
  timezone: string,
  now: Date,
  /** The owner's day boundary: a from_completion rule counts from now's OpenTask date. */
  dayStart: string,
): boolean {
  if (!task.rrule || task.done || task.archived_at || !hasRepeatEnd(task)) return false
  const end = repeatEndOf(task)
  if (end.repeat_count !== null) return end.repeat_count_used + 1 >= end.repeat_count
  const occurrence = task.occurrence_at ?? task.due_at
  const at = occurrence && Date.parse(occurrence) > now.getTime() ? new Date(occurrence) : now
  try {
    return nextOrEnd(task, timezone, { completedAt: at, dayStart }).ended
  } catch {
    // A rule with no next occurrence: this one is the last there is.
    return true
  }
}

/**
 * A series that ended on the SKIP of its last occurrence: a repeat with an end,
 * archived and not done (`writeSeriesEndSkip`, A1). Asked with the end, so a
 * repeating row archived any other way (a one-off skipped, then given a rule)
 * is not read as an ended series.
 */
export function seriesEndedBySkip(
  task: RepeatEndFields & { rrule: string | null; done: boolean; archived_at: string | null },
): boolean {
  return !!task.rrule && !task.done && task.archived_at !== null && hasRepeatEnd(task)
}

/** `repeat_count − repeat_count_used` (the current one included), or null with no count. */
export function repeatRemaining(task: RepeatEndFields): number | null {
  const end = repeatEndOf(task)
  return end.repeat_count === null ? null : Math.max(0, end.repeat_count - end.repeat_count_used)
}

/**
 * The words for the occurrence that ENDED a series (history, toasts):
 * "the last of 6", "the last; it ended Dec 31", or "the last".
 */
export function seriesEndWords(task: RepeatEndFields): string {
  const end = repeatEndOf(task)
  if (end.repeat_count !== null) return `the last of ${end.repeat_count}`
  if (end.repeat_until !== null) {
    const day = DateTime.fromISO(end.repeat_until, { zone: 'utc' }).toFormat('LLL d')
    return `the last; it ended ${day}`
  }
  return 'the last'
}

/** The rule fields the occurrence walk reads. */
export interface RepeatRule {
  rrule: string
  recurrence_mode: 'from_due' | 'from_completion' | null | undefined
  anchor_time: string | null
}

/**
 * The occurrence after `from` on the task's rule, `from` being one of its own
 * occurrences (a from_completion rule: as if done at `from`).
 *
 * A STEP FROM AN OCCURRENCE, not from a completion: a from_completion rule
 * steps the occurrence's OWN date (`CALENDAR_DAY_START`), never a user's day.
 * For an occurrence at the rule's time this is the same answer under every
 * day start (Done counts from the OpenTask date and places the rule's time
 * back inside the landing day, `computeFromCompletion` — the occurrence's
 * OpenTask date maps back to its own date), so the deadline walk and
 * everything built on it (the relative-target checks, the rule's wait) need
 * no user's day.
 */
function followingOccurrence(rule: RepeatRule, from: Date, timezone: string): Date {
  return computeNextOccurrence({
    rrule: rule.rrule,
    recurrenceMode: rule.recurrence_mode ?? 'from_due',
    anchorTime: rule.anchor_time,
    timezone,
    completedAt: from,
    dayStart: CALENDAR_DAY_START,
    prevDueAt: from,
    anchorAt: from,
  })
}

/** How far the validation and the default look ahead: 60 occurrences or a year. */
const WALK_OCCURRENCES = 60
const WALK_YEARS = 1

/**
 * The rule's occurrences from `first` (inclusive), up to the walk's limits —
 * ONE walk the default target and the validation share (a write that needs
 * both walks once: `resolveRelativeTarget`).
 */
export function deadlineWalk(rule: RepeatRule, first: string, timezone: string): Date[] {
  const start = new Date(first)
  const end = DateTime.fromJSDate(start).plus({ years: WALK_YEARS }).toMillis()
  const out = [start]
  while (out.length <= WALK_OCCURRENCES) {
    const last = out[out.length - 1]
    const next = followingOccurrence(rule, last, timezone)
    if (next.getTime() <= last.getTime() || next.getTime() > end) break
    out.push(next)
  }
  return out
}

export type RelativeTargetProblem = 'after_deadline' | 'overlaps_previous'

/** The 400s for a relative target that can't be written (`relativeTargetProblem`). */
export const RELATIVE_TARGET_MESSAGES: Record<RelativeTargetProblem, string> = {
  after_deadline:
    'The target would be after the deadline: on the deadline day (target_days_before 0) target_time must be at or before the deadline time',
  overlaps_previous:
    "The target would fall on or before the previous occurrence's deadline: use fewer target_days_before for this rule",
}

/**
 * WRITE-TIME VALIDATION of a deadline-anchored repeat's relative target — the
 * POST, PATCH, bulk edit and the migration all ask it. Refused, never
 * clamped (a clamp would silently change a rule the user typed):
 *  - 'after_deadline': the same day (0) at a time later than the rule's —
 *    the deadline's — time of day;
 *  - 'overlaps_previous': some occurrence's target on or before the previous
 *    occurrence's deadline, walking the next 60 occurrences (or a year) from
 *    `firstDeadline`. A from_completion rule is walked as if each occurrence
 *    were done on its deadline, so its lead must be shorter than its interval.
 */
export function relativeTargetProblem(
  offset: RelativeTarget,
  rule: RepeatRule,
  firstDeadline: string,
  timezone: string,
  walk: Date[] = deadlineWalk(rule, firstDeadline, timezone),
): RelativeTargetProblem | null {
  const { hour, minute } = ruleTimeOfDay(rule.rrule, rule.anchor_time)
  const ruleTime = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
  if (offset.days_before === 0 && offset.time > ruleTime) return 'after_deadline'
  const schedule: RepeatSchedule = {
    rrule: rule.rrule,
    repeat_anchor: 'deadline',
    target_days_before: offset.days_before,
    target_time: offset.time,
  }
  const deadlines = walk
  for (let i = 1; i < deadlines.length; i++) {
    const target = occurrenceDates(schedule, deadlines[i].toISOString(), timezone).targetAt!
    if (Date.parse(target) <= deadlines[i - 1].getTime()) return 'overlaps_previous'
  }
  return null
}

/**
 * THE DEADLINE LEAD (A1, decided 2026-10-21): how many local days before a
 * deadline its default target falls, by the WAIT — the local days from the
 * previous deadline to this one. Upcoming's heads-up constants, no new
 * numbers (its Tomorrow and its default 3/4-day Later, `upcomingDays`, which
 * reads this table as its default lead):
 *  - under HEADS_UP_DAY_BEFORE_MIN_WAIT (2): the deadline day itself (0);
 *  - up to HEADS_UP_EARLY_AFTER_WAIT (7): the day before (1);
 *  - over it: `leadDaysForWait` — 3 days under HEADS_UP_LONG_WAIT (16), 4 at
 *    16 or more.
 */
export function deadlineLeadDays(wait: number): number {
  if (wait < HEADS_UP_DAY_BEFORE_MIN_WAIT) return 0
  if (wait <= HEADS_UP_EARLY_AFTER_WAIT) return 1
  return leadDaysForWait(wait)
}

/**
 * THE AUTOMATIC TARGET'S ONE TABLE (2026-10-21, "one rule everywhere"): for a
 * deadline `wait` local days off — after the previous deadline (a repeat's
 * default, `defaultRelativeTarget`) or after now (a one-off's automatic
 * target, `autoTargetAt`) — `deadlineLeadDays(wait)` days before, at the
 * user's morning; on the deadline day itself, at the morning or the
 * deadline's own time if that is earlier (the picker's "Morning of the deadline",
 * `deadlineDayTarget`). Pure, in relative form. Every automatic ("fake")
 * target goes through it, so replacing them is one change here.
 */
export function leadTargetFor(
  wait: number,
  deadlineTime: string,
  morningTime: string,
): RelativeTarget {
  const days = deadlineLeadDays(wait)
  if (days > 0) return { days_before: days, time: morningTime }
  return { days_before: 0, time: morningTime < deadlineTime ? morningTime : deadlineTime }
}

/**
 * The relative target a deadline-anchored repeat gets when it is written with
 * none (A1, 2026-10-21): `leadTargetFor` at the rule's WAIT, read as the
 * smallest local-day gap between consecutive deadlines in the walk from
 * `firstDeadline` — so a twice-weekly rule (gaps of 3 and 4) takes the day
 * before, a fortnightly one 3 days and a monthly one (28 to 31) 4. A rule with
 * no second occurrence within the walk (yearly) reads as the longest wait.
 * Stored as real values, so the API always shows what it is.
 */
export function defaultRelativeTarget(
  rule: RepeatRule,
  firstDeadline: string,
  timezone: string,
  morningTime: string,
  walk: Date[] = deadlineWalk(rule, firstDeadline, timezone),
): RelativeTarget {
  const days = walk.map((d) => DateTime.fromJSDate(d).setZone(timezone))
  let wait = Infinity
  for (let i = 1; i < days.length; i++) {
    wait = Math.min(wait, waitDays(days[i].startOf('day'), days[i - 1].startOf('day')))
  }
  if (wait === Infinity) wait = HEADS_UP_LONG_WAIT
  return leadTargetFor(wait, localHHMM(days[0]), morningTime)
}

/**
 * The WAIT of a repeat's rule (A1, 2026-10-21): the smallest local-day gap
 * between consecutive deadlines in the walk from `firstDeadline` — a
 * twice-weekly rule (gaps of 3 and 4) waits 3, a monthly one 28. A rule with
 * no second occurrence within the walk (yearly) reads as the longest wait.
 */
export function ruleWait(
  rule: RepeatRule,
  firstDeadline: string,
  timezone: string,
  walk?: Date[],
): number {
  const days = (walk ?? deadlineWalk(rule, firstDeadline, timezone)).map((d) =>
    DateTime.fromJSDate(d).setZone(timezone).startOf('day'),
  )
  let wait = Infinity
  for (let i = 1; i < days.length; i++) wait = Math.min(wait, waitDays(days[i], days[i - 1]))
  return wait === Infinity ? HEADS_UP_LONG_WAIT : wait
}

// ===========================================================================
// THE DEADLINES PAGE — lead days (2026-10-22; docs/TASK-MODEL.md § The
// deadlines page)
// ===========================================================================

/**
 * THE DEADLINES PAGE replaces the deadline's automatic target (task-queue
 * switch on; plan "Deadlines page", rulings 10-22). A deadline task with NO
 * target is never over target; instead, from its LEAD DAY on, it sits on the
 * deadlines page ("TASK QUEUE · DEADLINES"), and from the day before its
 * deadline (D−1) the SAFETY NET holds it there — seen or not, only a target
 * or done takes it off.
 *
 * `lead_from` (yyyy-MM-dd, the owner's OPENTASK day — rollover to rollover)
 * is STORED, per instance: written whenever the deadline is (a create, a
 * deadline change, each advance of a repeat), so a Defer (`POST
 * /api/task-segments/defer-lead`) is a plain column write and "deferred" is
 * `lead_from` ≠ what `leadFor` derives. `lead_days` is the user's override
 * (NULL = the table below), series-level on a repeat.
 *
 * THE DAY: the deadline's OpenTask day D (`deadlineDay`) minus the lead —
 * `lead_days`, else `deadlineLeadDays(wait)`: the one lead table the
 * automatic target used, no new numbers. Never before today (the day it is
 * written), never after D−1 (a lead under 1 is D−1); when D−1 has already
 * come, D; a deadline already past, D (the page holds it at once).
 *  - a one-off's WAIT is from today (the write's OpenTask day) to D, as the
 *    automatic target counted it;
 *  - a repeat's is its rule's (`defaultLeadDays`): the smallest gap between
 *    consecutive deadlines.
 *
 * Only on an ordinary task with a deadline and no relative target: a
 * deadline-anchored repeat WITH offsets has a real target every occurrence
 * (ruling 2: a relative target is not a lead) and no lead day.
 */
export const LEAD_DAY_FORMAT = 'yyyy-MM-dd'

/** The deadline's OPENTASK day (yyyy-MM-dd): the local day of `deadline − rollover time`. */
export function deadlineDay(
  deadlineAt: string,
  timezone: string,
  rolloverTime: string | null,
): string {
  return repeatingDeadlineDay(deadlineAt, timezone, rolloverTime)
}

/** Today as the owner's OpenTask day (the calendar day with no rollover time). */
export function openTaskToday(timezone: string, now: Date, rolloverTime: string | null): string {
  return rolloverTime ? openTaskDayOf(now, timezone, rolloverTime) : calendarDateOf(now, timezone)
}

/**
 * Skip until's EARLIEST DATE (yyyy-MM-dd): the OpenTask day after today's
 * ("OpenTask day everywhere" part 2) — the dialog's first pickable day and
 * `parseUntil`'s floor. At 00:30 Monday with a 3:00 AM start, Monday (the
 * calendar today), as at 23:30 Sunday.
 */
export function skipUntilFirstDay(timezone: string, now: Date, dayStart: string): string {
  return addDays(openTaskDayOf(now, timezone, dayStart), 1)
}

/** `day` (yyyy-MM-dd) moved by `days` calendar days. */
export function shiftDay(day: string, days: number, timezone: string): string {
  return DateTime.fromISO(day, { zone: timezone }).plus({ days }).toFormat(LEAD_DAY_FORMAT)
}

/** Whole days from `from` to `to` (both yyyy-MM-dd). */
function dayGap(to: string, from: string, timezone: string): number {
  return waitDays(
    DateTime.fromISO(to, { zone: timezone }),
    DateTime.fromISO(from, { zone: timezone }),
  )
}

/**
 * THE LEAD DAY (pure): `leadDays` before the deadline's OpenTask day,
 * clamped to [today, D−1] — or D once D−1 has come (see above).
 */
export function leadFrom(
  deadlineAt: string,
  leadDays: number,
  timezone: string,
  rolloverTime: string | null,
  now: Date,
): string {
  const d = deadlineDay(deadlineAt, timezone, rolloverTime)
  const today = openTaskToday(timezone, now, rolloverTime)
  let day = shiftDay(d, -Math.max(leadDays, 1), timezone)
  if (day < today) day = today
  return day > d ? d : day
}

/**
 * The default lead of a repeat's rule (`ruleWait` → `deadlineLeadDays`): the
 * day before for a weekly rule, 3 days for a fortnightly one, 4 for a monthly
 * one. Replaces `defaultRelativeTarget` (A1's fake target) with the switch on.
 */
export function defaultLeadDays(
  rule: RepeatRule,
  firstDeadline: string,
  timezone: string,
  walk?: Date[],
): number {
  return deadlineLeadDays(ruleWait(rule, firstDeadline, timezone, walk))
}

/** A target-less deadline-anchored repeat's lead day for the occurrence `occurrenceAt`. */
function repeatLeadFrom(
  schedule: RepeatSchedule,
  occurrenceAt: string,
  timezone: string,
  lead: LeadContext,
): string {
  const days =
    schedule.lead_days ??
    defaultLeadDays(
      {
        rrule: schedule.rrule!,
        recurrence_mode: schedule.recurrence_mode ?? 'from_due',
        anchor_time: schedule.anchor_time ?? null,
      },
      occurrenceAt,
      timezone,
    )
  return leadFrom(occurrenceAt, days, timezone, lead.rolloverTime, lead.now)
}

/**
 * A repeat's lead override must be SHORTER than its rule's wait (the smallest
 * gap between occurrences — deadlines on a deadline-anchored rule, targets on
 * a target-anchored one): a weekly rule with a lead of 10 would put every
 * occurrence on the page, or in Upcoming's Later, from the moment the last one
 * was done. Refused like `overlaps_previous` (a 400, never a clamp). Null when
 * it is fine. The words fit every repeat (2026-10-25: target-anchored repeats
 * with no deadline are judged too).
 */
export const LEAD_DAYS_TOO_LONG_MESSAGE =
  'Lead time (lead_days) must be shorter than the time between occurrences'

export function leadDaysProblem(
  leadDays: number | null,
  rule: RepeatRule,
  firstDeadline: string,
  timezone: string,
): string | null {
  if (leadDays === null) return null
  return leadDays >= ruleWait(rule, firstDeadline, timezone) ? LEAD_DAYS_TOO_LONG_MESSAGE : null
}

/** The fields `leadFor` reads (a task, or the row a write leaves). */
export interface LeadFields extends RepeatSchedule {
  deadline_at: string | null
  occurrence_at?: string | null
  is_reminder?: boolean
  is_tracked?: boolean
  progress_target?: number
}

/**
 * THE LEAD DAY A ROW CARRIES (`lead_from`), derived now, or null: no
 * deadline, a reminder or a quota, a deadline-anchored repeat WITH a relative
 * target, or a target-anchored repeat (a legacy row the anchor migration
 * skipped). A one-off: its wait from today; a target-less deadline-anchored
 * repeat: its rule's, for the current occurrence (its deadline).
 */
export function leadFor(task: LeadFields, timezone: string, lead: LeadContext): string | null {
  if (!task.deadline_at) return null
  if (task.is_reminder || task.is_tracked || (task.progress_target ?? 1) > 1) return null
  if (task.rrule) {
    if (!isDeadlineAnchored(task) || hasRelativeTarget(task)) return null
    return repeatLeadFrom(task, task.occurrence_at ?? task.deadline_at, timezone, lead)
  }
  const d = deadlineDay(task.deadline_at, timezone, lead.rolloverTime)
  const wait = dayGap(d, openTaskToday(timezone, lead.now, lead.rolloverTime), timezone)
  const days = task.lead_days ?? deadlineLeadDays(wait)
  return leadFrom(task.deadline_at, days, timezone, lead.rolloverTime, lead.now)
}

/** The fields the page reads. */
export interface DeadlinePageFields {
  due_at: string | null
  deadline_at: string | null
  lead_from?: string | null
  /** For a row with no stored lead day (`lead_from` NULL): derived now (`leadFor`). */
  lead_days?: number | null
  repeat_anchor?: RepeatAnchor | null
  target_days_before?: number | null
  target_time?: string | null
  recurrence_mode?: 'from_due' | 'from_completion' | null
  anchor_time?: string | null
  occurrence_at?: string | null
  on_deck_day?: string | null
  last_considered_at: string | null
  target_set_at: string | null
  created_at: string
  rrule?: string | null
  last_completed_at?: string | null
}

/** Where a target-less deadline task stands today (`deadlinePlace`). */
export type DeadlinePlace =
  /** On the deadlines page. `seen`: considered this OpenTask day. */
  | { kind: 'page'; state: SegmentState; safetyNet: boolean; seen: boolean }
  /**
   * Nowhere today: before its lead day (quiet — rule 3, 2026-10-25: no
   * Upcoming rows, a future deck's included), or the On deck section holds it.
   */
  | null

/** Whether a task belongs to the page's rules: a deadline, and no target. */
export function isDeadlinePageTask(task: {
  due_at: string | null
  deadline_at: string | null
}): boolean {
  return task.deadline_at !== null && task.due_at === null
}

/**
 * Whether the deadline's SAFETY NET holds the task today: from D−1 (the day
 * before the deadline's OpenTask day) on, past the deadline included (A8).
 */
export function inSafetyNet(
  deadlineAt: string,
  timezone: string,
  now: Date,
  rolloverTime: string | null,
): boolean {
  const d = deadlineDay(deadlineAt, timezone, rolloverTime)
  return openTaskToday(timezone, now, rolloverTime) >= shiftDay(d, -1, timezone)
}

/**
 * WHERE A TARGET-LESS DEADLINE TASK STANDS TODAY (the caller has already
 * chosen an open, ordinary, unqueued task with a deadline and no target —
 * `isDeadlinePageTask`). Every "today" here is the OPENTASK day (A7; ruling
 * 3: one day boundary everywhere). It is never in Upcoming (TM-INV-14):
 *
 *  - IN THE WINDOW — `lead_from` ≤ today, or the safety net (D−1 on, also
 *    when `lead_from` is missing): the page. State: in the safety net always
 *    'waiting' (seeing does not silence it; `seen` says it was seen), else
 *    'considered' when seen today, else 'waiting'. A deck does not take it
 *    off — except ON the deck day itself outside the safety net, when the On
 *    deck section holds it (null: rule 7's de-duplication). In the safety net
 *    the page always shows it; the deck does not count there.
 *  - BEFORE THE WINDOW: quiet (RULE 3 of the Upcoming split, 2026-10-25 —
 *    until then Upcoming heads-ups counted to the lead day). The deadlines
 *    page alone holds a target-less deadline task; its lead day is its
 *    heads-up. STRICT: a future deck on one gets no Upcoming rows either
 *    (plan Q8) — on the deck day the On deck section holds it.
 */
export function deadlinePlace(
  task: DeadlinePageFields,
  timezone: string,
  now: Date,
  rolloverTime: string | null,
): DeadlinePlace {
  const today = openTaskToday(timezone, now, rolloverTime)
  const dayOf = (iso: string) => openTaskToday(timezone, new Date(iso), rolloverTime)
  const safetyNet = inSafetyNet(task.deadline_at!, timezone, now, rolloverTime)
  const seen = !!task.last_considered_at && dayOf(task.last_considered_at) === today
  // A row with no stored lead day (from before the column; a write that
  // missed it) reads the one `leadFor` derives now.
  const leadDay = task.lead_from ?? derivedLeadDay(task, timezone, now, rolloverTime)
  if (safetyNet || (leadDay !== null && leadDay <= today)) {
    if (!safetyNet && deckIsToday(task, timezone, now, rolloverTime ?? CALENDAR_DAY_START)) {
      return null
    }
    const state: SegmentState = !safetyNet && seen ? 'considered' : 'waiting'
    return { kind: 'page', state, safetyNet, seen }
  }
  return null
}

function derivedLeadDay(
  task: DeadlinePageFields,
  timezone: string,
  now: Date,
  rolloverTime: string | null,
): string | null {
  return leadFor(
    {
      rrule: task.rrule ?? null,
      repeat_anchor: task.repeat_anchor ?? null,
      target_days_before: task.target_days_before ?? null,
      target_time: task.target_time ?? null,
      lead_days: task.lead_days ?? null,
      recurrence_mode: task.recurrence_mode ?? null,
      anchor_time: task.anchor_time ?? null,
      deadline_at: task.deadline_at,
      occurrence_at: task.occurrence_at ?? null,
    },
    timezone,
    { rolloverTime, now },
  )
}

/**
 * The page's order (A4, APPROVED 10-22): priority, highest first; then the
 * NEAREST deadline; then id.
 */
export function compareDeadlineRows(
  a: { id: number; priority: number; deadline_at: string | null },
  b: { id: number; priority: number; deadline_at: string | null },
): number {
  if (a.priority !== b.priority) return b.priority - a.priority
  const da = a.deadline_at ? Date.parse(a.deadline_at) : Infinity
  const db = b.deadline_at ? Date.parse(b.deadline_at) : Infinity
  if (da !== db) return da < db ? -1 : 1
  return a.id - b.id
}

/** Why a Defer of the lead day is refused for one task (`refused[].reason`). */
export type LeadDeferRefusal = 'safety_net' | 'after_safety_net' | 'not_later' | 'not_on_page'

export const LEAD_DEFER_MESSAGES: Record<LeadDeferRefusal, string> = {
  safety_net: 'The deadline is close: only a target or done takes it off the deadlines page',
  after_safety_net: 'That day is too close to the deadline: defer at most to two days before it',
  not_later: 'Defer to a day after today and after its current lead day',
  not_on_page: 'Only a deadline task with no target is on the deadlines page',
}

/**
 * DEFER (plan §3): moves THIS instance's lead day to `day` — later than
 * today and than its current lead day, and at most D−2 (the safety net's start minus one). Refused once
 * the safety net holds the task (today ≥ D−1). Null when allowed.
 */
export function leadDeferRefusal(
  task: { due_at: string | null; deadline_at: string | null; lead_from?: string | null },
  day: string,
  timezone: string,
  now: Date,
  rolloverTime: string | null,
): LeadDeferRefusal | null {
  if (!isDeadlinePageTask(task)) return 'not_on_page'
  if (inSafetyNet(task.deadline_at!, timezone, now, rolloverTime)) return 'safety_net'
  if (day <= openTaskToday(timezone, now, rolloverTime)) return 'not_later'
  // A Defer only ever moves the lead day LATER (a day before it is no defer).
  if (task.lead_from && day <= task.lead_from) return 'not_later'
  return day > lastDeferDay(task.deadline_at!, timezone, rolloverTime) ? 'after_safety_net' : null
}

/** The latest day a Defer may pick (D−2), for the day menu. */
export function lastDeferDay(
  deadlineAt: string,
  timezone: string,
  rolloverTime: string | null,
): string {
  return shiftDay(deadlineDay(deadlineAt, timezone, rolloverTime), -2, timezone)
}

// ===========================================================================
// UPCOMING — the heads-up segment
// ===========================================================================

/**
 * UPCOMING — the heads-up segment (2026-10-12, spec §2; split into LATER and
 * TOMORROW 2026-10-25, plan `plan-upcoming-split-1024.md`; docs/TASK-MODEL.md
 * § Upcoming). Read by the server (`src/core/tasks/task-segments.ts`) and the
 * web UI.
 *
 * A target makes a task quiet until its date (spec §1). Upcoming is the one
 * exception: a task whose ANCHOR hasn't arrived shows in one of two SECTIONS
 * of the one Upcoming page before it. It holds one-off tasks with a target the
 * user picked (a relative target counts: it is a real target), repeating
 * tasks' next occurrences and future decks — never reminders or quotas, never
 * a deadline's automatic target (§8.5, its task stays in its horizon segment)
 * and, with the deadlines page drawn, never a target-less deadline task (rule
 * 3: the page alone holds it, from its lead day — `deadlinePlace`).
 *
 * THE RULE (`upcomingDays`). A = the anchor's OpenTask day (the picked target,
 * else the future deck day); set day = the OpenTask day of `target_set_at`
 * (when the target was last set, by any path); wait = A − set day; lead =
 * `lead_days` (the user's override, days ahead of the anchor; series-level on
 * a repeat) ?? `deadlineLeadDays(wait)` — the one lead table: under 2 → 0, up
 * to 7 → 1, then 3, from 16 → 4. Then:
 *   - TOMORROW = A − 1, only when wait ≥ 2 — a task made today for tomorrow
 *     gets none: the day before is the day you made it (and a defer sweep to
 *     tomorrow would otherwise fill Tomorrow every evening);
 *   - LATER = max(A − lead, set day + 1), only when that is ≤ A − 2 — so an
 *     override longer than the wait is clamped to the day after it was set,
 *     and a lead of 1 has no Later at all.
 * Under the default leads these are exactly the 2026-10-12 heads-up days: the
 * day before when wait ≥ 2, and 3 / 4 days before when wait > 7.
 * OPENTASK DAYS throughout (Luxon calendar days in the user's zone, cut at the
 * day start) — UTC days or 24-hour math give the wrong wait across DST and
 * late at night.
 *
 * PLACEMENT, one row a day. A Tomorrow row shows only ON A − 1. A Later row
 * shows from the Later day and CARRIES OVER — the same single row, day after
 * day — until it is seen (`last_considered_at` on or after the Later day),
 * at the latest to A − 2: on A − 1 the task is in Tomorrow, whatever Later
 * said. Seen is PER SECTION with no new state: seeing it in Later does not
 * silence Tomorrow, because Tomorrow's day comes after that stamp. On A it
 * leaves (it is over target, or on deck). Never counted over target, never
 * notified. The check-in day plays no part. Derived on read, no backfill.
 */

/** The day-before heads-up (Tomorrow) needs at least this wait (in local days). */
export const HEADS_UP_DAY_BEFORE_MIN_WAIT = 2
/** Up to this wait the default lead is the day before (no Later); over it, 3 or 4. */
export const HEADS_UP_EARLY_AFTER_WAIT = 7
/** At or over this wait the default Later is 4 days out, under it 3. */
export const HEADS_UP_LONG_WAIT = 16
export const HEADS_UP_EARLY_LEAD_DAYS = 3
export const HEADS_UP_LONG_LEAD_DAYS = 4

/** Upcoming's two sections, in the order the page lists them (Tomorrow first). */
export const UPCOMING_SECTIONS = ['tomorrow', 'later'] as const
export type UpcomingSection = (typeof UPCOMING_SECTIONS)[number]

/** Whole local days from `setDay` to `targetDay` (both local start-of-day). */
export function waitDays(targetDay: DateTime, setDay: DateTime): number {
  return Math.round(targetDay.diff(setDay, 'days').days)
}

/**
 * THE 3/4 LEAD: the default Later day for a long wait, and the far end of the
 * one lead table (`deadlineLeadDays`, which the deadlines page and the
 * automatic targets use too). 3 days when the wait is under
 * HEADS_UP_LONG_WAIT (16) local days, 4 days at 16 or more.
 */
export function leadDaysForWait(wait: number): number {
  return wait < HEADS_UP_LONG_WAIT ? HEADS_UP_EARLY_LEAD_DAYS : HEADS_UP_LONG_LEAD_DAYS
}

/**
 * THE TWO UPCOMING DAYS for an anchor on `anchorDay` set on `setDay` (both
 * local start-of-day), with the lead override `leadDays` (null = the default
 * table): `{ later, tomorrow }`, each a local start-of-day or null (see the
 * rule above). Calendar arithmetic, so a DST change between them still lands
 * on local midnight.
 */
export function upcomingDays(
  anchorDay: DateTime,
  setDay: DateTime,
  leadDays: number | null,
): { later: DateTime | null; tomorrow: DateTime | null } {
  const wait = waitDays(anchorDay, setDay)
  const tomorrow = wait >= HEADS_UP_DAY_BEFORE_MIN_WAIT ? anchorDay.minus({ days: 1 }) : null
  const lead = leadDays ?? deadlineLeadDays(wait)
  const earliest = setDay.plus({ days: 1 })
  const byLead = anchorDay.minus({ days: lead })
  const later = byLead < earliest ? earliest : byLead
  return { later: later <= anchorDay.minus({ days: 2 }) ? later : null, tomorrow }
}

/** The fields the Upcoming rule reads. */
export interface UpcomingTaskFields extends TargetFields {
  target_set_at: string | null
  created_at: string
  last_completed_at?: string | null
  last_considered_at: string | null
  segment_deferred_at: string | null
  /** On deck (2026-10-20): a future deck's day is the anchor. */
  on_deck_day?: string | null
  /** The lead override (days ahead of the anchor), or null/absent: the default table. */
  lead_days?: number | null
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
 * the user PICKED on a one-off (§8.5 — an automatic deadline target never has
 * Upcoming rows; the deadline pull-in already shows the task), or a repeating
 * task's occurrence. The caller has already left out reminders, quotas and
 * anything done or deleted.
 */
export function upcomingCandidate(task: Pick<TargetFields, 'due_at' | 'target_auto'>): boolean {
  return hasPickedTarget(task)
}

/** Where a task stands in today's Upcoming (`upcomingState`). */
export interface UpcomingPlace {
  state: SegmentState
  /** The anchor instant the row is ordered by (the target, or the deck day's local midnight). */
  target: string
  section: UpcomingSection
}

/**
 * The anchor's OpenTask day and instant, or null when the task has none: a
 * future deck's DAY (every deck write stamps `target_set_at`, A6 — a deck and
 * a picked target never coexist), else a target the user PICKED
 * (`upcomingCandidate`: one-off, relative target, a repeat's occurrence).
 */
function upcomingAnchor(
  task: UpcomingTaskFields,
  timezone: string,
  dayOf: (iso: string) => DateTime,
): { day: DateTime; target: string } | null {
  if (task.on_deck_day) {
    const day = parseDeckDay(task.on_deck_day, timezone)
    return day ? { day, target: day.toUTC().toISO()! } : null
  }
  if (!upcomingCandidate(task)) return null
  return { day: dayOf(task.due_at!), target: task.due_at! }
}

/**
 * Where the task stands in today's Upcoming, or null when it is not there:
 * - its anchor is today or earlier (over target / on deck), or it has none;
 * - neither of its Upcoming days has come (`upcomingDays`);
 * - in Later, it was seen on or after the Later day (but not today).
 * The section: Tomorrow on A − 1, else Later (from the Later day, carried
 * over until seen). Seen today → 'considered' (listed ticked, so "X of Y" and
 * put-back work); Defer All today → 'deferred'; otherwise 'waiting'. `target`
 * is the anchor the row is ordered by (within its section).
 *
 * ON DECK (2026-10-20, B6, spec rule 5): a future deck is an anchor like a
 * picked target, its days counted to its DAY from `target_set_at`. On its day
 * and after, it is in the On deck section (`deckIsToday`), not here. A deck
 * outranks a deadline's automatic target, which has no Upcoming rows of its own.
 */
export function upcomingState(
  task: UpcomingTaskFields,
  timezone: string,
  now: Date,
  /** The user's day boundary (`localDay`): Upcoming days are OpenTask days. */
  dayStart: string,
): UpcomingPlace | null {
  const today = openTaskLocalDay(now, timezone, dayStart)
  const dayOf = (iso: string) => localDay(iso, timezone, dayStart)
  const anchor = upcomingAnchor(task, timezone, dayOf)
  if (!anchor || anchor.day <= today) return null
  const { target } = anchor

  const { later, tomorrow } = upcomingDays(
    anchor.day,
    dayOf(targetSetAtOf(task)),
    task.lead_days ?? null,
  )
  let section: UpcomingSection
  let from: DateTime
  if (tomorrow && +tomorrow === +today) {
    section = 'tomorrow'
    from = tomorrow
  } else if (later && later <= today) {
    section = 'later'
    from = later
  } else {
    return null
  }

  const considered = task.last_considered_at ? dayOf(task.last_considered_at) : null
  if (considered && +considered === +today) return { state: 'considered', target, section }
  if (considered && considered >= from) return null
  if (task.segment_deferred_at && +dayOf(task.segment_deferred_at) === +today) {
    return { state: 'deferred', target, section }
  }
  return { state: 'waiting', target, section }
}

/**
 * The row's gap text (spec §2): "Target Tue Nov 3 · deadline Sat Nov 7".
 * No deadline: "Target Tue Nov 3". No "(+4d)" / "(same day)" gap count: Trent,
 * 2026-10-12, "I don't even know what +3 days means" — the two dates say it.
 * The target is never after a deadline still ahead (§8.2). Returned in parts
 * so the row can make the target a chip.
 */
export function upcomingGap(
  task: Pick<TargetFields, 'due_at' | 'deadline_at'> & { on_deck_day?: string | null },
  timezone: string,
  /**
   * The user's day boundary (`useDayStart`): L9's night rule (`nightDay`,
   * part 2, 2026-10-26) — a target or deadline between midnight and the day
   * start names its OpenTask day: a Fri 01:00 target is "Target Thu night
   * Oct 29", on a Tomorrow row "Target tomorrow night 1:00 AM".
   */
  dayStart: string,
  /**
   * The row's section (2026-10-25): a TOMORROW row's day goes without saying
   * (it is tomorrow), so it says only the time — "Target 9:00 AM" — except a
   * deck, which has no time: "On deck tomorrow" (2026-10-27, Trent: a bare
   * "On deck" read as "on deck now?"). A Later row (or no section) says the
   * day as before. The deadline keeps its date either way.
   */
  section?: UpcomingSection,
): { target: string | null; deadline: string | null } {
  // Its night (L9): the OpenTask day's weekday and date, "Thu night Oct 29".
  const fmt = (iso: string) =>
    isLateNight(new Date(iso), timezone, dayStart)
      ? nightWords(openTaskDayOf(new Date(iso), timezone, dayStart), timezone)
      : DateTime.fromISO(iso, { zone: 'utc' }).setZone(timezone).toFormat('ccc LLL d')
  const tomorrow = section === 'tomorrow'
  // On deck (2026-10-20): "On deck Sat Oct 24" — the day, no time. It wins
  // over a deadline's automatic target, which is not the plan.
  let target: string | null = null
  const deck = task.on_deck_day ? parseDeckDay(task.on_deck_day, timezone) : null
  if (deck) {
    target = tomorrow ? 'On deck tomorrow' : `On deck ${deck.toFormat('ccc LLL d')}`
  } else if (task.due_at) {
    const time = DateTime.fromISO(task.due_at, { zone: 'utc' }).setZone(timezone).toFormat('h:mm a')
    // A Tomorrow row's 1:00 AM is tomorrow NIGHT's, not tonight's: said.
    const night = isLateNight(new Date(task.due_at), timezone, dayStart)
    target = tomorrow
      ? `Target ${night ? 'tomorrow night ' : ''}${time}`
      : `Target ${fmt(task.due_at)}`
  }
  if (!task.deadline_at) return { target, deadline: null }
  return { target, deadline: `deadline ${fmt(task.deadline_at)}` }
}

/** An OpenTask date's night, for a label (L9): "Thu night Oct 29". */
function nightWords(date: string, timezone: string): string {
  const day = DateTime.fromISO(date, { zone: timezone })
  return `${day.toFormat('ccc')}${NIGHT_SUFFIX} ${day.toFormat('LLL d')}`
}

/**
 * Whether a target can be removed ("Remove target", 2026-10-22 — it replaced
 * "Back to auto"): a one-off with a target the user picked, deadline or not.
 * Removed, a task with no deadline goes back to its horizon segment, and one
 * with a deadline onto the deadlines page from its lead day (quiet before it,
 * rule 3). Null: nothing to offer — no target, a repeating task (its target goes
 * with its recurrence, in the editor's own menu), or, with the task queue
 * off, the deadline's automatic target (`target_auto`, still written there
 * for one release, A1). Every surface that offers it reads it here: the row
 * menus, the defer menu, the editor and Upcoming's target chip.
 */
export function targetReset(task: {
  due_at: string | null
  deadline_at: string | null
  target_auto?: boolean
  rrule?: string | null
}): 'remove' | null {
  if (task.rrule || task.due_at === null || task.target_auto) return null
  return 'remove'
}

/**
 * Which buttons an Upcoming row offers (2026-10-12): Today and its picker on
 * EVERY row — since the occurrence is kept apart from the target (§6), moving
 * a repeating task's target no longer resets its schedule, so Today on one is
 * safe (done that day advances to the next scheduled occurrence; the deadline
 * still measures from the occurrence). Remove target per `targetReset`.
 */
export function upcomingRowActions(row: {
  recurring: boolean
  task: { due_at: string | null; deadline_at: string | null; target_auto?: boolean }
}): { today: boolean; reset: 'remove' | null } {
  return { today: true, reset: row.recurring ? null : targetReset(row.task) }
}

// ===========================================================================
// ON DECK (2026-10-20; docs/TASK-MODEL.md § On deck)
// ===========================================================================

/**
 * ON DECK — a target's DAY without its nag: "I'd like to get to this on that
 * day; if it gets done it gets done." `tasks.on_deck_day` is the owner's
 * OPENTASK date (yyyy-MM-dd) — since "Day starts at" PR 2 (2026-10-24,
 * everything uses the OpenTask date; it was the calendar date under red-team
 * A2): "today" between midnight and a 3:00 AM day start is the day that is
 * ending, so a deck for "today" made then is stripped at 3:00 — the late
 * night's pick is "Tomorrow". The rules:
 *
 *  1. A task carries a picked target OR a deck, never both. Decking drops a
 *     picked target (a deadline task keeps its AUTOMATIC one — the deadline
 *     protects regardless); a pick clears the deck (`src/core/tasks/deck-clear.ts`).
 *  2. A deck never nags: no over target, no badge, no Snooze-all.
 *  3. Decking a queued task takes it out of the queue.
 *  4. At the rollover an undone deck whose day has ended goes to the queue
 *     at every priority, remembering its day (`queued_from_deck_day`).
 *  5. A future deck shows in Upcoming on the heads-up days a picked target
 *     would get (`upcomingState`); today's is in the On deck section.
 *  6. No reminder or quota. A REPEATING task can be decked (Trent,
 *     2026-10-20: "It needs to be added."): the deck is for its CURRENT
 *     occurrence — `occurrence_at` stays, `due_at` is NULL while decked (never
 *     a held value: old native builds read over-target from `due_at` alone),
 *     taking it off deck puts `due_at` back on the occurrence, and the
 *     rollover hands an un-done one to the repeating rules (roll or wait).
 *
 * A deadline task can be decked only while its automatic target is still
 * ahead, and only BEFORE that target's day (red-team A1), so a deck
 * never sits on a task that is already nagging (`deckRefusal`). A repeating
 * task has no automatic target: its deck must come before its (per-occurrence)
 * deadline's own day, while that deadline is ahead.
 */

/** The deck day's format: a local calendar date. */
export const DECK_DAY_FORMAT = 'yyyy-MM-dd'

/** Why a deck write is refused for one task (the response's `refused[].reason`). */
export type DeckRefusal = 'deadline_nagging' | 'after_auto_target'

/** Why a task cannot be decked at all (the endpoint skips and counts it). */
export type DeckSkip = 'recurring' | 'reminder' | 'quota' | 'done' | 'trashed'

const DECK_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/**
 * A deck day as the local start of that day, or null when it is not a valid
 * yyyy-MM-dd date. Never throws (Luxon throws on an invalid date here,
 * `throwOnInvalid`): a hand-written stored value must not take down a read.
 */
export function parseDeckDay(day: string, timezone: string): DateTime | null {
  if (!DECK_DAY_PATTERN.test(day)) return null
  try {
    const d = DateTime.fromISO(day, { zone: timezone })
    return d.isValid ? d.startOf('day') : null
  } catch {
    return null
  }
}

/**
 * What is wrong with a deck day, or null: not a yyyy-MM-dd date, or a day
 * before today's OpenTask date (the earliest deck is today). `dayStart`: the
 * owner's day boundary (`dayBoundaryForUser` / `useDayStart`).
 */
export function deckDayProblem(
  day: string,
  timezone: string,
  now: Date,
  dayStart: string,
): string | null {
  if (!parseDeckDay(day, timezone)) {
    return 'The deck day must be a date (yyyy-MM-dd)'
  }
  if (day < openTaskDayOf(now, timezone, dayStart)) return 'The deck day must be today or later'
  return null
}

/**
 * Whether the task is on deck for TODAY (the OpenTask day): its day, or an
 * earlier one not yet stripped — a rollover that has not run yet leaves
 * yesterday's leftovers counting until it sends them to the queue.
 */
export function deckIsToday(
  task: { on_deck_day?: string | null },
  timezone: string,
  now: Date,
  dayStart: string,
): boolean {
  return !!task.on_deck_day && task.on_deck_day <= openTaskDayOf(now, timezone, dayStart)
}

/**
 * The kind test: what keeps a task off deck altogether, or null. A repeating
 * task is no longer one of them (2026-10-20); `'recurring'` stays in the type
 * (and `skipped_recurring` in the deck endpoint's answer, always 0 now) for
 * clients that read it.
 */
export function deckSkip(task: {
  rrule?: string | null
  is_reminder?: boolean
  is_tracked?: boolean
  progress_target?: number
  done?: boolean
  deleted_at?: string | null
}): DeckSkip | null {
  if (task.deleted_at) return 'trashed'
  if (task.done) return 'done'
  if (task.is_reminder) return 'reminder'
  if (task.is_tracked || (task.progress_target ?? 1) > 1) return 'quota'
  return null
}

/**
 * A1, THE DEADLINES PAGE'S RULE (2026-10-22, plan §5 — replaces the 10-20
 * "before the automatic target's day" rule): a deadline task, one-off or
 * repeating, goes on deck for any day up to and INCLUDING its deadline's
 * OpenTask day D (`repeatingDeadlineDay`), while the deadline is ahead:
 *  - `deadline_nagging` (the API enum, kept): the deadline has passed —
 *    "This deadline has passed";
 *  - `after_auto_target` (the enum, kept): the day is after D — "That day is
 *    after this task's deadline".
 * A deck on D itself is allowed: a target-less deadline task's safety net
 * (from D−1) still holds it on the deadlines page, deck or not. No deadline:
 * never refused. Decks exist only with the task-queue switch on, so this is
 * the only rule there is. `rolloverTime` (the owner's, `deckRolloverTime`)
 * makes D the OpenTask day; without one, the calendar day.
 */
export function deckRefusal(
  task: Pick<TargetFields, 'deadline_at'>,
  day: string,
  ctx: TargetContext,
  now: Date,
  rolloverTime: string | null,
): DeckRefusal | null {
  if (!task.deadline_at) return null
  if (Date.parse(task.deadline_at) <= now.getTime()) return 'deadline_nagging'
  const deadlineDay = repeatingDeadlineDay(task.deadline_at, ctx.timezone, rolloverTime)
  return day > deadlineDay ? 'after_auto_target' : null
}

/**
 * A repeating task's deadline DAY for the deck check (review 2026-10-20): the
 * OpenTask day it falls in — the local day of `deadline − rollover time`. A
 * deadline between local midnight and the rollover belongs to the evening
 * before: a deck on that calendar day would last until the rollover, so the
 * deadline would pass while decked, silently (the rollover only gives the
 * target back after it). The deck must come BEFORE this day. Without a
 * rollover time (the switch off — no decks then anyway): the calendar day.
 */
export function repeatingDeadlineDay(
  deadlineAt: string,
  timezone: string,
  rolloverTime: string | null,
): string {
  return openTaskDayOf(new Date(deadlineAt), timezone, rolloverTime ?? CALENDAR_DAY_START)
}

/** The refusal's words (the API's `refused[].message`; D2's toast reads the first). */
export const DECK_REFUSAL_MESSAGES: Record<DeckRefusal, string> = {
  deadline_nagging: 'This deadline has passed.',
  after_auto_target: "That day is after this task's deadline.",
}

/**
 * A repeating task refused for its deadline's day (`after_auto_target`, the
 * enum kept): its deadline is per occurrence and never "starts reminding", so
 * a PATCH's 400 says this (the web's toast too, `deckErrorMessage`).
 */
export const REPEATING_DECK_REFUSAL_MESSAGE = "That day is after this task's deadline."

/** The counts a deck write reports (`POST /api/tasks/deck`). */
export interface DeckResultCounts {
  day: string | null
  decked: number
  undecked: number
  skipped_recurring: number
  skipped_reminder: number
  skipped_quota: number
  skipped_done: number
  skipped_trashed: number
  refused: { id: number; reason: DeckRefusal }[]
}

/** "today", "tomorrow", else "Sat Oct 24" — a deck day as words, by the OpenTask today. */
export function deckDayWords(day: string, timezone: string, now: Date, dayStart: string): string {
  const today = openTaskLocalDay(now, timezone, dayStart)
  const d = DateTime.fromISO(day, { zone: timezone })
  if (+d === +today) return 'today'
  if (+d === +today.plus({ days: 1 })) return 'tomorrow'
  return d.toFormat('ccc LLL d')
}

function countWord(k: number, one: string, many: string): string {
  return k === 1 ? `1 ${one}` : `${k} ${many}`
}

/**
 * The one line a deck write answers with (the API's `summary`, the undo
 * entry's description, D2's toast): "3 tasks on deck for tomorrow · 1
 * repeating skipped". A lone refusal says why, in the toast's words.
 */
export function deckSummary(
  r: DeckResultCounts,
  timezone: string,
  now: Date,
  dayStart: string,
): string {
  const parts: string[] = []
  if (r.day === null) {
    parts.push(
      r.undecked > 0
        ? `Took ${countWord(r.undecked, 'task', 'tasks')} off deck`
        : 'Nothing on deck',
    )
  } else if (r.decked > 0) {
    const words = deckDayWords(r.day, timezone, now, dayStart)
    parts.push(`${countWord(r.decked, 'task', 'tasks')} on deck for ${words}`)
  }
  const skipped = [
    r.skipped_recurring > 0 ? `${r.skipped_recurring} repeating` : null,
    r.skipped_reminder > 0 ? countWord(r.skipped_reminder, 'reminder', 'reminders') : null,
    r.skipped_quota > 0 ? countWord(r.skipped_quota, 'quota', 'quotas') : null,
    r.skipped_done > 0 ? `${r.skipped_done} done` : null,
    r.skipped_trashed > 0 ? `${r.skipped_trashed} in trash` : null,
  ].filter((p): p is string => p !== null)
  if (skipped.length > 0) parts.push(`${skipped.join(', ')} skipped`)
  if (r.refused.length === 1 && parts.length === 0) {
    return DECK_REFUSAL_MESSAGES[r.refused[0].reason]
  }
  if (r.refused.length > 0) parts.push(`${r.refused.length} refused (deadline close)`)
  return parts.length > 0 ? parts.join(' · ') : 'Nothing to put on deck'
}
