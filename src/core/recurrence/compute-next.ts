/**
 * Recurrence computation engine for OpenTask
 *
 * THE core algorithm: given a task with an RRULE, compute the next occurrence.
 *
 * Key insight: rrule.js BYHOUR operates in UTC, which doesn't work for local-time
 * recurring patterns. Instead, we:
 * 1. Don't use BYHOUR/BYMINUTE in the RRule
 * 2. Set DTSTART with the local time (as a "naive" Date)
 * 3. Convert input/output between timezone-aware and "naive local"
 *
 * This "naive local" approach treats JavaScript Date objects as timezone-naive,
 * using their local time methods (getHours(), etc.) rather than UTC methods.
 */

import { RRule, Weekday } from 'rrule'
import { DateTime } from 'luxon'
import { parseRRule } from './rrule-builder'
import { parseAnchorTime } from './timezone'
import { toNaiveLocal, fromNaiveLocal } from './utils'

// Map our DOW (0=Mon..6=Sun) to rrule.js Weekday constants
const DOW_TO_RRULE_WEEKDAY: Weekday[] = [
  RRule.MO,
  RRule.TU,
  RRule.WE,
  RRule.TH,
  RRule.FR,
  RRule.SA,
  RRule.SU,
]

/**
 * Frequency string to RRule constant
 */
const FREQ_MAP: Record<string, number> = {
  DAILY: RRule.DAILY,
  WEEKLY: RRule.WEEKLY,
  MONTHLY: RRule.MONTHLY,
  YEARLY: RRule.YEARLY,
}

export interface ComputeNextOptions {
  rrule: string
  recurrenceMode: 'from_due' | 'from_completion'
  anchorTime: string | null
  timezone: string
  completedAt: Date
}

/**
 * Compute the next occurrence of a recurring task.
 *
 * For 'from_due' mode:
 * - Uses rrule.after(completedAt) to find the next occurrence in the pattern
 * - The pattern time comes from DTSTART (set via anchor_time)
 *
 * For 'from_completion' mode:
 * - Computes interval from completion time
 * - Snaps to anchor_time
 */
export function computeNextOccurrence(options: ComputeNextOptions): Date {
  const { rrule, recurrenceMode, anchorTime, timezone, completedAt } = options

  if (recurrenceMode === 'from_completion') {
    return computeFromCompletion(rrule, anchorTime, timezone, completedAt)
  }

  return computeFromDue(rrule, anchorTime, timezone, completedAt)
}

/**
 * Compute next occurrence for 'from_due' mode (default)
 *
 * This is the standard recurrence: "Every Monday at 9 AM" means the next Monday
 * at 9 AM, regardless of when the task was completed.
 */
function computeFromDue(
  rruleStr: string,
  anchorTime: string | null,
  timezone: string,
  completedAt: Date
): Date {
  const components = parseRRule(rruleStr)

  // Get anchor time (local hour/minute)
  let hour = 0
  let minute = 0
  if (anchorTime) {
    const parsed = parseAnchorTime(anchorTime)
    hour = parsed.hour
    minute = parsed.minute
  } else if (components.byhour !== undefined) {
    hour = components.byhour
    minute = components.byminute ?? 0
  }

  // Create DTSTART in "naive local" format with the anchor time
  // We use a date far in the past as the epoch of this pattern
  const dtstart = new Date(2020, 0, 1, hour, minute, 0, 0)

  // Build RRule options - NO BYHOUR/BYMINUTE, time comes from dtstart
  const ruleOptions: Partial<InstanceType<typeof RRule>['options']> = {
    freq: FREQ_MAP[components.freq],
    interval: components.interval || 1,
    dtstart,
  }

  // Add day-of-week for weekly patterns
  if (components.byday && components.byday.length > 0) {
    // Cast to any to work around rrule.js type inconsistency
    // The Weekday type from RRule is compatible but TypeScript doesn't recognize it
    ruleOptions.byweekday = components.byday.map((dow) => DOW_TO_RRULE_WEEKDAY[dow]) as unknown as number[]
  }

  // Add day-of-month for monthly patterns
  if (components.bymonthday !== undefined) {
    const monthdays = Array.isArray(components.bymonthday)
      ? components.bymonthday
      : [components.bymonthday]
    ruleOptions.bymonthday = monthdays
  }

  // Add BYSETPOS for patterns like "last Friday"
  if (components.bysetpos !== undefined) {
    ruleOptions.bysetpos = [components.bysetpos]
  }

  const rule = new RRule(ruleOptions)

  // Convert completedAt to "naive local" in the user's timezone
  const completedDt = DateTime.fromJSDate(completedAt).setZone(timezone)
  const completedNaive = toNaiveLocal(completedDt)

  // Get the next occurrence (in "naive local")
  const nextNaive = rule.after(completedNaive, false)

  if (!nextNaive) {
    // Fallback: shouldn't happen for infinite rules
    // Return tomorrow at anchor time
    const tomorrow = completedDt.plus({ days: 1 }).set({ hour, minute, second: 0, millisecond: 0 })
    return tomorrow.toJSDate()
  }

  // Convert back to timezone-aware DateTime
  let nextDt = fromNaiveLocal(nextNaive, timezone)

  // DST fix: rrule.js works in UTC, so when DST changes between dtstart and the
  // result date, the local hour shifts. Force the hour to match the anchor time.
  if (nextDt.hour !== hour) {
    nextDt = nextDt.set({ hour, minute, second: 0, millisecond: 0 })
  }

  return nextDt.toJSDate()
}

/**
 * Compute next occurrence for 'from_completion' mode
 *
 * The date advances from the completion moment by the interval,
 * but the time snaps to anchor_time.
 *
 * Example: "7 days after last completion" - if completed Wednesday 2pm,
 * next = next Wednesday at anchor_time (e.g., 9am)
 */
function computeFromCompletion(
  rruleStr: string,
  anchorTime: string | null,
  timezone: string,
  completedAt: Date
): Date {
  const components = parseRRule(rruleStr)
  const completedDt = DateTime.fromJSDate(completedAt).setZone(timezone)

  // Get anchor time for snapping
  let hour = 0
  let minute = 0
  if (anchorTime) {
    const parsed = parseAnchorTime(anchorTime)
    hour = parsed.hour
    minute = parsed.minute
  } else if (components.byhour !== undefined) {
    hour = components.byhour
    minute = components.byminute ?? 0
  }

  const interval = components.interval || 1
  let nextDt: DateTime

  switch (components.freq) {
    case 'DAILY':
      nextDt = completedDt.plus({ days: interval })
      break
    case 'WEEKLY':
      nextDt = completedDt.plus({ weeks: interval })
      break
    case 'MONTHLY':
      nextDt = completedDt.plus({ months: interval })
      break
    case 'YEARLY':
      nextDt = completedDt.plus({ years: interval })
      break
    default:
      nextDt = completedDt.plus({ days: 1 })
  }

  // Snap to anchor time
  nextDt = nextDt.set({ hour, minute, second: 0, millisecond: 0 })

  return nextDt.toJSDate()
}

/**
 * Check if a task is recurring
 */
export function isRecurring(rrule: string | null): boolean {
  return rrule !== null && rrule.length > 0
}

/**
 * Compute the first occurrence of a recurring task from now
 * Used when creating a new recurring task without an explicit due_at
 */
export function computeFirstOccurrence(
  rruleStr: string,
  anchorTime: string | null,
  timezone: string
): Date {
  return computeFromDue(rruleStr, anchorTime, timezone, new Date())
}
