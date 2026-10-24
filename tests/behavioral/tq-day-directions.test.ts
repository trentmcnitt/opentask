/**
 * THE OPENTASK DAY IN BOTH DIRECTIONS (TQ-DD, Trent 2026-10-24) —
 * `src/lib/opentask-day.ts`, pure.
 *
 * The convention: a day start at or before 12:00 names the day by the date it
 * begins on (03:00: Mon 03:00 → Tue 03:00 is Monday); after 12:00, by the next
 * date (23:00: Sun 23:00 → Mon 23:00 is Monday). For every day start,
 * `openTaskDayOf(x) = D` ⇔ `dayStartMoment(D) ≤ x < dayStartMoment(D + 1)`.
 *
 * Pinned at day starts 00:00, 03:00, 06:30, 12:00, 12:01 and 23:00, on an
 * ordinary day and both America/Chicago DST nights (spring forward
 * 2027-03-14, fall back 2026-11-01), at instants just before, at and after
 * each boundary — and as properties over every quarter hour of a span that
 * covers both nights.
 */

import { describe, test, expect } from 'vitest'
import { DateTime } from 'luxon'
import {
  addDays,
  dayStartMoment,
  dayStartOnDate,
  isEarlyMorningPick,
  isLateNight,
  latestRollover,
  namesNextDate,
  nextRollover,
  openTaskDayOf,
  openTaskDaySpan,
  periodOpensAt,
  targetOpenTaskDay,
} from '@/lib/opentask-day'

const TZ = 'America/Chicago'
const STARTS = ['00:00', '03:00', '06:30', '12:00', '12:01', '23:00'] as const
const ORDINARY = '2026-10-20'
const SPRING = '2027-03-14' // 2:00 → 3:00
const FALL = '2026-11-01' // 2:00 → 1:00
const DATES = [ORDINARY, SPRING, FALL]

/** A Chicago wall-clock time as a Date. */
function local(iso: string): Date {
  return DateTime.fromISO(iso, { zone: TZ }).toJSDate()
}

/** A Date as Chicago wall-clock "yyyy-MM-ddTHH:mm". */
function wall(d: Date): string {
  return DateTime.fromJSDate(d).setZone(TZ).toFormat("yyyy-MM-dd'T'HH:mm")
}

const ms = (d: Date, delta: number) => new Date(d.getTime() + delta)

describe('TQ-DD: the naming convention', () => {
  test('TQ-DD01: 12:00 and before name the day by its own date; after 12:00, by the next', () => {
    expect(STARTS.map(namesNextDate)).toEqual([false, false, false, false, true, true])
  })

  test('TQ-DD02: where each day start puts the start of the OpenTask day 2026-10-20', () => {
    const expected: Record<(typeof STARTS)[number], string> = {
      '00:00': '2026-10-20T00:00',
      '03:00': '2026-10-20T03:00',
      '06:30': '2026-10-20T06:30',
      '12:00': '2026-10-20T12:00',
      '12:01': '2026-10-19T12:01',
      '23:00': '2026-10-19T23:00',
    }
    for (const start of STARTS) {
      expect(wall(dayStartMoment(ORDINARY, TZ, start)), start).toBe(expected[start])
    }
  })

  test('TQ-DD03: with 11 PM, Sunday 23:30 is already Monday; Sunday 22:59 is still Sunday', () => {
    expect(openTaskDayOf(local('2026-10-18T23:30'), TZ, '23:00')).toBe('2026-10-19')
    expect(openTaskDayOf(local('2026-10-18T23:00'), TZ, '23:00')).toBe('2026-10-19')
    expect(openTaskDayOf(local('2026-10-18T22:59:59.999'), TZ, '23:00')).toBe('2026-10-18')
    expect(openTaskDayOf(local('2026-10-19T12:00'), TZ, '23:00')).toBe('2026-10-19')
  })

  test('TQ-DD04: 12:00 vs 12:01 — the one-minute edge of the convention', () => {
    expect(openTaskDayOf(local('2026-10-20T11:59'), TZ, '12:00')).toBe('2026-10-19')
    expect(openTaskDayOf(local('2026-10-20T12:00'), TZ, '12:00')).toBe('2026-10-20')
    expect(openTaskDayOf(local('2026-10-20T12:00'), TZ, '12:01')).toBe('2026-10-20')
    expect(openTaskDayOf(local('2026-10-20T12:01'), TZ, '12:01')).toBe('2026-10-21')
  })

  test('TQ-DD05: midnight is the calendar day', () => {
    expect(openTaskDayOf(local('2026-10-20T00:00'), TZ, '00:00')).toBe('2026-10-20')
    expect(openTaskDayOf(local('2026-10-19T23:59:59.999'), TZ, '00:00')).toBe('2026-10-19')
  })
})

describe('TQ-DD: every boundary, just before / at / after', () => {
  for (const start of STARTS) {
    for (const date of DATES) {
      test(`TQ-DD10: start ${start}, day ${date}`, () => {
        const b = dayStartMoment(date, TZ, start)
        expect(openTaskDayOf(ms(b, -1), TZ, start)).toBe(addDays(date, -1))
        expect(openTaskDayOf(b, TZ, start)).toBe(date)
        expect(openTaskDayOf(ms(b, 1), TZ, start)).toBe(date)
        const span = openTaskDaySpan(b, TZ, start)
        expect(span).toEqual({ date, start: b, end: dayStartMoment(addDays(date, 1), TZ, start) })
        expect(latestRollover(b, TZ, start)).toEqual(b)
        expect(latestRollover(ms(b, -1), TZ, start)).toEqual(
          dayStartMoment(addDays(date, -1), TZ, start),
        )
        expect(nextRollover(ms(b, -1), TZ, start)).toEqual(b)
        expect(nextRollover(b, TZ, start)).toEqual(span.end)
        // The cron fires on the date the day start falls on.
        const firesOn = namesNextDate(start) ? addDays(date, -1) : date
        expect(dayStartOnDate(firesOn, TZ, start)).toEqual(b)
      })
    }
  }

  test('TQ-DD11: DST — a 02:30 start on the spring-forward night starts at 03:00 (next valid minute)', () => {
    expect(wall(dayStartMoment(SPRING, TZ, '02:30'))).toBe('2027-03-14T03:00')
    expect(openTaskDayOf(local('2027-03-14T01:59'), TZ, '02:30')).toBe('2027-03-13')
    expect(openTaskDayOf(local('2027-03-14T03:00'), TZ, '02:30')).toBe('2027-03-14')
  })

  test('TQ-DD12: DST — 23:00 around both nights: the 23- and 25-hour days', () => {
    const spring = openTaskDaySpan(local('2027-03-14T12:00'), TZ, '23:00')
    expect([spring.date, wall(spring.start), wall(spring.end)]).toEqual([
      SPRING,
      '2027-03-13T23:00',
      '2027-03-14T23:00',
    ])
    expect((spring.end.getTime() - spring.start.getTime()) / 3_600_000).toBe(23)
    const fall = openTaskDaySpan(local('2026-11-01T12:00'), TZ, '23:00')
    expect([fall.date, wall(fall.start), wall(fall.end)]).toEqual([
      FALL,
      '2026-10-31T23:00',
      '2026-11-01T23:00',
    ])
    expect((fall.end.getTime() - fall.start.getTime()) / 3_600_000).toBe(25)
  })

  test('TQ-DD13: DST — a 01:30 start on the fall-back night is the first 01:30; the second is the same day', () => {
    const b = dayStartMoment(FALL, TZ, '01:30')
    expect(b.toISOString()).toBe('2026-11-01T06:30:00.000Z') // 01:30 CDT
    const second = new Date('2026-11-01T07:30:00.000Z') // 01:30 CST
    expect(openTaskDayOf(second, TZ, '01:30')).toBe(FALL)
  })
})

describe('TQ-DD: properties over every quarter hour (both DST nights)', () => {
  const from = local('2026-10-30T00:00').getTime()
  const to = local('2026-11-03T00:00').getTime()
  const spring = local('2027-03-12T00:00').getTime()
  const springTo = local('2027-03-16T00:00').getTime()
  const instants: Date[] = []
  for (let t = from; t < to; t += 15 * 60_000) instants.push(new Date(t))
  for (let t = spring; t < springTo; t += 15 * 60_000) instants.push(new Date(t))

  for (const start of STARTS) {
    test(`TQ-DD20: start ${start} — dayStartMoment(D) ≤ x < dayStartMoment(D+1) ⇔ openTaskDayOf(x) = D`, () => {
      for (const x of instants) {
        const day = openTaskDayOf(x, TZ, start)
        const span = openTaskDaySpan(x, TZ, start)
        expect(span.date).toBe(day)
        expect(span.start.getTime()).toBeLessThanOrEqual(x.getTime())
        expect(x.getTime()).toBeLessThan(span.end.getTime())
        expect(openTaskDayOf(span.start, TZ, start)).toBe(day)
        expect(openTaskDayOf(ms(span.end, -1), TZ, start)).toBe(day)
        expect(openTaskDayOf(span.end, TZ, start)).toBe(addDays(day, 1))
        expect(latestRollover(x, TZ, start)).toEqual(span.start)
        expect(nextRollover(x, TZ, start)).toEqual(span.end)
        expect(nextRollover(x, TZ, start).getTime()).toBeGreaterThan(x.getTime())
        // The named date is the calendar date, or the one before (≤ 12:00) / after (> 12:00).
        const calendar = DateTime.fromJSDate(x).setZone(TZ).toISODate()!
        const other = namesNextDate(start) ? addDays(calendar, 1) : addDays(calendar, -1)
        expect([calendar, other]).toContain(day)
      }
    })
  }
})

describe('TQ-DD: periods within a day (periodOpensAt)', () => {
  const PERIODS = ['00:30', '01:00', '02:30', '03:00', '06:30', '07:00', '12:00', '20:30', '23:30']

  for (const start of STARTS) {
    test(`TQ-DD30: start ${start} — every period opens inside its own day`, () => {
      for (const date of DATES) {
        for (const p of PERIODS) {
          const at = periodOpensAt(date, p, TZ, start)
          expect(openTaskDayOf(at, TZ, start), `${date} ${p}`).toBe(date)
        }
      }
    })
  }

  test('TQ-DD31: with 11 PM, Monday (Sun 23:00 → Mon 23:00): 07:00 is Monday morning, 23:30 Sunday night', () => {
    const monday = '2026-10-19'
    expect(wall(periodOpensAt(monday, '07:00', TZ, '23:00'))).toBe('2026-10-19T07:00')
    expect(wall(periodOpensAt(monday, '22:30', TZ, '23:00'))).toBe('2026-10-19T22:30')
    expect(wall(periodOpensAt(monday, '23:30', TZ, '23:00'))).toBe('2026-10-18T23:30')
    expect(wall(periodOpensAt(monday, '23:00', TZ, '23:00'))).toBe('2026-10-18T23:00')
  })

  test('TQ-DD32: with 3:00 AM, a 1:00 AM period ends the day; 07:00 begins it', () => {
    expect(wall(periodOpensAt(ORDINARY, '01:00', TZ, '03:00'))).toBe('2026-10-21T01:00')
    expect(wall(periodOpensAt(ORDINARY, '07:00', TZ, '03:00'))).toBe('2026-10-20T07:00')
  })
})

describe('TQ-DD: the late night and early-morning picks', () => {
  test('TQ-DD40: a start after midnight and at or before 12:00 has a late night; others none', () => {
    expect(isLateNight(local('2026-10-20T01:00'), TZ, '03:00')).toBe(true)
    expect(isLateNight(local('2026-10-20T03:00'), TZ, '03:00')).toBe(false)
    expect(isLateNight(local('2026-10-20T11:59'), TZ, '12:00')).toBe(true)
    for (const start of ['00:00', '12:01', '23:00']) {
      for (const h of ['00:30', '06:00', '11:00', '22:00', '23:30']) {
        expect(isLateNight(local(`2026-10-20T${h}`), TZ, start), `${start} ${h}`).toBe(false)
      }
    }
  })

  test('TQ-DD41: an early-morning pick exists only in the late night', () => {
    const pick = (due: string, set: string, start: string) =>
      isEarlyMorningPick(local(due).toISOString(), local(set).toISOString(), TZ, start)
    // 3:00 AM: at 22:00 "tomorrow 2:00" is one; set after midnight it is not.
    expect(pick('2026-10-21T02:00', '2026-10-20T22:00', '03:00')).toBe(true)
    expect(pick('2026-10-21T02:00', '2026-10-21T01:00', '03:00')).toBe(false)
    // 11 PM: there is no late night — 23:30 Sunday belongs to Monday anyway.
    expect(pick('2026-10-19T23:30', '2026-10-19T20:00', '23:00')).toBe(false)
    expect(
      targetOpenTaskDay(
        local('2026-10-19T23:30').toISOString(),
        local('2026-10-19T20:00').toISOString(),
        TZ,
        '23:00',
      ),
    ).toBe('2026-10-20')
  })
})
