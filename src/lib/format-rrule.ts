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

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}
