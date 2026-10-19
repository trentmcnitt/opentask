/**
 * THE OPENTASK DAY (task queue, 2026-10-19; docs/TASK-MODEL.md § The OpenTask
 * day, picks and defers).
 *
 * The day runs from ROLLOVER to rollover, not midnight to midnight. The
 * rollover is the start of the user's first reminder period (Trent's is
 * 6:30), or their `morning_time` when they have no periods. The stretch from
 * midnight to the rollover belongs to the day before: a night owl's 2 AM
 * target is part of the evening's day.
 *
 * Used, for now, by the defer rule in `bulkSnooze` (a Snooze-all landing at or
 * after the next rollover marks the task for the queue) and, from task-queue
 * PR 2, by the rollover job and attempts. "Today" in the Now view, the Today
 * pill, Upcoming and check_in_day stay on midnight (build-plan resolution 4).
 *
 * Pure: no database, no clock of its own. Every function takes the instant it
 * is asked about.
 */

import { DateTime } from 'luxon'
import { parseHHMM, sortSlotsByStart } from '@/lib/time-slot-assign'

/**
 * The rollover time of day (HH:MM): the earliest period's start, else
 * `morningTime`. A slot whose start does not parse is ignored.
 */
export function rolloverTimeOf(
  slots: readonly { start_time: string }[],
  morningTime: string,
): string {
  const first = sortSlotsByStart(slots.filter((s) => parseHHMM(s.start_time) !== null))[0]
  return first?.start_time ?? morningTime
}

/**
 * The rollover instant on a local date (yyyy-MM-dd) in `timezone`.
 *
 * DST. A spring-forward gap can swallow the rollover time (a 02:30 first
 * period on the night clocks jump 2:00 → 3:00). Luxon would shift such a time
 * forward by the gap's length (2:30 → 3:30); the rule here is the NEXT VALID
 * MINUTE — the first local minute after the requested one that exists that
 * day (3:00). On a fall-back night the repeated hour resolves to its first
 * occurrence (Luxon's choice), which is the earlier instant.
 */
export function rolloverMoment(localDate: string, timezone: string, rolloverTime: string): Date {
  const minutes = parseHHMM(rolloverTime)
  if (minutes === null) throw new Error(`Not an HH:MM rollover time: ${rolloverTime}`)
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
