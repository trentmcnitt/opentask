/**
 * The lean task row's time-chip words (2026-10-28): the MOMENT alone, for a
 * deadline (behind its flag) and a target alike — "Today 6:00 PM",
 * "Yesterday 7:00 AM", "Tomorrow 9:00 AM", "Thu night 1:00 AM", "Mon 9:00 AM"
 * within a week either side, else "Oct 22 9:00 AM" ("Oct 22, 2025 9:00 AM"
 * in another year). No "3h ago": on a lean row the over-target look says a
 * target has passed, and the chip just says when.
 *
 * The day words are the app's one night rule (`nightDay` / `nightDayWords`,
 * L9): a moment before the day start belongs to the OpenTask day before
 * ("Thu night"); "today", "tomorrow" and "yesterday" are said only where the
 * OpenTask day and the moment's own date agree. The time is
 * `formatTimeInTimezone`. The card rows keep `formatDueTimeParts`.
 */
import { formatTimeInTimezone } from '@/lib/format-date'
import { capitalized, nightDay, nightDayWords, timedDay } from '@/lib/night-day'

/** Within this many OpenTask days either side, a day word or weekday; beyond, the date. */
const WEEK = 7

export function momentChipWords(
  iso: string,
  timezone: string,
  dayStart: string | null,
  now: Date = new Date(),
): string {
  const at = new Date(iso)
  const n = nightDay(at, timezone, dayStart, now)
  const time = formatTimeInTimezone(iso, timezone)
  if (Math.abs(n.gap) < WEEK) return `${capitalized(nightDayWords(n, at < now))} ${time}`
  const day = timedDay(n)
  const thisYear = day.year === n.day.minus({ days: n.gap }).year
  return `${day.toFormat(thisYear ? 'LLL d' : 'LLL d, yyyy')} ${time}`
}
