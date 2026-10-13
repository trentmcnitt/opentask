/**
 * A repeating task's schedule in a few words — "every Wed", "daily at 9 AM",
 * "monthly on the 1st" — for the small words after an Upcoming row's target
 * ("Target Wed Oct 14 · every Wed"), where it replaced a bare "repeats"
 * (2026-10-12, Trent: "repeats" doesn't say when).
 *
 * THE SAME WORDS AS THE WIDGET AND WATCH. This is a port of the native
 * `RecurrenceSummary` (`ios/Shared/RecurrenceSummary.swift`), branch for
 * branch, so a repeating row reads the same on every surface; its tests
 * (`tests/behavioral/recurrence-summary.test.ts`) mirror the Swift ones. Change
 * both together.
 *
 * Why not `formatRRuleCompact`: that is the task row's line, written to stand
 * alone ("Wednesdays", "Every 2 weeks on M"). Mid-sentence after a date it
 * read badly, so this keeps a lower-case start, three-letter days, "every Wed"
 * rather than "Wednesdays", the monthly ordinal ("the 2nd Tue"), "the last
 * day", and "yearly on Mar 15". Times read "at 9 AM", "at 9:30 AM", "at noon",
 * "at midnight": BYHOUR/BYMINUTE win, else the task's `anchor_time`.
 *
 * Anything it can't read — no FREQ, HOURLY and finer, a day it doesn't know —
 * falls back to "repeats", never to the raw rule.
 */
import { parseRRuleParts } from '@/lib/format-rrule'

export const RECURRENCE_SUMMARY_FALLBACK = 'repeats'

const SHORT_DAYS: Record<string, string> = {
  MO: 'Mon',
  TU: 'Tue',
  WE: 'Wed',
  TH: 'Thu',
  FR: 'Fri',
  SA: 'Sat',
  SU: 'Sun',
}
const DAY_ORDER = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function recurrenceSummary(rrule: string | null | undefined, anchorTime?: string | null) {
  if (!rrule) return RECURRENCE_SUMMARY_FALLBACK
  return summary(rrule, anchorTime ?? null) ?? RECURRENCE_SUMMARY_FALLBACK
}

/** A whole-number value, or null (the Swift `Int(_:)`: no partial parses). */
function int(value: string | undefined): number | null {
  if (value === undefined || !/^[+-]?\d+$/.test(value.trim())) return null
  return Number(value)
}

function upperParts(rrule: string): Record<string, string> {
  const body = rrule.trim().replace(/^rrule:/i, '')
  const parts: Record<string, string> = {}
  for (const [key, value] of Object.entries(parseRRuleParts(body))) {
    if (key && value) parts[key.toUpperCase()] = value
  }
  return parts
}

function summary(rrule: string, anchorTime: string | null): string | null {
  const parts = upperParts(rrule)
  const freq = parts.FREQ?.toUpperCase()
  if (!freq) return null
  const interval = parts.INTERVAL === undefined ? 1 : int(parts.INTERVAL)
  if (interval === null || interval < 1) return null
  const byDay = parts.BYDAY ? parts.BYDAY.toUpperCase().split(',') : []
  const byMonthDay = parts.BYMONTHDAY
    ? parts.BYMONTHDAY.split(',')
        .map((d) => int(d))
        .filter((d): d is number => d !== null)
    : []
  const clockText = timeText(parts, anchorTime)
  const time = clockText ? ` at ${clockText}` : ''

  let base: string | null
  switch (freq) {
    case 'DAILY':
      base = interval === 1 ? 'daily' : `every ${interval} days`
      break
    case 'WEEKLY':
      base = weekly(interval, byDay)
      break
    case 'MONTHLY':
      base = monthly(interval, byDay, byMonthDay, int(parts.BYSETPOS))
      break
    case 'YEARLY':
      base = yearly(interval, int(parts.BYMONTH), byMonthDay)
      break
    default:
      base = null
  }
  return base === null ? null : base + time
}

function weekly(interval: number, byDay: string[]): string | null {
  const every = interval === 1 ? 'every' : `every ${interval} weeks on`
  if (byDay.length === 0) return interval === 1 ? 'weekly' : `every ${interval} weeks`
  if (!byDay.every((d) => SHORT_DAYS[d])) return null
  const days = new Set(byDay)
  const sorted = DAY_ORDER.filter((d) => days.has(d))
  const same = (set: string[]) => days.size === set.length && set.every((d) => days.has(d))
  if (sorted.length === 7) return interval === 1 ? 'daily' : `every ${interval} weeks, every day`
  if (same(['MO', 'TU', 'WE', 'TH', 'FR'])) return interval === 1 ? 'weekdays' : `${every} weekdays`
  if (same(['SA', 'SU'])) return interval === 1 ? 'weekends' : `${every} weekends`
  return `${every} ${sorted.map((d) => SHORT_DAYS[d]).join(', ')}`
}

function monthly(
  interval: number,
  byDay: string[],
  byMonthDay: number[],
  setPos: number | null,
): string | null {
  const prefix = interval === 1 ? 'monthly' : `every ${interval} months`
  if (byMonthDay.length > 0) {
    if (!byMonthDay.every((d) => (d >= 1 && d <= 31) || d === -1)) return null
    return `${prefix} on the ${byMonthDay.map((d) => (d === -1 ? 'last day' : ordinal(d))).join(', ')}`
  }
  const first = byDay[0]
  if (first) {
    // "2TU" / "-1FR", or a bare "TU" with BYSETPOS.
    const day = SHORT_DAYS[first.slice(-2)]
    if (!day) return null
    const lead = first.slice(0, -2)
    const position = lead ? int(lead) : setPos
    if (lead && position === null) return null
    if (position === null) return `${prefix} on ${day}`
    if (position === -1) return `${prefix} on the last ${day}`
    if (position >= 1 && position <= 5) return `${prefix} on the ${ordinal(position)} ${day}`
    return null
  }
  return prefix
}

function yearly(interval: number, byMonth: number | null, byMonthDay: number[]): string {
  const prefix = interval === 1 ? 'yearly' : `every ${interval} years`
  const day = byMonthDay[0]
  if (
    byMonth !== null &&
    byMonth >= 1 &&
    byMonth <= 12 &&
    day !== undefined &&
    day >= 1 &&
    day <= 31
  ) {
    return `${prefix} on ${MONTHS[byMonth - 1]} ${day}`
  }
  return prefix
}

/** BYHOUR (with BYMINUTE, or :00) wins, else the anchor time ("HH:MM"). */
function timeText(parts: Record<string, string>, anchorTime: string | null): string | null {
  const hourText = parts.BYHOUR
  if (hourText && !hourText.includes(',')) {
    const hour = int(hourText)
    if (hour !== null) {
      const minuteText = parts.BYMINUTE
      const minute = minuteText && !minuteText.includes(',') ? (int(minuteText) ?? 0) : 0
      return clock(hour, minute)
    }
  }
  if (anchorTime) {
    const [h, m] = anchorTime.split(':')
    const hour = int(h)
    const minute = int(m)
    if (hour !== null && minute !== null) return clock(hour, minute)
  }
  return null
}

/** "9 AM", "9:30 PM", "noon", "midnight". */
function clock(hour: number, minute: number): string | null {
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  if (minute === 0 && hour === 12) return 'noon'
  if (minute === 0 && hour === 0) return 'midnight'
  const h = hour % 12 === 0 ? 12 : hour % 12
  const suffix = hour < 12 ? 'AM' : 'PM'
  return minute === 0 ? `${h} ${suffix}` : `${h}:${String(minute).padStart(2, '0')} ${suffix}`
}

/** 1st, 2nd, 3rd, 4th, 11th, 21st. */
function ordinal(n: number): string {
  const tens = n % 100
  if (tens >= 11 && tens <= 13) return `${n}th`
  switch (n % 10) {
    case 1:
      return `${n}st`
    case 2:
      return `${n}nd`
    case 3:
      return `${n}rd`
    default:
      return `${n}th`
  }
}
