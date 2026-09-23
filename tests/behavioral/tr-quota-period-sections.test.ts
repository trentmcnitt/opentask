/**
 * The Track panel's period-first redesign (§5, 2026-09-23, Trent's `mock4`):
 * a section per period — today, this week, this month, this year, no period —
 * each with a bar (partial credit, capped per quota) and a notch at how much
 * of the period's clock has run.
 *
 * The clock math (`periodElapsedFraction`, `periodDaysLeft`,
 * `periodTimeLeftText`) is the part that has to be exactly right and is easy
 * to get subtly wrong around a week boundary, a month's end, or a DST day —
 * so it is pure, timezone-driven, and frozen here with `vi.setSystemTime`
 * rather than exercised only through the component.
 */
import { describe, test, expect, afterEach, vi } from 'vitest'
import {
  periodElapsedFraction,
  periodDaysLeft,
  periodTimeLeftText,
  trackSections,
  TRACK_NOTCH_CLASS,
} from '@/lib/track'
import type { Task } from '@/types'

const TZ = 'America/Chicago'

const quota = (title: string, rrule: string | null, current: number, target: number): Task =>
  ({ title, rrule, progress_current: current, progress_target: target }) as Task

afterEach(() => {
  vi.useRealTimers()
})

describe('periodElapsedFraction', () => {
  test('a day: 0 at local midnight, ~0.5 at noon, close to (but under) 1 late at night', () => {
    // Wed 2026-09-23 America/Chicago. Midnight local is 05:00 UTC (CDT, -5).
    expect(periodElapsedFraction('DAILY', TZ, new Date('2026-09-23T05:00:00.000Z'))).toBe(0)
    expect(periodElapsedFraction('DAILY', TZ, new Date('2026-09-23T17:00:00.000Z'))).toBeCloseTo(
      0.5,
      5,
    )
    const late = periodElapsedFraction('DAILY', TZ, new Date('2026-09-24T04:59:59.999Z'))
    expect(late).toBeGreaterThan(0.999)
    expect(late).toBeLessThan(1)
  })

  test('a week: 0 at Monday local midnight, close to 1 just before the next Monday', () => {
    // Luxon's week starts Monday. 2026-09-21 is a Monday.
    expect(periodElapsedFraction('WEEKLY', TZ, new Date('2026-09-21T05:00:00.000Z'))).toBe(0)
    // Sunday 23:59:59.999 local (2026-09-27), the week's last instant.
    const sundayNight = periodElapsedFraction('WEEKLY', TZ, new Date('2026-09-28T04:59:59.999Z'))
    expect(sundayNight).toBeGreaterThan(0.999)
    expect(sundayNight).toBeLessThan(1)
    // Midweek (Wed 2026-09-23, noon local) sits partway through, in order.
    const wed = periodElapsedFraction('WEEKLY', TZ, new Date('2026-09-23T17:00:00.000Z'))
    expect(wed).toBeGreaterThan(0)
    expect(wed).toBeLessThan(sundayNight)
  })

  test('a month: 0 on the 1st, close to 1 on the last night, resets cleanly across the boundary', () => {
    expect(periodElapsedFraction('MONTHLY', TZ, new Date('2026-09-01T05:00:00.000Z'))).toBe(0)
    // Sep has 30 days; 23:00 local on the 30th is well into the month.
    const monthEnd = periodElapsedFraction('MONTHLY', TZ, new Date('2026-10-01T03:00:00.000Z'))
    expect(monthEnd).toBeGreaterThan(0.9)
    expect(monthEnd).toBeLessThan(1)
    // One minute later, October has started fresh at 0 — not a continuation.
    expect(periodElapsedFraction('MONTHLY', TZ, new Date('2026-10-01T05:00:00.000Z'))).toBe(0)
  })

  test('a year: 0 on Jan 1, partway through by September', () => {
    expect(periodElapsedFraction('YEARLY', TZ, new Date('2026-01-01T06:00:00.000Z'))).toBe(0)
    const sep = periodElapsedFraction('YEARLY', TZ, new Date('2026-09-23T17:00:00.000Z'))
    expect(sep).toBeGreaterThan(0.6)
    expect(sep).toBeLessThan(0.8)
  })

  test('a DST spring-forward day is 23 real hours, not 24 — the fraction reflects that', () => {
    // 2026-03-08 is the US spring-forward Sunday: 2:00am CST jumps to 3:00am
    // CDT, so this local day is 23 real hours long. At 22:00 CDT, 21 real
    // hours have elapsed (23 - 2 remain, not 24 - 2): a naive
    // hoursSinceMidnight/24 would say 22/24 ≈ 0.917; the real answer is
    // 21/23 ≈ 0.913 because one clock hour never happened.
    const at22 = periodElapsedFraction('DAILY', TZ, new Date('2026-03-09T03:00:00.000Z')) // 22:00 CDT
    expect(at22).toBeCloseTo(21 / 23, 5)
    expect(at22).not.toBeCloseTo(22 / 24, 3)
  })

  test('honours the default `now` — a real vi.setSystemTime freeze, not a passed-in clock', () => {
    vi.setSystemTime(new Date('2026-09-23T17:00:00.000Z'))
    expect(periodElapsedFraction('DAILY', TZ)).toBeCloseTo(0.5, 5)
  })
})

describe('periodDaysLeft', () => {
  test('a week: Wednesday has 5 days left (Wed, Thu, Fri, Sat, Sun), today counted', () => {
    // 2026-09-23 is a Wednesday.
    expect(periodDaysLeft('WEEKLY', TZ, new Date('2026-09-23T17:00:00.000Z'))).toBe(5)
  })

  test('a month: the 23rd of a 30-day September has 8 days left', () => {
    expect(periodDaysLeft('MONTHLY', TZ, new Date('2026-09-23T17:00:00.000Z'))).toBe(8)
  })

  test('the last day of a period has exactly 1 day left, all day', () => {
    // Sep 30, both early morning and late at night — the count moves at
    // midnight, not at the hour the clock happens to read.
    expect(periodDaysLeft('MONTHLY', TZ, new Date('2026-09-30T06:00:00.000Z'))).toBe(1)
    expect(periodDaysLeft('MONTHLY', TZ, new Date('2026-10-01T04:00:00.000Z'))).toBe(1)
  })

  test('the first day of a period has every day of it left', () => {
    expect(periodDaysLeft('MONTHLY', TZ, new Date('2026-09-01T15:00:00.000Z'))).toBe(30)
  })
})

describe('periodTimeLeftText', () => {
  test('a day always reads "ends tonight" — never a day count', () => {
    expect(periodTimeLeftText('DAILY', TZ, new Date('2026-09-23T05:00:01.000Z'))).toBe(
      'ends tonight',
    )
    expect(periodTimeLeftText('DAILY', TZ, new Date('2026-09-24T04:59:59.999Z'))).toBe(
      'ends tonight',
    )
  })

  test('a week or month reads "N days left", pluralised', () => {
    expect(periodTimeLeftText('WEEKLY', TZ, new Date('2026-09-23T17:00:00.000Z'))).toBe(
      '5 days left',
    )
    expect(periodTimeLeftText('MONTHLY', TZ, new Date('2026-09-30T15:00:00.000Z'))).toBe(
      '1 day left',
    )
  })
})

describe('trackSections', () => {
  const NOW = new Date('2026-09-23T17:00:00.000Z') // Wed, noon-ish CDT

  test('orders day-to-year, no-period last, and omits empty sections', () => {
    const quotas = [
      quota('Reset router', 'FREQ=MONTHLY', 0, 1),
      quota('Eggs', null, 0, 1),
      quota('Walk', 'FREQ=DAILY', 1, 2),
      quota('Taxes', 'FREQ=YEARLY', 0, 1),
      quota('Broccoli', 'FREQ=WEEKLY', 0, 3),
    ]
    const sections = trackSections(quotas, TZ, NOW)
    expect(sections.map((s) => s.key)).toEqual(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY', 'NONE'])
    expect(sections.map((s) => s.heading)).toEqual([
      'today',
      'this week',
      'this month',
      'this year',
      'no period',
    ])
  })

  test('an empty corpus is an empty list of sections', () => {
    expect(trackSections([], TZ, NOW)).toEqual([])
  })

  test('bar fill is partial credit, capped per quota — 3 of 5 pulls the section to 0.6, not more', () => {
    // Overflowing on one quota (4/2) must not pay for another's shortfall.
    const [section] = trackSections(
      [quota('Vegetables', 'FREQ=WEEKLY', 3, 5), quota('Overflowed', 'FREQ=WEEKLY', 4, 2)],
      TZ,
      NOW,
    )
    // done = min(3,5) + min(4,2) = 3 + 2 = 5; total = 5 + 2 = 7
    expect(section.barFraction).toBeCloseTo(5 / 7, 10)
  })

  test('a section is allMet only when every quota in it has reached its target', () => {
    const [metSection] = trackSections([quota('Done', 'FREQ=DAILY', 2, 2)], TZ, NOW)
    expect(metSection.allMet).toBe(true)
    expect(metSection.barFraction).toBe(1)

    const [partial] = trackSections(
      [quota('Done', 'FREQ=DAILY', 2, 2), quota('Not yet', 'FREQ=DAILY', 0, 1)],
      TZ,
      NOW,
    )
    expect(partial.allMet).toBe(false)
  })

  test('the no-period section has no clock: no time-left text and no notch', () => {
    const [section] = trackSections([quota('Eggs', null, 0, 1)], TZ, NOW)
    expect(section.freq).toBeNull()
    expect(section.timeLeft).toBeNull()
    expect(section.elapsedFraction).toBeNull()
    expect(section.barAriaLabel).toBe('0% done')
  })

  test('a dated section carries both halves of the bar description', () => {
    // NOW is noon local — half the day gone — and Walk is 1/2, half done.
    const [section] = trackSections([quota('Walk', 'FREQ=DAILY', 1, 2)], TZ, NOW)
    expect(section.barAriaLabel).toBe('50% done, 50% of the day gone')
  })

  test('summary counts quotas, not summed targets', () => {
    const [section] = trackSections(
      [quota('A', 'FREQ=WEEKLY', 1, 1), quota('B', 'FREQ=WEEKLY', 0, 5)],
      TZ,
      NOW,
    )
    expect(section.summary).toEqual({ count: 2, met: 1 })
  })
})

describe('TRACK_NOTCH_CLASS', () => {
  test('is one flat, faint tone — no light/dark-by-coverage variants baked in', () => {
    // Trent, 2026-09-23: the notch must not switch shade by whether the fill
    // covers it — one class, tuned in one place.
    expect(TRACK_NOTCH_CLASS).toBe('bg-black/14 dark:bg-white/14')
  })
})
