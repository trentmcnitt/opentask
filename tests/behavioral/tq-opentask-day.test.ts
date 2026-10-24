/**
 * The OpenTask day (task queue, 2026-10-19): rollover to rollover, not
 * midnight to midnight. `src/lib/opentask-day.ts` — pure, so no database.
 */

import { describe, test, expect } from 'vitest'
import { DateTime } from 'luxon'
import { nextRollover, openTaskDayOf, dayStartMoment } from '@/lib/opentask-day'

const TZ = 'America/Chicago'

/** A Chicago wall-clock time as a Date. */
function local(iso: string, zone = TZ): Date {
  return DateTime.fromISO(iso, { zone }).toJSDate()
}

/** A Date as Chicago wall-clock "yyyy-MM-ddTHH:mm". */
function wall(d: Date, zone = TZ): string {
  return DateTime.fromJSDate(d).setZone(zone).toFormat("yyyy-MM-dd'T'HH:mm")
}

describe('TQ-D: dayStartMoment (a start at or before 12:00: on its own date)', () => {
  test('TQ-D10: an ordinary day', () => {
    expect(wall(dayStartMoment('2026-10-20', TZ, '06:30'))).toBe('2026-10-20T06:30')
  })

  test('TQ-D11: spring forward with a 02:30 first period → the next valid minute (03:00)', () => {
    // 2027-03-14: Chicago jumps 2:00 → 3:00. 02:30 does not exist.
    const at = dayStartMoment('2027-03-14', TZ, '02:30')
    expect(wall(at)).toBe('2027-03-14T03:00')
    expect(at.toISOString()).toBe('2027-03-14T08:00:00.000Z')
  })

  test('TQ-D12: spring forward does not touch a 06:30 rollover', () => {
    expect(dayStartMoment('2027-03-14', TZ, '06:30').toISOString()).toBe('2027-03-14T11:30:00.000Z')
  })

  test('TQ-D13: fall back with a 01:30 first period → the first 01:30 (CDT)', () => {
    // 2026-11-01: Chicago falls back 2:00 → 1:00, so 01:30 happens twice.
    const at = dayStartMoment('2026-11-01', TZ, '01:30')
    expect(wall(at)).toBe('2026-11-01T01:30')
    expect(at.toISOString()).toBe('2026-11-01T06:30:00.000Z')
  })

  test('TQ-D14: fall back, a 06:30 rollover is CST', () => {
    expect(dayStartMoment('2026-11-01', TZ, '06:30').toISOString()).toBe('2026-11-01T12:30:00.000Z')
  })
})

describe('TQ-D: openTaskDayOf', () => {
  test('TQ-D20: 00:00–06:29 belongs to the previous date; 06:30 starts the new one', () => {
    expect(openTaskDayOf(local('2026-10-20T00:00'), TZ, '06:30')).toBe('2026-10-19')
    expect(openTaskDayOf(local('2026-10-20T02:00'), TZ, '06:30')).toBe('2026-10-19')
    expect(openTaskDayOf(local('2026-10-20T06:29:59'), TZ, '06:30')).toBe('2026-10-19')
    expect(openTaskDayOf(local('2026-10-20T06:30'), TZ, '06:30')).toBe('2026-10-20')
    expect(openTaskDayOf(local('2026-10-20T23:59'), TZ, '06:30')).toBe('2026-10-20')
  })

  test('TQ-D21: a night owl’s 2 AM belongs to the evening’s day', () => {
    expect(openTaskDayOf(local('2026-10-21T02:00'), TZ, '06:30')).toBe('2026-10-20')
  })

  test('TQ-D22: spring forward with a 02:30 rollover — the day starts at 03:00', () => {
    expect(openTaskDayOf(local('2027-03-14T01:59'), TZ, '02:30')).toBe('2027-03-13')
    expect(openTaskDayOf(local('2027-03-14T03:00'), TZ, '02:30')).toBe('2027-03-14')
  })
})

describe('TQ-D: nextRollover', () => {
  test('TQ-D30: before today’s rollover → today’s', () => {
    expect(wall(nextRollover(local('2026-10-20T01:00'), TZ, '06:30'))).toBe('2026-10-20T06:30')
    expect(wall(nextRollover(local('2026-10-20T06:29:59'), TZ, '06:30'))).toBe('2026-10-20T06:30')
  })

  test('TQ-D31: at exactly 06:30:00 → tomorrow’s (strictly after)', () => {
    expect(wall(nextRollover(local('2026-10-20T06:30'), TZ, '06:30'))).toBe('2026-10-21T06:30')
  })

  test('TQ-D32: in the evening → tomorrow’s', () => {
    expect(wall(nextRollover(local('2026-10-20T23:30'), TZ, '06:30'))).toBe('2026-10-21T06:30')
  })

  test('TQ-D33: the night before spring forward, 02:30 rollover → 03:00 next day', () => {
    expect(wall(nextRollover(local('2027-03-13T22:00'), TZ, '02:30'))).toBe('2027-03-14T03:00')
  })

  test('TQ-D34: across fall back, the rollover stays at 06:30 local', () => {
    expect(wall(nextRollover(local('2026-10-31T22:00'), TZ, '06:30'))).toBe('2026-11-01T06:30')
  })
})
