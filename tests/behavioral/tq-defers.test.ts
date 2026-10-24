/**
 * Task queue PR 1: picks and defers (docs/TASK-MODEL.md § The OpenTask day,
 * picks and defers). With OPENTASK_TASK_QUEUE on, a DEFER (Snooze-all in
 * any form, Try Tomorrow) of a below-High task with no deadline that lands
 * at or after the next rollover moves the target to that rollover and marks
 * the task for the queue; every other target write clears the mark.
 *
 * The user here: periods at 06:30 / 12:00 / 20:30 (so the rollover is 06:30)
 * and morning_time 08:30 — Trent's shape, where "tomorrow" (8:30) and the
 * rollover (6:30) differ, which is what proves the rollover helper is wired.
 */

import { CALENDAR_DAY_START } from '@/lib/opentask-day'
import { describe, test, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { DateTime } from 'luxon'
import { getDb } from '@/core/db'
import { createTask, updateTask, markDone, bulkSnooze, bulkEdit, bulkDone } from '@/core/tasks'
import { markUndone } from '@/core/tasks/mark-done'
import { skipOccurrence } from '@/core/tasks/skip'
import { snoozeTask } from '@/core/tasks/snooze'
import { getTaskById } from '@/core/tasks/read'
import { targetTasksToday } from '@/core/tasks/task-segments'
import { executeUndo, executeRedo } from '@/core/undo'
import { listTimeSlots } from '@/core/time-slots'
import { stampTargetSet } from '@/core/tasks/target-set'
import { computeSnoozeTime } from '@/lib/snooze'
import { nextPeriodStart, nextSlotStart } from '@/lib/time-slot-assign'
import type { BulkSnoozeSource } from '@/core/tasks/bulk'
import type { Task } from '@/types'
import {
  setupTestDb,
  teardownTestDb,
  madeBefore,
  TEST_TIMEZONE,
  TEST_USER_ID,
} from '../helpers/setup'

const tz = TEST_TIMEZONE
const u = { userId: TEST_USER_ID, userTimezone: tz }

/** A Chicago wall-clock time as the UTC ISO string the DB stores. */
function at(local: string): string {
  return DateTime.fromISO(local, { zone: tz }).toUTC().toISO()!
}

function setClock(local: string) {
  vi.setSystemTime(new Date(at(local)))
}

function make(input: Record<string, unknown> = {}): Task {
  return createTask({ ...u, input: { title: 'Task', ...input } })
}

/** A repeating task whose date has passed (made while it was still ahead). */
function makeRepeating(rrule: string, dueAt: string, input: Record<string, unknown> = {}): Task {
  return madeBefore(dueAt, () => make({ rrule, due_at: dueAt, ...input }))
}

function task(id: number): Task {
  return getTaskById(id)!
}

/** A bulk snooze — a sweep unless told otherwise ('pick' = no `source`). */
function sweep(
  ids: number[],
  move: { until?: string; deltaMinutes?: number },
  source: BulkSnoozeSource | 'pick' = 'sweep',
) {
  return bulkSnooze({ ...u, taskIds: ids, ...move, source: source === 'pick' ? undefined : source })
}

/** The periods and morning time the whole file runs on. */
function seedPeriods(
  starts: string[] = ['06:30', '12:00', '20:30'],
  morning = '08:30',
  dayStart: string | null = '06:30',
) {
  const db = getDb()
  db.prepare('DELETE FROM time_slots WHERE user_id = ?').run(TEST_USER_ID)
  const insert = db.prepare(
    'INSERT INTO time_slots (user_id, label, start_time, sort_order) VALUES (?, ?, ?, ?)',
  )
  starts.forEach((s, i) => insert.run(TEST_USER_ID, `Period ${i}`, s, i))
  // The day starts at 06:30, pinned (2026-10-24): this file's timelines were
  // written against a 06:30 rollover (once the first period's start); the
  // unset default is now 3:00 AM.
  db.prepare('UPDATE users SET morning_time = ?, day_start_time = ? WHERE id = ?').run(
    morning,
    dayStart,
    TEST_USER_ID,
  )
}

beforeEach(() => {
  vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
  setClock('2026-10-20T21:00')
  setupTestDb()
  seedPeriods()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

afterAll(() => teardownTestDb())

describe('TQ-L: where a sweep lands, for every option', () => {
  test('TQ-L01: absolute until later today → moves as always, no mark', () => {
    const t = make({ due_at: at('2026-10-20T15:00') })
    const r = sweep([t.id], { until: at('2026-10-20T22:00') })
    expect(task(t.id).due_at).toBe(at('2026-10-20T22:00'))
    expect(task(t.id).queue_mark).toBe(false)
    expect(r.queued).toBe(0)
  })

  test('TQ-L02: until tomorrow 8:30 → target is the 6:30 ROLLOVER, not 8:30, and marked', () => {
    const t = make({ due_at: at('2026-10-20T15:00') })
    const r = sweep([t.id], { until: at('2026-10-21T08:30') })
    expect(task(t.id).due_at).toBe(at('2026-10-21T06:30'))
    expect(task(t.id).queue_mark).toBe(true)
    expect(task(t.id).try_tomorrow).toBe(false)
    expect(r.queued).toBe(1)
    expect(r.queuedName).toBe('Task')
    // The marked tasks' own target, for a client to word them by — not `until`.
    expect(r.queuedUntil).toBe(at('2026-10-21T06:30'))
    expect(r.summary).toBe('"Task" will move to the Tasks queue at 6:30 AM')
  })

  test('TQ-L03: until tomorrow 6:00, before the rollover → moves to 6:00, no mark', () => {
    const t = make({ due_at: at('2026-10-20T15:00') })
    sweep([t.id], { until: at('2026-10-21T06:00') })
    expect(task(t.id).due_at).toBe(at('2026-10-21T06:00'))
    expect(task(t.id).queue_mark).toBe(false)
  })

  test('TQ-L04: exactly the rollover is "at or after" → marked', () => {
    const t = make({ due_at: at('2026-10-20T15:00') })
    sweep([t.id], { until: at('2026-10-21T06:30') })
    expect(task(t.id).due_at).toBe(at('2026-10-21T06:30'))
    expect(task(t.id).queue_mark).toBe(true)
  })

  test('TQ-L05: a delta crossing the rollover → marked; one short of it → moved', () => {
    const a = make({ title: 'A', due_at: at('2026-10-20T20:00') })
    const b = make({ title: 'B', due_at: at('2026-10-20T20:00') })
    sweep([a.id], { deltaMinutes: 12 * 60 }) // 08:00 tomorrow
    sweep([b.id], { deltaMinutes: 6 * 60 }) // 02:00 tomorrow
    expect(task(a.id).due_at).toBe(at('2026-10-21T06:30'))
    expect(task(a.id).queue_mark).toBe(true)
    expect(task(b.id).due_at).toBe(at('2026-10-21T02:00'))
    expect(task(b.id).queue_mark).toBe(false)
  })

  test("TQ-L06: snooze-overdue slot 'next' in the evening → tomorrow's first period → marked", () => {
    const t = make({ due_at: at('2026-10-20T15:00') })
    const until = nextPeriodStart(listTimeSlots(TEST_USER_ID), tz)!
    expect(until).toBe(at('2026-10-21T06:30'))
    sweep([t.id], { until })
    expect(task(t.id).due_at).toBe(at('2026-10-21T06:30'))
    expect(task(t.id).queue_mark).toBe(true)
  })

  test("TQ-L07: slot 'HH:MM' — tomorrow's noon is marked, today's noon is not", () => {
    const evening = make({ title: 'Evening', due_at: at('2026-10-20T15:00') })
    sweep([evening.id], { until: nextSlotStart('12:00', tz) })
    expect(task(evening.id).due_at).toBe(at('2026-10-21T06:30'))
    expect(task(evening.id).queue_mark).toBe(true)

    setClock('2026-10-21T10:00')
    const morning = make({ title: 'Morning', due_at: at('2026-10-21T09:00') })
    sweep([morning.id], { until: nextSlotStart('12:00', tz) })
    expect(task(morning.id).due_at).toBe(at('2026-10-21T12:00'))
    expect(task(morning.id).queue_mark).toBe(false)
  })

  test('TQ-L08: tomorrow:true (morning_time 8:30) → the 6:30 rollover, marked', () => {
    const t = make({ due_at: at('2026-10-20T15:00') })
    const until = computeSnoozeTime('tomorrow', tz, '08:30', CALENDAR_DAY_START)
    expect(until).toBe(at('2026-10-21T08:30'))
    sweep([t.id], { until })
    expect(task(t.id).due_at).toBe(at('2026-10-21T06:30'))
    expect(task(t.id).queue_mark).toBe(true)
  })

  test('TQ-L09: a sweep at 23:30, +1h → 00:00 tonight, before the rollover → no mark', () => {
    setClock('2026-10-20T23:30')
    const t = make({ due_at: at('2026-10-20T22:00') })
    const until = computeSnoozeTime('60', tz, '08:30', CALENDAR_DAY_START)
    sweep([t.id], { until })
    expect(task(t.id).due_at).toBe(until)
    expect(task(t.id).queue_mark).toBe(false)
  })

  test('TQ-L10: a sweep at 1:00 to "tomorrow" — the rollover is THIS morning 6:30', () => {
    setClock('2026-10-21T01:00')
    const t = make({ due_at: at('2026-10-20T22:00') })
    sweep([t.id], { until: computeSnoozeTime('tomorrow', tz, '08:30', CALENDAR_DAY_START) }) // Oct 22 8:30
    expect(task(t.id).due_at).toBe(at('2026-10-21T06:30'))
    expect(task(t.id).queue_mark).toBe(true)
  })

  test('TQ-L11: a sweep at 1:00, +1h → 2:00 → no mark', () => {
    setClock('2026-10-21T01:00')
    const t = make({ due_at: at('2026-10-20T22:00') })
    sweep([t.id], { until: computeSnoozeTime('60', tz, '08:30', CALENDAR_DAY_START) })
    expect(task(t.id).due_at).toBe(at('2026-10-21T02:00'))
    expect(task(t.id).queue_mark).toBe(false)
  })

  test('TQ-L12: a sweep at 6:00, +1h → 7:00 lands at 6:30, marked (resolution 12)', () => {
    setClock('2026-10-21T06:00')
    const t = make({ due_at: at('2026-10-21T05:00') })
    const r = sweep([t.id], { until: computeSnoozeTime('60', tz, '08:30', CALENDAR_DAY_START) })
    expect(task(t.id).due_at).toBe(at('2026-10-21T06:30'))
    expect(task(t.id).queue_mark).toBe(true)
    expect(r.summary).toBe('"Task" will move to the Tasks queue at 6:30 AM')
  })

  test('TQ-L13: a sweep at 6:31, +1h → 7:31, the next rollover is tomorrow → no mark', () => {
    setClock('2026-10-21T06:31')
    const t = make({ due_at: at('2026-10-21T05:00') })
    const until = computeSnoozeTime('60', tz, '08:30', CALENDAR_DAY_START)
    sweep([t.id], { until })
    expect(task(t.id).due_at).toBe(until)
    expect(task(t.id).queue_mark).toBe(false)
  })

  test('TQ-L14: day start unset, no periods → the rollover is the 3:00 AM default, never morning_time', () => {
    seedPeriods([], '08:30', null)
    const t = make({ due_at: at('2026-10-20T15:00') })
    sweep([t.id], { until: at('2026-10-21T09:00') })
    expect(task(t.id).due_at).toBe(at('2026-10-21T03:00'))
    expect(task(t.id).queue_mark).toBe(true)
  })

  test('TQ-L15: a pick (no source) to tomorrow keeps its own time and is never marked', () => {
    const t = make({ due_at: at('2026-10-20T15:00') })
    sweep([t.id], { until: at('2026-10-21T08:30') }, 'pick')
    expect(task(t.id).due_at).toBe(at('2026-10-21T08:30'))
    expect(task(t.id).queue_mark).toBe(false)
  })
})

describe('TQ-M: a mixed press', () => {
  test('TQ-M01: one-off, deadline, P3, passed-deadline P1, daily, weekly, P4, reminder, quota', () => {
    const oneOff = make({ title: 'One-off', due_at: at('2026-10-20T15:00') })
    const deadline = make({
      title: 'Deadline',
      priority: 1,
      due_at: at('2026-10-20T15:00'),
      deadline_at: at('2026-10-25T17:00'),
    })
    const high = make({ title: 'High', priority: 3, due_at: at('2026-10-20T15:00') })
    const passed = make({ title: 'Passed', priority: 1, due_at: at('2026-10-19T15:00') })
    getDb()
      .prepare('UPDATE tasks SET deadline_at = ? WHERE id = ?')
      .run(at('2026-10-20T12:00'), passed.id)
    const daily = makeRepeating('FREQ=DAILY;BYHOUR=9;BYMINUTE=0', at('2026-10-20T09:00'), {
      title: 'Daily',
    })
    const weekly = makeRepeating(
      'FREQ=WEEKLY;BYDAY=TU;BYHOUR=9;BYMINUTE=0',
      at('2026-10-20T09:00'),
      {
        title: 'Weekly',
      },
    )
    const urgent = make({ title: 'Urgent', priority: 4, due_at: at('2026-10-20T15:00') })
    const reminder = make({
      title: 'Reminder',
      is_reminder: true,
      rrule: 'FREQ=DAILY;BYHOUR=20;BYMINUTE=30',
    })
    const quota = make({
      title: 'Quota',
      rrule: 'FREQ=WEEKLY',
      progress_target: 3,
      is_tracked: true,
    })

    const ids = [oneOff, deadline, high, passed, daily, weekly, urgent, reminder, quota].map(
      (t) => t.id,
    )
    const r = sweep(ids, { until: at('2026-10-21T08:30') })

    const rollover = at('2026-10-21T06:30')
    expect(task(oneOff.id)).toMatchObject({ due_at: rollover, queue_mark: true })
    // A deadline task moves as always (the landing, before its deadline), never marked.
    expect(task(deadline.id)).toMatchObject({ due_at: at('2026-10-21T08:30'), queue_mark: false })
    // Repeating below High: marked at the rollover; the occurrence is untouched.
    expect(task(daily.id)).toMatchObject({ due_at: rollover, queue_mark: true })
    expect(task(daily.id).occurrence_at).toBe(at('2026-10-20T09:00'))
    expect(task(weekly.id)).toMatchObject({ due_at: rollover, queue_mark: true })
    // Held back: High (something lower is left), the passed deadline, Urgent.
    expect(task(high.id).due_at).toBe(at('2026-10-20T15:00'))
    expect(task(passed.id).due_at).toBe(at('2026-10-19T15:00'))
    expect(task(urgent.id).due_at).toBe(at('2026-10-20T15:00'))
    for (const t of [high, passed, urgent]) expect(task(t.id).queue_mark).toBe(false)

    expect(r).toMatchObject({
      tasksAffected: 4,
      queued: 3,
      queuedName: null,
      urgentSkipped: 2,
      highSkipped: 1,
      deadlineSkipped: 1,
      reminderSkipped: 2,
      snoozedHighName: null,
      cappedOccurrence: 0,
    })
    expect(r.summary).toBe(
      '3 will move to the Tasks queue at 6:30 AM · Deferred 1 task (1 high, 1 past deadline, 1 urgent skipped)',
    )
  })

  test('TQ-M02: the second press takes ONE High and names it', () => {
    const a = make({ title: 'High A', priority: 3, due_at: at('2026-10-20T15:00') })
    const b = make({ title: 'High B', priority: 3, due_at: at('2026-10-20T14:00') })
    const r = sweep([a.id, b.id], { until: at('2026-10-21T08:30') })
    // High is never marked: it moves to the landing itself.
    expect(task(b.id)).toMatchObject({ due_at: at('2026-10-21T08:30'), queue_mark: false })
    expect(task(a.id).due_at).toBe(at('2026-10-20T15:00'))
    expect(r).toMatchObject({ tasksAffected: 1, highSnoozed: 1, highSkipped: 1, urgentSkipped: 1 })
    expect(r.snoozedHighName).toBe('High B')
    expect(r.summary).toBe('Deferred high-priority "High B" (1 high skipped)')
  })
})

describe('TQ-H: one High per press (B8, resolution 8)', () => {
  test('TQ-H01: oldest target first, then nearest deadline, then id; one per press', () => {
    const a = make({ title: 'A', priority: 3, due_at: at('2026-10-18T10:00') })
    const b = make({ title: 'B', priority: 3, due_at: at('2026-10-17T10:00') })
    // A passed deadline puts a P1 in the High tier. Same target as B, but a deadline.
    const c = make({ title: 'C', priority: 1, due_at: at('2026-10-17T10:00') })
    getDb()
      .prepare('UPDATE tasks SET deadline_at = ? WHERE id = ?')
      .run(at('2026-10-18T12:00'), c.id)
    const d = make({ title: 'D', priority: 3, due_at: at('2026-10-18T10:00') }) // ties A, higher id
    const urgent = make({ title: 'U', priority: 4, due_at: at('2026-10-17T10:00') })
    const ids = [a, b, c, d, urgent].map((t) => t.id)
    const until = at('2026-10-21T08:30')

    const order: (string | null)[] = []
    const presses = []
    // Each press sweeps what is over target at the time, as the route does.
    const overdue = () => ids.filter((id) => Date.parse(task(id).due_at!) <= Date.now())
    for (let i = 0; i < 5; i++) {
      const r = sweep(overdue(), { until })
      presses.push(r)
      order.push(r.snoozedHighName)
    }
    expect(order).toEqual(['C', 'B', 'A', 'D', null])
    // Press 1: C moved; A, B, D (High) and U (Urgent) skipped on priority.
    expect(presses[0]).toMatchObject({
      tasksAffected: 1,
      urgentSkipped: 4,
      highSkipped: 3,
      deadlineSkipped: 0,
      highSnoozed: 0, // C is P1 by priority
    })
    // C is in the tier by its passed deadline, and named so.
    expect(presses[0].summary).toBe('Deferred past-deadline "C" (3 high, 1 urgent skipped)')
    expect(presses[1]).toMatchObject({ tasksAffected: 1, urgentSkipped: 3, highSkipped: 2 })
    expect(presses[1].summary).toBe('Deferred high-priority "B" (2 high, 1 urgent skipped)')
    expect(presses[4]).toMatchObject({ tasksAffected: 0, urgentSkipped: 1, highSkipped: 0 })
    expect(presses[4].summary).toBe(
      'No deferrable tasks (1 urgent task must be deferred individually)',
    )
    expect(task(urgent.id).due_at).toBe(at('2026-10-17T10:00'))
  })

  test('TQ-H02: include_task_ids still rescues, and does not count as the press’s one', () => {
    const low = make({ title: 'Low', due_at: at('2026-10-20T15:00') })
    const picked = make({ title: 'Picked', priority: 3, due_at: at('2026-10-20T15:00') })
    const other = make({ title: 'Other', priority: 3, due_at: at('2026-10-19T15:00') })
    const r = bulkSnooze({
      ...u,
      taskIds: [low.id, picked.id, other.id],
      until: at('2026-10-21T08:30'),
      includeTaskIds: [picked.id],
      source: 'sweep',
    })
    expect(task(picked.id).due_at).toBe(at('2026-10-21T08:30'))
    expect(task(other.id).due_at).toBe(at('2026-10-19T15:00')) // something lower was left
    expect(r.snoozedHighName).toBeNull()
  })

  test('TQ-H04: a pick (no source) keeps the whole-tier rule with the switch on', () => {
    const a = make({ title: 'A', priority: 3, due_at: at('2026-10-18T10:00') })
    const b = make({ title: 'B', priority: 3, due_at: at('2026-10-17T10:00') })
    const r = sweep([a.id, b.id], { until: at('2026-10-21T08:30') }, 'pick')
    expect(r).toMatchObject({ tasksAffected: 2, highSnoozed: 2, snoozedHighName: null })
    expect(task(a.id).due_at).toBe(at('2026-10-21T08:30'))
    expect(task(b.id).due_at).toBe(at('2026-10-21T08:30'))
  })

  test('TQ-H03: switch off → the whole High tier on the second press, as before', () => {
    vi.stubEnv('OPENTASK_TASK_QUEUE', '')
    const a = make({ title: 'A', priority: 3, due_at: at('2026-10-18T10:00') })
    const b = make({ title: 'B', priority: 3, due_at: at('2026-10-17T10:00') })
    const r = sweep([a.id, b.id], { until: at('2026-10-21T08:30') })
    expect(r).toMatchObject({ tasksAffected: 2, highSnoozed: 2, snoozedHighName: null })
    expect(r.summary).toBe('Deferred 2 high-priority tasks')
  })
})

describe('TQ-C: every pick clears the mark (and its undo puts it back)', () => {
  /** A one-off marked by an evening sweep. */
  function marked(input: Record<string, unknown> = {}): Task {
    const t = make({ due_at: at('2026-10-20T15:00'), ...input })
    sweep([t.id], { until: at('2026-10-21T08:30') })
    expect(task(t.id).queue_mark).toBe(true)
    return task(t.id)
  }

  function clearedThenRestored(id: number, pick: () => void) {
    pick()
    expect(task(id).queue_mark).toBe(false)
    executeUndo(TEST_USER_ID)
    expect(task(id).queue_mark).toBe(true)
    executeRedo(TEST_USER_ID)
    expect(task(id).queue_mark).toBe(false)
  }

  test('TQ-C01: a single PATCH of the target', () => {
    const t = marked()
    clearedThenRestored(t.id, () =>
      updateTask({ ...u, taskId: t.id, input: { due_at: at('2026-10-21T10:00') } }),
    )
  })

  test('TQ-C02: the single snooze (the editor’s and the row clock’s pick)', () => {
    const t = marked()
    clearedThenRestored(t.id, () =>
      snoozeTask({ ...u, taskId: t.id, until: at('2026-10-21T10:00') }),
    )
  })

  test('TQ-C03: a multi-select bulk/snooze (no source) — even to tomorrow 8:30', () => {
    const t = marked()
    clearedThenRestored(t.id, () =>
      bulkSnooze({
        ...u,
        taskIds: [t.id],
        until: at('2026-10-21T08:30'),
        includeTaskIds: [t.id],
      }),
    )
    expect(task(t.id).due_at).toBe(at('2026-10-21T08:30'))
  })

  test('TQ-C04: bulk/edit', () => {
    const t = marked()
    clearedThenRestored(t.id, () =>
      bulkEdit({ ...u, taskIds: [t.id], changes: { due_at: at('2026-10-22T09:00') } }),
    )
  })

  test('TQ-C05: Today (/task-segments/target-today)', () => {
    const t = marked()
    clearedThenRestored(t.id, () => targetTasksToday(TEST_USER_ID, tz, [t.id]))
  })

  test('TQ-C06: a deadline added, target removed → no target: the deadlines page (2026-10-22)', () => {
    const t = marked()
    clearedThenRestored(t.id, () =>
      updateTask({
        ...u,
        taskId: t.id,
        input: { due_at: null, deadline_at: at('2026-10-30T17:00') },
      }),
    )
    // The undo/redo round trip ends on the redo. With the task queue on there
    // is no automatic target any more: the task is target-less, with a lead
    // day (the deadlines page holds it).
    expect(task(t.id)).toMatchObject({ due_at: null, target_auto: false })
    expect(task(t.id).lead_from).not.toBeNull()
  })

  test('TQ-C06b: a deadline added while the target stays put', () => {
    const t = marked()
    // A deadline after the marked target: the target does not move, but the
    // deadline write moves the EFFECTIVE target, so it is a target write.
    clearedThenRestored(t.id, () =>
      updateTask({ ...u, taskId: t.id, input: { deadline_at: at('2026-10-30T17:00') } }),
    )
    expect(task(t.id).due_at).toBe(at('2026-10-21T06:30'))
  })

  test('TQ-C07: done of a repeating task (the completion advance)', () => {
    const t = makeRepeating('FREQ=DAILY;BYHOUR=9;BYMINUTE=0', at('2026-10-20T09:00'))
    sweep([t.id], { until: at('2026-10-21T08:30') })
    expect(task(t.id).queue_mark).toBe(true)
    clearedThenRestored(t.id, () => markDone({ ...u, taskId: t.id }))
  })

  test('TQ-C07b: done of a one-off clears the mark and flag; undo puts them back', () => {
    const t = make({ due_at: at('2026-10-20T15:00') })
    sweep([t.id], {}, 'try_tomorrow')
    expect(task(t.id)).toMatchObject({ queue_mark: true, try_tomorrow: true })
    markDone({ ...u, taskId: t.id })
    expect(task(t.id)).toMatchObject({ done: true, queue_mark: false, try_tomorrow: false })
    executeUndo(TEST_USER_ID)
    expect(task(t.id)).toMatchObject({ done: false, queue_mark: true, try_tomorrow: true })
    executeRedo(TEST_USER_ID)
    expect(task(t.id)).toMatchObject({ done: true, queue_mark: false, try_tomorrow: false })
  })

  test('TQ-C08: bulk done of a repeating task', () => {
    const t = makeRepeating('FREQ=DAILY;BYHOUR=9;BYMINUTE=0', at('2026-10-20T09:00'))
    sweep([t.id], { until: at('2026-10-21T08:30') })
    clearedThenRestored(t.id, () => bulkDone({ ...u, taskIds: [t.id] }))
  })

  test('TQ-C09: skip of a repeating task', () => {
    const t = makeRepeating('FREQ=DAILY;BYHOUR=9;BYMINUTE=0', at('2026-10-20T09:00'))
    sweep([t.id], { until: at('2026-10-21T08:30') })
    clearedThenRestored(t.id, () => skipOccurrence({ ...u, taskId: t.id }))
  })

  test('TQ-C10: put-back (markUndone) clears a mark the row somehow still has', () => {
    const t = makeRepeating('FREQ=DAILY;BYHOUR=9;BYMINUTE=0', at('2026-10-20T09:00'))
    markDone({ ...u, taskId: t.id })
    getDb().prepare('UPDATE tasks SET queue_mark = 1 WHERE id = ?').run(t.id)
    clearedThenRestored(t.id, () => markUndone({ ...u, taskId: t.id }))
  })

  test('TQ-C11: the clearing also takes queued_at; queued_from_due_at is kept', () => {
    const t = make({ due_at: at('2026-10-20T15:00') })
    getDb()
      .prepare(
        'UPDATE tasks SET queue_mark = 1, try_tomorrow = 1, queued_at = ?, queued_from_due_at = ? WHERE id = ?',
      )
      .run(at('2026-10-20T06:30'), at('2026-10-19T15:00'), t.id)
    updateTask({ ...u, taskId: t.id, input: { due_at: at('2026-10-21T10:00') } })
    expect(task(t.id)).toMatchObject({
      queue_mark: false,
      try_tomorrow: false,
      queued_at: null,
      queued_from_due_at: at('2026-10-19T15:00'),
    })
    executeUndo(TEST_USER_ID)
    expect(task(t.id)).toMatchObject({
      queue_mark: true,
      try_tomorrow: true,
      queued_at: at('2026-10-20T06:30'),
    })
  })

  test('TQ-C12: enrichment’s write (stampTargetSet with no snapshot states) clears it', () => {
    const write = { setClauses: ['due_at = ?'], values: ['x'], fieldsChanged: ['due_at'] }
    stampTargetSet(
      write,
      { target_set_at: null, queue_mark: true, try_tomorrow: false, queued_at: null },
      '2026-10-20T00:00:00.000Z',
    )
    expect(write.setClauses).toContain('queue_mark = 0')
    expect(write.setClauses).not.toContain('try_tomorrow = 0')
    expect(write.fieldsChanged).toContain('queue_mark')
  })

  test('TQ-C13: a write that moves no target leaves the mark', () => {
    const t = marked()
    updateTask({ ...u, taskId: t.id, input: { title: 'Renamed', priority: 2 } })
    expect(task(t.id).queue_mark).toBe(true)
  })

  test('TQ-C14: a target write on a task with no queue state adds no queue fields', () => {
    const t = make({ due_at: at('2026-10-20T15:00') })
    const r = updateTask({ ...u, taskId: t.id, input: { due_at: at('2026-10-21T10:00') } })
    expect(r.fieldsChanged).not.toContain('queue_mark')
    expect(r.fieldsChanged).not.toContain('queued_at')
  })
})

describe('TQ-R: repeating tasks — a defer is capped at the next occurrence (B2)', () => {
  /** A daily 20:00 task still on yesterday's occurrence, at 7:00 this morning. */
  function lateDaily(): Task {
    setClock('2026-10-20T07:00')
    return makeRepeating('FREQ=DAILY;BYHOUR=20;BYMINUTE=0', at('2026-10-19T20:00'))
  }

  test('TQ-R01: a sweep past the next occurrence lands ON it, counted and said', () => {
    const t = lateDaily()
    const r = sweep([t.id], { until: at('2026-10-20T22:00') })
    expect(task(t.id).due_at).toBe(at('2026-10-20T20:00'))
    expect(task(t.id).queue_mark).toBe(false)
    expect(r.cappedOccurrence).toBe(1)
    expect(r.summary).toBe('Deferred "Task" · 1 stopped at its next occurrence')
  })

  test('TQ-R02: a manual snooze may pass it', () => {
    const t = lateDaily()
    snoozeTask({ ...u, taskId: t.id, until: at('2026-10-20T22:00') })
    expect(task(t.id).due_at).toBe(at('2026-10-20T22:00'))
  })

  test('TQ-R03: a multi-select (a pick) passes it too', () => {
    const t = lateDaily()
    const r = bulkSnooze({
      ...u,
      taskIds: [t.id],
      until: at('2026-10-20T22:00'),
      includeTaskIds: [t.id],
    })
    expect(task(t.id).due_at).toBe(at('2026-10-20T22:00'))
    expect(r.cappedOccurrence).toBe(0)
  })

  test('TQ-R04: High is never capped', () => {
    setClock('2026-10-20T07:00')
    const t = makeRepeating('FREQ=DAILY;BYHOUR=20;BYMINUTE=0', at('2026-10-19T20:00'), {
      priority: 3,
    })
    sweep([t.id], { until: at('2026-10-20T22:00') })
    expect(task(t.id).due_at).toBe(at('2026-10-20T22:00'))
  })

  test('TQ-R05: a sweep within the occurrence is not capped', () => {
    const t = lateDaily()
    const r = sweep([t.id], { until: at('2026-10-20T12:00') })
    expect(task(t.id).due_at).toBe(at('2026-10-20T12:00'))
    expect(r.cappedOccurrence).toBe(0)
  })
})

describe('TQ-U: undo and redo of a marking sweep', () => {
  test('TQ-U01: undo restores the target and clears the mark; redo re-applies both', () => {
    const t = make({ due_at: at('2026-10-20T15:00') })
    sweep([t.id], { until: at('2026-10-21T08:30') })
    executeUndo(TEST_USER_ID)
    expect(task(t.id)).toMatchObject({ due_at: at('2026-10-20T15:00'), queue_mark: false })
    executeRedo(TEST_USER_ID)
    expect(task(t.id)).toMatchObject({ due_at: at('2026-10-21T06:30'), queue_mark: true })
  })

  test('TQ-U02: Try Tomorrow’s flag goes and comes back with it', () => {
    const t = make({ due_at: at('2026-10-20T15:00') })
    sweep([t.id], {}, 'try_tomorrow')
    executeUndo(TEST_USER_ID)
    expect(task(t.id)).toMatchObject({ queue_mark: false, try_tomorrow: false })
    executeRedo(TEST_USER_ID)
    expect(task(t.id)).toMatchObject({ queue_mark: true, try_tomorrow: true })
  })
})

/** The newest undo entry's description (what Undo and History show). */
function lastUndoDescription(): string {
  return (
    getDb()
      .prepare('SELECT description FROM undo_log WHERE user_id = ? ORDER BY id DESC LIMIT 1')
      .get(TEST_USER_ID) as { description: string }
  ).description
}

describe('TQ-W: the undo / History description says what happened', () => {
  test('TQ-W01: every task marked → "Sent N tasks to the queue at 6:30 AM"', () => {
    const a = make({ due_at: at('2026-10-20T15:00') })
    const b = make({ due_at: at('2026-10-20T15:00') })
    sweep([a.id, b.id], { until: at('2026-10-21T08:30') })
    expect(lastUndoDescription()).toBe('Sent 2 tasks to the queue at 6:30 AM')
  })

  test('TQ-W02: a mixed press → "Snoozed N tasks (M to the queue at 6:30 AM)"', () => {
    const a = make({ due_at: at('2026-10-20T15:00') })
    const d = make({ due_at: at('2026-10-20T15:00'), deadline_at: at('2026-10-25T17:00') })
    sweep([a.id, d.id], { until: at('2026-10-21T08:30') })
    expect(lastUndoDescription()).toBe('Deferred 2 tasks (1 to the queue at 6:30 AM)')
  })

  test('TQ-W03: nothing marked → the old wording', () => {
    const a = make({ due_at: at('2026-10-20T15:00') })
    sweep([a.id], { until: at('2026-10-20T22:00') })
    expect(lastUndoDescription()).toBe('Deferred 1 tasks to 10:00 PM')
  })
})

describe('TQ-Q: queued_at and the Try Tomorrow flag on a defer’s own write', () => {
  function queue(id: number) {
    getDb()
      .prepare('UPDATE tasks SET queued_at = ?, queued_from_due_at = ?, due_at = NULL WHERE id = ?')
      .run(at('2026-10-20T06:30'), at('2026-10-19T15:00'), id)
  }

  test('TQ-Q01: Try Tomorrow on a queued task puts it back on a target, out of the queue', () => {
    const t = make({ title: 'Queued' })
    queue(t.id)
    sweep([t.id], {}, 'try_tomorrow')
    expect(task(t.id)).toMatchObject({
      due_at: at('2026-10-21T06:30'),
      queue_mark: true,
      try_tomorrow: true,
      queued_at: null,
      queued_from_due_at: at('2026-10-19T15:00'),
    })
    executeUndo(TEST_USER_ID)
    expect(task(t.id)).toMatchObject({ queued_at: at('2026-10-20T06:30'), queue_mark: false })
  })

  test('TQ-Q02: a plain sweep that marks clears an earlier Try Tomorrow flag', () => {
    const t = make({ due_at: at('2026-10-20T15:00') })
    getDb().prepare('UPDATE tasks SET try_tomorrow = 1 WHERE id = ?').run(t.id)
    sweep([t.id], { until: at('2026-10-21T08:30') })
    expect(task(t.id)).toMatchObject({ queue_mark: true, try_tomorrow: false })
    executeUndo(TEST_USER_ID)
    expect(task(t.id)).toMatchObject({ queue_mark: false, try_tomorrow: true })
  })
})

describe('TQ-T: Try Tomorrow', () => {
  test('TQ-T01: on a P1 — the next rollover, marked, flagged (whatever until says)', () => {
    setClock('2026-10-20T10:00')
    const t = make({ priority: 1, due_at: at('2026-10-20T09:00') })
    const r = bulkSnooze({
      ...u,
      taskIds: [t.id],
      until: at('2026-10-20T11:00'),
      source: 'try_tomorrow',
    })
    expect(task(t.id)).toMatchObject({
      due_at: at('2026-10-21T06:30'),
      queue_mark: true,
      try_tomorrow: true,
    })
    expect(r.queued).toBe(1)
  })

  test('TQ-T02: on a P3 — a plain target to the next rollover, no mark, no flag', () => {
    setClock('2026-10-20T10:00')
    const t = make({ priority: 3, due_at: at('2026-10-20T09:00') })
    const r = sweep([t.id], {}, 'try_tomorrow')
    expect(task(t.id)).toMatchObject({
      due_at: at('2026-10-21T06:30'),
      queue_mark: false,
      try_tomorrow: false,
    })
    expect(r.queued).toBe(0)
    expect(r.summary).toBe('Deferred "Task"')
  })

  test('TQ-T03: on an Urgent task too (it is one the user pointed at)', () => {
    const t = make({ priority: 4, due_at: at('2026-10-20T09:00') })
    sweep([t.id], {}, 'try_tomorrow')
    expect(task(t.id)).toMatchObject({ due_at: at('2026-10-21T06:30'), queue_mark: false })
  })

  test('TQ-T04: a deadline task moves (capped), never marked', () => {
    const t = make({
      due_at: at('2026-10-20T09:00'),
      deadline_at: at('2026-10-21T05:00'),
    })
    sweep([t.id], {}, 'try_tomorrow')
    expect(task(t.id)).toMatchObject({ due_at: at('2026-10-21T05:00'), queue_mark: false })
  })

  test('TQ-T05: exactly one task', () => {
    const a = make({ due_at: at('2026-10-20T09:00') })
    const b = make({ due_at: at('2026-10-20T09:00') })
    expect(() => sweep([a.id, b.id], {}, 'try_tomorrow')).toThrow('exactly one task')
  })
})

describe('TQ-O: switch off — a sweep is exactly today’s', () => {
  beforeEach(() => vi.stubEnv('OPENTASK_TASK_QUEUE', ''))

  test('TQ-O01: lands on until, no mark, the old counts and line', () => {
    const a = make({ title: 'A', due_at: at('2026-10-20T15:00') })
    const b = make({
      title: 'B',
      due_at: at('2026-10-20T15:00'),
      deadline_at: at('2026-10-21T07:00'),
    })
    const h = make({ title: 'H', priority: 3, due_at: at('2026-10-20T15:00') })
    const daily = makeRepeating('FREQ=DAILY;BYHOUR=9;BYMINUTE=0', at('2026-10-20T09:00'))
    const r = sweep([a.id, b.id, h.id, daily.id], { until: at('2026-10-22T08:30') })
    expect(task(a.id)).toMatchObject({ due_at: at('2026-10-22T08:30'), queue_mark: false })
    expect(task(b.id).due_at).toBe(at('2026-10-21T07:00')) // capped at its deadline
    // Not capped at the next occurrence either: that is the queue's rule.
    expect(task(daily.id)).toMatchObject({ due_at: at('2026-10-22T08:30'), queue_mark: false })
    expect(r).toEqual({
      tasksAffected: 3,
      tasksSkipped: 1,
      urgentSkipped: 1,
      highSkipped: 1,
      highSnoozed: 0,
      reminderSkipped: 0,
      noDueDateSkipped: 0,
      deadlineSkipped: 0,
      deadlineCapped: 1,
      snoozedIds: [a.id, b.id, daily.id],
      queued: 0,
      queuedName: null,
      cappedOccurrence: 0,
      snoozedHighName: null,
      queuedUntil: null,
      summary: 'Deferred 3 tasks (1 high skipped) · 1 stopped at its deadline',
    })
  })

  test('TQ-O02: one task is not named', () => {
    const a = make({ title: 'A', due_at: at('2026-10-20T15:00') })
    expect(sweep([a.id], { until: at('2026-10-21T08:30') }).summary).toBe('Deferred 1 task')
  })
})
