/**
 * Timezone utilities for OpenTask
 *
 * All datetimes in the database are stored in UTC.
 * Recurrence patterns (BYHOUR, BYDAY, etc.) are in the user's local timezone.
 */

import { DateTime, Settings } from 'luxon'

// Ensure luxon doesn't throw on invalid zones
Settings.throwOnInvalid = true

/**
 * Convert a UTC datetime string to a DateTime in the specified timezone
 */
export function utcToLocal(utcDatetime: string, timezone: string): DateTime {
  return DateTime.fromISO(utcDatetime, { zone: 'utc' }).setZone(timezone)
}

/**
 * Convert a DateTime in any timezone to a UTC ISO string
 */
export function localToUtc(dt: DateTime): string {
  return dt.toUTC().toISO()!
}

/**
 * Get the current time in a specific timezone
 */
export function nowInTimezone(timezone: string): DateTime {
  return DateTime.now().setZone(timezone)
}

/**
 * Get the current time as a UTC ISO string
 */
export function nowUtc(): string {
  return DateTime.utc().toISO()!
}

/**
 * Parse an anchor time string (HH:MM) into hours and minutes
 */
export function parseAnchorTime(anchorTime: string): { hour: number; minute: number } {
  const [hourStr, minuteStr] = anchorTime.split(':')
  return {
    hour: parseInt(hourStr, 10),
    minute: parseInt(minuteStr, 10),
  }
}

/**
 * Format hours and minutes as an anchor time string (HH:MM)
 */
export function formatAnchorTime(hour: number, minute: number): string {
  return `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`
}

/**
 * Validate a timezone string
 */
export function isValidTimezone(timezone: string): boolean {
  try {
    const dt = DateTime.now().setZone(timezone)
    return dt.isValid && dt.zone.name === timezone
  } catch {
    return false
  }
}

/**
 * Convert a local time (hour/minute) in a timezone to UTC for a specific date
 */
export function localTimeToUtc(
  date: DateTime,
  hour: number,
  minute: number,
  timezone: string,
): DateTime {
  return DateTime.fromObject(
    {
      year: date.year,
      month: date.month,
      day: date.day,
      hour,
      minute,
      second: 0,
      millisecond: 0,
    },
    { zone: timezone },
  ).toUTC()
}

/**
 * Get day of week (0=Monday..6=Sunday) from a DateTime
 * Note: Luxon's weekday is 1=Monday..7=Sunday, we convert to 0-indexed
 */
export function getDayOfWeek(dt: DateTime): number {
  return dt.weekday - 1
}

/**
 * Convert 0-indexed DOW (0=Mon..6=Sun) to RRULE BYDAY abbreviation
 */
export function dowToRRuleDay(dow: number): string {
  const days = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']
  return days[dow]
}

/**
 * Convert RRULE BYDAY abbreviation to 0-indexed DOW (0=Mon..6=Sun)
 */
export function rruleDayToDow(day: string): number {
  const days: Record<string, number> = {
    MO: 0,
    TU: 1,
    WE: 2,
    TH: 3,
    FR: 4,
    SA: 5,
    SU: 6,
  }
  return days[day.toUpperCase()]
}
