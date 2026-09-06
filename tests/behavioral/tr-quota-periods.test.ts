/**
 * The period table is the single source of FREQ→period truth (§5). It used to
 * be written out five times, and two of the copies had drifted into silent
 * data loss — a YEARLY quota and a quota with no rule at all both read back as
 * WEEKLY, so editing only the target rewrote the schedule underneath the user.
 */
import { describe, test, expect } from 'vitest'
import { quotaFreqOf, periodLabel, periodShort, groupByPeriod, QUOTA_PERIODS } from '@/lib/track'
import type { Task } from '@/types'

const task = (rrule: string | null): Task => ({ rrule }) as Task

describe('quota periods', () => {
  test('every FREQ in the table round-trips, and nothing else does', () => {
    for (const p of QUOTA_PERIODS) {
      expect(quotaFreqOf(`FREQ=${p.freq}`)).toBe(p.freq)
      expect(periodLabel(`FREQ=${p.freq}`)).toBe(p.label)
      expect(periodShort(p.label)).toBe(p.short)
    }
  })

  test('a yearly quota is yearly, not weekly', () => {
    // The old editor had no YEARLY branch and defaulted to WEEKLY, so touching
    // a yearly quota's target silently made it weekly.
    expect(quotaFreqOf('FREQ=YEARLY')).toBe('YEARLY')
    expect(periodLabel('FREQ=YEARLY')).toBe('this year')
  })

  test('no rule means no period — not a default', () => {
    expect(quotaFreqOf(null)).toBeNull()
    expect(quotaFreqOf('')).toBeNull()
    expect(quotaFreqOf('FREQ=FORTNIGHTLY')).toBeNull()
    expect(periodLabel(null)).toBeNull()
  })

  test('grouping orders day-to-year and puts the period-less bucket last', () => {
    const groups = groupByPeriod([
      task('FREQ=MONTHLY'),
      task(null),
      task('FREQ=DAILY'),
      task('FREQ=YEARLY'),
      task('FREQ=WEEKLY'),
    ])
    expect(groups.map((g) => g.period)).toEqual([
      'today',
      'this week',
      'this month',
      'this year',
      null,
    ])
  })

  test('an empty period is omitted rather than rendered blank', () => {
    const groups = groupByPeriod([task('FREQ=WEEKLY')])
    expect(groups.map((g) => g.period)).toEqual(['this week'])
  })
})
