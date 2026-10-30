/**
 * T1, THE TARGET MENU (Trent, 2026-10-30; `src/lib/target-menu.ts`): six rows
 * — Next period, 1 hour, 2 hours, Tomorrow, This/Next weekend, Next week —
 * then every other period as buttons. Friday drops This weekend (Tomorrow is
 * Saturday); Saturday and Sunday offer Next weekend; Sunday hides Next week
 * (it would be tomorrow). Days are OpenTask days.
 */
import { describe, test, expect } from 'vitest'
import { DateTime } from 'luxon'
import { targetMenu } from '@/lib/target-menu'
import type { TimeSlot } from '@/lib/time-slot-assign'

const TZ = 'America/Chicago'
const DAY_START = '03:00'
const MORNING = '08:30'

const slot = (id: number, label: string, start_time: string) =>
  ({ id, label, start_time }) as unknown as TimeSlot

const FIVE = [
  slot(1, 'Early', '06:30'),
  slot(2, 'Morning', '08:30'),
  slot(3, 'Lunchtime', '12:00'),
  slot(4, 'Dinner', '18:00'),
  slot(5, 'Bed', '20:15'),
]

/** A local wall-clock moment in the test zone. */
const at = (iso: string) => DateTime.fromISO(iso, { zone: TZ }).toJSDate()
const local = (iso: string) =>
  DateTime.fromISO(iso, { zone: 'utc' }).setZone(TZ).toFormat('ccc yyyy-MM-dd HH:mm')

function menu(nowIso: string, slots = FIVE) {
  return targetMenu({
    now: at(nowIso),
    timezone: TZ,
    dayStart: DAY_START,
    morningTime: MORNING,
    slots,
  })
}

describe('T1 target menu', () => {
  test('TM-T1-1: a Wednesday — six rows in order, the next period first, the rest as buttons in day order', () => {
    // Wed Oct 28 2026, 11:00.
    const m = menu('2026-10-28T11:00')
    expect(m.rows.map((r) => r.label)).toEqual([
      'Next period · Lunchtime 12:00 PM',
      '1 hour',
      '2 hours',
      'Tomorrow',
      'This weekend',
      'Next week',
    ])
    expect(m.rows.map((r) => r.detail ?? null)).toEqual([
      null,
      null,
      null,
      'Thu 8:30 AM',
      'Sat 8:30 AM',
      'Mon 8:30 AM',
    ])
    const byOption = new Map(m.rows.map((r) => [r.option, local(r.at)]))
    expect(byOption.get('slot:12:00')).toBe('Wed 2026-10-28 12:00')
    expect(byOption.get('60')).toBe('Wed 2026-10-28 12:00')
    expect(byOption.get('tomorrow')).toBe('Thu 2026-10-29 08:30')
    expect(byOption.get('this-weekend')).toBe('Sat 2026-10-31 08:30')
    expect(byOption.get('next-week')).toBe('Mon 2026-11-02 08:30')
    // The periods: all but Lunchtime, in day order; a passed one goes to tomorrow.
    expect(m.periods.map((p) => `${p.label} ${p.time}`)).toEqual([
      'Early 6:30',
      'Morning 8:30',
      'Dinner 6:00',
      'Bed 8:15',
    ])
    expect(local(m.periods[0].at)).toBe('Thu 2026-10-29 06:30')
    expect(local(m.periods[2].at)).toBe('Wed 2026-10-28 18:00')
    for (const r of m.rows.slice(3)) expect(r.needsDay).toBe(true)
  })

  test('TM-T1-2: a Friday drops This weekend — Tomorrow is Saturday', () => {
    const m = menu('2026-10-30T11:00')
    expect(m.rows.map((r) => r.option)).toEqual([
      'slot:12:00',
      '60',
      '120',
      'tomorrow',
      'next-week',
    ])
    expect(m.rows.find((r) => r.option === 'tomorrow')?.detail).toBe('Sat 8:30 AM')
  })

  test('TM-T1-3: a Saturday offers Next weekend (the Saturday after) and Next week', () => {
    const m = menu('2026-10-31T11:00')
    const weekend = m.rows.find((r) => r.option === 'next-weekend')!
    expect(weekend.label).toBe('Next weekend')
    expect(weekend.detail).toBe('Sat Nov 7')
    expect(local(weekend.at)).toBe('Sat 2026-11-07 08:30')
    expect(m.rows.some((r) => r.option === 'this-weekend')).toBe(false)
    expect(local(m.rows.find((r) => r.option === 'next-week')!.at)).toBe('Mon 2026-11-02 08:30')
  })

  test('TM-T1-4: a Sunday — Next weekend is the coming Saturday; Next week hides (it is tomorrow)', () => {
    const m = menu('2026-11-01T11:00')
    expect(m.rows.map((r) => r.option)).toEqual([
      'slot:12:00',
      '60',
      '120',
      'tomorrow',
      'next-weekend',
    ])
    expect(m.rows.find((r) => r.option === 'tomorrow')?.detail).toBe('Mon 8:30 AM')
    expect(m.rows.find((r) => r.option === 'next-weekend')?.detail).toBe('Sat Nov 7')
  })

  test('TM-T1-5: after the last period the top row is tomorrow’s first, and Bed is a button again', () => {
    const m = menu('2026-10-28T21:00')
    expect(m.rows[0].label).toBe('Next period · Early tomorrow 6:30 AM')
    expect(local(m.rows[0].at)).toBe('Thu 2026-10-29 06:30')
    expect(m.periods.map((p) => p.label)).toEqual(['Morning', 'Lunchtime', 'Dinner', 'Bed'])
  })

  test('TM-T1-6: late at night the days are OpenTask days — at 1:30 AM Saturday it is still Friday', () => {
    // Calendar Sat Oct 31 01:30; with a 3:00 AM start the OpenTask day is Friday.
    const m = menu('2026-10-31T01:30')
    expect(m.rows.some((r) => r.option === 'this-weekend')).toBe(false)
    const tomorrow = m.rows.find((r) => r.option === 'tomorrow')!
    expect(local(tomorrow.at)).toBe('Sat 2026-10-31 08:30')
  })

  test('TM-T1-7: ten periods stay buttons — the rows never grow; no periods, no Next period row', () => {
    const ten = [
      ...FIVE,
      slot(6, 'Mid-morning', '10:00'),
      slot(7, 'Early afternoon', '14:00'),
      slot(8, 'After school', '16:30'),
      slot(9, 'Evening', '19:00'),
      slot(10, 'Late night', '22:00'),
    ]
    const m = menu('2026-10-28T11:00', ten)
    expect(m.rows).toHaveLength(6)
    expect(m.periods).toHaveLength(9)
    const none = menu('2026-10-28T11:00', [])
    expect(none.rows.map((r) => r.option)).toEqual([
      '60',
      '120',
      'tomorrow',
      'this-weekend',
      'next-week',
    ])
    expect(none.periods).toEqual([])
  })
})
