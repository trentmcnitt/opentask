/**
 * The day roster (src/core/tasks/segment-roster.ts; Trent's phone review,
 * 2026-10-22): a task segment's "N of M" keeps M fixed for the day. A row
 * decked, targeted (Today) or done leaves the list but is still counted, as a
 * considered row marked `left`; a row that left without being handled (trashed,
 * an Upcoming heads-up whose day passed) drops out of M. Only with
 * `handledRows` — without it the segments are as before.
 *
 * The user: America/Chicago, rollover 06:30. "Today" is Thu 2026-10-22.
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
import { createTask, deleteTask, markDone, markUndone } from '@/core/tasks'
import { deckTasks } from '@/core/tasks/deck'
import {
  considerTasks,
  getTaskSegments,
  targetTasksToday,
  type TaskSegment,
} from '@/core/tasks/task-segments'
import { runTaskRollover } from '@/core/tasks/task-rollover'
import { executeUndo } from '@/core/undo'
import { emitSyncEvent } from '@/lib/sync-events'
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

/** The segments as the web reads them (queue panels, deck rows, the roster). */
function read(local: string, handledRows = true): TaskSegment[] {
  setClock(local)
  return getTaskSegments(TEST_USER_ID, tz, new Date(), {
    queuePanels: true,
    deckRows: true,
    handledRows,
  })
}
function segment(local: string, kind: string, handledRows = true): TaskSegment | undefined {
  return read(local, handledRows).find((s) => s.horizon === kind)
}
/** "N of M": every row not waiting, of every row (`segmentCounts` on the clients). */
function counts(seg: TaskSegment | undefined): string {
  if (!seg) return 'none'
  return `${seg.tasks.length - seg.waiting} of ${seg.tasks.length}`
}

/** `n` one-offs on the Days horizon, made yesterday: the Days segment lists them every day. */
function daysTasks(n: number): Task[] {
  return Array.from({ length: n }, (_, i) =>
    makeAt('2026-10-21T09:00', { title: `Days task ${i + 1}`, horizon: 'days' }),
  )
}

describe('TQ-R: the day roster keeps "N of M" fixed for the day', () => {
  beforeEach(() => {
    setupTestDb()
    vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
    const insert = getDb().prepare(
      'INSERT INTO time_slots (user_id, label, start_time, sort_order) VALUES (?, ?, ?, ?)',
    )
    ;['06:30', '12:00', '20:30'].forEach((s, i) => insert.run(TEST_USER_ID, `Period ${i}`, s, i))
    getDb()
      .prepare("UPDATE users SET last_rollover_date = '2026-10-22' WHERE id = ?")
      .run(TEST_USER_ID)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })
  afterAll(() => teardownTestDb())

  test('TQ-R01: 75 came round; deck, Today and done on three → "3 of 75", not "0 of 72"', () => {
    const tasks = daysTasks(75)
    expect(counts(segment('2026-10-22T08:00', 'days'))).toBe('0 of 75')

    setClock('2026-10-22T09:00')
    deckTasks({ userId: TEST_USER_ID, timezone: tz, ids: [tasks[0].id], day: '2026-10-23' })
    targetTasksToday(TEST_USER_ID, tz, [tasks[1].id])
    markDone({ ...u, taskId: tasks[2].id })

    const days = segment('2026-10-22T09:05', 'days')!
    expect(counts(days)).toBe('3 of 75')
    expect(days.waiting).toBe(72)
    expect(days.considered).toBe(3)
    const left = Object.fromEntries(
      days.tasks.filter((r) => r.left).map((r) => [r.task.id, `${r.state}:${r.left}`]),
    )
    expect(left).toEqual({
      [tasks[0].id]: 'considered:deck',
      [tasks[1].id]: 'considered:target',
      [tasks[2].id]: 'considered:done',
    })

    // Without the roster (a native build, the simulator): as before.
    expect(counts(segment('2026-10-22T09:05', 'days', false))).toBe('0 of 72')
  })

  test('TQ-R02: a consider raises N, M stays; handled rows are not duplicated by an Undo', () => {
    const tasks = daysTasks(5)
    expect(counts(segment('2026-10-22T08:00', 'days'))).toBe('0 of 5')
    setClock('2026-10-22T09:00')
    considerTasks(TEST_USER_ID, [tasks[0].id])
    deckTasks({ userId: TEST_USER_ID, timezone: tz, ids: [tasks[1].id], day: '2026-10-23' })
    expect(counts(segment('2026-10-22T09:01', 'days'))).toBe('2 of 5')

    // Undo the deck: the row waits again — listed once, M still 5.
    setClock('2026-10-22T09:02')
    executeUndo(TEST_USER_ID)
    const days = segment('2026-10-22T09:03', 'days')!
    expect(counts(days)).toBe('1 of 5')
    expect(days.tasks.filter((r) => r.task.id === tasks[1].id)).toHaveLength(1)
  })

  test('TQ-R03: a row that left unhandled — trashed — drops out of M', () => {
    const tasks = daysTasks(4)
    expect(counts(segment('2026-10-22T08:00', 'days'))).toBe('0 of 4')
    setClock('2026-10-22T09:00')
    deleteTask({ userId: TEST_USER_ID, taskId: tasks[0].id })
    expect(counts(segment('2026-10-22T09:01', 'days'))).toBe('0 of 3')
  })

  test('TQ-R04: an Upcoming heads-up whose target arrives is not "handled"', () => {
    // A picked target tomorrow: a heads-up row in Upcoming today.
    const t = makeAt('2026-10-20T09:00', {
      title: 'Dentist forms',
      due_at: at('2026-10-23T10:00'),
    })
    expect(segment('2026-10-22T08:00', 'upcoming')?.tasks.map((r) => r.task.id)).toEqual([t.id])
    // Moved (not from a segment, no stamp) to today 9am: over target, out of
    // Upcoming, and not counted as handled there.
    getDb().prepare('UPDATE tasks SET due_at = ? WHERE id = ?').run(at('2026-10-22T09:00'), t.id)
    expect(segment('2026-10-22T09:30', 'upcoming')).toBeUndefined()
  })

  test('TQ-R05: a new day starts a new roster', () => {
    const tasks = daysTasks(3)
    expect(counts(segment('2026-10-22T08:00', 'days'))).toBe('0 of 3')
    setClock('2026-10-22T09:00')
    markDone({ ...u, taskId: tasks[0].id })
    expect(counts(segment('2026-10-22T09:01', 'days'))).toBe('1 of 3')
    // Friday: the done task came round yesterday, not today.
    expect(counts(segment('2026-10-23T08:00', 'days'))).toBe('0 of 2')
  })

  test("TQ-R06: the queue's panel counts a consider that takes a one-off out of the queue", () => {
    // Targeted Wed 16:00, missed: Thursday's 06:30 rollover queues it.
    const t = makeAt('2026-10-21T09:00', {
      title: 'Call the bank',
      horizon: 'days',
      due_at: at('2026-10-21T16:00'),
    })
    const other = makeAt('2026-10-21T09:00', {
      title: 'Email the school',
      horizon: 'days',
      due_at: at('2026-10-21T17:00'),
    })
    getDb()
      .prepare("UPDATE users SET last_rollover_date = '2026-10-21' WHERE id = ?")
      .run(TEST_USER_ID)
    setClock('2026-10-22T06:30')
    runTaskRollover({ now: new Date(), userId: TEST_USER_ID })
    expect(counts(segment('2026-10-22T07:00', 'queue_today'))).toBe('0 of 2')

    setClock('2026-10-22T07:05')
    considerTasks(TEST_USER_ID, [t.id])
    const queue = segment('2026-10-22T07:10', 'queue_today')!
    expect(counts(queue)).toBe('1 of 2')
    expect(queue.tasks.find((r) => r.task.id === t.id)?.left).toBe('considered')
    expect(queue.tasks.find((r) => r.task.id === other.id)?.state).toBe('waiting')

    // The switch off: no queue panel made of remembered rows alone.
    vi.stubEnv('OPENTASK_TASK_QUEUE', '0')
    expect(segment('2026-10-22T07:15', 'queue_today')).toBeUndefined()
  })

  test('TQ-R08: a one-off done, reopened, then decked reads "deck", not "done"', () => {
    const [t] = daysTasks(2)
    expect(counts(segment('2026-10-22T08:00', 'days'))).toBe('0 of 2')
    setClock('2026-10-22T09:00')
    markDone({ ...u, taskId: t.id })
    markUndone({ ...u, taskId: t.id })
    markDone({ ...u, taskId: t.id })
    markUndone({ ...u, taskId: t.id })
    deckTasks({ userId: TEST_USER_ID, timezone: tz, ids: [t.id], day: '2026-10-23' })
    const days = segment('2026-10-22T09:05', 'days')!
    expect(counts(days)).toBe('1 of 2')
    expect(days.tasks.find((r) => r.task.id === t.id)?.left).toBe('deck')
  })

  test('TQ-R07: reading the roster is bookkeeping — no undo entry, no sync event', () => {
    daysTasks(2)
    const undoRows = () =>
      (getDb().prepare('SELECT COUNT(*) AS n FROM undo_log').get() as { n: number }).n
    const before = undoRows()
    vi.mocked(emitSyncEvent).mockClear()
    read('2026-10-22T08:00')
    read('2026-10-22T08:01')
    expect(undoRows()).toBe(before)
    expect(emitSyncEvent).not.toHaveBeenCalled()
  })
})
