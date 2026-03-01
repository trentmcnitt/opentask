/**
 * Shared utilities for seed scripts (seed-demo)
 */

import { DateTime } from 'luxon'
import { localToUtc } from '../src/core/recurrence/timezone'

const DEFAULT_TIMEZONE = 'America/Chicago'

/**
 * Convert a local time offset to a UTC ISO string.
 *
 * @param daysOffset - Days from today (positive = future, negative = past)
 * @param hour - Local hour (0-23)
 * @param minute - Local minute (0-59)
 * @param timezone - IANA timezone (default: America/Chicago)
 */
export function localToUtcIso(
  daysOffset: number,
  hour: number,
  minute: number,
  timezone: string = DEFAULT_TIMEZONE,
): string {
  const local = DateTime.now()
    .setZone(timezone)
    .plus({ days: daysOffset })
    .set({ hour, minute, second: 0, millisecond: 0 })
  return localToUtc(local)
}

/**
 * Returns the number of days from today until the next occurrence of
 * the given ISO weekday(s) (1=Mon..7=Sun). Always returns at least
 * `minDays` (default 1) so tasks are never due today — prevents
 * accidental overdue after the daily 3 AM reset.
 *
 * @param isoWeekdays - Single weekday or array of weekdays (1=Mon..7=Sun)
 * @param minDays - Minimum days to return (default: 1)
 * @param timezone - IANA timezone (default: America/Chicago)
 */
export function daysUntilWeekday(
  isoWeekdays: number | number[],
  minDays: number = 1,
  timezone: string = DEFAULT_TIMEZONE,
): number {
  const weekdays = Array.isArray(isoWeekdays) ? isoWeekdays : [isoWeekdays]
  const today = DateTime.now().setZone(timezone)
  for (let d = minDays; d <= 7 + minDays; d++) {
    if (weekdays.includes(today.plus({ days: d }).weekday)) return d
  }
  return minDays
}
