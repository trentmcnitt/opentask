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
    }
  }

  return result
}

/**
 * Check if an RRULE string is valid
 */
export function isValidRRule(rrule: string): boolean {
  try {
    const components = parseRRule(rrule)

    // Must have a frequency
    if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(components.freq)) {
      return false
    }

    // Interval must be positive if specified
    if (components.interval !== undefined && components.interval < 1) {
      return false
    }

    // Hour must be 0-23
    if (components.byhour !== undefined && (components.byhour < 0 || components.byhour > 23)) {
      return false
    }

    // Minute must be 0-59
    if (
      components.byminute !== undefined &&
      (components.byminute < 0 || components.byminute > 59)
    ) {
      return false
    }

    // Days of week must be 0-6
    if (components.byday) {
      for (const dow of components.byday) {
        if (dow < 0 || dow > 6) {
          return false
        }
      }
    }

    // Month day must be 1-31 or negative for "last"
    if (components.bymonthday !== undefined) {
      const days = Array.isArray(components.bymonthday)
        ? components.bymonthday
        : [components.bymonthday]
      for (const day of days) {
        if ((day < -31 || day > 31) && day !== 0) {
          return false
        }
      }
    }

    return true
  } catch {
    return false
  }
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
