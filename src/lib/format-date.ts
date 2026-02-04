/**
 * Timezone-aware date formatting utilities.
 *
 * All functions accept a UTC ISO string and a timezone string (IANA, e.g. "America/Chicago").
 * Uses Intl.DateTimeFormat for browser-native formatting — no extra dependencies.
 */

interface DayBoundaries {
  todayStart: Date
  tomorrowStart: Date
  dayAfterTomorrowStart: Date
  nextWeekStart: Date
}

/**
 * Returns UTC Date objects representing day boundaries in the given timezone.
 */
export function getTimezoneDayBoundaries(timezone: string): DayBoundaries {
  // Get current date parts in the user's timezone
  const now = new Date()
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(now)

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '0'
  const year = parseInt(get('year'))
  const month = parseInt(get('month'))
  const day = parseInt(get('day'))

  // Build a date string that represents midnight in the user's timezone,
  // then parse it as that timezone to get the correct UTC instant.
  const todayStart = parseInTimezone(year, month, day, timezone)
  const tomorrowStart = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000)
  const dayAfterTomorrowStart = new Date(tomorrowStart.getTime() + 24 * 60 * 60 * 1000)
  const nextWeekStart = new Date(todayStart.getTime() + 7 * 24 * 60 * 60 * 1000)

  return { todayStart, tomorrowStart, dayAfterTomorrowStart, nextWeekStart }
}

/**
 * Parse a date at midnight in a given timezone, returning a UTC Date.
 */
function parseInTimezone(year: number, month: number, day: number, timezone: string): Date {
  // Create a date in UTC, then adjust by the timezone offset
  const utcGuess = new Date(Date.UTC(year, month - 1, day, 12, 0, 0))

  // Format back in the target timezone to find the offset
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(utcGuess)

  const get = (type: string) => parseInt(formatted.find((p) => p.type === type)?.value ?? '0')
  // Use raw hour for offset calculation (hour=24 means midnight of next day,
  // which is correct for computing the UTC offset at the guess point)
  const localH = get('hour')
  const localM = get('minute')

  // The offset is: local time - UTC time (at the guess point)
  const utcH = utcGuess.getUTCHours()
  const utcM = utcGuess.getUTCMinutes()
  const offsetMs = (localH - utcH) * 60 * 60 * 1000 + (localM - utcM) * 60 * 1000

  // Midnight local = start of day in the timezone
  const midnightLocal = new Date(Date.UTC(year, month - 1, day, 0, 0, 0))
  return new Date(midnightLocal.getTime() - offsetMs)
}

/**
 * Full date-time for task detail: "Wed, Jan 5, 2025, 9:00 AM"
 */
export function formatDateTime(isoUtc: string, timezone: string): string {
  const date = new Date(isoUtc)
  return date.toLocaleString('en-US', {
    timeZone: timezone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

/**
 * For datetime-local input value: "2025-01-05T09:00"
 */
export function toLocalDatetimeInput(isoUtc: string, timezone: string): string {
  const d = new Date(isoUtc)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d)

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00'
  const hour = get('hour') === '24' ? '00' : get('hour')
  return `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}`
}

export interface DueTimeParts {
  relative: string // "in 47m", "5:00 PM", "Tomorrow 9:00 AM", "3h ago", etc.
  absolute?: string // "2:25 PM" — only present when relative is "in X"
}

/**
 * Structured due-time data for TaskRow's second line.
 *
 * Returns a relative string (always) and an optional absolute string
 * (only when relative is "in Xm" / "in Xh Ym").
 */
export function formatDueTimeParts(isoUtc: string, timezone: string): DueTimeParts {
  const due = new Date(isoUtc)
  const now = new Date()
  const { todayStart, tomorrowStart, dayAfterTomorrowStart, nextWeekStart } =
    getTimezoneDayBoundaries(timezone)

  const time = formatTimeInZone(due, timezone)

  // Overdue — due is in the past
  if (due < now) {
    return formatOverdue(due, now, todayStart, timezone, time)
  }

  // Today, future
  if (due < tomorrowStart) {
    return formatTodayFuture(due, now, time)
  }

  // Tomorrow
  if (due < dayAfterTomorrowStart) {
    return { relative: `Tomorrow ${time}` }
  }

  // Within 7 days (after tomorrow)
  if (due < nextWeekStart) {
    const dayName = due.toLocaleDateString('en-US', {
      timeZone: timezone,
      weekday: 'short',
    })
    return { relative: `${dayName} ${time}` }
  }

  // Beyond 7 days
  const dateStr = due.toLocaleDateString('en-US', {
    timeZone: timezone,
    month: 'short',
    day: 'numeric',
  })
  return { relative: `${dateStr} ${time}` }
}

/**
 * Overdue format — relative + absolute:
 *   < 60 min:    "Xm ago"     · "5:00 PM"
 *   today:       "Xh ago"     · "5:00 PM"
 *   yesterday:   "yesterday"  · "5:00 PM"
 *   2–6 days:    "Xd ago"     · "Jan 30 5:00 PM"
 *   1–4 weeks:   "Xw ago"     · "Jan 15 5:00 PM"
 *   5+ weeks:    "Xmo ago"    · "Dec 1 5:00 PM"
 */
function formatOverdue(
  due: Date,
  now: Date,
  todayStart: Date,
  timezone: string,
  time: string,
): DueTimeParts {
  const diffMs = now.getTime() - due.getTime()
  const diffMin = Math.floor(diffMs / 60000)

  // For today/yesterday, absolute is just the time.
  // For older, absolute includes the date.
  const dateAndTime = `${due.toLocaleDateString('en-US', { timeZone: timezone, month: 'short', day: 'numeric' })} ${time}`

  // Still today — show minutes or hours
  if (due >= todayStart) {
    if (diffMin < 60) {
      const rel = diffMin < 1 ? 'just now' : `${diffMin}m ago`
      return { relative: rel, absolute: time }
    }
    return { relative: `${Math.floor(diffMin / 60)}h ago`, absolute: time }
  }

  // Yesterday
  const yesterdayStart = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000)
  if (due >= yesterdayStart) {
    return { relative: 'yesterday', absolute: time }
  }

  // Days/weeks/months ago (based on calendar days in timezone)
  const dueDateStr = due.toLocaleDateString('en-US', { timeZone: timezone })
  const todayStr = now.toLocaleDateString('en-US', { timeZone: timezone })
  const dueDate = new Date(dueDateStr)
  const today = new Date(todayStr)
  const calendarDays = Math.round((today.getTime() - dueDate.getTime()) / (24 * 60 * 60 * 1000))

  if (calendarDays < 7) {
    return { relative: `${calendarDays}d ago`, absolute: dateAndTime }
  }

  const weeks = Math.floor(calendarDays / 7)
  if (calendarDays < 35) {
    return { relative: `${weeks}w ago`, absolute: dateAndTime }
  }

  const months = Math.round(calendarDays / 30)
  return { relative: `${Math.max(1, months)}mo ago`, absolute: dateAndTime }
}

function formatTodayFuture(due: Date, now: Date, time: string): DueTimeParts {
  const diffMin = Math.floor((due.getTime() - now.getTime()) / 60000)
  const threeHoursMin = 180

  if (diffMin < 1) {
    return { relative: 'in <1m', absolute: time }
  }

  if (diffMin < threeHoursMin) {
    const hours = Math.floor(diffMin / 60)
    const mins = diffMin % 60
    let rel: string
    if (hours === 0) {
      rel = `in ${mins}m`
    } else if (mins === 0) {
      rel = `in ${hours}h`
    } else {
      rel = `in ${hours}h ${mins}m`
    }
    return { relative: rel, absolute: time }
  }

  return { relative: time }
}

/**
 * "snoozed from Tue" or "snoozed from Jan 30" for snooze context in TaskRow.
 * Named formatOriginalDueAt to match the field name, but displays as "snoozed from".
 */
export function formatOriginalDueAt(isoUtc: string, timezone: string): string | null {
  const snoozedDate = new Date(isoUtc)
  const now = new Date()

  // Only render if original_due_at is in the past
  if (snoozedDate > now) return null

  const diffMs = now.getTime() - snoozedDate.getTime()
  const diffDays = diffMs / (24 * 60 * 60 * 1000)

  if (diffDays <= 7) {
    const dayName = snoozedDate.toLocaleDateString('en-US', {
      timeZone: timezone,
      weekday: 'short',
    })
    return `snoozed from ${dayName}`
  }

  const dateStr = snoozedDate.toLocaleDateString('en-US', {
    timeZone: timezone,
    month: 'short',
    day: 'numeric',
  })
  return `snoozed from ${dateStr}`
}

function formatTimeInZone(date: Date, timezone: string): string {
  return date.toLocaleTimeString('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

/**
 * Parse a datetime-local input value ("YYYY-MM-DDTHH:MM") as the user's timezone
 * and return a UTC ISO string.
 *
 * This is the inverse of toLocalDatetimeInput(): that function converts UTC → local display,
 * and this function converts local input → UTC for storage.
 */
/**
 * Format the duration between two timestamps as a delta string.
 *
 * @param fromMs - Start timestamp in milliseconds
 * @param toMs - End timestamp in milliseconds
 * @returns Delta string like "+30m", "+2h", "+1d", "-30m", etc.
 */
export function formatDurationDelta(fromMs: number, toMs: number): string {
  const diffMs = toMs - fromMs
  const sign = diffMs >= 0 ? '+' : '-'
  const absDiffMs = Math.abs(diffMs)

  const minutes = Math.floor(absDiffMs / 60000)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  const weeks = Math.floor(days / 7)

  if (weeks >= 1) {
    return `${sign}${weeks}w`
  }
  if (days >= 1) {
    return `${sign}${days}d`
  }
  if (hours >= 1) {
    const remainingMins = minutes % 60
    if (remainingMins === 0) {
      return `${sign}${hours}h`
    }
    return `${sign}${hours}h${remainingMins}m`
  }
  if (minutes >= 1) {
    return `${sign}${minutes}m`
  }
  return `${sign}0m`
}

/**
 * Format a time in a given timezone as "9:00 AM" style.
 * Exported for use in activity formatting.
 */
export function formatTimeInTimezone(isoUtc: string, timezone: string): string {
  const date = new Date(isoUtc)
  return date.toLocaleTimeString('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

export function parseLocalDatetimeInput(value: string, timezone: string): string {
  const [datePart, timePart] = value.split('T')
  const [year, month, day] = datePart.split('-').map(Number)
  const [hour, minute] = timePart.split(':').map(Number)

  // Get the UTC offset for this specific date/time in the target timezone
  // by creating a UTC guess near the target and measuring the difference
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0))

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(utcGuess)

  const get = (type: string) => parseInt(parts.find((p) => p.type === type)?.value ?? '0')
  const localH = get('hour')
  const localM = get('minute')

  const utcH = utcGuess.getUTCHours()
  const utcM = utcGuess.getUTCMinutes()
  const offsetMs = (localH - utcH) * 60 * 60 * 1000 + (localM - utcM) * 60 * 1000

  // The desired local time as if it were UTC, then subtract the offset
  const localAsUtc = new Date(Date.UTC(year, month - 1, day, hour, minute, 0))
  return new Date(localAsUtc.getTime() - offsetMs).toISOString()
}
