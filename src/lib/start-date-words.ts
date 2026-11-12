/**
 * THE START DATE'S WORDS (2026-11-12; docs/TASK-MODEL.md § Start date).
 * Pure: the quick panel's Starts row, the Due page's open-window rows and the
 * "Starts Jan 1" note beside a deadline chip all read from here. The rules
 * themselves are the server's:
 * (restates RULE START-3, home: src/lib/task-segments.ts)
 * (restates RULE START-4, home: src/lib/task-segments.ts)
 *
 * A target-less deadline one-off with a picked start date S is quiet before
 * S, comes round on its SET horizon's cadence from S until the day it becomes
 * daily (C, `comingDueDay`), and is daily from C. Days are OpenTask days
 * (yyyy-MM-dd).
 */
import { DateTime } from 'luxon'
import {
  comingDueDay,
  deadlineDay,
  nextRound,
  type CheckInDay,
  type HorizonValue,
} from '@/lib/task-segments'

/** The Starts row's label (the deadline form of the Lead time row, on a one-off). */
export const STARTS_WORD = 'Starts'
/** The Due page's two headings (shown only when both groups have rows). */
export const COMING_DUE_TITLE = 'Coming due'
export const OPEN_WINDOW_TITLE = 'Open window'

/** How often a horizon's rounds come: unset reads as weeks. */
export function cadenceWord(horizon: HorizonValue | null | undefined): string {
  switch (horizon ?? 'weeks') {
    case 'days':
      return 'daily'
    case 'months':
      return 'monthly'
    case 'eventually':
      return 'quarterly'
    default:
      return 'weekly'
  }
}

const dayOf = (day: string, timezone: string) => DateTime.fromISO(day, { zone: timezone })
const longDay = (day: string, timezone: string) => dayOf(day, timezone).toFormat('ccc LLL d')
const daysFrom = (from: string, to: string, timezone: string) =>
  Math.round(dayOf(to, timezone).diff(dayOf(from, timezone), 'days').days)

/** A picked start date's facts for the Starts row. */
export interface StartsDateWords {
  /** "Fri Jan 1": the chip. */
  chip: string
  /** Local days from the start to the deadline's day (89). */
  daysBefore: number
  /** The line under the chip: what the date does. */
  line: string
}

/**
 * The line under a picked start date, naming the first cadence round
 * honestly (the first one a full step after the start, START-4):
 * - "Comes round weekly from Sat Jan 9 until Sat Mar 27, then daily";
 * - no cadence round before the daily day (an Eventually task, a short
 *   window): "Shows on Fri Jan 1, then daily from Sat Mar 27";
 * - a start on or after the daily day has no open window: "Daily from Fri Mar 26".
 */
export function startsDateWords(
  startDate: string,
  deadlineAt: string,
  horizon: HorizonValue | null | undefined,
  checkInDay: CheckInDay,
  timezone: string,
  rolloverTime: string | null,
): StartsDateWords {
  const d = deadlineDay(deadlineAt, timezone, rolloverTime)
  const daily = comingDueDay(deadlineAt, startDate, timezone, rolloverTime)
  const chip = longDay(startDate, timezone)
  const daysBefore = Math.max(0, daysFrom(startDate, d, timezone))
  if (startDate >= daily) return { chip, daysBefore, line: `Daily from ${chip}` }
  const first = nextRound(startDate, daily, horizon, checkInDay, startDate, timezone)
  const line = first
    ? `Comes round ${cadenceWord(horizon)} from ${longDay(first, timezone)} until ${longDay(daily, timezone)}, then daily`
    : `Shows on ${chip}, then daily from ${longDay(daily, timezone)}`
  return { chip, daysBefore, line }
}

/** "11 weeks left" from two weeks out, else "9 days left" / "1 day left" (the push's words too). */
export function timeLeftWords(days: number): string {
  if (days >= 14) return `${Math.floor(days / 7)} weeks left`
  return days === 1 ? '1 day left' : `${Math.max(0, days)} days left`
}

/**
 * An open-window row's words after its deadline chip, as parts joined with
 * " · ": "weekly", "next Sat" (the weekday within a week, else "next Jan 23";
 * left out with no round left) and "11 weeks left".
 */
export function openWindowRowWords(
  row: { horizon: HorizonValue | null | undefined; nextRound: string | null | undefined },
  deadlineAt: string,
  today: string,
  timezone: string,
  rolloverTime: string | null,
): string[] {
  const parts = [cadenceWord(row.horizon)]
  if (row.nextRound) {
    const near = daysFrom(today, row.nextRound, timezone) <= 7
    parts.push(`next ${dayOf(row.nextRound, timezone).toFormat(near ? 'ccc' : 'LLL d')}`)
  }
  const d = deadlineDay(deadlineAt, timezone, rolloverTime)
  parts.push(timeLeftWords(daysFrom(today, d, timezone)))
  return parts
}

/**
 * "Starts Jan 1" beside the deadline chip of a task still before its picked
 * start date (`deadline_window: 'before_start'`), on every list that shows
 * it (All, search, Scan). Null otherwise — a Default or Days task before its
 * lead day says nothing new.
 * (restates RULE START-8, home: src/core/tasks/task-segments.ts)
 */
export function startsNote(
  task: { deadline_window?: string | null; start_date?: string | null },
  timezone: string,
): string | null {
  if (task.deadline_window !== 'before_start' || !task.start_date) return null
  return `Starts ${dayOf(task.start_date, timezone).toFormat('LLL d')}`
}
