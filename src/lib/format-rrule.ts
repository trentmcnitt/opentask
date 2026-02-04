/**
 * Human-readable RRULE formatting
 *
 * Converts RRULE strings like "FREQ=DAILY;BYHOUR=8;BYMINUTE=0"
 * into readable text like "Daily at 8:00 AM"
 */

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

function formatTime(hour: number, minute: number): string {
  const period = hour >= 12 ? 'PM' : 'AM'
  const h = hour % 12 || 12
  const m = minute.toString().padStart(2, '0')
  return `${h}:${m} ${period}`
}

function parseRRuleParts(rrule: string): Record<string, string> {
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

function formatMonthly(
  interval: number,
  byDay: string[],
  byMonthDay: number[],
  timeStr: string,
): string {
  const prefix = interval === 1 ? 'Monthly' : `Every ${interval} months`
  if (byMonthDay.length > 0) {
    const ordinals = byMonthDay.map(ordinal)
    return `${prefix} on the ${ordinals.join(', ')}${timeStr}`
  }
  if (byDay.length > 0) {
    const dayName = DAY_NAMES[byDay[0].replace(/[^A-Z]/gi, '').toUpperCase()] || byDay[0]
    return `${prefix} on ${dayName}${timeStr}`
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
  const { freq, interval, byDay, byMonthDay, timeStr } = parseForFormat(rrule, anchorTime)

  switch (freq) {
    case 'DAILY':
      return formatDaily(interval, timeStr)
    case 'WEEKLY':
      return formatWeekly(interval, byDay, timeStr)
    case 'MONTHLY':
      return formatMonthly(interval, byDay, byMonthDay, timeStr)
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
 * Strips time info (time is already shown in the relative time portion).
 * Uses single-letter day abbreviations (M, Tu, W, Th, F, Sa, Su).
 */
export function formatRRuleCompact(rrule: string): string {
  const parts = parseRRuleParts(rrule)
  const freq = parts.FREQ?.toUpperCase()
  const interval = parts.INTERVAL ? parseInt(parts.INTERVAL) : 1
  const byDay = parts.BYDAY?.split(',') || []
  const byMonthDay = parts.BYMONTHDAY?.split(',').map(Number) || []

  switch (freq) {
    case 'DAILY':
      return formatDailyCompact(interval)
    case 'WEEKLY':
      return formatWeeklyCompact(interval, byDay)
    case 'MONTHLY':
      return formatMonthlyCompact(interval, byDay, byMonthDay)
    case 'YEARLY':
      return formatYearlyCompact(interval)
    default:
      return rrule
  }
}

function formatDailyCompact(interval: number): string {
  return interval === 1 ? 'Daily' : `Every ${interval} days`
}

function formatWeeklyCompact(interval: number, byDay: string[]): string {
  if (byDay.length === 0) {
    return interval === 1 ? 'Weekly' : `Every ${interval} weeks`
  }

  const dayStr = formatDaysCompact(byDay)

  // "Daily", "Weekdays", "Weekends" are already complete
  if (dayStr === 'Daily' || dayStr === 'Weekdays' || dayStr === 'Weekends') {
    return dayStr
  }

  if (interval === 1) {
    // Single day weekly: use plural natural form ("Fridays")
    if (byDay.length === 1) {
      return PLURAL_DAY_NAMES[byDay[0].toUpperCase()] || dayStr
    }
    return dayStr
  }

  return `Every ${interval} weeks on ${dayStr}`
}

function formatMonthlyCompact(interval: number, byDay: string[], byMonthDay: number[]): string {
  const prefix = interval === 1 ? 'Monthly' : `Every ${interval} months`
  if (byMonthDay.length > 0) {
    return `${prefix} on the ${byMonthDay.map(ordinal).join(', ')}`
  }
  if (byDay.length > 0) {
    const dayName = SHORT_DAY_NAMES[byDay[0].replace(/[^A-Z]/gi, '').toUpperCase()] || byDay[0]
    return `${prefix} on ${dayName}`
  }
  return prefix
}

function formatYearlyCompact(interval: number): string {
  return interval === 1 ? 'Yearly' : `Every ${interval} years`
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}

/**
 * Format recurrence for bulk mode display.
 *
 * Returns:
 * - null if no tasks have recurrence
 * - The compact rrule text if all tasks have the same rrule
 * - "mixed" if tasks have different rrules
 */
export function formatBulkRecurrence(tasks: { rrule?: string | null }[]): string | null {
  const rrules = tasks.map((t) => t.rrule).filter(Boolean) as string[]
  if (rrules.length === 0) return null

  const unique = [...new Set(rrules)]
  if (unique.length === 1) {
    return formatRRuleCompact(unique[0])
  }
  return 'mixed'
}
