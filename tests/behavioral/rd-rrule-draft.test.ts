/**
 * RD-DRAFT (2026-10-22, editor plan §2.1, §14.1): the rule a recurrence editor
 * holds (`src/lib/rrule-draft.ts`) — taken out of RecurrencePicker, which now
 * calls it — parses and builds back to the same text, part for part, so the
 * picker's output is byte-identical to before; and the day shift both the
 * migration and every-time mode use (`src/core/recurrence/rule-shift.ts`).
 *
 * RT-5: COUNT/UNTIL round-trip through the draft, but the server refuses
 * both, and on a legacy row that holds one the engine ignores it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { ZodError } from 'zod'
import {
  buildRule,
  defaultRuleDraft,
  describeRuleDraft,
  parseRule,
  parseRuleTime,
  weeklyDayMissing,
} from '@/lib/rrule-draft'
import { shiftRuleDays, shiftedRuleHolds } from '@/core/recurrence/rule-shift'
import { computeFirstOccurrence, isValidRRule } from '@/core/recurrence'
import { validateTaskCreate, validateTaskUpdate } from '@/core/validation'
import { getDb } from '@/core/db'
import { createTask, getTaskById } from '@/core/tasks'
import { markDone } from '@/core/tasks/mark-done'
import { skipOccurrence } from '@/core/tasks/skip'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

/** parse → build at the rule's own time. */
function roundTrip(rrule: string): string {
  const { hour, minute } = parseRuleTime(rrule)
  return buildRule(parseRule(rrule)!, { hour, minute })
}

describe('RD-DRAFT: parse and build round-trip', () => {
  test.each([
    'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    'FREQ=DAILY;INTERVAL=3;BYHOUR=7;BYMINUTE=30',
    'FREQ=WEEKLY;BYDAY=FR;BYHOUR=16;BYMINUTE=0',
    'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR;BYHOUR=8;BYMINUTE=15',
    // A weekday of the month, kept as written (1SA, BYSETPOS).
    'FREQ=MONTHLY;BYDAY=1SA;BYHOUR=8;BYMINUTE=0',
    'FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1;BYHOUR=17;BYMINUTE=0',
    'FREQ=MONTHLY;BYMONTHDAY=-1;BYHOUR=12;BYMINUTE=0',
    'FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=15;BYHOUR=9;BYMINUTE=0',
    // A yearly rule's date is carried through (the picker used to drop it).
    'FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0',
    // Ends parse and build (RT-5: the server refuses them, see below).
    'FREQ=WEEKLY;BYDAY=TU;BYHOUR=9;BYMINUTE=0;COUNT=5',
    'FREQ=DAILY;BYHOUR=9;BYMINUTE=0;UNTIL=20261231T235959Z',
  ])('%s', (rrule) => {
    expect(roundTrip(rrule)).toBe(rrule)
  })

  test('BYHOUR/BYMINUTE are always written — from the time passed', () => {
    const draft = parseRule('FREQ=WEEKLY;BYDAY=FR')!
    expect(buildRule(draft, '16:05')).toBe('FREQ=WEEKLY;BYDAY=FR;BYHOUR=16;BYMINUTE=5')
    expect(buildRule(draft, { hour: 0, minute: 0 })).toBe(
      'FREQ=WEEKLY;BYDAY=FR;BYHOUR=0;BYMINUTE=0',
    )
  })

  test('the parsed fields', () => {
    expect(parseRule(null)).toBeNull()
    expect(parseRule('FREQ=MONTHLY;BYDAY=1SA;BYHOUR=8;BYMINUTE=0')).toMatchObject({
      freq: 'MONTHLY',
      days: ['SA'],
      monthWeekday: { byDay: '1SA', setPos: null },
    })
    expect(parseRule('FREQ=MONTHLY;BYMONTHDAY=-1')).toMatchObject({
      monthDay: 'last',
      monthWeekday: null,
    })
    expect(parseRule('FREQ=WEEKLY;BYDAY=TU;COUNT=5')).toMatchObject({
      endType: 'count',
      endCount: 5,
    })
    expect(parseRule('FREQ=DAILY;UNTIL=20261231T235959Z')).toMatchObject({
      endType: 'date',
      endDate: '2026-12-31',
    })
  })

  test('picking a day of the month replaces the weekday of the month', () => {
    const draft = parseRule('FREQ=MONTHLY;BYDAY=1SA;BYHOUR=8;BYMINUTE=0')!
    expect(buildRule({ ...draft, monthWeekday: null, monthDay: 7 }, '08:00')).toBe(
      'FREQ=MONTHLY;BYMONTHDAY=7;BYHOUR=8;BYMINUTE=0',
    )
  })

  test('parseRuleTime: the rule, else initialTime, else 9:00', () => {
    expect(parseRuleTime('FREQ=DAILY;BYHOUR=18;BYMINUTE=30', '07:00')).toEqual({
      hour: 18,
      minute: 30,
    })
    expect(parseRuleTime('FREQ=DAILY', '07:15')).toEqual({ hour: 7, minute: 15 })
    expect(parseRuleTime(null, null)).toEqual({ hour: 9, minute: 0 })
  })

  test('describeRuleDraft — the picker preview', () => {
    const t = { hour: 16, minute: 0 }
    expect(describeRuleDraft(parseRule('FREQ=WEEKLY;BYDAY=FR')!, t)).toBe(
      'Every week on Friday at 4:00 PM',
    )
    expect(describeRuleDraft(parseRule('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR')!, t)).toBe(
      'Weekdays at 4:00 PM',
    )
    expect(describeRuleDraft(parseRule('FREQ=MONTHLY;BYDAY=1SA')!, t)).toBe(
      'Every month on the 1st Sat at 4:00 PM',
    )
    expect(describeRuleDraft({ ...defaultRuleDraft('DAILY'), interval: 2 }, t)).toBe(
      'Every 2 days at 4:00 PM',
    )
  })

  test('weeklyDayMissing: from_due only', () => {
    const draft = parseRule('FREQ=WEEKLY;BYHOUR=9;BYMINUTE=0')!
    expect(weeklyDayMissing(draft, 'from_due')).toBe(true)
    expect(weeklyDayMissing(draft, 'from_completion')).toBe(false)
    expect(weeklyDayMissing(parseRule('FREQ=WEEKLY;BYDAY=MO')!, 'from_due')).toBe(false)
  })
})

describe('RD-SHIFT: moving a rule’s days (rule-shift.ts)', () => {
  test('forward, as the migration always did', () => {
    expect(shiftRuleDays('FREQ=WEEKLY;BYDAY=FR;BYHOUR=16;BYMINUTE=0', 1)).toBe(
      'FREQ=WEEKLY;BYDAY=SA;BYHOUR=16;BYMINUTE=0',
    )
    expect(shiftRuleDays('FREQ=WEEKLY;BYDAY=SU', 1)).toBe('FREQ=WEEKLY;BYDAY=MO')
    expect(shiftRuleDays('FREQ=MONTHLY;BYMONTHDAY=27', 1)).toBe('FREQ=MONTHLY;BYMONTHDAY=28')
    expect(shiftRuleDays('FREQ=MONTHLY;BYMONTHDAY=28', 1)).toBeNull()
    expect(shiftRuleDays('FREQ=DAILY', 3)).toBe('FREQ=DAILY')
  })

  test('backward wraps the week and refuses day 0 (both were broken before the move)', () => {
    expect(shiftRuleDays('FREQ=WEEKLY;BYDAY=MO', -1)).toBe('FREQ=WEEKLY;BYDAY=SU')
    expect(shiftRuleDays('FREQ=WEEKLY;BYDAY=TU,TH', -3)).toBe('FREQ=WEEKLY;BYDAY=SA,MO')
    expect(shiftRuleDays('FREQ=MONTHLY;BYMONTHDAY=1', -1)).toBeNull()
    expect(shiftRuleDays('FREQ=MONTHLY;BYMONTHDAY=5', -2)).toBe('FREQ=MONTHLY;BYMONTHDAY=3')
    expect(shiftRuleDays('FREQ=MONTHLY;BYMONTHDAY=-1', -1)).toBeNull()
  })

  test('unshiftable parts are refused', () => {
    expect(shiftRuleDays('FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1', 1)).toBeNull()
  })

  test('shiftedRuleHolds proves a plain weekday shift and refuses an ordinal one', () => {
    const tz = TEST_TIMEZONE
    const rule = (rrule: string) => ({
      rrule,
      recurrence_mode: 'from_due' as const,
      anchor_time: null,
    })
    const now = new Date('2026-10-22T15:00:00Z')
    const fri = 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=16;BYMINUTE=0'
    const sat = 'FREQ=WEEKLY;BYDAY=SA;BYHOUR=8;BYMINUTE=0'
    const from = computeFirstOccurrence(fri, null, tz, now).toISOString()
    const satFrom = computeFirstOccurrence(sat, null, tz, now).toISOString()
    expect(shiftedRuleHolds(rule(fri), from, rule(sat), satFrom, 1, '08:00', tz)).toBe(true)
    // "1SA" − 1 writes "1FR", which is not always the day before the 1st Saturday.
    const firstSat = 'FREQ=MONTHLY;BYDAY=1SA;BYHOUR=8;BYMINUTE=0'
    const firstFri = shiftRuleDays(firstSat, -1)!
    expect(firstFri).toBe('FREQ=MONTHLY;BYDAY=1FR;BYHOUR=8;BYMINUTE=0')
    const a = computeFirstOccurrence(firstSat, null, tz, now).toISOString()
    const b = computeFirstOccurrence(firstFri, null, tz, now).toISOString()
    expect(shiftedRuleHolds(rule(firstSat), a, rule(firstFri), b, -1, '08:00', tz)).toBe(false)
  })
})

// ===========================================================================
// RT-5: ends (COUNT / UNTIL)
// ===========================================================================

describe('RT-5: a repeat that ends', () => {
  const COUNT = 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0;COUNT=2'
  const UNTIL = 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0;UNTIL=20261023T235959Z'

  test('RT-5-01: the server refuses COUNT and UNTIL on create and edit', () => {
    for (const rrule of [COUNT, UNTIL]) {
      expect(isValidRRule(rrule), rrule).toBe(false)
      expect(() => validateTaskCreate({ title: 'x', rrule })).toThrow(ZodError)
      expect(() => validateTaskUpdate({ rrule })).toThrow(ZodError)
    }
  })

  describe('a legacy row that holds one', () => {
    beforeAll(() => setupTestDb())
    afterAll(() => teardownTestDb())
    afterEach(() => vi.useRealTimers())

    /** A daily task whose stored rule is replaced behind validation's back. */
    function legacy(rrule: string) {
      vi.setSystemTime(new Date('2026-10-22T12:00:00Z'))
      const task = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: `legacy ${rrule}`, rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0' },
      })
      getDb().prepare('UPDATE tasks SET rrule = ? WHERE id = ?').run(rrule, task.id)
      return task.id
    }

    test.each([
      ['UNTIL', UNTIL],
      ['COUNT', COUNT],
    ])(
      'RT-5-02 (%s): done and skip past its last occurrence keep repeating — the end is ignored',
      (_name, rrule) => {
        const id = legacy(rrule)
        // UNTIL's last day is Oct 23; COUNT=2 would be spent after two.
        for (let i = 0; i < 3; i++) {
          markDone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: id })
        }
        skipOccurrence({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: id })
        const after = getTaskById(id)!
        expect(after.done).toBe(false)
        expect(after.rrule).toBe(rrule)
        // Four advances from Oct 22 9:00 Chicago — through UNTIL's Oct 23 and on: Oct 26.
        expect(after.occurrence_at).toBe('2026-10-26T14:00:00.000Z')
      },
    )
  })
})
