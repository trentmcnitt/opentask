/**
 * Relative date helpers for quality test scenarios
 *
 * These functions generate ISO 8601 UTC timestamps relative to the current
 * clock time. Using them instead of hardcoded dates makes scenarios
 * time-agnostic — a task designed to be "10 days old" stays 10 days old
 * regardless of when the test suite runs.
 *
 * Originally defined inline in quick-take.ts; extracted here so all
 * scenario families (insights, whats-next, quick-take) can share them.
 */

import { DateTime } from 'luxon'

// ---------------------------------------------------------------------------
// Past dates (for created_at, overdue due_at)
// ---------------------------------------------------------------------------

/** N days ago (UTC). Use for created_at or due_at that should be in the past. */
export function daysAgo(n: number): string {
  return DateTime.now().minus({ days: n }).toUTC().toISO()!
}

/** N days ago at a specific local time. Use when creation/due time of day matters. */
export function daysAgoAt(days: number, hour: number, min: number, tz: string): string {
  return DateTime.now()
    .setZone(tz)
    .minus({ days })
    .set({ hour, minute: min, second: 0 })
    .toUTC()
    .toISO()!
}

/** N weeks ago (UTC). Convenience wrapper around daysAgo. */
export function weeksAgo(n: number): string {
  return DateTime.now().minus({ weeks: n }).toUTC().toISO()!
}

/** N months ago (UTC). Use for genuinely old tasks ("created 3 months ago"). */
export function monthsAgo(n: number): string {
  return DateTime.now().minus({ months: n }).toUTC().toISO()!
}

// ---------------------------------------------------------------------------
// Present / future dates (for due_at on upcoming tasks)
// ---------------------------------------------------------------------------

/** Today at the given local time (converted to UTC). */
export function todayAt(hour: number, min: number, tz: string): string {
  return DateTime.now().setZone(tz).set({ hour, minute: min, second: 0 }).toUTC().toISO()!
}

/** Tomorrow at the given local time. */
export function tomorrowAt(hour: number, min: number, tz: string): string {
  return DateTime.now()
    .setZone(tz)
    .plus({ days: 1 })
    .set({ hour, minute: min, second: 0 })
    .toUTC()
    .toISO()!
}

/** N days from now at the given local time. Negative values = past. */
export function daysFromNowAt(days: number, hour: number, min: number, tz: string): string {
  return DateTime.now()
    .setZone(tz)
    .plus({ days })
    .set({ hour, minute: min, second: 0 })
    .toUTC()
    .toISO()!
}
