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
 * (`formatLastLogged`), "since …" (`formatTaskSince`), History's times and
 * the activity log's deadline weekday all read it from here. A day start
 * after 12:00 has no late night (the stretch before midnight is already the
 * next day), so nothing there says "night".
 *
 * A LABEL WITH A CLOCK TIME NAMES THE CALENDAR DAY (Trent, 2026-10-26). With
 * a day start after 12:00 a moment's OpenTask date can be the day AFTER its
 * calendar date (an 11 PM start: Tue 23:47 is on Wednesday's list), and
 * "Wed, Oct 27, 11:47 PM" pairs one day's weekday with another's date. So a
 * timed label shows the moment's own weekday and date, with no cue — "Tue,
 * Oct 27, 11:47 PM", "Tue 11:47 PM" (`timedWeekday`) — and says "today",
 * "tomorrow" or "yesterday" only when its OpenTask day and its own date say
 * the same (`wordsAgree`): at Sat 12:30 a Sat 23:30 target is on Sunday's
 * list but dated Saturday, so it is "Sat 11:30 PM", never "Tomorrow, Oct 24".
 * Grouping (which day's list it is on) still follows the OpenTask day. The
 * night cue is for a start at or before 12:00 only, where it is the one
 * honest word. A label of a whole DAY with no time (the deadline chip, the
 * bulk header's shared day, `getDayLabel`) names the OpenTask day.
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
  /** The moment's own calendar date, at its local midnight. */
  date: DateTime
  /** Days from today's OpenTask date to the moment's own date (`gap`, unless a start after noon moves it). */
  dateGap: number
}

/**
 * The OpenTask day `at` counts on, how far it is from `now`'s, and whether
 * `at` is in its night. `dayStart` null reads the calendar (the switch off on
 * a server read that has no day start): the moment's own date, never night.
 */
export function nightDay(at: Date, timezone: string, dayStart: string | null, now: Date): NightDay {
  const date = dayStart ? openTaskDayOf(at, timezone, dayStart) : calendarDateOf(at, timezone)
  const today = dayStart ? openTaskDayOf(now, timezone, dayStart) : calendarDateOf(now, timezone)
  const todayAt = DateTime.fromISO(today, { zone: timezone })
  const day = DateTime.fromISO(date, { zone: timezone })
  const gap = Math.round(day.diff(todayAt, 'days').days)
  const own = DateTime.fromISO(calendarDateOf(at, timezone), { zone: timezone })
  const dateGap = Math.round(own.diff(todayAt, 'days').days)
  const night = dayStart !== null && isLateNight(at, timezone, dayStart)
  return { day, gap, night, date: own, dateGap }
}

/**
 * Whether a timed label may name the moment's day by a relative word
 * ("today", "tomorrow", "yesterday"): its night (the word names the OpenTask
 * day and says "night"), or its OpenTask day and own date are the same
 * distance from today. Always, for a start at or before 12:00 (out of the
 * night the two dates are one); with a later start, not for a moment after
 * the start on the evening before its OpenTask date.
 */
export function wordsAgree(n: NightDay): boolean {
  return n.night || n.gap === n.dateGap
}

/** The word a night label adds: "Thu" → "Thu night". */
export const NIGHT_SUFFIX = ' night'

/**
 * Yesterday's night, as people say it (2026-10-27): "last night", never
 * "yesterday night" — the row, "Last:", "since", History, the deadline chip.
 */
export const LAST_NIGHT = 'last night'

/**
 * The OpenTask day's weekday, with " night" when the moment is in its night:
 * "Thu night" — for a label of the whole day (the deadline chip, the deck's
 * "the deadline is Wed").
 */
export function nightWeekday(n: NightDay): string {
  return `${n.day.toFormat('ccc')}${n.night ? NIGHT_SUFFIX : ''}`
}

/**
 * The day a label WITH A CLOCK TIME names: in its night the OpenTask day
 * (said with "night"), else the moment's own date — never an OpenTask date
 * beside the moment's own time ("Tue 11:47 PM", not "Wed 11:47 PM").
 */
export function timedDay(n: NightDay): DateTime {
  return n.night ? n.day : n.date
}

/** The weekday of a timed label (`timedDay`): "Tue", "Thu night". */
export function timedWeekday(n: NightDay): string {
  return `${timedDay(n).toFormat('ccc')}${n.night ? NIGHT_SUFFIX : ''}`
}

/**
 * A timed label's day words (lower case): "today" / "tonight", "tomorrow"
 * (" night"), "yesterday" / "last night", else the weekday (" night") — and the
 * moment's own weekday wherever a word would contradict its date
 * (`wordsAgree`). A moment already past on today's own night is "Thu night",
 * never "tonight" (the chip's rule).
 */
export function nightDayWords(n: NightDay, past: boolean): string {
  if (!wordsAgree(n)) return timedWeekday(n)
  const suffix = n.night ? NIGHT_SUFFIX : ''
  if (n.gap === 0) {
    if (!n.night) return 'today'
    return past ? timedWeekday(n) : 'tonight'
  }
  if (n.gap === 1) return `tomorrow${suffix}`
  if (n.gap === -1) return n.night ? LAST_NIGHT : 'yesterday'
  return timedWeekday(n)
}

/** "tonight" → "Tonight", "thu night" stays as written ("Thu night"). */
export function capitalized(words: string): string {
  return words.charAt(0).toUpperCase() + words.slice(1)
}
