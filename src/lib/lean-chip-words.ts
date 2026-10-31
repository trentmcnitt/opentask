/**
 * What the lean row's time chips say (Trent, 2026-10-28):
 *
 *   ⚑ Today 9:00 PM in 5 hrs    a deadline later today counts down
 *   5:00 PM                     a target today, beside a deadline that
 *                               already said "Today" ("Today" once per row)
 *   Today 1:00 PM               a target today otherwise (passed ones too)
 *
 * - The words are the moment (`momentChipWords`). Only a DEADLINE counts
 *   down, and only a deadline later today (the OpenTask day). Targets never.
 * - The countdown is whole hours from the NEXT top of the hour (strictly
 *   after now) to the deadline, so it changes only on the hour: at 8:30 AM a
 *   6 PM deadline is "in 9 hrs"; from 7:00 PM to an 8 PM deadline it is
 *   "in <1 hr" (Trent: "when it switches to 7 PM it would say less than an
 *   hour left"). Local hours, so half-hour time zones count right.
 * - "Today" appears once per row: if the deadline chip says it, a target
 *   today shows its bare time. Other days are unchanged.
 * - "Tonight" counts as Today (Trent, 2026-10-29): it names the same OpenTask
 *   day, so a deadline "Tonight 12:30 AM" is the row's one day word and a
 *   target "Today 5:00 PM" beside it reads "5:00 PM" (and the other way
 *   round).
 * - A queue-marked target says "Queue tomorrow" (`QUEUE_TOMORROW`, Trent
 *   2026-10-31), never its 3:00 AM moment.
 */
import { DateTime } from 'luxon'
import { momentChipWords } from '@/lib/moment-chip-words'
import { openTaskDayOf } from '@/lib/opentask-day'
import { QUEUE_TOMORROW, queueMarked } from '@/lib/queue-tomorrow'

export interface LeanChipWords {
  deadline: string | null
  /** "in 5 hrs" / "in 1 hr" / "in <1 hr", or null when the deadline is not later today. */
  countdown: string | null
  target: string | null
}

/** The day words that name today's OpenTask day (`nightDayWords`, capitalised). */
const TODAY_WORDS = ['Today ', 'Tonight '] as const

/** The today word `words` start with, or null. */
function todayWord(words: string | null): string | null {
  return TODAY_WORDS.find((w) => words?.startsWith(w)) ?? null
}

/** Whole hours from the next top of the hour to `deadline`; "in <1 hr" under one. */
export function countdownWords(deadline: Date, timezone: string, now: Date): string {
  const nextHour = DateTime.fromJSDate(now).setZone(timezone).startOf('hour').plus({ hours: 1 })
  const hours = Math.floor((deadline.getTime() - nextHour.toMillis()) / 3_600_000)
  if (hours < 1) return 'in <1 hr'
  return `in ${hours} hr${hours === 1 ? '' : 's'}`
}

export function leanChipWords(
  task: { deadline_at: string | null; due_at: string | null; queue_mark?: boolean },
  timezone: string,
  dayStart: string,
  now: Date = new Date(),
): LeanChipWords {
  const deadline = task.deadline_at
    ? momentChipWords(task.deadline_at, timezone, dayStart, now)
    : null
  let countdown: string | null = null
  if (task.deadline_at) {
    const at = new Date(task.deadline_at)
    const laterToday =
      at > now && openTaskDayOf(at, timezone, dayStart) === openTaskDayOf(now, timezone, dayStart)
    if (laterToday) countdown = countdownWords(at, timezone, now)
  }
  if (queueMarked(task)) return { deadline, countdown, target: QUEUE_TOMORROW }
  let target = task.due_at ? momentChipWords(task.due_at, timezone, dayStart, now) : null
  const word = todayWord(target)
  if (word && todayWord(deadline)) target = target!.slice(word.length)
  return { deadline, countdown, target }
}

/** The next local top of the hour after `now`: when every countdown can change. */
export function nextTopOfHour(now: Date, timezone: string): Date {
  return DateTime.fromJSDate(now).setZone(timezone).startOf('hour').plus({ hours: 1 }).toJSDate()
}
