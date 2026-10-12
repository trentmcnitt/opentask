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
  /** Left where they were: the sweep would have crossed their deadline (2026-10-10). */
  deadline?: number
}

/** "2 high", "1 urgent", "2 high, 1 urgent". Empty when nothing was skipped. */
function skipList(high: number, urgent: number): string {
  const parts: string[] = []
  if (high > 0) parts.push(`${high} high`)
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
export function bulkSnoozeMessage({
  affected,
  highAffected = 0,
  high,
  urgent,
  deadline = 0,
}: BulkSnoozeSkips): string {
  const list = skipList(high, urgent)
  // A deadline-capped task is never silently clamped: the toast says it stayed.
  const kept =
    deadline > 0 ? ` · ${deadline} kept before ${deadline === 1 ? 'its' : 'their'} deadline` : ''
  return bulkSnoozeCore({ affected, highAffected, high, urgent }, list) + kept
}

function bulkSnoozeCore(
  { affected, highAffected = 0, high, urgent }: BulkSnoozeSkips,
  list: string,
): string {
  if (affected > 0) {
    // "HIGH-PRIORITY" WHEN THAT IS ALL IT MOVED (Trent, 2026-09-22). High is
    // swept only once nothing lower is left, so a double snooze is two presses:
    // the first moves the ordinary tasks, the second the High ones left over.
    // Saying so is what makes the second press make sense.
    const what =
      highAffected === affected ? `high-priority ${taskWord(affected)}` : taskWord(affected)
    return `Snoozed ${affected} ${what}${list ? ` (${list} skipped)` : ''}`
  }
  if (!list) return 'No snoozable tasks'
  if (high === 0) {
    return `No snoozable tasks (${urgent} urgent ${taskWord(urgent)} must be snoozed individually)`
  }
  return `No snoozable tasks (${list} skipped)`
}
