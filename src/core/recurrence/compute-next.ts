/**
 * Recurrence computation engine for OpenTask
 *
 * THE core algorithm: given a task with an RRULE, compute the next occurrence.
 *
 * Key insight: rrule.js BYHOUR operates in UTC, which doesn't work for local-time
 * recurring patterns. Instead, we:
 * 1. Don't use BYHOUR/BYMINUTE in the RRule
 * 2. Set DTSTART with the local time (as a "naive" Date)
 * 3. Convert input/output between timezone-aware and "naive local"
 *
 * This "naive local" approach treats JavaScript Date objects as timezone-naive,
 * using their local time methods (getHours(), etc.) rather than UTC methods.
 */

import { RRule, Weekday } from 'rrule'
import { DateTime } from 'luxon'
import { ValidationError } from '@/core/errors'
import { ordinalsCount, parseRRule, type RRuleComponents } from './rrule-builder'
import { parseAnchorTime } from './timezone'
import { toNaiveLocal, fromNaiveLocal } from './utils'
import {
  dayStartMoment,
  openTaskDayOf,
  openTaskLocalDay,
  periodOpensAt,
  periodOpensOnDate,
} from '@/lib/opentask-day'
import { toHHMM } from '@/lib/rrule-draft'

// Map our DOW (0=Mon..6=Sun) to rrule.js Weekday constants
const DOW_TO_RRULE_WEEKDAY: Weekday[] = [
  RRule.MO,
  RRule.TU,
  RRule.WE,
  RRule.TH,
  RRule.FR,
  RRule.SA,
  RRule.SU,
]

/**
 * Frequency string to RRule constant
 */
const FREQ_MAP: Record<string, number> = {
  DAILY: RRule.DAILY,
  WEEKLY: RRule.WEEKLY,
  MONTHLY: RRule.MONTHLY,
  YEARLY: RRule.YEARLY,
}

/**
 * The pattern's epoch, for a rule with no grid of its own: a rule that pins
 * its own phase (every INTERVAL=1 rule with a day — `FREQ=DAILY`,
 * `BYDAY=SU`, `BYMONTHDAY=1` — lands on the same days from any dtstart), and
 * a floating rule asked without an anchor (a row with no date at all, e.g. a
 * quota's bare period rule, or a dateless row's "is there one today?").
 * Fixed so that the answer never depends on when it is asked. A floating rule
 * WITH an anchor never reads it — see `phaseFloats`.
 */
const PATTERN_EPOCH_YEAR = 2020

/**
 * Move dtstart by whole periods of the rule so it sits a couple of periods
 * before `ref`.
 *
 * rrule.js finds `after(ref)` by iterating occurrences forward from dtstart,
 * so a DAILY rule anchored in 2020 walks ~2,500 days for every single "is this
 * due today?" question. With ~185 recurring rows that put ~2.3 s inside every
 * check-off (the badge recount) and ~0.8 s inside every reminders load, and the
 * same cost in the browser when the Today view groups by slot. Sliding dtstart
 * to a couple of periods before `ref` makes each call O(1) while leaving the
 * answer identical: shifting by an exact multiple of the interval keeps a
 * WEEKLY/INTERVAL=2 rule on the same weeks and a MONTHLY/INTERVAL=3 rule on the
 * same months. Weekly shifts move by whole weeks, so the base's weekday is
 * preserved too (rrule.js reads it when BYDAY is absent), and monthly/yearly
 * shifts keep the base's day of month — a shift that would land on a day the
 * month lacks (a 31st, Feb 29) steps one more period back instead, so the
 * phase and the day rrule.js reads are never changed.
 *
 * `rewind` (an every-N grid anchored on the task's own occurrence, see
 * `gridDtstart`) also moves dtstart BACK when the base is after `ref`: the
 * grid runs both ways from the anchor. The fixed epoch never rewinds — it is
 * the start of its pattern.
 *
 * Works in the same naive-UTC representation as dtstart itself, so no DST
 * arithmetic is involved.
 */
export function advanceDtstart(
  base: Date,
  freq: string,
  interval: number,
  ref: Date,
  rewind = false,
): Date {
  const n = Math.max(1, Math.floor(interval))
  // Leave at least two full periods of runway before `ref`, so rrule's
  // "strictly after" search sees the same neighbourhood it would have from 2020.
  const MARGIN = 2
  const hour = base.getUTCHours()
  const minute = base.getUTCMinutes()
  const usable = (periods: number) => periods > 0 || (rewind && periods < 0)

  if (freq === 'DAILY' || freq === 'WEEKLY') {
    const periodMs = (freq === 'DAILY' ? 1 : 7) * n * 86_400_000
    const periods = Math.floor((ref.getTime() - base.getTime()) / periodMs) - MARGIN
    return usable(periods) ? new Date(base.getTime() + periods * periodMs) : base
  }
  if (freq === 'MONTHLY' || freq === 'YEARLY') {
    const monthsPerPeriod = (freq === 'MONTHLY' ? 1 : 12) * n
    const months =
      (ref.getUTCFullYear() - base.getUTCFullYear()) * 12 + (ref.getUTCMonth() - base.getUTCMonth())
    let periods = Math.floor(months / monthsPerPeriod) - MARGIN
    // A day the landing month lacks would roll over into the next month:
    // step back a period at a time until the day exists (a few steps at most).
    for (;;) {
      if (!usable(periods)) return base
      const shifted = new Date(
        Date.UTC(
          base.getUTCFullYear(),
          base.getUTCMonth() + periods * monthsPerPeriod,
          base.getUTCDate(),
          hour,
          minute,
        ),
      )
      if (shifted.getUTCDate() === base.getUTCDate()) return shifted
      periods -= 1
    }
  }
  return base
}

/**
 * Whether a rule's phase floats — whether it needs a grid of its own because
 * nothing in the rule says which days it lands on:
 *   - an "every N" rule (INTERVAL > 1: every 22 days, every 2 weeks, every 3
 *     months) — which day/week/month of the N is the first;
 *   - a BARE rule with no day (`FREQ=WEEKLY`, `FREQ=MONTHLY`, `FREQ=YEARLY`,
 *     no BYDAY / BYMONTHDAY) — rrule.js takes its weekday / day of month /
 *     date from dtstart.
 * Every other rule pins its own phase (`FREQ=DAILY`, `FREQ=WEEKLY;BYDAY=SU`,
 * `FREQ=MONTHLY;BYMONTHDAY=1`) and gives the same days from any dtstart, so it
 * keeps the epoch. (Bare WEEKLY/MONTHLY are refused on a task by validation —
 * they are a quota's period rule — so on a task the bare case is FREQ=YEARLY
 * or a row from before that rule; the engine handles them all the same.)
 */
export function phaseFloats(components: RRuleComponents): boolean {
  if ((components.interval ?? 1) > 1) return true
  if (components.freq === 'DAILY') return false
  return !pinsDays(components)
}

/** The rule names its days itself (BYDAY or BYMONTHDAY). */
function pinsDays(components: RRuleComponents): boolean {
  return (components.byday?.length ?? 0) > 0 || components.bymonthday !== undefined
}

/**
 * THE TASK'S OWN GRID (2026-10-12, Trent): a rule whose phase floats
 * (`phaseFloats`) runs on a grid anchored at the task's OWN occurrence
 * (`occurrence_at`, which starts at the task's first date), not at the 2020
 * epoch. Before, a first target set off the epoch's grid made the second
 * occurrence come early: every 22 days, first Nov 3 → again Nov 13 (the next
 * epoch-grid day), not Nov 25; and a bare FREQ=WEEKLY always landed on the
 * epoch's Wednesday.
 *
 * The anchor's local date becomes dtstart's date (at the rule's time of day,
 * as for the epoch), so the anchor is period 0: for DAILY the grid is
 * anchor + k·N days, for WEEKLY the anchor's week (weeks start Monday) + k·N
 * weeks — on the anchor's weekday when the rule has no BYDAY —, for
 * MONTHLY/YEARLY the anchor's month/year + k·N (on the anchor's day / date
 * when the rule names none). Each advance writes an occurrence on that grid
 * back to `occurrence_at`, so the grid holds from occurrence to occurrence.
 * `advanceDtstart` then slides it (both ways) next to the reference, keeping
 * every call O(1).
 *
 * A first occurrence (no date yet) is anchored at the creation day — see
 * `computeFirstOccurrence`. Rules that pin their phase, and anchorless calls,
 * get the fixed epoch, exactly as before.
 */
function gridDtstart(
  components: RRuleComponents,
  hour: number,
  minute: number,
  timezone: string,
  refNaive: Date,
  anchorAt: Date | null | undefined,
): Date {
  const freq = components.freq
  const interval = components.interval || 1
  const anchorDt =
    phaseFloats(components) && anchorAt && !Number.isNaN(anchorAt.getTime())
      ? DateTime.fromJSDate(anchorAt).setZone(timezone)
      : null
  if (!anchorDt?.isValid) {
    const epoch = new Date(Date.UTC(PATTERN_EPOCH_YEAR, 0, 1, hour, minute, 0, 0))
    return advanceDtstart(epoch, freq, interval, refNaive)
  }
  const base = new Date(Date.UTC(anchorDt.year, anchorDt.month - 1, anchorDt.day, hour, minute))
  return advanceDtstart(base, freq, interval, refNaive, true)
}

interface ComputeNextCommon {
  rrule: string
  anchorTime: string | null
  timezone: string
  completedAt: Date
  /**
   * The task's current due_at (prior to this completion). Used by 'from_due' mode
   * to guarantee the next occurrence is strictly after the previous due — otherwise
   * completing a recurring task before its due date (or twice in quick succession)
   * can return the same occurrence and leave the task stuck.
   */
  prevDueAt?: Date | null
  /**
   * An occurrence on the task's own grid — its `occurrence_at` (else its
   * `due_at`). Read only by a rule whose phase floats (`phaseFloats`: every N,
   * or a bare rule with no day) in 'from_due' mode, whose grid it anchors
   * (`gridDtstart`). Omitted: the fixed epoch.
   */
  anchorAt?: Date | null
}

/**
 * The options of `computeNextOccurrence`. A call that may run a
 * 'from_completion' rule — the literal mode, or a task's own mode
 * (`'from_due' | 'from_completion'`) — must carry `dayStart`, the user's day
 * boundary (`dayBoundaryForUser` / `useDayStart`; required, never defaulted —
 * TQ-G03): a from-completion repeat counts from the completion's OpenTask
 * date (`computeFromCompletion`). A call that only ever runs 'from_due' (the
 * literal mode) never reads it and may leave it out.
 */
export type ComputeNextOptions = ComputeNextCommon &
  (
    | { recurrenceMode: 'from_due'; dayStart?: string }
    | { recurrenceMode: 'from_due' | 'from_completion'; dayStart: string }
  )

/** A rule with no next occurrence (`computeNextOccurrence` throws it as a 400). */
export const NEVER_OCCURS_MESSAGE = 'This repeat never occurs again: check its days and months'

/**
 * Compute the next occurrence of a recurring task.
 *
 * For 'from_due' mode:
 * - Uses rrule.after(max(prevDueAt, completedAt)) to find the next occurrence
 * - The pattern time comes from DTSTART (set via anchor_time)
 *
 * For 'from_completion' mode:
 * - Computes interval from completion time
 * - Snaps to anchor_time
 */
export function computeNextOccurrence(options: ComputeNextOptions): Date {
  const { rrule, anchorTime, timezone, completedAt, prevDueAt, anchorAt } = options

  if (options.recurrenceMode === 'from_completion') {
    return computeFromCompletion(rrule, anchorTime, timezone, completedAt, options.dayStart)
  }

  return computeFromDue(rrule, anchorTime, timezone, completedAt, prevDueAt ?? null, anchorAt)
}

/**
 * Compute next occurrence for 'from_due' mode (default)
 *
 * This is the standard recurrence: "Every Monday at 9 AM" means the next Monday
 * at 9 AM, regardless of when the task was completed.
 *
 * Reference point for "next" is max(prevDueAt, completedAt): if the user completes
 * before the current due (or re-completes the new occurrence immediately), we
 * advance from the previous due — not from "now" — so each completion moves the
 * task forward by one cycle.
 */
function computeFromDue(
  rruleStr: string,
  anchorTime: string | null,
  timezone: string,
  completedAt: Date,
  prevDueAt: Date | null,
  anchorAt?: Date | null,
): Date {
  const components = parseRRule(rruleStr)
  const { hour, minute } = ruleTimeOfDay(rruleStr, anchorTime)

  // Reference point: the later of prevDueAt and completedAt. This ensures the next
  // occurrence is strictly after the previous due, so completing early (or completing
  // the same recurring task twice in a row) always advances by one cycle.
  const completedDt = DateTime.fromJSDate(completedAt).setZone(timezone)
  const prevDueDt = prevDueAt ? DateTime.fromJSDate(prevDueAt).setZone(timezone) : null
  const refDt = prevDueDt && prevDueDt > completedDt ? prevDueDt : completedDt
  const refNaive = toNaiveLocal(refDt)

  const rule = buildDueRule(components, hour, minute, timezone, refNaive, anchorAt)

  // Get the next occurrence (in "naive local")
  const nextNaive = rule.after(refNaive, false)

  if (!nextNaive) {
    // A rule with no next occurrence (2026-10-21, the recurrence oracle: "the
    // 31st of April" — `isValidRRule` now refuses one, but an older row may
    // hold it). Never invent a date (this used to return "tomorrow"): a write
    // that needs the next occurrence is refused (400), and a reader that only
    // asks (today's occurrence, the snooze guard) already treats a throw as
    // "no occurrence".
    throw new ValidationError(NEVER_OCCURS_MESSAGE)
  }

  // Convert back to timezone-aware DateTime
  let nextDt = fromNaiveLocal(nextNaive, timezone)

  // DST fix: rrule.js works in UTC, so when DST changes between dtstart and the
  // result date, the local hour shifts. Force the hour to match the anchor time.
  if (nextDt.hour !== hour) {
    nextDt = nextDt.set({ hour, minute, second: 0, millisecond: 0 })
  }

  return nextDt.toJSDate()
}

/**
 * The rule's time of day: the task's `anchor_time`, else the rule's BYHOUR /
 * BYMINUTE, else local midnight — the one fallback every computation uses,
 * so the time a skip lands on is the time the next Done keeps.
 */
export function ruleTimeOfDay(
  rruleStr: string,
  anchorTime: string | null,
): { hour: number; minute: number } {
  if (anchorTime) return parseAnchorTime(anchorTime)
  const components = parseRRule(rruleStr)
  if (components.byhour !== undefined) {
    return { hour: components.byhour, minute: components.byminute ?? 0 }
  }
  return { hour: 0, minute: 0 }
}

/**
 * The from_due rule as rrule.js runs it, in "naive local" time, with its
 * dtstart slid next to `refNaive` (see computeFromDue).
 */
function buildDueRule(
  components: RRuleComponents,
  hour: number,
  minute: number,
  timezone: string,
  refNaive: Date,
  anchorAt: Date | null | undefined,
): RRule {
  // Create DTSTART in "naive" format (UTC slot) with the anchor time. Using
  // Date.UTC keeps the pattern independent of the server's local timezone —
  // critical on DST-observing hosts where new Date(2020,0,1,h,m) would carry
  // the winter UTC offset and drift from summer target dates. Its date is the
  // 2020 epoch, or for an "every N" rule the task's own occurrence (the grid,
  // see gridDtstart); either is then slid toward the reference (see
  // advanceDtstart) so rrule.js does not iterate years of occurrences to answer
  // a question about this week.
  const dtstart = gridDtstart(components, hour, minute, timezone, refNaive, anchorAt)

  // Build RRule options - NO BYHOUR/BYMINUTE, time comes from dtstart
  const ruleOptions: Partial<InstanceType<typeof RRule>['options']> = {
    freq: FREQ_MAP[components.freq],
    interval: components.interval || 1,
    dtstart,
  }

  // The rule's weekdays, each with its ordinal when it has one: "1SA" is
  // RRule.SA.nth(1) (the 1st Saturday of the month), "-1FR" RRule.FR.nth(-1)
  // (the last Friday). Until 2026-10-20 the ordinal was dropped and a
  // "monthly on the 1st Saturday" rule ran every Saturday.
  if (components.byday && components.byday.length > 0) {
    // rrule.js types byweekday loosely; its Weekday values are what it reads.
    // An ordinal counts only in a MONTHLY/YEARLY rule (`ordinalsCount`); a
    // legacy WEEKLY "1FR" runs as plain FR, as it always did.
    const nth = ordinalsCount(components)
    ruleOptions.byweekday = components.byday.map((d) =>
      nth && d.n !== undefined ? DOW_TO_RRULE_WEEKDAY[d.day].nth(d.n) : DOW_TO_RRULE_WEEKDAY[d.day],
    ) as unknown as number[]
  }

  // Add day-of-month for monthly patterns
  if (components.bymonthday !== undefined) {
    const monthdays = Array.isArray(components.bymonthday)
      ? components.bymonthday
      : [components.bymonthday]
    ruleOptions.bymonthday = monthdays
  }

  // Add the month(s) for yearly patterns ("every year on March 1st"). Without
  // it rrule.js expands a YEARLY;BYMONTHDAY=1 rule to the 1st of every month.
  if (components.bymonth && components.bymonth.length > 0) {
    ruleOptions.bymonth = components.bymonth
  }

  // Add BYSETPOS for patterns like "last Friday"
  if (components.bysetpos !== undefined) {
    ruleOptions.bysetpos = [components.bysetpos]
  }

  return new RRule(ruleOptions)
}

/** A naive-local rrule result as the real instant, at the rule's hour across DST. */
function naiveToInstant(naive: Date, timezone: string, hour: number, minute: number): Date {
  let dt = fromNaiveLocal(naive, timezone)
  if (dt.hour !== hour) dt = dt.set({ hour, minute, second: 0, millisecond: 0 })
  return dt.toJSDate()
}

/**
 * SKIP UNTIL's walk for a from_due rule, in two rrule.js calls rather than a
 * step per occurrence: how many occurrences fall in [`from`, `before`), and
 * the first one on or after `before`. `from` is an occurrence on the rule
 * (the one a plain skip lands on); `anchorAt` anchors a floating rule's grid
 * as in computeNextOccurrence.
 */
export function occurrencesFromDue(options: {
  rrule: string
  anchorTime: string | null
  timezone: string
  from: Date
  before: Date
  anchorAt?: Date | null
}): { count: number; firstOnOrAfter: Date } {
  const { rrule, anchorTime, timezone, from, before, anchorAt } = options
  const components = parseRRule(rrule)
  const { hour, minute } = ruleTimeOfDay(rrule, anchorTime)
  const fromNaive = toNaiveLocal(DateTime.fromJSDate(from).setZone(timezone))
  const beforeNaive = toNaiveLocal(DateTime.fromJSDate(before).setZone(timezone))
  const rule = buildDueRule(components, hour, minute, timezone, fromNaive, anchorAt)
  const inRange = rule.between(fromNaive, beforeNaive, true)
  const count = inRange.filter((d) => d.getTime() < beforeNaive.getTime()).length
  const next = rule.after(beforeNaive, true)
  if (!next) throw new Error('occurrencesFromDue: the rule has no occurrence after the date')
  return { count, firstOnOrAfter: naiveToInstant(next, timezone, hour, minute) }
}

/**
 * Compute next occurrence for 'from_completion' mode
 *
 * The date advances from the completion's day by the interval, and the time
 * snaps to the rule's time (`ruleTimeOfDay`).
 *
 * Example: "7 days after last completion" - if completed Wednesday 2pm,
 * next = next Wednesday at anchor_time (e.g., 9am)
 *
 * COUNTED FROM THE OPENTASK DAY (Trent, 2026-10-26): the base is the
 * completion's OpenTask date (`openTaskLocalDay`), not its calendar date. With
 * a 3:00 AM day start, Done at 00:30 Monday is Sunday's — "every 2 days at
 * 09:00" lands Tuesday 09:00, exactly as Done at 23:30 Sunday does (it used
 * to land Wednesday). With a start after 12:00 the same map runs forward: with
 * 11 PM, Done at Sunday 23:30 is Monday's, so every 2 days lands Wednesday.
 * The interval is plain calendar maths on that date (Luxon's `plus`, so a
 * monthly from Jan 31 still lands Feb 28), and the rule's time is placed
 * WITHIN the landing OpenTask day (`periodOpensOnDate`): a 1:00 AM rule with a
 * 3:00 AM start is the END of that day, the calendar date after — the rule
 * skip until's from-completion landing uses (`walkFromCompletion` in
 * src/core/tasks/skip-until.ts), so Done, skip and skip until agree.
 *
 * DST: the time is set the way it always was — the completion's own
 * DateTime moved to the landing date, then set to the rule's time (Luxon's
 * `set`: a 02:30 that does not exist moves on by the gap). With midnight
 * (`CALENDAR_DAY_START`, the task queue off) the OpenTask date is the
 * calendar date and the landing date is the stepped date, so every answer is
 * the one it was before (pinned by TQ-LN).
 */
function computeFromCompletion(
  rruleStr: string,
  anchorTime: string | null,
  timezone: string,
  completedAt: Date,
  /** The user's day boundary: the completion's OpenTask date is the base. */
  dayStart: string,
): Date {
  const components = parseRRule(rruleStr)
  const completedDt = DateTime.fromJSDate(completedAt).setZone(timezone)

  // Get anchor time for snapping
  const { hour, minute } = ruleTimeOfDay(rruleStr, anchorTime)

  const interval = components.interval || 1
  const baseDay = openTaskLocalDay(completedAt, timezone, dayStart)
  let stepped: DateTime

  switch (components.freq) {
    case 'DAILY':
      stepped = baseDay.plus({ days: interval })
      break
    case 'WEEKLY':
      stepped = baseDay.plus({ weeks: interval })
      break
    case 'MONTHLY':
      stepped = baseDay.plus({ months: interval })
      break
    case 'YEARLY':
      stepped = baseDay.plus({ years: interval })
      break
    default:
      stepped = baseDay.plus({ days: 1 })
  }

  // The calendar date the rule's time falls on within the landing OpenTask day.
  const landingDate = periodOpensOnDate(stepped.toISODate()!, toHHMM(hour, minute), dayStart)
  const landing = DateTime.fromISO(landingDate, { zone: timezone })

  // Move the completion to that date, then snap to the rule's time (two
  // steps, as `plus` then `set` always did — the same DST resolution).
  return completedDt
    .set({ year: landing.year, month: landing.month, day: landing.day })
    .set({ hour, minute, second: 0, millisecond: 0 })
    .toJSDate()
}

/**
 * Check if a task is recurring
 */
export function isRecurring(rrule: string | null): boolean {
  return rrule !== null && rrule.length > 0
}

/**
 * Compute the first occurrence of a recurring task from now.
 * Used when a repeating task gets its rule with no date: created without one,
 * re-ruled (PATCH / bulk edit) without one, or ruled by AI enrichment.
 *
 * THE CREATION DAY IS DAY 0 (Trent, 2026-10-12): "If I create it on a Sunday
 * and it's every 7 days, and I complete it on that Thursday, then it should
 * pop up on the Sunday." For a rule whose phase floats (`phaseFloats`) the
 * grid is anchored at the day the rule is set, and that day is itself the
 * first occurrence if its time has not yet passed — every 22 days made Mon
 * Oct 12 at 10:00 for 9 PM → Oct 12 at 9 PM; made at 10 PM → Nov 3, the next
 * grid point. A bare FREQ=WEEKLY made on a Sunday repeats on Sundays. Every
 * later occurrence is on that grid (`occurrence_at` anchors it), whenever it
 * is done. Before, the first occurrence came from the 2020 epoch's grid (Oct
 * 12, every 22 days → Oct 22).
 *
 * A floating rule that names its days (every 2 weeks on Monday, every 3
 * months on the 1st) can't make an arbitrary creation day period 0 — the day
 * may not match. Its day 0 is the first matching day on or after today (the
 * rule at INTERVAL=1, from the start of today), so the first occurrence is
 * never later than the plain weekly/monthly rule's: every 2 weeks on Monday
 * made Sunday → tomorrow, then every 2 weeks from there; every 3 months on
 * the 1st made Oct 12 → Nov 1, then Feb 1. Made ON a matching day after its
 * time → the next grid point (two weeks on), as for a bare rule.
 *
 * A rule with no time of day (no BYHOUR and no `anchorTime`) is at local
 * midnight, which has always passed, so it starts one period on.
 *
 * DAY 0 IS THE OPENTASK DAY ("OpenTask day everywhere" part 2, Trent
 * 2026-10-26): "today" is the user's day (`dayStart`, `dayBoundaryForUser` /
 * `useDayStart`), so at 00:30 Monday with a 3:00 AM day start the creation
 * day is still Sunday — every 22 days made then is on Sunday's grid, exactly
 * as if made at 23:30 Sunday (the long first gap included, when Sunday's
 * time has passed). Day 0's occurrence is the one instant at the rule's time
 * INSIDE that day (`periodOpensAt`), which with a start after 12:00 can be on
 * the date before: with an 11 PM start, every 3 days at 23:45 made Sun 23:26
 * (Monday's day) is first Sun 23:45, 19 minutes on (PR #354 review). With
 * midnight (the switch off) it is the calendar day.
 *
 * Rules that pin their own phase (FREQ=DAILY, BYDAY=SU, BYMONTHDAY=1 at
 * INTERVAL=1) are exactly as before: the next matching time after now.
 *
 * `now` is injectable for tests; callers pass the clock.
 */
export function computeFirstOccurrence(
  rruleStr: string,
  anchorTime: string | null,
  timezone: string,
  now: Date,
  /** The user's day boundary: day 0 is the OpenTask day `now` is in. */
  dayStart: string,
): Date {
  const components = parseRRule(rruleStr)
  if (!phaseFloats(components)) {
    return computeFromDue(rruleStr, anchorTime, timezone, now, null)
  }
  const today = openTaskDayOf(now, timezone, dayStart)
  if (pinsDays(components)) {
    // The first matching day from the moment today's OpenTask day starts.
    const startOfToday = new Date(dayStartMoment(today, timezone, dayStart).getTime() - 1)
    const everyPeriod = rruleStr
      .split(';')
      .filter((part) => !/^INTERVAL=/i.test(part))
      .join(';')
    const day0 = computeFromDue(everyPeriod, anchorTime, timezone, startOfToday, null)
    return computeFromDue(rruleStr, anchorTime, timezone, now, null, day0)
  }
  // Day 0's occurrence: the one instant at the rule's time INSIDE today's
  // OpenTask day (`periodOpensAt`) — its date anchors the grid. With an 11 PM
  // start, at Sun 23:26 (Monday's day) a 23:45 rule's is Sun 23:45, still
  // ahead; with a 3:00 AM start, at Mon 00:30 (Sunday's day) a 1:00 AM rule's
  // is Mon 01:00. With midnight it is today's date, as it always was.
  const { hour, minute } = ruleTimeOfDay(rruleStr, anchorTime)
  const day0 = periodOpensAt(today, toHHMM(hour, minute), timezone, dayStart)
  // A rule with no time of day: day 0's midnight counts as passed (the
  // promise above), even where the day start leaves it ahead.
  const timeless = !anchorTime && components.byhour === undefined
  return computeFromDue(rruleStr, anchorTime, timezone, now, timeless ? day0 : null, day0)
}

/**
 * A NEW repeating task given a first date already PAST starts at its NEXT
 * occurrence instead (designer, 2026-10-16) — the same ruling as "the
 * creation day is day 0" (#258, `computeFirstOccurrence`): a repeat's first
 * occurrence is never one that has already gone by. Two real cases:
 * - earlier today: "submit my timesheet every Friday by 5pm" made Friday at
 *   8:30 PM came out due Friday 5 PM (#286);
 * - an earlier day: "pay mortgage on the 15th of every month" made Oct 16
 *   came out due Oct 15 — over target at birth either way.
 *
 * The next occurrence keeps the given date's time of day (as the anchor), on
 * the rule, counted from now: a weekly Friday → next Friday; a daily →
 * tomorrow; the 15th of every month made on the 16th → the 15th of next
 * month; an every-2-weeks rule → the next grid point. A date still ahead is
 * the first occurrence as given — so "a repeat with no day named starts
 * today", while today's time is still ahead, is untouched.
 *
 * FOR A NEW TASK ONLY. Callers: createTask (every client and mode) and AI
 * enrichment of a just-created task (`rollPassedRepeatStart`). Never a later
 * edit: PATCH and bulk edit don't call it, so moving an existing repeating
 * task's date into the past stays as the user set it. Not reminders (the
 * callers skip them: today's occurrence is still today's to consider).
 * `now` is injectable for tests.
 */
export function rollPassedFirstOccurrence(
  rruleStr: string,
  dueAt: Date,
  timezone: string,
  now: Date,
  /** The user's day boundary: counted from the OpenTask day (`computeFirstOccurrence`). */
  dayStart: string,
): Date {
  const due = DateTime.fromJSDate(dueAt).setZone(timezone)
  const nowLocal = DateTime.fromJSDate(now).setZone(timezone)
  if (!due.isValid || due >= nowLocal) return dueAt
  return computeFirstOccurrence(rruleStr, due.toFormat('HH:mm'), timezone, now, dayStart)
}
