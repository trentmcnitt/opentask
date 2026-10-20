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
 * (`capAtDeadline`) and the picker's "Deadline day"; the effective horizon; the
 * check-in day and the horizon segments' days (`latestSegmentDay`); segment
 * membership and carry-over (`segmentState`); the two badges (§7: the age
 * thresholds, `ageLabel`, and attempts, `effectiveAttempts`); the recurring
 * deadline (`advanceDeadline`, from the occurrence); and UPCOMING — the wait,
 * the 3/4 lead (`leadDaysForWait`, shared with the auto target), the heads-up
 * days and their carry-over (`headsUpDays`, `upcomingState`).
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
 * task keeps its scheduled occurrence (`occurrence_at`) apart from its target.
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
import { openTaskDayOf, targetOpenTaskDay } from '@/lib/opentask-day'

export const HORIZON_ORDER = ['days', 'weeks', 'months', 'eventually'] as const
export type HorizonValue = (typeof HORIZON_ORDER)[number]

/**
 * The task queue's two panels (task queue PR 3, 2026-10-19; design rules 6-8,
 * docs/TASK-MODEL.md § The task queue). Code words only — the titles on screen
 * are `QUEUE_PANEL_TITLES` in task-model-words.ts:
 * - `queue_today`: queued at or after the latest rollover ("Queued");
 * - `queue_previous`: queued before it ("Previously queued").
 * Only with the server switch on (`OPENTASK_TASK_QUEUE`); `queueKind`, below.
 */
export const QUEUE_KINDS = ['queue_today', 'queue_previous'] as const
export type QueueKind = (typeof QUEUE_KINDS)[number]

/**
 * A task segment's identity: a horizon, Upcoming (2026-10-12, the heads-up
 * segment — `upcomingState`, below), or one of the queue's two panels. In the
 * API, `horizon: "upcoming"` / `"queue_today"` / `"queue_previous"`.
 */
export type SegmentKind = HorizonValue | 'upcoming' | QueueKind

/** Whether a segment is one of the task queue's panels. */
export function isQueueKind(kind: SegmentKind): kind is QueueKind {
  return kind === 'queue_today' || kind === 'queue_previous'
}

/**
 * The order the screens walk the segments: the queue's two panels FIRST (spec
 * rule 6: "the first and foremost thing to handle"), then Upcoming directly
 * after Days and before Weeks, on a check-in day too (spec §2).
 */
export const SEGMENT_ORDER: readonly SegmentKind[] = [
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
 * deadline with no target stores a real target: the user's morning on the
 * deadline's local day minus the LEAD — the same 3/4 lead as Upcoming's early
 * heads-up (`leadDaysForWait`; Trent 10-12: "let's make it consistent
 * everywhere"). The wait is counted in local days from now (when the deadline
 * is set) to the deadline's day. A moment already past is now (ruling Q10): the
 * task is over target at once. Never after the deadline (target ≤ deadline,
 * §8.2), so a deadline already past gives the deadline itself.
 *
 * Example (Chicago, morning 9:00): deadline Fri Oct 23 23:59, set Mon Oct 12 →
 * wait 11, lead 3 → Tue Oct 20, 9:00 AM. Set Sep 30 (wait 23) → lead 4 → Mon
 * Oct 19, 9:00 AM.
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
  const deadlineDay = deadline.setZone(zone).startOf('day')
  const today = DateTime.fromJSDate(now).setZone(zone).startOf('day')
  const leadDay = deadlineDay.minus({ days: leadDaysForWait(waitDays(deadlineDay, today)) })
  const at = ctx ? morningOn(leadDay, ctx) : leadDay
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
}

export interface ResolvedTarget {
  dueAt: string | null
  /** `target_auto` after the write. */
  auto: boolean
  /** The target was pulled back to the deadline (§8.2). */
  capped: boolean
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
  let dueAt = w.dueAt
  let auto = w.wasAuto && !w.dueWritten && w.autoEligible
  if (auto && (w.deadlineChanged || w.deadlineAt === null)) {
    dueAt = null
    auto = false
  }
  if (w.autoEligible && w.deadlineAt !== null && dueAt === null) {
    return { dueAt: autoTargetAt(w.deadlineAt, ctx, now), auto: true, capped: false }
  }
  if (dueAt !== null && capsAt(dueAt, w.deadlineAt, now)) {
    return { dueAt: w.deadlineAt, auto, capped: true }
  }
  return { dueAt, auto, capped: false }
}

/**
 * The picker's "Deadline day" (ruling Q8): the user's morning on the
 * deadline's own local day — or the deadline itself, if that is earlier.
 */
export function deadlineDayTarget(
  deadlineAt: string,
  ctx: TargetContext | null = clientContext,
): string {
  const deadline = DateTime.fromISO(deadlineAt, { zone: 'utc' })
  if (!ctx) return deadline.startOf('day').toISO()!
  const morning = morningOn(deadline.setZone(ctx.timezone).startOf('day'), ctx)
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
  checkInDay: CheckInDay = CHECK_IN_DAY_DEFAULT,
): { horizon: HorizonValue; state: SegmentState } | null {
  if (hasPickedTarget(task)) return null
  // ON DECK is quiet like a picked target (B6): no horizon segment. A future
  // deck shows in Upcoming on its heads-up days, today's in the On deck section.
  if (task.on_deck_day) return null
  if (targetIsToday(task.due_at, timezone, now)) return null
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
  rolloverTime: string | null = null,
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
  const dayOf = (iso: string): DateTime =>
    rolloverTime
      ? DateTime.fromISO(openTaskDayOf(new Date(iso), timezone, rolloverTime), { zone: timezone })
      : localDay(iso, timezone)
  // The target's day: an early-morning pick belongs to its calendar day, not
  // the evening's OpenTask day (`targetOpenTaskDay`, the rollover's spare rule).
  const targetDay = rolloverTime
    ? DateTime.fromISO(targetOpenTaskDay(task.due_at, setAt, timezone, rolloverTime), {
        zone: timezone,
      })
    : localDay(task.due_at, timezone)
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
  rolloverTime: string | null = null,
): string {
  const dayOf = (instant: Date): DateTime =>
    rolloverTime
      ? DateTime.fromISO(openTaskDayOf(instant, timezone, rolloverTime), { zone: timezone })
      : DateTime.fromJSDate(instant).setZone(timezone).startOf('day')
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
 * — never automatically: "Remove target?" on a one-off with no deadline,
 * "Back to auto?" on a deadline task whose target the user picked. An
 * automatic target offers nothing (ruling Q9), and a repeating task's target
 * goes only with its recurrence (`targetReset` decides all three). Nor once
 * the deadline has passed: "back to auto" would be the passed deadline, still
 * over target — the deadline itself is what to change.
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
): 'auto' | 'remove' | null {
  if ((task.attempts ?? 0) < ATTEMPTS_OFFER_REMOVE) return null
  const reset = targetReset(task)
  if (reset === 'remove' && opts.queue && queueStrippable(task)) return null
  return reset === 'auto' && isPastDeadline(task.deadline_at, now) ? null : reset
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
 * stays considered at 00:30, inside the same "Queued" panel, until the
 * rollover moves it to "Previously queued", waiting again. Queue panels
 * only: horizon segments and Upcoming stay on midnight (resolution 4).
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
   * passes `rolloverMoment` with the owner's zone and rollover time. Without
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

/**
 * A recurring task's deadline for its next occurrence (2026-10-10, spec §4):
 * the same distance from the new occurrence as it was from the current one, so
 * the weekly Upwork lock moves with the week. Left alone on a stale one, a
 * deadline would cap every later move. Measured from the SCHEDULED occurrence
 * (`occurrence_at`, §6 2026-10-12), never from a moved target, so moving the
 * target never shifts it (the red team's B1 drift). A row from before the
 * column falls back to `original_due_at`, then `due_at`.
 */
export function advanceDeadline(
  task: {
    deadline_at: string | null
    due_at: string | null
    original_due_at: string | null
    occurrence_at?: string | null
  },
  nextDueAt: string | null,
  timezone: string,
): string | null {
  const origin = task.occurrence_at ?? task.original_due_at ?? task.due_at
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
 * days before it. It holds one-off tasks with a target the user picked (a
 * deadline task with its automatic target stays in its horizon segment, its
 * deadline pulling it in)
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
 * Only a PICKED target (§8.5): an automatic deadline target has no rows.
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
 * THE 3/4 LEAD — one function for both rules that use it (Trent 10-12: "let's
 * make it consistent everywhere"): Upcoming's earlier heads-up and the
 * deadline's automatic target (`autoTargetAt`). 3 days when the wait is under
 * HEADS_UP_LONG_WAIT (16) local days, 4 days at 16 or more.
 */
export function leadDaysForWait(wait: number): number {
  return wait < HEADS_UP_LONG_WAIT ? HEADS_UP_EARLY_LEAD_DAYS : HEADS_UP_LONG_LEAD_DAYS
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
    days.push(targetDay.minus({ days: leadDaysForWait(wait) }))
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
  /** On deck (2026-10-20): a future deck's heads-ups count to its day. */
  on_deck_day?: string | null
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

/**
 * Where the task stands in today's Upcoming, or null when it is not there:
 * - its target is today or earlier (over target), or it has no picked one;
 * - no heads-up day has come yet;
 * - it was considered on or after the latest heads-up day (but not today).
 * Considered today → 'considered' (listed ticked, so "X of Y" and put-back
 * work); Defer All today → 'deferred'; otherwise 'waiting'. `target` is the
 * target the row is ordered by.
 */
export function upcomingState(
  task: UpcomingTaskFields,
  timezone: string,
  now: Date,
): { state: SegmentState; target: string } | null {
  const today = DateTime.fromJSDate(now).setZone(timezone).startOf('day')
  let target: string
  let targetDay: DateTime
  if (task.on_deck_day) {
    // ON DECK (2026-10-20, B6, spec rule 5): a future deck gets the heads-ups
    // a picked target would, counted to its DAY from `target_set_at` (every
    // deck write stamps it, A6). On its day and after, it is in the On deck
    // section (`deckIsToday`), not here. A deck outranks a deadline's
    // automatic target, which has no Upcoming rows of its own.
    const day = parseDeckDay(task.on_deck_day, timezone)
    if (!day) return null
    targetDay = day
    target = targetDay.toUTC().toISO()!
  } else {
    if (!upcomingCandidate(task)) return null
    target = task.due_at!
    targetDay = localDay(target, timezone)
  }
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
 * The row's gap text (spec §2): "Target Tue Nov 3 · deadline Sat Nov 7".
 * No deadline: "Target Tue Nov 3". No "(+4d)" / "(same day)" gap count: Trent,
 * 2026-10-12, "I don't even know what +3 days means" — the two dates say it.
 * The target is never after a deadline still ahead (§8.2). Returned in parts
 * so the row can make the target a chip.
 */
export function upcomingGap(
  task: Pick<TargetFields, 'due_at' | 'deadline_at'> & { on_deck_day?: string | null },
  timezone: string,
): { target: string | null; deadline: string | null } {
  const fmt = (iso: string) =>
    DateTime.fromISO(iso, { zone: 'utc' }).setZone(timezone).toFormat('ccc LLL d')
  // On deck (2026-10-20): "On deck Sat Oct 24" — the day, no time. It wins
  // over a deadline's automatic target, which is not the plan.
  let target: string | null = null
  const deck = task.on_deck_day ? parseDeckDay(task.on_deck_day, timezone) : null
  if (deck) {
    target = `On deck ${deck.toFormat('ccc LLL d')}`
  } else if (task.due_at) {
    target = `Target ${fmt(task.due_at)}`
  }
  if (!task.deadline_at) return { target, deadline: null }
  return { target, deadline: `deadline ${fmt(task.deadline_at)}` }
}

/**
 * What a target can be sent back to (§8.3, ruling Q9, 2026-10-12):
 * - 'auto': "Back to auto" — a one-off with a deadline whose target the user
 *   picked. A deadline task never has Remove target; its target goes back to
 *   the deadline's automatic one. An auto target offers neither.
 * - 'remove': "Remove target" — a one-off with a target and no deadline (back
 *   to its horizon segment).
 * - null: nothing to offer (no target, an auto target, or a repeating task —
 *   whose target goes with its recurrence, in the editor's own menu).
 * Every surface that offers either reads it here: the row menus, the snooze
 * menu, the editor and Upcoming's target chip.
 */
export function targetReset(task: {
  due_at: string | null
  deadline_at: string | null
  target_auto?: boolean
  rrule?: string | null
}): 'auto' | 'remove' | null {
  if (task.rrule || task.due_at === null || task.target_auto) return null
  return task.deadline_at !== null ? 'auto' : 'remove'
}

/**
 * Which buttons an Upcoming row offers (2026-10-12): Today and its picker on
 * EVERY row — since the occurrence is kept apart from the target (§6), moving
 * a repeating task's target no longer resets its schedule, so Today on one is
 * safe (done that day advances to the next scheduled occurrence; the deadline
 * still measures from the occurrence). Back to auto / Remove target per
 * `targetReset`.
 */
export function upcomingRowActions(row: {
  recurring: boolean
  task: { due_at: string | null; deadline_at: string | null; target_auto?: boolean }
}): { today: boolean; reset: 'auto' | 'remove' | null } {
  return { today: true, reset: row.recurring ? null : targetReset(row.task) }
}

// ===========================================================================
// ON DECK (2026-10-20; docs/TASK-MODEL.md § On deck)
// ===========================================================================

/**
 * ON DECK — a target's DAY without its nag: "I'd like to get to this on that
 * day; if it gets done it gets done." `tasks.on_deck_day` is the owner's local
 * CALENDAR date (yyyy-MM-dd; red-team A2 — "today" between midnight and the
 * rollover is the coming calendar day, not the OpenTask day). The rules:
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
 *  6. One-offs only (no repeating task, reminder or quota).
 *
 * A deadline task can be decked only while its automatic target is still
 * ahead, and only on or before that target's day (red-team A1), so a deck
 * never sits on a task that is already nagging (`deckRefusal`).
 */

/** The deck day's format: a local calendar date. */
export const DECK_DAY_FORMAT = 'yyyy-MM-dd'

/** Why a deck write is refused for one task (the response's `refused[].reason`). */
export type DeckRefusal = 'deadline_nagging' | 'after_auto_target'

/** Why a task cannot be decked at all (the endpoint skips and counts it). */
export type DeckSkip = 'recurring' | 'reminder' | 'quota' | 'done' | 'trashed'

/** The local calendar date (yyyy-MM-dd) of `now` in `timezone`. */
export function calendarToday(timezone: string, now: Date): string {
  return DateTime.fromJSDate(now).setZone(timezone).toFormat(DECK_DAY_FORMAT)
}

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
 * What is wrong with a deck day, or null: not a yyyy-MM-dd calendar date, or
 * a day before the calendar today (the earliest deck is today).
 */
export function deckDayProblem(day: string, timezone: string, now: Date): string | null {
  if (!parseDeckDay(day, timezone)) {
    return 'The deck day must be a date (yyyy-MM-dd)'
  }
  if (day < calendarToday(timezone, now)) return 'The deck day must be today or later'
  return null
}

/**
 * Whether the task is on deck for TODAY (calendar day): its day, or an
 * earlier one not yet stripped — yesterday's leftovers between midnight and
 * the rollover still count (A2) until the rollover sends them to the queue.
 */
export function deckIsToday(
  task: { on_deck_day?: string | null },
  timezone: string,
  now: Date,
): boolean {
  return !!task.on_deck_day && task.on_deck_day <= calendarToday(timezone, now)
}

/** The kind test: what keeps a task off deck altogether, or null. */
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
  if (task.rrule) return 'recurring'
  return null
}

/**
 * A1 (red team, APPROVED 2026-10-20): a deadline task goes on deck only while
 * its AUTOMATIC target is still ahead, and only on or before that target's
 * local day — so a deck never nags and Snooze-all never meets one.
 *  - `deadline_nagging`: the automatic target has arrived (or the deadline
 *    has passed) — "This deadline is close and already reminding you — use
 *    Today."
 *  - `after_auto_target`: the day is after the automatic target's day.
 * The automatic target is the one the deck leaves: the stored one when the
 * target already is automatic, else (decking drops a picked target) the one
 * "Back to auto" computes now. No deadline: never refused.
 */
export function deckRefusal(
  task: Pick<TargetFields, 'due_at' | 'deadline_at' | 'target_auto'>,
  day: string,
  ctx: TargetContext,
  now: Date,
): DeckRefusal | null {
  if (!task.deadline_at) return null
  const auto =
    task.target_auto && task.due_at ? task.due_at : autoTargetAt(task.deadline_at, ctx, now)
  if (Date.parse(auto) <= now.getTime()) return 'deadline_nagging'
  const autoDay = DateTime.fromISO(auto, { zone: 'utc' })
    .setZone(ctx.timezone)
    .toFormat(DECK_DAY_FORMAT)
  return day > autoDay ? 'after_auto_target' : null
}

/** The refusal's words (the API's `refused[].message`; D2's toast reads the first). */
export const DECK_REFUSAL_MESSAGES: Record<DeckRefusal, string> = {
  deadline_nagging: 'This deadline is close and already reminding you — use Today.',
  after_auto_target: 'That day is after this deadline starts reminding you.',
}

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

/** "today", "tomorrow", else "Sat Oct 24" — a deck day as words. */
export function deckDayWords(day: string, timezone: string, now: Date): string {
  const today = DateTime.fromISO(calendarToday(timezone, now), { zone: timezone })
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
export function deckSummary(r: DeckResultCounts, timezone: string, now: Date): string {
  const parts: string[] = []
  if (r.day === null) {
    parts.push(
      r.undecked > 0
        ? `Took ${countWord(r.undecked, 'task', 'tasks')} off deck`
        : 'Nothing on deck',
    )
  } else if (r.decked > 0) {
    const words = deckDayWords(r.day, timezone, now)
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
