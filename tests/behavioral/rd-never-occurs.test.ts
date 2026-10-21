/**
 * RD-NEVER (2026-10-21, the recurrence oracle): a rule that never occurs —
 * "the 31st of April", the 30th of February, a Thursday that must also be a
 * day its months never have — is refused wherever a rule is written (POST,
 * PATCH, bulk edit), dropped from an AI answer (logged, the rest kept), and
 * `computeNextOccurrence` never invents a date for one an older row holds.
 */
import { describe, test, expect } from 'vitest'
import { ZodError } from 'zod'
import { isValidRRule } from '@/core/recurrence/rrule-builder'
import { computeNextOccurrence, NEVER_OCCURS_MESSAGE } from '@/core/recurrence/compute-next'
import { validateBulkEdit, validateTaskCreate, validateTaskUpdate } from '@/core/validation'
import { ValidationError } from '@/core/errors'
import { parseEnrichmentAnswer } from '@/core/ai/enrichment'

const NEVER = [
  'FREQ=YEARLY;BYMONTH=4;BYMONTHDAY=31;BYHOUR=9;BYMINUTE=0',
  'FREQ=YEARLY;BYMONTH=6;BYMONTHDAY=31;BYHOUR=9;BYMINUTE=0',
  'FREQ=YEARLY;INTERVAL=2;BYMONTH=9;BYMONTHDAY=31;BYHOUR=9;BYMINUTE=0',
  'FREQ=YEARLY;BYMONTH=11;BYMONTHDAY=31;BYHOUR=9;BYMINUTE=0',
  'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30;BYHOUR=9;BYMINUTE=0',
  'FREQ=YEARLY;BYDAY=TH;BYMONTH=9;BYMONTHDAY=31;BYHOUR=9;BYMINUTE=0',
]

describe('RD-NEVER: a rule that never occurs', () => {
  test('RD-NEVER-01: isValidRRule refuses it; February 29 and ordinary rules pass', () => {
    for (const rule of NEVER) expect(isValidRRule(rule), rule).toBe(false)
    for (const rule of [
      'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29;BYHOUR=9;BYMINUTE=0',
      'FREQ=YEARLY;BYMONTH=4,5;BYMONTHDAY=30;BYHOUR=9;BYMINUTE=0',
      'FREQ=MONTHLY;BYMONTHDAY=31;BYHOUR=9;BYMINUTE=0',
      'FREQ=WEEKLY;BYDAY=FR;BYHOUR=17;BYMINUTE=0',
      'FREQ=YEARLY;BYDAY=TH;BYMONTH=9;BYMONTHDAY=24;BYHOUR=9;BYMINUTE=0',
    ]) {
      expect(isValidRRule(rule), rule).toBe(true)
    }
  })

  test('RD-NEVER-02: POST, PATCH and bulk edit refuse it (400)', () => {
    const rrule = NEVER[0]
    expect(() => validateTaskCreate({ title: 'x', rrule })).toThrow(ZodError)
    expect(() => validateTaskUpdate({ rrule })).toThrow(ZodError)
    expect(() => validateBulkEdit({ ids: [1], changes: { rrule } })).toThrow(ZodError)
  })

  test('RD-NEVER-03: computeNextOccurrence never invents a date — a 400', () => {
    const from = new Date('2026-10-21T15:00:00Z')
    expect(() =>
      computeNextOccurrence({
        rrule: NEVER[0],
        recurrenceMode: 'from_due',
        anchorTime: '09:00',
        timezone: 'America/Chicago',
        completedAt: from,
        prevDueAt: from,
      }),
    ).toThrow(new ValidationError(NEVER_OCCURS_MESSAGE))
  })

  test('RD-NEVER-04: an AI answer with one drops the rule, keeps the rest', () => {
    const answer = {
      reasoning: 'x',
      title: 'Pay the HOA dues',
      due_at: null,
      deadline_at: null,
      horizon: null,
      priority: 2,
      labels: [],
      project_name: null,
      rrule: NEVER[0],
      auto_snooze_minutes: null,
      recurrence_mode: 'from_due',
      notes: null,
      on_deck_day: null,
      reminder_slot: null,
    }
    const parsed = parseEnrichmentAnswer(answer, 1)
    expect(parsed.success).toBe(true)
    expect(parsed.data).toMatchObject({ title: 'Pay the HOA dues', priority: 2, rrule: null })
  })
})
