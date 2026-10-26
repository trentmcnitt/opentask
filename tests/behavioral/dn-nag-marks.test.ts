/**
 * Clock marks (DN-M01 … DN-M08): where every repeat of a nag lands (Trent,
 * 2026-10-26; src/core/notifications/nag-marks.ts).
 *
 * The next send is the local clock mark nearest `last + I`, a tie to the
 * earlier mark, on a grid of 60 for I ≥ 60 and otherwise the largest divisor
 * of 60 ≤ I. Pure — no database, no clock.
 */

import { describe, test, expect } from 'vitest'
import { DateTime } from 'luxon'
import {
  isRepeatMinute,
  markGridMinutes,
  markStepMinutes,
  minuteIndex,
  nextNagAt,
} from '@/core/notifications/nag-marks'

const ZONE = 'America/Chicago'

/** A local wall-clock instant on 2026-01-15 in `zone`. */
function at(hour: number, minute = 0, zone = ZONE): Date {
  return DateTime.fromObject({ year: 2026, month: 1, day: 15, hour, minute }, { zone }).toJSDate()
}

const hhmm = (d: Date, zone = ZONE) => DateTime.fromJSDate(d).setZone(zone).toFormat('HH:mm')

/** The smallest and largest gap from every start minute in two hours. */
function gapRange(interval: number): [number, number] {
  let min = Infinity
  let max = -Infinity
  for (let m = 0; m < 120; m++) {
    const last = new Date(at(9).getTime() + m * 60_000)
    const gap = (nextNagAt(last, interval, ZONE).getTime() - last.getTime()) / 60_000
    min = Math.min(min, gap)
    max = Math.max(max, gap)
  }
  return [min, max]
}

describe('Clock marks', () => {
  /** DN-M01: the plan's gap table — both ends reached, which pins the tie rule. */
  test.each([
    [5, 3, 7],
    [10, 5, 14],
    [30, 15, 44],
    [60, 30, 89],
    [120, 90, 149],
    [240, 210, 269],
    [480, 450, 509],
  ])('DN-M01: I=%i gives gaps %i–%i', (interval, lo, hi) => {
    expect(gapRange(interval)).toEqual([lo, hi])
  })

  /** DN-M02: Trent's examples. */
  test('DN-M02: 16:30 → 17:00, 20:15 → 21:00, 8:15 + 120 → 10:00', () => {
    expect(hhmm(nextNagAt(at(16, 30), 60, ZONE))).toBe('17:00')
    expect(hhmm(nextNagAt(at(20, 15), 60, ZONE))).toBe('21:00')
    expect(hhmm(nextNagAt(at(8, 15), 120, ZONE))).toBe('10:00')
  })

  /** DN-M03: the grid, and the step once on it. */
  test('DN-M03: grid and step', () => {
    expect([5, 7, 10, 15, 30, 45, 59, 60, 90, 480].map(markGridMinutes)).toEqual([
      5, 6, 10, 15, 30, 30, 30, 60, 60, 60,
    ])
    expect([5, 7, 10, 15, 30, 45, 60, 90, 150, 240].map(markStepMinutes)).toEqual([
      5, 6, 10, 15, 30, 30, 60, 60, 120, 240,
    ])
  })

  /** DN-M04: never under half the interval, at any interval and start (the plan's floor). */
  test('DN-M04: the half-interval floor never binds', () => {
    for (let interval = 1; interval <= 600; interval++) {
      expect(gapRange(interval)[0]).toBeGreaterThanOrEqual(interval / 2)
    }
  })

  /** DN-M05: seconds on the last send don't move the mark (the cron's minute grid). */
  test('DN-M05: last is floored to its minute', () => {
    const last = new Date(at(16, 30).getTime() + 42_500)
    expect(hhmm(nextNagAt(last, 60, ZONE))).toBe('17:00')
  })

  /** DN-M06: the mark is the LOCAL top of the hour, in a half-hour zone too. */
  test('DN-M06: local marks in Asia/Kolkata', () => {
    const zone = 'Asia/Kolkata'
    expect(hhmm(nextNagAt(at(9, 10, zone), 60, zone), zone)).toBe('10:00')
    expect(hhmm(nextNagAt(at(9, 10, zone), 30, zone), zone)).toBe('09:30')
  })

  /** DN-M07: once on a mark, every repeat is one step on. */
  test('DN-M07: iterating from a mark steps by S', () => {
    let last = at(17)
    const seen: string[] = []
    for (let i = 0; i < 3; i++) {
      last = nextNagAt(last, 60, ZONE)
      seen.push(hhmm(last))
    }
    expect(seen).toEqual(['18:00', '19:00', '20:00'])
  })

  /**
   * DN-M08: the stateless repeat rule agrees with iterating `nextNagAt` from
   * the first push, for every start minute and the shipped overdue tiers.
   */
  test('DN-M08: isRepeatMinute matches the iterated marks', () => {
    for (const interval of [5, 7, 15, 30, 60, 240]) {
      for (let m = 0; m < 60; m += 7) {
        const first = new Date(at(8).getTime() + m * 60_000)
        const expected = new Set<number>()
        let last = first
        while (last.getTime() < at(20).getTime()) {
          last = nextNagAt(last, interval, ZONE)
          expected.add(minuteIndex(last))
        }
        for (let t = minuteIndex(first) + 1; t < minuteIndex(at(20)); t++) {
          const now = new Date(t * 60_000)
          expect(isRepeatMinute(minuteIndex(first), interval, now, ZONE)).toBe(expected.has(t))
        }
      }
    }
  })
})
