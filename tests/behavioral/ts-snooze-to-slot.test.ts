/**
 * Snoozing to a time slot (Trent, 2026-09-22): each slot's next start, and
 * the "next period" a notification's "All → Next period" goes to.
 */
import { describe, expect, test } from 'vitest'
import { nextPeriodStart, nextSlotStart } from '@/lib/time-slot-assign'

const TZ = 'America/Chicago'
/** A Chicago wall-clock moment on 2026-01-15 (CST, UTC−6). */
const at = (hhmm: string) => new Date(`2026-01-15T${hhmm}:00-06:00`)
const SLOTS = ['07:00', '09:00', '12:00', '16:00', '20:30'].map((start_time) => ({ start_time }))

describe('nextSlotStart', () => {
  test('a slot still ahead today is today', () => {
    expect(nextSlotStart('20:30', TZ, at('09:15'))).toBe('2026-01-16T02:30:00.000Z')
  })

  test('a slot already begun is tomorrow', () => {
    expect(nextSlotStart('07:00', TZ, at('21:00'))).toBe('2026-01-16T13:00:00.000Z')
  })

  test('the minute a slot starts counts as begun', () => {
    expect(nextSlotStart('12:00', TZ, at('12:00'))).toBe('2026-01-16T18:00:00.000Z')
  })

  test('tomorrow keeps the local wall-clock time across a DST change', () => {
    // 2026-03-08 is the spring-forward day in Chicago: 7:00 CDT is 12:00 UTC.
    const eve = new Date('2026-03-07T21:00:00-06:00')
    expect(nextSlotStart('07:00', TZ, eve)).toBe('2026-03-08T12:00:00.000Z')
  })

  test('rejects a start that is not HH:MM', () => {
    expect(() => nextSlotStart('7am', TZ, at('09:00'))).toThrow()
  })
})

describe('nextPeriodStart', () => {
  test('mid-morning goes to Midday; mid-Midday to Afternoon', () => {
    expect(nextPeriodStart(SLOTS, TZ, at('10:00'))).toBe('2026-01-15T18:00:00.000Z')
    expect(nextPeriodStart(SLOTS, TZ, at('13:00'))).toBe('2026-01-15T22:00:00.000Z')
  })

  test('after the last slot has begun, tomorrow’s first', () => {
    expect(nextPeriodStart(SLOTS, TZ, at('21:00'))).toBe('2026-01-16T13:00:00.000Z')
  })

  test('before the day’s first slot, that slot today', () => {
    expect(nextPeriodStart(SLOTS, TZ, at('05:00'))).toBe('2026-01-15T13:00:00.000Z')
  })

  test('no slots, no period', () => {
    expect(nextPeriodStart([], TZ, at('10:00'))).toBeNull()
  })
})
