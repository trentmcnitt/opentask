/**
 * Pure date arithmetic functions for the Quick Action Panel.
 *
 * All functions work with UTC ISO strings and IANA timezone strings.
 * Preset times use wall-clock time in the user's timezone; increments
 * use duration-based arithmetic (except +/-1 day which uses calendar-day
 * arithmetic to survive DST transitions).
 */

import { parseLocalDatetimeInput } from '@/lib/format-date'

/** Preset time slots (24h format in user's local timezone) */
export const PRESET_TIMES = [
  { label: '9:00 AM', hour: 9, minute: 0 },
  { label: '12:00 PM', hour: 12, minute: 0 },
  { label: '4:00 PM', hour: 16, minute: 0 },
  { label: '8:30 PM', hour: 20, minute: 30 },
] as const

/** Increment buttons: positive = forward, negative = backward */
export const INCREMENTS = [
  { label: '+1 min', minutes: 1 },
  { label: '+30 min', minutes: 30 },
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

  // Preset has passed — use tomorrow
  const tomorrow = new Date(reference.getTime() + 24 * 60 * 60 * 1000)
  return dateAtLocalTime(tomorrow, hour, minute, timezone)
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
      hour12: false,
    }).formatToParts(current)

    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00'
    const year = parseInt(get('year'))
    const month = parseInt(get('month'))
    const day = parseInt(get('day'))
    const hourStr = get('hour') === '24' ? '00' : get('hour')
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
 * - Otherwise, round up to the next full hour from now + 1 hour.
 */
export function initWorkingDate(dueAt: string | null, now?: Date): string {
  if (dueAt) return dueAt

  const reference = now ?? new Date()
  const future = new Date(reference.getTime() + 60 * 60 * 1000)
  // Round up to next hour
  if (future.getMinutes() > 0 || future.getSeconds() > 0) {
    future.setMinutes(0, 0, 0)
    future.setHours(future.getHours() + 1)
  }
  return future.toISOString()
}

/**
 * Format the header line for the Quick Action Panel.
 * Returns: "Mon, Feb 2 at 6:50 PM"
 */
export function formatQuickSelectHeader(isoUtc: string, timezone: string): string {
  const date = new Date(isoUtc)
  return date.toLocaleString('en-US', {
    timeZone: timezone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

/**
 * Format the relative time portion: "in 26 mins", "3h ago", etc.
 */
export function formatRelativeTime(isoUtc: string, now?: Date): string {
  const target = new Date(isoUtc)
  const reference = now ?? new Date()
  const diffMs = target.getTime() - reference.getTime()
  const absDiffMs = Math.abs(diffMs)
  const isPast = diffMs < 0

  const totalMinutes = Math.floor(absDiffMs / 60000)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  const days = Math.floor(hours / 24)

  let text: string
  if (days > 0) {
    text = days === 1 ? '1 day' : `${days} days`
    const remainingHours = hours % 24
    if (remainingHours > 0) {
      text += ` ${remainingHours}h`
    }
  } else if (hours > 0) {
    text = minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  } else if (totalMinutes > 0) {
    text = `${totalMinutes} min${totalMinutes !== 1 ? 's' : ''}`
  } else {
    text = '<1 min'
  }

  return isPast ? `${text} ago` : `in ${text}`
}
