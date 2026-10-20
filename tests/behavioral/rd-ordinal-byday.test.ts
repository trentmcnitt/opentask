/**
 * Ordinal BYDAY (2026-10-20): "monthly on the 1st Saturday" is
 * FREQ=MONTHLY;BYDAY=1SA. parseRRule used to strip the ordinal (`1SA` → `SA`)
 * and the engine then fired on EVERY Saturday — prev Oct 3 → next Oct 10.
 * The ordinal is now kept through parse → build → rrule.js (`RRule.SA.nth(1)`),
 * the formatters say it, and the core mutations advance on it.
 *
 * Dates are America/Chicago; DST ends Sun Nov 1 2026 (CDT −5 → CST −6).
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  buildRRule,
  parseRRule,
  isValidRRule,
  computeNextOccurrence,
  computeFirstOccurrence,
  deriveAnchorFields,
} from '@/core/recurrence'
import { formatRRule, formatRRuleCompact } from '@/lib/format-rrule'
import { recurrenceSummary } from '@/lib/recurrence-summary'
import { createTask, getTaskById, markDone } from '@/core/tasks'
import { skipOccurrence } from '@/core/tasks/skip'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

const TZ = 'America/Chicago'

function next(rrule: string, prevIso: string, anchorAt?: string): string {
  return computeNextOccurrence({
    rrule,
    recurrenceMode: 'from_due',
    anchorTime: null,
    timezone: TZ,
    completedAt: new Date(prevIso),
    prevDueAt: new Date(prevIso),
    anchorAt: anchorAt ? new Date(anchorAt) : undefined,
  }).toISOString()
}

describe('ordinal BYDAY — parse and build', () => {
  test('the ordinal is kept by parseRRule', () => {
    expect(parseRRule('FREQ=MONTHLY;BYDAY=1SA').byday).toEqual([{ day: 5, n: 1 }])
    expect(parseRRule('FREQ=MONTHLY;BYDAY=-1FR').byday).toEqual([{ day: 4, n: -1 }])
    expect(parseRRule('FREQ=MONTHLY;BYDAY=+2TU').byday).toEqual([{ day: 1, n: 2 }])
    expect(parseRRule('FREQ=WEEKLY;BYDAY=MO,WE').byday).toEqual([{ day: 0 }, { day: 2 }])
  })

  test.each([
    'FREQ=MONTHLY;BYDAY=1SA;BYHOUR=9;BYMINUTE=0',
    'FREQ=MONTHLY;BYDAY=2TU;BYHOUR=9;BYMINUTE=0',
    'FREQ=MONTHLY;BYDAY=-1FR;BYHOUR=16;BYMINUTE=0',
    'FREQ=MONTHLY;INTERVAL=2;BYDAY=3WE;BYHOUR=8;BYMINUTE=30',
    'FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1;BYHOUR=16;BYMINUTE=0',
    'FREQ=YEARLY;BYDAY=4TH;BYMONTH=11;BYHOUR=12;BYMINUTE=0',
    'FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=9;BYMINUTE=0',
  ])('round-trips: %s', (rule) => {
    expect(buildRRule(parseRRule(rule))).toBe(rule)
  })

  test('validation: an ordinal only on MONTHLY/YEARLY, never 0, in range', () => {
    expect(isValidRRule('FREQ=MONTHLY;BYDAY=1SA')).toBe(true)
    expect(isValidRRule('FREQ=MONTHLY;BYDAY=-1FR')).toBe(true)
    expect(isValidRRule('FREQ=YEARLY;BYMONTH=11;BYDAY=4TH')).toBe(true)
    expect(isValidRRule('FREQ=WEEKLY;BYDAY=1MO')).toBe(false)
    expect(isValidRRule('FREQ=DAILY;BYDAY=1MO')).toBe(false)
    expect(isValidRRule('FREQ=MONTHLY;BYDAY=0MO')).toBe(false)
    expect(isValidRRule('FREQ=MONTHLY;BYDAY=6MO')).toBe(false)
    expect(isValidRRule('FREQ=MONTHLY;BYDAY=-6MO')).toBe(false)
  })

  test('anchor_dow stays a weekly-only field; an ordinal monthly rule sets none', () => {
    const a = deriveAnchorFields('FREQ=MONTHLY;BYDAY=1SA;BYHOUR=9;BYMINUTE=0', null, TZ)
    expect(a).toEqual({ anchor_time: '09:00', anchor_dow: null, anchor_dom: null })
  })
})

describe('ordinal BYDAY — next occurrence', () => {
  test('1st Saturday: Oct 3 → Nov 7 (not Oct 10), across the DST change', () => {
    // Oct 3 9:00 CDT = 14:00Z; Nov 7 9:00 CST = 15:00Z
    expect(next('FREQ=MONTHLY;BYDAY=1SA;BYHOUR=9;BYMINUTE=0', '2026-10-03T14:00:00Z')).toBe(
      '2026-11-07T15:00:00.000Z',
    )
  })

  test('1st Saturday across a year boundary: Dec 5 → Jan 2', () => {
    expect(next('FREQ=MONTHLY;BYDAY=1SA;BYHOUR=9;BYMINUTE=0', '2026-12-05T15:00:00Z')).toBe(
      '2027-01-02T15:00:00.000Z',
    )
  })

  test('1st Saturday from mid-month (completed late): Oct 20 → Nov 7', () => {
    expect(next('FREQ=MONTHLY;BYDAY=1SA;BYHOUR=9;BYMINUTE=0', '2026-10-20T17:00:00Z')).toBe(
      '2026-11-07T15:00:00.000Z',
    )
  })

  test('1st Sunday lands ON the DST-end day at the rule time: Oct 4 → Nov 1 9:00 CST', () => {
    expect(next('FREQ=MONTHLY;BYDAY=1SU;BYHOUR=9;BYMINUTE=0', '2026-10-04T14:00:00Z')).toBe(
      '2026-11-01T15:00:00.000Z',
    )
  })

  test('2nd Tuesday: Oct 13 → Nov 10 → Dec 8', () => {
    const rule = 'FREQ=MONTHLY;BYDAY=2TU;BYHOUR=9;BYMINUTE=0'
    expect(next(rule, '2026-10-13T14:00:00Z')).toBe('2026-11-10T15:00:00.000Z')
    expect(next(rule, '2026-11-10T15:00:00Z')).toBe('2026-12-08T15:00:00.000Z')
  })

  test('last Friday (-1FR): Oct 23 → Oct 30 (a five-Friday month), Oct 30 → Nov 27', () => {
    const rule = 'FREQ=MONTHLY;BYDAY=-1FR;BYHOUR=16;BYMINUTE=0'
    expect(next(rule, '2026-10-23T21:00:00Z')).toBe('2026-10-30T21:00:00.000Z')
    expect(next(rule, '2026-10-30T21:00:00Z')).toBe('2026-11-27T22:00:00.000Z')
  })

  test('BYDAY=FR;BYSETPOS=-1 gives the same days as -1FR', () => {
    const rule = 'FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1;BYHOUR=16;BYMINUTE=0'
    expect(next(rule, '2026-10-23T21:00:00Z')).toBe('2026-10-30T21:00:00.000Z')
    expect(next(rule, '2026-10-30T21:00:00Z')).toBe('2026-11-27T22:00:00.000Z')
  })

  test('every 2 months on the 2nd Tuesday, on the task own grid: Oct 13 → Dec 8', () => {
    const rule = 'FREQ=MONTHLY;INTERVAL=2;BYDAY=2TU;BYHOUR=9;BYMINUTE=0'
    expect(next(rule, '2026-10-13T14:00:00Z', '2026-10-13T14:00:00Z')).toBe(
      '2026-12-08T15:00:00.000Z',
    )
  })

  test('yearly on the 4th Thursday of November: 2026 → 2027', () => {
    const rule = 'FREQ=YEARLY;BYMONTH=11;BYDAY=4TH;BYHOUR=12;BYMINUTE=0'
    expect(next(rule, '2026-11-26T18:00:00Z')).toBe('2027-11-25T18:00:00.000Z')
  })

  test('a plain BYDAY in a monthly rule still means every such weekday', () => {
    expect(next('FREQ=MONTHLY;BYDAY=SA;BYHOUR=9;BYMINUTE=0', '2026-10-03T14:00:00Z')).toBe(
      '2026-10-10T14:00:00.000Z',
    )
  })

  test('first occurrence of a 1st-Saturday rule made Oct 20 is Nov 7', () => {
    const first = computeFirstOccurrence(
      'FREQ=MONTHLY;BYDAY=1SA;BYHOUR=9;BYMINUTE=0',
      null,
      TZ,
      new Date('2026-10-20T15:00:00Z'),
    )
    expect(first.toISOString()).toBe('2026-11-07T15:00:00.000Z')
  })
})

describe('ordinal BYDAY — formatters', () => {
  test('formatRRule names the position', () => {
    expect(formatRRule('FREQ=MONTHLY;BYDAY=1SA;BYHOUR=9;BYMINUTE=0')).toBe(
      'Monthly on the 1st Saturday at 9:00 AM',
    )
    expect(formatRRule('FREQ=MONTHLY;BYDAY=-1FR;BYHOUR=16;BYMINUTE=0')).toBe(
      'Monthly on the last Friday at 4:00 PM',
    )
    expect(formatRRule('FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1;BYHOUR=16;BYMINUTE=0')).toBe(
      'Monthly on the last Friday at 4:00 PM',
    )
    expect(formatRRule('FREQ=MONTHLY;BYDAY=SA;BYHOUR=9;BYMINUTE=0')).toBe(
      'Monthly on Saturday at 9:00 AM',
    )
  })

  test('formatRRuleCompact (the Quick panel line) names the position', () => {
    expect(formatRRuleCompact('FREQ=MONTHLY;BYDAY=1SA;BYHOUR=9;BYMINUTE=0')).toBe(
      'Monthly on the 1st Sat at 9:00 AM',
    )
    expect(formatRRuleCompact('FREQ=MONTHLY;INTERVAL=2;BYDAY=2TU;BYHOUR=9;BYMINUTE=0')).toBe(
      'Every 2 months on the 2nd Tue at 9:00 AM',
    )
    expect(formatRRuleCompact('FREQ=MONTHLY;BYDAY=-1FR')).toBe('Monthly on the last Fri')
  })

  test('recurrenceSummary (the row and widget words) agrees', () => {
    expect(recurrenceSummary('FREQ=MONTHLY;BYDAY=1SA;BYHOUR=9;BYMINUTE=0')).toBe(
      'monthly on the 1st Sat at 9 AM',
    )
  })
})

describe('ordinal BYDAY — through markDone and skipOccurrence', () => {
  beforeEach(() => {
    // Sat Oct 3 2026, 8:00 AM CDT — before the 1st Saturday's 9 AM.
    vi.setSystemTime(new Date('2026-10-03T13:00:00Z'))
    setupTestDb()
  })

  afterEach(() => {
    vi.useRealTimers()
    teardownTestDb()
  })

  function make() {
    return createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Check out Home Depot craft',
        rrule: 'FREQ=MONTHLY;BYDAY=1SA;BYHOUR=9;BYMINUTE=0',
        due_at: '2026-10-03T14:00:00.000Z',
      },
    })
  }

  test('the stored rule keeps its ordinal', () => {
    expect(make().rrule).toBe('FREQ=MONTHLY;BYDAY=1SA;BYHOUR=9;BYMINUTE=0')
  })

  test('done on Oct 3 brings Nov 7, then Dec 5', () => {
    const task = make()
    vi.setSystemTime(new Date('2026-10-03T14:30:00Z'))
    markDone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: task.id })
    expect(getTaskById(task.id)!.due_at).toBe('2026-11-07T15:00:00.000Z')
    markDone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: task.id })
    expect(getTaskById(task.id)!.due_at).toBe('2026-12-05T15:00:00.000Z')
  })

  test('skip on Oct 3 brings Nov 7, never Oct 10', () => {
    const task = make()
    const { task: after } = skipOccurrence({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
    })
    expect(after.due_at).toBe('2026-11-07T15:00:00.000Z')
  })
})
