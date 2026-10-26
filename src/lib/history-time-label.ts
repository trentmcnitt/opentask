/**
 * History's separator-pill time labels ("Yesterday 12:33 PM", "Wednesday
 * 3:15 PM", "Feb 3"), out of src/app/history/page.tsx so the label rules can
 * be tested with the others (TQ-LN21: a label's weekday and date always name
 * the same day). Pure: `now` is passed in.
 */
import { getTimezoneDayBoundaries, openTaskDateLabel } from '@/lib/format-date'
import {
  LAST_NIGHT,
  NIGHT_SUFFIX,
  capitalized,
  nightDay,
  timedDay,
  wordsAgree,
} from '@/lib/night-day'

/**
 * Format a label for the separator pill above an activity entry.
 * Uses precise timezone-aware day boundaries for "Yesterday" detection.
 *
 * Label tiers (most recent → oldest):
 * - < 1h:     "3:04 PM (54m ago)"
 * - 1–24h:    "12:48 PM (3h ago)"
 * - Yesterday: "Yesterday 12:33 PM"
 * - 2–4 days: "Wednesday 3:15 PM"   (weekday + time)
 * - 5–7 days: "Feb 3 3:15 PM"       (date + time)
 * - > 7 days: "Feb 3"               (date only)
 */
export function formatTimeAgoLabel(
  entry: { created_at: string },
  now: number,
  timezone: string,
  dayStart: string,
): string {
  const entryTime = new Date(entry.created_at).getTime()
  const entryDate = new Date(entry.created_at)
  const age = now - entryTime

  const ONE_HOUR = 3_600_000
  const ONE_DAY = 86_400_000

  const formatTime = () =>
    entryDate.toLocaleTimeString('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })

  if (age < ONE_HOUR) {
    const minutes = Math.max(1, Math.floor(age / 60_000))
    return `${formatTime()} (${minutes}m ago)`
  }

  if (age < ONE_DAY) {
    const hours = Math.floor(age / ONE_HOUR)
    return `${formatTime()} (${hours}h ago)`
  }

  // The OpenTask day boundaries tell "Yesterday" from a weekday
  const { todayStart, yesterdayStart } = getTimezoneDayBoundaries(timezone, dayStart, new Date(now))

  // L9's night rule (`nightDay`): a 1:00 AM entry is the night of the day
  // before. Out of the night the weekday is the entry's own date's (a start
  // after noon: a Sat 23:47 entry is "Saturday 11:47 PM", `timedDay`), and
  // "Yesterday" gives way to it where it would contradict that date.
  const n = nightDay(entryDate, timezone, dayStart, new Date(now))
  const night = n.night ? NIGHT_SUFFIX : ''
  const weekday = `${timedDay(n).toFormat('cccc')}${night}`
  const yesterday = entryTime >= yesterdayStart.getTime() && entryTime < todayStart.getTime()
  if (yesterday && wordsAgree(n)) {
    return `${n.night ? capitalized(LAST_NIGHT) : 'Yesterday'} ${formatTime()}`
  }

  // 2–4 days ago: the weekday + time
  const fourDaysAgo = new Date(todayStart.getTime() - 4 * ONE_DAY)
  if (yesterday || entryTime >= fourDaysAgo.getTime()) {
    return `${weekday} ${formatTime()}`
  }

  // 5–7 days ago: date + time
  if (age < 7 * ONE_DAY) {
    const date = entryDate.toLocaleDateString('en-US', {
      timeZone: timezone,
      month: 'short',
      day: 'numeric',
    })
    return `${date} ${formatTime()}`
  }

  // > 7 days: date only — the OpenTask date, the day History lists it under
  return openTaskDateLabel(entry.created_at, timezone, dayStart)
}
