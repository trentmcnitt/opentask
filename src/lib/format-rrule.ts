/**
 * Human-readable RRULE formatting
 *
 * Converts RRULE strings like "FREQ=DAILY;BYHOUR=8;BYMINUTE=0"
 * into readable text like "Daily at 8:00 AM"
 */

import { ordinal } from '@/lib/quota-prompts'

const DAY_NAMES: Record<string, string> = {
  MO: 'Monday',
  TU: 'Tuesday',
  WE: 'Wednesday',
  TH: 'Thursday',
  FR: 'Friday',
  SA: 'Saturday',
  SU: 'Sunday',
}

const SHORT_DAY_NAMES: Record<string, string> = {
  MO: 'Mon',
  TU: 'Tue',
  WE: 'Wed',
  TH: 'Thu',
  FR: 'Fri',
  SA: 'Sat',
  SU: 'Sun',
}

export function formatTime(hour: number, minute: number): string {
  const period = hour >= 12 ? 'PM' : 'AM'
  const h = hour % 12 || 12
  const m = minute.toString().padStart(2, '0')
  return `${h}:${m} ${period}`
}

export function parseRRuleParts(rrule: string): Record<string, string> {
  const parts: Record<string, string> = {}
  // Remove RRULE: prefix if present
  const cleaned = rrule.replace(/^RRULE:/i, '')
  for (const part of cleaned.split(';')) {
    const [key, value] = part.split('=')
    if (key && value) {
      parts[key.toUpperCase()] = value
    }
  }
  return parts
}

interface ParsedRRule {
  freq: string | undefined
  interval: number
  byDay: string[]
  byMonthDay: number[]
  /** BYSETPOS ("last Friday" as BYDAY=FR;BYSETPOS=-1), or null. */
  setPos: number | null
  timeStr: string
}

function parseForFormat(rrule: string, anchorTime?: string | null): ParsedRRule {
  const parts = parseRRuleParts(rrule)
  const byHour = parts.BYHOUR ? parseInt(parts.BYHOUR) : null
  const byMinute = parts.BYMINUTE ? parseInt(parts.BYMINUTE) : null

  let timeStr = ''
  if (byHour !== null && byMinute !== null) {
    timeStr = ` at ${formatTime(byHour, byMinute)}`
  } else if (anchorTime) {
    const [h, m] = anchorTime.split(':').map(Number)
    if (!isNaN(h) && !isNaN(m)) {
      timeStr = ` at ${formatTime(h, m)}`
    }
  }

  return {
    freq: parts.FREQ?.toUpperCase(),
    interval: parts.INTERVAL ? parseInt(parts.INTERVAL) : 1,
    byDay: parts.BYDAY?.split(',') || [],
    byMonthDay: parts.BYMONTHDAY?.split(',').map(Number) || [],
    setPos: parts.BYSETPOS && /^[+-]?\d+$/.test(parts.BYSETPOS) ? parseInt(parts.BYSETPOS) : null,
    timeStr,
  }
}

function formatDaily(interval: number, timeStr: string): string {
  if (interval === 1) return `Daily${timeStr}`
  return `Every ${interval} days${timeStr}`
}

function formatWeekly(interval: number, byDay: string[], timeStr: string): string {
  const dayNames = byDay.map((d) => SHORT_DAY_NAMES[d.toUpperCase()] || d)
  const prefix = interval === 1 ? 'Weekly' : `Every ${interval} weeks`

  if (dayNames.length === 0) return `${prefix}${timeStr}`
  if (dayNames.length === 5 && !byDay.includes('SA') && !byDay.includes('SU')) {
    return `Weekdays${timeStr}`
  }
  if (dayNames.length === 2 && byDay.includes('SA') && byDay.includes('SU')) {
    return `Weekends${timeStr}`
  }
  if (dayNames.length === 1) {
    return `${prefix} on ${DAY_NAMES[byDay[0].toUpperCase()] || dayNames[0]}${timeStr}`
  }
  return `${prefix} on ${dayNames.join(', ')}${timeStr}`
}

/**
 * A monthly rule's day, with its position when it has one: "1SA" → "the 1st
 * Saturday", "-1FR" (or FR with BYSETPOS=-1) → "the last Friday", a bare
 * "SA" → "Saturday". The position is part of the rule — it used to be
 * dropped here, so "the 1st Saturday" read "Monthly on Sat" (2026-10-20).
 */
export function monthlyDay(
  token: string,
  setPos: number | null,
  names: Record<string, string> = SHORT_DAY_NAMES,
): string {
  const m = token.toUpperCase().match(/^([+-]?\d{1,2})?([A-Z]{2})$/)
  const code = m?.[2] ?? token.replace(/[^A-Z]/gi, '').toUpperCase()
  const name = names[code] || token
  const position = m?.[1] !== undefined ? parseInt(m[1]) : setPos
  if (position === null || position === 0) return name
  if (position === -1) return `the last ${name}`
  if (position < 0) return `the ${ordinal(-position)}-to-last ${name}`
  return `the ${ordinal(position)} ${name}`
}

/**
 * `monthlyDay` for a rule's whole BYDAY list: Monday to Friday with a
 * BYSETPOS is "the last weekday" / "the 1st weekday" of the month
 * (BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1), not "the last Monday"; anything else
 * is named by its first day, as before.
 */
function monthlyDays(byDay: string[], setPos: number | null, names: Record<string, string>) {
  const days = new Set(byDay.map((d) => d.toUpperCase()))
  const weekdays = ['MO', 'TU', 'WE', 'TH', 'FR']
  if (setPos !== null && setPos !== 0 && days.size === 5 && weekdays.every((d) => days.has(d))) {
    if (setPos === -1) return 'the last weekday'
    return setPos > 0 ? `the ${ordinal(setPos)} weekday` : `the ${ordinal(-setPos)}-to-last weekday`
  }
  return monthlyDay(byDay[0], setPos, names)
}

function formatMonthly(
  interval: number,
  byDay: string[],
  byMonthDay: number[],
  setPos: number | null,
  timeStr: string,
): string {
  const prefix = interval === 1 ? 'Monthly' : `Every ${interval} months`
  if (byMonthDay.length > 0) {
    const ordinals = byMonthDay.map(ordinal)
    return `${prefix} on the ${ordinals.join(', ')}${timeStr}`
  }
  if (byDay.length > 0) {
    return `${prefix} on ${monthlyDays(byDay, setPos, DAY_NAMES)}${timeStr}`
  }
  return `${prefix}${timeStr}`
}

function formatYearly(interval: number, timeStr: string): string {
  if (interval === 1) return `Yearly${timeStr}`
  return `Every ${interval} years${timeStr}`
}

/**
 * Convert an RRULE string to human-readable text
 */
export function formatRRule(rrule: string, anchorTime?: string | null): string {
  const { freq, interval, byDay, byMonthDay, setPos, timeStr } = parseForFormat(rrule, anchorTime)

  switch (freq) {
    case 'DAILY':
      return formatDaily(interval, timeStr)
    case 'WEEKLY':
      return formatWeekly(interval, byDay, timeStr)
    case 'MONTHLY':
      return formatMonthly(interval, byDay, byMonthDay, setPos, timeStr)
    case 'YEARLY':
      return formatYearly(interval, timeStr)
    default:
      return rrule
  }
}

const COMPACT_DAY_NAMES: Record<string, string> = {
  MO: 'M',
  TU: 'Tu',
  WE: 'W',
  TH: 'Th',
  FR: 'F',
  SA: 'Sa',
  SU: 'Su',
}

const PLURAL_DAY_NAMES: Record<string, string> = {
  MO: 'Mondays',
  TU: 'Tuesdays',
  WE: 'Wednesdays',
  TH: 'Thursdays',
  FR: 'Fridays',
  SA: 'Saturdays',
  SU: 'Sundays',
}

// ISO day ordering: Monday=0 through Sunday=6
const DAY_ORDER: Record<string, number> = {
  MO: 0,
  TU: 1,
  WE: 2,
  TH: 3,
  FR: 4,
  SA: 5,
  SU: 6,
}

function formatDaysCompact(byDay: string[]): string {
  const upper = byDay.map((d) => d.toUpperCase())

  // Sort by ISO index
  const sorted = [...upper].sort((a, b) => (DAY_ORDER[a] ?? 0) - (DAY_ORDER[b] ?? 0))

  // Special cases
  if (sorted.length === 7) return 'Daily'
  if (sorted.length === 5 && !sorted.includes('SA') && !sorted.includes('SU')) {
    return 'Weekdays'
  }
  if (sorted.length === 2 && sorted.includes('SA') && sorted.includes('SU')) {
    return 'Weekends'
  }

  return sorted.map((d) => COMPACT_DAY_NAMES[d] || d).join(', ')
}

/**
 * Compact RRULE formatting for TaskRow's second line.
 *
 * Uses single-letter day abbreviations (M, Tu, W, Th, F, Sa, Su).
 * Optionally includes time from anchorTime if provided.
 */
export function formatRRuleCompact(rrule: string, anchorTime?: string | null): string {
  const { freq, interval, byDay, byMonthDay, setPos, timeStr } = parseForFormat(rrule, anchorTime)

  switch (freq) {
    case 'DAILY':
      return formatDailyCompact(interval, timeStr)
    case 'WEEKLY':
      return formatWeeklyCompact(interval, byDay, timeStr)
    case 'MONTHLY':
      return formatMonthlyCompact(interval, byDay, byMonthDay, setPos, timeStr)
    case 'YEARLY':
      return formatYearlyCompact(interval, timeStr)
    default:
      return rrule
  }
}

function formatDailyCompact(interval: number, timeStr: string): string {
  const base = interval === 1 ? 'Daily' : `Every ${interval} days`
  return `${base}${timeStr}`
}

function formatWeeklyCompact(interval: number, byDay: string[], timeStr: string): string {
  if (byDay.length === 0) {
    const base = interval === 1 ? 'Weekly' : `Every ${interval} weeks`
    return `${base}${timeStr}`
  }

  const dayStr = formatDaysCompact(byDay)

  // "Daily", "Weekdays", "Weekends" are already complete
  if (dayStr === 'Daily' || dayStr === 'Weekdays' || dayStr === 'Weekends') {
    return `${dayStr}${timeStr}`
  }

  if (interval === 1) {
    // Single day weekly: use plural natural form ("Fridays")
    if (byDay.length === 1) {
      const base = PLURAL_DAY_NAMES[byDay[0].toUpperCase()] || dayStr
      return `${base}${timeStr}`
    }
    return `${dayStr}${timeStr}`
  }

  return `Every ${interval} weeks on ${dayStr}${timeStr}`
}

function formatMonthlyCompact(
  interval: number,
  byDay: string[],
  byMonthDay: number[],
  setPos: number | null,
  timeStr: string,
): string {
  const prefix = interval === 1 ? 'Monthly' : `Every ${interval} months`
  if (byMonthDay.length > 0) {
    return `${prefix} on the ${byMonthDay.map(ordinal).join(', ')}${timeStr}`
  }
  if (byDay.length > 0) {
    return `${prefix} on ${monthlyDays(byDay, setPos, SHORT_DAY_NAMES)}${timeStr}`
  }
  return `${prefix}${timeStr}`
}

function formatYearlyCompact(interval: number, timeStr: string): string {
  const base = interval === 1 ? 'Yearly' : `Every ${interval} years`
  return `${base}${timeStr}`
}

/**
 * Format recurrence for bulk mode display.
 *
 * Returns:
 * - null if no tasks have recurrence
 * - The compact rrule text (with time if all have same anchor_time) if all tasks have the same rrule
 * - '—' (em-dash) if tasks have different rrules
 */
export function formatBulkRecurrence(
  tasks: { rrule?: string | null; anchor_time?: string | null }[],
): string | null {
  const recurringTasks = tasks.filter((t) => t.rrule)
  if (recurringTasks.length === 0) return null

  const uniqueRrules = [...new Set(recurringTasks.map((t) => t.rrule))]
  if (uniqueRrules.length === 1) {
    // If all recurring tasks have the same anchor_time, include it
    const uniqueAnchorTimes = [...new Set(recurringTasks.map((t) => t.anchor_time))]
    const anchorTime = uniqueAnchorTimes.length === 1 ? uniqueAnchorTimes[0] : null
    return formatRRuleCompact(uniqueRrules[0]!, anchorTime)
  }
  return '—'
}

const END_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

/**
 * REPEAT ENDS (2026-10-22, docs/TASK-MODEL.md § Repeat ends): the end's
 * words — "6 times (2 left)", "until Dec 31" (the year added when it is not
 * this one) — or null with no end. Appended to a rule's words with " · "
 * (`withRepeatEnd`): "Weekly on Fri · 6 times (2 left)". `left` counts the
 * current occurrence.
 */
export function formatRepeatEnd(
  end: {
    repeat_count?: number | null
    repeat_count_used?: number | null
    repeat_until?: string | null
  },
  now: Date = new Date(),
): string | null {
  if (end.repeat_count != null) {
    const n = end.repeat_count
    const left = Math.max(0, n - (end.repeat_count_used ?? 0))
    return `${n} ${n === 1 ? 'time' : 'times'} (${left} left)`
  }
  if (end.repeat_until != null) {
    const [y, m, d] = end.repeat_until.split('-').map(Number)
    const year = y !== now.getFullYear() ? `, ${y}` : ''
    return `until ${END_MONTHS[m - 1]} ${d}${year}`
  }
  return null
}

/** A rule's words with its end, if any: "Weekly on Fri · until Dec 31". */
export function withRepeatEnd(text: string, end: Parameters<typeof formatRepeatEnd>[0]): string {
  const words = formatRepeatEnd(end)
  return words ? `${text} · ${words}` : text
}
