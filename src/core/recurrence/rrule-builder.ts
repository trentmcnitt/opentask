/**
 * RRULE string builder for OpenTask
 *
 * Generates RFC 5545 compliant RRULE strings with proper BYHOUR/BYMINUTE
 * for anti-drift recurrence computation.
 */

import { dowToRRuleDay } from './timezone'

export interface RRuleComponents {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'
  interval?: number
  byhour?: number
  byminute?: number
  byday?: number[] // 0=Mon..6=Sun
  bymonthday?: number | number[] // 1-31 or -1 for last day
  bysetpos?: number // For patterns like "last Friday" (-1)
  /**
   * 1-12. A yearly rule's month(s): "every year on March 1st" is
   * FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=1. Until 2026-10-13 it was dropped here,
   * so that rule ran on the 1st of EVERY month.
   */
  bymonth?: number[]
  /** Set by parseRRule when COUNT or UNTIL is found in the input string */
  hasUnsupportedTerminator?: boolean
}

/**
 * Build an RRULE string from components
 */
export function buildRRule(components: RRuleComponents): string {
  const parts: string[] = [`FREQ=${components.freq}`]

  if (components.interval && components.interval > 1) {
    parts.push(`INTERVAL=${components.interval}`)
  }

  if (components.byday && components.byday.length > 0) {
    const days = components.byday.map(dowToRRuleDay).join(',')
    parts.push(`BYDAY=${days}`)
  }

  if (components.bymonth && components.bymonth.length > 0) {
    parts.push(`BYMONTH=${components.bymonth.join(',')}`)
  }

  if (components.bymonthday !== undefined) {
    if (Array.isArray(components.bymonthday)) {
      parts.push(`BYMONTHDAY=${components.bymonthday.join(',')}`)
    } else {
      parts.push(`BYMONTHDAY=${components.bymonthday}`)
    }
  }

  if (components.bysetpos !== undefined) {
    parts.push(`BYSETPOS=${components.bysetpos}`)
  }

  if (components.byhour !== undefined) {
    parts.push(`BYHOUR=${components.byhour}`)
  }

  if (components.byminute !== undefined) {
    parts.push(`BYMINUTE=${components.byminute}`)
  }

  return parts.join(';')
}

/**
 * Parse an RRULE string into components
 */
export function parseRRule(rrule: string): RRuleComponents {
  const parts = rrule.split(';')
  const result: RRuleComponents = { freq: 'DAILY' }

  for (const part of parts) {
    const [key, value] = part.split('=')

    switch (key.toUpperCase()) {
      case 'FREQ':
        result.freq = value.toUpperCase() as RRuleComponents['freq']
        break
      case 'INTERVAL':
        result.interval = parseInt(value, 10)
        break
      case 'BYHOUR':
        result.byhour = parseInt(value, 10)
        break
      case 'BYMINUTE':
        result.byminute = parseInt(value, 10)
        break
      case 'BYDAY': {
        const dayMap: Record<string, number> = {
          MO: 0,
          TU: 1,
          WE: 2,
          TH: 3,
          FR: 4,
          SA: 5,
          SU: 6,
        }
        // Handle both "MO,WE,FR" and "-1FR" (last Friday) formats
        const days = value.split(',').map((d) => {
          // Strip any numeric prefix (like -1 for "last")
          const dayCode = d.replace(/^-?\d*/, '').toUpperCase()
          return dayMap[dayCode]
        })
        result.byday = days.filter((d) => d !== undefined)
        break
      }
      case 'BYMONTHDAY': {
        const monthdays = value.split(',').map((d) => parseInt(d, 10))
        result.bymonthday = monthdays.length === 1 ? monthdays[0] : monthdays
        break
      }
      case 'BYSETPOS':
        result.bysetpos = parseInt(value, 10)
        break
      case 'BYMONTH':
        result.bymonth = value.split(',').map((m) => parseInt(m, 10))
        break
      case 'COUNT':
      case 'UNTIL':
        // OpenTask does not support finite recurrence (COUNT/UNTIL). Flag so
        // isValidRRule can reject these rather than silently dropping them.
        result.hasUnsupportedTerminator = true
        break
    }
  }

  return result
}

/** BYMONTH in 1..12; BYMONTHDAY in -31..-1 or 1..31 (0 is invalid per RFC 5545). */
function monthFieldsValid(components: RRuleComponents): boolean {
  if (components.bymonth?.some((m) => !Number.isInteger(m) || m < 1 || m > 12)) return false
  if (components.bymonthday === undefined) return true
  const days = Array.isArray(components.bymonthday)
    ? components.bymonthday
    : [components.bymonthday]
  return !days.some((day) => day === 0 || day < -31 || day > 31)
}

/**
 * Validate parsed RRULE components against allowed ranges and semantic rules.
 *
 * Beyond range checks, enforces:
 * - FREQ=WEEKLY requires at least one BYDAY (without it, rrule.js takes the
 *   weekday from dtstart — the task's own day since 2026-10-12, the 2020
 *   epoch's Wednesday for a row with no date; the bare form is a quota's
 *   period rule, `isPeriodRRule`)
 * - FREQ=MONTHLY requires BYMONTHDAY or BYDAY (same dtstart default)
 * - BYMONTHDAY=0 is invalid per RFC 5545 (valid range: -31..-1, 1..31)
 * - BYMONTH must be 1..12
 * - INTERVAL capped at 365 to prevent effectively non-recurring tasks
 * - COUNT/UNTIL rejected (OpenTask only supports infinite recurrence)
 */
function validateComponents(components: RRuleComponents): boolean {
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(components.freq)) return false
  if (components.interval !== undefined && (components.interval < 1 || components.interval > 365))
    return false
  if (components.byhour !== undefined && (components.byhour < 0 || components.byhour > 23))
    return false
  if (components.byminute !== undefined && (components.byminute < 0 || components.byminute > 59))
    return false
  if (components.byday?.some((dow) => dow < 0 || dow > 6)) return false
  if (!monthFieldsValid(components)) return false

  // FREQ=WEEKLY requires BYDAY. Without it rrule.js takes the weekday from
  // dtstart: since 2026-10-12 that is the task's own day (its occurrence, or
  // the creation day — `phaseFloats` in compute-next.ts), but with no date at
  // all it is the 2020 epoch's Wednesday. The bare form stays a quota's period
  // rule (`isPeriodRRule`), refused on a task by validation; a task names its day.
  if (components.freq === 'WEEKLY' && (!components.byday || components.byday.length === 0))
    return false

  // FREQ=MONTHLY requires BYMONTHDAY or BYDAY — likewise (dtstart's day of month)
  if (
    components.freq === 'MONTHLY' &&
    components.bymonthday === undefined &&
    (!components.byday || components.byday.length === 0)
  )
    return false

  // Reject COUNT/UNTIL — OpenTask only supports infinite recurrence
  if (components.hasUnsupportedTerminator) return false

  return true
}

/**
 * Check if an RRULE string is valid
 */
export function isValidRRule(rrule: string): boolean {
  try {
    return validateComponents(parseRRule(rrule))
  } catch {
    return false
  }
}

/**
 * A quota's rule: FREQ and an optional INTERVAL, nothing else. It names the
 * period a count runs over ("this week", "this month"), not a day to occur
 * on — the §9 migration wrote these for every quota ("FREQ=WEEKLY" for
 * "2x/week"). Only valid on a tracked task; see validation.
 */
export function isPeriodRRule(rrule: string): boolean {
  return /^FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(;INTERVAL=([1-9]\d{0,2}))?$/i.test(rrule.trim())
}

/**
 * Common RRULE patterns for convenience
 */
export const RRulePatterns = {
  /**
   * Daily at a specific time
   */
  daily(hour: number, minute: number = 0): string {
    return buildRRule({ freq: 'DAILY', byhour: hour, byminute: minute })
  },

  /**
   * Weekly on specific days at a specific time
   * @param days Array of days (0=Mon..6=Sun)
   */
  weekly(days: number[], hour: number, minute: number = 0): string {
    return buildRRule({ freq: 'WEEKLY', byday: days, byhour: hour, byminute: minute })
  },

  /**
   * Every N weeks on specific days
   */
  everyNWeeks(interval: number, days: number[], hour: number, minute: number = 0): string {
    return buildRRule({ freq: 'WEEKLY', interval, byday: days, byhour: hour, byminute: minute })
  },

  /**
   * Monthly on a specific day of month
   * @param dayOfMonth 1-31, or -1 for last day
   */
  monthly(dayOfMonth: number, hour: number, minute: number = 0): string {
    return buildRRule({ freq: 'MONTHLY', bymonthday: dayOfMonth, byhour: hour, byminute: minute })
  },

  /**
   * Every N months on a specific day
   */
  everyNMonths(interval: number, dayOfMonth: number, hour: number, minute: number = 0): string {
    return buildRRule({
      freq: 'MONTHLY',
      interval,
      bymonthday: dayOfMonth,
      byhour: hour,
      byminute: minute,
    })
  },
}
