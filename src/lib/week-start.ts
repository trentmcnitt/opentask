/**
 * The first day of the user's week — the one place a week boundary is computed.
 *
 * A per-user preference (`users.week_start`, Settings → "Week starts on"):
 * `'sunday'` (the default — US convention; Trent, 2026-09-27: "Saturday at
 * midnight is the changeover") or `'monday'` (ISO 8601). Before this existed
 * every week in the app was Luxon's ISO week, which starts Monday and has no
 * option to change it — so NOTHING may call `startOf('week')` / `endOf('week')`
 * for a user-facing week any more. Use `startOfWeek` below.
 *
 * Pure (no DB, no Node imports): shared by the server (period rollover, quota
 * prompts, quick take) and the client (Track panel "N days left").
 *
 * ── Quota periods and a misaligned anchor ──────────────────────────────────
 *
 * A weekly quota's current period begins at `tasks.progress_period_start` (the
 * anchor) and normally ends `interval` weeks later. An anchor that is NOT on
 * one of the user's week-start days — anchored under the old Monday-only
 * rule, or the user flipped the preference — ends instead at the NEXT
 * week-start boundary after it. That period is short (Mon → Sun is 6 days):
 * a TRANSITION period (`anchorOnPeriodStart`), met → a completion, unmet →
 * recorded and marked, breaking no streak; the period after it starts on the
 * boundary, so from then on the quota is aligned. (A day-start change is
 * never a misalignment: the anchor's DATE is unchanged — `anchorDate`,
 * below. A timezone move usually isn't either; one large enough to carry the
 * anchor's local time across noon or midnight shifts its read date by one,
 * which gives one transition period, then aligns — no worse than before.)
 *
 * INTERVAL > 1: the short period still ends at the next boundary (one week at
 * most), and the next period then runs the full `interval` weeks from it.
 * There is no "phase" to preserve — a 2-week quota's fortnight is simply
 * counted from wherever its aligned anchor lands.
 */
import { DateTime } from 'luxon'
import { addDays, dayStartMoment, openTaskDayOf } from '@/lib/opentask-day'

export type WeekStart = 'sunday' | 'monday'

export const WEEK_START_DEFAULT: WeekStart = 'sunday'

export const WEEK_STARTS: readonly WeekStart[] = ['sunday', 'monday']

/** A stored/sent value as a WeekStart — anything unknown reads as the default. */
export function coerceWeekStart(value: unknown): WeekStart {
  return value === 'monday' || value === 'sunday' ? value : WEEK_START_DEFAULT
}

/** Luxon weekday (1 = Monday … 7 = Sunday) the week begins on. */
function startWeekday(weekStart: WeekStart): number {
  return weekStart === 'monday' ? 1 : 7
}

/**
 * Local midnight of the first day of the week containing `dt`, in `dt`'s zone.
 * Calendar arithmetic (`minus({ days })`), so a DST change inside the week
 * still lands on 00:00 local.
 */
export function startOfWeek(dt: DateTime, weekStart: WeekStart): DateTime {
  const back = (dt.weekday - startWeekday(weekStart) + 7) % 7
  return dt.startOf('day').minus({ days: back })
}

export type PeriodUnit = 'days' | 'weeks' | 'months' | 'years'

/*
 * ── Quota periods on the OpenTask day ("Day starts at" PR 2, Trent 2026-10-24)
 *
 * EVERYTHING USES THE OPENTASK DATE. A period's IDENTITY is a DATE — its
 * first OpenTask date (a Sunday for a Sunday week, the 1st for a month) —
 * and every step from one period to the next is calendar maths on dates
 * (`periodFirstDate`, `addUnits`). Its BOUNDS are instants: `dayStartMoment`
 * of its first date and of the next period's first date. With the 3:00 AM
 * default, a Sunday week runs Sunday 03:00 → Sunday 03:00, a month the 1st
 * 03:00 → the next 1st 03:00; Saturday 01:30 is still the old week. With an
 * 11 PM start the week named Sunday starts Saturday 23:00. Midnight
 * (`CALENDAR_DAY_START`, the task queue's switch off) is just another day
 * start, through the same path: local midnights, as they always were.
 *
 * A STORED ANCHOR'S DATE (`anchorDate`): the anchor was stamped at the day
 * start in force then (or at midnight, before PR 2), so its date is the one
 * the naming convention gives its own wall-clock time — at or before 12:00
 * its local date, after 12:00 the next date (an anchor stamped at 23:00 by an
 * 11 PM start begins the next date's period). That is why CHANGING THE DAY
 * START, in either direction, only moves the bounds and never the phase: a
 * fortnight anchored on Sunday Oct 11 stays on Oct 11, Oct 25, … whether the
 * day starts at 00:00, 03:00, 06:30 or 23:00, and a quarter that began Oct 1
 * ends on Jan 1's day start. The period in progress ends at the NEW day start
 * of its next first date — a few hours longer or shorter, once.
 *
 * A MISALIGNED anchor — one whose date is not the first date of its unit (a
 * week anchored under the old Monday-only rule, a week-start change, or a
 * timezone move large enough to shift the anchor's read date by one) — ends
 * at the start of the NEXT unit: a TRANSITION period,
 * shorter than its unit by whole days, aligned from then on. The rollover
 * marks its record (`progress_periods.transition`) so an unmet one breaks no
 * streak, and carries any taps logged after its end into the next period
 * (`loggedSince` in src/core/tasks/period-rollover.ts). A period whose date
 * is its unit's first date is full-length by identity — never a transition,
 * however far a day-start change moved its bounds.
 */

/** The first OpenTask date (yyyy-MM-dd) of the `unit` containing the date `date`. */
export function periodFirstDate(date: string, unit: PeriodUnit, weekStart: WeekStart): string {
  const d = DateTime.fromISO(date, { zone: 'utc' })
  switch (unit) {
    case 'days':
      return date
    case 'weeks':
      return addDays(date, -((d.weekday - startWeekday(weekStart) + 7) % 7))
    case 'months':
      return d.set({ day: 1 }).toFormat('yyyy-MM-dd')
    case 'years':
      return d.set({ month: 1, day: 1 }).toFormat('yyyy-MM-dd')
  }
}

/** A date `n` units on: calendar arithmetic on the date, no zone. */
function addUnits(date: string, unit: PeriodUnit, n: number): string {
  return DateTime.fromISO(date, { zone: 'utc' })
    .plus({ [unit]: n })
    .toFormat('yyyy-MM-dd')
}

/** `dayStartMoment` of an OpenTask date, as a DateTime in `zone`. */
function startOf(date: string, zone: string, dayStart: string): DateTime {
  return DateTime.fromJSDate(dayStartMoment(date, zone, dayStart)).setZone(zone)
}

/** 12:00 in milliseconds of the day: the naming convention's line (`namesNextDate`). */
const NOON_MS = 12 * 60 * 60 * 1000

/**
 * The OpenTask DATE a stored period anchor stands for, whatever day start
 * stamped it: its local date when its wall-clock time is at or before 12:00,
 * else the next date — the naming convention (`namesNextDate`) applied to the
 * anchor's own time, which is the day start that stamped it. An anchor at
 * 00:00, 03:00 or 06:30 on Sunday and one at 23:00 on Saturday all stand for
 * Sunday. Independent of the current day start, so changing it never shifts a
 * period's phase.
 */
export function anchorDate(anchor: DateTime): string {
  const msOfDay =
    ((anchor.hour * 60 + anchor.minute) * 60 + anchor.second) * 1000 + anchor.millisecond
  const date = anchor.toISODate()!
  return msOfDay > NOON_MS ? addDays(date, 1) : date
}

/**
 * The start of the `unit` (day, week, month, year) containing `dt`, in
 * `dt`'s zone: `dayStartMoment` of the first OpenTask date of the unit its
 * OpenTask date is in. With `CALENDAR_DAY_START`: local midnight of the
 * unit's first day, as it always was.
 */
export function unitStartAt(
  dt: DateTime,
  unit: PeriodUnit,
  weekStart: WeekStart,
  dayStart: string,
): DateTime {
  const zone = dt.zoneName ?? 'utc'
  const date = openTaskDayOf(dt.toJSDate(), zone, dayStart)
  return startOf(periodFirstDate(date, unit, weekStart), zone, dayStart)
}

/**
 * Whether a period anchored at `anchor` is FULL-LENGTH: its date
 * (`anchorDate`) is the first date of its unit. False is a TRANSITION
 * period — a misaligned anchor, ending early at the next unit's start
 * (`quotaPeriodEnd`); the rollover marks its record
 * (`progress_periods.transition`), so an unmet one breaks no streak. A
 * day-start change never makes one: it moves the bounds, not the date.
 */
export function anchorOnPeriodStart(
  anchor: DateTime,
  unit: PeriodUnit,
  weekStart: WeekStart,
): boolean {
  const date = anchorDate(anchor)
  return periodFirstDate(date, unit, weekStart) === date
}

/**
 * The instant a quota period that began at `anchor` ends (exclusive): the
 * day start (`dayStart`: the owner's "Day starts at" with the task queue's
 * switch on, midnight off — one path for both) of the first date of the
 * period after it. A full-length period (`anchorOnPeriodStart`) runs
 * `interval` units from its date; a misaligned one ends at the next unit's
 * first date, and is aligned from then on. Dates, so a DST change or a
 * day-start change inside the period never shifts the phase.
 */
export function quotaPeriodEnd(
  anchor: DateTime,
  unit: PeriodUnit,
  interval: number,
  weekStart: WeekStart,
  dayStart: string,
): DateTime {
  const zone = anchor.zoneName ?? 'utc'
  const date = anchorDate(anchor)
  const first = periodFirstDate(date, unit, weekStart)
  const units = first === date ? interval : 1
  return startOf(addUnits(first, unit, units), zone, dayStart)
}
