/**
 * A task's creation date as the lean task row shows it (Trent, 2026-10-28):
 *
 *   today 9:14 AM · yesterday 4:30 PM   — with the time
 *   Mon                                 — 2–6 days ago, the weekday
 *   Oct 21                              — a week or more ago, this year
 *   Mar 2025                            — an earlier year
 *
 * Plain words, never "added" ("added to what?"). Today and yesterday are
 * OpenTask days (`src/lib/opentask-day.ts`, TQ-G03), the time chips' own
 * rule: a task made at 1:30 AM before a 3:00 AM day start is "yesterday
 * 1:30 AM". The time is `formatTimeInTimezone`, the chips' format.
 */
import { DateTime } from 'luxon'
import { formatTimeInTimezone } from '@/lib/format-date'
import { dayStartMoment, openTaskDayOf, openTaskDaysBetween } from '@/lib/opentask-day'

export function createdDateWords(
  createdAt: string,
  timezone: string,
  dayStart: string,
  now: Date = new Date(),
): string {
  const day = openTaskDayOf(new Date(createdAt), timezone, dayStart)
  const today = openTaskDayOf(now, timezone, dayStart)
  const ago = openTaskDaysBetween(
    dayStartMoment(day, timezone, dayStart),
    dayStartMoment(today, timezone, dayStart),
    timezone,
    dayStart,
  )
  if (ago === 0) return `today ${formatTimeInTimezone(createdAt, timezone)}`
  if (ago === 1) return `yesterday ${formatTimeInTimezone(createdAt, timezone)}`
  const d = DateTime.fromISO(day)
  if (ago > 1 && ago < 7) return d.toFormat('ccc')
  return d.year === DateTime.fromISO(today).year ? d.toFormat('LLL d') : d.toFormat('LLL yyyy')
}
