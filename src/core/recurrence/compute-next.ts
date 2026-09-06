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

/**
 * The pattern's epoch. Fixed so that a rule's phase (which weeks an
 * every-other-week rule lands on, which months a quarterly one does) never
 * depends on when the task was created or last edited.
 */
const PATTERN_EPOCH_YEAR = 2020

/**
 * Advance the fixed epoch dtstart toward `ref` in whole periods of the rule.
 *
 * rrule.js finds `after(ref)` by iterating occurrences forward from dtstart,
 * so a DAILY rule anchored in 2020 walks ~2,500 days for every single "is this
 * due today?" question. With ~185 recurring rows that put ~2.3 s inside every
 * check-off (the badge recount) and ~0.8 s inside every reminders load, and the
 * same cost in the browser when the Today view groups by slot. Sliding dtstart
 * to a couple of periods before `ref` makes each call O(1) while leaving the
 * answer identical: shifting by an exact multiple of the interval keeps a
 * WEEKLY/INTERVAL=2 rule on the same weeks and a MONTHLY/INTERVAL=3 rule on the
 * same months. Weekly shifts move by whole weeks, so the epoch's weekday is
 * preserved too (rrule.js reads it when BYDAY is absent).
 *
 * Works in the same naive-UTC representation as dtstart itself, so no DST
 * arithmetic is involved.
 */
export function advanceDtstart(base: Date, freq: string, interval: number, ref: Date): Date {
  const n = Math.max(1, Math.floor(interval))
  // Leave at least two full periods of runway before `ref`, so rrule's
  // "strictly after" search sees the same neighbourhood it would have from 2020.
  const MARGIN = 2
  const hour = base.getUTCHours()
  const minute = base.getUTCMinutes()

  if (freq === 'DAILY' || freq === 'WEEKLY') {
    const periodMs = (freq === 'DAILY' ? 1 : 7) * n * 86_400_000
    const periods = Math.floor((ref.getTime() - base.getTime()) / periodMs) - MARGIN
    return periods > 0 ? new Date(base.getTime() + periods * periodMs) : base
  }
  if (freq === 'MONTHLY') {
    const months =
      (ref.getUTCFullYear() - base.getUTCFullYear()) * 12 + (ref.getUTCMonth() - base.getUTCMonth())
    const periods = Math.floor(months / n) - MARGIN
    if (periods <= 0) return base
    return new Date(
      Date.UTC(
        base.getUTCFullYear(),
        base.getUTCMonth() + periods * n,
        base.getUTCDate(),
        hour,
        minute,
      ),
    )
  }
  if (freq === 'YEARLY') {
    const periods = Math.floor((ref.getUTCFullYear() - base.getUTCFullYear()) / n) - MARGIN
    if (periods <= 0) return base
    return new Date(
      Date.UTC(
        base.getUTCFullYear() + periods * n,
        base.getUTCMonth(),
        base.getUTCDate(),
        hour,
        minute,
      ),
    )
  }
  return base
}

export interface ComputeNextOptions {
  rrule: string
  recurrenceMode: 'from_due' | 'from_completion'
  anchorTime: string | null
  timezone: string
  completedAt: Date
  /**
   * The task's current due_at (prior to this completion). Used by 'from_due' mode
   * to guarantee the next occurrence is strictly after the previous due — otherwise
   * completing a recurring task before its due date (or twice in quick succession)
   * can return the same occurrence and leave the task stuck.
   */
  prevDueAt?: Date | null
}

/**
 * Compute the next occurrence of a recurring task.
 *
 * For 'from_due' mode:
 * - Uses rrule.after(max(prevDueAt, completedAt)) to find the next occurrence
 * - The pattern time comes from DTSTART (set via anchor_time)
 *
 * For 'from_completion' mode:
 * - Computes interval from completion time
 * - Snaps to anchor_time
 */
export function computeNextOccurrence(options: ComputeNextOptions): Date {
  const { rrule, recurrenceMode, anchorTime, timezone, completedAt, prevDueAt } = options

  if (recurrenceMode === 'from_completion') {
    return computeFromCompletion(rrule, anchorTime, timezone, completedAt)
  }

  return computeFromDue(rrule, anchorTime, timezone, completedAt, prevDueAt ?? null)
}

/**
 * Compute next occurrence for 'from_due' mode (default)
 *
 * This is the standard recurrence: "Every Monday at 9 AM" means the next Monday
 * at 9 AM, regardless of when the task was completed.
 *
 * Reference point for "next" is max(prevDueAt, completedAt): if the user completes
 * before the current due (or re-completes the new occurrence immediately), we
 * advance from the previous due — not from "now" — so each completion moves the
 * task forward by one cycle.
 */
function computeFromDue(
  rruleStr: string,
  anchorTime: string | null,
  timezone: string,
  completedAt: Date,
  prevDueAt: Date | null,
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

  // Reference point: the later of prevDueAt and completedAt. This ensures the next
  // occurrence is strictly after the previous due, so completing early (or completing
  // the same recurring task twice in a row) always advances by one cycle.
  const completedDt = DateTime.fromJSDate(completedAt).setZone(timezone)
  const prevDueDt = prevDueAt ? DateTime.fromJSDate(prevDueAt).setZone(timezone) : null
  const refDt = prevDueDt && prevDueDt > completedDt ? prevDueDt : completedDt
  const refNaive = toNaiveLocal(refDt)

  // Create DTSTART in "naive" format (UTC slot) with the anchor time. Using
  // Date.UTC keeps the pattern independent of the server's local timezone —
  // critical on DST-observing hosts where new Date(2020,0,1,h,m) would carry
  // the winter UTC offset and drift from summer target dates. The epoch is then
  // slid forward toward the reference (see advanceDtstart) so rrule.js does not
  // iterate years of occurrences to answer a question about this week.
  const epoch = new Date(Date.UTC(PATTERN_EPOCH_YEAR, 0, 1, hour, minute, 0, 0))
  const dtstart = advanceDtstart(epoch, components.freq, components.interval || 1, refNaive)

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
    ruleOptions.byweekday = components.byday.map(
      (dow) => DOW_TO_RRULE_WEEKDAY[dow],
    ) as unknown as number[]
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

  // Get the next occurrence (in "naive local")
  const nextNaive = rule.after(refNaive, false)

  if (!nextNaive) {
    // Fallback: shouldn't happen for infinite rules
    // Return tomorrow at anchor time (relative to the reference, not completion)
    const tomorrow = refDt.plus({ days: 1 }).set({ hour, minute, second: 0, millisecond: 0 })
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
  completedAt: Date,
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
  timezone: string,
): Date {
  return computeFromDue(rruleStr, anchorTime, timezone, new Date(), null)
}
