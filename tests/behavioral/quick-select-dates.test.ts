import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  snapToNextPreset,
  adjustDate,
  initWorkingDate,
  formatQuickSelectHeader,
  formatRelativeTime,
  formatDeltaText,
  snapToNextHour,
} from '@/lib/quick-select-dates'

const TZ = 'America/Chicago' // UTC-6 (CST) / UTC-5 (CDT)

afterEach(() => {
  vi.useRealTimers()
})

describe('snapToNextPreset', () => {
  it('returns today if the preset time has not passed', () => {
    // 8 AM CST = 14:00 UTC
    const now = new Date('2025-02-03T14:00:00.000Z')
    const result = snapToNextPreset(9, 0, TZ, now) // 9 AM CST
    // 9 AM CST = 15:00 UTC on Feb 3
    expect(new Date(result).toISOString()).toBe('2025-02-03T15:00:00.000Z')
  })

  it('returns tomorrow if the preset time has passed today', () => {
    // 10 AM CST = 16:00 UTC
    const now = new Date('2025-02-03T16:00:00.000Z')
    const result = snapToNextPreset(9, 0, TZ, now) // 9 AM CST
    // 9 AM CST = 15:00 UTC on Feb 4
    expect(new Date(result).toISOString()).toBe('2025-02-04T15:00:00.000Z')
  })

  it('returns today for a later preset', () => {
    // 3 PM CST = 21:00 UTC
    const now = new Date('2025-02-03T21:00:00.000Z')
    const result = snapToNextPreset(20, 30, TZ, now) // 8:30 PM CST
    // 8:30 PM CST = 02:30 UTC on Feb 4
    expect(new Date(result).toISOString()).toBe('2025-02-04T02:30:00.000Z')
  })

  it('handles midnight boundary for timezones ahead of UTC', () => {
    const tokyoTz = 'Asia/Tokyo' // UTC+9
    // 8 AM JST = 23:00 UTC previous day
    const now = new Date('2025-02-02T23:00:00.000Z') // Feb 3 8AM JST
    const result = snapToNextPreset(9, 0, tokyoTz, now) // 9 AM JST
    // 9 AM JST = 00:00 UTC on Feb 3
    expect(new Date(result).toISOString()).toBe('2025-02-03T00:00:00.000Z')
  })
})

describe('adjustDate', () => {
  const baseDate = '2025-02-03T15:00:00.000Z' // 9 AM CST

  it('adds minutes', () => {
    const result = adjustDate(baseDate, { minutes: 30 }, TZ)
    expect(new Date(result).toISOString()).toBe('2025-02-03T15:30:00.000Z')
  })

  it('subtracts minutes', () => {
    const result = adjustDate(baseDate, { minutes: -5 }, TZ)
    expect(new Date(result).toISOString()).toBe('2025-02-03T14:55:00.000Z')
  })

  it('adds 1 hour', () => {
    const result = adjustDate(baseDate, { minutes: 60 }, TZ)
    expect(new Date(result).toISOString()).toBe('2025-02-03T16:00:00.000Z')
  })

  it('subtracts 1 hour', () => {
    const result = adjustDate(baseDate, { minutes: -60 }, TZ)
    expect(new Date(result).toISOString()).toBe('2025-02-03T14:00:00.000Z')
  })

  it('adds 1 calendar day preserving wall-clock time', () => {
    const result = adjustDate(baseDate, { minutes: null, days: 1 }, TZ)
    // Feb 4 9 AM CST = 15:00 UTC
    expect(new Date(result).toISOString()).toBe('2025-02-04T15:00:00.000Z')
  })

  it('subtracts 1 calendar day preserving wall-clock time', () => {
    const result = adjustDate(baseDate, { minutes: null, days: -1 }, TZ)
    // Feb 2 9 AM CST = 15:00 UTC
    expect(new Date(result).toISOString()).toBe('2025-02-02T15:00:00.000Z')
  })

  it('handles DST spring-forward (+1 day preserves wall-clock time)', () => {
    // March 9, 2025 is spring-forward in America/Chicago (CST->CDT)
    // 9 AM CST on March 8 = 15:00 UTC
    const preDst = '2025-03-08T15:00:00.000Z'
    const result = adjustDate(preDst, { minutes: null, days: 1 }, TZ)
    // 9 AM CDT on March 9 = 14:00 UTC (offset changed from -6 to -5)
    expect(new Date(result).toISOString()).toBe('2025-03-09T14:00:00.000Z')
  })

  it('cumulative increments work correctly', () => {
    // +1 hr then +30 min = +1.5 hrs
    const step1 = adjustDate(baseDate, { minutes: 60 }, TZ)
    const step2 = adjustDate(step1, { minutes: 30 }, TZ)
    expect(new Date(step2).toISOString()).toBe('2025-02-03T16:30:00.000Z')
  })
})

describe('initWorkingDate', () => {
  it('returns due_at when present', () => {
    const dueAt = '2025-02-03T15:00:00.000Z'
    expect(initWorkingDate(dueAt)).toBe(dueAt)
  })

  it('returns near-now time snapped to 5-minute boundary when no due_at', () => {
    const now = new Date('2025-02-03T14:23:00.000Z')
    const result = initWorkingDate(null, now)
    // 14:23 → snapped to 14:25 (next 5-minute mark)
    expect(new Date(result).toISOString()).toBe('2025-02-03T14:25:00.000Z')
  })

  it('snaps forward when exactly on a 5-minute mark', () => {
    const now = new Date('2025-02-03T14:00:00.000Z')
    const result = initWorkingDate(null, now)
    // Exactly on the mark → snap to 14:05
    expect(new Date(result).toISOString()).toBe('2025-02-03T14:05:00.000Z')
  })
})

describe('formatQuickSelectHeader', () => {
  it('shows "Today" for today\'s date', () => {
    // Feb 3, 2025 9:00 AM CST, now is Feb 3 8 AM CST
    vi.setSystemTime(new Date('2025-02-03T14:00:00.000Z')) // 8 AM CST
    const result = formatQuickSelectHeader('2025-02-03T15:00:00.000Z', TZ)
    expect(result).toContain('Today')
    expect(result).toContain('Feb')
    expect(result).toContain('3')
    expect(result).toContain('9:00')
    expect(result).toContain('AM')
  })

  it('shows "Tomorrow" for tomorrow\'s date', () => {
    vi.setSystemTime(new Date('2025-02-03T14:00:00.000Z')) // 8 AM CST Feb 3
    const result = formatQuickSelectHeader('2025-02-04T15:00:00.000Z', TZ) // Feb 4 9 AM CST
    expect(result).toContain('Tomorrow')
    expect(result).toContain('Feb')
    expect(result).toContain('4')
  })

  it('shows "Yesterday" for yesterday\'s date', () => {
    vi.setSystemTime(new Date('2025-02-03T14:00:00.000Z')) // 8 AM CST Feb 3
    const result = formatQuickSelectHeader('2025-02-02T15:00:00.000Z', TZ) // Feb 2 9 AM CST
    expect(result).toContain('Yesterday')
    expect(result).toContain('Feb')
    expect(result).toContain('2')
  })

  it('shows weekday for dates beyond yesterday/tomorrow', () => {
    vi.setSystemTime(new Date('2025-02-03T14:00:00.000Z')) // 8 AM CST Feb 3
    const result = formatQuickSelectHeader('2025-02-05T15:00:00.000Z', TZ) // Feb 5 9 AM CST (Wednesday)
    expect(result).toContain('Wed')
    expect(result).toContain('Feb')
    expect(result).toContain('5')
  })
})

describe('formatRelativeTime', () => {
  it('shows "in X mins" for near-future dates', () => {
    const now = new Date('2025-02-03T15:00:00.000Z')
    const future = '2025-02-03T15:26:00.000Z'
    expect(formatRelativeTime(future, now)).toBe('in 26 mins')
  })

  it('shows "in 1 min" for singular', () => {
    const now = new Date('2025-02-03T15:00:00.000Z')
    const future = '2025-02-03T15:01:30.000Z' // 1.5 min, floor = 1
    expect(formatRelativeTime(future, now)).toBe('in 1 min')
  })

  it('shows "in Xh Ym" for hours', () => {
    const now = new Date('2025-02-03T15:00:00.000Z')
    const future = '2025-02-03T17:30:00.000Z'
    expect(formatRelativeTime(future, now)).toBe('in 2h 30m')
  })

  it('shows "Xh ago" for past dates', () => {
    const now = new Date('2025-02-03T17:00:00.000Z')
    const past = '2025-02-03T15:00:00.000Z'
    expect(formatRelativeTime(past, now)).toBe('2h ago')
  })

  it('shows days for longer durations', () => {
    const now = new Date('2025-02-05T15:00:00.000Z')
    const past = '2025-02-03T15:00:00.000Z'
    expect(formatRelativeTime(past, now)).toBe('2 days ago')
  })

  it('shows "in <1 min" for very small future differences', () => {
    const now = new Date('2025-02-03T15:00:00.000Z')
    const near = '2025-02-03T15:00:30.000Z'
    expect(formatRelativeTime(near, now)).toBe('in <1 min')
  })

  it('shows "just now" for very small past differences', () => {
    const now = new Date('2025-02-03T15:00:30.000Z')
    const recent = '2025-02-03T15:00:00.000Z'
    expect(formatRelativeTime(recent, now)).toBe('just now')
  })
})

describe('preset + increment composition', () => {
  // These tests verify that adjustDate can chain increments on top of preset values,
  // which is the core mechanism for Bug 1 (bulk preset→increment dropping the preset).

  it('preset 12 PM + 1 hour = 1 PM', () => {
    // 12 PM CST = 18:00 UTC
    const preset = snapToNextPreset(12, 0, TZ, new Date('2025-02-03T14:00:00.000Z'))
    expect(new Date(preset).toISOString()).toBe('2025-02-03T18:00:00.000Z')

    const result = adjustDate(preset, { minutes: 60 }, TZ)
    // 1 PM CST = 19:00 UTC
    expect(new Date(result).toISOString()).toBe('2025-02-03T19:00:00.000Z')
  })

  it('preset 12 PM - 5 min = 11:55 AM', () => {
    const preset = snapToNextPreset(12, 0, TZ, new Date('2025-02-03T14:00:00.000Z'))
    const result = adjustDate(preset, { minutes: -5 }, TZ)
    // 11:55 AM CST = 17:55 UTC
    expect(new Date(result).toISOString()).toBe('2025-02-03T17:55:00.000Z')
  })

  it('preset 12 PM + 1 day = 12 PM tomorrow', () => {
    const preset = snapToNextPreset(12, 0, TZ, new Date('2025-02-03T14:00:00.000Z'))
    const result = adjustDate(preset, { minutes: null, days: 1 }, TZ)
    // Feb 4, 12 PM CST = 18:00 UTC
    expect(new Date(result).toISOString()).toBe('2025-02-04T18:00:00.000Z')
  })

  it('chains multiple increments: preset 12 PM + 1h + 30m - 5m = 1:25 PM', () => {
    const preset = snapToNextPreset(12, 0, TZ, new Date('2025-02-03T14:00:00.000Z'))
    const step1 = adjustDate(preset, { minutes: 60 }, TZ)
    const step2 = adjustDate(step1, { minutes: 30 }, TZ)
    const step3 = adjustDate(step2, { minutes: -5 }, TZ)
    // 1:25 PM CST = 19:25 UTC
    expect(new Date(step3).toISOString()).toBe('2025-02-03T19:25:00.000Z')
  })

  it('initWorkingDate + increment gives near-now result for no-due-date tasks', () => {
    const now = new Date('2025-02-03T18:53:00.000Z') // 12:53 PM CST
    const working = initWorkingDate(null, now)
    // Should be 18:55 (snapped to 5-min), not ~20:00 (old hour-roundup)
    expect(new Date(working).toISOString()).toBe('2025-02-03T18:55:00.000Z')

    const plusOne = adjustDate(working, { minutes: 1 }, TZ)
    // 18:56 — close to "now + 1 min"
    expect(new Date(plusOne).toISOString()).toBe('2025-02-03T18:56:00.000Z')
  })
})

describe('formatDeltaText', () => {
  it('formats positive minutes', () => {
    expect(formatDeltaText(30)).toBe('+30m')
  })

  it('formats negative minutes', () => {
    expect(formatDeltaText(-5)).toBe('-5m')
  })

  it('formats positive hours', () => {
    expect(formatDeltaText(60)).toBe('+1h')
  })

  it('formats negative hours', () => {
    expect(formatDeltaText(-120)).toBe('-2h')
  })

  it('formats hours and minutes', () => {
    expect(formatDeltaText(90)).toBe('+1h 30m')
  })

  it('formats negative hours and minutes', () => {
    expect(formatDeltaText(-90)).toBe('-1h 30m')
  })

  it('formats exact day boundary', () => {
    expect(formatDeltaText(1440)).toBe('+1d')
  })

  it('formats negative day', () => {
    expect(formatDeltaText(-1440)).toBe('-1d')
  })

  it('formats days and hours', () => {
    // 25 hours = 1d 1h
    expect(formatDeltaText(1500)).toBe('+1d 1h')
  })

  it('formats multi-day with hours', () => {
    // 50 hours = 2d 2h
    expect(formatDeltaText(3000)).toBe('+2d 2h')
  })

  it('formats 1 minute', () => {
    expect(formatDeltaText(1)).toBe('+1m')
  })

  it('formats zero as +0m', () => {
    // Edge case: callers guard against this, but documenting the behavior
    expect(formatDeltaText(0)).toBe('+0m')
  })
})

describe('snapToNextHour', () => {
  it('rounds to next hour when minutes < 35', () => {
    // 1:30 PM → 2:00 PM
    const now = new Date('2025-02-03T19:30:00.000Z') // 1:30 PM CST
    const result = snapToNextHour(now)
    expect(new Date(result).toISOString()).toBe('2025-02-03T20:00:00.000Z')
  })

  it('skips to hour after next when minutes >= 35', () => {
    // 1:37 PM → 3:00 PM
    const now = new Date('2025-02-03T19:37:00.000Z') // 1:37 PM CST
    const result = snapToNextHour(now)
    expect(new Date(result).toISOString()).toBe('2025-02-03T21:00:00.000Z')
  })

  it('skips to hour after next at exactly minute 35', () => {
    // 1:35 PM → 3:00 PM (>= 35 threshold)
    const now = new Date('2025-02-03T19:35:00.000Z')
    const result = snapToNextHour(now)
    expect(new Date(result).toISOString()).toBe('2025-02-03T21:00:00.000Z')
  })

  it('rounds to next hour at minute 34', () => {
    // 1:34 PM → 2:00 PM (< 35 threshold)
    const now = new Date('2025-02-03T19:34:00.000Z')
    const result = snapToNextHour(now)
    expect(new Date(result).toISOString()).toBe('2025-02-03T20:00:00.000Z')
  })

  it('rounds to next hour at minute 0', () => {
    // Exactly on the hour → next hour
    const now = new Date('2025-02-03T19:00:00.000Z')
    const result = snapToNextHour(now)
    expect(new Date(result).toISOString()).toBe('2025-02-03T20:00:00.000Z')
  })

  it('handles near-midnight rollover (minutes < 35)', () => {
    // 11:30 PM → 12:00 AM next day
    const now = new Date('2025-02-03T23:30:00.000Z')
    const result = snapToNextHour(now)
    expect(new Date(result).toISOString()).toBe('2025-02-04T00:00:00.000Z')
  })

  it('handles near-midnight rollover (minutes >= 35)', () => {
    // 11:40 PM → 1:00 AM next day
    const now = new Date('2025-02-03T23:40:00.000Z')
    const result = snapToNextHour(now)
    expect(new Date(result).toISOString()).toBe('2025-02-04T01:00:00.000Z')
  })

  it('zeroes out seconds and milliseconds', () => {
    const now = new Date('2025-02-03T19:15:45.123Z')
    const result = snapToNextHour(now)
    expect(new Date(result).toISOString()).toBe('2025-02-03T20:00:00.000Z')
  })
})

describe('adjustDate DST fall-back', () => {
  // Nov 2, 2025 is fall-back in America/Chicago (CDT->CST).
  // Clocks fall back at 2:00 AM CDT → 1:00 AM CST, so the 1:00-2:00 AM
  // wall-clock hour occurs twice. Calendar-day arithmetic should preserve
  // wall-clock time and pick the correct offset on the destination day.

  it('+1 day across fall-back preserves wall-clock time', () => {
    // 9 AM CDT on Nov 1 = 14:00 UTC
    const preFallBack = '2025-11-01T14:00:00.000Z'
    const result = adjustDate(preFallBack, { minutes: null, days: 1 }, TZ)
    // 9 AM CST on Nov 2 = 15:00 UTC (offset changed from -5 to -6)
    expect(new Date(result).toISOString()).toBe('2025-11-02T15:00:00.000Z')
  })

  it('-1 day across fall-back preserves wall-clock time', () => {
    // 9 AM CST on Nov 2 = 15:00 UTC
    const postFallBack = '2025-11-02T15:00:00.000Z'
    const result = adjustDate(postFallBack, { minutes: null, days: -1 }, TZ)
    // 9 AM CDT on Nov 1 = 14:00 UTC (offset changed from -6 to -5)
    expect(new Date(result).toISOString()).toBe('2025-11-01T14:00:00.000Z')
  })

  it('+1 day across fall-back at a non-ambiguous evening time', () => {
    // 8 PM CDT on Nov 1 = 01:00 UTC Nov 2 (CDT = UTC-5)
    const eveningBeforeFallBack = '2025-11-02T01:00:00.000Z'
    const result = adjustDate(eveningBeforeFallBack, { minutes: null, days: 1 }, TZ)
    // 8 PM CST on Nov 2 = 02:00 UTC Nov 3 (CST = UTC-6, offset shifted)
    expect(new Date(result).toISOString()).toBe('2025-11-03T02:00:00.000Z')
  })
})
