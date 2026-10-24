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
 * one of the user's week-start boundaries — anchored under the old
 * Monday-only rule, or the user flipped the preference, or moved timezone so
 * the stored instant is no longer local midnight — ends instead at the NEXT
 * week-start boundary after it. That period is short (Mon → Sun is 6 days);
 * it closes like any other (met → completion, short → recorded only), and the
 * period after it starts on the boundary, so from then on the quota is aligned.
 *
 * INTERVAL > 1: the short period still ends at the next boundary (one week at
 * most), and the next period then runs the full `interval` weeks from it.
 * There is no "phase" to preserve — a 2-week quota's fortnight is simply
 * counted from wherever its aligned anchor lands.
 */
import { DateTime } from 'luxon'
import { CALENDAR_DAY_START, addDays, dayStartMoment, openTaskDayOf } from '@/lib/opentask-day'

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
 * EVERYTHING USES THE OPENTASK DATE: the period an instant is in is plain
 * calendar maths on its OpenTask date (`openTaskDayOf`) — the week of that
 * date (on the user's week-start day), its month, its year — and the
 * period's start and end instants are `dayStartMoment` of the period's first
 * date and of the next period's first date. With the 3:00 AM default, a
 * Sunday week runs Sunday 03:00 → Sunday 03:00, a month the 1st 03:00 → the
 * next 1st 03:00; Saturday 01:30 is still the old week. With an 11 PM start
 * the week named Sunday starts Saturday 23:00.
 *
 * A MISALIGNED anchor — one that is not its period's start, such as every
 * midnight anchor when the day start moves to 3:00 — ends at the start of the
 * NEXT period after it (the week rule above, for every unit): one short
 * period, and aligned from then on. The rollover carries any taps logged
 * after that end into the next period (`loggedSince` in
 * src/core/tasks/period-rollover.ts), so the short period holds only what was
 * logged inside it. At midnight (`CALENDAR_DAY_START` — the task queue's
 * switch off) every function below is exactly what it was before.
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
  if (dayStart === CALENDAR_DAY_START) {
    if (unit === 'days') return dt.startOf('day')
    if (unit === 'weeks') return startOfWeek(dt, weekStart)
    return dt.startOf(unit === 'months' ? 'month' : 'year')
  }
  const zone = dt.zoneName ?? 'utc'
  const date = openTaskDayOf(dt.toJSDate(), zone, dayStart)
  return startOf(periodFirstDate(date, unit, weekStart), zone, dayStart)
}

/**
 * Whether `anchor` is the start of its period — on the user's boundary for
 * the unit (`unitStartAt`). With a day start (the task queue on), every unit
 * realigns: an anchor that is not on a period start ends at the next one, a
 * short TRANSITION period (`quotaPeriodEnd`; the rollover marks its record,
 * `progress_periods.transition`, so an unmet one breaks no streak). At
 * midnight (the switch off) nothing is a transition: the old week rule's
 * short period is recorded as it always was.
 */
export function anchorOnPeriodStart(
  anchor: DateTime,
  unit: PeriodUnit,
  weekStart: WeekStart,
  dayStart: string,
): boolean {
  if (dayStart === CALENDAR_DAY_START) return true
  return unitStartAt(anchor, unit, weekStart, dayStart).toMillis() === anchor.toMillis()
}

/**
 * The instant a quota period that began at `anchor` ends (exclusive).
 *
 * With a day start (`dayStart`: the owner's "Day starts at" with the task
 * queue's switch on — the module's "Quota periods on the OpenTask day"): an
 * anchor on its period's start runs `interval` units, to the day start of
 * the date `interval` units on; one that is not ends at the start of the
 * next period, a short period, and is aligned from then on.
 *
 * At midnight (`CALENDAR_DAY_START`, the switch off), as it always was:
 * days, months and years are plain calendar addition; a week whose anchor
 * sits on the user's boundary runs `interval` weeks, one that does not ends
 * at the next boundary (see the module doc).
 */
export function quotaPeriodEnd(
  anchor: DateTime,
  unit: PeriodUnit,
  interval: number,
  weekStart: WeekStart,
  dayStart: string,
): DateTime {
  if (dayStart !== CALENDAR_DAY_START) {
    // By OpenTask DATE, never the boundary's calendar date: with a start
    // after 12:00 the day starts on the date before the one it is named by.
    const zone = anchor.zoneName ?? 'utc'
    const first = periodFirstDate(openTaskDayOf(anchor.toJSDate(), zone, dayStart), unit, weekStart)
    const aligned = anchorOnPeriodStart(anchor, unit, weekStart, dayStart)
    return startOf(addUnits(first, unit, aligned ? interval : 1), zone, dayStart)
  }
  if (unit !== 'weeks') return anchor.plus({ [unit]: interval })
  const boundary = startOfWeek(anchor, weekStart)
  if (boundary.toMillis() === anchor.toMillis()) return anchor.plus({ weeks: interval })
  return boundary.plus({ weeks: 1 })
}
