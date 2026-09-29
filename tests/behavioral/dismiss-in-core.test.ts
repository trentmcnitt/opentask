/**
 * Notification dismissal lives in the core mutations (decision D11, 2026-09-29).
 *
 * Each route used to call `dismissNotificationsForTasks` / `syncBadgeCount`
 * itself, and the routes drifted: bulk edit never dismissed a moved date,
 * restore never resynced the badge, and bulk snooze dismissed every posted id
 * — including a P4 it had skipped, which is still overdue. These tests pin
 * which ids each core mutation hands to the dismiss module.
 *
 * The dismiss module is mocked, so nothing is sent; only the calls are read.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('@/core/notifications/dismiss', () => ({
  dismissNotificationsForTasks: vi.fn(),
  syncBadgeCount: vi.fn(),
}))

import { dismissNotificationsForTasks, syncBadgeCount } from '@/core/notifications/dismiss'
import {
  createTask,
  updateTask,
  deleteTask,
  restoreTask,
  markDone,
  snoozeTask,
  bulkDone,
  bulkSnooze,
  bulkEdit,
  bulkDelete,
} from '@/core/tasks'
import { skipOccurrence } from '@/core/tasks/skip'
import { executeUndo } from '@/core/undo'
import {
  setupTestDb,
  teardownTestDb,
  localTime,
  TEST_USER_ID,
  TEST_TIMEZONE,
} from '../helpers/setup'

const dismiss = vi.mocked(dismissNotificationsForTasks)
const badge = vi.mocked(syncBadgeCount)

const base = { userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE }

function task(title: string, dueAt: string | null, extra: Record<string, unknown> = {}) {
  return createTask({ ...base, input: { title, due_at: dueAt, ...extra } })
}

/** Every id passed to `dismissNotificationsForTasks` since the last clear. */
function dismissedIds(): number[] {
  return dismiss.mock.calls.flatMap(([, ids]) => ids)
}

describe('notification dismissal in core mutations', () => {
  beforeEach(() => {
    // 10am Chicago: localTime(8) is two hours overdue, localTime(12) is ahead.
    vi.setSystemTime(new Date('2026-01-15T16:00:00Z'))
    setupTestDb()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    teardownTestDb()
  })

  test('bulkEdit dismisses only the tasks whose date moved', () => {
    const a = task('A', localTime(8))
    const b = task('B', localTime(8))
    dismiss.mockClear()

    // Priority on both, the date on A alone.
    bulkEdit({
      ...base,
      taskIds: [a.id, b.id],
      changes: { priority: 2, due_at: localTime(12) },
      dateTaskIds: [a.id],
    })
    expect(dismissedIds()).toEqual([a.id])
  })

  test('bulkEdit with no date change dismisses nothing', () => {
    const a = task('A', localTime(8))
    dismiss.mockClear()

    bulkEdit({ ...base, taskIds: [a.id], changes: { priority: 1 } })
    expect(dismissedIds()).toEqual([])
  })

  test('bulkSnooze dismisses the moved tasks, not a skipped Urgent one', () => {
    const low = task('Low', localTime(8))
    const urgent = task('Urgent', localTime(8), { priority: 4 })
    dismiss.mockClear()

    const result = bulkSnooze({ ...base, taskIds: [low.id, urgent.id], until: localTime(12) })
    expect(result.snoozedIds).toEqual([low.id])
    expect(dismissedIds()).toEqual([low.id])
  })

  test('bulkSnooze works the badge out from dueBeforeIds when until is in the future', () => {
    const low = task('Low', localTime(8))
    const urgent = task('Urgent', localTime(8), { priority: 4 })
    dismiss.mockClear()

    bulkSnooze({
      ...base,
      taskIds: [low.id, urgent.id],
      until: localTime(12),
      dueBeforeIds: [low.id, urgent.id],
    })
    // The Urgent task did not move, so one task is still overdue.
    expect(dismiss).toHaveBeenCalledWith(TEST_USER_ID, [low.id], 1)
  })

  test('bulkSnooze measures the badge when until is in the past', () => {
    const low = task('Low', localTime(8))
    dismiss.mockClear()

    bulkSnooze({ ...base, taskIds: [low.id], until: localTime(9), dueBeforeIds: [low.id] })
    expect(dismiss).toHaveBeenCalledWith(TEST_USER_ID, [low.id], undefined)
  })

  test('bulkSnooze that moves nothing dismisses nothing', () => {
    const urgent = task('Urgent', localTime(8), { priority: 4 })
    dismiss.mockClear()

    bulkSnooze({ ...base, taskIds: [urgent.id], until: localTime(12) })
    expect(dismissedIds()).toEqual([])
  })

  test('updateTask dismisses on a date change but not on a title edit', () => {
    const a = task('A', localTime(8))
    dismiss.mockClear()

    updateTask({ ...base, taskId: a.id, input: { title: 'A renamed' } })
    expect(dismissedIds()).toEqual([])

    updateTask({ ...base, taskId: a.id, input: { due_at: localTime(12) } })
    expect(dismissedIds()).toEqual([a.id])
  })

  test('snoozeTask dismisses exactly once', () => {
    const a = task('A', localTime(8))
    dismiss.mockClear()

    snoozeTask({ ...base, taskId: a.id, until: localTime(12) })
    expect(dismiss).toHaveBeenCalledTimes(1)
    expect(dismissedIds()).toEqual([a.id])
  })

  test('markDone, bulkDone, skipOccurrence, deleteTask and bulkDelete dismiss their tasks', () => {
    const one = task('One', localTime(8))
    const two = task('Two', localTime(8))
    const three = task('Three', localTime(8))
    const four = task('Four', localTime(8))
    const daily = task('Daily', localTime(8), { rrule: 'FREQ=DAILY;BYHOUR=8;BYMINUTE=0' })
    dismiss.mockClear()

    markDone({ ...base, taskId: one.id })
    bulkDone({ ...base, taskIds: [two.id] })
    skipOccurrence({ ...base, taskId: daily.id })
    deleteTask({ userId: TEST_USER_ID, taskId: three.id })
    bulkDelete({ userId: TEST_USER_ID, taskIds: [four.id] })

    expect(dismissedIds()).toEqual([one.id, two.id, daily.id, three.id, four.id])
  })

  test('createTask resyncs the badge only for a task born overdue', () => {
    task('Later', localTime(12))
    expect(badge).not.toHaveBeenCalled()

    task('Already late', localTime(8))
    expect(badge).toHaveBeenCalledTimes(1)
  })

  test('restoreTask resyncs the badge', () => {
    const a = task('A', localTime(8))
    deleteTask({ userId: TEST_USER_ID, taskId: a.id })
    badge.mockClear()

    restoreTask({ userId: TEST_USER_ID, taskId: a.id })
    expect(badge).toHaveBeenCalledWith(TEST_USER_ID)
  })

  test('undo resyncs the badge', () => {
    const a = task('A', localTime(8))
    snoozeTask({ ...base, taskId: a.id, until: localTime(12) })
    badge.mockClear()

    executeUndo(TEST_USER_ID)
    expect(badge).toHaveBeenCalledWith(TEST_USER_ID)
  })
})
