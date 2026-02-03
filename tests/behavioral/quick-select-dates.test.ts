import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  snapToNextPreset,
  adjustDate,
  initWorkingDate,
  formatQuickSelectHeader,
  formatRelativeTime,
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

  it('returns now + ~1 hour rounded up to next hour when no due_at', () => {
    const now = new Date('2025-02-03T14:23:00.000Z')
    const result = initWorkingDate(null, now)
    // 14:23 + 1h = 15:23, rounded up to 16:00
    expect(new Date(result).toISOString()).toBe('2025-02-03T16:00:00.000Z')
  })

  it('handles exact hour boundary', () => {
    const now = new Date('2025-02-03T14:00:00.000Z')
    const result = initWorkingDate(null, now)
    // 14:00 + 1h = 15:00, already on the hour
    expect(new Date(result).toISOString()).toBe('2025-02-03T15:00:00.000Z')
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
