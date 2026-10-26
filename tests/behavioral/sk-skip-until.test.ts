/**
 * Skip until (SKU-001 …), task queue PR 4 — spec rule 10, resolution 7.
 *
 * "A tap with the default skips this occurrence; a date skips every
 * occurrence before it (the vacation case)." Many tasks at once; a mixed
 * batch is counted, never refused; one undo entry.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { DateTime } from 'luxon'
import { getDb } from '@/core/db'
import { createTask, markDone, deleteTask } from '@/core/tasks'
import { getTaskById } from '@/core/tasks/read'
import { skipOccurrence, nextOccurrenceAfterSkip } from '@/core/tasks/skip'
import { skipUntil, planSkipUntil } from '@/core/tasks/skip-until'
import { deckTasks } from '@/core/tasks/deck'
import { executeUndo, executeRedo } from '@/core/undo'
import { ValidationError } from '@/core/errors'
import { CALENDAR_DAY_START } from '@/lib/opentask-day'
import type { Task } from '@/types'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

const tz = TEST_TIMEZONE
const u = { userId: TEST_USER_ID, userTimezone: tz }

/** A Chicago wall-clock time as the UTC ISO string the DB stores. */
function at(local: string): string {
  return DateTime.fromISO(local, { zone: tz }).toUTC().toISO()!
}

function make(input: Record<string, unknown>): Task {
  return createTask({ ...u, input: { title: 'Task', ...input } })
}

function task(id: number): Task {
  return getTaskById(id)!
}

function set(id: number, fields: Record<string, unknown>): void {
  const cols = Object.keys(fields)
  getDb()
    .prepare(`UPDATE tasks SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
    .run(...cols.map((c) => fields[c] as string | number | null), id)
}

function undoEntries(): { action: string; snapshot: string }[] {
  return getDb()
    .prepare('SELECT action, snapshot FROM undo_log WHERE user_id = ? ORDER BY id')
    .all(TEST_USER_ID) as { action: string; snapshot: string }[]
}

/** Thu Jan 15 2026, 10:00 AM Chicago, on a fresh database. */
function useFixedDay(): void {
  beforeEach(() => {
    // Thu Jan 15 2026, 10:00 AM Chicago.
    vi.setSystemTime(new Date('2026-01-15T16:00:00Z'))
    setupTestDb()
  })

  afterEach(() => {
    vi.useRealTimers()
    teardownTestDb()
  })
}

describe('Skip until: landing and counts', () => {
  useFixedDay()

  test('SKU-001: daily — lands on the date, every occurrence before it is a skip', () => {
    const t = make({ rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0', due_at: at('2026-01-16T09:00') })
    const r = skipUntil({ ...u, taskIds: [t.id], until: '2026-01-20' })
    const after = task(t.id)
    expect(after.occurrence_at).toBe(at('2026-01-20T09:00'))
    expect(after.due_at).toBe(at('2026-01-20T09:00'))
    // Jan 16, 17, 18, 19.
    expect(after.skip_count).toBe(4)
    expect(r.tasksAffected).toBe(1)
    expect(r.occurrencesSkipped).toBe(4)
    expect(after.completion_count).toBe(0)
    expect(r.summary).toBe('Skipped 4 occurrences of "Task" · next Tue, Jan 20')
  })

  test('SKU-002: weekly — the first Monday on or after the date', () => {
    const t = make({
      rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0',
      due_at: at('2026-01-19T09:00'),
    })
    skipUntil({ ...u, taskIds: [t.id], until: '2026-02-03' })
    expect(task(t.id).occurrence_at).toBe(at('2026-02-09T09:00'))
    // Jan 19, Jan 26, Feb 2.
    expect(task(t.id).skip_count).toBe(3)
  })

  test('SKU-002b: an occurrence ON the date is not skipped (on or after its start)', () => {
    const t = make({
      rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0',
      due_at: at('2026-01-19T09:00'),
    })
    skipUntil({ ...u, taskIds: [t.id], until: '2026-02-02' })
    expect(task(t.id).occurrence_at).toBe(at('2026-02-02T09:00'))
    expect(task(t.id).skip_count).toBe(2)
  })

  test('SKU-003: monthly — the 1st after the date', () => {
    const t = make({
      rrule: 'FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=8;BYMINUTE=0',
      due_at: at('2026-02-01T08:00'),
    })
    skipUntil({ ...u, taskIds: [t.id], until: '2026-04-15' })
    expect(task(t.id).occurrence_at).toBe(at('2026-05-01T08:00'))
    // Feb 1, Mar 1, Apr 1.
    expect(task(t.id).skip_count).toBe(3)
  })

  test('SKU-004: no date = skip-occurrence, field for field', () => {
    const rule = { rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0', due_at: at('2026-01-16T09:00') }
    const a = make(rule)
    const b = make(rule)
    const r = skipUntil({ ...u, taskIds: [a.id] })
    skipOccurrence({ ...u, taskId: b.id })
    const [x, y] = [task(a.id), task(b.id)]
    for (const f of [
      'due_at',
      'occurrence_at',
      'original_due_at',
      'skip_count',
      'attempts',
    ] as const) {
      expect(x[f]).toEqual(y[f])
    }
    expect(x.occurrence_at).toBe(at('2026-01-17T09:00'))
    expect(r.occurrencesSkipped).toBe(1)
  })

  test('SKU-005: an over-target occurrence is one skip, however long it waited', () => {
    const t = make({ rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0', due_at: at('2026-01-16T09:00') })
    set(t.id, { due_at: at('2026-01-12T09:00'), occurrence_at: at('2026-01-12T09:00') })
    skipUntil({ ...u, taskIds: [t.id], until: '2026-01-18' })
    expect(task(t.id).occurrence_at).toBe(at('2026-01-18T09:00'))
    // The waiting one (Jan 12), then Jan 16 and 17 — the first after now is Jan 16.
    expect(task(t.id).skip_count).toBe(3)
  })

  test('SKU-006: from_completion lands ON the date at the rule time; the interval restarts there', () => {
    const t = make({
      rrule: 'FREQ=DAILY;INTERVAL=3;BYHOUR=9;BYMINUTE=0',
      recurrence_mode: 'from_completion',
      due_at: at('2026-01-16T09:00'),
    })
    skipUntil({ ...u, taskIds: [t.id], until: '2026-01-26' })
    const after = task(t.id)
    expect(after.occurrence_at).toBe(at('2026-01-26T09:00'))
    expect(after.due_at).toBe(at('2026-01-26T09:00'))
    // Stepped as if done on time: Jan 16, 19, 22, 25 (Jan 28 is the first on/after).
    expect(after.skip_count).toBe(4)

    vi.setSystemTime(new Date(at('2026-01-26T10:00')))
    markDone({ ...u, taskId: t.id })
    expect(task(t.id).due_at).toBe(at('2026-01-29T09:00'))
  })

  /** Deadline Mondays 17:00, target the Saturday before at 9:00 (2026-10-21). */
  function mondayDeadline(): Task {
    return make({
      rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=17;BYMINUTE=0',
      deadline_at: at('2026-01-19T17:00'),
      target_days_before: 2,
      target_time: '09:00',
    })
  }

  test('SKU-007: a deadline-anchored repeat lands where its DERIVED TARGET is on or after the date', () => {
    const t = mondayDeadline()
    expect(task(t.id).due_at).toBe(at('2026-01-17T09:00'))
    // Until Mon Feb 2: that Monday's deadline is on the date, but its target
    // (Sat Jan 31) is before it — skipped too. Lands on Feb 9 (target Sat Feb 7).
    const r = skipUntil({ ...u, taskIds: [t.id], until: '2026-02-02' })
    expect(r.occurrencesSkipped).toBe(3)
    expect(task(t.id).occurrence_at).toBe(at('2026-02-09T17:00'))
    expect(task(t.id).deadline_at).toBe(at('2026-02-09T17:00'))
    expect(task(t.id).due_at).toBe(at('2026-02-07T09:00'))

    // Until Sun Jan 18: the current occurrence's deadline (Mon) is after the
    // date but its target (Sat) is before — one skip, to Jan 26.
    const c = mondayDeadline()
    const one = skipUntil({ ...u, taskIds: [c.id], until: '2026-01-18' })
    expect(one.occurrencesSkipped).toBe(1)
    expect(task(c.id).occurrence_at).toBe(at('2026-01-26T17:00'))
    expect(task(c.id).due_at).toBe(at('2026-01-24T09:00'))
  })

  test('SKU-007b: from_completion, deadline-anchored: the DEADLINE lands target_days_before after the date', () => {
    const t = make({
      rrule: 'FREQ=WEEKLY;INTERVAL=2;BYHOUR=17;BYMINUTE=0',
      recurrence_mode: 'from_completion',
      deadline_at: at('2026-01-19T17:00'),
      target_days_before: 2,
      target_time: '09:00',
    })
    skipUntil({ ...u, taskIds: [t.id], until: '2026-02-20' })
    expect(task(t.id).deadline_at).toBe(at('2026-02-22T17:00'))
    expect(task(t.id).due_at).toBe(at('2026-02-20T09:00'))
  })
})

describe('Skip until: batches, undo and checks', () => {
  useFixedDay()

  test('SKU-008: a queued repeating task leaves the queue; undo puts it back', () => {
    const t = make({ rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0', due_at: at('2026-01-16T09:00') })
    set(t.id, { queue_mark: 1, try_tomorrow: 1, queued_at: at('2026-01-15T06:30') })
    skipUntil({ ...u, taskIds: [t.id], until: '2026-01-20' })
    expect(task(t.id).queue_mark).toBe(false)
    expect(task(t.id).try_tomorrow).toBe(false)
    expect(task(t.id).queued_at).toBeNull()
    executeUndo(TEST_USER_ID)
    expect(task(t.id).queue_mark).toBe(true)
    expect(task(t.id).try_tomorrow).toBe(true)
    expect(task(t.id).queued_at).toBe(at('2026-01-15T06:30'))
  })

  test('SKU-009: a mixed batch is counted, never refused', () => {
    const repeating = make({
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      due_at: at('2026-01-16T09:00'),
    })
    const oneOff = make({ due_at: at('2026-01-16T09:00') })
    const reminder = make({ is_reminder: true, rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0' })
    const quota = make({ rrule: 'FREQ=WEEKLY', is_tracked: true, progress_target: 3 })
    const trashed = make({
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      due_at: at('2026-01-16T09:00'),
    })
    deleteTask({ userId: TEST_USER_ID, taskId: trashed.id })
    const clear = make({
      rrule: 'FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0',
      due_at: at('2026-02-01T09:00'),
    })

    const r = skipUntil({
      ...u,
      taskIds: [repeating.id, oneOff.id, reminder.id, quota.id, trashed.id, clear.id, repeating.id],
      until: '2026-01-20',
    })
    expect(r.tasksAffected).toBe(1)
    expect(r.occurrencesSkipped).toBe(4)
    expect(r.skippedNotRepeating).toBe(1)
    expect(r.skippedReminders).toBe(1)
    expect(r.skippedQuotas).toBe(1)
    expect(r.skippedInactive).toBe(1)
    // Feb 1 is already after Jan 20: nothing before the date to skip.
    expect(r.alreadyClear).toBe(1)
    expect(task(clear.id).occurrence_at).toBe(at('2026-02-01T09:00'))
    expect(task(clear.id).skip_count ?? 0).toBe(0)
    expect(task(oneOff.id).archived_at).toBeNull()
    expect(r.summary).toBe(
      'Skipped 4 occurrences of "Task" · next Tue, Jan 20 · 1 not repeating · 1 already on or after Tue, Jan 20 · 1 reminder · 1 quota · 1 done or in the trash',
    )
  })

  test('SKU-010: one undo entry for the batch; undo and redo move every task', () => {
    const a = make({
      title: 'A',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      due_at: at('2026-01-16T09:00'),
    })
    const b = make({
      title: 'B',
      rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0',
      due_at: at('2026-01-19T09:00'),
    })
    const before = undoEntries().length
    const r = skipUntil({ ...u, taskIds: [a.id, b.id], until: '2026-02-03' })
    expect(r.summary).toBe('Skipped 2 tasks until Tue, Feb 3 (21 occurrences)')
    const entries = undoEntries()
    expect(entries.length).toBe(before + 1)
    expect(entries.at(-1)!.action).toBe('bulk_skip')
    expect(JSON.parse(entries.at(-1)!.snapshot)).toHaveLength(2)

    executeUndo(TEST_USER_ID)
    expect(task(a.id).occurrence_at).toBe(at('2026-01-16T09:00'))
    expect(task(a.id).skip_count ?? 0).toBe(0)
    expect(task(b.id).due_at).toBe(at('2026-01-19T09:00'))

    executeRedo(TEST_USER_ID)
    expect(task(a.id).occurrence_at).toBe(at('2026-02-03T09:00'))
    expect(task(a.id).skip_count).toBe(18)
    expect(task(b.id).occurrence_at).toBe(at('2026-02-09T09:00'))
    expect(task(b.id).skip_count).toBe(3)
  })

  test('SKU-011: across the DST change the occurrence keeps its local time', () => {
    vi.setSystemTime(new Date('2026-03-04T16:00:00Z'))
    const t = make({ rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0', due_at: at('2026-03-06T09:00') })
    skipUntil({ ...u, taskIds: [t.id], until: '2026-03-10' })
    // CST (UTC-6) before Mar 8, CDT (UTC-5) after.
    expect(task(t.id).occurrence_at).toBe('2026-03-10T14:00:00.000Z')
    expect(task(t.id).skip_count).toBe(4)

    const f = make({
      rrule: 'FREQ=WEEKLY;INTERVAL=2;BYHOUR=7;BYMINUTE=30',
      recurrence_mode: 'from_completion',
      due_at: at('2026-03-05T07:30'),
    })
    // Resolution 7 never lands earlier than the plain skip — the no-date skip's
    // own landing, computed the same way (for from_completion: two weeks from now,
    // Mar 18 at 7:30 CDT). Mar 12 is earlier, so it lands on Mar 18.
    const plain = nextOccurrenceAfterSkip(task(f.id), tz, new Date(), CALENDAR_DAY_START)
    expect(plain).toBe('2026-03-18T12:30:00.000Z')
    skipUntil({ ...u, taskIds: [f.id], until: '2026-03-12' })
    expect(task(f.id).occurrence_at).toBe(plain)
    expect(task(f.id).skip_count).toBe(1)
  })

  test('SKU-012: the date is checked in the user timezone; a foreign id refuses the batch', () => {
    const t = make({ rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0', due_at: at('2026-01-16T09:00') })
    expect(() => skipUntil({ ...u, taskIds: [t.id], until: '2026-01-14' })).toThrow(ValidationError)
    expect(() => skipUntil({ ...u, taskIds: [t.id], until: '2026-02-30' })).toThrow(ValidationError)
    expect(() => skipUntil({ ...u, taskIds: [t.id], until: '2037-01-01' })).toThrow(ValidationError)
    expect(() => skipUntil({ ...u, taskIds: [t.id, 999999] })).toThrow(ValidationError)
    // Today is refused: "skip this occurrence" is the no-date call.
    expect(() => skipUntil({ ...u, taskIds: [t.id], until: '2026-01-15' })).toThrow(
      'until must be tomorrow or later',
    )
    expect(task(t.id).skip_count ?? 0).toBe(0)
  })

  test('SKU-013: nothing skipped writes nothing — no undo entry, no activity', () => {
    const oneOff = make({ due_at: at('2026-01-16T09:00') })
    const before = undoEntries().length
    const r = skipUntil({ ...u, taskIds: [oneOff.id], until: '2026-01-20' })
    expect(r.tasksAffected).toBe(0)
    expect(r.summary).toBe('Nothing skipped · 1 not repeating')
    expect(undoEntries().length).toBe(before)
  })

  test('SKU-014: one activity row per task, a skip with the count; attempts afresh', () => {
    const t = make({ rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0', due_at: at('2026-01-16T09:00') })
    set(t.id, { attempts: 3 })
    skipUntil({ ...u, taskIds: [t.id], until: '2026-01-18' })
    const rows = getDb()
      .prepare("SELECT action, metadata FROM activity_log WHERE task_id = ? AND action = 'skip'")
      .all(t.id) as { action: string; metadata: string }[]
    expect(rows).toHaveLength(1)
    expect(JSON.parse(rows[0].metadata)).toMatchObject({
      skip_until: '2026-01-18',
      occurrences_skipped: 2,
    })
    expect(task(t.id).attempts).toBe(0)
  })

  test('SKU-015: the plan is pure — a far date walks a daily rule without a write', () => {
    const t = make({ rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0', due_at: at('2026-01-16T09:00') })
    const plan = planSkipUntil(t, tz, '2026-04-15', new Date(), CALENDAR_DAY_START)
    expect(plan).toEqual({
      kind: 'skip',
      landing: at('2026-04-15T09:00'),
      skipped: 89,
      keepDeck: false,
      ended: false,
    })
    expect(task(t.id).skip_count ?? 0).toBe(0)
  })
})

describe('Skip until: targets, far dates and rule times', () => {
  useFixedDay()

  test('SKU-016: an occurrence past the date with a target before it — the target goes to the occurrence', () => {
    const t = make({
      rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0',
      due_at: at('2026-01-19T09:00'),
    })
    // The target pulled earlier, to tomorrow; the occurrence stays Mon Jan 19.
    set(t.id, { due_at: at('2026-01-16T09:00'), queue_mark: 1, attempts: 2 })
    const r = skipUntil({ ...u, taskIds: [t.id], until: '2026-01-18' })
    expect(r.tasksAffected).toBe(1)
    expect(r.targetsMoved).toBe(1)
    expect(r.occurrencesSkipped).toBe(0)
    expect(r.alreadyClear).toBe(0)
    expect(r.summary).toBe('Moved "Task" to its occurrence · Mon, Jan 19')
    const after = task(t.id)
    expect(after.due_at).toBe(at('2026-01-19T09:00'))
    expect(after.occurrence_at).toBe(at('2026-01-19T09:00'))
    // A move, not a new occurrence: no skip, attempts kept; the queue mark goes.
    expect(after.skip_count ?? 0).toBe(0)
    expect(after.attempts).toBe(2)
    expect(after.queue_mark).toBe(false)

    const entries = undoEntries()
    expect(entries.at(-1)!.action).toBe('bulk_skip')
    // The undo / History words match the toast.
    const { description } = getDb()
      .prepare('SELECT description FROM undo_log WHERE user_id = ? ORDER BY id DESC LIMIT 1')
      .get(TEST_USER_ID) as { description: string }
    expect(description).toBe('Moved "Task" to its occurrence')
    executeUndo(TEST_USER_ID)
    expect(task(t.id).due_at).toBe(at('2026-01-16T09:00'))
    expect(task(t.id).queue_mark).toBe(true)
  })

  test('SKU-016b: a deadline-anchored target already on its derived day — a re-run writes nothing', () => {
    // Deadline Mon Jan 19 17:00, target derived Sat Jan 17 09:00: nothing before Sat.
    const t = make({
      rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=17;BYMINUTE=0',
      deadline_at: at('2026-01-19T17:00'),
      target_days_before: 2,
      target_time: '09:00',
    })
    const before = undoEntries().length
    const r = skipUntil({ ...u, taskIds: [t.id], until: '2026-01-17' })
    expect(r.tasksAffected).toBe(0)
    expect(r.alreadyClear).toBe(1)
    // Moved before the date: it goes back to its derived target, no skip.
    set(t.id, { due_at: at('2026-01-16T12:00') })
    const moved = skipUntil({ ...u, taskIds: [t.id], until: '2026-01-17' })
    expect(moved.targetsMoved).toBe(1)
    expect(task(t.id).due_at).toBe(at('2026-01-17T09:00'))
    expect(task(t.id).occurrence_at).toBe(at('2026-01-19T17:00'))
    expect(undoEntries().length).toBe(before + 1)
  })

  test('SKU-017: a multi-BYHOUR daily rule two years out, counted in one pass', () => {
    const t = make({ rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0', due_at: at('2026-01-16T09:00') })
    // Stored straight: validation never makes one, but an old row or the API could hold it.
    // The engine reads a rule's first BYHOUR as its time of day, so it is one a day at 9:00.
    set(t.id, { rrule: 'FREQ=DAILY;BYHOUR=9,13,17;BYMINUTE=0', anchor_time: '09:00' })
    const started = performance.now()
    const plan = planSkipUntil(task(t.id), tz, '2028-01-16', new Date(), CALENDAR_DAY_START)
    expect(performance.now() - started).toBeLessThan(1000)
    // Jan 16 2026 up to Jan 15 2028: 730 days.
    expect(plan).toEqual({
      kind: 'skip',
      landing: at('2028-01-16T09:00'),
      skipped: 730,
      keepDeck: false,
      ended: false,
    })
  })

  test('SKU-018: past the guard is a 400 (ValidationError), never a 500', () => {
    const daily = make({ rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0', due_at: at('2026-01-16T09:00') })
    const fromDone = make({
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      recurrence_mode: 'from_completion',
      due_at: at('2026-01-16T09:00'),
    })
    // Pure plans, so the 10-year limit on `until` is not in the way: ~14 years of days.
    expect(() =>
      planSkipUntil(task(daily.id), tz, '2040-01-01', new Date(), CALENDAR_DAY_START),
    ).toThrow(ValidationError)
    expect(() =>
      planSkipUntil(task(fromDone.id), tz, '2040-01-01', new Date(), CALENDAR_DAY_START),
    ).toThrow(ValidationError)
  })

  test('SKU-019: from_completion with no time in the rule lands at the time the next Done keeps', () => {
    const t = make({
      rrule: 'FREQ=DAILY;INTERVAL=3;BYHOUR=9;BYMINUTE=0',
      recurrence_mode: 'from_completion',
      due_at: at('2026-01-16T09:00'),
    })
    // An old row: no BYHOUR, no anchor_time. computeFromCompletion's fallback is midnight.
    set(t.id, { rrule: 'FREQ=DAILY;INTERVAL=3', anchor_time: null })
    skipUntil({ ...u, taskIds: [t.id], until: '2026-01-26' })
    expect(task(t.id).occurrence_at).toBe(at('2026-01-26T00:00'))
    vi.setSystemTime(new Date(at('2026-01-26T10:00')))
    markDone({ ...u, taskId: t.id })
    expect(task(t.id).due_at).toBe(at('2026-01-29T00:00'))
  })
})

describe('Skip until: on deck and ordinal rules', () => {
  useFixedDay()
  // On deck lives behind the task queue.
  beforeEach(() => vi.stubEnv('OPENTASK_TASK_QUEUE', '1'))
  afterEach(() => vi.unstubAllEnvs())

  const DAILY_9 = 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0'

  /** A daily at 09:00 whose occurrence is tomorrow, decked for `day` (today by default). */
  function deckedDaily(day = '2026-01-15'): Task {
    const t = make({ rrule: DAILY_9, due_at: at('2026-01-16T09:00') })
    const r = deckTasks({ userId: TEST_USER_ID, timezone: tz, ids: [t.id], day })
    expect(r.refused).toEqual([])
    const decked = task(t.id)
    // A decked repeating task: no target, its occurrence kept.
    expect(decked.on_deck_day).toBe(day)
    expect(decked.due_at).toBeNull()
    expect(decked.occurrence_at).toBe(at('2026-01-16T09:00'))
    return decked
  }

  test('SKU-020: a deck the day before the date goes; the target lands on the occurrence; undo restores the deck', () => {
    const t = deckedDaily('2026-01-19')
    const r = skipUntil({ ...u, taskIds: [t.id], until: '2026-01-20' })
    const after = task(t.id)
    expect(after.on_deck_day).toBeNull()
    // Counted from the kept occurrence, never from the null target: Jan 16–19.
    expect(after.occurrence_at).toBe(at('2026-01-20T09:00'))
    expect(after.due_at).toBe(at('2026-01-20T09:00'))
    expect(after.skip_count).toBe(4)
    expect(r.occurrencesSkipped).toBe(4)
    const entry = undoEntries().at(-1)!
    expect(entry.action).toBe('bulk_skip')
    expect(entry.snapshot).toContain('on_deck_day')

    executeUndo(TEST_USER_ID)
    const undone = task(t.id)
    expect(undone.on_deck_day).toBe('2026-01-19')
    expect(undone.due_at).toBeNull()
    expect(undone.occurrence_at).toBe(at('2026-01-16T09:00'))
  })

  test('SKU-021: skip this occurrence (no date) on a decked task clears the deck and lands a target', () => {
    const t = deckedDaily()
    skipUntil({ ...u, taskIds: [t.id], until: null })
    const after = task(t.id)
    expect(after.on_deck_day).toBeNull()
    expect(after.occurrence_at).toBe(at('2026-01-17T09:00'))
    expect(after.due_at).toBe(at('2026-01-17T09:00'))
    expect(after.skip_count).toBe(1)
  })

  test('SKU-022: plain skip-occurrence clears a deck too, and undo restores it', () => {
    const t = deckedDaily()
    skipOccurrence({ ...u, taskId: t.id })
    expect(task(t.id).on_deck_day).toBeNull()
    expect(task(t.id).due_at).toBe(at('2026-01-17T09:00'))
    executeUndo(TEST_USER_ID)
    expect(task(t.id).on_deck_day).toBe('2026-01-15')
    expect(task(t.id).due_at).toBeNull()
  })

  test('SKU-023: a deck before the date, occurrence already past it — the target comes back, no skip', () => {
    const weekly = make({
      rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0',
      due_at: at('2026-01-19T09:00'),
    })
    deckTasks({ userId: TEST_USER_ID, timezone: tz, ids: [weekly.id], day: '2026-01-15' })
    expect(task(weekly.id).due_at).toBeNull()
    expect(
      planSkipUntil(task(weekly.id), tz, '2026-01-17', new Date(), CALENDAR_DAY_START),
    ).toEqual({
      kind: 'retarget',
      landing: at('2026-01-19T09:00'),
    })
    const r = skipUntil({ ...u, taskIds: [weekly.id], until: '2026-01-17' })
    const after = task(weekly.id)
    // Never a repeating task with neither a target nor a deck.
    expect(after.on_deck_day).toBeNull()
    expect(after.due_at).toBe(at('2026-01-19T09:00'))
    expect(after.occurrence_at).toBe(at('2026-01-19T09:00'))
    expect(after.skip_count ?? 0).toBe(0)
    expect(r.targetsMoved).toBe(1)
    expect(r.alreadyClear).toBe(0)
    executeUndo(TEST_USER_ID)
    expect(task(weekly.id).on_deck_day).toBe('2026-01-15')
    expect(task(weekly.id).due_at).toBeNull()
  })

  test.each([
    ['on the date', '2026-01-20'],
    ['after the date', '2026-01-22'],
  ])('SKU-025: a deck %s is kept — still decked, the occurrence moved; undo', (_, day) => {
    const t = deckedDaily(day)
    const r = skipUntil({ ...u, taskIds: [t.id], until: '2026-01-20' })
    const after = task(t.id)
    // The deck stays and now refers to the landing occurrence; no target.
    expect(after.on_deck_day).toBe(day)
    expect(after.due_at).toBeNull()
    // The same landing and count as an undecked skip: Jan 16–19.
    expect(after.occurrence_at).toBe(at('2026-01-20T09:00'))
    expect(after.skip_count).toBe(4)
    expect(r.occurrencesSkipped).toBe(4)
    expect(r.tasksAffected).toBe(1)
    const entry = undoEntries().at(-1)!
    expect(entry.action).toBe('bulk_skip')
    // The deck is not part of the write: the snapshot leaves it alone.
    expect(JSON.parse(entry.snapshot)[0].after_state).not.toHaveProperty('on_deck_day')
    expect(JSON.parse(entry.snapshot)[0].after_state.due_at).toBeNull()

    executeUndo(TEST_USER_ID)
    const undone = task(t.id)
    expect(undone.on_deck_day).toBe(day)
    expect(undone.due_at).toBeNull()
    expect(undone.occurrence_at).toBe(at('2026-01-16T09:00'))
    expect(undone.skip_count ?? 0).toBe(0)

    executeRedo(TEST_USER_ID)
    expect(task(t.id).occurrence_at).toBe(at('2026-01-20T09:00'))
    expect(task(t.id).on_deck_day).toBe(day)
  })

  test('SKU-026: a deck on or after the date with the occurrence already past it is already clear', () => {
    const weekly = make({
      rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0',
      due_at: at('2026-01-19T09:00'),
    })
    deckTasks({ userId: TEST_USER_ID, timezone: tz, ids: [weekly.id], day: '2026-01-17' })
    const before = undoEntries().length
    const r = skipUntil({ ...u, taskIds: [weekly.id], until: '2026-01-17' })
    expect(r.alreadyClear).toBe(1)
    expect(r.tasksAffected).toBe(0)
    expect(task(weekly.id).on_deck_day).toBe('2026-01-17')
    expect(task(weekly.id).due_at).toBeNull()
    expect(undoEntries().length).toBe(before)
  })

  test('SKU-028: a kept deck with no occurrence on the row (an old row) lands on the walk', () => {
    const t = deckedDaily('2026-01-22')
    set(t.id, { occurrence_at: null })
    const r = skipUntil({ ...u, taskIds: [t.id], until: '2026-01-20' })
    const after = task(t.id)
    // Walked from now (Jan 15 10:00), the occurrence set to the landing one.
    expect(after.occurrence_at).toBe(at('2026-01-20T09:00'))
    expect(after.on_deck_day).toBe('2026-01-22')
    expect(after.due_at).toBeNull()
    // With no occurrence on the row, the walk still counts one for "the current
    // occurrence" (as every skip does), then Jan 16–19 before the date.
    expect(r.occurrencesSkipped).toBe(5)
    executeUndo(TEST_USER_ID)
    expect(task(t.id).occurrence_at).toBeNull()
    expect(task(t.id).on_deck_day).toBe('2026-01-22')
  })

  test('SKU-027: skip this occurrence (no date) clears even a later deck', () => {
    const t = deckedDaily('2026-01-22')
    skipUntil({ ...u, taskIds: [t.id], until: null })
    expect(task(t.id).on_deck_day).toBeNull()
    expect(task(t.id).due_at).toBe(at('2026-01-17T09:00'))
    executeUndo(TEST_USER_ID)
    expect(task(t.id).on_deck_day).toBe('2026-01-22')
  })

  test('SKU-024: monthly on the 1st Saturday lands on the right 1st Saturday', () => {
    const t = make({
      rrule: 'FREQ=MONTHLY;BYDAY=1SA;BYHOUR=9;BYMINUTE=0',
      due_at: at('2026-02-07T09:00'),
    })
    skipUntil({ ...u, taskIds: [t.id], until: '2026-03-15' })
    const after = task(t.id)
    // Feb 7 and Mar 7 skipped; the 1st Saturday of April is the 4th
    // (every Saturday — the old bug — would land Mar 21).
    expect(after.occurrence_at).toBe(at('2026-04-04T09:00'))
    expect(after.due_at).toBe(at('2026-04-04T09:00'))
    expect(after.skip_count).toBe(2)
  })
})
