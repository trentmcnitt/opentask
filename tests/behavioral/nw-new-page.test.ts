/**
 * NEW (2026-11-10; src/lib/new-tasks.ts, `newRows` in getTaskSegments). `nw-`:
 *  - NW-01 N1: made yesterday → in New today; made today → not yet, tomorrow yes;
 *  - NW-02 N2: one place at a time — never also in its horizon segment;
 *  - NW-03 N3: untouched, the next rollover drops it into its horizon's rhythm;
 *  - NW-04 N4: consider → handled in New today, its horizon's rhythm tomorrow;
 *  - NW-05 N5: Not today → back tomorrow under "Carried over", once;
 *  - NW-06 N6/N1: done, a target, a deck or a deadline takes it out;
 *    reminders, quotas and repeats never come;
 *  - NW-07 a caller that doesn't ask (native) sees the horizons as before.
 *
 * Synthetic data only. Task queue on (the day starts at 3:00 AM). Days in
 * America/Chicago: Mon 2026-11-09 (made), Tue 11-10 (New), Wed 11-11.
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

import { createTask, markDone, updateTask } from '@/core/tasks'
import { considerTasks, deferTasks, getTaskSegments } from '@/core/tasks/task-segments'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

const tz = TEST_TIMEZONE
const at = (local: string) => DateTime.fromISO(local, { zone: tz }).toJSDate()
const setClock = (local: string) => vi.setSystemTime(at(local))

function make(input: Record<string, unknown> = {}) {
  return createTask({
    userId: TEST_USER_ID,
    userTimezone: tz,
    input: { title: 'Synthetic new task', horizon: 'days', ...input },
  })
}

/** Where task `id` is now: each segment that lists it, with its state (and `carried`). */
function where(id: number, newRows = true): string[] {
  return getTaskSegments(TEST_USER_ID, tz, new Date(), { newRows, fill: false }).flatMap((s) =>
    s.tasks
      .filter((r) => r.task.id === id)
      .map((r) => `${s.horizon}:${r.state}${r.carried ? ':carried' : ''}`),
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

describe('NW-01 who: made during the previous OpenTask day', () => {
  test('made yesterday → in New today; made today → not yet, tomorrow yes', () => {
    const yesterday = make()
    setClock('2026-11-10T09:00')
    const today = make()
    expect(where(yesterday.id)).toEqual(['new:waiting'])
    expect(where(today.id).some((p) => p.startsWith('new'))).toBe(false)
    setClock('2026-11-11T09:00')
    expect(where(today.id)).toEqual(['new:waiting'])
  })

  test('rollover to rollover: made at 1:30 AM Tuesday is Monday’s (before the 3:00 day start)', () => {
    setClock('2026-11-10T01:30')
    const small = make()
    setClock('2026-11-10T09:00')
    expect(where(small.id)).toEqual(['new:waiting'])
  })
})

describe('NW-02 one place at a time', () => {
  test('a Days task made yesterday is in New, not in Days', () => {
    const task = make()
    setClock('2026-11-10T09:00')
    expect(where(task.id)).toEqual(['new:waiting'])
  })
})

describe('NW-03 one pass, not a backlog', () => {
  test('untouched, the next rollover drops it into Days', () => {
    const task = make()
    setClock('2026-11-11T09:00')
    expect(where(task.id)).toEqual(['days:waiting'])
  })
})

describe('NW-04 consider', () => {
  test('handled in New today; its horizon’s rhythm tomorrow', () => {
    const task = make({ horizon: 'weeks' })
    setClock('2026-11-10T09:00')
    considerTasks(TEST_USER_ID, [task.id])
    expect(where(task.id)).toEqual(['new:considered'])
    setClock('2026-11-11T09:00')
    // Seen for Weeks: not waiting there before the next check-in day.
    expect(where(task.id)).toEqual([])
  })
})

describe('NW-05 Not today', () => {
  test('back tomorrow under Carried over, once; then its horizon', () => {
    const task = make()
    setClock('2026-11-10T09:00')
    deferTasks(TEST_USER_ID, [task.id])
    expect(where(task.id)).toEqual(['new:deferred'])
    setClock('2026-11-11T09:00')
    expect(where(task.id)).toEqual(['new:waiting:carried'])
    deferTasks(TEST_USER_ID, [task.id])
    setClock('2026-11-12T09:00')
    expect(where(task.id).some((p) => p.startsWith('new'))).toBe(false)
  })

  test('fresh rows come before carried ones', () => {
    const carried = make({ priority: 4 })
    setClock('2026-11-10T09:00')
    deferTasks(TEST_USER_ID, [carried.id])
    const fresh = make({ priority: 0 })
    setClock('2026-11-11T09:00')
    const page = getTaskSegments(TEST_USER_ID, tz, new Date(), { newRows: true }).find(
      (s) => s.horizon === 'new',
    )!
    expect(page.tasks.map((r) => r.task.id)).toEqual([fresh.id, carried.id])
  })
})

describe('NW-06 who leaves, who never comes', () => {
  test('done, a target, a deck or a deadline takes it out', () => {
    const done = make()
    const targeted = make()
    const decked = make()
    const deadlined = make()
    setClock('2026-11-10T09:00')
    markDone({ userId: TEST_USER_ID, userTimezone: tz, taskId: done.id })
    const edit = (taskId: number, input: Record<string, unknown>) =>
      updateTask({ userId: TEST_USER_ID, userTimezone: tz, taskId, input })
    edit(targeted.id, { due_at: at('2026-11-12T09:00').toISOString() })
    edit(decked.id, { on_deck_day: '2026-11-12' })
    edit(deadlined.id, { deadline_at: at('2026-11-20T17:00').toISOString() })
    for (const t of [done, targeted, decked, deadlined]) {
      expect(where(t.id).some((p) => p.startsWith('new'))).toBe(false)
    }
  })

  test('a reminder, a quota or a repeating task never comes', () => {
    const reminder = make({ is_reminder: true, horizon: undefined })
    const quota = make({ is_tracked: true, rrule: 'FREQ=WEEKLY', horizon: undefined })
    const repeat = make({ rrule: 'FREQ=WEEKLY', due_at: at('2026-11-16T09:00').toISOString() })
    setClock('2026-11-10T09:00')
    for (const t of [reminder, quota, repeat]) {
      expect(where(t.id).some((p) => p.startsWith('new'))).toBe(false)
    }
  })
})

describe('NW-07 a caller that does not ask', () => {
  test('sees its horizon as before', () => {
    const task = make()
    setClock('2026-11-10T09:00')
    expect(where(task.id, false)).toEqual(['days:waiting'])
  })
})
