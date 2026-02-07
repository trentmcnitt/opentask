import { DateTime } from 'luxon'

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
    // Round up to the next hour boundary (matches existing behavior for 1h+ snoozes)
    const t = new Date(Date.now() + minutes * 60 * 1000)
    t.setMinutes(0, 0, 0)
    return t.toISOString()
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
