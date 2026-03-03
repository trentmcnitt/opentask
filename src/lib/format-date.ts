/**
 * Timezone-aware date formatting utilities.
 *
 * All functions accept a UTC ISO string and a timezone string (IANA, e.g. "America/Chicago").
 * Uses Intl.DateTimeFormat for browser-native formatting — no extra dependencies.
 */

export interface DayBoundaries {
  yesterdayStart: Date
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
    hourCycle: 'h23',
  }).formatToParts(now)

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '0'
  const year = parseInt(get('year'))
  const month = parseInt(get('month'))
  const day = parseInt(get('day'))

  // Build a date string that represents midnight in the user's timezone,
  // then parse it as that timezone to get the correct UTC instant.
  // Uses parseInTimezone for each boundary so DST transitions (23h or 25h days)
  // are handled correctly — ms arithmetic would be off by ±1 hour on DST days.
  const yesterdayStart = parseInTimezone(year, month, day - 1, timezone)
  const todayStart = parseInTimezone(year, month, day, timezone)
  const tomorrowStart = parseInTimezone(year, month, day + 1, timezone)
  const dayAfterTomorrowStart = parseInTimezone(year, month, day + 2, timezone)
  const nextWeekStart = parseInTimezone(year, month, day + 7, timezone)

  return { yesterdayStart, todayStart, tomorrowStart, dayAfterTomorrowStart, nextWeekStart }
}

/**
 * Parse a date at midnight in a given timezone, returning a UTC Date.
 */
export function parseInTimezone(year: number, month: number, day: number, timezone: string): Date {
  // Date.UTC auto-normalizes overflow (e.g. day=32 → next month, day=0 → last day of prev month)
  const normalized = new Date(Date.UTC(year, month - 1, day, 0, 0, 0))
  const normY = normalized.getUTCFullYear()
  const normM = normalized.getUTCMonth() + 1
  const normD = normalized.getUTCDate()

  // Probe at noon UTC on the target date to discover the timezone offset.
  // Noon is far enough from midnight that local and UTC are almost always on the
  // same calendar day, avoiding wrap-around in the offset calculation.
  const noonUtc = new Date(Date.UTC(normY, normM - 1, normD, 12, 0, 0))

  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })

  // Compute offset using full datetime difference (not just hours) to avoid
  // wrap-around errors when local and UTC dates differ.
  const offsetMsAt = (instant: Date): number => {
    const parts = fmt.formatToParts(instant)
    const get = (type: string) => parseInt(parts.find((p) => p.type === type)?.value ?? '0')
    const localMs = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'))
    const utcMs = Date.UTC(
      instant.getUTCFullYear(),
      instant.getUTCMonth(),
      instant.getUTCDate(),
      instant.getUTCHours(),
      instant.getUTCMinutes(),
    )
    return localMs - utcMs
  }

  // Step 1: approximate midnight using the offset at noon
  const noonOffset = offsetMsAt(noonUtc)
  const midnightAsUtc = new Date(Date.UTC(normY, normM - 1, normD, 0, 0, 0))
  const approxMidnight = new Date(midnightAsUtc.getTime() - noonOffset)

  // Step 2: verify offset at the approximate midnight itself.
  // On DST transition days the offset at midnight may differ from noon
  // (e.g. spring-forward at 2 AM: midnight is still in standard time).
  const midnightOffset = offsetMsAt(approxMidnight)
  if (midnightOffset === noonOffset) {
    return approxMidnight
  }
  return new Date(midnightAsUtc.getTime() - midnightOffset)
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
    hourCycle: 'h23',
  }).formatToParts(d)

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00'
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`
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
  const { yesterdayStart, todayStart, tomorrowStart, dayAfterTomorrowStart, nextWeekStart } =
    getTimezoneDayBoundaries(timezone)

  const time = formatTimeInZone(due, timezone)

  // Overdue — due is in the past
  if (due < now) {
    return formatOverdue(due, now, todayStart, yesterdayStart, timezone, time)
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
  yesterdayStart: Date,
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

  const { yesterdayStart, todayStart } = getTimezoneDayBoundaries(timezone)
  const time = formatTimeInZone(snoozedDate, timezone)

  // Today — show time instead of day name (avoids "snoozed from Tue" when today is Tue)
  if (snoozedDate >= todayStart) {
    return `snoozed from ${time}`
  }

  // Yesterday
  if (snoozedDate >= yesterdayStart) {
    return `snoozed from yesterday ${time}`
  }

  // Use calendar-day math (timezone-aware) to decide between day name and date.
  // Day names are only unambiguous within 6 calendar days — e.g., if today is Friday,
  // "Sat" (6 days ago) clearly means last Saturday, but "Fri" (7 days ago) is ambiguous
  // with today.
  const snoozedDateStr = snoozedDate.toLocaleDateString('en-US', { timeZone: timezone })
  const todayStr = now.toLocaleDateString('en-US', { timeZone: timezone })
  const calendarDays = Math.round(
    (new Date(todayStr).getTime() - new Date(snoozedDateStr).getTime()) / (24 * 60 * 60 * 1000),
  )

  if (calendarDays <= 6) {
    const dayName = snoozedDate.toLocaleDateString('en-US', {
      timeZone: timezone,
      weekday: 'short',
    })
    return `snoozed from ${dayName} ${time}`
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
 * Exported for use in activity formatting and anywhere a timezone-aware time string is needed.
 */
export function formatTimeInTimezone(isoUtc: string, timezone: string): string {
  return formatTimeInZone(new Date(isoUtc), timezone)
}

/**
 * Compact task age for the dashboard TaskRow metadata line.
 *
 * Returns a compact "Xd old" string when the anchor is 1+ calendar days old
 * (in the user's timezone), or null if the anchor is less than 1 day old.
 *
 * Anchor dates (chosen by caller):
 * - One-off tasks: original_due_at ?? created_at (captures deferral time when present)
 * - Recurring tasks: original_due_at ?? due_at
 *
 * Ranges: 1–6d → "Xd old", 7–29d → "Xw old", 30–364d → "Xmo old", 365+ → "Xy old"
 */
export function formatTaskAge(anchorIsoUtc: string, timezone: string): string | null {
  const anchor = new Date(anchorIsoUtc)
  const now = new Date()

  if (anchor > now) return null

  // Use timezone-aware calendar day math (same pattern as formatOverdue)
  const anchorDateStr = anchor.toLocaleDateString('en-US', { timeZone: timezone })
  const todayStr = now.toLocaleDateString('en-US', { timeZone: timezone })
  const anchorDate = new Date(anchorDateStr)
  const today = new Date(todayStr)
  const calendarDays = Math.round((today.getTime() - anchorDate.getTime()) / (24 * 60 * 60 * 1000))

  if (calendarDays < 1) return null

  if (calendarDays < 7) return `${calendarDays}d old`

  if (calendarDays < 30) {
    const weeks = Math.floor(calendarDays / 7)
    return `${weeks}w old`
  }

  if (calendarDays < 365) {
    const months = Math.floor(calendarDays / 30)
    return `${Math.max(1, months)}mo old`
  }

  const years = Math.floor(calendarDays / 365)
  return `${years}y old`
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
    hourCycle: 'h23',
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
