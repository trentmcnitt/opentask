/**
 * Shared utility functions for recurrence computation
 *
 * These functions handle conversion between timezone-aware DateTime
 * and "naive local" Date objects for rrule.js compatibility.
 */

import { DateTime } from 'luxon'

/**
 * Convert a timezone-aware DateTime to a "naive local" Date.
 * The resulting Date's local methods (getHours, etc.) return the original local time values.
 */
export function toNaiveLocal(dt: DateTime): Date {
  return new Date(dt.year, dt.month - 1, dt.day, dt.hour, dt.minute, dt.second, dt.millisecond)
}

/**
 * Convert a "naive local" Date to a timezone-aware DateTime.
 * Treats the Date's local time values as being in the specified timezone.
 */
export function fromNaiveLocal(d: Date, timezone: string): DateTime {
  return DateTime.fromObject(
    {
      year: d.getFullYear(),
      month: d.getMonth() + 1,
      day: d.getDate(),
      hour: d.getHours(),
      minute: d.getMinutes(),
      second: d.getSeconds(),
      millisecond: d.getMilliseconds(),
    },
    { zone: timezone },
  )
}
