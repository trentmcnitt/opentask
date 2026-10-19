import { DateTime } from 'luxon'
import { taskWord } from '@/lib/utils'
import { formatClockTime } from '@/lib/time-utils'
import type { BulkSnoozeDefault } from '@/lib/preferences-state'
import { nextPeriodStart } from '@/lib/time-slot-assign'

const HOUR_ROUND_THRESHOLD = 35

/** Snap a Date to the nearest hour: >=35 min rounds up, <35 truncates down. */
export function snapToHour(date: Date): Date {
  const result = new Date(date.getTime())
  const mins = result.getMinutes()
  result.setMinutes(0, 0, 0)
  if (mins >= HOUR_ROUND_THRESHOLD) {
    result.setHours(result.getHours() + 1)
  }
  return result
}

/**
 * Compute the UTC ISO string for a snooze target time.
 *
 * @param option - Snooze option: 'tomorrow', 'next_period', or a string-integer
 *   of minutes (e.g., '60', '120')
 * @param timezone - User's IANA timezone (e.g., 'America/Chicago')
 * @param morningTime - User's configured morning time in HH:MM format (e.g., '09:00')
 * @param slots - The user's periods, for 'next_period' (2026-10-10: the single-tap
 *   default can be the next period too). With none, 'next_period' reads as an hour.
 * @returns UTC ISO string for the snooze target
 */
export function computeSnoozeTime(
  option: string,
  timezone: string,
  morningTime: string,
  slots: { start_time: string }[] = [],
): string {
  if (option === 'tomorrow') {
    const [hour, minute] = morningTime.split(':').map(Number)
    return DateTime.now()
      .setZone(timezone)
      .plus({ days: 1 })
      .set({ hour, minute, second: 0, millisecond: 0 })
      .toUTC()
      .toISO()!
  }
  if (option === NEXT_PERIOD_OPTION) {
    // The next period still TODAY; with none left today, the top of the next
    // hour (spec amendment 17), not tomorrow's first period. The sweep's own
    // `slot: "next"` (Shortcuts) is resolved elsewhere and is unchanged.
    const next = nextPeriodStart(slots, timezone)
    const now = DateTime.now().setZone(timezone)
    if (next && DateTime.fromISO(next).setZone(timezone).hasSame(now, 'day')) return next
    return now.startOf('hour').plus({ hours: 1 }).toUTC().toISO()!
  }

  const minutes = parseInt(option, 10)
  if (minutes >= 60) {
    return snapToHour(new Date(Date.now() + minutes * 60 * 1000)).toISOString()
  }

  // Sub-hour: exact minutes from now
  return new Date(Date.now() + minutes * 60 * 1000).toISOString()
}

/**
 * When a task segment's "Target today" sets the target (spec §4) — the pure
 * half of `targetTodayTime` (`src/core/tasks/task-segments.ts`), here so the
 * client can open the Today button's time picker on the very moment a tap
 * would use (2026-10-12). Where the Snooze-all button goes
 * (`bulk_snooze_default` — the next period, or the default snooze option), as
 * long as that is still today; otherwise the top of the next hour.
 */
export function targetTodayTimeFor(
  prefs: {
    bulkSnoozeDefault: BulkSnoozeDefault | string
    defaultSnoozeOption: string
    morningTime: string
  },
  slots: { start_time: string }[],
  timezone: string,
  now: Date = new Date(),
): string {
  const local = DateTime.fromJSDate(now).setZone(timezone)
  let candidate: string | null = null
  if (prefs.bulkSnoozeDefault === 'default_option') {
    if (prefs.defaultSnoozeOption !== 'tomorrow') {
      candidate = computeSnoozeTime(prefs.defaultSnoozeOption, timezone, prefs.morningTime, slots)
    }
  } else {
    candidate = nextPeriodStart(slots, timezone, now)
  }
  if (candidate && DateTime.fromISO(candidate).setZone(timezone).hasSame(local, 'day')) {
    return candidate
  }
  return local.startOf('hour').plus({ hours: 1 }).toUTC().toISO()!
}

/** The `default_snooze_option` value meaning "the next period" (2026-10-10). */
export const NEXT_PERIOD_OPTION = 'next_period'

/**
 * Format a morning time string for display.
 * '09:00' -> '9:00 AM', '14:30' -> '2:30 PM'
 * `formatClockTime` under the name the snooze and AI-prompt callers use.
 */
export function formatMorningTime(morningTime: string): string {
  return formatClockTime(morningTime)
}

/**
 * Format a snooze option as a compact badge label.
 * '30' -> '+30m', '60' -> '+1h', '120' -> '+2h', 'tomorrow' -> 'AM'
 */
export function formatCompactSnoozeLabel(option: string): string {
  if (option === 'tomorrow') return 'AM'
  if (option === NEXT_PERIOD_OPTION) return 'Next'
  const minutes = parseInt(option, 10)
  if (minutes < 60) return `+${minutes}m`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (m === 0) return `+${h}h`
  return `+${h}h${m}m`
}

/**
 * The compact badge on the snooze-all clock: where a plain press sends the
 * overdue tasks. That is the next period when `bulkSnoozeDefault` says so and
 * the user has periods to go to (`useSnoozeOverdue` falls back to the default
 * option when there are none), otherwise the default option's own label.
 * Before this read both settings, the badge showed "+1h" while a press went to
 * the next period.
 */
export function bulkSnoozeCompactLabel(
  bulkSnoozeDefault: BulkSnoozeDefault,
  defaultSnoozeOption: string,
  hasPeriods: boolean,
): string {
  if (bulkSnoozeDefault === 'next_period' && hasPeriods) return 'Next'
  // The default option can be "next_period" as well; without periods
  // `computeSnoozeTime` reads it as an hour, so the badge does too.
  if (defaultSnoozeOption === NEXT_PERIOD_OPTION && !hasPeriods) return '+1h'
  return formatCompactSnoozeLabel(defaultSnoozeOption)
}

/**
 * Format a snooze option for display in settings / menus.
 * '30' -> '30 min', '60' -> '1 hour', '120' -> '2 hours', 'tomorrow' -> 'Tomorrow at 9:00 AM'
 */
export function formatSnoozeOptionLabel(option: string, morningTime: string): string {
  if (option === 'tomorrow') {
    return `Tomorrow at ${formatMorningTime(morningTime)}`
  }
  if (option === NEXT_PERIOD_OPTION) return 'Next period'
  const minutes = parseInt(option, 10)
  if (minutes < 60) return `${minutes} min`
  if (minutes === 60) return '1 hour'
  if (minutes % 60 === 0) return `${minutes / 60} hours`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${h}h ${m}m`
}

/** What a bulk sweep skipped on priority, split so a message can name it. */
export interface BulkSnoozeSkips {
  /** Tasks actually moved. */
  affected: number
  /** How many of those were High (P3). Optional: only the bulk press reports it. */
  highAffected?: number
  /** P3 skipped — deferred to the next sweep, because something lower was still eligible. */
  high: number
  /** P4 skipped — never bulk-snoozable at all. */
  urgent: number
  /**
   * Below High, held back like High because their deadline has passed
   * (Trent's ruling, 2026-10-12) — swept on the next press once nothing lower
   * is left. Named beside High: "(2 high, 1 past deadline skipped)".
   */
  deadline?: number
  /** Moved only as far as their deadline (§8.2). Counted in `affected` too. */
  capped?: number
  /*
   * THE TASK QUEUE (2026-10-19, OPENTASK_TASK_QUEUE). All optional and zero /
   * null by default, so with the switch off the line is exactly what it was.
   */
  /** Marked for the Tasks queue (a defer landing at or after the next rollover). In `affected`. */
  queued?: number
  /** The marked task's title, when exactly one was marked. */
  queuedName?: string | null
  /** When the rollover is, as the toast shows it ("6:30 AM"). Needed when `queued` > 0. */
  queueAt?: string
  /** The one task moved, when the press moved exactly one (spec rule 4: it is named). */
  singleName?: string | null
  /** The High moved by "one High per press" (B8), named. */
  highName?: string | null
  /** Repeating tasks a defer stopped at their next occurrence (B2). In `affected`. */
  cappedOccurrence?: number
}

/**
 * "2 high", "1 past deadline", "1 urgent", "2 high, 1 past deadline, 1 urgent".
 * Empty when nothing was skipped.
 */
function skipList(high: number, urgent: number, deadline = 0): string {
  const parts: string[] = []
  if (high > 0) parts.push(`${high} high`)
  if (deadline > 0) parts.push(`${deadline} past deadline`)
  if (urgent > 0) parts.push(`${urgent} urgent`)
  return parts.join(', ')
}

/**
 * The toast for a bulk "snooze all overdue" press.
 *
 * NAMES HIGH AND URGENT SEPARATELY, and this is the point of the function.
 * The message used to read "No snoozable tasks (4 urgent must be snoozed
 * individually)" for four tasks that were priority 3, High — none of them
 * Urgent. The count was right and the word was wrong, because the core's
 * internal `urgentSkipped` counts BOTH tiers (its name is frozen by the
 * `skipped_urgent` API field the iOS client reads) and that internal name
 * leaked into user-facing copy.
 *
 * "MUST BE SNOOZED INDIVIDUALLY" IS NOW ONLY SAID OF URGENT, because it is only
 * true of Urgent. High is swept on the next press once nothing lower is left
 * (see `filterForBulkSnooze`), so saying it of High would be telling the user
 * to do by hand the thing the next press does for them.
 *
 * A pure function so the copy can be tested without a browser.
 */
export function bulkSnoozeMessage(skips: BulkSnoozeSkips): string {
  const { high, urgent, deadline = 0, capped = 0, cappedOccurrence = 0 } = skips
  // A passed deadline is held back like High (Trent's ruling, 2026-10-12),
  // so it is named the way High is: "(2 high, 1 past deadline skipped)".
  const list = skipList(high, urgent, deadline)
  // The deadline cap is never silent (§8.2): the toast says which stopped at
  // a deadline still ahead. Nor is a defer's stop at a repeating task's next
  // occurrence (B2, task queue).
  const its = (n: number) => (n === 1 ? 'its' : 'their')
  const stopped =
    (capped > 0 ? ` · ${capped} stopped at ${its(capped)} deadline` : '') +
    (cappedOccurrence > 0
      ? ` · ${cappedOccurrence} stopped at ${its(cappedOccurrence)} next occurrence`
      : '')
  return bulkSnoozeCore(skips, list) + stopped
}

/**
 * The moved part of the line. With the task queue on, a press can do two
 * things at once, so it reads as one line of parts joined by " · ":
 *
 *   3 will move to the Tasks queue at 6:30 AM · Snoozed 2 tasks (1 urgent skipped)
 *   "Call the bank" will move to the Tasks queue at 6:30 AM
 *   Snoozed high-priority "Pay rent" (2 high skipped)
 *
 * Spec rule 4: the queued count says where they go and when; a press that
 * moved exactly one task names it; the one High moved (B8) is named. With
 * none of the queue fields (the switch off) this is the line it always was.
 */
function bulkSnoozeCore(skips: BulkSnoozeSkips, list: string): string {
  const { affected, high, urgent } = skips
  if (affected > 0) {
    const queued = skips.queued ?? 0
    const other = affected - queued
    const parts: string[] = []
    if (queued > 0) {
      const who = queued === 1 && skips.queuedName ? `"${skips.queuedName}"` : String(queued)
      parts.push(`${who} will move to the Tasks queue at ${skips.queueAt ?? 'the next rollover'}`)
    }
    if (other > 0) parts.push(snoozedPart(skips, other))
    return `${parts.join(' · ')}${list ? ` (${list} skipped)` : ''}`
  }
  if (!list) return 'No snoozable tasks'
  if (high === 0 && list === `${urgent} urgent`) {
    return `No snoozable tasks (${urgent} urgent ${taskWord(urgent)} must be snoozed individually)`
  }
  return `No snoozable tasks (${list} skipped)`
}

/** `Snoozed 3 tasks`, `Snoozed "Title"`, `Snoozed high-priority "Title"`. */
function snoozedPart(skips: BulkSnoozeSkips, other: number): string {
  const { affected, highAffected = 0, highName, singleName } = skips
  if (highName && other === 1) return `Snoozed high-priority "${highName}"`
  if (other === 1 && affected === 1 && singleName) return `Snoozed "${singleName}"`
  // "HIGH-PRIORITY" WHEN THAT IS ALL IT MOVED (Trent, 2026-09-22). High is
  // swept only once nothing lower is left, so a double snooze is two presses:
  // the first moves the ordinary tasks, the second the High ones left over.
  // Saying so is what makes the second press make sense.
  const what = highAffected === other ? `high-priority ${taskWord(other)}` : taskWord(other)
  const including =
    highName && highAffected !== other ? `, including high-priority "${highName}"` : ''
  return `Snoozed ${other} ${what}${including}`
}
