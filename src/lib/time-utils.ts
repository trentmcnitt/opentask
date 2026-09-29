import { formatTime } from '@/lib/format-rrule'

/** Convert 12-hour time to 24-hour format. */
export function to24Hour(hour12: number, period: 'AM' | 'PM'): number {
  if (period === 'AM') return hour12 % 12
  return (hour12 % 12) + 12
}

/** Convert 24-hour time to 12-hour display value (1-12). */
export function to12Hour(hour24: number): number {
  return hour24 % 12 || 12
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/

/**
 * A stored 24-hour "HH:MM" as a 12-hour clock time: "07:00" → "7:00 AM",
 * "20:30" → "8:30 PM". Anything that isn't a valid HH:MM comes back unchanged,
 * so a bad value shows as itself rather than as "NaN:NaN".
 */
export function formatClockTime(hhmm: string): string {
  const match = HHMM.exec(hhmm)
  if (!match) return hhmm
  return formatTime(parseInt(match[1], 10), parseInt(match[2], 10))
}
