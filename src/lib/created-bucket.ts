/**
 * SCAN'S AGE STEPS (Trent, 2026-10-29, GS2: "it really does convey age"):
 * which bucket a task's CREATED date falls in, counted in the user's OpenTask
 * days (their day start, `openTaskDayOf`); each bucket is a grey step of the
 * row's background (`AGE_STEP_GREYS`, drawn by `TaskList`). They replaced
 * the date breaks between rows the same day.
 *
 *   Today      created on today's OpenTask day
 *   Yesterday  the day before
 *   Week       2 to 6 OpenTask days ago (the last seven days, so a Monday
 *              still has last week's Saturday in it)
 *   Month      earlier in the same calendar month (of the OpenTask date)
 *   Year       earlier in the same calendar year
 *   Earlier    anything before
 *
 * The first matching rule wins, so a task 4 days old is Week even when it
 * was last month. A created date "after" now (a clock off by a little) is
 * Today.
 *
 * Pure: the clock, the zone and the day start come in.
 */
import { openTaskDayOf, openTaskDaysBetween } from '@/lib/opentask-day'

export type CreatedBucket = 'today' | 'yesterday' | 'week' | 'month' | 'year' | 'earlier'

/**
 * Each bucket's grey step, R = G = B: light from white down, dark counted UP
 * from the page background (#0a0a0a, `--background`). Trent's GS2, lightened
 * at the young end on 2026-10-29 ("really starting out strong for something
 * that is two days old"; tuned again the same day): light 255 / 253 / 251 /
 * 246 / 243 / 241, dark +0 / +2 / +4 / +9 / +12 / +14. Drawn by the `.age-step-*` classes in
 * globals.css (literal values, tunable in dev tools); a test keeps them equal.
 */
export const AGE_STEP_GREYS: Readonly<Record<CreatedBucket, { light: number; dark: number }>> = {
  today: { light: 255, dark: 10 },
  yesterday: { light: 253, dark: 12 },
  week: { light: 251, dark: 14 },
  month: { light: 246, dark: 19 },
  year: { light: 243, dark: 22 },
  earlier: { light: 241, dark: 24 },
}

export function createdBucket(
  createdAt: string,
  now: Date,
  timezone: string,
  dayStart: string,
): CreatedBucket {
  const created = new Date(createdAt)
  const days = openTaskDaysBetween(created, now, timezone, dayStart)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days <= 6) return 'week'
  // OpenTask dates, "YYYY-MM-DD": the calendar month and year are prefixes.
  const day = openTaskDayOf(created, timezone, dayStart)
  const today = openTaskDayOf(now, timezone, dayStart)
  if (day.slice(0, 7) === today.slice(0, 7)) return 'month'
  if (day.slice(0, 4) === today.slice(0, 4)) return 'year'
  return 'earlier'
}
