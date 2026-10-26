/**
 * TM-RA: DEADLINE-ANCHORED REPEATS (2026-10-21; docs/TASK-MODEL.md
 * § Recurrence Model). A repeating task has ONE scheduled instant,
 * `occurrence_at`; `repeat_anchor` says whether it is the target or the
 * deadline. The other dates come from one pure function, `occurrenceDates`.
 * Pure rules first, then the writers that advance an occurrence (create,
 * done, skip, put-back, undo), then TM-G01, the guard that keeps every SQL
 * writer of `occurrence_at` / `deadline_at` on the derivation.
 * Every date is a LOCAL time in America/Chicago.
 */
import { CALENDAR_DAY_START } from '@/lib/opentask-day'
import fs from 'node:fs'
import path from 'node:path'
import { describe, test, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest'
import { DateTime } from 'luxon'
import { getDb } from '@/core/db'
import { bulkEdit, createTask, markDone, markUndone, updateTask } from '@/core/tasks'
import { snoozeTask } from '@/core/tasks/snooze'
import { skipOccurrence } from '@/core/tasks/skip'
import { skipUntil } from '@/core/tasks/skip-until'
import { getTaskById } from '@/core/tasks/read'
import { executeUndo } from '@/core/undo'
import { effectiveDueAt } from '@/core/recurrence/occurrence'
import { nextScheduledOccurrence } from '@/lib/snooze-guard'
import {
  deadlineLeadDays,
  defaultRelativeTarget,
  leadTargetFor,
  occurrenceDates,
  relativeTargetOf,
  relativeTargetProblem,
  targetMoved,
  type RepeatRule,
} from '@/lib/task-segments'
import {
  ANCHOR_SWITCH_NEEDS_RULE_MESSAGE,
  DEADLINE_CLEAR_MESSAGE,
  DECK_WITH_SCHEDULE_MESSAGE,
  REPEAT_TARGET_CLEAR_MESSAGE,
  RULE_NEEDS_TIME_MESSAGE,
  RELATIVE_TARGET_NEEDS_DEADLINE_MESSAGE,
  RELATIVE_TARGET_PAIR_MESSAGE,
  REPEAT_ANCHOR_KIND_MESSAGE,
  REPEAT_ANCHOR_NEEDS_RULE_MESSAGE,
  RULE_NOT_ON_DEADLINE_MESSAGE,
  TARGET_ANCHORED_DEADLINE_MESSAGE,
} from '@/core/tasks/repeat-schedule'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

const tz = TEST_TIMEZONE
function at(local: string): string {
  return DateTime.fromISO(local, { zone: tz }).toUTC().toISO()!
}
function setClock(local: string) {
  vi.setSystemTime(new Date(at(local)))
}
const u = { userId: TEST_USER_ID, userTimezone: tz }
function make(input: Record<string, unknown>) {
  return createTask({ ...u, input: { title: 'Task', ...input } })
}
function rule(rrule: string, mode: RepeatRule['recurrence_mode'] = 'from_due'): RepeatRule {
  return { rrule, recurrence_mode: mode, anchor_time: null }
}
const deadlineSchedule = (rrule: string, days: number, time: string) => ({
  rrule,
  repeat_anchor: 'deadline' as const,
  target_days_before: days,
  target_time: time,
})

/** Home Depot: the 1st Saturday at 8 AM, target the Friday before at 6 PM. */
const HOME_DEPOT = 'FREQ=MONTHLY;BYDAY=1SA;BYHOUR=8;BYMINUTE=0'

describe('TM-RA: occurrenceDates and its helpers (pure)', () => {
  test('TM-RA01: a target-anchored occurrence is its own target, with no deadline', () => {
    const s = { rrule: 'FREQ=WEEKLY;BYDAY=SU', repeat_anchor: 'target' as const }
    expect(
      occurrenceDates(
        { ...s, target_days_before: null, target_time: null },
        at('2026-10-18T12:00'),
        tz,
      ),
    ).toEqual({
      occurrenceAt: at('2026-10-18T12:00'),
      targetAt: at('2026-10-18T12:00'),
      deadlineAt: null,
      leadFrom: null,
    })
  })

  test('TM-RA02: a deadline-anchored occurrence is the deadline; the target N local days before', () => {
    const s = deadlineSchedule(HOME_DEPOT, 1, '18:00')
    // Sat May 1 2027 08:00 → Fri Apr 30 18:00 (across a month).
    expect(occurrenceDates(s, at('2027-05-01T08:00'), tz)).toEqual({
      occurrenceAt: at('2027-05-01T08:00'),
      targetAt: at('2027-04-30T18:00'),
      deadlineAt: at('2027-05-01T08:00'),
      leadFrom: null,
    })
  })

  test('TM-RA03: the inverse round-trips; a target after the deadline has none', () => {
    const d = at('2027-05-01T08:00')
    const offset = relativeTargetOf(at('2027-04-30T18:00'), d, tz)!
    expect(offset).toEqual({ days_before: 1, time: '18:00' })
    const s = deadlineSchedule(HOME_DEPOT, offset.days_before, offset.time)
    expect(occurrenceDates(s, d, tz).targetAt).toBe(at('2027-04-30T18:00'))
    expect(relativeTargetOf(at('2027-05-01T09:00'), d, tz)).toBeNull()
  })

  test('TM-RA04: DST — a skipped time is the next valid minute, a repeated one its first instant', () => {
    // Spring forward Sun Mar 14 2027: 02:30 does not exist → 03:00 CDT.
    const spring = occurrenceDates(
      deadlineSchedule('FREQ=WEEKLY;BYDAY=SU;BYHOUR=9;BYMINUTE=0', 0, '02:30'),
      at('2027-03-14T09:00'),
      tz,
    )
    expect(spring.targetAt).toBe('2027-03-14T08:00:00.000Z')
    // Fall back Sun Nov 1 2026: 01:30 happens twice → the first (CDT, 06:30Z).
    const fall = occurrenceDates(
      deadlineSchedule('FREQ=WEEKLY;BYDAY=SU;BYHOUR=9;BYMINUTE=0', 0, '01:30'),
      '2026-11-01T15:00:00.000Z',
      tz,
    )
    expect(fall.targetAt).toBe('2026-11-01T06:30:00.000Z')
    // The clamp: never after the deadline, whatever the offset says.
    const late = occurrenceDates(
      deadlineSchedule('FREQ=DAILY;BYHOUR=9;BYMINUTE=0', 0, '23:00'),
      at('2026-10-20T09:00'),
      tz,
    )
    expect(late.targetAt).toBe(at('2026-10-20T09:00'))
  })

  test('TM-RA05: targetMoved — only a target off the derivation', () => {
    const s = deadlineSchedule('FREQ=WEEKLY;BYDAY=SU;BYHOUR=23;BYMINUTE=0', 0, '12:00')
    const base = { ...s, occurrence_at: at('2026-10-25T23:00') }
    expect(targetMoved({ ...base, due_at: at('2026-10-25T12:00') }, tz)).toBe(false)
    expect(targetMoved({ ...base, due_at: at('2026-10-25T15:00') }, tz)).toBe(true)
    expect(targetMoved({ ...base, due_at: null }, tz)).toBe(false)
  })

  describe('relativeTargetProblem — refused, never clamped (A6)', () => {
    test('TM-RA10: the same day later than the deadline → after_deadline', () => {
      const r = rule('FREQ=WEEKLY;BYDAY=SU;BYHOUR=23;BYMINUTE=0')
      expect(
        relativeTargetProblem({ days_before: 0, time: '23:30' }, r, at('2026-10-25T23:00'), tz),
      ).toBe('after_deadline')
      expect(
        relativeTargetProblem({ days_before: 0, time: '23:00' }, r, at('2026-10-25T23:00'), tz),
      ).toBeNull()
    })

    test('TM-RA11: daily 07:00 — the day before at 06:00 overlaps; at 21:00 it does not', () => {
      const r = rule('FREQ=DAILY;BYHOUR=7;BYMINUTE=0')
      const first = at('2026-10-21T07:00')
      expect(relativeTargetProblem({ days_before: 1, time: '06:00' }, r, first, tz)).toBe(
        'overlaps_previous',
      )
      expect(relativeTargetProblem({ days_before: 1, time: '21:00' }, r, first, tz)).toBeNull()
    })

    test('TM-RA12: Mondays and Thursdays — 3 days before overlaps (Mon → Thu is 3 days)', () => {
      const r = rule('FREQ=WEEKLY;BYDAY=MO,TH;BYHOUR=17;BYMINUTE=0')
      const first = at('2026-10-22T17:00')
      expect(relativeTargetProblem({ days_before: 3, time: '09:00' }, r, first, tz)).toBe(
        'overlaps_previous',
      )
      expect(relativeTargetProblem({ days_before: 2, time: '09:00' }, r, first, tz)).toBeNull()
    })

    test('TM-RA13: from_completion every 3 months — the lead must be shorter than the interval', () => {
      const r = rule('FREQ=MONTHLY;INTERVAL=3;BYHOUR=9;BYMINUTE=0', 'from_completion')
      const first = at('2026-11-02T09:00')
      expect(relativeTargetProblem({ days_before: 7, time: '09:00' }, r, first, tz)).toBeNull()
      expect(relativeTargetProblem({ days_before: 100, time: '09:00' }, r, first, tz)).toBe(
        'overlaps_previous',
      )
    })
  })

  describe('the default target (A1, decided 2026-10-21): the wait-keyed lead', () => {
    test('TM-RA20: the lead table — Upcoming’s constants', () => {
      expect([0, 1, 2, 7, 8, 15, 16, 30].map(deadlineLeadDays)).toEqual([0, 0, 1, 1, 3, 3, 4, 4])
    })

    test('TM-RA21: by cadence — daily, twice-weekly, weekly, fortnightly, monthly', () => {
      const d = (rrule: string, first: string) =>
        defaultRelativeTarget(rule(rrule), at(first), tz, '08:30')
      expect(d('FREQ=DAILY;BYHOUR=17;BYMINUTE=0', '2026-10-21T17:00')).toEqual({
        days_before: 0,
        time: '08:30',
      })
      expect(d('FREQ=WEEKLY;BYDAY=MO,TH;BYHOUR=17;BYMINUTE=0', '2026-10-22T17:00')).toEqual({
        days_before: 1,
        time: '08:30',
      })
      expect(d('FREQ=WEEKLY;BYDAY=FR;BYHOUR=17;BYMINUTE=0', '2026-10-23T17:00')).toEqual({
        days_before: 1,
        time: '08:30',
      })
      expect(d('FREQ=WEEKLY;INTERVAL=2;BYDAY=FR;BYHOUR=17;BYMINUTE=0', '2026-10-23T17:00')).toEqual(
        { days_before: 3, time: '08:30' },
      )
      expect(d('FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=17;BYMINUTE=0', '2026-11-01T17:00')).toEqual({
        days_before: 4,
        time: '08:30',
      })
    })

    test('TM-RA22: a deadline earlier than the morning — the deadline day at the deadline’s own time', () => {
      expect(
        defaultRelativeTarget(
          rule('FREQ=DAILY;BYHOUR=7;BYMINUTE=0'),
          at('2026-10-21T07:00'),
          tz,
          '08:30',
        ),
      ).toEqual({ days_before: 0, time: '07:00' })
      expect(leadTargetFor(1, '07:00', '08:30')).toEqual({ days_before: 0, time: '07:00' })
    })
  })
})

/** Deadline Fridays 17:00 (Oct 23), target the day before at 18:00. */
function friday(extra: Record<string, unknown> = {}) {
  return make({
    rrule: 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=17;BYMINUTE=0',
    deadline_at: at('2026-10-23T17:00'),
    target_days_before: 1,
    target_time: '18:00',
    ...extra,
  })
}

describe('TM-RA: create', () => {
  beforeAll(() => setupTestDb())
  afterAll(() => teardownTestDb())
  beforeEach(() => {
    const db = getDb()
    db.prepare('DELETE FROM completions').run()
    db.prepare('DELETE FROM tasks').run()
    db.prepare('DELETE FROM undo_log').run()
    db.prepare("UPDATE users SET morning_time = '08:30' WHERE id = ?").run(TEST_USER_ID)
    setClock('2026-10-20T10:00') // Tue
  })
  afterEach(() => vi.useRealTimers())

  describe('create', () => {
    test('TM-RA30: a rule with a deadline is deadline-anchored; no offset → the default', () => {
      const t = make({ rrule: 'FREQ=WEEKLY;BYDAY=FR', deadline_at: at('2026-10-23T17:00') })
      expect(t).toMatchObject({
        rrule: 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=17;BYMINUTE=0',
        anchor_time: '17:00',
        repeat_anchor: 'deadline',
        target_days_before: 1,
        target_time: '08:30',
        occurrence_at: at('2026-10-23T17:00'),
        deadline_at: at('2026-10-23T17:00'),
        due_at: at('2026-10-22T08:30'),
        target_auto: false,
      })
    })

    test('TM-RA31: a target sent with the deadline gives the offset (its inverse)', () => {
      const t = make({
        rrule: 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=17;BYMINUTE=0',
        deadline_at: at('2026-10-23T17:00'),
        target_at: undefined,
        due_at: at('2026-10-21T20:00'),
      })
      expect(t).toMatchObject({ target_days_before: 2, target_time: '20:00' })
      expect(t.due_at).toBe(at('2026-10-21T20:00'))
    })

    test('TM-RA32: a deadline already past starts at the rule’s next one (judged on the deadline, A4)', () => {
      const t = friday({ deadline_at: at('2026-10-16T17:00') })
      expect(t.occurrence_at).toBe(at('2026-10-23T17:00'))
      expect(t.due_at).toBe(at('2026-10-22T18:00'))
    })

    test('TM-RA33: a derived target already past while the deadline is ahead is over target at birth', () => {
      const t = friday({ target_days_before: 4, target_time: '09:00' })
      expect(t.due_at).toBe(at('2026-10-19T09:00'))
      expect(effectiveDueAt(t, tz, CALENDAR_DAY_START)!.getTime()).toBeLessThan(Date.now())
    })

    test('TM-RA34: the 400s', () => {
      const weekly = 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=17;BYMINUTE=0'
      const deadline = at('2026-10-23T17:00')
      expect(() => make({ rrule: weekly, deadline_at: deadline, repeat_anchor: 'target' })).toThrow(
        TARGET_ANCHORED_DEADLINE_MESSAGE,
      )
      expect(() =>
        make({
          rrule: weekly,
          deadline_at: deadline,
          repeat_anchor: 'deadline',
          is_reminder: true,
        }),
      ).toThrow(REPEAT_ANCHOR_KIND_MESSAGE)
      expect(() => make({ deadline_at: deadline, repeat_anchor: 'deadline' })).toThrow(
        REPEAT_ANCHOR_NEEDS_RULE_MESSAGE,
      )
      expect(() => make({ rrule: weekly, target_days_before: 1, target_time: '09:00' })).toThrow(
        RELATIVE_TARGET_NEEDS_DEADLINE_MESSAGE,
      )
      expect(() => make({ rrule: weekly, deadline_at: deadline, target_days_before: 1 })).toThrow(
        RELATIVE_TARGET_PAIR_MESSAGE,
      )
      expect(() =>
        make({ rrule: 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=9;BYMINUTE=0', deadline_at: deadline }),
      ).toThrow(RULE_NOT_ON_DEADLINE_MESSAGE)
      expect(() =>
        make({ rrule: weekly, deadline_at: deadline, target_days_before: 0, target_time: '18:00' }),
      ).toThrow('The target would be after the deadline')
      expect(() =>
        make({ rrule: weekly, deadline_at: deadline, target_days_before: 7, target_time: '09:00' }),
      ).toThrow("previous occurrence's deadline")
    })

    test('TM-RA35: a reminder with a rule and a deadline stays target-anchored (never inferred)', () => {
      const r = make({
        is_reminder: true,
        rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
        deadline_at: at('2026-10-23T17:00'),
      })
      expect(r.repeat_anchor).toBe('target')
    })
  })
})

describe('TM-RA: the advancing writers and the readers', () => {
  beforeAll(() => setupTestDb())
  afterAll(() => teardownTestDb())
  beforeEach(() => {
    const db = getDb()
    db.prepare('DELETE FROM completions').run()
    db.prepare('DELETE FROM tasks').run()
    db.prepare('DELETE FROM undo_log').run()
    setClock('2026-10-20T10:00') // Tue
  })
  afterEach(() => vi.useRealTimers())

  describe('done, skip, put-back, undo', () => {
    test('TM-RA40: done advances the deadline; the next target is derived — a move never carries over', () => {
      const t = friday()
      snoozeTask({ ...u, taskId: t.id, until: at('2026-10-23T12:00') })
      setClock('2026-10-23T13:00')
      const next = markDone({ ...u, taskId: t.id }).task
      expect(next).toMatchObject({
        occurrence_at: at('2026-10-30T17:00'),
        deadline_at: at('2026-10-30T17:00'),
        due_at: at('2026-10-29T18:00'),
        original_due_at: at('2026-10-29T18:00'),
      })
      expect(targetMoved(next, tz)).toBe(false)
    })

    test('TM-RA41: skip does the same', () => {
      const t = friday()
      const r = skipOccurrence({ ...u, taskId: t.id })
      expect(r.task).toMatchObject({
        occurrence_at: at('2026-10-30T17:00'),
        deadline_at: at('2026-10-30T17:00'),
        due_at: at('2026-10-29T18:00'),
      })
    })

    test('TM-RA42: put-back after a move after done (the occurrence_at_next regression)', () => {
      const t = friday()
      setClock('2026-10-22T19:00')
      markDone({ ...u, taskId: t.id })
      // Move the NEXT occurrence's target: the schedule has not changed.
      snoozeTask({ ...u, taskId: t.id, until: at('2026-10-29T20:00') })
      const back = markUndone({ ...u, taskId: t.id })
      expect(back).toMatchObject({
        occurrence_at: at('2026-10-23T17:00'),
        deadline_at: at('2026-10-23T17:00'),
        due_at: at('2026-10-22T18:00'),
      })
    })

    test('TM-RA43: undo of done restores the occurrence, the deadline and the target', () => {
      const t = friday()
      setClock('2026-10-22T19:00')
      markDone({ ...u, taskId: t.id })
      executeUndo(TEST_USER_ID)
      expect(getTaskById(t.id)).toMatchObject({
        occurrence_at: at('2026-10-23T17:00'),
        deadline_at: at('2026-10-23T17:00'),
        due_at: at('2026-10-22T18:00'),
      })
    })

    test('TM-RA45: a deadline pulled earlier never makes a second occurrence in its period', () => {
      // Fri Oct 23's deadline pulled to Thu Oct 22: done Thu → the NEXT Friday.
      const t = friday()
      updateTask({ ...u, taskId: t.id, input: { deadline_at: at('2026-10-22T17:00') } })
      setClock('2026-10-22T15:00')
      expect(markDone({ ...u, taskId: t.id }).task).toMatchObject({
        deadline_at: at('2026-10-30T17:00'),
        due_at: at('2026-10-29T18:00'),
      })
      // Skip and skip until advance from the same base.
      const s = friday()
      updateTask({ ...u, taskId: s.id, input: { deadline_at: at('2026-10-22T17:00') } })
      expect(skipOccurrence({ ...u, taskId: s.id }).task.deadline_at).toBe(at('2026-10-30T17:00'))
      const k = friday()
      updateTask({ ...u, taskId: k.id, input: { deadline_at: at('2026-10-22T17:00') } })
      skipUntil({ ...u, taskIds: [k.id], until: '2026-10-24' })
      expect(getTaskById(k.id)!.deadline_at).toBe(at('2026-10-30T17:00'))
    })

    test('TM-RA46: a deadline pushed past the next rule occurrence covers it', () => {
      // Fri Oct 23 pushed to Mon Oct 26: it stands for Fri Oct 30 too, so done
      // → Fri Nov 6.
      const t = friday()
      updateTask({ ...u, taskId: t.id, input: { deadline_at: at('2026-10-26T17:00') } })
      setClock('2026-10-26T12:00')
      expect(markDone({ ...u, taskId: t.id }).task.deadline_at).toBe(at('2026-11-06T17:00'))
      // On its rule, nothing changes: done → the next Friday.
      setClock('2026-10-20T10:00')
      const on = friday()
      expect(markDone({ ...u, taskId: on.id }).task.deadline_at).toBe(at('2026-10-30T17:00'))
    })

    test("TM-RA47: a rule edit over target keeps the occurrence's day, at the new rule's time", () => {
      const t = friday({ target_days_before: 0, target_time: '09:00' })
      setClock('2026-10-23T10:00') // over target since 09:00
      const r = updateTask({
        ...u,
        taskId: t.id,
        input: { rrule: 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=20;BYMINUTE=0' },
      })
      expect(r.task).toMatchObject({
        occurrence_at: at('2026-10-23T20:00'),
        deadline_at: at('2026-10-23T20:00'),
        due_at: at('2026-10-23T09:00'),
      })
    })

    test('TM-RA44: a move is capped at the deadline while it is ahead', () => {
      const t = friday()
      const r = updateTask({ ...u, taskId: t.id, input: { due_at: at('2026-10-24T09:00') } })
      expect(r.task.due_at).toBe(at('2026-10-23T17:00'))
      expect(r.cappedAtDeadline).toBe(true)
      expect(r.task.occurrence_at).toBe(at('2026-10-23T17:00'))
    })
  })

  describe('readers', () => {
    test('TM-RA50: with no target off deck, nothing is due (never today’s DEADLINE occurrence)', () => {
      const t = friday()
      getDb().prepare('UPDATE tasks SET due_at = NULL WHERE id = ?').run(t.id)
      setClock('2026-10-23T18:00')
      expect(effectiveDueAt(getTaskById(t.id)!, tz, CALENDAR_DAY_START)).toBeNull()
    })

    test('TM-RA51: the snooze guard names the next occurrence’s derived target', () => {
      const t = friday()
      expect(nextScheduledOccurrence(t, tz)!.toISOString()).toBe(at('2026-10-29T18:00'))
    })
  })
})

describe('TM-RA: PATCH and bulk edit (plan §3.2)', () => {
  beforeAll(() => setupTestDb())
  afterAll(() => teardownTestDb())
  beforeEach(() => {
    const db = getDb()
    db.prepare('DELETE FROM completions').run()
    db.prepare('DELETE FROM tasks').run()
    db.prepare('DELETE FROM undo_log').run()
    db.prepare("UPDATE users SET morning_time = '08:30' WHERE id = ?").run(TEST_USER_ID)
    setClock('2026-10-20T10:00') // Tue
  })
  afterEach(() => vi.useRealTimers())

  const patch = (id: number, input: Record<string, unknown>) =>
    updateTask({ ...u, taskId: id, input })
  const FRIDAY_17 = 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=17;BYMINUTE=0'

  test('TM-RA60: a deadline sent reschedules THIS occurrence; an unmoved target re-derives, a moved one stays', () => {
    const t = friday()
    const r = patch(t.id, { deadline_at: at('2026-10-24T12:00') })
    expect(r.task).toMatchObject({
      occurrence_at: at('2026-10-24T12:00'),
      deadline_at: at('2026-10-24T12:00'),
      due_at: at('2026-10-23T18:00'),
      rrule: FRIDAY_17,
    })
    // Moved, then rescheduled earlier: kept, pulled back to the new deadline.
    patch(t.id, { due_at: at('2026-10-24T09:00') })
    const back = patch(t.id, { deadline_at: at('2026-10-23T20:00') })
    expect(back.task.due_at).toBe(at('2026-10-23T20:00'))
    // Undo puts the deadline, the occurrence and the target back together.
    executeUndo(TEST_USER_ID)
    expect(getTaskById(t.id)).toMatchObject({
      occurrence_at: at('2026-10-24T12:00'),
      deadline_at: at('2026-10-24T12:00'),
      due_at: at('2026-10-24T09:00'),
    })
  })

  test('TM-RA61: new offsets re-derive an unmoved target, and are validated', () => {
    const t = friday()
    const r = patch(t.id, { target_days_before: 2, target_time: '09:00' })
    expect(r.task).toMatchObject({
      target_days_before: 2,
      target_time: '09:00',
      due_at: at('2026-10-21T09:00'),
    })
    expect(() => patch(t.id, { target_days_before: 0, target_time: '18:00' })).toThrow(
      'The target would be after the deadline',
    )
    expect(() => patch(t.id, { target_days_before: 9 })).toThrow("previous occurrence's deadline")
    executeUndo(TEST_USER_ID)
    expect(getTaskById(t.id)).toMatchObject({ target_days_before: 1, target_time: '18:00' })
  })

  test('TM-RA62: target → deadline needs the rule; the occurrence comes from it', () => {
    const t = make({ rrule: 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=9;BYMINUTE=0' })
    expect(t.due_at).toBe(at('2026-10-23T09:00'))
    expect(() => patch(t.id, { repeat_anchor: 'deadline' })).toThrow(
      ANCHOR_SWITCH_NEEDS_RULE_MESSAGE,
    )
    // With a rule and a deadline: the rule repeats the deadline.
    const r = patch(t.id, {
      repeat_anchor: 'deadline',
      rrule: FRIDAY_17,
      deadline_at: at('2026-10-23T17:00'),
    })
    expect(r.task).toMatchObject({
      repeat_anchor: 'deadline',
      target_days_before: 1,
      target_time: '08:30',
      occurrence_at: at('2026-10-23T17:00'),
      deadline_at: at('2026-10-23T17:00'),
      due_at: at('2026-10-22T08:30'),
    })
  })

  test('TM-RA63: deadline → target drops the deadline and the offsets in the same write', () => {
    const t = friday()
    const r = patch(t.id, {
      repeat_anchor: 'target',
      rrule: 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=9;BYMINUTE=0',
    })
    expect(r.task).toMatchObject({
      repeat_anchor: 'target',
      target_days_before: null,
      target_time: null,
      deadline_at: null,
      due_at: at('2026-10-23T09:00'),
      occurrence_at: at('2026-10-23T09:00'),
    })
    // Clearing the rule instead: a one-off that keeps its deadline — and,
    // since 2026-10-24 (relative targets, ruling 6), its unmoved relative
    // target: a relative one-off, the day before at 6 PM.
    const s = friday()
    const one = patch(s.id, { rrule: null })
    expect(one.task).toMatchObject({
      rrule: null,
      repeat_anchor: 'target',
      target_days_before: 1,
      target_time: '18:00',
      occurrence_at: null,
      deadline_at: at('2026-10-23T17:00'),
      due_at: at('2026-10-22T18:00'),
    })
  })

  test('TM-RA64: an over-target repeat switched to its deadline keeps its target as the debt', () => {
    const t = make({ rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0' })
    // Missed Monday's occurrence: over target since Mon 09:00.
    getDb()
      .prepare('UPDATE tasks SET due_at = ?, occurrence_at = ? WHERE id = ?')
      .run(at('2026-10-19T09:00'), at('2026-10-19T09:00'), t.id)
    const r = patch(t.id, { repeat_anchor: 'deadline', rrule: FRIDAY_17 })
    expect(r.task).toMatchObject({
      repeat_anchor: 'deadline',
      occurrence_at: at('2026-10-23T17:00'),
      deadline_at: at('2026-10-23T17:00'),
      due_at: at('2026-10-19T09:00'),
    })
    expect(() =>
      patch(make({ rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0' }).id, {
        repeat_anchor: 'deadline',
        rrule: 'FREQ=WEEKLY;BYDAY=FR',
      }),
    ).toThrow(RULE_NEEDS_TIME_MESSAGE)
  })
})

describe('TM-RA: PATCH and bulk edit — the refusals', () => {
  beforeAll(() => setupTestDb())
  afterAll(() => teardownTestDb())
  beforeEach(() => {
    const db = getDb()
    db.prepare('DELETE FROM completions').run()
    db.prepare('DELETE FROM tasks').run()
    db.prepare('DELETE FROM undo_log').run()
    db.prepare("UPDATE users SET morning_time = '08:30' WHERE id = ?").run(TEST_USER_ID)
    setClock('2026-10-20T10:00') // Tue
  })
  afterEach(() => vi.useRealTimers())

  const patch = (id: number, input: Record<string, unknown>) =>
    updateTask({ ...u, taskId: id, input })
  const FRIDAY_17 = 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=17;BYMINUTE=0'

  test('TM-RA65: the 400s', () => {
    const t = friday()
    expect(() => patch(t.id, { deadline_at: null })).toThrow(DEADLINE_CLEAR_MESSAGE)
    expect(() => patch(t.id, { due_at: null })).toThrow(REPEAT_TARGET_CLEAR_MESSAGE)
    expect(() => patch(t.id, { is_reminder: true, repeat_anchor: 'deadline' })).toThrow(
      REPEAT_ANCHOR_KIND_MESSAGE,
    )
    expect(() =>
      patch(t.id, {
        rrule: 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=9;BYMINUTE=0',
        deadline_at: at('2026-10-30T17:00'),
      }),
    ).toThrow(RULE_NOT_ON_DEADLINE_MESSAGE)
    expect(() => patch(t.id, { on_deck_day: '2026-10-21', target_days_before: 2 })).toThrow(
      DECK_WITH_SCHEDULE_MESSAGE,
    )
    // L9: a target-anchored repeat never gains a deadline.
    const plain = make({ rrule: 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=9;BYMINUTE=0' })
    expect(() => patch(plain.id, { deadline_at: at('2026-10-23T17:00') })).toThrow(
      TARGET_ANCHORED_DEADLINE_MESSAGE,
    )
    expect(() => patch(plain.id, { target_days_before: 1, target_time: '09:00' })).toThrow(
      RELATIVE_TARGET_NEEDS_DEADLINE_MESSAGE,
    )
    // A3: a rule given to a one-off with a deadline needs the anchor.
    const oneOff = make({ deadline_at: at('2026-10-23T17:00') })
    expect(() => patch(oneOff.id, { rrule: FRIDAY_17 })).toThrow(TARGET_ANCHORED_DEADLINE_MESSAGE)
    const made = patch(oneOff.id, { rrule: FRIDAY_17, repeat_anchor: 'deadline' })
    expect(made.task).toMatchObject({
      repeat_anchor: 'deadline',
      occurrence_at: at('2026-10-23T17:00'),
      deadline_at: at('2026-10-23T17:00'),
      due_at: at('2026-10-22T08:30'),
    })
  })

  test('TM-RA66: bulk edit — held to the same rules; a refusal refuses the batch', () => {
    const a = friday()
    const plain = make({ rrule: 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=9;BYMINUTE=0' })
    expect(() =>
      bulkEdit({
        ...u,
        taskIds: [a.id, plain.id],
        changes: { deadline_at: at('2026-10-30T17:00') },
      }),
    ).toThrow(TARGET_ANCHORED_DEADLINE_MESSAGE)
    expect(getTaskById(a.id)!.deadline_at).toBe(at('2026-10-23T17:00'))
    bulkEdit({ ...u, taskIds: [a.id], changes: { target_days_before: 2, target_time: '20:00' } })
    expect(getTaskById(a.id)).toMatchObject({ due_at: at('2026-10-21T20:00') })
  })
})

describe('TM-G01: every SQL writer of occurrence_at / deadline_at / lead_from derives through occurrenceDates', () => {
  function files(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) return files(p)
      return /\.tsx?$/.test(e.name) ? [p] : []
    })
  }
  const read = (f: string) => fs.readFileSync(f, 'utf8')

  /**
   * Files allowed to write either column without importing the derivation,
   * and why. Anything else that writes them in SQL (or through `trackField`)
   * must import `occurrenceDates` or the write side (`repeat-schedule.ts`).
   */
  const EXEMPT: Record<string, string> = {
    // Migrations and backfills: the shape before the column, by construction.
    'src/core/db/index.ts': 'migrations',
    'src/core/db/migrate-deadline-targets.ts': 'migrations',
    // That migration's step 1 (the occurrence seed), moved out so the raw-SQL
    // seeds share it (2026-10-26): the same UPDATE, not a new writer.
    'src/core/db/occurrence-seed.ts': 'migrations (step 1, shared with the seeds)',
    // The deadline-anchor migration: occurrence_at := deadline_at is I2 itself.
    'src/core/db/migrate-repeat-anchor.ts': 'migrations',
    // Writes computeMarkDone's result, which is `occurrenceDates`'.
    'src/core/tasks/helpers/execute-mark-done.ts': "computeMarkDone's dates",
    // Enrichment never makes a deadline-anchored repeat (its sanitizer drops a
    // rule's deadline), and it never writes the occurrence of one (guarded on
    // `repeat_anchor`). Teaching it to make one is PR 5.
    'src/core/ai/enrichment.ts': 'never on a deadline-anchored row (PR 5)',
    // The deadlines page (2026-10-22): `lead_from` rides the same derivation
    // (`occurrenceDates`' `leadFrom`, `leadFor`). The migration writes it
    // once; Defer moves THIS instance's day by hand — never a derivation.
    'src/core/db/migrate-deadline-leads.ts': 'migrations',
    // A pre-migration automatic target converted on reopen / restore (the
    // deadlines page): its SQL fragment runs inside mark-done.ts and delete.ts,
    // which stamp and snapshot it; it never writes a target, only clears one.
    'src/core/tasks/auto-target-lead.ts': 'clears an automatic target (autoTargetToLead)',
    'src/core/tasks/task-segments.ts': 'Defer moves the lead day itself (deferLeads)',
    // The undo fence (2026-10-24): an undo that drops an automatic target and
    // leaves a deadline ONE-OFF with no lead day gives it `leadFor`'s, through
    // the same `oneOffLeadFrom` as autoTargetToLead — never a repeat's date.
    'src/core/undo/auto-target-fence.ts':
      "a one-off's lead day after a dropped automatic target (oneOffLeadFrom)",
  }
  const writer =
    /\b(occurrence_at|deadline_at|lead_from)\s*=\s*(\?|NULL|deadline_at|due_at|COALESCE)|INSERT INTO tasks|trackField\(\s*data,\s*'(occurrence_at|deadline_at|lead_from)'/
  // Relative targets (2026-10-24): `relativeTargetAt`, the derivation
  // `occurrenceDates` delegates to (and a relative one-off's), counts too.
  const derives =
    /import\s*\{[^}]*\b(occurrenceDates|relativeTargetAt)\b[^}]*\}\s*from '@\/lib\/task-segments'|from '\.\.?\/repeat-schedule'/

  test('TM-G01: no per-writer special cases — the writers import the one derivation (or are exempt, with a reason)', () => {
    const root = process.cwd()
    const offenders = files(path.join(root, 'src'))
      .map((f) => path.relative(root, f))
      .filter((f) => !EXEMPT[f])
      .filter((f) => writer.test(read(f)))
      .filter((f) => !derives.test(read(f)))
    expect(offenders).toEqual([])
  })

  test('TM-G03: a write of occurrence_at FROM a target is held to target-anchored rows', () => {
    // `occurrence_at = due_at` (or the target an advance lands on) is only
    // true of a target-anchored repeat; a file that writes it says so in SQL.
    const root = process.cwd()
    const fromTarget = /\boccurrence_at\s*=\s*due_at\b/
    const offenders = files(path.join(root, 'src'))
      .map((f) => path.relative(root, f))
      .filter((f) => !EXEMPT[f])
      .filter((f) => fromTarget.test(read(f)))
      .filter((f) => !/repeat_anchor = 'target'/.test(read(f)))
    expect(offenders).toEqual([])
  })

  test('TM-G02: advanceDeadline is gone', () => {
    const root = process.cwd()
    const left = files(path.join(root, 'src')).filter((f) => /\badvanceDeadline\(/.test(read(f)))
    expect(left.map((f) => path.relative(root, f))).toEqual([])
  })
})
