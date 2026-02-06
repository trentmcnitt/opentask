/**
 * Client-side recurrence preview computation
 *
 * This mirrors the server-side "naive local" approach from compute-next.ts.
 * The key insight: rrule.js BYHOUR operates in UTC, which doesn't work for
 * local-time recurring patterns. Instead, we:
 * 1. Extract BYHOUR/BYMINUTE from the RRULE (treating them as local time)
 * 2. Set DTSTART with the anchor time (as a "naive" Date)
 * 3. Don't pass BYHOUR/BYMINUTE to the RRule (time comes from dtstart)
 * 4. Convert between timezone-aware and "naive local" for correct results
 */

import { RRule } from 'rrule'
import { DateTime } from 'luxon'
import { parseRRuleParts } from './format-rrule'

/**
 * Parse RRULE components from a string
 */
interface RRuleComponents {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'
  interval?: number
  byhour?: number
  byminute?: number
  byday?: number[] // 0=Mon..6=Sun
  bymonthday?: number
  bysetpos?: number
}

function parseRRuleComponents(rrule: string): RRuleComponents {
  const parts = parseRRuleParts(rrule)
  const result: RRuleComponents = {
    freq: (parts.FREQ?.toUpperCase() as RRuleComponents['freq']) || 'DAILY',
  }

  if (parts.INTERVAL) result.interval = parseInt(parts.INTERVAL, 10)
  if (parts.BYHOUR) result.byhour = parseInt(parts.BYHOUR, 10)
  if (parts.BYMINUTE) result.byminute = parseInt(parts.BYMINUTE, 10)
  if (parts.BYSETPOS) result.bysetpos = parseInt(parts.BYSETPOS, 10)

  if (parts.BYDAY) {
    const dayMap: Record<string, number> = {
      MO: 0,
      TU: 1,
      WE: 2,
      TH: 3,
      FR: 4,
      SA: 5,
      SU: 6,
    }
    const days = parts.BYDAY.split(',').map((d) => {
      const dayCode = d.replace(/^-?\d*/, '').toUpperCase()
      return dayMap[dayCode]
    })
    result.byday = days.filter((d) => d !== undefined)
  }

  if (parts.BYMONTHDAY) {
    const monthdays = parts.BYMONTHDAY.split(',').map((d) => parseInt(d, 10))
    result.bymonthday = monthdays[0]
  }

  return result
}

// Map our DOW (0=Mon..6=Sun) to rrule.js Weekday constants
const DOW_TO_RRULE_WEEKDAY = [RRule.MO, RRule.TU, RRule.WE, RRule.TH, RRule.FR, RRule.SA, RRule.SU]

const FREQ_MAP: Record<string, number> = {
  DAILY: RRule.DAILY,
  WEEKLY: RRule.WEEKLY,
  MONTHLY: RRule.MONTHLY,
  YEARLY: RRule.YEARLY,
}

/**
 * Convert a timezone-aware DateTime to a "naive local" Date.
 * The resulting Date's local methods (getHours, etc.) return the original local time values.
 */
function toNaiveLocal(dt: DateTime): Date {
  return new Date(dt.year, dt.month - 1, dt.day, dt.hour, dt.minute, dt.second, dt.millisecond)
}

/**
 * Convert a "naive local" Date to a timezone-aware DateTime.
 * Treats the Date's local time values as being in the specified timezone.
 */
function fromNaiveLocal(d: Date, timezone: string): DateTime {
  return DateTime.fromObject(
    {
      year: d.getFullYear(),
      month: d.getMonth() + 1,
      day: d.getDate(),
      hour: d.getHours(),
      minute: d.getMinutes(),
      second: d.getSeconds(),
      millisecond: d.getMilliseconds(),
    },
    { zone: timezone },
  )
}

/**
 * Compute the next occurrence for a recurrence preview.
 *
 * This uses the same "naive local" approach as the server to ensure
 * the preview matches what the server will compute when the task is saved.
 *
 * @param rruleStr The RRULE string (e.g., "FREQ=DAILY;BYHOUR=9;BYMINUTE=0")
 * @param timezone The user's IANA timezone (e.g., "America/Chicago")
 * @returns ISO string of the next occurrence, or null if unable to compute
 */
export function computeRecurrencePreview(rruleStr: string, timezone: string): string | null {
  try {
    const components = parseRRuleComponents(rruleStr)

    // Get anchor time (local hour/minute) from BYHOUR/BYMINUTE
    const hour = components.byhour ?? 0
    const minute = components.byminute ?? 0

    // Create DTSTART in "naive local" format with the anchor time
    // Use a date far in the past as the epoch of this pattern
    const dtstart = new Date(2020, 0, 1, hour, minute, 0, 0)

    // Build RRule options - NO BYHOUR/BYMINUTE, time comes from dtstart
    const ruleOptions: Partial<InstanceType<typeof RRule>['options']> = {
      freq: FREQ_MAP[components.freq],
      interval: components.interval || 1,
      dtstart,
    }

    // Add day-of-week for weekly patterns
    if (components.byday && components.byday.length > 0) {
      ruleOptions.byweekday = components.byday.map(
        (dow) => DOW_TO_RRULE_WEEKDAY[dow],
      ) as unknown as number[]
    }

    // Add day-of-month for monthly patterns
    if (components.bymonthday !== undefined) {
      ruleOptions.bymonthday = [components.bymonthday]
    }

    // Add BYSETPOS for patterns like "last Friday"
    if (components.bysetpos !== undefined) {
      ruleOptions.bysetpos = [components.bysetpos]
    }

    const rule = new RRule(ruleOptions)

    // Get "now" in user's timezone as naive local
    const nowDt = DateTime.now().setZone(timezone)
    const nowNaive = toNaiveLocal(nowDt)

    // Get the next occurrence (in "naive local")
    const nextNaive = rule.after(nowNaive, false)
    if (!nextNaive) return null

    // Convert back to timezone-aware DateTime
    let nextDt = fromNaiveLocal(nextNaive, timezone)

    // DST fix: force the hour to match the anchor time
    if (nextDt.hour !== hour) {
      nextDt = nextDt.set({ hour, minute, second: 0, millisecond: 0 })
    }

    return nextDt.toISO()
  } catch {
    // Invalid rrule - don't show preview
    return null
  }
}
