/**
 * TR-030..: `done` on a quota needs `close_period` (2026-09-24).
 *
 * Completing a quota closes its period early and resets `progress_current` to
 * 0. No app surface does it — quota surfaces only log progress — so an API
 * `done` on one almost always meant "+1", and used to silently throw away the
 * period's count. Single done refuses with a pointer to /progress; bulk done
 * skips quotas (one stale id must not abort the batch) and refuses only when
 * nothing else is left. `closePeriod` is the deliberate opt-in.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  createTask,
  getTaskById,
  markDone,
  markUndone,
  bulkDone,
  rolloverTrackedPeriods,
} from '@/core/tasks'
import { getDb } from '@/core/db'
import { incrementProgress } from '@/core/tasks/progress'
import { QUOTA_DONE_MESSAGE } from '@/core/validation'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

const base = { userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE }

function quota(extra: Record<string, unknown> = {}) {
  const q = createTask({
    ...base,
    input: { title: 'Eggs', rrule: 'FREQ=WEEKLY', progress_target: 3, ...extra },
  })
  incrementProgress({ userId: TEST_USER_ID, taskId: q.id })
  incrementProgress({ userId: TEST_USER_ID, taskId: q.id })
  return getTaskById(q.id)!
}

describe('Quota done guard', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-01-15T16:00:00Z'))
    setupTestDb()
  })
  afterEach(() => {
    vi.useRealTimers()
    teardownTestDb()
  })

  test('TR-030: markDone refuses a quota and keeps its count', () => {
    const q = quota()
    expect(() => markDone({ ...base, taskId: q.id })).toThrow(QUOTA_DONE_MESSAGE)
    const after = getTaskById(q.id)!
    expect(after.progress_current).toBe(2)
    expect(after.completion_count).toBe(0)
  })

  test('TR-031: a flag-only (target 1) quota is refused too', () => {
    const q = createTask({
      ...base,
      input: { title: 'Date night', rrule: 'FREQ=MONTHLY', is_tracked: true },
    })
    expect(() => markDone({ ...base, taskId: q.id })).toThrow(QUOTA_DONE_MESSAGE)
  })

  test('TR-032: closePeriod completes it deliberately', () => {
    const q = quota()
    markDone({ ...base, taskId: q.id, closePeriod: true })
    const after = getTaskById(q.id)!
    expect(after.progress_current).toBe(0)
    expect(after.completion_count).toBe(1)
  })

  test('TR-033: bulkDone skips quotas and completes the rest', () => {
    const q = quota()
    const plain = createTask({ ...base, input: { title: 'Plain', due_at: '2026-01-15T13:00:00Z' } })

    const result = bulkDone({ ...base, taskIds: [q.id, plain.id] })

    expect(result.tasksAffected).toBe(1)
    expect(result.quotaSkipped).toBe(1)
    expect(getTaskById(plain.id)!.done).toBe(true)
    expect(getTaskById(q.id)!.progress_current).toBe(2)
  })

  test('TR-034: bulkDone of only quotas is refused', () => {
    const q = quota()
    expect(() => bulkDone({ ...base, taskIds: [q.id] })).toThrow(QUOTA_DONE_MESSAGE)
    expect(getTaskById(q.id)!.progress_current).toBe(2)
  })

  test('TR-035: bulkDone with closePeriod completes quotas too', () => {
    const q = quota()
    const result = bulkDone({ ...base, taskIds: [q.id], closePeriod: true })
    expect(result.tasksAffected).toBe(1)
    expect(result.quotaSkipped).toBe(0)
    expect(getTaskById(q.id)!.progress_current).toBe(0)
  })

  test('TR-036: ordinary tasks are unaffected', () => {
    const plain = createTask({ ...base, input: { title: 'Plain' } })
    const result = markDone({ ...base, taskId: plain.id })
    expect(result.task.done).toBe(true)
  })

  test('TR-037: markUndone refuses a quota and leaves its rollover completion alone', () => {
    // A met week closes into a completions row via the rollover — the row the
    // widgets' DONE list offers to "put back". Putting it back deleted it.
    const q = createTask({
      ...base,
      input: { title: 'Eggs', rrule: 'FREQ=WEEKLY', progress_target: 2 },
    })
    rolloverTrackedPeriods(new Date('2026-01-15T16:00:00Z')) // anchor the week
    incrementProgress({ userId: TEST_USER_ID, taskId: q.id })
    incrementProgress({ userId: TEST_USER_ID, taskId: q.id })
    rolloverTrackedPeriods(new Date('2026-01-19T12:00:00Z')) // next Monday: the met week closes
    expect(getTaskById(q.id)!.completion_count).toBe(1)
    const rows = () =>
      (
        getDb().prepare('SELECT COUNT(*) AS n FROM completions WHERE task_id = ?').get(q.id) as {
          n: number
        }
      ).n
    expect(rows()).toBe(1)

    expect(() => markUndone({ ...base, taskId: q.id })).toThrow(/quota/i)
    expect(rows()).toBe(1)
    expect(getTaskById(q.id)!.completion_count).toBe(1)
  })
})
