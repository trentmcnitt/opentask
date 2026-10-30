/**
 * Where every custom date/time picker opens (2026-10-30,
 * `src/lib/custom-picker-start.ts`): the Default task time, on tomorrow or a
 * later target's day.
 */
import { describe, test, expect } from 'vitest'
import { DateTime } from 'luxon'
import { customPickerStart } from '@/lib/custom-picker-start'

const TZ = 'America/Chicago'
const at = (iso: string) => DateTime.fromISO(iso, { zone: TZ }).toUTC().toISO()!
const local = (iso: string) =>
  DateTime.fromISO(iso, { zone: 'utc' }).setZone(TZ).toFormat('yyyy-MM-dd HH:mm')
const start = (from: (string | null)[], now = '2026-10-30T16:07') =>
  local(
    customPickerStart({
      from,
      timezone: TZ,
      morningTime: '06:30',
      dayStart: '03:00',
      now: new Date(at(now)),
    }),
  )

describe('custom picker start', () => {
  test('no targets: tomorrow at the Default task time', () => {
    expect(start([])).toBe('2026-10-31 06:30')
  })
  test('one shared target (one task, or all of a selection): open on it, date and time', () => {
    expect(start([at('2026-11-01T09:00')])).toBe('2026-11-01 09:00')
    expect(start([at('2026-11-01T09:00'), at('2026-11-01T09:00'), at('2026-11-01T09:00')])).toBe(
      '2026-11-01 09:00',
    )
  })
  test('targets that differ, or one missing: the Default task time on the earliest day', () => {
    expect(start([at('2026-11-01T09:00'), at('2026-11-01T12:00')])).toBe('2026-11-01 06:30')
    expect(start([at('2026-11-01T09:00'), null])).toBe('2026-11-01 06:30')
  })
  test('mixed targets: the earliest day, if after tomorrow', () => {
    expect(start([at('2026-11-04T09:00'), at('2026-11-02T09:00')])).toBe('2026-11-02 06:30')
    // The earliest is today: tomorrow.
    expect(start([at('2026-11-04T09:00'), at('2026-10-30T20:00')])).toBe('2026-10-31 06:30')
  })
  test('a passed or today target: still tomorrow', () => {
    expect(start([at('2026-10-29T09:00'), at('2026-10-30T20:00')])).toBe('2026-10-31 06:30')
  })
  test('late at night the days are OpenTask days', () => {
    // 01:30 Saturday with a 3:00 AM day start is still Friday: tomorrow is Saturday.
    expect(start([], '2026-10-31T01:30')).toBe('2026-10-31 06:30')
  })
})
