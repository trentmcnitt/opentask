/**
 * Pure date arithmetic functions for the Quick Action Panel.
 *
 * All functions work with UTC ISO strings and IANA timezone strings.
 * Preset times use wall-clock time in the user's timezone; increments
 * use duration-based arithmetic (except +/-1 day which uses calendar-day
 * arithmetic to survive DST transitions).
 */

import {
  parseLocalDatetimeInput,
  parseInTimezone,
  getTimezoneDayBoundaries,
  daysBetween,
} from '@/lib/format-date'
import { snapToHour } from '@/lib/snooze'
import { capitalized, nightDay, nightDayWords, timedDay } from '@/lib/night-day'

/** Increment buttons: positive = forward, negative = backward */
export const INCREMENTS = [
  { label: '+1 min', minutes: 1 },
  { label: '+10 min', minutes: 10 },
  { label: '+1 hr', minutes: 60 },
  { label: '+1 day', minutes: null, days: 1 },
] as const

export const DECREMENTS = [
  { label: '-5 min', minutes: -5 },
  { label: '-30 min', minutes: -30 },
  { label: '-1 hr', minutes: -60 },
  { label: '-1 day', minutes: null, days: -1 },
] as const

/**
 * Get a UTC ISO string for a specific hour:minute in the user's timezone
 * on the date represented by `refDate` (or the next calendar day if that
 * time has already passed today).
 */
function dateAtLocalTime(refDate: Date, hour: number, minute: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(refDate)

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00'
  const pad = (n: number) => n.toString().padStart(2, '0')

  return parseLocalDatetimeInput(
    `${get('year')}-${get('month')}-${get('day')}T${pad(hour)}:${pad(minute)}`,
    timezone,
  )
}

/**
 * Snap to the next occurrence of a preset time.
 * If the preset time has already passed today (in the user's timezone),
 * returns tomorrow at that time.
 */
export function snapToNextPreset(
  hour: number,
  minute: number,
  timezone: string,
  now?: Date,
): string {
  const reference = now ?? new Date()
  const todayAtPreset = dateAtLocalTime(reference, hour, minute, timezone)

  if (new Date(todayAtPreset) > reference) {
    return todayAtPreset
  }

  // Preset has passed — use tomorrow (DST-safe: use calendar-day arithmetic)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(reference)
  const get = (type: string) => parseInt(parts.find((p) => p.type === type)?.value ?? '0')
  const tomorrowMidnight = parseInTimezone(get('year'), get('month'), get('day') + 1, timezone)
  return dateAtLocalTime(tomorrowMidnight, hour, minute, timezone)
}

/**
 * Adjust a working date by a duration increment.
 *
 * For minute-based increments, adds/subtracts exact milliseconds.
 * For day-based increments, uses calendar-day arithmetic in the user's
 * timezone to preserve wall-clock time across DST transitions.
 */
export function adjustDate(
  currentIso: string,
  increment: { minutes: number | null; days?: number },
  timezone: string,
): string {
  const current = new Date(currentIso)

  // Day-based: calendar arithmetic in user's timezone
  if (increment.minutes === null && increment.days) {
    // Extract local date/time parts
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(current)

    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00'
    const year = parseInt(get('year'))
    const month = parseInt(get('month'))
    const day = parseInt(get('day'))
    const hourStr = get('hour')
    const minuteStr = get('minute')

    // Add calendar days
    const localDate = new Date(year, month - 1, day + increment.days)
    const pad = (n: number) => n.toString().padStart(2, '0')

    return parseLocalDatetimeInput(
      `${localDate.getFullYear()}-${pad(localDate.getMonth() + 1)}-${pad(localDate.getDate())}T${hourStr}:${minuteStr}`,
      timezone,
    )
  }

  // Minute-based: exact duration
  const minutes = increment.minutes ?? 0
  return new Date(current.getTime() + minutes * 60 * 1000).toISOString()
}

/**
 * Initialize the working date for a task.
 * - If the task has a due_at, use that.
 * - Otherwise, snap to the nearest 5-minute boundary (close to "now").
 *   Presets ignore this value (they snap to next occurrence), and the UI
 *   shows "No due date" until the user presses a button, so using a
 *   near-now value gives intuitive results for increment buttons (+1 min, etc.).
 */
export function initWorkingDate(dueAt: string | null, now?: Date): string {
  if (dueAt) return dueAt
  return snapToNearestFiveMinutes(now)
}

/**
 * Get the day label for a date: "Today", "Tomorrow", "Yesterday", or short
 * weekday (e.g., "Mon") — by the user's OpenTask days (`dayStart`, "Day
 * starts at" PR 2): with a 3:00 AM start, at 01:30 a 9:00 AM time is
 * "Tomorrow", and a Friday 1:00 AM time is "Thu" (the OpenTask day's weekday,
 * part 2) — the label of the WHOLE DAY the moment is on, for a label beside
 * that day's OpenTask date (the bulk header's "Wed, Oct 28, —"). A label
 * with the moment's own time and date is `formatQuickSelectHeader`'s.
 */
export function getDayLabel(
  isoUtc: string,
  timezone: string,
  dayStart: string,
  now: Date = new Date(),
): string {
  const date = new Date(isoUtc)
  const { yesterdayStart, todayStart, tomorrowStart, dayAfterTomorrowStart } =
    getTimezoneDayBoundaries(timezone, dayStart, now)

  if (date >= yesterdayStart && date < todayStart) return 'Yesterday'
  if (date >= todayStart && date < tomorrowStart) return 'Today'
  if (date >= tomorrowStart && date < dayAfterTomorrowStart) return 'Tomorrow'

  return nightDay(date, timezone, dayStart, now).day.toFormat('ccc')
}

/**
 * Format the header line for the Quick Action Panel.
 * Returns: "Today, Feb 3, 10:00 AM" or "Tomorrow, Feb 4, 9:00 AM" or "Mon, Feb 10, 6:50 PM".
 *
 * Between midnight and the day start the day word follows L9's night rule
 * (`nightDay`, part 2): "Tonight, Feb 3, 1:00 AM", "Tomorrow night, Feb 4,
 * 1:00 AM", "Thu night, Feb 5, 1:00 AM" — the word AND the date name the
 * OpenTask day the time is on, the evening (2026-10-27: "Mon night, Oct 27"
 * for a Tue Oct 27 01:00 paired Monday with Tuesday's date; a label's weekday
 * and date always name the same day, `timedDay`). Out of the night the day
 * is the moment's own (Trent, 2026-10-26): with an 11 PM start a Tue Oct 27
 * 23:47 target is on Wednesday's list but reads "Tue, Oct 27, 11:47 PM", and
 * a word that would contradict the date gives way to the weekday — at Sat
 * 12:30 a Sat 23:30 target is "Sat, Oct 24, 11:30 PM", not "Tomorrow, Oct 24"
 * (`nightDayWords`).
 */
export function formatQuickSelectHeader(
  isoUtc: string,
  timezone: string,
  dayStart: string,
  now: Date = new Date(),
): string {
  const date = new Date(isoUtc)
  const n = nightDay(date, timezone, dayStart, now)
  const dayLabel = capitalized(nightDayWords(n, date < now))

  const timePart = date.toLocaleString('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })

  // The day the words name: the evening's date in its night, else its own.
  const datePart = timedDay(n).toFormat('LLL d')

  return `${dayLabel}, ${datePart}, ${timePart}`
}

/**
 * Format the relative time portion: "in 26 mins", "3h ago", "in 2 days", etc.
 *
 * Rules:
 * - Same calendar day: Always show hours/minutes ("in 2h", "in 30m")
 * - Tomorrow & <12 hours away: Show hours ("in 8h", "in 11h")
 * - Tomorrow & 12+ hours away: Show "in 1 day"
 * - Beyond tomorrow: Count calendar days ("in 2 days", "in 5 days")
 *
 * Days are counted in `timezone` (the account's) on the user's OpenTask days
 * (`dayStart`), so the text agrees with the Today/Tomorrow header even when
 * the device clock is set to another zone.
 */
export function formatRelativeTime(
  isoUtc: string,
  timezone: string,
  dayStart: string,
  now: Date = new Date(),
): string {
  const target = new Date(isoUtc)
  const reference = now
  const diffMs = target.getTime() - reference.getTime()
  const absDiffMs = Math.abs(diffMs)
  const isPast = diffMs < 0

  const totalMinutes = Math.floor(absDiffMs / 60000)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60

  const calendarDays = Math.abs(daysBetween(reference, target, timezone, dayStart))

  let text: string

  if (calendarDays === 0) {
    // Same calendar day: always use hours/minutes
    if (hours > 0) {
      text = minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
    } else if (totalMinutes > 0) {
      text = `${totalMinutes} min${totalMinutes !== 1 ? 's' : ''}`
    } else {
      return isPast ? 'just now' : 'in <1 min'
    }
  } else if (calendarDays === 1 && hours < 12) {
    // Tomorrow but less than 12 hours away: show hours
    text = minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  } else {
    // Tomorrow 12+ hours away, or any day beyond: show calendar days
    text = calendarDays === 1 ? '1 day' : `${calendarDays} days`
  }

  return isPast ? `${text} ago` : `in ${text}`
}

/**
 * Format delta minutes for display: "+1h 30m", "+2d 2h", "-30m", etc.
 * Used by both single-task and bulk snooze to show the delta applied.
 */
export function formatDeltaText(deltaMinutes: number): string {
  const absDelta = Math.abs(deltaMinutes)
  const direction = deltaMinutes >= 0 ? 'later' : 'sooner'

  const totalHours = Math.floor(absDelta / 60)
  const minutes = absDelta % 60
  const days = Math.floor(totalHours / 24)
  const hours = totalHours % 24

  let magnitude: string
  if (days > 0 && hours > 0) {
    magnitude = `${days}d ${hours}h`
  } else if (days > 0) {
    magnitude = `${days}d`
  } else if (hours > 0 && minutes > 0) {
    magnitude = `${hours}h ${minutes}m`
  } else if (hours > 0) {
    magnitude = `${hours}h`
  } else {
    magnitude = `${minutes}m`
  }

  return `${magnitude} ${direction}`
}

/** Smart button definitions for quick date selection */
export const SMART_BUTTONS = [
  { label: 'Now', type: 'now' as const },
  { label: 'Next Hour', type: 'nextHour' as const },
] as const

/**
 * Snap to the nearest 5-minute increment in the future.
 * - 1:33 PM → 1:35 PM
 * - 1:35 PM → 1:40 PM (rounds up if exactly on mark)
 */
export function snapToNearestFiveMinutes(now?: Date): string {
  const reference = now ?? new Date()
  const minutes = reference.getMinutes()
  const remainder = minutes % 5
  const addMinutes = remainder === 0 ? 5 : 5 - remainder
  const result = new Date(reference.getTime())
  result.setMinutes(minutes + addMinutes, 0, 0)
  return result.toISOString()
}

/**
 * Round up to the top of the next hour, or the hour after if past X:35.
 * Advances at least one hour first, then snaps to the nearest hour boundary.
 * - 1:30 PM → 2:00 PM (minutes < 35)
 * - 1:37 PM → 3:00 PM (minutes >= 35)
 */
export function snapToNextHour(now?: Date): string {
  const reference = now ?? new Date()
  const oneHourLater = new Date(reference.getTime() + 60 * 60 * 1000)
  return snapToHour(oneHourLater).toISOString()
}
