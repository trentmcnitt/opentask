/**
 * Shared utility functions for recurrence computation
 *
 * These functions handle conversion between timezone-aware DateTime
 * and "naive" Date objects for rrule.js compatibility.
 *
 * We use UTC methods (not server-local) so results are independent of the host
 * timezone. rrule.js operates on Date objects via getUTC*() internally, so we
 * pack the user's local components (year/month/day/hour/…) into a Date's UTC
 * slot, let rrule iterate, then unpack the UTC components back into the user's
 * timezone. Using server-local methods here causes DST-offset drift between
 * DTSTART (winter offset) and the target date (summer offset) on hosts that
 * observe DST — see the recurrence tests for the regression this avoids.
 */

import { DateTime } from 'luxon'

/**
 * Convert a timezone-aware DateTime to a "naive" Date for rrule.js.
 * The DateTime's local components are packed into the Date's UTC slot.
 */
export function toNaiveLocal(dt: DateTime): Date {
  return new Date(
    Date.UTC(dt.year, dt.month - 1, dt.day, dt.hour, dt.minute, dt.second, dt.millisecond),
  )
}

/**
 * Convert a "naive" Date from rrule.js to a timezone-aware DateTime.
 * Reads UTC components and interprets them as being in the specified timezone.
 */
export function fromNaiveLocal(d: Date, timezone: string): DateTime {
  return DateTime.fromObject(
    {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
      second: d.getUTCSeconds(),
      millisecond: d.getUTCMilliseconds(),
    },
    { zone: timezone },
  )
}
