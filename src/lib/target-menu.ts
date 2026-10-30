/**
 * THE TARGET MENU, T1 (Trent, 2026-10-30; mockup `.tmp/target-menu/shots/a-t1*`):
 * what the hold menu offers for a target or a defer (`SnoozeMenu`, every web
 * caller — the row clock, the defer-overdue trigger, Today's hold, the target
 * chip's Move…). Six rows, then the user's periods as ONE wrapping row of
 * buttons, so the menu stays the same height at 8 or 10 periods (the old menu
 * listed every period as its own row and ran off a phone's screen):
 *
 *   Next period · <name> <time>   the soonest period start (today, else tomorrow's first)
 *   1 hour
 *   2 hours
 *   Tomorrow           <ddd> <morning>   the next OpenTask day's morning
 *   This weekend       Sat <morning>     — dropped on a Friday: Tomorrow is Saturday
 *                                         ("If it's Friday, just drop this weekend")
 *   Next weekend       Sat <date>        — instead, on a Saturday or Sunday
 *   Next week          Mon <morning>     — hidden on a Sunday, when it would be tomorrow
 *   PERIODS  [Early 6:30] [Morning 8:30] …   every period but the next one (it is
 *                                            the top row), in day order; each goes to
 *                                            that period's next start — today if still
 *                                            ahead, else tomorrow
 *
 * The deadline-morning row, Custom… and Remove target are the caller's
 * (`SnoozeMenu`), as before. Days are OpenTask days (`openTaskDayOf`): at 1:30
 * AM with a 3:00 AM day start, "tomorrow" is the calendar today.
 *
 * Pure: `tests/behavioral/tm-target-menu.test.ts`.
 */
import { DateTime } from 'luxon'
import { addDays, openTaskDayOf, openTaskLocalDay, periodOpensAt } from '@/lib/opentask-day'
import { nextSlotStart, type TimeSlot } from '@/lib/time-slot-assign'
import { computeSnoozeTime, formatMorningTime } from '@/lib/snooze'

/** A period button's option value: the period's start time after this prefix. */
export const SLOT_OPTION_PREFIX = 'slot:'

export interface TargetMenuRow {
  /** The option's value: minutes ('60'), 'tomorrow', a named day, or `slot:<HH:MM>`. */
  option: string
  label: string
  /** The when, quieter, at the row's end ("Sat 8:30 AM"). */
  detail?: string
  /** The instant it picks (UTC ISO). */
  at: string
  /** It needs the user's day start, which the browser may not know yet. */
  needsDay?: boolean
}

export interface TargetMenuPeriod {
  option: string
  /** The period's own name. */
  label: string
  /** Its start, short: "6:30" (the button's own words; the row says when). */
  time: string
  at: string
}

export interface TargetMenu {
  rows: TargetMenuRow[]
  periods: TargetMenuPeriod[]
}

const SATURDAY = 6
const SUNDAY = 7
const MONDAY = 1

/** The morning of an OpenTask date, as an instant. */
function morningOf(date: string, morningTime: string, timezone: string, dayStart: string): Date {
  return periodOpensAt(date, morningTime, timezone, dayStart)
}

export function targetMenu({
  now,
  timezone,
  dayStart,
  morningTime,
  slots,
}: {
  now: Date
  timezone: string
  dayStart: string
  morningTime: string
  slots: readonly TimeSlot[]
}): TargetMenu {
  // The offsets and Tomorrow are the snooze's own (`computeSnoozeTime`: an
  // offset snapped to the hour, Tomorrow the next OpenTask day's morning).
  const snooze = (option: string) =>
    computeSnoozeTime(option, timezone, morningTime, dayStart, [], now)
  const today = openTaskDayOf(now, timezone, dayStart)
  const weekday = openTaskLocalDay(now, timezone, dayStart).weekday
  const morning = (date: string) => morningOf(date, morningTime, timezone, dayStart)
  const when = (date: string, format: string) =>
    DateTime.fromJSDate(morning(date)).setZone(timezone).toFormat(format)
  const morningWords = formatMorningTime(morningTime)

  // Every period at its next start, the soonest first: the top row.
  const starts = slots
    .map((slot) => ({ slot, at: nextSlotStart(slot.start_time, timezone, now) }))
    .sort((a, b) => a.at.localeCompare(b.at))
  const next = starts[0]

  const rows: TargetMenuRow[] = []
  if (next) {
    const tomorrow = openTaskDayOf(new Date(next.at), timezone, dayStart) > today
    rows.push({
      option: `${SLOT_OPTION_PREFIX}${next.slot.start_time}`,
      label: `Next period · ${next.slot.label} ${tomorrow ? 'tomorrow ' : ''}${formatMorningTime(next.slot.start_time)}`,
      at: next.at,
    })
  }
  rows.push({ option: '60', label: '1 hour', at: snooze('60') })
  rows.push({ option: '120', label: '2 hours', at: snooze('120') })

  const tomorrow = addDays(today, 1)
  rows.push({
    option: 'tomorrow',
    label: 'Tomorrow',
    detail: `${when(tomorrow, 'ccc')} ${morningWords}`,
    at: snooze('tomorrow'),
    needsDay: true,
  })

  if (weekday === SATURDAY || weekday === SUNDAY) {
    // Next weekend: the Saturday after this one.
    const saturday = addDays(today, SATURDAY - weekday + 7)
    rows.push({
      option: 'next-weekend',
      label: 'Next weekend',
      detail: when(saturday, 'ccc LLL d'),
      at: morning(saturday).toISOString(),
      needsDay: true,
    })
  } else if (weekday !== SATURDAY - 1) {
    // This weekend (Mon–Thu): this week's Saturday. On a Friday it is
    // Tomorrow, so it isn't offered twice.
    const saturday = addDays(today, SATURDAY - weekday)
    rows.push({
      option: 'this-weekend',
      label: 'This weekend',
      detail: `${when(saturday, 'ccc')} ${morningWords}`,
      at: morning(saturday).toISOString(),
      needsDay: true,
    })
  }

  if (weekday !== SUNDAY) {
    // Next week: the coming Monday. On a Sunday that is Tomorrow, so it hides.
    const monday = addDays(today, 7 - weekday + MONDAY)
    rows.push({
      option: 'next-week',
      label: 'Next week',
      detail: `${when(monday, 'ccc')} ${morningWords}`,
      at: morning(monday).toISOString(),
      needsDay: true,
    })
  }

  // The periods, in day order, without the one the top row already offers.
  const periods = starts
    .filter((s) => s !== next)
    .sort((a, b) => a.slot.start_time.localeCompare(b.slot.start_time))
    .map(({ slot, at: start }) => ({
      option: `${SLOT_OPTION_PREFIX}${slot.start_time}`,
      label: slot.label,
      time: DateTime.fromFormat(slot.start_time, 'HH:mm').toFormat('h:mm'),
      at: start,
    }))

  return { rows, periods }
}
