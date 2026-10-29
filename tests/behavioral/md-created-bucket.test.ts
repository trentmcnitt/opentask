/**
 * Scan's age steps (`src/lib/created-bucket.ts`): the created-date bucket in
 * OpenTask days — the 3:00 AM boundary, the calendar month and year — and
 * each bucket's grey. Chicago, a 3:00 AM day start.
 */
import { describe, expect, test } from 'vitest'
import { DateTime } from 'luxon'
import { AGE_STEP_GREYS, createdBucket } from '@/lib/created-bucket'
import { AGE_STEP_CLASS } from '@/components/modes/age-step'

const TZ = 'America/Chicago'
const DS = '03:00'
const iso = (local: string) => DateTime.fromISO(local, { zone: TZ }).toUTC().toISO()!
const at = (local: string) => new Date(iso(local))
const bucket = (created: string, now: string) => createdBucket(iso(created), at(now), TZ, DS)

describe('createdBucket', () => {
  const now = '2026-10-29T10:07' // a Thursday

  test('today, yesterday, then the week (2–6 days)', () => {
    expect(bucket('2026-10-29T08:00', now)).toBe('today')
    expect(bucket('2026-10-28T22:38', now)).toBe('yesterday')
    expect(bucket('2026-10-27T09:00', now)).toBe('week')
    expect(bucket('2026-10-23T09:00', now)).toBe('week')
  })

  test('the 3:00 AM boundary: 2:30 AM is still the day before', () => {
    expect(bucket('2026-10-29T02:30', now)).toBe('yesterday')
    expect(bucket('2026-10-29T03:00', now)).toBe('today')
    // At 1:00 AM it is still Wednesday's OpenTask day: Wednesday 9 AM is today.
    expect(bucket('2026-10-28T09:00', '2026-10-29T01:00')).toBe('today')
    expect(bucket('2026-10-27T23:00', '2026-10-29T01:00')).toBe('yesterday')
  })

  test('the calendar month, then the calendar year, then earlier', () => {
    expect(bucket('2026-10-22T09:00', now)).toBe('month')
    expect(bucket('2026-10-01T09:00', now)).toBe('month')
    expect(bucket('2026-09-30T09:00', now)).toBe('year')
    expect(bucket('2026-01-01T09:00', now)).toBe('year')
    expect(bucket('2025-12-31T09:00', now)).toBe('earlier')
  })

  test('the week wins over the month: early in a month, last month\'s days are "Week"', () => {
    expect(bucket('2026-10-29T09:00', '2026-11-02T10:00')).toBe('week')
    expect(bucket('2026-10-26T09:00', '2026-11-02T10:00')).toBe('year')
  })

  test('the month boundary is the OpenTask date: Nov 1 at 2 AM is October 31', () => {
    expect(bucket('2026-11-01T02:00', '2026-11-09T10:00')).toBe('year')
    expect(bucket('2026-11-01T03:30', '2026-11-09T10:00')).toBe('month')
  })

  test('the year boundary is the OpenTask date too', () => {
    expect(bucket('2026-01-01T01:00', '2026-01-20T10:00')).toBe('earlier')
    expect(bucket('2026-01-01T04:00', '2026-01-20T10:00')).toBe('month')
  })

  test('a created date just ahead of the clock is today', () => {
    expect(bucket('2026-10-29T10:08', now)).toBe('today')
  })
})

describe('the age steps (GS2)', () => {
  test('the greys: light down from white, dark up from the page (+0 / 6 / 11 / 14 / 16 / 17)', () => {
    expect(Object.values(AGE_STEP_GREYS).map((g) => g.light)).toEqual([
      255, 249, 244, 241, 239, 238,
    ])
    expect(Object.values(AGE_STEP_GREYS).map((g) => g.dark - 10)).toEqual([0, 6, 11, 14, 16, 17])
  })

  test('the row classes are those greys, R = G = B, today the page itself', () => {
    expect(AGE_STEP_CLASS.today).toBe('bg-background')
    for (const [bucket, grey] of Object.entries(AGE_STEP_GREYS)) {
      if (bucket === 'today') continue
      const cls = AGE_STEP_CLASS[bucket as keyof typeof AGE_STEP_CLASS]
      expect(cls).toBe(
        `bg-[rgb(${grey.light},${grey.light},${grey.light})] dark:bg-[rgb(${grey.dark},${grey.dark},${grey.dark})]`,
      )
    }
  })
})
