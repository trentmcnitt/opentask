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
  normalizeRRule,
  computeNextOccurrence,
  computeFirstOccurrence,
  deriveAnchorFields,
} from '@/core/recurrence'
import { formatRRule, formatRRuleCompact } from '@/lib/format-rrule'
import { validateTaskCreate, validateTaskUpdate } from '@/core/validation'
import { DateTime } from 'luxon'
import { EnrichmentResultSchema, type EnrichmentResult } from '@/core/ai/types'
import { postProcessTaskEnrichment, pinUnnamedDay, snapDueAtToByday } from '@/core/ai/enrichment'
import { recurrenceSummary } from '@/lib/recurrence-summary'
import { createTask, getTaskById, markDone } from '@/core/tasks'
import { skipOccurrence } from '@/core/tasks/skip'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'
import { CALENDAR_DAY_START } from '@/lib/opentask-day'

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

  test('validation: a MONTHLY/YEARLY ordinal never 0, in range', () => {
    expect(isValidRRule('FREQ=MONTHLY;BYDAY=1SA')).toBe(true)
    expect(isValidRRule('FREQ=MONTHLY;BYDAY=-1FR')).toBe(true)
    expect(isValidRRule('FREQ=YEARLY;BYMONTH=11;BYDAY=4TH')).toBe(true)
    expect(isValidRRule('FREQ=YEARLY;BYDAY=54TH')).toBe(false)
    expect(isValidRRule('FREQ=MONTHLY;BYDAY=0MO')).toBe(false)
    expect(isValidRRule('FREQ=MONTHLY;BYDAY=6MO')).toBe(false)
    expect(isValidRRule('FREQ=MONTHLY;BYDAY=-6MO')).toBe(false)
  })

  test('a WEEKLY/DAILY ordinal is accepted and normalized away, never refused', () => {
    // Accepted before 2026-10-20; clients may echo such a stored rule back.
    expect(isValidRRule('FREQ=WEEKLY;BYDAY=1FR')).toBe(true)
    expect(isValidRRule('FREQ=DAILY;BYDAY=1MO')).toBe(true)
    expect(normalizeRRule('FREQ=WEEKLY;BYDAY=1FR;BYHOUR=9;BYMINUTE=0')).toBe(
      'FREQ=WEEKLY;BYDAY=FR;BYHOUR=9;BYMINUTE=0',
    )
    expect(normalizeRRule('FREQ=WEEKLY;BYDAY=-1MO,+2WE,FR')).toBe('FREQ=WEEKLY;BYDAY=MO,WE,FR')
    // Anything else is returned exactly as given.
    for (const rule of [
      'FREQ=MONTHLY;BYDAY=1SA;BYHOUR=9;BYMINUTE=0',
      'FREQ=WEEKLY;BYDAY=MO,WE',
      'FREQ=DAILY;BYHOUR=8;BYMINUTE=0',
    ])
      expect(normalizeRRule(rule)).toBe(rule)
  })

  test('input validation stores the normalized rule (create and update)', () => {
    expect(validateTaskCreate({ title: 'x', rrule: 'FREQ=WEEKLY;BYDAY=1FR' }).rrule).toBe(
      'FREQ=WEEKLY;BYDAY=FR',
    )
    expect(validateTaskUpdate({ rrule: 'FREQ=WEEKLY;BYDAY=2TU;BYHOUR=9;BYMINUTE=0' }).rrule).toBe(
      'FREQ=WEEKLY;BYDAY=TU;BYHOUR=9;BYMINUTE=0',
    )
    expect(validateTaskCreate({ title: 'x', rrule: 'FREQ=MONTHLY;BYDAY=1SA' }).rrule).toBe(
      'FREQ=MONTHLY;BYDAY=1SA',
    )
    expect(() => validateTaskCreate({ title: 'x', rrule: 'FREQ=MONTHLY;BYDAY=6SA' })).toThrow()
  })

  test('a legacy stored WEEKLY "1FR" runs as every Friday', () => {
    // Fri Oct 16 2026 16:00 CDT → Fri Oct 23
    expect(next('FREQ=WEEKLY;BYDAY=1FR;BYHOUR=16;BYMINUTE=0', '2026-10-16T21:00:00Z')).toBe(
      '2026-10-23T21:00:00.000Z',
    )
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
      CALENDAR_DAY_START,
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

  test('"last weekday of the month" reads as such, not "the last Monday"', () => {
    const rule = 'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;BYHOUR=17;BYMINUTE=0'
    expect(formatRRule(rule)).toBe('Monthly on the last weekday at 5:00 PM')
    expect(formatRRuleCompact(rule)).toBe('Monthly on the last weekday at 5:00 PM')
    expect(formatRRuleCompact('FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=1')).toBe(
      'Monthly on the 1st weekday',
    )
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

describe('ordinal BYDAY — AI enrichment', () => {
  const base: EnrichmentResult = {
    title: 'Team sync',
    due_at: null,
    deadline_at: null,
    horizon: null,
    priority: 2,
    labels: [],
    project_name: null,
    rrule: 'FREQ=WEEKLY;BYDAY=2TU;BYHOUR=10;BYMINUTE=0',
    auto_snooze_minutes: null,
    recurrence_mode: null,
    notes: null,
    reasoning: '',
  }

  test('a model WEEKLY "2TU" passes the schema and is stored as plain TU', () => {
    const parsed = EnrichmentResultSchema.safeParse(base)
    expect(parsed.success).toBe(true)
    const out = postProcessTaskEnrichment(parsed.data!, 'team sync every tuesday at 10', TZ, {
      dayStart: CALENDAR_DAY_START,
      morningTime: '09:00',
      todayTarget: '09:00',
      now: new Date('2026-10-20T15:00:00Z'),
    })
    expect(out.rrule).toBe('FREQ=WEEKLY;BYDAY=TU;BYHOUR=10;BYMINUTE=0')
    // The rest of the enrichment survives.
    expect(out.title).toBe('Team sync')
    expect(out.priority).toBe(2)
    expect(
      pinUnnamedDay(base, 'every tuesday at 10', TZ, new Date(), CALENDAR_DAY_START).rrule,
    ).toBe('FREQ=WEEKLY;BYDAY=TU;BYHOUR=10;BYMINUTE=0')
  })

  test('snap: a 1st-Saturday rule moves the model date to a real occurrence', () => {
    const rule = 'FREQ=MONTHLY;BYDAY=1SA;BYHOUR=9;BYMINUTE=0'
    // Sat Oct 10 (the 2nd Saturday) → Sat Nov 7, same time.
    const second = DateTime.fromISO('2026-10-10T09:00:00', { zone: TZ })
    expect(snapDueAtToByday(second, rule).toISO()).toBe('2026-11-07T09:00:00.000-06:00')
    // Thu Oct 1 → Sat Oct 3 (on or after the model date).
    const thu = DateTime.fromISO('2026-10-01T09:00:00', { zone: TZ })
    expect(snapDueAtToByday(thu, rule).toISO()).toBe('2026-10-03T09:00:00.000-05:00')
    // Already an occurrence: unchanged (same object).
    const first = DateTime.fromISO('2026-10-03T09:00:00', { zone: TZ })
    expect(snapDueAtToByday(first, rule)).toBe(first)
    // Last Friday: Oct 23 → Oct 30.
    const fri = DateTime.fromISO('2026-10-23T16:00:00', { zone: TZ })
    expect(snapDueAtToByday(fri, 'FREQ=MONTHLY;BYDAY=-1FR').toISO()).toBe(
      '2026-10-30T16:00:00.000-05:00',
    )
  })

  test('snap: a weekly rule still snaps by weekday', () => {
    const thu = DateTime.fromISO('2026-10-22T18:00:00', { zone: TZ })
    expect(snapDueAtToByday(thu, 'FREQ=WEEKLY;BYDAY=MO,WE').toISO()).toBe(
      '2026-10-26T18:00:00.000-05:00',
    )
  })
})
