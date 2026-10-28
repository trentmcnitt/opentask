/**
 * The lean row's created date (`src/lib/created-date.ts`): the wording rule
 * on the OpenTask day. Pinned: Wed 2026-10-28, noon in Chicago, a 3:00 AM
 * day start.
 */
import { describe, expect, test } from 'vitest'
import { DateTime } from 'luxon'
import { createdDateWords } from '@/lib/created-date'

const TZ = 'America/Chicago'
const NOW = DateTime.fromISO('2026-10-28T12:00', { zone: TZ }).toJSDate()
const words = (local: string, dayStart = '03:00') =>
  createdDateWords(DateTime.fromISO(local, { zone: TZ }).toUTC().toISO()!, TZ, dayStart, NOW)

describe('createdDateWords', () => {
  test('today and yesterday carry the time', () => {
    expect(words('2026-10-28T09:14')).toBe('today 9:14 AM')
    expect(words('2026-10-27T16:30')).toBe('yesterday 4:30 PM')
  })

  test('before the day start it is still the day before (the OpenTask day)', () => {
    expect(words('2026-10-28T01:30')).toBe('yesterday 1:30 AM')
    // With a midnight day start, 1:30 AM is today.
    expect(words('2026-10-28T01:30', '00:00')).toBe('today 1:30 AM')
  })

  test('2–6 days ago: the weekday', () => {
    expect(words('2026-10-26T10:00')).toBe('Mon')
    expect(words('2026-10-22T10:00')).toBe('Thu')
  })

  test('a week or more this year: the date; an earlier year: month and year', () => {
    expect(words('2026-10-21T10:00')).toBe('Oct 21')
    expect(words('2026-01-02T10:00')).toBe('Jan 2')
    expect(words('2025-03-22T10:00')).toBe('Mar 2025')
  })
})
