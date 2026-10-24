/**
 * TQ-QP: A QUOTA PERIOD'S IDENTITY IS ITS FIRST DATE ("Day starts at" PR 2,
 * the review of 2026-10-24) — `quotaPeriodEnd`, `anchorOnPeriodStart`,
 * `anchorDate` in src/lib/week-start.ts, pure.
 *
 * Properties, over every-1/2/3 weeks, months (3 = a quarter) and years, both
 * week starts, day starts 00:00, 03:00, 06:30 and 23:00, chains that cross
 * both America/Chicago DST nights (fall back 2026-11-01, spring forward
 * 2027-03-14), with the day start changed mid-chain in both directions:
 *
 * - THE PHASE IS KEPT: period i starts on first date + i × interval units,
 *   whatever the day starts were and whenever they changed;
 * - THE BOUNDS are `dayStartMoment` of those dates under the day start in
 *   force when the period ends;
 * - a full-length period is NEVER a transition (`anchorOnPeriodStart`);
 * - at midnight from a midnight anchor (the task queue off), every end is
 *   the old rule's exactly: calendar addition, the week rule for weeks.
 *
 * And the one real transition: a date that is not its unit's first date (a
 * Monday anchor in Sunday weeks) ends at the next unit's start, then aligns.
 */
import { describe, test, expect } from 'vitest'
import { DateTime } from 'luxon'
import { addDays, dayStartMoment } from '@/lib/opentask-day'
import {
  anchorDate,
  anchorOnPeriodStart,
  quotaPeriodEnd,
  unitStartAt,
  type PeriodUnit,
  type WeekStart,
} from '@/lib/week-start'
import { quotaPeriodFields } from '@/lib/track'

const TZ = 'America/Chicago'
const STARTS = ['00:00', '03:00', '06:30', '23:00'] as const
const UNITS: [PeriodUnit, number][] = [
  ['weeks', 1],
  ['weeks', 2],
  ['weeks', 3],
  ['months', 1],
  ['months', 3],
  ['years', 1],
]
const WEEK_STARTS: WeekStart[] = ['sunday', 'monday']
/** Chain starts, each a few periods before a DST night. */
const FROM = ['2026-09-20T12:00', '2027-02-10T12:00', '2026-10-24T01:30', '2026-10-24T23:30']

const local = (iso: string) => DateTime.fromISO(iso, { zone: TZ })
const plusUnits = (date: string, unit: PeriodUnit, n: number) =>
  DateTime.fromISO(date, { zone: 'utc' })
    .plus({ [unit]: n })
    .toFormat('yyyy-MM-dd')
const moment = (date: string, dayStart: string) =>
  DateTime.fromJSDate(dayStartMoment(date, TZ, dayStart)).setZone(TZ)

/**
 * Walk `steps` periods from the unit start `from` falls in under `first`,
 * switching to day start `then` after `switchAt` periods.
 */
function walk(
  from: string,
  unit: PeriodUnit,
  interval: number,
  ws: WeekStart,
  first: string,
  then: string,
  switchAt: number,
  steps: number,
) {
  let anchor = unitStartAt(local(from), unit, ws, first)
  const firstDate = anchorDate(anchor)
  const out: { start: DateTime; end: DateTime; dayStart: string; full: boolean }[] = []
  for (let i = 0; i < steps; i++) {
    const dayStart = i < switchAt ? first : then
    const end = quotaPeriodEnd(anchor, unit, interval, ws, dayStart)
    out.push({ start: anchor, end, dayStart, full: anchorOnPeriodStart(anchor, unit, ws) })
    anchor = end
  }
  return { firstDate, out }
}

describe('TQ-QP: the phase is the date — day starts move the bounds, never the phase', () => {
  for (const [unit, interval] of UNITS) {
    for (const ws of WEEK_STARTS) {
      if (unit !== 'weeks' && ws === 'monday') continue
      test(`TQ-QP01: every ${interval} ${unit} (${ws}) — phase, bounds and no transition, every day start and every change`, () => {
        const steps = unit === 'years' ? 3 : 6
        for (const from of FROM) {
          for (const first of STARTS) {
            for (const then of STARTS) {
              for (const switchAt of [0, 1, 2]) {
                const { firstDate, out } = walk(
                  from,
                  unit,
                  interval,
                  ws,
                  first,
                  then,
                  switchAt,
                  steps,
                )
                out.forEach((p, i) => {
                  const label = `${from} ${first}→${then}@${switchAt} #${i}`
                  // Phase: period i stands for first date + i × interval.
                  expect(anchorDate(p.start), label).toBe(plusUnits(firstDate, unit, i * interval))
                  // Bounds: the day start of the next period's first date.
                  const next = plusUnits(firstDate, unit, (i + 1) * interval)
                  expect(p.end.toMillis(), label).toBe(moment(next, p.dayStart).toMillis())
                  // A full-length period is never a transition.
                  expect(p.full, label).toBe(true)
                })
              }
            }
          }
        }
      })
    }
  }

  test("TQ-QP02: the served period — its last day is the day before the next period's first date, at every day start", () => {
    const now = local('2026-10-20T12:00').toJSDate()
    for (const [anchor, ds] of [
      ['2026-10-01T00:00', '00:00'],
      ['2026-10-01T03:00', '00:00'],
      ['2026-10-01T00:00', '03:00'],
      ['2026-09-30T23:00', '23:00'],
      ['2026-10-01T03:00', '23:00'],
    ] as const) {
      const fields = quotaPeriodFields(
        {
          rrule: 'FREQ=MONTHLY;INTERVAL=3',
          progress_period_start: local(anchor).toUTC().toISO(),
          progress_target: 1,
          is_tracked: true,
        },
        TZ,
        now,
        'sunday',
        ds,
      )
      expect(fields.period_last_day, `${anchor} ${ds}`).toBe('2026-12-31')
      expect(fields.period_label, `${anchor} ${ds}`).toBe('by Dec 31')
      expect(fields.progress_period_end, `${anchor} ${ds}`).toBe(
        moment('2027-01-01', ds).toUTC().toISO(),
      )
    }
  })

  test('TQ-QP03: an anchor stamped at 23:00 stands for the next date; one at 00:00–12:00 for its own', () => {
    expect(anchorDate(local('2026-10-10T23:00'))).toBe('2026-10-11')
    expect(anchorDate(local('2026-10-11T00:00'))).toBe('2026-10-11')
    expect(anchorDate(local('2026-10-11T06:30'))).toBe('2026-10-11')
    expect(anchorDate(local('2026-10-11T12:00'))).toBe('2026-10-11')
    expect(anchorDate(local('2026-10-11T12:01'))).toBe('2026-10-12')
    // The spring-forward night: a 02:30 start stamps 03:00, still its date.
    expect(
      anchorDate(DateTime.fromJSDate(dayStartMoment('2027-03-14', TZ, '02:30')).setZone(TZ)),
    ).toBe('2027-03-14')
    // Fall back: both 01:30s are Nov 1.
    const first = DateTime.fromObject(
      { year: 2026, month: 11, day: 1, hour: 1, minute: 30 },
      { zone: TZ },
    )
    expect(anchorDate(first)).toBe('2026-11-01')
    expect(anchorDate(first.plus({ hours: 1 }))).toBe('2026-11-01')
  })
})

describe('TQ-QP: the switch off (midnight) is the old rule exactly', () => {
  test('TQ-QP10: from a midnight anchor at midnight, every end is calendar addition (the week rule for weeks)', () => {
    for (const [unit, interval] of [
      ...UNITS,
      ['days', 1] as [PeriodUnit, number],
      ['days', 2] as [PeriodUnit, number],
    ]) {
      for (const from of FROM) {
        let anchor = unitStartAt(local(from), unit, 'sunday', '00:00')
        for (let i = 0; i < 8; i++) {
          const end = quotaPeriodEnd(anchor, unit, interval, 'sunday', '00:00')
          expect(end.toMillis(), `${unit}×${interval} ${from} #${i}`).toBe(
            anchor.plus({ [unit]: interval }).toMillis(),
          )
          expect(end.hour * 60 + end.minute).toBe(0)
          anchor = end
        }
      }
    }
  })
})

describe("TQ-QP: the one real transition — a date that is not its unit's first date", () => {
  test("TQ-QP20: a Monday anchor in Sunday weeks ends at the next Sunday's day start, then runs the full interval", () => {
    for (const ds of STARTS) {
      for (const interval of [1, 2]) {
        const anchor = local('2026-10-19T00:00')
        expect(anchorOnPeriodStart(anchor, 'weeks', 'sunday')).toBe(false)
        const end = quotaPeriodEnd(anchor, 'weeks', interval, 'sunday', ds)
        expect(end.toMillis(), `${ds} ×${interval}`).toBe(moment('2026-10-25', ds).toMillis())
        expect(anchorOnPeriodStart(end, 'weeks', 'sunday')).toBe(true)
        expect(quotaPeriodEnd(end, 'weeks', interval, 'sunday', ds).toMillis()).toBe(
          moment(addDays('2026-10-25', 7 * interval), ds).toMillis(),
        )
      }
    }
  })

  test('TQ-QP21: a mid-month anchor (a timezone move far enough to change its date) ends at the 1st', () => {
    const anchor = local('2026-01-31T03:00')
    expect(anchorOnPeriodStart(anchor, 'months', 'sunday')).toBe(false)
    expect(quotaPeriodEnd(anchor, 'months', 3, 'sunday', '03:00').toJSDate()).toEqual(
      moment('2026-02-01', '03:00').toJSDate(),
    )
  })
})
