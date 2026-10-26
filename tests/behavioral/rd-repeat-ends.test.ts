/**
 * RE: REPEAT ENDS (2026-10-22; docs/TASK-MODEL.md § Repeat ends; plan
 * .tmp/plan-repeat-ends-1022.md). "Ends: never / after N times / on date".
 *
 * The end lives in three columns — `repeat_count`, `repeat_count_used`,
 * `repeat_until` (a LOCAL date) — never in the stored rule; one pure judge,
 * `repeatStep`, decides whether an advance is still in the series. This file
 * pins the validation table, the pure functions, every writer (done, skip,
 * skip until, put-back, undo/redo, bulk done, the defer cap, the snooze
 * guard, the rollover, decks, both modes, deadline-anchored), the startup
 * lift (`liftRuleEnds`) and RE-G01, the guard that keeps every advance on the
 * judge. The day-by-day cases are golden timelines (`tests/golden/repeat-ends.ts`).
 *
 * The user: periods 06:30 / 12:00 / 20:30 (rollover 06:30), morning 08:30,
 * America/Chicago, the task queue on. The clock is Tue 2026-10-20 10:00.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, test, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { DateTime } from 'luxon'
import { ZodError } from 'zod'

vi.mock('@/core/notifications/dismiss', () => ({
  dismissNotificationsForTasks: vi.fn(),
  syncBadgeCount: vi.fn(),
}))
vi.mock('@/core/webhooks/dispatch', () => ({ dispatchWebhookEvent: vi.fn() }))

import { getDb, liftRuleEnds } from '@/core/db'
import {
  bulkDone,
  bulkEdit,
  bulkSnooze,
  createTask,
  markDone,
  markUndone,
  updateTask,
} from '@/core/tasks'
import { getTaskById } from '@/core/tasks/read'
import { REPEAT_ENDED_MESSAGE } from '@/core/tasks/mark-done'
import { nextOccurrenceAfterSkip, SKIPPED_LAST_MARKS_DONE, skipOccurrence } from '@/core/tasks/skip'
import { skipUntil } from '@/core/tasks/skip-until'
import { deckTasks } from '@/core/tasks/deck'
import { runTaskRollover } from '@/core/tasks/task-rollover'
import { REPEAT_END_MESSAGES, repeatEndProblem } from '@/core/tasks/repeat-schedule'
import { executeRedo, executeUndo } from '@/core/undo'
import { ValidationError } from '@/core/errors'
import { isValidRRule } from '@/core/recurrence'
import {
  BULK_ENDS_MESSAGE,
  RULE_END_CONFLICT_MESSAGE,
  liftRuleEnd,
  validateBulkEdit,
  validateTaskCreate,
  validateTaskUpdate,
} from '@/core/validation'
import { nextScheduledOccurrence } from '@/lib/snooze-guard'
import { formatTaskResponse } from '@/lib/format-task'
import { formatRepeatEnd } from '@/lib/format-rrule'
import {
  isLastOccurrence,
  nextOrEnd,
  repeatRemaining,
  repeatStep,
  seriesEndWords,
  seriesEndedBySkip,
} from '@/lib/task-segments'
import type { Task } from '@/types'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'
import { CALENDAR_DAY_START } from '@/lib/opentask-day'

const tz = TEST_TIMEZONE
const u = { userId: TEST_USER_ID, userTimezone: tz }
const DAILY_8 = 'FREQ=DAILY;BYHOUR=8;BYMINUTE=0'
const FRIDAY_9 = 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=9;BYMINUTE=0'
const MONDAY_8 = 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=8;BYMINUTE=0'

function at(local: string): string {
  return DateTime.fromISO(local, { zone: tz }).toUTC().toISO()!
}
function setClock(local: string) {
  vi.setSystemTime(new Date(at(local)))
}
function make(input: Record<string, unknown>): Task {
  return createTask({ ...u, input: validateTaskCreate({ title: 'Task', ...input }) })
}
function patch(id: number, input: Record<string, unknown>) {
  return updateTask({ ...u, taskId: id, input: validateTaskUpdate(input) })
}
/** Made at `created` (local), then the clock to `now`. */
function repeating(
  rrule: string,
  created: string,
  input: Record<string, unknown> = {},
  now = '2026-10-20T10:00',
): Task {
  setClock(created)
  const t = make({ rrule, ...input })
  setClock(now)
  return t
}
/** Weekly Fridays 09:00, made Tue 10:00: first occurrence Fri Oct 23. */
function fridays(input: Record<string, unknown> = {}): Task {
  const t = repeating(FRIDAY_9, '2026-10-20T10:00', input)
  expect(t.occurrence_at).toBe(at('2026-10-23T09:00'))
  return t
}
/** Daily 08:00, made Tue 07:00: today's 08:00 occurrence has come (over target at 10:00). */
function daily(input: Record<string, unknown> = {}): Task {
  const t = repeating(DAILY_8, '2026-10-20T07:00', input)
  expect(t.occurrence_at).toBe(at('2026-10-20T08:00'))
  return t
}
function task(id: number): Task {
  return getTaskById(id)!
}
function done(id: number) {
  return markDone({ ...u, taskId: id })
}
function completions(id: number) {
  return getDb()
    .prepare(
      'SELECT occurrence_at_was, occurrence_at_next, due_at_next FROM completions WHERE task_id = ? ORDER BY id',
    )
    .all(id) as { occurrence_at_was: string; occurrence_at_next: string | null }[]
}
function roll(local: string) {
  setClock(local)
  return runTaskRollover({ now: new Date(at(local)), userId: TEST_USER_ID })
}
function message(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    if (err instanceof ZodError) return err.issues.map((i) => i.message).join('; ')
    return (err as Error).message
  }
  throw new Error('expected a refusal')
}

beforeEach(() => {
  setupTestDb()
  const db = getDb()
  db.prepare('DELETE FROM time_slots WHERE user_id = ?').run(TEST_USER_ID)
  const insert = db.prepare(
    'INSERT INTO time_slots (user_id, label, start_time, sort_order) VALUES (?, ?, ?, ?)',
  )
  ;['06:30', '12:00', '20:30'].forEach((s, i) => insert.run(TEST_USER_ID, `Period ${i}`, s, i))
  db.prepare("UPDATE users SET morning_time = '08:30' WHERE id = ?").run(TEST_USER_ID)
  vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
  setClock('2026-10-20T10:00')
  db.prepare("UPDATE users SET last_rollover_date = '2026-10-20' WHERE id = ?").run(TEST_USER_ID)
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})
afterAll(() => teardownTestDb())

// ---------------------------------------------------------------------------
// The pure functions
// ---------------------------------------------------------------------------

describe('RE: the judge (pure)', () => {
  const end = (count: number | null, used: number, until: string | null) => ({
    repeat_count: count,
    repeat_count_used: used,
    repeat_until: until,
  })
  const landing = at('2026-10-30T09:00')

  test('RE-U01: repeatStep — a count, a date, no landing, no end', () => {
    // No end: always on, `used` counts every close.
    expect(repeatStep(end(null, 4, null), landing, 1, tz)).toEqual({
      ended: false,
      occurrenceAt: landing,
      used: 5,
    })
    // A count: ends when used + closes reaches it.
    expect(repeatStep(end(3, 1, null), landing, 1, tz).ended).toBe(false)
    expect(repeatStep(end(3, 2, null), landing, 1, tz)).toEqual({
      ended: true,
      used: 3,
      consumed: 1,
    })
    // Closing more than is left consumes only what was left.
    expect(repeatStep(end(3, 1, null), landing, 5, tz)).toEqual({
      ended: true,
      used: 3,
      consumed: 2,
    })
    // A date: the landing's LOCAL date against the inclusive last day.
    expect(repeatStep(end(null, 0, '2026-10-30'), landing, 1, tz).ended).toBe(false)
    expect(repeatStep(end(null, 0, '2026-10-29'), landing, 1, tz)).toEqual({
      ended: true,
      used: 1,
      consumed: 1,
    })
    // 23:30 Chicago on Oct 30 is Oct 31 in UTC: still Oct 30 locally — in the series.
    expect(repeatStep(end(null, 0, '2026-10-30'), at('2026-10-30T23:30'), 1, tz).ended).toBe(false)
    // No landing: the rule has no next — ended.
    expect(repeatStep(end(null, 0, null), null, 1, tz).ended).toBe(true)
  })

  test('RE-U02: nextOrEnd — a count that ends never asks the engine', () => {
    const t = {
      rrule: 'FREQ=YEARLY;BYMONTH=4;BYMONTHDAY=31', // never occurs: the engine would throw
      repeat_anchor: 'target' as const,
      recurrence_mode: 'from_due' as const,
      anchor_time: '09:00',
      occurrence_at: at('2026-10-23T09:00'),
      due_at: at('2026-10-23T09:00'),
      repeat_count: 2,
      repeat_count_used: 1,
      repeat_until: null,
    }
    expect(nextOrEnd(t, tz, { completedAt: new Date(), dayStart: CALENDAR_DAY_START })).toEqual({
      ended: true,
      used: 2,
      consumed: 1,
    })
  })

  test('RE-U03: isLastOccurrence and repeat_remaining', () => {
    const base = {
      rrule: FRIDAY_9,
      repeat_anchor: 'target' as const,
      recurrence_mode: 'from_due' as const,
      anchor_time: '09:00',
      occurrence_at: at('2026-10-23T09:00'),
      due_at: at('2026-10-23T09:00'),
    }
    const now = new Date(at('2026-10-20T10:00'))
    expect(isLastOccurrence({ ...base }, tz, now, CALENDAR_DAY_START)).toBe(false)
    expect(
      isLastOccurrence(
        { ...base, repeat_count: 3, repeat_count_used: 1 },
        tz,
        now,
        CALENDAR_DAY_START,
      ),
    ).toBe(false)
    expect(
      isLastOccurrence(
        { ...base, repeat_count: 3, repeat_count_used: 2 },
        tz,
        now,
        CALENDAR_DAY_START,
      ),
    ).toBe(true)
    // A date: the next Friday (Oct 30) is after Oct 29 — this one is the last.
    expect(
      isLastOccurrence({ ...base, repeat_until: '2026-10-29' }, tz, now, CALENDAR_DAY_START),
    ).toBe(true)
    expect(
      isLastOccurrence({ ...base, repeat_until: '2026-10-30' }, tz, now, CALENDAR_DAY_START),
    ).toBe(false)
    // A closed row is never "the last".
    const closed = { ...base, repeat_count: 3, repeat_count_used: 3, done: true }
    expect(isLastOccurrence(closed, tz, now, CALENDAR_DAY_START)).toBe(false)
    // An ended-by-skip series needs the end: an archived repeat without one is not.
    const archived = { rrule: FRIDAY_9, done: false, archived_at: at('2026-10-20T10:00') }
    expect(seriesEndedBySkip({ ...archived, repeat_count: 2, repeat_count_used: 2 })).toBe(true)
    expect(seriesEndedBySkip(archived)).toBe(false)
    expect(seriesEndedBySkip({ ...archived, done: true, repeat_count: 2 })).toBe(false)
    expect(repeatRemaining({ repeat_count: 6, repeat_count_used: 4 })).toBe(2)
    expect(repeatRemaining({ repeat_until: '2026-12-31' })).toBeNull()
  })

  test('RE-U04: the words', () => {
    expect(seriesEndWords({ repeat_count: 6 })).toBe('the last of 6')
    expect(seriesEndWords({ repeat_until: '2026-12-31' })).toBe('the last; it ended Dec 31')
    const now = new Date(at('2026-10-20T10:00'))
    expect(formatRepeatEnd({ repeat_count: 6, repeat_count_used: 4 }, now)).toBe('6 times (2 left)')
    expect(formatRepeatEnd({ repeat_until: '2026-12-31' }, now)).toBe('until Dec 31')
    expect(formatRepeatEnd({ repeat_until: '2027-01-15' }, now)).toBe('until Jan 15, 2027')
    expect(formatRepeatEnd({}, now)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Validation (plan §2)
// ---------------------------------------------------------------------------

describe('RE: fields, shorthand and the 400s', () => {
  test('RE-001: create with a count — stored end-free, used 0, the derived fields', () => {
    const t = fridays({ repeat_count: 3 })
    expect(t).toMatchObject({
      rrule: FRIDAY_9,
      repeat_count: 3,
      repeat_count_used: 0,
      repeat_until: null,
      repeat_last: false,
      repeat_remaining: 3,
    })
    const res = formatTaskResponse(t, tz)
    expect(res.repeat_last).toBe(false)
    expect(res.repeat_remaining).toBe(3)
    // No end: the response still carries both keys.
    const plain = formatTaskResponse(fridays(), tz)
    expect(plain).toMatchObject({ repeat_last: false, repeat_remaining: null, repeat_count: null })
  })

  test('RE-002: COUNT and UNTIL in rrule are lifted; UNTIL is taken literally as the local day', () => {
    expect(liftRuleEnd({ rrule: `${FRIDAY_9};COUNT=6` })).toEqual({
      rrule: FRIDAY_9,
      repeat_count: 6,
    })
    // The legacy picker's T235959Z is the END of the day in UTC — 6:59 PM in
    // Chicago, 8:59 AM the next day in Tokyo. The date is what was picked.
    expect(liftRuleEnd({ rrule: `${FRIDAY_9};UNTIL=20261231T235959Z` })).toEqual({
      rrule: FRIDAY_9,
      repeat_until: '2026-12-31',
    })
    expect(liftRuleEnd({ rrule: `UNTIL=20261231;${FRIDAY_9}` })).toEqual({
      rrule: FRIDAY_9,
      repeat_until: '2026-12-31',
    })
    const tokyo = createTask({
      userId: TEST_USER_ID,
      userTimezone: 'Asia/Tokyo',
      input: validateTaskCreate({ title: 'T', rrule: `${FRIDAY_9};UNTIL=20261231T235959Z` }),
    })
    expect(tokyo).toMatchObject({ rrule: FRIDAY_9, repeat_until: '2026-12-31' })
    // A rule with no end passes untouched.
    expect(liftRuleEnd({ rrule: FRIDAY_9 })).toEqual({ rrule: FRIDAY_9 })
  })

  test('RE-003: shorthand conflicts', () => {
    expect(
      message(() =>
        validateTaskCreate({ title: 'T', rrule: `${FRIDAY_9};COUNT=3;UNTIL=20261231` }),
      ),
    ).toBe(REPEAT_END_MESSAGES.both_ends)
    expect(
      message(() =>
        validateTaskCreate({ title: 'T', rrule: `${FRIDAY_9};COUNT=3`, repeat_count: 4 }),
      ),
    ).toBe(RULE_END_CONFLICT_MESSAGE)
    // The same end twice is fine.
    expect(
      validateTaskCreate({ title: 'T', rrule: `${FRIDAY_9};COUNT=3`, repeat_count: 3 })
        .repeat_count,
    ).toBe(3)
    expect(message(() => validateTaskCreate({ title: 'T', rrule: `${FRIDAY_9};COUNT=x` }))).toBe(
      REPEAT_END_MESSAGES.count_range,
    )
    expect(
      message(() => validateTaskCreate({ title: 'T', rrule: `${FRIDAY_9};UNTIL=2026-12` })),
    ).toBe(REPEAT_END_MESSAGES.until_invalid)
  })

  test('RE-004: the 400 table', () => {
    const v = (input: Record<string, unknown>) => () => make({ rrule: FRIDAY_9, ...input })
    expect(message(v({ repeat_count: 0 }))).toBe(REPEAT_END_MESSAGES.count_range)
    expect(message(v({ repeat_count: 1000 }))).toBe(REPEAT_END_MESSAGES.count_range)
    expect(message(v({ repeat_count: 2.5 }))).toBe(REPEAT_END_MESSAGES.count_range)
    expect(message(v({ repeat_count: 3, repeat_until: '2026-12-31' }))).toBe(
      REPEAT_END_MESSAGES.both_ends,
    )
    expect(message(v({ repeat_until: '2026-10-19' }))).toBe(REPEAT_END_MESSAGES.until_past)
    expect(message(v({ repeat_until: '2036-10-21' }))).toBe(REPEAT_END_MESSAGES.until_too_far)
    expect(message(v({ repeat_until: '2026-02-30' }))).toBe(REPEAT_END_MESSAGES.until_invalid)
    // The first occurrence is Fri Oct 23: an end on Thu leaves none.
    expect(message(v({ repeat_until: '2026-10-22' }))).toBe(
      REPEAT_END_MESSAGES.until_before_occurrence,
    )
    // Today is allowed (the date is not past), when the occurrence is on it.
    expect(daily({ repeat_until: '2026-10-20' }).repeat_until).toBe('2026-10-20')
    // A one-off, a reminder and a quota can't end.
    expect(message(() => make({ repeat_count: 3 }))).toBe(REPEAT_END_MESSAGES.ends_need_rule)
    expect(message(v({ repeat_count: 3, is_reminder: true }))).toBe(REPEAT_END_MESSAGES.ends_kind)
    expect(
      message(() =>
        make({ rrule: 'FREQ=WEEKLY', progress_target: 3, is_tracked: true, repeat_count: 3 }),
      ),
    ).toBe(REPEAT_END_MESSAGES.ends_kind)
  })

  test('RE-005: count_spent, and a write that turns an ending task into a reminder', () => {
    const t = fridays({ repeat_count: 4 })
    done(t.id)
    done(t.id)
    expect(task(t.id).repeat_count_used).toBe(2)
    expect(message(() => patch(t.id, { repeat_count: 2 }))).toBe(REPEAT_END_MESSAGES.count_spent)
    // Changing N keeps used (A7): 5 > 2.
    patch(t.id, { repeat_count: 5 })
    expect(task(t.id)).toMatchObject({ repeat_count: 5, repeat_count_used: 2, repeat_remaining: 3 })
    expect(message(() => patch(t.id, { is_reminder: true }))).toBe(REPEAT_END_MESSAGES.ends_kind)
  })
})

describe('RE: edits', () => {
  test('RE-006: edits — one end clears the other, a count from none restarts used, rrule null clears', () => {
    const t = fridays()
    done(t.id) // used 1, with no end set
    expect(task(t.id).repeat_count_used).toBe(1)
    // A count where there was none: the current occurrence is #1 (A3).
    patch(t.id, { repeat_count: 3 })
    expect(task(t.id)).toMatchObject({ repeat_count: 3, repeat_count_used: 0 })
    // A date clears the count.
    patch(t.id, { repeat_until: '2026-12-31' })
    expect(task(t.id)).toMatchObject({ repeat_count: null, repeat_until: '2026-12-31' })
    // A count clears the date.
    patch(t.id, { repeat_count: 2 })
    expect(task(t.id)).toMatchObject({ repeat_count: 2, repeat_until: null })
    // A rule change keeps the end and used (the rule is sent end-free).
    done(t.id)
    patch(t.id, { rrule: 'FREQ=WEEKLY;BYDAY=TH;BYHOUR=9;BYMINUTE=0' })
    expect(task(t.id)).toMatchObject({ repeat_count: 2, repeat_count_used: 1 })
    // Echoing the end-free rule back never wipes the end.
    patch(t.id, { rrule: task(t.id).rrule, title: 'Renamed' })
    expect(task(t.id).repeat_count).toBe(2)
    // Shorthand on PATCH sets the end.
    patch(t.id, { rrule: 'FREQ=WEEKLY;BYDAY=TH;BYHOUR=9;BYMINUTE=0;UNTIL=20261231T235959Z' })
    expect(task(t.id)).toMatchObject({ repeat_count: null, repeat_until: '2026-12-31' })
    // Stop repeating: all three cleared.
    patch(t.id, { rrule: null })
    expect(task(t.id)).toMatchObject({
      rrule: null,
      repeat_count: null,
      repeat_until: null,
      repeat_count_used: 0,
    })
    // And undo puts them back.
    executeUndo(TEST_USER_ID)
    expect(task(t.id)).toMatchObject({ repeat_until: '2026-12-31' })
  })

  test('RE-007: a rule change that moves the occurrence past the end date is refused', () => {
    const t = fridays({ repeat_until: '2026-10-25' })
    // Mondays: the first is Oct 26, after the end.
    expect(message(() => patch(t.id, { rrule: MONDAY_8 }))).toBe(
      REPEAT_END_MESSAGES.until_before_occurrence,
    )
  })

  test('RE-010: an unchanged end echoed back is not re-judged (a passed date on a debt row)', () => {
    // Through Oct 20: today's occurrence is the last; missed, it stays as debt.
    const t = daily({ repeat_until: '2026-10-20' })
    setClock('2026-10-23T10:00')
    // The editor saves the whole draft: the same end comes back with a title.
    patch(t.id, { title: 'Renamed', repeat_until: '2026-10-20' })
    expect(task(t.id)).toMatchObject({ title: 'Renamed', repeat_until: '2026-10-20' })
    // A CHANGED date is judged: still in the past.
    expect(message(() => patch(t.id, { repeat_until: '2026-10-21' }))).toBe(
      REPEAT_END_MESSAGES.until_past,
    )
    // Likewise a count sent equal to the stored one.
    const c = fridays({ repeat_count: 2 })
    done(c.id)
    patch(c.id, { title: 'Again', repeat_count: 2 })
    expect(task(c.id).repeat_count).toBe(2)
  })

  test('RE-008: bulk edit never sets an end (A11)', () => {
    const t = fridays()
    expect(message(() => validateBulkEdit({ ids: [t.id], changes: { repeat_count: 3 } }))).toBe(
      BULK_ENDS_MESSAGE,
    )
    expect(
      message(() => validateBulkEdit({ ids: [t.id], changes: { rrule: `${FRIDAY_9};COUNT=3` } })),
    ).toBe(BULK_ENDS_MESSAGE)
    expect(
      message(() =>
        validateBulkEdit({
          ids: [t.id],
          changes: { priority: 1 },
          per_task: { [String(t.id)]: { rrule: `${FRIDAY_9};UNTIL=20261231` } },
        }),
      ),
    ).toBe(BULK_ENDS_MESSAGE)
    // A bulk rule clear clears each task's end.
    patch(t.id, { repeat_count: 3 })
    bulkEdit({
      ...u,
      taskIds: [t.id],
      changes: validateBulkEdit({ ids: [t.id], changes: { rrule: null } }).changes,
    })
    expect(task(t.id)).toMatchObject({ rrule: null, repeat_count: null })
  })

  test('RE-009: repeatEndProblem is pure (the editor shares it)', () => {
    const now = new Date(at('2026-10-20T10:00'))
    const check = {
      count: null,
      until: '2026-10-22',
      used: 0,
      countWritten: false,
      untilWritten: false,
      walkWritten: false,
      occurrenceAt: at('2026-10-23T09:00'),
      hasRule: true,
      isReminder: false,
      isTracked: false,
    }
    // A stored end, with neither it nor the walk written: a reschedule of
    // this occurrence past it is allowed (that occurrence is in the series).
    expect(repeatEndProblem(check, tz, now, CALENDAR_DAY_START)).toBeNull()
    expect(repeatEndProblem({ ...check, walkWritten: true }, tz, now, CALENDAR_DAY_START)).toBe(
      'until_before_occurrence',
    )
  })
})

// ---------------------------------------------------------------------------
// The writers (plan §4)
// ---------------------------------------------------------------------------

describe('RE: done, put-back, undo', () => {
  test('RE-W01: weekly for 3 — done, done, done → done=1, archived, completion rows', () => {
    const t = fridays({ repeat_count: 3 })
    const r1 = done(t.id)
    expect(r1.seriesEnded).toBe(false)
    expect(task(t.id)).toMatchObject({
      occurrence_at: at('2026-10-30T09:00'),
      repeat_count_used: 1,
      repeat_last: false,
      repeat_remaining: 2,
    })
    done(t.id)
    expect(task(t.id)).toMatchObject({
      occurrence_at: at('2026-11-06T09:00'),
      repeat_count_used: 2,
      repeat_last: true,
      repeat_remaining: 1,
    })
    const r3 = done(t.id)
    expect(r3).toMatchObject({ seriesEnded: true, wasRecurring: true, nextDueAt: null })
    const ended = task(t.id)
    expect(ended).toMatchObject({
      done: true,
      repeat_count_used: 3,
      repeat_remaining: 0,
      completion_count: 3,
      // The occurrence stays, so a put-back restores it exactly.
      occurrence_at: at('2026-11-06T09:00'),
      due_at: at('2026-11-06T09:00'),
    })
    expect(ended.archived_at).not.toBeNull()
    expect(ended.done_at).not.toBeNull()
    const rows = completions(t.id)
    expect(rows).toHaveLength(3)
    expect(rows[2]).toMatchObject({
      occurrence_at_was: at('2026-11-06T09:00'),
      occurrence_at_next: null,
    })
    // The history words.
    const entry = getDb()
      .prepare('SELECT description FROM undo_log WHERE user_id = ? ORDER BY id DESC LIMIT 1')
      .get(TEST_USER_ID) as { description: string }
    expect(entry.description).toBe('Marked "Task" done — the last of 3')
    // Done again, and skip, are refused.
    expect(message(() => done(t.id))).toBe('Task is already done')
    expect(message(() => skipOccurrence({ ...u, taskId: t.id }))).toBe('Task is already done')
  })

  test('RE-W02: put-back of the final done reopens it on its occurrence, used back', () => {
    const t = fridays({ repeat_count: 2 })
    done(t.id)
    done(t.id)
    expect(task(t.id).done).toBe(true)
    markUndone({ ...u, taskId: t.id })
    expect(task(t.id)).toMatchObject({
      done: false,
      archived_at: null,
      repeat_count_used: 1,
      occurrence_at: at('2026-10-30T09:00'),
      repeat_last: true,
      completion_count: 1,
    })
    expect(completions(t.id)).toHaveLength(1)
    // And done ends it again.
    expect(done(t.id).seriesEnded).toBe(true)
  })

  test('RE-W03: put-back of a non-final done (the recurring put-back) gives used back', () => {
    const t = fridays({ repeat_count: 3 })
    done(t.id)
    markUndone({ ...u, taskId: t.id })
    expect(task(t.id)).toMatchObject({
      repeat_count_used: 0,
      occurrence_at: at('2026-10-23T09:00'),
    })
  })

  test('RE-W04: undo and redo of the final done, and of a non-final done', () => {
    const t = fridays({ repeat_count: 2 })
    done(t.id)
    executeUndo(TEST_USER_ID)
    expect(task(t.id)).toMatchObject({
      repeat_count_used: 0,
      occurrence_at: at('2026-10-23T09:00'),
    })
    executeRedo(TEST_USER_ID)
    expect(task(t.id)).toMatchObject({
      repeat_count_used: 1,
      occurrence_at: at('2026-10-30T09:00'),
    })
    done(t.id)
    expect(task(t.id).done).toBe(true)
    executeUndo(TEST_USER_ID)
    expect(task(t.id)).toMatchObject({
      done: false,
      archived_at: null,
      repeat_count_used: 1,
      occurrence_at: at('2026-10-30T09:00'),
    })
    expect(completions(t.id)).toHaveLength(1)
    executeRedo(TEST_USER_ID)
    expect(task(t.id)).toMatchObject({ done: true, repeat_count_used: 2 })
    expect(completions(t.id)).toHaveLength(2)
  })
})

describe('RE: completion rows across put-back and undo', () => {
  test('RE-W06: put-back, undo, put-back of the final done — every completion row survives', () => {
    const t = daily({ repeat_count: 2 })
    const rows = () =>
      getDb()
        .prepare('SELECT id, completed_at FROM completions WHERE task_id = ? ORDER BY id')
        .all(t.id) as { id: number; completed_at: string }[]
    setClock('2026-10-20T10:00')
    done(t.id) // the Oct 20 occurrence
    setClock('2026-10-21T10:00')
    done(t.id) // the Oct 21 occurrence: the last
    const [first, last] = rows()
    expect(rows()).toHaveLength(2)
    expect(task(t.id)).toMatchObject({ done: true, last_completed_at: last.completed_at })

    // Put back: the last row goes; last_completed_at is the one before it.
    markUndone({ ...u, taskId: t.id })
    expect(rows()).toEqual([first])
    expect(task(t.id)).toMatchObject({
      done: false,
      completion_count: 1,
      last_completed_at: first.completed_at,
      repeat_count_used: 1,
    })
    // Undo of the put-back: the same row comes back, with its id.
    executeUndo(TEST_USER_ID)
    expect(rows()).toEqual([first, last])
    expect(task(t.id)).toMatchObject({ done: true, completion_count: 2 })
    // Put back again: the LAST row goes again — never the Oct 20 one.
    markUndone({ ...u, taskId: t.id })
    expect(rows()).toEqual([first])
    // Redo of an undone put-back deletes by id, too.
    executeUndo(TEST_USER_ID)
    executeRedo(TEST_USER_ID)
    expect(rows()).toEqual([first])
  })

  test('RE-W07: a one-off reopened, undone and reopened keeps its rows straight too', () => {
    const t = make({ due_at: at('2026-10-20T09:00') })
    done(t.id)
    markUndone({ ...u, taskId: t.id })
    done(t.id)
    const rows = () =>
      getDb().prepare('SELECT id FROM completions WHERE task_id = ? ORDER BY id').all(t.id)
    expect(rows()).toHaveLength(1)
    markUndone({ ...u, taskId: t.id })
    expect(rows()).toHaveLength(0)
    executeUndo(TEST_USER_ID)
    expect(rows()).toHaveLength(1)
    expect(task(t.id).done).toBe(true)
  })

  test('RE-W05: bulk done of a mix — one series ends, one advances, a one-off is done', () => {
    const last = fridays({ repeat_count: 1 })
    const going = fridays({ repeat_count: 5 })
    const oneOff = make({ due_at: at('2026-10-20T09:00') })
    const r = bulkDone({ ...u, taskIds: [last.id, going.id, oneOff.id] })
    expect(r).toMatchObject({ recurringCount: 2, seriesEndedCount: 1, oneOffCount: 1 })
    expect(task(last.id)).toMatchObject({ done: true, repeat_count_used: 1 })
    expect(task(going.id)).toMatchObject({ done: false, repeat_count_used: 1 })
    // One undo entry undoes all three.
    executeUndo(TEST_USER_ID)
    expect(task(last.id)).toMatchObject({ done: false, repeat_count_used: 0 })
    expect(task(going.id).repeat_count_used).toBe(0)
    // An ended series in a bulk done is refused like a done one-off.
    bulkDone({ ...u, taskIds: [last.id] })
    expect(message(() => bulkDone({ ...u, taskIds: [last.id] }))).toContain('Invalid task IDs')
  })
})

describe('RE: skip, skip until', () => {
  test('RE-W10: skip the last → archived, done=0 (A1), skip_count + 1, no completion', () => {
    expect(SKIPPED_LAST_MARKS_DONE).toBe(false)
    const t = fridays({ repeat_count: 2 })
    skipOccurrence({ ...u, taskId: t.id })
    expect(task(t.id)).toMatchObject({ repeat_count_used: 1, skip_count: 1, repeat_last: true })
    const r = skipOccurrence({ ...u, taskId: t.id })
    expect(r.seriesEnded).toBe(true)
    expect(r.description).toBe('Skipped "Task" — the last of 2; the repeat has ended')
    const ended = task(t.id)
    expect(ended).toMatchObject({
      done: false,
      skip_count: 2,
      repeat_count_used: 2,
      completion_count: 0,
      occurrence_at: at('2026-10-30T09:00'),
    })
    expect(ended.archived_at).not.toBeNull()
    expect(completions(t.id)).toHaveLength(0)
    // Ended: done, skip and put-back all refuse; undo brings it back.
    expect(message(() => done(t.id))).toBe(REPEAT_ENDED_MESSAGE)
    expect(message(() => skipOccurrence({ ...u, taskId: t.id }))).toBe(REPEAT_ENDED_MESSAGE)
    expect(message(() => markUndone({ ...u, taskId: t.id }))).toBe('Task is not done')
    executeUndo(TEST_USER_ID)
    expect(task(t.id)).toMatchObject({ archived_at: null, repeat_count_used: 1, skip_count: 1 })
  })

  test('RE-W11: skip until past a count — consumes only what was left', () => {
    // Daily 08:00, 5 times; skip until Oct 30 would pass 10.
    const t = daily({ repeat_count: 5 })
    const r = skipUntil({ ...u, taskIds: [t.id], until: '2026-10-30' })
    expect(r).toMatchObject({ seriesEnded: 1, occurrencesSkipped: 5, tasksAffected: 1 })
    expect(r.summary).toBe('Skipped "Task" — the last of 5; the repeat has ended')
    expect(task(t.id)).toMatchObject({ skip_count: 5, repeat_count_used: 5, done: false })
    expect(task(t.id).archived_at).not.toBeNull()
  })

  test('RE-W12: skip until past a date — consumes the occurrences on or before it', () => {
    // Daily 08:00 through Oct 23: Oct 20, 21, 22, 23 are in the series.
    const t = daily({ repeat_until: '2026-10-23' })
    const r = skipUntil({ ...u, taskIds: [t.id], until: '2026-10-30' })
    expect(r).toMatchObject({ seriesEnded: 1, occurrencesSkipped: 4 })
    expect(task(t.id)).toMatchObject({ skip_count: 4, repeat_count_used: 4 })
    // Short of the end: an ordinary skip until.
    const going = daily({ repeat_until: '2026-10-30' })
    const r2 = skipUntil({ ...u, taskIds: [going.id], until: '2026-10-25' })
    expect(r2.seriesEnded).toBe(0)
    expect(task(going.id)).toMatchObject({
      occurrence_at: at('2026-10-25T08:00'),
      repeat_count_used: 5,
    })
  })

  test('RE-W13: skip until with no date on the last occurrence ends it; a batch counts "ended"', () => {
    const last = fridays({ repeat_count: 1 })
    const other = fridays()
    const r = skipUntil({ ...u, taskIds: [last.id, other.id] })
    expect(r).toMatchObject({ seriesEnded: 1, tasksAffected: 2, occurrencesSkipped: 2 })
    expect(r.summary).toBe('Skipped 2 tasks · 1 ended')
  })
})

describe('RE: the defer cap, the snooze guard', () => {
  test('RE-W20: no next occurrence on the last one — no cap, no guard, the sweep succeeds', () => {
    const t = daily({ repeat_count: 1 })
    expect(nextOccurrenceAfterSkip(task(t.id), tz, new Date(), CALENDAR_DAY_START)).toBeNull()
    expect(nextScheduledOccurrence(task(t.id), tz)).toBeNull()
    // Not the last: the guard sees tomorrow's.
    const going = daily({ repeat_count: 2 })
    expect(nextScheduledOccurrence(task(going.id), tz)?.toISOString()).toBe(at('2026-10-21T08:00'))
    const r = bulkSnooze({ ...u, taskIds: [t.id, going.id], deltaMinutes: 60, source: 'sweep' })
    expect(r.tasksAffected).toBe(2)
    // The delta moves its own target (08:00 → 09:00), uncapped.
    expect(task(t.id).due_at).toBe(at('2026-10-20T09:00'))
  })
})

describe('RE: the rollover (A4)', () => {
  test('RE-W30: a roll uses one; a missed LAST occurrence is left as debt', () => {
    const t = daily({ repeat_count: 2 })
    roll('2026-10-21T06:30')
    expect(task(t.id)).toMatchObject({
      occurrence_at: at('2026-10-21T08:00'),
      skip_count: 1,
      repeat_count_used: 1,
      repeat_last: true,
    })
    roll('2026-10-22T06:30')
    // Untouched: still on Wed's occurrence, over target, open.
    expect(task(t.id)).toMatchObject({
      occurrence_at: at('2026-10-21T08:00'),
      due_at: at('2026-10-21T08:00'),
      skip_count: 1,
      repeat_count_used: 1,
      done: false,
      archived_at: null,
      queued_at: null,
    })
    // Done ends it.
    expect(done(t.id).seriesEnded).toBe(true)
  })

  test('RE-W31: a date end — the roll stops at the last day', () => {
    const t = daily({ repeat_until: '2026-10-21' })
    roll('2026-10-21T06:30')
    expect(task(t.id).occurrence_at).toBe(at('2026-10-21T08:00'))
    roll('2026-10-22T06:30')
    expect(task(t.id)).toMatchObject({ occurrence_at: at('2026-10-21T08:00'), done: false })
  })

  test('RE-W32: an end set during a wait — the release returns the debt, no skip', () => {
    // Mondays 08:00, made Mon Oct 19 07:00: Monday's occurrence missed.
    const t = repeating(MONDAY_8, '2026-10-19T07:00')
    roll('2026-10-21T06:30')
    expect(task(t.id)).toMatchObject({ due_at: at('2026-10-26T08:00') })
    expect(task(t.id).queued_at).not.toBeNull()
    // The missed occurrence is now the last.
    patch(t.id, { repeat_count: 1 })
    roll('2026-10-26T06:30')
    expect(task(t.id)).toMatchObject({
      due_at: at('2026-10-19T08:00'),
      occurrence_at: at('2026-10-19T08:00'),
      queued_at: null,
      skip_count: 0,
      repeat_count_used: 0,
      repeat_last: true,
    })
  })

  test('RE-W33: the days a wait spent in the queue are not attempts when the debt returns', () => {
    const t = repeating(MONDAY_8, '2026-10-19T07:00')
    // Over target Mon Oct 19 and Tue Oct 20 (OpenTask days): 2.
    setClock('2026-10-20T21:00')
    expect(task(t.id).attempts).toBe(2)
    roll('2026-10-21T06:30')
    // Waiting: frozen at its checkpoint.
    setClock('2026-10-25T21:00')
    expect(task(t.id).attempts).toBe(2)
    patch(t.id, { repeat_count: 1 })
    roll('2026-10-26T06:30')
    // The debt is back: today counts (it nags today), the five days in the
    // queue (Oct 21–25, never shown as over target) do not.
    setClock('2026-10-26T07:00')
    expect(task(t.id).attempts).toBe(3)
  })
})

describe('RE: decks, modes, deadline-anchored', () => {
  test('RE-W40: on deck on the last occurrence — done ends it, put-back brings the deck back', () => {
    const t = daily({ repeat_count: 1 })
    deckTasks({ userId: TEST_USER_ID, timezone: tz, ids: [t.id], day: '2026-10-21' })
    expect(task(t.id)).toMatchObject({ on_deck_day: '2026-10-21', due_at: null })
    expect(done(t.id).seriesEnded).toBe(true)
    expect(task(t.id)).toMatchObject({ done: true, on_deck_day: '2026-10-21' })
    markUndone({ ...u, taskId: t.id })
    expect(task(t.id)).toMatchObject({
      done: false,
      on_deck_day: '2026-10-21',
      repeat_count_used: 0,
      occurrence_at: at('2026-10-20T08:00'),
    })
  })

  test('RE-W41: from_completion with a count — each done uses one', () => {
    const t = repeating('FREQ=DAILY;INTERVAL=10;BYHOUR=9;BYMINUTE=0', '2026-10-20T10:00', {
      recurrence_mode: 'from_completion',
      repeat_count: 2,
    })
    done(t.id)
    expect(task(t.id)).toMatchObject({ repeat_count_used: 1, repeat_last: true })
    expect(done(t.id).seriesEnded).toBe(true)
  })

  test('RE-W42: from_completion with a date — ends when "done now + interval" is after it', () => {
    const t = repeating('FREQ=DAILY;INTERVAL=10;BYHOUR=9;BYMINUTE=0', '2026-10-20T10:00', {
      recurrence_mode: 'from_completion',
      repeat_until: '2026-11-15',
    })
    // Done now (Oct 20): next Oct 30 — in.
    done(t.id)
    expect(task(t.id).occurrence_at).toBe(at('2026-10-30T09:00'))
    // Judged at max(occurrence, now): Oct 30 + 10 = Nov 9 — still in.
    expect(task(t.id).repeat_last).toBe(false)
    // Done late, Nov 7: Nov 17 is after Nov 15 — it ends.
    setClock('2026-11-07T10:00')
    expect(task(t.id).repeat_last).toBe(true)
    expect(done(t.id).seriesEnded).toBe(true)
  })

  test('RE-W43: deadline-anchored with a date — judged on the deadline, not the target (A5)', () => {
    // Deadline Fridays 17:00, target 3 days before at 08:00. Through Thu Oct 29:
    // Oct 30's TARGET (Tue Oct 27) is before it, but its deadline is not.
    const t = repeating('FREQ=WEEKLY;BYDAY=FR;BYHOUR=17;BYMINUTE=0', '2026-10-20T07:00', {
      deadline_at: at('2026-10-23T17:00'),
      target_days_before: 3,
      target_time: '08:00',
      repeat_until: '2026-10-29',
    })
    expect(task(t.id).repeat_last).toBe(true)
    expect(done(t.id).seriesEnded).toBe(true)
    // Through Fri Oct 30: one more.
    const t2 = repeating('FREQ=WEEKLY;BYDAY=FR;BYHOUR=17;BYMINUTE=0', '2026-10-20T07:00', {
      deadline_at: at('2026-10-23T17:00'),
      target_days_before: 3,
      target_time: '08:00',
      repeat_until: '2026-10-30',
    })
    done(t2.id)
    expect(task(t2.id)).toMatchObject({
      deadline_at: at('2026-10-30T17:00'),
      due_at: at('2026-10-27T08:00'),
      repeat_last: true,
    })
    // A reschedule of THIS occurrence's deadline past the end is allowed.
    patch(t2.id, { deadline_at: at('2026-10-31T17:00') })
    expect(task(t2.id).deadline_at).toBe(at('2026-10-31T17:00'))
    expect(done(t2.id).seriesEnded).toBe(true)
  })
})

describe('RE: the startup lift (liftRuleEnds)', () => {
  test('RE-M01: a stored COUNT/UNTIL is lifted into the columns, once', () => {
    const a = fridays()
    const b = fridays()
    const c = fridays({ repeat_count: 4 })
    const db = getDb()
    db.prepare('UPDATE tasks SET rrule = ? WHERE id = ?').run(`${FRIDAY_9};COUNT=6`, a.id)
    db.prepare('UPDATE tasks SET rrule = ?, repeat_count_used = 3 WHERE id = ?').run(
      `UNTIL=20261231T235959Z;${FRIDAY_9}`,
      b.id,
    )
    // A column already set wins over the rule's end.
    db.prepare('UPDATE tasks SET rrule = ? WHERE id = ?').run(`${FRIDAY_9};COUNT=9`, c.id)
    // A reminder and a quota can't end: their rule's end is stripped, not lifted.
    const reminder = make({ rrule: DAILY_8, is_reminder: true })
    const quota = make({ rrule: 'FREQ=WEEKLY', is_tracked: true, progress_target: 3 })
    db.prepare('UPDATE tasks SET rrule = ? WHERE id = ?').run(
      `${DAILY_8};UNTIL=20261231`,
      reminder.id,
    )
    db.prepare('UPDATE tasks SET rrule = ? WHERE id = ?').run('FREQ=WEEKLY;COUNT=4', quota.id)
    expect(liftRuleEnds(db)).toEqual({ lifted: 3, stripped: [reminder.id, quota.id] })
    expect(task(reminder.id)).toMatchObject({ rrule: DAILY_8, repeat_until: null })
    expect(task(quota.id)).toMatchObject({ rrule: 'FREQ=WEEKLY', repeat_count: null })
    // …so they stay editable.
    patch(reminder.id, { title: 'Still a reminder' })
    expect(task(a.id)).toMatchObject({ rrule: FRIDAY_9, repeat_count: 6, repeat_count_used: 0 })
    expect(task(b.id)).toMatchObject({
      rrule: FRIDAY_9,
      repeat_until: '2026-12-31',
      repeat_count_used: 0,
    })
    expect(task(c.id)).toMatchObject({ rrule: FRIDAY_9, repeat_count: 4 })
    // Idempotent.
    expect(liftRuleEnds(db)).toEqual({ lifted: 0, stripped: [] })
  })

  test('RE-M02: a lifted legacy row ends (its UNTIL already passed: the next done ends it)', () => {
    const t = daily()
    getDb()
      .prepare('UPDATE tasks SET rrule = ? WHERE id = ?')
      .run(`${DAILY_8};UNTIL=20261020`, t.id)
    liftRuleEnds(getDb())
    expect(task(t.id)).toMatchObject({ repeat_until: '2026-10-20', repeat_last: true })
    expect(done(t.id).seriesEnded).toBe(true)
  })
})

describe('RE-G01: every advance goes through the end judge', () => {
  function files(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) return files(p)
      return /\.tsx?$/.test(e.name) ? [p] : []
    })
  }
  const read = (f: string) => fs.readFileSync(f, 'utf8')
  const src = files('src').map((f) => f.split(path.sep).join('/'))

  /**
   * Files that ask the END-BLIND engine (`computeNextOccurrence`, or
   * `nextLanding`) without the judge, and why. Anything else must import
   * `repeatStep` or `nextOrEnd`. (`nextOccurrenceAfterSkip` is judged itself:
   * it returns null on the last occurrence.)
   */
  const EXEMPT: Record<string, string> = {
    'src/core/recurrence/compute-next.ts': 'the engine itself',
    'src/core/recurrence/index.ts': 're-export',
    // todaysOccurrence / effectiveDueAt: reminders only, which never end.
    'src/core/recurrence/occurrence.ts': 'reminders (never end)',
    // Enrichment sets a first occurrence, never an advance; ends are PR 5.
    'src/core/ai/enrichment.ts': 'first occurrence only (PR 5)',
    // (The editor's preview walk, src/lib/every-time.ts, is judged since 4c:
    // `nextDates` cuts it with `repeatStep`.)
  }

  test('RE-G01a: a caller of the end-blind engine imports the judge, or is exempt', () => {
    const offenders = src.filter((f) => {
      if (EXEMPT[f]) return false
      const text = read(f)
      const asks = /\b(computeNextOccurrence|nextLanding)\(/.test(text)
      return asks && !/\b(repeatStep|nextOrEnd)\b/.test(text)
    })
    expect(offenders).toEqual([])
    // The judged wrappers really are judged.
    expect(read('src/core/tasks/skip.ts')).toMatch(
      /export function nextOccurrenceAfterSkip[\s\S]*?nextOrEnd\(/,
    )
    expect(read('src/core/tasks/helpers/compute-mark-done.ts')).toMatch(/nextOrEnd\(/)
  })

  test('RE-G01b: every SQL writer of skip_count / completion_count also writes repeat_count_used', () => {
    const EXEMPT_COUNTS: Record<string, string> = {
      // A quota's period close: a quota never has an end (ends_kind).
      'src/core/tasks/period-rollover.ts': 'quotas only',
    }
    const offenders = src.filter((f) => {
      if (EXEMPT_COUNTS[f]) return false
      const text = read(f)
      return (
        /\b(skip_count|completion_count) = \?/.test(text) && !text.includes('repeat_count_used')
      )
    })
    expect(offenders).toEqual([])
  })

  test('RE-G01c: a stored rule never carries an end (the shorthand is lifted first)', () => {
    expect(isValidRRule(`${FRIDAY_9};COUNT=3`)).toBe(false)
    expect(isValidRRule(`${FRIDAY_9};UNTIL=20261231`)).toBe(false)
    expect(validateTaskCreate({ title: 'T', rrule: `${FRIDAY_9};COUNT=3` }).rrule).toBe(FRIDAY_9)
  })
})

describe('RE: errors are ValidationErrors (400s)', () => {
  test('RE-E01: a refusal in core is a ValidationError', () => {
    const t = fridays({ repeat_count: 2 })
    expect(() => patch(t.id, { repeat_until: '2026-10-19' })).toThrow(ValidationError)
    expect(() => patch(t.id, { repeat_count: 0 })).toThrow(ZodError)
  })
})
