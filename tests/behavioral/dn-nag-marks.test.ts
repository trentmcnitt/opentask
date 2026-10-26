/**
 * Clock marks (DN-M01 … DN-M13): where every repeat of a nag lands (Trent,
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

/**
 * DST (review of #362): every mark is judged in the offset that holds at it.
 * Australia/Lord_Howe shifts by 30 minutes (+10:30 ⇄ +11:00); with a fixed
 * UTC step its hourly repeats used to land on :30 local forever after. Whole-
 * hour zones must not move: Chicago keeps real-time spacing through both
 * changes.
 */
describe('Clock marks across DST changes', () => {
  /** Every repeat minute in `hours` after a first push, as "HH:mm±HH:MM". */
  function repeats(zone: string, firstIso: string, interval: number, hours: number): string[] {
    const first = minuteIndex(firstIso)
    const out: string[] = []
    for (let m = first + 1; m < first + hours * 60; m++) {
      const now = new Date(m * 60_000)
      if (isRepeatMinute(first, interval, now, zone)) {
        out.push(DateTime.fromJSDate(now).setZone(zone).toFormat('HH:mmZZ'))
      }
    }
    return out
  }
  const LORD_HOWE = 'Australia/Lord_Howe'

  test('DN-M09: Lord Howe spring forward (02:00 → 02:30): hourly repeats stay on :00', () => {
    // First push 2026-10-03T13:20Z = 23:50 +10:30. Local 02:00–02:29 never happens.
    expect(repeats(LORD_HOWE, '2026-10-03T13:20:00Z', 60, 7)).toEqual([
      '01:00+10:30',
      '03:00+11:00',
      '04:00+11:00',
      '05:00+11:00',
      '06:00+11:00',
      '07:00+11:00',
    ])
  })

  test('DN-M10: Lord Howe fall back (02:00 → 01:30): hourly repeats stay on :00', () => {
    // First push 2026-04-04T12:20Z = 23:20 +11:00.
    expect(repeats(LORD_HOWE, '2026-04-04T12:20:00Z', 60, 7)).toEqual([
      '00:00+11:00',
      '01:00+11:00',
      '02:00+10:30',
      '03:00+10:30',
      '04:00+10:30',
      '05:00+10:30',
    ])
  })

  test('DN-M11: nextNagAt judges the mark in its own offset', () => {
    // From 14:20Z (00:50 +10:30) at I = 60: the target 15:20Z is 01:50 +10:30,
    // but 02:00 that night does not exist (02:00 +10:30 is 02:30 +11:00).
    // The real marks either side: 01:00 (14:30Z, 50 away), 03:00 (16:00Z, 40 away).
    expect(nextNagAt('2026-10-03T14:20:00Z', 60, LORD_HOWE).toISOString()).toBe(
      '2026-10-03T16:00:00.000Z',
    )
    // After the change, a :30-local target ties :00 either side: the earlier.
    expect(nextNagAt('2026-10-03T16:30:00Z', 60, LORD_HOWE).toISOString()).toBe(
      '2026-10-03T17:00:00.000Z',
    )
  })

  test('DN-M12: Chicago spring forward: real-time spacing, on the hour', () => {
    // 02:00 CST → 03:00 CDT on 2026-03-08 (08:00Z).
    expect(repeats(ZONE, '2026-03-08T06:20:00Z', 60, 5)).toEqual([
      '01:00-06:00',
      '03:00-05:00',
      '04:00-05:00',
      '05:00-05:00',
      '06:00-05:00',
    ])
    expect(repeats(ZONE, '2026-03-08T04:20:00Z', 120, 8)).toEqual([
      '00:00-06:00',
      '03:00-05:00',
      '05:00-05:00',
      '07:00-05:00',
    ])
  })

  test('DN-M13: Chicago fall back: the repeated hour nags twice, hourly', () => {
    // 02:00 CDT → 01:00 CST on 2026-11-01 (07:00Z).
    expect(repeats(ZONE, '2026-11-01T04:20:00Z', 60, 6)).toEqual([
      '00:00-05:00',
      '01:00-05:00',
      '01:00-06:00',
      '02:00-06:00',
      '03:00-06:00',
      '04:00-06:00',
    ])
    expect(repeats(ZONE, '2026-11-01T03:20:00Z', 120, 8)).toEqual([
      '00:00-05:00',
      '01:00-06:00',
      '03:00-06:00',
      '05:00-06:00',
    ])
  })
})
