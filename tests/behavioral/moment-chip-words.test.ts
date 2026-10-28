/**
 * The lean row's time-chip words (`src/lib/moment-chip-words.ts`). Pinned:
 * Wed 2026-10-28, noon in Chicago, a 3:00 AM day start.
 */
import { describe, expect, test } from 'vitest'
import { DateTime } from 'luxon'
import { momentChipWords } from '@/lib/moment-chip-words'

const TZ = 'America/Chicago'
const NOW = DateTime.fromISO('2026-10-28T12:00', { zone: TZ }).toJSDate()
const words = (local: string) =>
  momentChipWords(DateTime.fromISO(local, { zone: TZ }).toUTC().toISO()!, TZ, '03:00', NOW)

describe('momentChipWords', () => {
  test('today, tomorrow, yesterday with the time — past or ahead, no "ago"', () => {
    expect(words('2026-10-28T18:00')).toBe('Today 6:00 PM')
    expect(words('2026-10-28T09:00')).toBe('Today 9:00 AM')
    expect(words('2026-10-29T09:00')).toBe('Tomorrow 9:00 AM')
    expect(words('2026-10-27T07:00')).toBe('Yesterday 7:00 AM')
  })

  test('within a week either side: the weekday', () => {
    expect(words('2026-10-26T09:00')).toBe('Mon 9:00 AM')
    expect(words('2026-10-30T17:00')).toBe('Fri 5:00 PM')
  })

  test('the night rule: before the day start counts on the day before', () => {
    // Thu 01:00 is Wednesday's OpenTask night, ahead of noon: "Tonight".
    expect(words('2026-10-29T01:00')).toBe('Tonight 1:00 AM')
    // Fri 01:00 belongs to Thursday's list: tomorrow's night.
    expect(words('2026-10-30T01:00')).toBe('Tomorrow night 1:00 AM')
    // Sat 01:00 is Friday's night: a weekday with the cue.
    expect(words('2026-10-31T01:00')).toBe('Fri night 1:00 AM')
  })

  test('beyond a week: the date; another year adds it', () => {
    expect(words('2026-10-21T09:00')).toBe('Oct 21 9:00 AM')
    expect(words('2026-11-15T23:59')).toBe('Nov 15 11:59 PM')
    expect(words('2025-10-22T09:00')).toBe('Oct 22, 2025 9:00 AM')
  })
})
