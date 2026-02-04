/**
 * Pure function tests for date and RRULE formatting utilities.
 *
 * No DB, no HTTP — tests formatDueTimeParts, formatSnoozedFrom, and formatRRuleCompact.
 */

import { describe, test, expect, vi, afterEach } from 'vitest'
import { formatDueTimeParts, formatSnoozedFrom, formatDurationDelta } from '@/lib/format-date'
import { formatRRuleCompact } from '@/lib/format-rrule'

const TZ = 'America/Chicago'

describe('formatDueTimeParts', () => {
  test('overdue <1m ago shows "just now" with time', () => {
    vi.setSystemTime(new Date('2025-02-01T12:00:00Z'))
    // 30 seconds ago — 5:59 AM CST
    const result = formatDueTimeParts('2025-02-01T11:59:30Z', TZ)
    expect(result.relative).toBe('just now')
    expect(result.absolute).toBe('5:59 AM')
  })

  test('overdue 10m ago today shows "10m ago" with time', () => {
    vi.setSystemTime(new Date('2025-02-01T12:00:00Z'))
    const result = formatDueTimeParts('2025-02-01T11:50:00Z', TZ) // 5:50 AM CST
    expect(result.relative).toBe('10m ago')
    expect(result.absolute).toBe('5:50 AM')
  })

  test('overdue 3h ago today shows "3h ago" with time', () => {
    vi.setSystemTime(new Date('2025-02-01T15:00:00Z')) // 9:00 AM CST
    const result = formatDueTimeParts('2025-02-01T12:00:00Z', TZ) // 6:00 AM CST
    expect(result.relative).toBe('3h ago')
    expect(result.absolute).toBe('6:00 AM')
  })

  test('overdue yesterday shows "yesterday" with time', () => {
    vi.setSystemTime(new Date('2025-02-02T12:00:00Z')) // Feb 2 6:00 AM CST
    const result = formatDueTimeParts('2025-02-01T15:00:00Z', TZ) // Feb 1 9:00 AM CST
    expect(result.relative).toBe('yesterday')
    expect(result.absolute).toBe('9:00 AM')
  })

  test('overdue 3 days ago shows "3d ago" with date and time', () => {
    vi.setSystemTime(new Date('2025-02-05T12:00:00Z'))
    const result = formatDueTimeParts('2025-02-02T12:00:00Z', TZ) // Feb 2 6:00 AM CST
    expect(result.relative).toBe('3d ago')
    expect(result.absolute).toBe('Feb 2 6:00 AM')
  })

  test('overdue 2 weeks ago shows "2w ago" with date and time', () => {
    vi.setSystemTime(new Date('2025-02-15T12:00:00Z'))
    const result = formatDueTimeParts('2025-02-01T12:00:00Z', TZ) // Feb 1 6:00 AM CST
    expect(result.relative).toBe('2w ago')
    expect(result.absolute).toBe('Feb 1 6:00 AM')
  })

  test('overdue 2 months ago shows "2mo ago" with date and time', () => {
    vi.setSystemTime(new Date('2025-04-01T12:00:00Z'))
    const result = formatDueTimeParts('2025-02-01T12:00:00Z', TZ) // Feb 1 6:00 AM CST
    expect(result.relative).toBe('2mo ago')
    expect(result.absolute).toBe('Feb 1 6:00 AM')
  })

  test('due in <1 minute shows "in <1m" with absolute time', () => {
    vi.setSystemTime(new Date('2025-02-01T12:00:00Z'))
    const result = formatDueTimeParts('2025-02-01T12:00:25Z', TZ) // 25s from now
    expect(result.relative).toBe('in <1m')
    expect(result.absolute).toBe('6:00 AM')
  })

  test('due in 10 minutes shows "in 10m" with absolute time', () => {
    vi.setSystemTime(new Date('2025-02-01T12:00:00Z'))
    const result = formatDueTimeParts('2025-02-01T12:10:00Z', TZ)
    expect(result.relative).toBe('in 10m')
    expect(result.absolute).toBe('6:10 AM')
  })

  test('due in 90 minutes shows "in 1h 30m" with absolute time', () => {
    vi.setSystemTime(new Date('2025-02-01T12:00:00Z'))
    const result = formatDueTimeParts('2025-02-01T13:30:00Z', TZ)
    expect(result.relative).toBe('in 1h 30m')
    expect(result.absolute).toBe('7:30 AM')
  })

  test('due in 120 minutes shows "in 2h" with absolute time', () => {
    vi.setSystemTime(new Date('2025-02-01T12:00:00Z'))
    const result = formatDueTimeParts('2025-02-01T14:00:00Z', TZ)
    expect(result.relative).toBe('in 2h')
    expect(result.absolute).toBe('8:00 AM')
  })

  test('due in exactly 3h shows just the time (no "in X")', () => {
    vi.setSystemTime(new Date('2025-02-01T12:00:00Z'))
    const result = formatDueTimeParts('2025-02-01T15:00:00Z', TZ) // exactly 180m
    expect(result.relative).toBe('9:00 AM')
    expect(result.absolute).toBeUndefined()
  })

  test('due today past 3h shows just the time', () => {
    // "now" = 6:00 AM CST, task due at 10:00 AM CST (4h away)
    vi.setSystemTime(new Date('2025-02-01T12:00:00Z'))
    const result = formatDueTimeParts('2025-02-01T16:00:00Z', TZ)
    expect(result.relative).toBe('10:00 AM')
    expect(result.absolute).toBeUndefined()
  })

  test('due tomorrow shows "Tomorrow" prefix', () => {
    vi.setSystemTime(new Date('2025-02-01T12:00:00Z'))
    const result = formatDueTimeParts('2025-02-02T15:00:00Z', TZ) // 9:00 AM CST on Feb 2
    expect(result.relative).toBe('Tomorrow 9:00 AM')
    expect(result.absolute).toBeUndefined()
  })

  test('due within 7 days (after tomorrow) shows weekday', () => {
    // Feb 1 (Sat) → Feb 4 (Tue) is within 7 days and after tomorrow
    vi.setSystemTime(new Date('2025-02-01T12:00:00Z'))
    const result = formatDueTimeParts('2025-02-04T15:00:00Z', TZ) // 9:00 AM CST on Tue Feb 4
    expect(result.relative).toBe('Tue 9:00 AM')
  })

  test('due beyond 7 days shows month and day', () => {
    // Feb 1 → Feb 11 is beyond 7 days
    vi.setSystemTime(new Date('2025-02-01T12:00:00Z'))
    const result = formatDueTimeParts('2025-02-11T15:00:00Z', TZ) // 9:00 AM CST on Feb 11
    expect(result.relative).toBe('Feb 11 9:00 AM')
  })

  afterEach(() => {
    vi.useRealTimers()
  })
})

describe('formatSnoozedFrom', () => {
  test('returns null for future snoozed_from', () => {
    vi.setSystemTime(new Date('2025-02-05T12:00:00Z'))
    const result = formatSnoozedFrom('2025-02-06T12:00:00Z', TZ)
    expect(result).toBeNull()
  })

  test('within 7 days shows weekday', () => {
    vi.setSystemTime(new Date('2025-02-05T12:00:00Z')) // Wednesday
    const result = formatSnoozedFrom('2025-02-03T12:00:00Z', TZ) // Monday
    expect(result).toBe('snoozed from Mon')
  })

  test('older than 7 days shows month and day', () => {
    vi.setSystemTime(new Date('2025-02-05T12:00:00Z'))
    const result = formatSnoozedFrom('2025-01-22T12:00:00Z', TZ) // Jan 22
    expect(result).toBe('snoozed from Jan 22')
  })

  afterEach(() => {
    vi.useRealTimers()
  })
})

describe('formatDurationDelta', () => {
  test('positive minutes', () => {
    const from = new Date('2025-02-01T12:00:00Z').getTime()
    const to = new Date('2025-02-01T12:30:00Z').getTime()
    expect(formatDurationDelta(from, to)).toBe('+30m')
  })

  test('positive hours', () => {
    const from = new Date('2025-02-01T12:00:00Z').getTime()
    const to = new Date('2025-02-01T14:00:00Z').getTime()
    expect(formatDurationDelta(from, to)).toBe('+2h')
  })

  test('positive hours and minutes', () => {
    const from = new Date('2025-02-01T12:00:00Z').getTime()
    const to = new Date('2025-02-01T14:30:00Z').getTime()
    expect(formatDurationDelta(from, to)).toBe('+2h30m')
  })

  test('positive days', () => {
    const from = new Date('2025-02-01T12:00:00Z').getTime()
    const to = new Date('2025-02-03T12:00:00Z').getTime()
    expect(formatDurationDelta(from, to)).toBe('+2d')
  })

  test('positive weeks', () => {
    const from = new Date('2025-02-01T12:00:00Z').getTime()
    const to = new Date('2025-02-08T12:00:00Z').getTime()
    expect(formatDurationDelta(from, to)).toBe('+1w')
  })

  test('negative minutes (rescheduled earlier)', () => {
    const from = new Date('2025-02-01T12:30:00Z').getTime()
    const to = new Date('2025-02-01T12:00:00Z').getTime()
    expect(formatDurationDelta(from, to)).toBe('-30m')
  })

  test('negative hours', () => {
    const from = new Date('2025-02-01T14:00:00Z').getTime()
    const to = new Date('2025-02-01T12:00:00Z').getTime()
    expect(formatDurationDelta(from, to)).toBe('-2h')
  })

  test('zero difference', () => {
    const time = new Date('2025-02-01T12:00:00Z').getTime()
    expect(formatDurationDelta(time, time)).toBe('+0m')
  })
})

describe('formatRRuleCompact', () => {
  test('daily', () => {
    expect(formatRRuleCompact('FREQ=DAILY')).toBe('Daily')
  })

  test('daily with time', () => {
    expect(formatRRuleCompact('FREQ=DAILY;BYHOUR=8;BYMINUTE=0')).toBe('Daily at 8:00 AM')
  })

  test('every 3 days', () => {
    expect(formatRRuleCompact('FREQ=DAILY;INTERVAL=3')).toBe('Every 3 days')
  })

  test('weekdays', () => {
    expect(formatRRuleCompact('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR')).toBe('Weekdays')
  })

  test('weekends', () => {
    expect(formatRRuleCompact('FREQ=WEEKLY;BYDAY=SA,SU')).toBe('Weekends')
  })

  test('all 7 days → Daily', () => {
    expect(formatRRuleCompact('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU')).toBe('Daily')
  })

  test('M,W,F comma-separated', () => {
    expect(formatRRuleCompact('FREQ=WEEKLY;BYDAY=MO,WE,FR')).toBe('M, W, F')
  })

  test('Tu,W,Th,Sa comma-separated (sorted)', () => {
    expect(formatRRuleCompact('FREQ=WEEKLY;BYDAY=SA,TU,WE,TH')).toBe('Tu, W, Th, Sa')
  })

  test('single day weekly → plural', () => {
    expect(formatRRuleCompact('FREQ=WEEKLY;BYDAY=FR')).toBe('Fridays')
    expect(formatRRuleCompact('FREQ=WEEKLY;BYDAY=MO')).toBe('Mondays')
  })

  test('every 2 weeks', () => {
    expect(formatRRuleCompact('FREQ=WEEKLY;INTERVAL=2;BYDAY=FR')).toBe('Every 2 weeks on F')
  })

  test('every 2 weeks multiple days', () => {
    expect(formatRRuleCompact('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE')).toBe('Every 2 weeks on M, W')
  })

  test('monthly by day of month', () => {
    expect(formatRRuleCompact('FREQ=MONTHLY;BYMONTHDAY=1')).toBe('Monthly on the 1st')
    expect(formatRRuleCompact('FREQ=MONTHLY;BYMONTHDAY=15')).toBe('Monthly on the 15th')
  })

  test('monthly by day of week', () => {
    expect(formatRRuleCompact('FREQ=MONTHLY;BYDAY=TH')).toBe('Monthly on Thu')
  })

  test('every 2 months', () => {
    expect(formatRRuleCompact('FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=1')).toBe(
      'Every 2 months on the 1st',
    )
  })

  test('yearly', () => {
    expect(formatRRuleCompact('FREQ=YEARLY')).toBe('Yearly')
  })

  test('every 2 years', () => {
    expect(formatRRuleCompact('FREQ=YEARLY;INTERVAL=2')).toBe('Every 2 years')
  })

  test('weekly with no days', () => {
    expect(formatRRuleCompact('FREQ=WEEKLY')).toBe('Weekly')
  })

  test('weekly with time parts shows time', () => {
    expect(formatRRuleCompact('FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=9;BYMINUTE=0')).toBe(
      'M, W, F at 9:00 AM',
    )
  })

  test('compact with anchor_time shows time', () => {
    expect(formatRRuleCompact('FREQ=DAILY', '14:30')).toBe('Daily at 2:30 PM')
    expect(formatRRuleCompact('FREQ=WEEKLY;BYDAY=FR', '09:00')).toBe('Fridays at 9:00 AM')
  })
})
