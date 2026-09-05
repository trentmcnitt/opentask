/**
 * The reminder editor's schedule vocabulary (REDESIGN-V03 §6): a reminder has
 * a cadence (which days) and a time of day (its slot), and `reminder-rule`
 * translates between that and the stored rrule. These pin the translation:
 * what each stored shape reads as, that a round trip is lossless, that the
 * written rule always carries a time (a bare FREQ is a Track period rule the
 * validator refuses on a reminder), and that a rule the editor cannot express
 * survives untouched except for its time.
 */

import { describe, test, expect } from 'vitest'
import {
  buildSchedule,
  describeCadence,
  describeTimeOfDay,
  isCompleteSchedule,
  readSchedule,
  sameSchedule,
  slotAtMinutes,
  timeOfDay,
} from '@/lib/reminder-rule'
import type { TimeSlot } from '@/lib/time-slot-assign'

const TZ = 'America/Chicago'

const SLOTS: TimeSlot[] = [
  ['Early morning', '07:00'],
  ['Morning', '09:00'],
  ['Midday', '12:00'],
  ['Afternoon', '16:00'],
  ['Evening', '20:30'],
].map(([label, start_time], i) => ({
  id: i + 1,
  user_id: 1,
  label,
  start_time,
  sort_order: i,
  created_at: '2026-01-01T00:00:00.000Z',
}))

const task = (
  rrule: string | null,
  anchor_time: string | null = null,
  due_at: string | null = null,
) => ({
  rrule,
  anchor_time,
  due_at,
})

describe('reading a stored reminder', () => {
  test('daily with INTERVAL=1 reads as every day at its anchor time', () => {
    const s = readSchedule(task('FREQ=DAILY;INTERVAL=1;BYHOUR=7;BYMINUTE=0', '07:00'), TZ)
    expect(s.cadence).toBe('daily')
    expect(s.time).toBe(7 * 60)
    expect(s.custom).toBeNull()
  })

  test('weekly reads its days in Monday-first order', () => {
    const s = readSchedule(
      task('FREQ=WEEKLY;INTERVAL=1;BYDAY=SU,FR;BYHOUR=20;BYMINUTE=30', '20:30'),
      TZ,
    )
    expect(s.cadence).toBe('weekly')
    expect(s.days).toEqual([4, 6])
    expect(s.time).toBe(20 * 60 + 30)
  })

  test('monthly reads its day, and -1 as the last day', () => {
    expect(readSchedule(task('FREQ=MONTHLY;BYMONTHDAY=15;BYHOUR=9;BYMINUTE=0'), TZ)).toMatchObject({
      cadence: 'monthly',
      monthDay: 15,
    })
    expect(readSchedule(task('FREQ=MONTHLY;BYMONTHDAY=-1;BYHOUR=9;BYMINUTE=0'), TZ)).toMatchObject({
      cadence: 'monthly',
      monthDay: 'last',
    })
  })

  test('no rule reads as once, with the time of day taken from the due date', () => {
    // 7:00 AM Chicago in January is 13:00 UTC.
    const s = readSchedule(task(null, null, '2026-01-15T13:00:00.000Z'), TZ)
    expect(s.cadence).toBe('once')
    expect(s.time).toBe(7 * 60)
  })

  test('a rule the editor cannot express is carried as custom', () => {
    for (const rrule of [
      'FREQ=DAILY;INTERVAL=2;BYHOUR=9;BYMINUTE=0',
      'FREQ=YEARLY;BYHOUR=9;BYMINUTE=0',
      'FREQ=MONTHLY;BYMONTHDAY=1,15;BYHOUR=9;BYMINUTE=0',
      'FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1;BYHOUR=9;BYMINUTE=0',
    ]) {
      const s = readSchedule(task(rrule), TZ)
      expect(s.cadence, rrule).toBe('custom')
      expect(s.custom).toBe(rrule)
      expect(s.time).toBe(9 * 60)
    }
  })

  test('anchor_time wins over the rule, which wins over the due date', () => {
    expect(
      timeOfDay(task('FREQ=DAILY;BYHOUR=9;BYMINUTE=0', '07:00', '2026-01-15T18:00:00.000Z'), TZ),
    ).toBe(7 * 60)
    expect(
      timeOfDay(task('FREQ=DAILY;BYHOUR=9;BYMINUTE=0', null, '2026-01-15T18:00:00.000Z'), TZ),
    ).toBe(9 * 60)
    expect(timeOfDay(task(null, null, null), TZ)).toBeNull()
  })
})

describe('writing a schedule', () => {
  test('every plain cadence round-trips and always carries a time', () => {
    for (const rrule of [
      'FREQ=DAILY;BYHOUR=7;BYMINUTE=0',
      'FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=12;BYMINUTE=0',
      'FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0',
      'FREQ=MONTHLY;BYMONTHDAY=-1;BYHOUR=20;BYMINUTE=30',
    ]) {
      const built = buildSchedule(readSchedule(task(rrule), TZ))
      expect(built).toBe(rrule)
      expect(built).toMatch(/BYHOUR=\d+;BYMINUTE=\d+$/)
    }
  })

  test('INTERVAL=1 is dropped on the way back out, without reading as a change', () => {
    const stored = task('FREQ=DAILY;INTERVAL=1;BYHOUR=7;BYMINUTE=0', '07:00')
    const s = readSchedule(stored, TZ)
    expect(buildSchedule(s)).toBe('FREQ=DAILY;BYHOUR=7;BYMINUTE=0')
    expect(sameSchedule(s, readSchedule(stored, TZ))).toBe(true)
  })

  test('once writes no rule', () => {
    expect(
      buildSchedule({ cadence: 'once', days: [], monthDay: 1, time: 420, custom: null }),
    ).toBeNull()
  })

  test('weekly days are written Monday-first and de-duplicated', () => {
    expect(
      buildSchedule({
        cadence: 'weekly',
        days: [6, 0, 6, 2],
        monthDay: 1,
        time: 540,
        custom: null,
      }),
    ).toBe('FREQ=WEEKLY;BYDAY=MO,WE,SU;BYHOUR=9;BYMINUTE=0')
  })

  test('a custom rule is written back verbatim except for its time', () => {
    const s = readSchedule(task('FREQ=DAILY;INTERVAL=2;BYHOUR=9;BYMINUTE=0'), TZ)
    expect(buildSchedule({ ...s, time: 20 * 60 + 30 })).toBe(
      'FREQ=DAILY;INTERVAL=2;BYHOUR=20;BYMINUTE=30',
    )
  })

  test('a repeating schedule without a time is incomplete, and building it throws', () => {
    const s = {
      cadence: 'daily' as const,
      days: [],
      monthDay: 1 as const,
      time: null,
      custom: null,
    }
    expect(isCompleteSchedule(s)).toBe(false)
    expect(() => buildSchedule(s)).toThrow()
  })

  test('weekly with no days is incomplete', () => {
    expect(
      isCompleteSchedule({ cadence: 'weekly', days: [], monthDay: 1, time: 420, custom: null }),
    ).toBe(false)
    expect(
      isCompleteSchedule({ cadence: 'weekly', days: [0], monthDay: 1, time: 420, custom: null }),
    ).toBe(true)
  })
})

describe('describing a schedule', () => {
  test('cadence words', () => {
    const base = { days: [], monthDay: 1 as const, time: 420, custom: null }
    expect(describeCadence({ ...base, cadence: 'once' })).toBe('Once')
    expect(describeCadence({ ...base, cadence: 'daily' })).toBe('Every day')
    expect(describeCadence({ ...base, cadence: 'weekly', days: [] })).toBe('Weekly')
    expect(describeCadence({ ...base, cadence: 'weekly', days: [0, 1, 2, 3, 4] })).toBe('Weekdays')
    expect(describeCadence({ ...base, cadence: 'weekly', days: [5, 6] })).toBe('Weekends')
    expect(describeCadence({ ...base, cadence: 'weekly', days: [4] })).toBe('Fridays')
    expect(describeCadence({ ...base, cadence: 'weekly', days: [4, 6] })).toBe('Fri, Sun')
    expect(describeCadence({ ...base, cadence: 'monthly', monthDay: 3 })).toBe('Monthly on the 3rd')
    expect(describeCadence({ ...base, cadence: 'monthly', monthDay: 'last' })).toBe(
      'Monthly on the last day',
    )
    expect(
      describeCadence({
        ...base,
        cadence: 'custom',
        custom: 'FREQ=DAILY;INTERVAL=2;BYHOUR=9;BYMINUTE=0',
      }),
    ).toBe('Every 2 days')
  })

  test('time of day names the slot, or the slot and time when inside one', () => {
    expect(describeTimeOfDay(9 * 60, SLOTS)).toBe('Morning')
    expect(describeTimeOfDay(19 * 60, SLOTS)).toBe('Afternoon, 7:00 PM')
    expect(describeTimeOfDay(6 * 60, SLOTS)).toBe('6:00 AM')
    expect(describeTimeOfDay(null, SLOTS)).toBeNull()
  })

  test('slotAtMinutes is the latest boundary at or before the time', () => {
    expect(slotAtMinutes(7 * 60, SLOTS)?.label).toBe('Early morning')
    expect(slotAtMinutes(23 * 60, SLOTS)?.label).toBe('Evening')
    expect(slotAtMinutes(6 * 60 + 59, SLOTS)).toBeNull()
  })
})
