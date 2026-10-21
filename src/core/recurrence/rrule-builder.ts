/**
 * RRULE string builder for OpenTask
 *
 * Generates RFC 5545 compliant RRULE strings with proper BYHOUR/BYMINUTE
 * for anti-drift recurrence computation.
 */

import { RRule } from 'rrule'
import { dowToRRuleDay } from './timezone'

const DAY_CODES: Record<string, number> = { MO: 0, TU: 1, WE: 2, TH: 3, FR: 4, SA: 5, SU: 6 }

/** Plain weekdays (no ordinal) as BYDAY entries: [0, 2] → MO, WE. */
export function plainDays(days: number[]): ByDay[] {
  return days.map((day) => ({ day }))
}

/** The rule's weekdays (0=Mon..6=Sun), ordinals dropped; [] when it names none. */
export function bydayDows(components: RRuleComponents): number[] {
  return (components.byday ?? []).map((d) => d.day)
}

/** Whether any BYDAY entry carries an ordinal ("1SA", "-1FR"). */
export function hasOrdinalByday(components: RRuleComponents): boolean {
  return (components.byday ?? []).some((d) => d.n !== undefined)
}

/**
 * One BYDAY entry: the weekday (0=Mon..6=Sun) and, for a MONTHLY or YEARLY
 * rule, an optional ordinal — `1SA` is { day: 5, n: 1 } ("the 1st
 * Saturday"), `-1FR` is { day: 4, n: -1 } ("the last Friday"). A plain `SA`
 * has no `n`: every Saturday the rule's period has.
 *
 * THE ORDINAL IS PART OF THE RULE (2026-10-20). Until then parseRRule dropped
 * it (`1SA` → `SA`), so "monthly on the 1st Saturday" fired EVERY Saturday
 * (prev Oct 3 → next Oct 10). It is kept through parse → build → the engine
 * (`RRule.SA.nth(1)` in compute-next.ts); `bydayDows` gives the bare weekdays
 * for code that only asks "which weekdays".
 */
export interface ByDay {
  day: number
  n?: number
}

export interface RRuleComponents {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'
  interval?: number
  byhour?: number
  byminute?: number
  byday?: ByDay[]
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
    const days = components.byday
      .map((d) => `${d.n !== undefined ? d.n : ''}${dowToRRuleDay(d.day)}`)
      .join(',')
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
        // "MO,WE,FR", and the ordinal forms "1SA" (1st Saturday), "+2TU",
        // "-1FR" (last Friday) — the ordinal is kept (see ByDay). A token
        // that isn't a day is dropped, as before.
        const days: ByDay[] = []
        for (const token of value.split(',')) {
          const m = token.trim().match(/^([+-]?\d{1,2})?([A-Za-z]{2})$/)
          const day = m ? DAY_CODES[m[2].toUpperCase()] : undefined
          if (!m || day === undefined) continue
          days.push(m[1] !== undefined ? { day, n: parseInt(m[1], 10) } : { day })
        }
        result.byday = days
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
  if (days.some((day) => day === 0 || day < -31 || day > 31)) return false
  return daysFitMonths(days, components.bymonth)
}

/** The most days each month ever has (February: 29, a leap year's). */
const MONTH_MAX_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

/**
 * Every BYMONTHDAY exists in some month the rule names (2026-10-21, the
 * recurrence oracle): "the 31st" with BYMONTH=4 (or 6, 9, 11), or the 30th of
 * February, never happens. February 29 does (leap years). No BYMONTH: every
 * month, so any day 1–31 exists in some.
 */
function daysFitMonths(days: number[], months: number[] | undefined): boolean {
  if (!months || months.length === 0) return true
  const longest = Math.max(...months.map((m) => MONTH_MAX_DAYS[m - 1]))
  return days.every((day) => Math.abs(day) <= longest)
}

/**
 * Whether the rule ever occurs (2026-10-21): one rrule.js probe for the first
 * occurrence from the start of this year. Null means it never does in the
 * years rrule.js searches — "the 31st of September", or a Thursday that must
 * also be one the months never have — and such a rule is refused, never
 * stored (`computeNextOccurrence` would have no date to give).
 */
function everOccurs(rrule: string): boolean {
  const start = new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1))
  try {
    const rule = new RRule({ ...RRule.parseString(rrule), dtstart: start })
    return rule.after(start, true) !== null
  } catch {
    // A form rrule.js's own parser doesn't take: the field checks above stand.
    return true
  }
}

/**
 * Every BYDAY weekday is 0..6, and an ordinal ("1SA", "-1FR") on a MONTHLY or
 * YEARLY rule is 1..5 / -5..-1 of a month, 1..53 / -53..-1 of a year — never
 * 0. An ordinal on a WEEKLY or DAILY rule means nothing (RFC 5545 §3.3.10
 * forbids it; rrule.js ignores it) but is NOT refused: such rules were
 * accepted before 2026-10-20, so an API client, a Shortcut or an old native
 * build may echo one back. They are accepted and stored without it —
 * `normalizeRRule`.
 */
function bydayValid(components: RRuleComponents): boolean {
  if (components.byday?.some((d) => d.day < 0 || d.day > 6)) return false
  if (!ordinalsCount(components)) return true
  const max = components.freq === 'MONTHLY' ? 5 : 53
  return (components.byday ?? []).every(
    (d) => d.n === undefined || (d.n !== 0 && Math.abs(d.n) <= max),
  )
}

/** Whether the rule's BYDAY ordinals mean anything: a MONTHLY or YEARLY rule with one. */
export function ordinalsCount(components: RRuleComponents): boolean {
  return (
    (components.freq === 'MONTHLY' || components.freq === 'YEARLY') && hasOrdinalByday(components)
  )
}

/**
 * The rule as it is stored: a WEEKLY or DAILY rule's BYDAY ordinals dropped
 * ("FREQ=WEEKLY;BYDAY=1FR" → "FREQ=WEEKLY;BYDAY=FR" — what it always ran as).
 * Every other rule comes back exactly as given, so a valid rule never changes
 * shape. Applied by input validation and to AI enrichment's rule.
 */
export function normalizeRRule(rrule: string): string {
  const components = parseRRule(rrule)
  if (components.freq !== 'WEEKLY' && components.freq !== 'DAILY') return rrule
  if (!hasOrdinalByday(components)) return rrule
  return rrule
    .split(';')
    .map((part) =>
      /^BYDAY=/i.test(part)
        ? part.replace(/(^BYDAY=|,)[+-]?\d{1,2}(?=[A-Za-z]{2}(,|$))/gi, '$1')
        : part,
    )
    .join(';')
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
 * - a BYDAY ordinal only on MONTHLY/YEARLY, never 0 (`bydayValid`)
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
  if (!bydayValid(components)) return false
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
    return validateComponents(parseRRule(rrule)) && everOccurs(rrule)
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
    return buildRRule({ freq: 'WEEKLY', byday: plainDays(days), byhour: hour, byminute: minute })
  },

  /**
   * Every N weeks on specific days
   */
  everyNWeeks(interval: number, days: number[], hour: number, minute: number = 0): string {
    return buildRRule({
      freq: 'WEEKLY',
      interval,
      byday: plainDays(days),
      byhour: hour,
      byminute: minute,
    })
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
