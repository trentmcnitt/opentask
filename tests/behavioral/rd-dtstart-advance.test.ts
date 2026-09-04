/**
 * `advanceDtstart` parity: sliding the recurrence epoch toward the reference
 * must never change what rrule.js answers for `after(ref)`.
 *
 * The reference implementation here is rrule.js itself with the original,
 * un-advanced 2020 epoch — exactly what `computeFromDue` did before the epoch
 * started sliding. Every (rule, reference) pair is evaluated both ways and the
 * two results must be identical, including for interval rules whose phase
 * depends on the epoch (every other week, every third month, every 3 days).
 */
import { describe, expect, test } from 'vitest'
import { RRule } from 'rrule'
import { advanceDtstart } from '@/core/recurrence/compute-next'
import { computeNextOccurrence } from '@/core/recurrence'

const EPOCH = (h: number, m: number) => new Date(Date.UTC(2020, 0, 1, h, m, 0, 0))

interface Shape {
  label: string
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'
  interval: number
  byweekday?: number[]
  bymonthday?: number[]
  bysetpos?: number[]
}

const FREQ = {
  DAILY: RRule.DAILY,
  WEEKLY: RRule.WEEKLY,
  MONTHLY: RRule.MONTHLY,
  YEARLY: RRule.YEARLY,
}

const SHAPES: Shape[] = [
  { label: 'daily', freq: 'DAILY', interval: 1 },
  { label: 'every 3 days', freq: 'DAILY', interval: 3 },
  { label: 'every 10 days', freq: 'DAILY', interval: 10 },
  { label: 'weekly Mon/Wed/Fri', freq: 'WEEKLY', interval: 1, byweekday: [0, 2, 4] },
  { label: 'every other Wednesday', freq: 'WEEKLY', interval: 2, byweekday: [2] },
  { label: 'every third Sunday', freq: 'WEEKLY', interval: 3, byweekday: [6] },
  { label: 'weekly, no BYDAY (epoch weekday)', freq: 'WEEKLY', interval: 1 },
  { label: 'monthly on the 15th', freq: 'MONTHLY', interval: 1, bymonthday: [15] },
  { label: 'quarterly on the 1st', freq: 'MONTHLY', interval: 3, bymonthday: [1] },
  { label: 'every other month, 31st', freq: 'MONTHLY', interval: 2, bymonthday: [31] },
  { label: 'last Friday monthly', freq: 'MONTHLY', interval: 1, byweekday: [4], bysetpos: [-1] },
  { label: 'yearly', freq: 'YEARLY', interval: 1 },
  { label: 'every other year', freq: 'YEARLY', interval: 2 },
]

function rule(shape: Shape, dtstart: Date): RRule {
  const weekdays = [RRule.MO, RRule.TU, RRule.WE, RRule.TH, RRule.FR, RRule.SA, RRule.SU]
  return new RRule({
    freq: FREQ[shape.freq],
    interval: shape.interval,
    dtstart,
    byweekday: shape.byweekday?.map((d) => weekdays[d]),
    bymonthday: shape.bymonthday,
    bysetpos: shape.bysetpos,
  })
}

/** A spread of reference instants: before the epoch, near it, and years past it. */
function references(): Date[] {
  const out: Date[] = []
  for (const iso of [
    '2019-06-15T12:00:00Z',
    '2020-01-01T00:00:00Z',
    '2020-01-01T09:00:00Z',
    '2020-01-02T09:00:00Z',
    '2020-02-29T23:59:59.999Z',
    '2021-12-31T09:00:00Z',
  ])
    out.push(new Date(iso))
  // Every 11 days + 5 hours across 2024–2027, so weekdays, month ends and
  // DST-season dates all get exercised (naive UTC, no DST arithmetic involved).
  // The stride is coarse on purpose: the REFERENCE rule still iterates from
  // 2020 on every call, which is exactly the cost this change removes.
  for (let t = Date.UTC(2024, 0, 1, 3, 0); t < Date.UTC(2027, 6, 1); t += (11 * 24 + 5) * 3_600_000)
    out.push(new Date(t))
  return out
}

describe('advanceDtstart parity with the fixed 2020 epoch', () => {
  for (const shape of SHAPES) {
    test(`${shape.label} (INTERVAL=${shape.interval})`, () => {
      const base = EPOCH(9, 0)
      const slow = rule(shape, base)
      for (const ref of references()) {
        const advanced = advanceDtstart(base, shape.freq, shape.interval, ref)
        expect(advanced.getTime()).toBeLessThanOrEqual(Math.max(base.getTime(), ref.getTime()))
        // Preserved intra-day time and (for weekly) weekday.
        expect(advanced.getUTCHours()).toBe(9)
        expect(advanced.getUTCMinutes()).toBe(0)
        if (shape.freq === 'WEEKLY') expect(advanced.getUTCDay()).toBe(base.getUTCDay())
        const fast = rule(shape, advanced)
        const a = slow.after(ref, false)
        const b = fast.after(ref, false)
        expect(b?.toISOString()).toBe(a?.toISOString())
        const ai = slow.after(ref, true)
        const bi = fast.after(ref, true)
        expect(bi?.toISOString()).toBe(ai?.toISOString())
      }
    }, 20_000)
  }

  test('never moves before the epoch, and leaves an early reference alone', () => {
    const base = EPOCH(7, 30)
    expect(advanceDtstart(base, 'DAILY', 1, new Date('2019-01-01T00:00:00Z'))).toEqual(base)
    expect(advanceDtstart(base, 'WEEKLY', 2, new Date('2020-01-20T00:00:00Z'))).toEqual(base)
    expect(advanceDtstart(base, 'MONTHLY', 3, new Date('2020-05-01T00:00:00Z'))).toEqual(base)
    expect(advanceDtstart(base, 'YEARLY', 1, new Date('2021-06-01T00:00:00Z'))).toEqual(base)
    expect(advanceDtstart(base, 'BOGUS', 1, new Date('2030-01-01T00:00:00Z'))).toEqual(base)
  })

  test('computeNextOccurrence is unchanged end-to-end for the corpus shapes', () => {
    // Spot checks through the public API, against values that were true
    // before the epoch started sliding.
    const tz = 'America/Chicago'
    const at = (iso: string) => new Date(iso)
    const next = (rrule: string, anchor: string, ref: string) =>
      computeNextOccurrence({
        rrule,
        recurrenceMode: 'from_due',
        anchorTime: anchor,
        timezone: tz,
        completedAt: at(ref),
        prevDueAt: at(ref),
      }).toISOString()
    expect(next('FREQ=DAILY;BYHOUR=9;BYMINUTE=0', '09:00', '2026-09-03T23:59:59.999Z')).toBe(
      '2026-09-04T14:00:00.000Z',
    )
    expect(
      next(
        'FREQ=WEEKLY;INTERVAL=2;BYDAY=WE;BYHOUR=9;BYMINUTE=0',
        '09:00',
        '2026-09-03T23:59:59.999Z',
      ),
    ).toBe('2026-09-16T14:00:00.000Z')
    expect(
      next('FREQ=MONTHLY;BYMONTHDAY=15;BYHOUR=12;BYMINUTE=0', '12:00', '2026-09-03T23:59:59.999Z'),
    ).toBe('2026-09-15T17:00:00.000Z')
    expect(
      next('FREQ=DAILY;INTERVAL=3;BYHOUR=12;BYMINUTE=0', '12:00', '2026-09-03T23:59:59.999Z'),
    ).toBe('2026-09-05T17:00:00.000Z')
  })
})
