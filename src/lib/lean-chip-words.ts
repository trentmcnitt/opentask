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
 */
import { DateTime } from 'luxon'
import { momentChipWords } from '@/lib/moment-chip-words'
import { openTaskDayOf } from '@/lib/opentask-day'

export interface LeanChipWords {
  deadline: string | null
  /** "in 5 hrs" / "in 1 hr" / "in <1 hr", or null when the deadline is not later today. */
  countdown: string | null
  target: string | null
}

const TODAY = 'Today '

/** Whole hours from the next top of the hour to `deadline`; "in <1 hr" under one. */
export function countdownWords(deadline: Date, timezone: string, now: Date): string {
  const nextHour = DateTime.fromJSDate(now).setZone(timezone).startOf('hour').plus({ hours: 1 })
  const hours = Math.floor((deadline.getTime() - nextHour.toMillis()) / 3_600_000)
  if (hours < 1) return 'in <1 hr'
  return `in ${hours} hr${hours === 1 ? '' : 's'}`
}

export function leanChipWords(
  task: { deadline_at: string | null; due_at: string | null },
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
  let target = task.due_at ? momentChipWords(task.due_at, timezone, dayStart, now) : null
  if (target?.startsWith(TODAY) && deadline?.startsWith(TODAY)) {
    target = target.slice(TODAY.length)
  }
  return { deadline, countdown, target }
}

/** The next local top of the hour after `now`: when every countdown can change. */
export function nextTopOfHour(now: Date, timezone: string): Date {
  return DateTime.fromJSDate(now).setZone(timezone).startOf('hour').plus({ hours: 1 }).toJSDate()
}
