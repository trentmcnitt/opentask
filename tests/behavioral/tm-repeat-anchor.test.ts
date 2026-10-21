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
import fs from 'node:fs'
import path from 'node:path'
import { describe, test, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest'
import { DateTime } from 'luxon'
import { getDb } from '@/core/db'
import { createTask, markDone, markUndone, updateTask } from '@/core/tasks'
import { snoozeTask } from '@/core/tasks/snooze'
import { skipOccurrence } from '@/core/tasks/skip'
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
    })
  })

  test('TM-RA02: a deadline-anchored occurrence is the deadline; the target N local days before', () => {
    const s = deadlineSchedule(HOME_DEPOT, 1, '18:00')
    // Sat May 1 2027 08:00 → Fri Apr 30 18:00 (across a month).
    expect(occurrenceDates(s, at('2027-05-01T08:00'), tz)).toEqual({
      occurrenceAt: at('2027-05-01T08:00'),
      targetAt: at('2027-04-30T18:00'),
      deadlineAt: at('2027-05-01T08:00'),
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
      expect(effectiveDueAt(t, tz)!.getTime()).toBeLessThan(Date.now())
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
      expect(effectiveDueAt(getTaskById(t.id)!, tz)).toBeNull()
    })

    test('TM-RA51: the snooze guard names the next occurrence’s derived target', () => {
      const t = friday()
      expect(nextScheduledOccurrence(t, tz)!.toISOString()).toBe(at('2026-10-29T18:00'))
    })
  })
})

describe('TM-G01: every SQL writer of occurrence_at / deadline_at derives through occurrenceDates', () => {
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
    // The deadline-anchor migration: occurrence_at := deadline_at is I2 itself.
    'src/core/db/migrate-repeat-anchor.ts': 'migrations',
    // Writes computeMarkDone's result, which is `occurrenceDates`'.
    'src/core/tasks/helpers/execute-mark-done.ts': "computeMarkDone's dates",
    // Enrichment never makes a deadline-anchored repeat (its sanitizer drops a
    // rule's deadline), and it never writes the occurrence of one (guarded on
    // `repeat_anchor`). Teaching it to make one is PR 5.
    'src/core/ai/enrichment.ts': 'never on a deadline-anchored row (PR 5)',
  }
  const writer =
    /\b(occurrence_at|deadline_at)\s*=\s*(\?|NULL|deadline_at|due_at|COALESCE)|INSERT INTO tasks|trackField\(\s*data,\s*'(occurrence_at|deadline_at)'/
  const derives =
    /import\s*\{[^}]*\boccurrenceDates\b[^}]*\}\s*from '@\/lib\/task-segments'|from '\.\.?\/repeat-schedule'/

  test('TM-G01: no per-writer special cases — the writers import the one derivation (or are exempt, with a reason)', () => {
    const root = process.cwd()
    const offenders = files(path.join(root, 'src'))
      .map((f) => path.relative(root, f))
      .filter((f) => !EXEMPT[f])
      .filter((f) => writer.test(read(f)))
      .filter((f) => !derives.test(read(f)))
    expect(offenders).toEqual([])
  })

  test('TM-G02: advanceDeadline is gone', () => {
    const root = process.cwd()
    const left = files(path.join(root, 'src')).filter((f) => /\badvanceDeadline\(/.test(read(f)))
    expect(left.map((f) => path.relative(root, f))).toEqual([])
  })
})
