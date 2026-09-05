/**
 * A reminder's schedule, in the two terms a reminder actually has
 * (REDESIGN-V03 §6): WHICH DAYS it comes up (cadence) and WHEN in the day
 * (its time slot). The task editor's full recurrence picker — intervals,
 * "schedule from completion", end conditions, a date grid, snooze — means
 * nothing for a thought, so the reminder editor speaks this vocabulary
 * instead and translates to and from the stored rrule here.
 *
 * Pure, so the browser can use it without dragging the server's rrule
 * evaluator along, and so the translation is testable on its own.
 *
 * WHAT IS PRESERVED: a rule the picker cannot express (an interval other than
 * 1, a yearly rule, several month days, BYSETPOS) is carried as `custom` and
 * written back verbatim except for its time of day, which the slot picker may
 * still replace. Switching such a reminder to one of the plain cadences
 * discards the custom rule — that is the user's edit, not a loss.
 *
 * WHAT IS ALWAYS WRITTEN: BYHOUR and BYMINUTE. A bare `FREQ=DAILY` is a
 * Track period rule (§5) and the validator refuses it on a reminder; more to
 * the point, a reminder without a time of day has no slot to appear in.
 */

import { DateTime } from 'luxon'
import { formatRRule, formatTime, parseRRuleParts } from '@/lib/format-rrule'
import { parseHHMM, type TimeSlot } from '@/lib/time-slot-assign'

export type ReminderCadence = 'daily' | 'weekly' | 'monthly' | 'once' | 'custom'

export interface ReminderSchedule {
  cadence: ReminderCadence
  /** Weekly only: 0 = Monday … 6 = Sunday, in that order. */
  days: number[]
  /** Monthly only. */
  monthDay: number | 'last'
  /** Minutes since local midnight, or null when the reminder has no time of day. */
  time: number | null
  /** The stored rule, kept verbatim while `cadence` is 'custom'. */
  custom: string | null
}

const RRULE_DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']

/** The subset of a task the schedule is read from. */
export interface ScheduledTask {
  rrule: string | null
  anchor_time: string | null
  due_at: string | null
}

/**
 * Where the reminder's time of day comes from, in order of trust: the stored
 * `anchor_time` (what the slot grouping itself uses), the rule's own
 * BYHOUR/BYMINUTE, and finally the due date's local time — the only carrier a
 * one-time reminder has.
 */
export function timeOfDay(task: ScheduledTask, timezone: string): number | null {
  if (task.anchor_time) {
    const parsed = parseHHMM(task.anchor_time)
    if (parsed !== null) return parsed
  }
  if (task.rrule) {
    const parts = parseRRuleParts(task.rrule)
    if (parts.BYHOUR !== undefined) {
      const hour = parseInt(parts.BYHOUR, 10)
      const minute = parts.BYMINUTE !== undefined ? parseInt(parts.BYMINUTE, 10) : 0
      if (!Number.isNaN(hour) && !Number.isNaN(minute)) return hour * 60 + minute
    }
  }
  if (task.due_at) {
    const local = DateTime.fromISO(task.due_at, { zone: 'utc' }).setZone(timezone)
    if (local.isValid) return local.hour * 60 + local.minute
  }
  return null
}

export function readSchedule(task: ScheduledTask, timezone: string): ReminderSchedule {
  const time = timeOfDay(task, timezone)
  const base: ReminderSchedule = { cadence: 'once', days: [], monthDay: 1, time, custom: null }
  if (!task.rrule) return base

  const parts = parseRRuleParts(task.rrule)
  const interval = parts.INTERVAL !== undefined ? parseInt(parts.INTERVAL, 10) : 1
  const plain =
    interval === 1 &&
    parts.COUNT === undefined &&
    parts.UNTIL === undefined &&
    parts.BYSETPOS === undefined

  if (plain && parts.FREQ === 'DAILY' && !parts.BYDAY && !parts.BYMONTHDAY) {
    return { ...base, cadence: 'daily' }
  }
  if (plain && parts.FREQ === 'WEEKLY' && parts.BYDAY && !parts.BYMONTHDAY) {
    const days = parts.BYDAY.split(',')
      .map((d) => RRULE_DAYS.indexOf(d.replace(/^-?\d*/, '').toUpperCase()))
      .filter((d) => d >= 0)
      .sort((a, b) => a - b)
    if (days.length > 0) return { ...base, cadence: 'weekly', days }
  }
  if (plain && parts.FREQ === 'MONTHLY' && parts.BYMONTHDAY && !parts.BYDAY) {
    const monthDays = parts.BYMONTHDAY.split(',')
    if (monthDays.length === 1) {
      const day = parseInt(monthDays[0], 10)
      if (day === -1) return { ...base, cadence: 'monthly', monthDay: 'last' }
      if (day >= 1 && day <= 31) return { ...base, cadence: 'monthly', monthDay: day }
    }
  }
  return { ...base, cadence: 'custom', custom: task.rrule }
}

/**
 * The rule to store for a schedule, or null for a one-time reminder.
 * Throws if a repeating schedule has no time of day — the editor never lets
 * that reach Save, so hitting it is a bug, not a user error.
 */
export function buildSchedule(schedule: ReminderSchedule): string | null {
  if (schedule.cadence === 'once') return null
  if (schedule.time === null) {
    throw new Error('A repeating reminder needs a time of day')
  }
  const hour = Math.floor(schedule.time / 60)
  const minute = schedule.time % 60
  const timePart = `BYHOUR=${hour};BYMINUTE=${minute}`

  switch (schedule.cadence) {
    case 'daily':
      return `FREQ=DAILY;${timePart}`
    case 'weekly': {
      const days = [...new Set(schedule.days)]
        .filter((d) => d >= 0 && d <= 6)
        .sort((a, b) => a - b)
        .map((d) => RRULE_DAYS[d])
      return `FREQ=WEEKLY;BYDAY=${days.join(',')};${timePart}`
    }
    case 'monthly':
      return `FREQ=MONTHLY;BYMONTHDAY=${schedule.monthDay === 'last' ? -1 : schedule.monthDay};${timePart}`
    case 'custom': {
      const kept = (schedule.custom ?? 'FREQ=DAILY')
        .split(';')
        .filter((part) => !/^BY(HOUR|MINUTE)=/i.test(part))
      return [...kept, timePart].join(';')
    }
  }
}

/** Whether Save should be allowed: a weekly schedule needs at least one day. */
export function isCompleteSchedule(schedule: ReminderSchedule): boolean {
  if (schedule.cadence === 'once') return true
  if (schedule.time === null) return false
  if (schedule.cadence === 'weekly') return schedule.days.length > 0
  return true
}

export function sameSchedule(a: ReminderSchedule, b: ReminderSchedule): boolean {
  if (a.cadence !== b.cadence) return false
  if (a.cadence === 'once') return true
  if (a.time !== b.time) return false
  switch (a.cadence) {
    case 'weekly':
      return a.days.length === b.days.length && a.days.every((d, i) => d === b.days[i])
    case 'monthly':
      return a.monthDay === b.monthDay
    case 'custom':
      return a.custom === b.custom
    default:
      return true
  }
}

/** The slot a time of day falls in: the latest slot boundary at or before it. */
export function slotAtMinutes(minutes: number | null, slots: TimeSlot[]): TimeSlot | null {
  if (minutes === null) return null
  let best: TimeSlot | null = null
  let bestStart = -1
  for (const slot of slots) {
    const start = parseHHMM(slot.start_time)
    if (start === null || start > minutes || start <= bestStart) continue
    bestStart = start
    best = slot
  }
  return best
}

export function formatMinutes(minutes: number): string {
  return formatTime(Math.floor(minutes / 60), minutes % 60)
}

const LONG_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const SHORT_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}

/** "Every day", "Weekdays", "Mon, Wed, Fri", "Monthly on the 1st", "Once". */
export function describeCadence(schedule: ReminderSchedule): string {
  switch (schedule.cadence) {
    case 'once':
      return 'Once'
    case 'daily':
      return 'Every day'
    case 'weekly': {
      const days = [...schedule.days].sort((a, b) => a - b)
      if (days.length === 0) return 'Weekly'
      if (days.length === 7) return 'Every day'
      if (days.length === 5 && !days.includes(5) && !days.includes(6)) return 'Weekdays'
      if (days.length === 2 && days.includes(5) && days.includes(6)) return 'Weekends'
      if (days.length === 1) return `${LONG_DAYS[days[0]]}s`
      return days.map((d) => SHORT_DAYS[d]).join(', ')
    }
    case 'monthly':
      return schedule.monthDay === 'last'
        ? 'Monthly on the last day'
        : `Monthly on the ${ordinal(schedule.monthDay)}`
    case 'custom': {
      const withoutTime = (schedule.custom ?? '')
        .split(';')
        .filter((part) => !/^BY(HOUR|MINUTE)=/i.test(part))
        .join(';')
      return withoutTime ? formatRRule(withoutTime) : 'Custom'
    }
  }
}

/**
 * The time-of-day half of the summary: the slot's name when the reminder sits
 * on the slot's boundary, "Afternoon, 7:00 PM" when it sits inside one, the
 * bare time when it is earlier than every slot.
 */
export function describeTimeOfDay(minutes: number | null, slots: TimeSlot[]): string | null {
  if (minutes === null) return null
  const slot = slotAtMinutes(minutes, slots)
  if (!slot) return formatMinutes(minutes)
  if (parseHHMM(slot.start_time) === minutes) return slot.label
  return `${slot.label}, ${formatMinutes(minutes)}`
}
