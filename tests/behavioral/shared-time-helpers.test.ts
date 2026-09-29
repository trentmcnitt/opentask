/**
 * The small time and slot helpers that several surfaces share (cleanup A6).
 * Each replaced a copy or two elsewhere, so these pin the outputs the copies
 * produced — a change here shows up on the Reminders page, the dashboard,
 * Settings, the undo toasts and the AI prompts at once.
 */
import { describe, expect, test } from 'vitest'
import { formatClockTime } from '@/lib/time-utils'
import { formatMorningTime } from '@/lib/snooze'
import { calendarDaysBetween } from '@/lib/format-date'
import { slotGroupKey, slotLabel, UNSLOTTED_KEY, UNSLOTTED_LABEL } from '@/lib/reminder-slots'
import { sortSlotsByStart, type TimeSlot } from '@/lib/time-slot-assign'
import { quotaPeriodUnit } from '@/lib/track'
import { slotHasStarted } from '@/lib/reminders-summary'

function slot(id: number, start_time: string, label = `S${id}`): TimeSlot {
  return { id, user_id: 1, label, start_time, sort_order: id, created_at: '' }
}

describe('formatClockTime', () => {
  test.each([
    ['00:00', '12:00 AM'],
    ['07:00', '7:00 AM'],
    ['09:05', '9:05 AM'],
    ['12:00', '12:00 PM'],
    ['20:30', '8:30 PM'],
    ['23:59', '11:59 PM'],
  ])('%s → %s', (input, expected) => {
    expect(formatClockTime(input)).toBe(expected)
    expect(formatMorningTime(input)).toBe(expected)
  })

  test.each(['7:00', '24:00', '12:60', '', 'noon'])('returns %j unchanged', (input) => {
    expect(formatClockTime(input)).toBe(input)
  })
})

describe('calendarDaysBetween', () => {
  const tz = 'America/Chicago'

  test('counts midnights in the given zone, not 24-hour spans', () => {
    // 23:30 → 00:30 the next local day is one calendar day, one hour apart.
    const a = new Date('2026-01-16T05:30:00Z') // Jan 15 23:30 Chicago
    const b = new Date('2026-01-16T06:30:00Z') // Jan 16 00:30 Chicago
    expect(calendarDaysBetween(a, b, tz)).toBe(1)
    expect(calendarDaysBetween(b, a, tz)).toBe(-1)
  })

  test('a DST day is still one day', () => {
    const before = new Date('2026-03-08T06:00:00Z') // Mar 8 00:00 CST
    const after = new Date('2026-03-09T05:00:00Z') // Mar 9 00:00 CDT
    expect(calendarDaysBetween(before, after, tz)).toBe(1)
  })
})

describe('reminder slot identity', () => {
  test('key and label for a slot and for the un-slotted bucket', () => {
    expect(slotGroupKey({ slot: slot(4, '09:00', 'Morning') })).toBe('4')
    expect(slotLabel({ slot: slot(4, '09:00', 'Morning') })).toBe('Morning')
    expect(slotGroupKey({ slot: null })).toBe(UNSLOTTED_KEY)
    expect(slotLabel({ slot: null })).toBe(UNSLOTTED_LABEL)
    expect(UNSLOTTED_KEY).toBe('unslotted')
    expect(UNSLOTTED_LABEL).toBe('Anytime')
  })
})

describe('slotHasStarted', () => {
  test('an invalid timezone counts as started', () => {
    expect(slotHasStarted(slot(1, '23:00'), 'Not/AZone', new Date())).toBe(true)
  })
})

describe('sortSlotsByStart', () => {
  test('orders by time of day and leaves the input alone', () => {
    const input = [slot(1, '16:00'), slot(2, '07:00'), slot(3, '12:00')]
    expect(sortSlotsByStart(input).map((s) => s.id)).toEqual([2, 3, 1])
    expect(input.map((s) => s.id)).toEqual([1, 2, 3])
  })
})

describe('quotaPeriodUnit', () => {
  test.each([
    ['FREQ=DAILY', { unit: 'days', interval: 1 }],
    ['FREQ=WEEKLY;INTERVAL=2', { unit: 'weeks', interval: 2 }],
    ['FREQ=MONTHLY;INTERVAL=0', { unit: 'months', interval: 1 }],
    ['FREQ=YEARLY', { unit: 'years', interval: 1 }],
  ])('%s', (rrule, expected) => {
    expect(quotaPeriodUnit(rrule)).toEqual(expected)
  })

  test('no period for a missing or unknown FREQ', () => {
    expect(quotaPeriodUnit(null)).toBeNull()
    expect(quotaPeriodUnit('FREQ=HOURLY')).toBeNull()
  })
})
