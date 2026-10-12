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
  const today = DateTime.fromJSDate(now).setZone(timezone).startOf('day')
  const end = arrived ? today : today.minus({ days: 1 })
  const starts = [
    localDay(task.due_at, timezone),
    localDay(setAt, timezone),
    localDay(task.created_at, timezone),
  ]
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
): string {
  const completedDay = localDay(completedAt, timezone)
  const arrived = targetWas !== null && Date.parse(targetWas) <= Date.parse(completedAt)
  const counted = arrived ? completedDay : completedDay.minus({ days: 1 })
  const yesterday = DateTime.fromJSDate(now).setZone(timezone).startOf('day').minus({ days: 1 })
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
 * goes only with its recurrence (`targetReset` decides all three).
 */
export function attemptsOffer(task: {
  due_at: string | null
  deadline_at: string | null
  target_auto?: boolean
  rrule?: string | null
  attempts?: number
}): 'auto' | 'remove' | null {
  return (task.attempts ?? 0) >= ATTEMPTS_OFFER_REMOVE ? targetReset(task) : null
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
  if (!upcomingCandidate(task)) return null
  const target = task.due_at!
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
 * No deadline: "Target Tue Nov 3". A deadline the same day as the target:
 * "(same day)". The target is never after the deadline (§8.2). Returned in
 * parts so the row can make the target a chip.
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
  return { target, deadline: gap <= 0 ? `${deadline} (same day)` : `${deadline} (+${gap}d)` }
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
