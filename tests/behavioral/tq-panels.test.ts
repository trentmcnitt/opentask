/**
 * Task queue PR 3: the queue's two panels on the reminders screen
 * (src/core/tasks/task-segments.ts, `queueKind` in src/lib/task-segments.ts;
 * docs/TASK-MODEL.md § The task queue). With OPENTASK_TASK_QUEUE on, a queued
 * task shows in "Stripped today" (`queue_today`, queued by this OpenTask
 * day's rollover) or "Previously targeted" (`queue_previous`), and in no
 * horizon segment and not in Upcoming. Consider takes a stripped one-off out
 * of the queue; a waiting repeating task stays.
 *
 * The user: periods 06:30 / 12:00 / 20:30 (rollover 06:30), America/Chicago.
 * "Today" is Tue 2026-10-20; every test sets `last_rollover_date` itself.
 */

import { describe, test, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { DateTime } from 'luxon'

vi.mock('@/core/notifications/dismiss', () => ({
  dismissNotificationsForTasks: vi.fn(),
  syncBadgeCount: vi.fn(),
}))
vi.mock('@/core/webhooks/dispatch', () => ({ dispatchWebhookEvent: vi.fn() }))
vi.mock('@/lib/sync-events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/sync-events')>()
  return { ...actual, emitSyncEvent: vi.fn() }
})

import { getDb } from '@/core/db'
import { createTask, updateTask } from '@/core/tasks'
import { getTaskById } from '@/core/tasks/read'
import { considerTasks, getTaskSegments, targetTasksToday } from '@/core/tasks/task-segments'
import { runTaskRollover } from '@/core/tasks/task-rollover'
import { executeUndo } from '@/core/undo'
import { SEGMENT_ORDER, compareQueueRows, queueKind } from '@/lib/task-segments'
import type { Task } from '@/types'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

const tz = TEST_TIMEZONE
const u = { userId: TEST_USER_ID, userTimezone: tz }

function at(local: string): string {
  return DateTime.fromISO(local, { zone: tz }).toUTC().toISO()!
}
function setClock(local: string) {
  vi.setSystemTime(new Date(at(local)))
}
function makeAt(madeAt: string, input: Record<string, unknown>): Task {
  setClock(madeAt)
  return createTask({ ...u, input: { title: 'Task', ...input } })
}
function task(id: number): Task {
  return getTaskById(id)!
}
function roll(local: string) {
  setClock(local)
  return runTaskRollover({ now: new Date(at(local)), userId: TEST_USER_ID })
}

/** Where each of `ids` sits today: segment kind and state, or absent. */
function placement(local: string, ids: number[]): Record<number, string> {
  setClock(local)
  const out: Record<number, string> = {}
  for (const seg of getTaskSegments(TEST_USER_ID, tz, new Date(at(local)), { queuePanels: true })) {
    for (const row of seg.tasks) {
      if (!ids.includes(row.task.id)) continue
      expect(out[row.task.id]).toBeUndefined() // one panel at most (rule 7)
      out[row.task.id] = `${seg.horizon}:${row.state}`
    }
  }
  return out
}

function kinds(local: string): string[] {
  setClock(local)
  return getTaskSegments(TEST_USER_ID, tz, new Date(at(local)), { queuePanels: true }).map(
    (s) => s.horizon,
  )
}

function setup() {
  setupTestDb()
  const db = getDb()
  const insert = db.prepare(
    'INSERT INTO time_slots (user_id, label, start_time, sort_order) VALUES (?, ?, ?, ?)',
  )
  ;['06:30', '12:00', '20:30'].forEach((s, i) => insert.run(TEST_USER_ID, `Period ${i}`, s, i))
  // The day starts at 06:30, pinned (2026-10-24): this file's timelines were
  // written against a 06:30 rollover (once the first period's start); the
  // unset default is now 3:00 AM.
  db.prepare("UPDATE users SET day_start_time = '06:30', morning_time = '08:30' WHERE id = ?").run(
    TEST_USER_ID,
  )
  vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
  setClock('2026-10-20T06:00')
  db.prepare("UPDATE users SET last_rollover_date = '2026-10-19' WHERE id = ?").run(TEST_USER_ID)
}

/** A one-off made on Mon 10-19 (Days horizon), targeted Mon 16:00, stripped Tue 06:30. */
function strippedOneOff(title = 'Call the bank', extra: Record<string, unknown> = {}): Task {
  return makeAt('2026-10-19T09:00', {
    title,
    horizon: 'days',
    due_at: at('2026-10-19T16:00'),
    ...extra,
  })
}

/** A weekly Monday task that missed Mon 10-19 08:00: the Tue rollover sends it to wait. */
function waitingWeekly(): Task {
  return makeAt('2026-10-19T07:00', {
    title: 'Water the plants',
    rrule: 'FREQ=WEEKLY;BYDAY=MO',
    due_at: at('2026-10-19T08:00'),
  })
}

describe('TQ-P: the task queue panels', () => {
  beforeEach(setup)
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })
  afterAll(() => teardownTestDb())

  test('TQ-P01: the queue panels come first in the segment order', () => {
    // After the deadlines page (2026-10-22, APPROVED: first in the carousel,
    // the only queue page that nags).
    expect(SEGMENT_ORDER.slice(0, 4)).toEqual([
      'deadlines',
      'queue_today',
      'queue_previous',
      'days',
    ])
  })

  test('TQ-P02: precedence — a stripped one-off is in the queue, not its horizon segment', () => {
    const t = strippedOneOff()
    // Before the rollover it is over target: in no segment at all.
    expect(placement('2026-10-20T06:10', [t.id])).toEqual({})
    roll('2026-10-20T06:30')
    expect(task(t.id).due_at).toBeNull()
    expect(placement('2026-10-20T07:00', [t.id])).toEqual({ [t.id]: 'queue_today:waiting' })
    expect(kinds('2026-10-20T07:00')).not.toContain('days')
  })

  test('TQ-P03: precedence over Upcoming — a waiting weekly task on its heads-up day', () => {
    const w = waitingWeekly()
    roll('2026-10-20T06:30')
    expect(task(w.id).due_at).toBe(at('2026-10-26T08:00'))
    // Sun 10-25 is the day before its next occurrence: Upcoming's heads-up day.
    expect(placement('2026-10-25T09:00', [w.id])).toEqual({ [w.id]: 'queue_previous:waiting' })
    // Switch off: Upcoming, as before the queue.
    vi.stubEnv('OPENTASK_TASK_QUEUE', '')
    expect(placement('2026-10-25T09:00', [w.id])).toEqual({ [w.id]: 'upcoming:waiting' })
  })

  test('TQ-P04: the split across three days, and resolution 6', () => {
    const a = strippedOneOff('Tuesday strip')
    const w = waitingWeekly()
    roll('2026-10-20T06:30')
    // Tue: both stripped today.
    expect(placement('2026-10-20T07:00', [a.id, w.id])).toEqual({
      [a.id]: 'queue_today:waiting',
      [w.id]: 'queue_today:waiting',
    })
    // The weekly one considered on Tue: still queued, ticked in its panel today.
    setClock('2026-10-20T07:05')
    considerTasks(TEST_USER_ID, [w.id])
    expect(task(w.id).queued_at).not.toBeNull()
    expect(placement('2026-10-20T07:10', [w.id])).toEqual({ [w.id]: 'queue_today:considered' })

    // Wed: before the rollover it is still Tuesday's OpenTask day.
    expect(placement('2026-10-21T06:10', [a.id])).toEqual({ [a.id]: 'queue_today:waiting' })
    const b = makeAt('2026-10-20T09:00', {
      title: 'Wednesday strip',
      due_at: at('2026-10-20T15:00'),
    })
    roll('2026-10-21T06:30')
    // Resolution 6: considered yesterday, the weekly task is "previously
    // targeted" today, waiting again; Tuesday's strip moved there too.
    expect(placement('2026-10-21T07:00', [a.id, b.id, w.id])).toEqual({
      [a.id]: 'queue_previous:waiting',
      [b.id]: 'queue_today:waiting',
      [w.id]: 'queue_previous:waiting',
    })

    // Thu: nothing new; the queue drops nothing.
    roll('2026-10-22T06:30')
    expect(placement('2026-10-22T07:00', [a.id, b.id, w.id])).toEqual({
      [a.id]: 'queue_previous:waiting',
      [b.id]: 'queue_previous:waiting',
      [w.id]: 'queue_previous:waiting',
    })
  })

  test('TQ-P05: consider on a stripped one-off — out of the queue, ticked in its horizon; undo', () => {
    const t = strippedOneOff()
    getDb().prepare('UPDATE tasks SET try_tomorrow = 1 WHERE id = ?').run(t.id)
    roll('2026-10-20T06:30')
    const queuedAt = task(t.id).queued_at
    expect(task(t.id).try_tomorrow).toBe(true)

    setClock('2026-10-20T07:00')
    considerTasks(TEST_USER_ID, [t.id])
    const after = task(t.id)
    expect(after.queued_at).toBeNull()
    expect(after.try_tomorrow).toBe(false)
    expect(after.queued_from_due_at).toBe(at('2026-10-19T16:00'))
    // Shared considered state (rule 7): ticked in its horizon segment today …
    expect(placement('2026-10-20T07:01', [t.id])).toEqual({ [t.id]: 'days:considered' })
    // … and tomorrow it is back on the Days rhythm, not in the queue.
    expect(placement('2026-10-21T09:00', [t.id])).toEqual({ [t.id]: 'days:waiting' })

    // Undo puts it back in the queue.
    setClock('2026-10-20T07:02')
    executeUndo(TEST_USER_ID)
    expect(task(t.id).queued_at).toBe(queuedAt)
    expect(task(t.id).try_tomorrow).toBe(true)
    expect(task(t.id).last_considered_at).toBeNull()
    expect(placement('2026-10-20T07:03', [t.id])).toEqual({ [t.id]: 'queue_today:waiting' })
  })

  test('TQ-P06: consider on a waiting repeating task — it stays queued; undo', () => {
    const w = waitingWeekly()
    roll('2026-10-20T06:30')
    setClock('2026-10-20T07:00')
    considerTasks(TEST_USER_ID, [w.id])
    expect(task(w.id).queued_at).not.toBeNull()
    expect(placement('2026-10-20T07:01', [w.id])).toEqual({ [w.id]: 'queue_today:considered' })
    setClock('2026-10-20T07:02')
    executeUndo(TEST_USER_ID)
    expect(task(w.id).last_considered_at).toBeNull()
    expect(placement('2026-10-20T07:03', [w.id])).toEqual({ [w.id]: 'queue_today:waiting' })
  })

  test('TQ-P07: Consider all — one call, one undo entry', () => {
    const a = strippedOneOff('One')
    const w = waitingWeekly()
    roll('2026-10-20T06:30')
    setClock('2026-10-20T07:00')
    expect(considerTasks(TEST_USER_ID, [a.id, w.id])).toBe(2)
    expect(task(a.id).queued_at).toBeNull()
    expect(task(w.id).queued_at).not.toBeNull()
    setClock('2026-10-20T07:01')
    executeUndo(TEST_USER_ID)
    expect(task(a.id).queued_at).not.toBeNull()
    expect(task(a.id).last_considered_at).toBeNull()
    expect(task(w.id).last_considered_at).toBeNull()
  })
})

describe('TQ-P: the queue panels — retargets, order, the switch', () => {
  beforeEach(setup)
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })
  afterAll(() => teardownTestDb())

  test('TQ-P08: Today from the queue — out of the queue, then a new attempt', () => {
    const t = strippedOneOff()
    // Over target on Mon: one attempt, kept through the strip (B7).
    roll('2026-10-20T06:30')
    expect(task(t.id).attempts).toBe(1)

    setClock('2026-10-20T09:00')
    const { until } = targetTasksToday(TEST_USER_ID, tz, [t.id])
    const after = task(t.id)
    expect(after.due_at).toBe(until)
    expect(after.queued_at).toBeNull()
    expect(placement('2026-10-20T09:01', [t.id])).toEqual({})
    // Its target arrives today: a new attempt, on top of Monday's.
    setClock('2026-10-20T23:00')
    expect(task(t.id).attempts).toBe(2)
  })

  test('TQ-P09: a retarget from details (PATCH) takes it out of the queue', () => {
    const t = strippedOneOff()
    roll('2026-10-20T06:30')
    setClock('2026-10-20T08:00')
    updateTask({ ...u, taskId: t.id, input: { due_at: at('2026-10-23T09:00') } })
    expect(task(t.id).queued_at).toBeNull()
    expect(placement('2026-10-20T08:01', [t.id])).toEqual({})
    // A priority-only edit leaves it in the queue.
    const s = strippedOneOff('Another')
    getDb()
      .prepare('UPDATE tasks SET due_at = NULL, queued_at = ? WHERE id = ?')
      .run(at('2026-10-20T06:30'), s.id)
    setClock('2026-10-20T08:02')
    updateTask({ ...u, taskId: s.id, input: { priority: 2 } })
    expect(task(s.id).queued_at).not.toBeNull()
  })

  test('TQ-P10: sorted by priority, then the older remembered target, then id', () => {
    const low = makeAt('2026-10-19T09:00', {
      title: 'Low',
      priority: 1,
      due_at: at('2026-10-17T09:00'),
    })
    const medNew = makeAt('2026-10-19T09:00', {
      title: 'Med new',
      priority: 2,
      due_at: at('2026-10-19T09:00'),
    })
    const medOld = makeAt('2026-10-19T09:00', {
      title: 'Med old',
      priority: 2,
      due_at: at('2026-10-18T09:00'),
    })
    const none = makeAt('2026-10-19T09:00', {
      title: 'None',
      priority: 0,
      due_at: at('2026-10-16T09:00'),
    })
    roll('2026-10-20T06:30')
    setClock('2026-10-20T07:00')
    const panel = getTaskSegments(TEST_USER_ID, tz, new Date(at('2026-10-20T07:00')), {
      queuePanels: true,
    }).find((s) => s.horizon === 'queue_today')!
    expect(panel.tasks.map((r) => r.task.id)).toEqual([medOld.id, medNew.id, low.id, none.id])
    // A row with no remembered target sorts after one with, at equal priority.
    const base = { priority: 2 }
    expect(
      compareQueueRows(
        { ...base, id: 1, queued_from_due_at: null },
        { ...base, id: 2, queued_from_due_at: at('2026-10-01T09:00') },
      ),
    ).toBeGreaterThan(0)
  })

  test('TQ-P11: a queued task whose target has arrived is not in the queue', () => {
    const now = new Date(at('2026-10-20T09:00'))
    const m = new Date(at('2026-10-20T06:30'))
    expect(queueKind({ queued_at: at('2026-10-20T06:30'), due_at: null }, now, m)).toBe(
      'queue_today',
    )
    expect(queueKind({ queued_at: at('2026-10-19T06:30'), due_at: null }, now, m)).toBe(
      'queue_previous',
    )
    expect(
      queueKind({ queued_at: at('2026-10-20T06:30'), due_at: at('2026-10-20T08:00') }, now, m),
    ).toBeNull()
    expect(queueKind({ queued_at: null, due_at: null }, now, m)).toBeNull()
  })

  test('TQ-P12: switch off — no queue kinds; a stripped task is back in its horizon segment', () => {
    const t = strippedOneOff()
    roll('2026-10-20T06:30')
    vi.stubEnv('OPENTASK_TASK_QUEUE', '')
    const ks = kinds('2026-10-20T07:00')
    expect(ks).not.toContain('queue_today')
    expect(ks).not.toContain('queue_previous')
    expect(placement('2026-10-20T07:00', [t.id])).toEqual({ [t.id]: 'days:waiting' })
  })

  test('TQ-P14: without the opt-in, queued tasks are in no segment (old native builds)', () => {
    const t = strippedOneOff()
    const w = waitingWeekly()
    const plain = makeAt('2026-10-19T09:00', { title: 'Plain', horizon: 'days' })
    roll('2026-10-20T06:30')
    setClock('2026-10-20T07:00')
    const segs = getTaskSegments(TEST_USER_ID, tz, new Date(at('2026-10-20T07:00')))
    expect(segs.map((s) => s.horizon)).toEqual(['days'])
    const ids = segs.flatMap((s) => s.tasks.map((r) => r.task.id))
    expect(ids).toContain(plain.id)
    expect(ids).not.toContain(t.id)
    expect(ids).not.toContain(w.id)
    // Not put back in their horizon segment or Upcoming either — on Sun 25,
    // Upcoming's heads-up day for the weekly task, it is still left out.
    setClock('2026-10-25T09:00')
    const sunday = getTaskSegments(TEST_USER_ID, tz, new Date(at('2026-10-25T09:00')))
    expect(sunday.flatMap((s) => s.tasks.map((r) => r.task.id))).not.toContain(w.id)
  })

  test("TQ-P15: a queue row's considered state lasts the OpenTask day, not the calendar day — and so does a horizon row's", () => {
    const w = waitingWeekly()
    roll('2026-10-20T06:30')
    // Considered at 23:30 Tue …
    setClock('2026-10-20T23:30')
    considerTasks(TEST_USER_ID, [w.id])
    // … still considered at 00:30 Wed, in the same "Stripped today" panel.
    expect(placement('2026-10-21T00:30', [w.id])).toEqual({ [w.id]: 'queue_today:considered' })
    // The rollover moves it to "Previously targeted", waiting again.
    roll('2026-10-21T06:30')
    expect(placement('2026-10-21T07:00', [w.id])).toEqual({ [w.id]: 'queue_previous:waiting' })
    // A horizon row reads the same OpenTask day since "Day starts at" PR 2
    // (2026-10-24; it stayed on midnight under resolution 4): considered at
    // 23:30, still considered at 00:30 in its Days segment, waiting again
    // once the day starts at 06:30.
    const d = makeAt('2026-10-19T09:00', { title: 'Days', horizon: 'days' })
    setClock('2026-10-21T23:30')
    considerTasks(TEST_USER_ID, [d.id])
    expect(placement('2026-10-22T00:30', [d.id])).toEqual({ [d.id]: 'days:considered' })
    expect(placement('2026-10-22T06:29', [d.id])).toEqual({ [d.id]: 'days:considered' })
    expect(placement('2026-10-22T06:30', [d.id])).toEqual({ [d.id]: 'days:waiting' })
  })

  test('TQ-P13: switch off — segments are exactly as before for unqueued tasks', () => {
    const plain = makeAt('2026-10-19T09:00', { title: 'Plain', horizon: 'days' })
    const on = placement('2026-10-20T07:00', [plain.id])
    vi.stubEnv('OPENTASK_TASK_QUEUE', '')
    expect(placement('2026-10-20T07:00', [plain.id])).toEqual(on)
    expect(on).toEqual({ [plain.id]: 'days:waiting' })
  })
})
