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
import { skipOccurrence } from '@/core/tasks/skip'
import { skipUntil, planSkipUntil } from '@/core/tasks/skip-until'
import { executeUndo, executeRedo } from '@/core/undo'
import { ValidationError } from '@/core/errors'
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

  test('SKU-007: the deadline moves with the occurrence, and caps the target', () => {
    const t = make({
      rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0',
      due_at: at('2026-01-19T09:00'),
    })
    // A deadline two days after the occurrence: it moves to two days after the landing.
    set(t.id, { deadline_at: at('2026-01-21T17:00') })
    skipUntil({ ...u, taskIds: [t.id], until: '2026-02-03' })
    expect(task(t.id).deadline_at).toBe(at('2026-02-11T17:00'))

    // A deadline the evening BEFORE the occurrence: the target stops at it.
    const c = make({
      rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0',
      due_at: at('2026-01-19T09:00'),
    })
    set(c.id, { deadline_at: at('2026-01-18T20:00') })
    skipUntil({ ...u, taskIds: [c.id], until: '2026-02-03' })
    expect(task(c.id).occurrence_at).toBe(at('2026-02-09T09:00'))
    expect(task(c.id).deadline_at).toBe(at('2026-02-08T20:00'))
    expect(task(c.id).due_at).toBe(at('2026-02-08T20:00'))
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
    skipUntil({ ...u, taskIds: [f.id], until: '2026-03-12' })
    expect(task(f.id).occurrence_at).toBe('2026-03-12T12:30:00.000Z')
  })

  test('SKU-012: the date is checked in the user timezone; a foreign id refuses the batch', () => {
    const t = make({ rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0', due_at: at('2026-01-16T09:00') })
    expect(() => skipUntil({ ...u, taskIds: [t.id], until: '2026-01-14' })).toThrow(ValidationError)
    expect(() => skipUntil({ ...u, taskIds: [t.id], until: '2026-02-30' })).toThrow(ValidationError)
    expect(() => skipUntil({ ...u, taskIds: [t.id], until: '2037-01-01' })).toThrow(ValidationError)
    expect(() => skipUntil({ ...u, taskIds: [t.id, 999999] })).toThrow(ValidationError)
    // Today is allowed: the occurrence (tomorrow) is already after it.
    expect(skipUntil({ ...u, taskIds: [t.id], until: '2026-01-15' }).alreadyClear).toBe(1)
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
      until: '2026-01-18',
      occurrences_skipped: 2,
    })
    expect(task(t.id).attempts).toBe(0)
  })

  test('SKU-015: the plan is pure — a far date walks a daily rule without a write', () => {
    const t = make({ rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0', due_at: at('2026-01-16T09:00') })
    const plan = planSkipUntil(t, tz, '2026-04-15', '09:00', new Date())
    expect(plan).toEqual({ kind: 'skip', landing: at('2026-04-15T09:00'), skipped: 89 })
    expect(task(t.id).skip_count ?? 0).toBe(0)
  })
})
