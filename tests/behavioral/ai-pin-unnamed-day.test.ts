/**
 * AI-PIN: a repeat with no day named starts from today (Trent, 2026-10-12).
 * "Every 2 weeks" said on a Thursday is every other Thursday; "every month"
 * said on the 12th is the 12th. `pinUnnamedDay` (src/core/ai/enrichment.ts)
 * replaces the model's day when the input names none — the prompt used to
 * teach BYDAY=MO and BYMONTHDAY=1. Pure; America/Chicago.
 */
import { describe, test, expect } from 'vitest'
import { pinUnnamedDay } from '@/core/ai/enrichment'
import type { EnrichmentResult } from '@/core/ai/types'
import { CALENDAR_DAY_START } from '@/lib/opentask-day'

const TZ = 'America/Chicago'
// Thu Oct 15 2026, 10:00 Chicago.
const THURSDAY = new Date('2026-10-15T15:00:00Z')

function result(rrule: string | null, due_at: string | null = null): EnrichmentResult {
  return {
    title: 'Synthetic',
    due_at,
    deadline_at: null,
    horizon: null,
    priority: 0,
    labels: [],
    project_name: null,
    rrule,
    auto_snooze_minutes: null,
    recurrence_mode: null,
    notes: null,
    reasoning: '',
  } as EnrichmentResult
}

const pin = (text: string, rrule: string | null, due: string | null = null, now = THURSDAY) =>
  pinUnnamedDay(result(rrule, due), text, TZ, now, CALENDAR_DAY_START)

describe('AI-PIN: weekly with no day named', () => {
  test.each([
    ['clean the fish tank every 2 weeks', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO'],
    ['mow the lawn every other week', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO'],
    ['biweekly payroll check', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=FR'],
  ])('AI-PIN-001: "%s" → today (Thursday)', (text, rrule) => {
    expect(pin(text, rrule).rrule).toBe(rrule.replace(/BYDAY=\w\w/, 'BYDAY=TH'))
  })

  test('AI-PIN-002: a named weekday is the user’s — left alone', () => {
    expect(pin('every other Friday water the ferns', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=FR').rrule).toBe(
      'FREQ=WEEKLY;INTERVAL=2;BYDAY=FR',
    )
    expect(pin('biweekly on weds', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=WE').rrule).toBe(
      'FREQ=WEEKLY;INTERVAL=2;BYDAY=WE',
    )
    expect(pin('every 2 weeks on the weekend', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=SA').rrule).toBe(
      'FREQ=WEEKLY;INTERVAL=2;BYDAY=SA',
    )
  })

  test('AI-PIN-003: several days ("twice a week") are left alone', () => {
    expect(pin('stretch twice a week', 'FREQ=WEEKLY;BYDAY=TU,TH').rrule).toBe(
      'FREQ=WEEKLY;BYDAY=TU,TH',
    )
  })

  test('AI-PIN-004: a guessed first date is folded into the rule (its time) and dropped', () => {
    const out = pin(
      'every 2 weeks at 3pm call grandma',
      'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO',
      '2026-10-19T15:00:00',
    )
    expect(out.rrule).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=TH;BYHOUR=15;BYMINUTE=0')
    expect(out.due_at).toBeNull()
  })

  test('AI-PIN-005: a stated start ("starting tomorrow") keeps the date and takes its weekday', () => {
    const out = pin(
      'every 2 weeks starting tomorrow',
      'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO',
      '2026-10-16T09:00:00',
    )
    expect(out.rrule).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=FR')
    expect(out.due_at).toBe('2026-10-16T09:00:00')
  })

  test('AI-PIN-006: today is read in the user’s zone (Thu 23:30 Chicago is Fri UTC)', () => {
    const late = new Date('2026-10-16T04:30:00Z')
    expect(pin('every other week', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO', null, late).rrule).toBe(
      'FREQ=WEEKLY;INTERVAL=2;BYDAY=TH',
    )
  })
})

describe('AI-PIN: monthly with no date named', () => {
  test.each([
    ['pay the water bill every month', 'FREQ=MONTHLY;BYMONTHDAY=1'],
    ['file quarterly taxes every quarter', 'FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=1'],
    ['replace the filter every 3 months', 'FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=1'],
  ])('AI-PIN-010: "%s" → today’s day of the month (15)', (text, rrule) => {
    expect(pin(text, rrule).rrule).toBe(rrule.replace('BYMONTHDAY=1', 'BYMONTHDAY=15'))
  })

  test('AI-PIN-011: a named date is the user’s — left alone', () => {
    expect(pin('pay rent on the 1st every month', 'FREQ=MONTHLY;BYMONTHDAY=1').rrule).toBe(
      'FREQ=MONTHLY;BYMONTHDAY=1',
    )
    expect(pin('every month at the end of the month', 'FREQ=MONTHLY;BYMONTHDAY=-1').rrule).toBe(
      'FREQ=MONTHLY;BYMONTHDAY=-1',
    )
    expect(pin('twice a month', 'FREQ=MONTHLY;BYMONTHDAY=1,15').rrule).toBe(
      'FREQ=MONTHLY;BYMONTHDAY=1,15',
    )
    expect(pin('every month', 'FREQ=MONTHLY;BYDAY=1MO').rrule).toBe('FREQ=MONTHLY;BYDAY=1MO')
  })

  test('AI-PIN-012: made on the last day of a month → BYMONTHDAY=-1, never skipping short months', () => {
    const oct31 = new Date('2026-10-31T15:00:00Z')
    expect(pin('every month', 'FREQ=MONTHLY;BYMONTHDAY=1', null, oct31).rrule).toBe(
      'FREQ=MONTHLY;BYMONTHDAY=-1',
    )
  })
})

describe('AI-PIN: everything else', () => {
  test('AI-PIN-020: other frequencies and no rule pass through', () => {
    expect(pin('every day', 'FREQ=DAILY').rrule).toBe('FREQ=DAILY')
    expect(pin('every year', 'FREQ=YEARLY').rrule).toBe('FREQ=YEARLY')
    expect(pin('buy milk', null).rrule).toBeNull()
  })

  test('AI-PIN-021: a rule already on today is returned as is', () => {
    const r = result('FREQ=WEEKLY;INTERVAL=2;BYDAY=TH')
    expect(pinUnnamedDay(r, 'every 2 weeks', TZ, THURSDAY, CALENDAR_DAY_START)).toEqual(r)
  })
})

/**
 * A yearly rule that names a month but no day starts on the 1st (Trent,
 * 2026-10-13): "every year in March" is March 1st — never March <today's date>,
 * which the today rule taught the model. Today's date is for the open weekly
 * and monthly rules only. "Every year" with no month is left as the model
 * wrote it: a bare FREQ=YEARLY floats from the creation day (its anniversary).
 */
describe('AI-PIN: yearly in a named month with no day', () => {
  test('AI-PIN-030: "every year in March" → BYMONTHDAY=1, whatever day the model gave', () => {
    const text = 'renew car registration every year in March'
    expect(pin(text, 'FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=15').rrule).toBe(
      'FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=1',
    )
    expect(pin(text, 'FREQ=YEARLY;BYMONTH=3').rrule).toBe('FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=1')
    expect(pin(text, 'FREQ=YEARLY;BYMONTH=3;BYDAY=1MO').rrule).toBe(
      'FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=1',
    )
  })

  test('AI-PIN-031: the model’s due_at (March <today>) is dropped and its time folded into the rule', () => {
    const out = pin(
      'renew car registration every year in March',
      'FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=15',
      '2027-03-15T09:00:00',
    )
    expect(out.rrule).toBe('FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0')
    expect(out.due_at).toBeNull()
  })

  test('AI-PIN-032: a stated rule time is kept; the due_at still goes', () => {
    const out = pin(
      'every year in March at 10am renew the registration',
      'FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=15;BYHOUR=10;BYMINUTE=0',
      '2027-03-15T10:00:00',
    )
    expect(out.rrule).toBe('FREQ=YEARLY;BYMONTH=3;BYHOUR=10;BYMINUTE=0;BYMONTHDAY=1')
    expect(out.due_at).toBeNull()
  })

  test('AI-PIN-033: several months all start on the 1st', () => {
    expect(
      pin('service the furnace every year in March and September', 'FREQ=YEARLY;BYMONTH=3,9').rrule,
    ).toBe('FREQ=YEARLY;BYMONTH=3,9;BYMONTHDAY=1')
  })

  test.each([
    ['every year on March 15', 'FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=15'],
    ['every year on Mar. 15 pay the property tax', 'FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=15'],
    ['every year on 15 March', 'FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=15'],
    ['every year on the 15th of March', 'FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=15'],
    ['every year on 3/15', 'FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=15'],
    ['every year at the end of March', 'FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=-1'],
    ['every year on the first Monday of March', 'FREQ=YEARLY;BYMONTH=3;BYDAY=1MO'],
  ])('AI-PIN-034: a named day is the user’s — "%s" left alone', (text, rrule) => {
    const out = pin(text, rrule, '2027-03-15T09:00:00')
    expect(out.rrule).toBe(rrule)
    expect(out.due_at).toBe('2027-03-15T09:00:00')
  })

  test('AI-PIN-035: "every year" with no month named is left as the model wrote it', () => {
    expect(pin('renew the domain every year', 'FREQ=YEARLY').rrule).toBe('FREQ=YEARLY')
    // A month and day the model filled in from today are not the user's month:
    // not moved to the 1st (Oct 1 would already have passed).
    const r = result('FREQ=YEARLY;BYMONTH=10;BYMONTHDAY=15', '2026-10-15T09:00:00')
    expect(
      pinUnnamedDay(r, 'renew the domain every year', TZ, THURSDAY, CALENDAR_DAY_START),
    ).toEqual(r)
  })

  test('AI-PIN-036: a rule already on the 1st with no due_at is returned as is', () => {
    const r = result('FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=1')
    expect(pinUnnamedDay(r, 'every year in March', TZ, THURSDAY, CALENDAR_DAY_START)).toEqual(r)
  })
})
