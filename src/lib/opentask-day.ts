/**
 * THE OPENTASK DAY (task queue, 2026-10-19; docs/TASK-MODEL.md § The OpenTask
 * day, picks and defers). THE ONE PLACE a day boundary is computed: every
 * "which day is it", "when does today start / end", "when does the day turn
 * next" in src/ goes through these helpers (guarded by TQ-G01,
 * tests/behavioral/tq-day-guard.test.ts).
 *
 * The day runs from DAY START to day start ("the rollover"), not midnight to
 * midnight. The day start is the user's "Day starts at" (2026-10-23,
 * `resolveDayStart` in src/lib/anchor-times.ts): unset — the default — a
 * fixed 3:00 AM for everyone (`DEFAULT_DAY_START`, Trent 2026-10-24); or a
 * custom time at any hour, or a linked period's start.
 *
 * BOTH DIRECTIONS (Trent, 2026-10-24). An instant's OpenTask date is the
 * local date it falls on once shifted back by the day start — and for a
 * start after noon the shift is FORWARD: with an 11 PM start, Sunday 23:30 is
 * already MONDAY. THE NAMING CONVENTION:
 *
 * - a day start AT OR BEFORE 12:00 names the day by the date it BEGINS on.
 *   With 3:00 AM, Monday runs Mon 03:00 → Tue 03:00; Tuesday 01:00 is still
 *   Monday (a night owl's 2 AM target is part of the evening's day).
 * - a day start AFTER 12:00 names the day by the NEXT date — the one it
 *   mostly covers. With 11:00 PM, Monday runs Sun 23:00 → Mon 23:00.
 * - midnight (`CALENDAR_DAY_START`) is the calendar day itself.
 *
 * As a rule, for every day start: `openTaskDayOf(x) = D` ⇔
 * `dayStartMoment(D) ≤ x < dayStartMoment(D + 1)`, where `dayStartMoment(D)`
 * is the start time on local date D (≤ 12:00) or on D − 1 (> 12:00), through
 * `localMoment`'s DST rule. Everything below is built on those two functions
 * — never on a moment's calendar date, which for a start after noon is the
 * day BEFORE the one it starts.
 *
 * ONE DAY BOUNDARY (Trent, 2026-10-23): with the task queue's switch on,
 * everything keyed to "today" runs on this day — the defer rule in
 * `bulkSnooze`, the rollover job, attempts, decks' rollover, the deadlines
 * page, the queue panels' day roster, and (from 2026-10-23) the Reminders
 * screen: its roster and "considered today", quota prompts and their day
 * keys, a daily quota's count, and the slot nag (`dayBoundaryForUser` in
 * src/core/tasks/rollover-time.ts is their read; with the switch off it is
 * midnight, `CALENDAR_DAY_START`).
 *
 * EVERYTHING USES THE OPENTASK DATE ("Day starts at" PR 2, Trent
 * 2026-10-24): one pure function maps an instant to its OpenTask date
 * (`openTaskDayOf`, and `openTaskLocalDay` for calendar maths on it), and
 * every surface downstream is plain calendar maths on that date — the Now
 * view's "today", the Today pill and header counts, the date labels and
 * filter chips (`openTaskDayBoundaries`), Upcoming, the horizon segments and
 * check_in_day, the day roster, the overdue fallback, decks (`on_deck_day`
 * is an OpenTask date), the weekly / monthly / yearly quota periods and the
 * Quotas page, daily stats and History. Target and deadline timestamps never
 * move; only which day's list they are on. The server reads the user's day
 * start through `dayBoundaryForUser`, the browser through `useDayStart`
 * (src/components/PreferencesProvider.tsx) — the same rule.
 *
 * Pure: no database, no clock of its own. Every function takes the instant it
 * is asked about.
 */

import { DateTime } from 'luxon'
import { parseHHMM } from '@/lib/time-slot-assign'

/**
 * Wall-clock minutes from the day start to a minute of the day (0..1439):
 * where a time of day falls within an OpenTask day. Defined beside the slot
 * pager (src/lib/time-slot-assign.ts, which this file imports from) and
 * re-exported here so the day's helpers are read from one place. Circular
 * minutes, so it reads the same for a start in either direction.
 */
export { minutesIntoDay } from '@/lib/time-slot-assign'

/**
 * Midnight as a day start: the calendar day, as an OpenTask day. What the
 * day-keyed surfaces run on with the task queue's switch off
 * (`dayBoundaryForUser`), so one code path serves both.
 */
export const CALENDAR_DAY_START = '00:00'

/** The latest day start (in minutes) that names its day by the date it begins on. */
const NOON_MINUTES = 12 * 60

/**
 * Whether a day start names its day by the NEXT date (a start after 12:00 —
 * the naming convention in the header). An unparseable time reads as
 * midnight's (false).
 */
export function namesNextDate(dayStart: string): boolean {
  const minutes = parseHHMM(dayStart)
  return minutes !== null && minutes > NOON_MINUTES
}

/** A local date (yyyy-MM-dd) `days` days on (or back): calendar arithmetic, no zone. */
export function addDays(date: string, days: number): string {
  // Plain UTC date arithmetic, no Luxon: it runs for every task on every
  // read, so it stays cheap ("Day starts at" PR 2 perf).
  const parts = parseLocalDate(date)
  if (!parts) throw new Error(`Not a local date: ${date}`)
  return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + days)).toISOString().slice(0, 10)
}

const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/** A yyyy-MM-dd date's [year, month, day], or null when it is not a real date. */
function parseLocalDate(date: string): [number, number, number] | null {
  const m = LOCAL_DATE.exec(date)
  if (!m) return null
  const [y, mo, d] = [+m[1], +m[2], +m[3]]
  const t = new Date(Date.UTC(y, mo - 1, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d
    ? [y, mo, d]
    : null
}

/**
 * MEMOS for the pure, hot helpers below ("Day starts at" PR 2 perf: every
 * task's day is read on every list, segment and tick). Their inputs are the
 * whole key — a date, a zone, a time — and their answers never change, so a
 * memo can never be stale (a user's NEW day start is a new key). Bounded:
 * cleared when full.
 */
const MEMO_MAX = 20_000
function memo<V>(map: Map<string, V>, key: string, make: () => V): V {
  const hit = map.get(key)
  if (hit !== undefined) return hit
  if (map.size >= MEMO_MAX) map.clear()
  const value = make()
  map.set(key, value)
  return value
}
const momentMemo = new Map<string, number>()
const localDayMemo = new Map<string, DateTime>()

/**
 * The local CALENDAR date (yyyy-MM-dd) of an instant in `timezone` — the
 * midnight-to-midnight date, whatever the day start. For the rules that are
 * about the calendar on purpose (an early-morning pick's own date, the
 * stretch after midnight); "which day is it" is `openTaskDayOf`.
 */
export function calendarDateOf(instant: Date, timezone: string): string {
  return DateTime.fromJSDate(instant).setZone(timezone).toISODate()!
}

/**
 * A LOCAL WALL-CLOCK MOMENT: `time` ("HH:MM") on the local date `localDate`
 * (yyyy-MM-dd) in `timezone`, as an instant. One rule for every derived
 * local moment — the day start (`dayStartMoment`) and a deadline-anchored
 * repeat's target (`occurrenceDates` in src/lib/task-segments.ts).
 *
 * DST. A spring-forward gap can swallow the time (02:30 on the night clocks
 * jump 2:00 → 3:00). Luxon would shift such a time forward by the gap's length
 * (2:30 → 3:30); the rule here is the NEXT VALID MINUTE — the first local
 * minute after the requested one that exists that day (3:00). On a fall-back
 * night the repeated hour resolves to its first occurrence (Luxon's choice),
 * which is the earlier instant.
 */
export function localMoment(localDate: string, time: string, timezone: string): Date {
  const minutes = parseHHMM(time)
  if (minutes === null) throw new Error(`Not an HH:MM time: ${time}`)
  const day = DateTime.fromISO(localDate, { zone: timezone })
  if (!day.isValid) throw new Error(`Not a local date: ${localDate}`)
  for (let m = minutes; m < 24 * 60; m++) {
    const at: DateTime = day.set({
      hour: Math.floor(m / 60),
      minute: m % 60,
      second: 0,
      millisecond: 0,
    })
    if (at.hour * 60 + at.minute === m && at.hasSame(day, 'day')) return at.toJSDate()
  }
  // Unreachable in practice: no zone skips the rest of a day.
  return day.endOf('day').toJSDate()
}

/**
 * The instant the OpenTask day `openTaskDate` (yyyy-MM-dd) STARTS: the day
 * start on that local date for a start at or before 12:00, on the date
 * before for one after 12:00 (an 11 PM start: Monday starts Sunday 23:00).
 * `localMoment`'s DST rule.
 */
export function dayStartMoment(openTaskDate: string, timezone: string, dayStart: string): Date {
  const ms = memo(momentMemo, `${openTaskDate}|${timezone}|${dayStart}`, () => {
    const onDate = namesNextDate(dayStart) ? addDays(openTaskDate, -1) : openTaskDate
    return localMoment(onDate, dayStart, timezone).getTime()
  })
  return new Date(ms)
}

/**
 * The day start that falls ON a local calendar date — the instant the
 * rollover cron fires that date (it starts the OpenTask day of that date,
 * or, after 12:00, of the next one). For a walk over calendar dates (the
 * day simulator).
 */
export function dayStartOnDate(calendarDate: string, timezone: string, dayStart: string): Date {
  return localMoment(calendarDate, dayStart, timezone)
}

/**
 * The OpenTask day (yyyy-MM-dd) an instant belongs to (the header's rule).
 * With 06:30: 00:00–06:29 belongs to the previous date, 06:30 exactly starts
 * the new one. With 23:00: 23:00 exactly is already the next date.
 */
export function openTaskDayOf(instant: Date, timezone: string, dayStart: string): string {
  const calendar = calendarDateOf(instant, timezone)
  const candidate = namesNextDate(dayStart) ? addDays(calendar, 1) : calendar
  if (instant.getTime() >= dayStartMoment(candidate, timezone, dayStart).getTime()) return candidate
  return addDays(candidate, -1)
}

/** One OpenTask day: its date, and the instants it runs between, `[start, end)`. */
export interface OpenTaskDaySpan {
  /** yyyy-MM-dd — the date the day is named by (`openTaskDayOf`). */
  date: string
  start: Date
  end: Date
}

/** The OpenTask day `date` as a span: from its day start to the next day's. */
export function openTaskDateSpan(
  date: string,
  timezone: string,
  dayStart: string,
): OpenTaskDaySpan {
  return {
    date,
    start: dayStartMoment(date, timezone, dayStart),
    end: dayStartMoment(addDays(date, 1), timezone, dayStart),
  }
}

/**
 * The OpenTask day `now` belongs to, as a span. With `CALENDAR_DAY_START` it
 * is the local calendar day.
 */
export function openTaskDaySpan(now: Date, timezone: string, dayStart: string): OpenTaskDaySpan {
  return openTaskDateSpan(openTaskDayOf(now, timezone, dayStart), timezone, dayStart)
}

/**
 * When a reminder period (`start`, HH:MM) opens within the OpenTask day
 * `date`: the one instant in `[dayStartMoment(date), dayStartMoment(date+1))`
 * at that wall-clock time. It is on the date the day starts on when the
 * period starts at or after the day start, else on the date after: a 1:00 AM
 * period, with the day starting at 3:00, is the END of the day, not its
 * beginning; with the day starting at 23:00 (Monday = Sun 23:00 → Mon 23:00),
 * a 07:00 period is Monday 07:00 and a 23:30 one Sunday 23:30.
 */
export function periodOpensAt(
  date: string,
  start: string,
  timezone: string,
  dayStart: string,
): Date {
  return localMoment(periodOpensOnDate(date, start, dayStart), start, timezone)
}

/**
 * The local calendar date (yyyy-MM-dd) `start` (HH:MM) falls on within the
 * OpenTask day `date` — `periodOpensAt`'s date, for a caller that sets the
 * time itself (skip until's from-completion landing keeps Luxon's DST
 * convention, as `computeNextOccurrence` does). With midnight it is `date`.
 */
export function periodOpensOnDate(date: string, start: string, dayStart: string): string {
  const startMin = parseHHMM(start)
  const dayStartMin = parseHHMM(dayStart)
  const begins = namesNextDate(dayStart) ? addDays(date, -1) : date
  return startMin === null || dayStartMin === null || startMin >= dayStartMin
    ? begins
    : addDays(begins, 1)
}

/**
 * The first day start STRICTLY after `now`: the end of `now`'s OpenTask day.
 * At exactly 6:30:00 (a 06:30 start) it is tomorrow's.
 */
export function nextRollover(now: Date, timezone: string, dayStart: string): Date {
  return openTaskDaySpan(now, timezone, dayStart).end
}

/**
 * The latest day start AT OR BEFORE `now` (the mirror of `nextRollover`): the
 * start of `now`'s OpenTask day — at exactly 6:30:00 today's, at 6:29
 * yesterday's. The rollover job runs as of this moment (task-queue PR 2).
 */
export function latestRollover(now: Date, timezone: string, dayStart: string): Date {
  return openTaskDaySpan(now, timezone, dayStart).start
}

/**
 * THE LATE NIGHT: an instant after local midnight that still belongs to the
 * OpenTask day before (its OpenTask date is earlier than its calendar date)
 * — 00:00–02:59 with a 3:00 AM start. Only a day start after midnight and at
 * or before 12:00 has one; with a start after 12:00 the stretch before
 * midnight belongs to the NEXT day instead, and there is no late night.
 * The A4 rule ("tomorrow" said then means the coming day, the calendar
 * today — `saidTomorrowBeforeRollover` in src/core/ai/enrichment.ts) and the
 * early-morning pick (`isEarlyMorningPick`) are both about this stretch.
 */
export function isLateNight(instant: Date, timezone: string, dayStart: string): boolean {
  return openTaskDayOf(instant, timezone, dayStart) < calendarDateOf(instant, timezone)
}

/**
 * AN EARLY-MORNING PICK (designer ruling, 2026-10-19): a target in the LATE
 * NIGHT (`isLateNight`) of its calendar day X — between midnight and the day
 * start — SET on an earlier calendar day than X: at 22:00, "tomorrow 6:00"
 * with a 6:30 start. It is a pick for the coming day, not the evening's
 * leftover, so it belongs to day X: the rollover of day X spares it
 * (src/core/tasks/task-rollover.ts) and its attempts count day X, not the
 * OpenTask day before (`targetOpenTaskDay`). A pick made after midnight (the
 * night owl's 1 AM pick of 2 AM) is not one: it stays with the evening's day.
 * With a start after 12:00 there is no late night, so no target is one.
 * ONE rule for both, so they can't drift apart.
 */
export function isEarlyMorningPick(
  dueAt: string,
  setAt: string,
  timezone: string,
  dayStart: string,
): boolean {
  const due = new Date(dueAt)
  if (!isLateNight(due, timezone, dayStart)) return false
  return calendarDateOf(new Date(setAt), timezone) < calendarDateOf(due, timezone)
}

/**
 * The OpenTask day (yyyy-MM-dd) a target belongs to for attempts: its
 * calendar day when it is an early-morning pick (`isEarlyMorningPick`), else
 * `openTaskDayOf` like any instant.
 */
export function targetOpenTaskDay(
  dueAt: string,
  setAt: string,
  timezone: string,
  dayStart: string,
): string {
  if (isEarlyMorningPick(dueAt, setAt, timezone, dayStart)) {
    return calendarDateOf(new Date(dueAt), timezone)
  }
  return openTaskDayOf(new Date(dueAt), timezone, dayStart)
}

/**
 * The OpenTask date of `instant` as a Luxon DateTime at that date's local
 * midnight in `timezone` — the shape the date rules do their calendar maths
 * on (weekdays, months, quarters, day gaps: `src/lib/task-segments.ts`).
 * "Day starts at" PR 2 (Trent, 2026-10-24: everything uses the OpenTask
 * date): one pure function maps an instant to its date, and everything
 * downstream is plain calendar maths on that date. With `CALENDAR_DAY_START`
 * it is the instant's own local midnight.
 */
export function openTaskLocalDay(instant: Date, timezone: string, dayStart: string): DateTime {
  const date = openTaskDayOf(instant, timezone, dayStart)
  return memo(localDayMemo, `${date}|${timezone}`, () => DateTime.fromISO(date, { zone: timezone }))
}

/** The instants the days around `now` start at: yesterday, today, tomorrow, the day after, a week on. */
export interface DayBoundaries {
  yesterdayStart: Date
  todayStart: Date
  tomorrowStart: Date
  dayAfterTomorrowStart: Date
  nextWeekStart: Date
}

/**
 * The OpenTask days around `now`, as the instants they start at
 * (`dayStartMoment` of today's OpenTask date −1, 0, +1, +2, +7) — every
 * "Today" / "Tomorrow" / "Yesterday" label, the Today pill and the due-date
 * filter chips read these. With `CALENDAR_DAY_START`, local midnights.
 */
export function openTaskDayBoundaries(
  timezone: string,
  dayStart: string,
  now: Date,
): DayBoundaries {
  const today = openTaskDayOf(now, timezone, dayStart)
  const at = (days: number) => dayStartMoment(addDays(today, days), timezone, dayStart)
  return {
    yesterdayStart: at(-1),
    todayStart: at(0),
    tomorrowStart: at(1),
    dayAfterTomorrowStart: at(2),
    nextWeekStart: at(7),
  }
}

/**
 * Whole OpenTask days from `a` to `b` (negative when `b` is earlier): the gap
 * between their OpenTask dates, calendar arithmetic on the dates.
 */
export function openTaskDaysBetween(a: Date, b: Date, timezone: string, dayStart: string): number {
  const from = openTaskLocalDay(a, timezone, dayStart)
  const to = openTaskLocalDay(b, timezone, dayStart)
  return Math.round(to.diff(from, 'days').days)
}
