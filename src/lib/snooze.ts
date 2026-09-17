import { DateTime } from 'luxon'
import { taskWord } from '@/lib/utils'

const HOUR_ROUND_THRESHOLD = 35

/** Snap a Date to the nearest hour: >=35 min rounds up, <35 truncates down. */
export function snapToHour(date: Date): Date {
  const result = new Date(date.getTime())
  const mins = result.getMinutes()
  result.setMinutes(0, 0, 0)
  if (mins >= HOUR_ROUND_THRESHOLD) {
    result.setHours(result.getHours() + 1)
  }
  return result
}

/**
 * Compute the UTC ISO string for a snooze target time.
 *
 * @param option - Snooze option: 'tomorrow' or a string-integer of minutes (e.g., '60', '120')
 * @param timezone - User's IANA timezone (e.g., 'America/Chicago')
 * @param morningTime - User's configured morning time in HH:MM format (e.g., '09:00')
 * @returns UTC ISO string for the snooze target
 */
export function computeSnoozeTime(option: string, timezone: string, morningTime: string): string {
  if (option === 'tomorrow') {
    const [hour, minute] = morningTime.split(':').map(Number)
    return DateTime.now()
      .setZone(timezone)
      .plus({ days: 1 })
      .set({ hour, minute, second: 0, millisecond: 0 })
      .toUTC()
      .toISO()!
  }

  const minutes = parseInt(option, 10)
  if (minutes >= 60) {
    return snapToHour(new Date(Date.now() + minutes * 60 * 1000)).toISOString()
  }

  // Sub-hour: exact minutes from now
  return new Date(Date.now() + minutes * 60 * 1000).toISOString()
}

/**
 * Format a morning time string for display.
 * '09:00' -> '9:00 AM', '14:30' -> '2:30 PM'
 */
export function formatMorningTime(morningTime: string): string {
  const [h, m] = morningTime.split(':').map(Number)
  const period = h >= 12 ? 'PM' : 'AM'
  const displayHour = h === 0 ? 12 : h > 12 ? h - 12 : h
  return `${displayHour}:${String(m).padStart(2, '0')} ${period}`
}

/**
 * Format a snooze option as a compact badge label.
 * '30' -> '+30m', '60' -> '+1h', '120' -> '+2h', 'tomorrow' -> 'AM'
 */
export function formatCompactSnoozeLabel(option: string): string {
  if (option === 'tomorrow') return 'AM'
  const minutes = parseInt(option, 10)
  if (minutes < 60) return `+${minutes}m`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (m === 0) return `+${h}h`
  return `+${h}h${m}m`
}

/**
 * Format a snooze option for display in settings / menus.
 * '30' -> '30 min', '60' -> '1 hour', '120' -> '2 hours', 'tomorrow' -> 'Tomorrow at 9:00 AM'
 */
export function formatSnoozeOptionLabel(option: string, morningTime: string): string {
  if (option === 'tomorrow') {
    return `Tomorrow at ${formatMorningTime(morningTime)}`
  }
  const minutes = parseInt(option, 10)
  if (minutes < 60) return `${minutes} min`
  if (minutes === 60) return '1 hour'
  if (minutes % 60 === 0) return `${minutes / 60} hours`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${h}h ${m}m`
}

/** What a bulk sweep skipped on priority, split so a message can name it. */
export interface BulkSnoozeSkips {
  /** Tasks actually moved. */
  affected: number
  /** P3 skipped — deferred to the next sweep, because something lower was still eligible. */
  high: number
  /** P4 skipped — never bulk-snoozable at all. */
  urgent: number
}

/** "2 high", "1 urgent", "2 high, 1 urgent". Empty when nothing was skipped. */
function skipList(high: number, urgent: number): string {
  const parts: string[] = []
  if (high > 0) parts.push(`${high} high`)
  if (urgent > 0) parts.push(`${urgent} urgent`)
  return parts.join(', ')
}

/**
 * The toast for a bulk "snooze all overdue" press.
 *
 * NAMES HIGH AND URGENT SEPARATELY, and this is the point of the function.
 * The message used to read "No snoozable tasks (4 urgent must be snoozed
 * individually)" for four tasks that were priority 3, High — none of them
 * Urgent. The count was right and the word was wrong, because the core's
 * internal `urgentSkipped` counts BOTH tiers (its name is frozen by the
 * `skipped_urgent` API field the iOS client reads) and that internal name
 * leaked into user-facing copy.
 *
 * "MUST BE SNOOZED INDIVIDUALLY" IS NOW ONLY SAID OF URGENT, because it is only
 * true of Urgent. High is swept on the next press once nothing lower is left
 * (see `filterForBulkSnooze`), so saying it of High would be telling the user
 * to do by hand the thing the next press does for them.
 *
 * A pure function so the copy can be tested without a browser.
 */
export function bulkSnoozeMessage({ affected, high, urgent }: BulkSnoozeSkips): string {
  const list = skipList(high, urgent)

  if (affected > 0) {
    return `Snoozed ${affected} ${taskWord(affected)}${list ? ` (${list} skipped)` : ''}`
  }
  if (!list) return 'No snoozable tasks'
  if (high === 0) {
    return `No snoozable tasks (${urgent} urgent ${taskWord(urgent)} must be snoozed individually)`
  }
  return `No snoozable tasks (${list} skipped)`
}
