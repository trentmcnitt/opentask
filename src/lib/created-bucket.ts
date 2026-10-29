/**
 * SCAN'S DATE BREAKS (Trent, 2026-10-29, "F3 at 30%"): which bucket a task's
 * CREATED date falls in, counted in the user's OpenTask days (their day
 * start, `openTaskDayOf`), for the breaks between Scan's rows (`DateBreak`).
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
 * Today. Each bucket has a colour (sky, indigo, amber, emerald, teal, slate);
 * the break mixes it 30% toward the background.
 *
 * Pure: the clock, the zone and the day start come in.
 */
import { openTaskDayOf, openTaskDaysBetween } from '@/lib/opentask-day'

export type CreatedBucket = 'today' | 'yesterday' | 'week' | 'month' | 'year' | 'earlier'

export const CREATED_BUCKETS: Readonly<Record<CreatedBucket, { label: string; color: string }>> = {
  today: { label: 'Today', color: '#0284c7' },
  yesterday: { label: 'Yesterday', color: '#4f46e5' },
  week: { label: 'Week', color: '#d97706' },
  month: { label: 'Month', color: '#059669' },
  year: { label: 'Year', color: '#0d9488' },
  earlier: { label: 'Earlier', color: '#64748b' },
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

/**
 * Where a list's rows change bucket: for each row, the bucket it OPENS, or
 * null where it continues the row before (and on the first row — the
 * section's heading opens it). Read off the rows as shown, so "Show 5 more"
 * extends the breaks with the rows.
 */
export function bucketBreaks(
  createdAts: readonly string[],
  now: Date,
  timezone: string,
  dayStart: string,
): (CreatedBucket | null)[] {
  let previous: CreatedBucket | null = null
  return createdAts.map((createdAt, i) => {
    const bucket = createdBucket(createdAt, now, timezone, dayStart)
    const opens = i > 0 && bucket !== previous ? bucket : null
    previous = bucket
    return opens
  })
}
