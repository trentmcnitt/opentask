/**
 * L9's NIGHT RULE, for every label that names the day of a moment (the
 * deadlines page plan §13, 2026-10-22; every target-time label from
 * "OpenTask day everywhere" part 2, Trent 2026-10-26).
 *
 * A moment between local midnight and the day start belongs to the OpenTask
 * day BEFORE (`isLateNight`): with a 3:00 AM start, Friday 01:00 is Thursday's.
 * A label that names its day by a word — "Today", "Tomorrow", a weekday —
 * names that OpenTask day and says "night": "Thu night", "Tomorrow night",
 * "Tonight". So the day the label names is the day the task is on, and the
 * calendar date shown beside it (where there is one) stays the moment's own.
 *
 * One rule: the deadline chip (`deadlineChip`), the quick panel's header
 * (`formatQuickSelectHeader`), the row's target time (`formatDueTimeParts`),
 * the defer words (`formatSnoozeTarget`), a quota's "Last:" line
 * (`formatLastLogged`), "since …" (`formatTaskSince`) and the activity log's
 * deadline weekday all read it from here. A day start after 12:00 has no
 * late night (the stretch before midnight is already the next day), so
 * nothing there says "night".
 *
 * Pure: no clock of its own.
 */
import { DateTime } from 'luxon'
import { calendarDateOf, isLateNight, openTaskDayOf } from '@/lib/opentask-day'

export interface NightDay {
  /** The OpenTask date the moment counts on, at its local midnight. */
  day: DateTime
  /** OpenTask days from today's to it (negative: before today). */
  gap: number
  /** The moment is in that day's night: between local midnight and the day start. */
  night: boolean
}

/**
 * The OpenTask day `at` counts on, how far it is from `now`'s, and whether
 * `at` is in its night. `dayStart` null reads the calendar (the switch off on
 * a server read that has no day start): the moment's own date, never night.
 */
export function nightDay(at: Date, timezone: string, dayStart: string | null, now: Date): NightDay {
  const date = dayStart ? openTaskDayOf(at, timezone, dayStart) : calendarDateOf(at, timezone)
  const today = dayStart ? openTaskDayOf(now, timezone, dayStart) : calendarDateOf(now, timezone)
  const day = DateTime.fromISO(date, { zone: timezone })
  const gap = Math.round(day.diff(DateTime.fromISO(today, { zone: timezone }), 'days').days)
  return { day, gap, night: dayStart !== null && isLateNight(at, timezone, dayStart) }
}

/** The word a night label adds: "Thu" → "Thu night". */
export const NIGHT_SUFFIX = ' night'

/** The OpenTask day's weekday, with " night" when the moment is in its night: "Thu night". */
export function nightWeekday(n: NightDay): string {
  return `${n.day.toFormat('ccc')}${n.night ? NIGHT_SUFFIX : ''}`
}

/**
 * The day's relative words (lower case): "today" / "tonight", "tomorrow"
 * (" night"), "yesterday" (" night"), else the weekday (" night") — for a
 * label that names any day by its word. A moment already past on today's
 * own night is "Thu night", never "tonight" (the chip's rule).
 */
export function nightDayWords(n: NightDay, past: boolean): string {
  const suffix = n.night ? NIGHT_SUFFIX : ''
  if (n.gap === 0) {
    if (!n.night) return 'today'
    return past ? nightWeekday(n) : 'tonight'
  }
  if (n.gap === 1) return `tomorrow${suffix}`
  if (n.gap === -1) return `yesterday${suffix}`
  return nightWeekday(n)
}

/** "tonight" → "Tonight", "thu night" stays as written ("Thu night"). */
export function capitalized(words: string): string {
  return words.charAt(0).toUpperCase() + words.slice(1)
}
