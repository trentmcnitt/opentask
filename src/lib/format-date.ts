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
 * Relative due time for task rows: "9:00 AM", "Tomorrow 9:00 AM", "Wed, Jan 5"
 */
export function formatDueTime(isoUtc: string, timezone: string): string {
  const due = new Date(isoUtc)
  const { todayStart, tomorrowStart, dayAfterTomorrowStart } = getTimezoneDayBoundaries(timezone)

  const time = due.toLocaleTimeString('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })

  if (due < todayStart) {
    // Past — show date + time
    return (
      due.toLocaleDateString('en-US', {
        timeZone: timezone,
        month: 'short',
        day: 'numeric',
      }) +
      ' ' +
      time
    )
  } else if (due < tomorrowStart) {
    return time
  } else if (due < dayAfterTomorrowStart) {
    return 'Tomorrow ' + time
  } else {
    return due.toLocaleDateString('en-US', {
      timeZone: timezone,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    })
  }
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

/**
 * Parse a datetime-local input value ("YYYY-MM-DDTHH:MM") as the user's timezone
 * and return a UTC ISO string.
 *
 * This is the inverse of toLocalDatetimeInput(): that function converts UTC → local display,
 * and this function converts local input → UTC for storage.
 */
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
