/**
 * The target's first time on its OpenTask day (`src/lib/target-day-first.ts`):
 * the pure rules. Chicago, a 3:00 AM day start. The write paths are pinned in
 * `tm-target-day-first-writes.test.ts`.
 */
import { describe, expect, test } from 'vitest'
import { DateTime } from 'luxon'
import { effectiveTargetDayFirst, nextTargetDayFirst, wasTargetTime } from '@/lib/target-day-first'

const TZ = 'America/Chicago'
const DS = '03:00'
const iso = (local: string) => DateTime.fromISO(local, { zone: TZ }).toUTC().toISO()!
const next = (oldDue: string | null, oldFirst: string | null, newDue: string | null) =>
  nextTargetDayFirst(
    oldDue && iso(oldDue),
    oldFirst && iso(oldFirst),
    newDue && iso(newDue),
    TZ,
    DS,
  )

describe('nextTargetDayFirst', () => {
  test("Trent's case: Tue 9 → Wed 9 → Wed 1 PM keeps Wed 9, not Tue 9", () => {
    const first = next('2026-11-03T09:00', '2026-11-03T09:00', '2026-11-04T09:00')
    expect(first).toBe(iso('2026-11-04T09:00'))
    expect(
      nextTargetDayFirst(iso('2026-11-04T09:00'), first, iso('2026-11-04T13:00'), TZ, DS),
    ).toBe(iso('2026-11-04T09:00'))
  })

  test('a target where there was none: the new target', () => {
    expect(next(null, null, '2026-11-04T14:00')).toBe(iso('2026-11-04T14:00'))
  })

  test('a move within the day keeps the first, earlier or later', () => {
    expect(next('2026-11-04T09:00', '2026-11-04T09:00', '2026-11-04T17:00')).toBe(
      iso('2026-11-04T09:00'),
    )
    expect(next('2026-11-04T17:00', '2026-11-04T09:00', '2026-11-04T08:00')).toBe(
      iso('2026-11-04T09:00'),
    )
  })

  test('the OpenTask day: a 2:30 AM moment is the day before (3:00 AM start)', () => {
    // Tue 9 PM → Wed 2:30 AM is the same OpenTask day (Tuesday's): kept.
    expect(next('2026-11-03T21:00', '2026-11-03T21:00', '2026-11-04T02:30')).toBe(
      iso('2026-11-03T21:00'),
    )
    // Wed 2:30 AM → Wed 9 AM crosses the 3:00 AM start: a new day.
    expect(next('2026-11-04T02:30', '2026-11-03T21:00', '2026-11-04T09:00')).toBe(
      iso('2026-11-04T09:00'),
    )
  })

  test('no target leaves none', () => {
    expect(next('2026-11-04T09:00', '2026-11-04T09:00', null)).toBeNull()
  })

  test('a stale first (another day than the old target) reads as the old target', () => {
    // Moved Tue → Wed by a path that left the column on Tue; then within Wed.
    expect(next('2026-11-04T09:00', '2026-11-03T09:00', '2026-11-04T13:00')).toBe(
      iso('2026-11-04T09:00'),
    )
  })
})

describe('effectiveTargetDayFirst', () => {
  test('itself on the target day; the target otherwise; none without a target', () => {
    const due = iso('2026-11-04T13:00')
    expect(effectiveTargetDayFirst(iso('2026-11-04T09:00'), due, TZ, DS)).toBe(
      iso('2026-11-04T09:00'),
    )
    expect(effectiveTargetDayFirst(iso('2026-11-03T09:00'), due, TZ, DS)).toBe(due)
    expect(effectiveTargetDayFirst(null, due, TZ, DS)).toBe(due)
    expect(effectiveTargetDayFirst(iso('2026-11-04T09:00'), null, TZ, DS)).toBeNull()
  })
})

describe('wasTargetTime', () => {
  const was = (due: string | null, first: string | null) =>
    wasTargetTime({ due_at: due && iso(due), target_day_first_at: first && iso(first) }, TZ, DS)

  test('"was 9:00 AM" when moved within the day', () => {
    expect(was('2026-11-04T14:00', '2026-11-04T09:00')).toBe('9:00 AM')
  })

  test('nothing for an untouched target, another day, or no target', () => {
    expect(was('2026-11-04T14:00', '2026-11-04T14:00')).toBeNull()
    expect(was('2026-11-04T14:00', '2026-11-03T09:00')).toBeNull()
    expect(was('2026-11-04T14:00', null)).toBeNull()
    expect(was(null, '2026-11-04T09:00')).toBeNull()
  })
})
