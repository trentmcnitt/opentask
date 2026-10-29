/**
 * The lean row's chip words (`src/lib/lean-chip-words.ts`): the deadline
 * countdown's hour math and "Today" once per row. Chicago, a 3:00 AM day start.
 */
import { describe, expect, test } from 'vitest'
import { DateTime } from 'luxon'
import { countdownWords, leanChipWords } from '@/lib/lean-chip-words'

const TZ = 'America/Chicago'
const at = (local: string) => DateTime.fromISO(local, { zone: TZ }).toJSDate()
const iso = (local: string) => at(local).toISOString()

describe('countdownWords: whole hours from the next top of the hour', () => {
  test('8:30 AM to a 6 PM deadline is "in 9 hrs"', () => {
    expect(countdownWords(at('2026-10-28T18:00'), TZ, at('2026-10-28T08:30'))).toBe('in 9 hrs')
  })
  test('7:05 PM to an 8 PM deadline is "in <1 hr"', () => {
    expect(countdownWords(at('2026-10-28T20:00'), TZ, at('2026-10-28T19:05'))).toBe('in <1 hr')
  })
  test('the moment it turns 7 PM, an 8 PM deadline is "in <1 hr" (Trent\'s example)', () => {
    expect(countdownWords(at('2026-10-28T20:00'), TZ, at('2026-10-28T19:00'))).toBe('in <1 hr')
  })
  test('it changes only on the hour; one hour is singular', () => {
    expect(countdownWords(at('2026-10-28T20:00'), TZ, at('2026-10-28T18:00'))).toBe('in 1 hr')
    expect(countdownWords(at('2026-10-28T20:00'), TZ, at('2026-10-28T18:59'))).toBe('in 1 hr')
    // A deadline off the hour: 9:30 PM at 8:30 AM is 12.5 hours from 9:00 — 12.
    expect(countdownWords(at('2026-10-28T21:30'), TZ, at('2026-10-28T08:30'))).toBe('in 12 hrs')
  })
})

describe('leanChipWords', () => {
  const now = at('2026-10-28T12:00')
  const words = (deadline: string | null, target: string | null) =>
    leanChipWords(
      { deadline_at: deadline && iso(deadline), due_at: target && iso(target) },
      TZ,
      '03:00',
      now,
    )

  test('a deadline later today counts down; earlier today or another day does not', () => {
    expect(words('2026-10-28T21:00', null)).toEqual({
      deadline: 'Today 9:00 PM',
      countdown: 'in 8 hrs',
      target: null,
    })
    expect(words('2026-10-28T09:00', null).countdown).toBeNull()
    expect(words('2026-10-29T09:00', null).countdown).toBeNull()
  })

  test('targets never count down', () => {
    expect(words(null, '2026-10-28T18:00')).toEqual({
      deadline: null,
      countdown: null,
      target: 'Today 6:00 PM',
    })
  })

  test('"Today" once per row: beside a deadline that says it, a target today is the bare time', () => {
    expect(words('2026-10-28T21:00', '2026-10-28T17:00').target).toBe('5:00 PM')
    // A passed target today, too.
    expect(words('2026-10-28T21:00', '2026-10-28T09:00').target).toBe('9:00 AM')
    // No deadline today: the target keeps "Today", passed or not.
    expect(words('2026-10-30T17:00', '2026-10-28T13:00').target).toBe('Today 1:00 PM')
    expect(words(null, '2026-10-28T09:00').target).toBe('Today 9:00 AM')
    // Other days unchanged.
    expect(words('2026-10-28T21:00', '2026-10-29T09:00').target).toBe('Tomorrow 9:00 AM')
  })
})
