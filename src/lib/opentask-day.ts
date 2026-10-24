/**
 * THE OPENTASK DAY (task queue, 2026-10-19; docs/TASK-MODEL.md § The OpenTask
 * day, picks and defers).
 *
 * The day runs from ROLLOVER to rollover, not midnight to midnight. The
 * rollover is the user's "Day starts at" (2026-10-23, `resolveDayStart` in
 * src/lib/anchor-times.ts): unset — the default — the start of their first
 * reminder period, or their `morning_time` when they have no periods; or a
 * custom time (Trent's 3:00 AM) or a linked period's start. The stretch from
 * midnight to the rollover belongs to the day before: a night owl's 2 AM
 * target is part of the evening's day.
 *
 * ONE DAY BOUNDARY (Trent, 2026-10-23): with the task queue's switch on,
 * everything keyed to "today" runs on this day — the defer rule in
 * `bulkSnooze`, the rollover job, attempts, decks, the deadlines page, the
 * queue panels' day roster, and (from 2026-10-23) the Reminders screen: its
 * roster and "considered today", quota prompts and their day keys, a daily
 * quota's count, and the slot nag (`dayBoundaryForUser` in
 * src/core/tasks/rollover-time.ts is their read; with the switch off it is
 * midnight, `CALENDAR_DAY_START`). "Today" in the Now view, the Today pill,
 * Upcoming, the horizon segments and check_in_day stay on midnight
 * (build-plan resolution 4).
 *
 * Pure: no database, no clock of its own. Every function takes the instant it
 * is asked about.
 */

import { DateTime } from 'luxon'
import { parseHHMM } from '@/lib/time-slot-assign'

/**
 * A LOCAL WALL-CLOCK MOMENT: `time` ("HH:MM") on the local date `localDate`
 * (yyyy-MM-dd) in `timezone`, as an instant. One rule for every derived
 * local moment — the rollover (`rolloverMoment`) and a deadline-anchored
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

/** The rollover instant on a local date (yyyy-MM-dd) in `timezone` (`localMoment`'s DST rule). */
export function rolloverMoment(localDate: string, timezone: string, rolloverTime: string): Date {
  return localMoment(localDate, rolloverTime, timezone)
}

/**
 * The OpenTask day (yyyy-MM-dd) an instant belongs to: the local date whose
 * rollover-to-rollover span contains it. 00:00–06:29 belongs to the previous
 * date; 06:30 exactly starts the new one.
 */
export function openTaskDayOf(instant: Date, timezone: string, rolloverTime: string): string {
  const local = DateTime.fromJSDate(instant).setZone(timezone)
  const date = local.toISODate()!
  if (instant.getTime() >= rolloverMoment(date, timezone, rolloverTime).getTime()) return date
  return local.minus({ days: 1 }).toISODate()!
}

/**
 * Midnight as a day start: the calendar day, as an OpenTask day. What the
 * day-keyed surfaces run on with the task queue's switch off
 * (`dayBoundaryForUser`), so one code path serves both.
 */
export const CALENDAR_DAY_START = '00:00'

/** One OpenTask day: its date, and the instants it runs between, `[start, end)`. */
export interface OpenTaskDaySpan {
  /** yyyy-MM-dd — the local date the day is named by (`openTaskDayOf`). */
  date: string
  start: Date
  end: Date
}

/**
 * The OpenTask day `now` belongs to, as a span: from its rollover to the
 * next date's. With `CALENDAR_DAY_START` it is the local calendar day.
 */
export function openTaskDaySpan(
  now: Date,
  timezone: string,
  rolloverTime: string,
): OpenTaskDaySpan {
  const date = openTaskDayOf(now, timezone, rolloverTime)
  const next = DateTime.fromISO(date, { zone: timezone }).plus({ days: 1 }).toISODate()!
  return {
    date,
    start: rolloverMoment(date, timezone, rolloverTime),
    end: rolloverMoment(next, timezone, rolloverTime),
  }
}

/**
 * Wall-clock minutes from the day start (`dayStart`, HH:MM) to `minuteOfDay`
 * (0..1439), 0..1439: where a time of day falls within an OpenTask day. A
 * period that starts before the day start sorts at the END of the day. With
 * `CALENDAR_DAY_START` it is the minute of the day itself. For the clients'
 * "has this slot started" (`slotHasStarted`, `naturalSlotIndex`); the
 * server's slot nag asks the same question in instants (`periodOpensAt`).
 */
export function minutesIntoDay(minuteOfDay: number, dayStart: string): number {
  const start = parseHHMM(dayStart) ?? 0
  return (((minuteOfDay - start) % 1440) + 1440) % 1440
}

/**
 * When a reminder period (`start`, HH:MM) opens within the OpenTask day
 * `date`: on that date when it starts at or after the rollover, else on the
 * next date — a 1:00 AM period, with the day starting at 3:00, is the END of
 * the day, not its beginning.
 */
export function periodOpensAt(
  date: string,
  start: string,
  timezone: string,
  rolloverTime: string,
): Date {
  const startMin = parseHHMM(start)
  const rolloverMin = parseHHMM(rolloverTime)
  const onDate =
    startMin === null || rolloverMin === null || startMin >= rolloverMin
      ? date
      : DateTime.fromISO(date, { zone: timezone }).plus({ days: 1 }).toISODate()!
  return localMoment(onDate, start, timezone)
}

/**
 * The first rollover moment STRICTLY after `now`: at exactly 6:30:00 it is
 * tomorrow's.
 */
export function nextRollover(now: Date, timezone: string, rolloverTime: string): Date {
  const local = DateTime.fromJSDate(now).setZone(timezone)
  const today = rolloverMoment(local.toISODate()!, timezone, rolloverTime)
  if (today.getTime() > now.getTime()) return today
  return rolloverMoment(local.plus({ days: 1 }).toISODate()!, timezone, rolloverTime)
}

/**
 * The latest rollover moment AT OR BEFORE `now` (the mirror of
 * `nextRollover`): at exactly 6:30:00 it is today's; at 6:29 it is
 * yesterday's. The rollover job runs as of this moment (task-queue PR 2).
 */
export function latestRollover(now: Date, timezone: string, rolloverTime: string): Date {
  const local = DateTime.fromJSDate(now).setZone(timezone)
  const today = rolloverMoment(local.toISODate()!, timezone, rolloverTime)
  if (today.getTime() <= now.getTime()) return today
  return rolloverMoment(local.minus({ days: 1 }).toISODate()!, timezone, rolloverTime)
}

/**
 * AN EARLY-MORNING PICK (designer ruling, 2026-10-19): a target between local
 * midnight and the rollover on its calendar day X, SET on an earlier calendar
 * day than X — at 22:00, "tomorrow 6:00". It is a pick for the coming day,
 * not the evening's leftover, so it belongs to day X: the rollover of day X
 * spares it (src/core/tasks/task-rollover.ts) and its attempts count day X,
 * not the OpenTask day before (`targetOpenTaskDay`). A pick made after
 * midnight (the night owl's 1 AM pick of 2 AM) is not one: it stays with the
 * evening's day. ONE rule for both, so they can't drift apart.
 */
export function isEarlyMorningPick(
  dueAt: string,
  setAt: string,
  timezone: string,
  rolloverTime: string,
): boolean {
  const due = DateTime.fromISO(dueAt, { zone: 'utc' }).setZone(timezone)
  const day = due.toISODate()!
  if (due.toMillis() >= rolloverMoment(day, timezone, rolloverTime).getTime()) return false
  const setDay = DateTime.fromISO(setAt, { zone: 'utc' }).setZone(timezone).toISODate()!
  return setDay < day
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
  rolloverTime: string,
): string {
  if (isEarlyMorningPick(dueAt, setAt, timezone, rolloverTime)) {
    return DateTime.fromISO(dueAt, { zone: 'utc' }).setZone(timezone).toISODate()!
  }
  return openTaskDayOf(new Date(dueAt), timezone, rolloverTime)
}
