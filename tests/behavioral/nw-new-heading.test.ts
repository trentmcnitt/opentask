/**
 * NEW AS A HEADING (2026-11-17; src/lib/new-tasks.ts, the seed in
 * src/core/db/index.ts). `nw-`:
 *  - NW-10 the state table: segment × considers × ended → New or not;
 *  - NW-11 a New row is in its own horizon segment, marked, first;
 *  - NW-12 no clock: untouched for weeks, still New;
 *  - NW-20 the count: consider, Consider all, keep, grow; Not today adds nothing;
 *  - NW-21 put-back takes one off; Undo puts the number back;
 *  - NW-30 New ends: Grow, a horizon change by hand; creation's horizon does not;
 *  - NW-31 Undo of a Grow un-ends it;
 *  - NW-40 leaves the segments and comes back: New again while under its threshold;
 *  - NW-41 done and undone: as it was;
 *  - NW-50 the seed: an old Days task, an old unset task, a 3-day-old unset task;
 *  - NW-51 unset reads as Days: daily, from the day after it is made.
 *
 * Synthetic data only. Task queue on (the day starts at 3:00 AM). Days in
 * America/Chicago: Mon 2026-11-09 (made), Tue 11-10, Wed 11-11; the check-in
 * day is Saturday (11-14).
 */
import { describe, test, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { DateTime } from 'luxon'

vi.mock('@/core/notifications/dismiss', () => ({
  dismissNotificationsForTasks: vi.fn(),
  dismissPromptNotifications: vi.fn(),
  syncBadgeCount: vi.fn(),
  getOverdueCount: vi.fn().mockReturnValue(0),
}))
vi.mock('@/core/webhooks/dispatch', () => ({ dispatchWebhookEvent: vi.fn() }))

import { createTask, getTaskById, markDone, markUndone, updateTask } from '@/core/tasks'
import {
  considerTasks,
  deferTasks,
  getTaskSegments,
  growTasks,
  keepTasks,
  restoreTasks,
} from '@/core/tasks/task-segments'
import { undoLatest } from '@/core/undo/execute-undo'
import { getDb, seedNewEnded } from '@/core/db'
import { NEW_CONSIDERS, isNewRow } from '@/lib/new-tasks'
import { HORIZON_ORDER } from '@/lib/task-segments'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

const tz = TEST_TIMEZONE
const at = (local: string) => DateTime.fromISO(local, { zone: tz }).toJSDate()
const setClock = (local: string) => vi.setSystemTime(at(local))

function make(input: Record<string, unknown> = {}) {
  return createTask({
    userId: TEST_USER_ID,
    userTimezone: tz,
    input: { title: 'Synthetic paper lantern', ...input },
  })
}
const read = (id: number) => getTaskById(id)!

/** Where task `id` is now: each segment that lists it, its state, and `:new` when marked. */
function where(id: number): string[] {
  return getTaskSegments(TEST_USER_ID, tz, new Date(), { handledRows: true }).flatMap((s) =>
    s.tasks
      .filter((r) => r.task.id === id)
      .map((r) => `${s.horizon}:${r.state}${r.isNew ? ':new' : ''}`),
  )
}

beforeEach(() => {
  setupTestDb()
  vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
  vi.useFakeTimers({ toFake: ['Date'] })
  setClock('2026-11-09T14:00')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})
afterAll(() => teardownTestDb())

describe('NW-10 the state table (RULE NEW-WHO)', () => {
  test('NW-10: New while the count is under the segment’s threshold and New has not ended', () => {
    expect(NEW_CONSIDERS).toEqual({ days: 2, weeks: 2, months: 1, eventually: 1 })
    for (const horizon of [null, ...HORIZON_ORDER]) {
      // Unset reads as Days.
      const threshold = NEW_CONSIDERS[horizon ?? 'days']
      for (let count = 0; count <= 3; count++) {
        expect(isNewRow({ horizon, consider_count: count, new_ended_at: null })).toBe(
          count < threshold,
        )
        // Ended: never New, whatever the count.
        expect(
          isNewRow({ horizon, consider_count: count, new_ended_at: '2026-11-09T20:00:00.000Z' }),
        ).toBe(false)
      }
    }
  })
})

describe('NW-11, NW-12 where a New row is (RULE NEW-HEADING)', () => {
  test('NW-11: in its own horizon segment, marked, before the segment’s other rows', () => {
    const settled = make({ title: 'Synthetic settled row', horizon: 'days', priority: 4 })
    getDb()
      .prepare('UPDATE tasks SET new_ended_at = ? WHERE id = ?')
      .run(new Date().toISOString(), settled.id)
    const low = make({ title: 'Synthetic new low', horizon: 'days', priority: 1 })
    setClock('2026-11-09T15:00')
    const high = make({ title: 'Synthetic new high', horizon: 'days', priority: 3 })
    setClock('2026-11-09T16:00')
    const newest = make({ title: 'Synthetic new newest', horizon: 'days', priority: 3 })
    setClock('2026-11-10T09:00')
    const days = getTaskSegments(TEST_USER_ID, tz, new Date()).find((s) => s.horizon === 'days')!
    // New first: priority rank, then newest; then the rest, an Urgent one included.
    expect(days.tasks.map((r) => [r.task.id, !!r.isNew])).toEqual([
      [newest.id, true],
      [high.id, true],
      [low.id, true],
      [settled.id, false],
    ])
    // No `new` kind anywhere.
    expect(
      getTaskSegments(TEST_USER_ID, tz, new Date(), { fill: true }).map((s) => s.horizon),
    ).not.toContain('new')
  })

  test('NW-12: no clock — untouched for three weeks, a Weeks task is still New on its check-in day', () => {
    const task = make({ horizon: 'weeks' })
    // Sat 11-28, a check-in day: listed, New. (Days would have aged out by then.)
    setClock('2026-11-28T09:00')
    expect(where(task.id)).toEqual(['weeks:waiting:new'])
  })
})

describe('NW-20, NW-21 the count (RULE NEW-COUNT)', () => {
  test('NW-20: consider, Consider all and Keep add one each; Not today adds nothing', () => {
    const a = make({ horizon: 'days' })
    const b = make({ horizon: 'days' })
    setClock('2026-11-10T09:00')
    deferTasks(TEST_USER_ID, [a.id])
    expect(read(a.id).consider_count).toBe(0)
    expect(where(a.id)).toEqual(['days:deferred:new'])
    // The next day: still New; one consider (the circle, or a sweep of both).
    setClock('2026-11-11T09:00')
    considerTasks(TEST_USER_ID, [a.id, b.id])
    expect([read(a.id).consider_count, read(b.id).consider_count]).toEqual([1, 1])
    // Days comes round again: New, at one.
    setClock('2026-11-12T09:00')
    expect(where(a.id)).toEqual(['days:waiting:new'])
    keepTasks(TEST_USER_ID, tz, [a.id])
    expect(read(a.id).consider_count).toBe(2)
    // Twice: an ordinary row from now on.
    setClock('2026-11-13T09:00')
    expect(where(a.id)).toEqual(['days:waiting'])
    expect(where(b.id)).toEqual(['days:waiting:new'])
  })

  test('NW-20b: Months and Eventually take one consider', () => {
    const task = make({ horizon: 'months' })
    // Sat 2026-12-05: the first check-in day of the month.
    setClock('2026-12-05T09:00')
    expect(where(task.id)).toEqual(['months:waiting:new'])
    considerTasks(TEST_USER_ID, [task.id])
    expect(isNewRow(read(task.id))).toBe(false)
  })

  test('NW-21: a put-back takes one off (never below 0); Undo puts the number back', () => {
    const task = make({ horizon: 'days' })
    setClock('2026-11-10T09:00')
    considerTasks(TEST_USER_ID, [task.id])
    restoreTasks(TEST_USER_ID, [task.id])
    expect(read(task.id).consider_count).toBe(0)
    expect(where(task.id)).toEqual(['days:waiting:new'])
    // A deferred row put back had no look to take off.
    deferTasks(TEST_USER_ID, [task.id])
    restoreTasks(TEST_USER_ID, [task.id])
    expect(read(task.id).consider_count).toBe(0)
    // Considered, then the consider undone.
    considerTasks(TEST_USER_ID, [task.id])
    expect(read(task.id).consider_count).toBe(1)
    undoLatest(TEST_USER_ID)
    expect(read(task.id).consider_count).toBe(0)
    expect(read(task.id).last_considered_at).toBeNull()
  })
})

describe('NW-30, NW-31 New ends (RULE NEW-ENDS, NEW-GROW)', () => {
  test('NW-30: a Grow and a horizon change by hand end it; a horizon stated at creation does not', () => {
    const stated = make({ horizon: 'weeks' })
    expect(read(stated.id).new_ended_at).toBeNull()
    const grown = make()
    const byHand = make({ horizon: 'weeks' })
    const cleared = make({ horizon: 'weeks' })
    setClock('2026-11-10T09:00')
    // Unset reads as Days: one step out is Weeks; considered, ended.
    expect(growTasks(TEST_USER_ID, tz, [grown.id])).toBe(1)
    const after = read(grown.id)
    expect([after.horizon, after.consider_count, after.new_ended_at !== null]).toEqual([
      'weeks',
      1,
      true,
    ])
    // Listed in Days today as the row that left, considered; not New anywhere.
    expect(where(grown.id).every((p) => !p.endsWith(':new'))).toBe(true)
    updateTask({
      userId: TEST_USER_ID,
      userTimezone: tz,
      taskId: byHand.id,
      input: { horizon: 'days' },
    })
    expect(isNewRow(read(byHand.id))).toBe(false)
    // Clearing the horizon is a change too.
    updateTask({
      userId: TEST_USER_ID,
      userTimezone: tz,
      taskId: cleared.id,
      input: { horizon: null },
    })
    expect(isNewRow(read(cleared.id))).toBe(false)
    // Re-sending the same horizon is no change: still New.
    updateTask({
      userId: TEST_USER_ID,
      userTimezone: tz,
      taskId: stated.id,
      input: { horizon: 'weeks' },
    })
    expect(isNewRow(read(stated.id))).toBe(true)
  })

  test('NW-31: the hold menu’s pick grows to that horizon, inward too; Undo un-ends it', () => {
    const task = make({ horizon: 'weeks' })
    growTasks(TEST_USER_ID, tz, [task.id], 'days')
    expect([read(task.id).horizon, isNewRow(read(task.id))]).toEqual(['days', false])
    undoLatest(TEST_USER_ID)
    const back = read(task.id)
    expect([back.horizon, back.consider_count, back.new_ended_at]).toEqual(['weeks', 0, null])
  })
})

describe('NW-40, NW-41 leaving and coming back', () => {
  test('NW-40: a target takes it out of the segments; removed, it is New again, its count kept', () => {
    const task = make({ horizon: 'days' })
    setClock('2026-11-10T09:00')
    considerTasks(TEST_USER_ID, [task.id])
    setClock('2026-11-11T09:00')
    updateTask({
      userId: TEST_USER_ID,
      userTimezone: tz,
      taskId: task.id,
      input: { due_at: at('2026-11-20T09:00').toISOString() },
    })
    expect(where(task.id).filter((p) => p.startsWith('days'))).toEqual([])
    updateTask({ userId: TEST_USER_ID, userTimezone: tz, taskId: task.id, input: { due_at: null } })
    expect(read(task.id).consider_count).toBe(1)
    expect(where(task.id)).toEqual(['days:waiting:new'])
  })

  test('NW-41: done then undone: back as it was', () => {
    const task = make({ horizon: 'days' })
    setClock('2026-11-10T09:00')
    markDone({ userId: TEST_USER_ID, userTimezone: tz, taskId: task.id })
    expect(where(task.id).some((p) => p.includes('waiting'))).toBe(false)
    markUndone({ userId: TEST_USER_ID, userTimezone: tz, taskId: task.id })
    expect(where(task.id)).toEqual(['days:waiting:new'])
  })
})

describe('NW-50 the seed (RULE NEW-SEED)', () => {
  test('NW-50: an old Days task and an old unset task are not New; a 3-day-old unset task is', () => {
    const oldDays = make({ title: 'Synthetic old days', horizon: 'days' })
    const oldUnset = make({ title: 'Synthetic old unset' })
    const oldRepeat = make({ title: 'Synthetic old repeat', rrule: 'FREQ=WEEKLY;BYDAY=MO' })
    setClock('2026-11-14T10:00')
    const recentUnset = make({ title: 'Synthetic recent unset' })
    const recentWeeks = make({ title: 'Synthetic recent weeks', horizon: 'weeks' })
    // The seed runs on Tue 11-17: the first two are 8 days old, the last two 3.
    setClock('2026-11-17T08:00')
    const stamp = new Date().toISOString()
    seedNewEnded(getDb(), new Date())

    const days = read(oldDays.id)
    expect([days.horizon, days.new_ended_at]).toEqual(['days', stamp])
    // Old and unset: Weeks, with no horizon_set_at (a hand-set one has it).
    const unset = read(oldUnset.id)
    expect([unset.horizon, unset.horizon_set_at, unset.new_ended_at]).toEqual([
      'weeks',
      null,
      stamp,
    ])
    // A repeat has no horizon to give; New has ended for it like any old task.
    const repeat = read(oldRepeat.id)
    expect([repeat.horizon, repeat.new_ended_at]).toEqual([null, stamp])
    // Recent and unset: left alone, New, count 0.
    const recent = read(recentUnset.id)
    expect([recent.horizon, recent.consider_count, recent.new_ended_at]).toEqual([null, 0, null])
    // Recent with a horizon: it existed before the columns, so New has ended.
    expect(read(recentWeeks.id).new_ended_at).toBe(stamp)

    expect(where(recentUnset.id)).toEqual(['days:waiting:new'])
    expect(where(oldDays.id)).toEqual(['days:waiting'])
    // Weeks now, made before the last check-in day (Sat 11-14): carried over, not New.
    expect(where(oldUnset.id)).toEqual(['weeks:waiting'])
  })
})

describe('NW-51 unset reads as Days (RULE HZ-UNSET)', () => {
  test('NW-51: an unset one-off comes round daily from the day after it is made', () => {
    const task = make()
    expect(where(task.id)).toEqual([])
    setClock('2026-11-10T09:00')
    expect(where(task.id)).toEqual(['days:waiting:new'])
    expect(read(task.id).horizon).toBeNull()
  })
})
