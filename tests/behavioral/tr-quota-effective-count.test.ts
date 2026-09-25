/**
 * TR-040..: a quota's count belongs to its period, even in the minutes before
 * the rollover cron notices the period ended (quota-reminders red team,
 * 2026-09-24).
 *
 * - `effectiveProgress` reads an expired period as 0.
 * - `incrementProgress` closes an expired period inline first, so a +1 at
 *   00:02 lands in today's period instead of being recorded as yesterday's
 *   and zeroed three minutes later.
 * - `progress_events` records the delta that was APPLIED, not the one asked
 *   for — a −1 at zero changes nothing and logs nothing.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { getDb } from '@/core/db'
import { createTask, getTaskById, rolloverTrackedPeriods } from '@/core/tasks'
import { incrementProgress } from '@/core/tasks/progress'
import { effectiveProgress } from '@/lib/track'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

// Thursday 2026-01-15, 10:00 Chicago.
const THU_10AM = new Date('2026-01-15T16:00:00Z')
// Friday 2026-01-16, 00:02 Chicago — the day has turned, the cron has not run.
const FRI_0002 = new Date('2026-01-16T06:02:00Z')

function quota(rrule: string, target = 2) {
  return createTask({
    userId: TEST_USER_ID,
    userTimezone: TEST_TIMEZONE,
    input: { title: 'Walks', rrule, progress_target: target, is_tracked: true },
  })
}

function events(taskId: number): number[] {
  return (
    getDb()
      .prepare('SELECT delta FROM progress_events WHERE task_id = ? ORDER BY id')
      .all(taskId) as { delta: number }[]
  ).map((r) => r.delta)
}

describe('Quota effective count', () => {
  beforeEach(() => {
    vi.setSystemTime(THU_10AM)
    setupTestDb()
  })
  afterEach(() => {
    vi.useRealTimers()
    teardownTestDb()
  })

  test('TR-040: an expired period reads as 0; a live one reads its count', () => {
    const q = quota('FREQ=DAILY')
    rolloverTrackedPeriods(THU_10AM)
    incrementProgress({ userId: TEST_USER_ID, taskId: q.id })
    const task = getTaskById(q.id)!
    expect(effectiveProgress(task, TEST_TIMEZONE, THU_10AM)).toBe(1)
    expect(effectiveProgress(task, TEST_TIMEZONE, FRI_0002)).toBe(0)
  })

  test('TR-041: no anchor yet means nothing has expired', () => {
    const q = quota('FREQ=WEEKLY')
    getDb().prepare('UPDATE tasks SET progress_current = 3 WHERE id = ?').run(q.id)
    expect(effectiveProgress(getTaskById(q.id)!, TEST_TIMEZONE, FRI_0002)).toBe(3)
  })

  test('TR-042: INTERVAL is honoured — every other day does not expire at the first midnight', () => {
    const q = quota('FREQ=DAILY;INTERVAL=2')
    rolloverTrackedPeriods(THU_10AM)
    incrementProgress({ userId: TEST_USER_ID, taskId: q.id })
    const task = getTaskById(q.id)!
    expect(effectiveProgress(task, TEST_TIMEZONE, FRI_0002)).toBe(1)
    expect(effectiveProgress(task, TEST_TIMEZONE, new Date('2026-01-17T06:02:00Z'))).toBe(0)
  })

  test('TR-043: a +1 just after midnight lands in today, and yesterday is recorded as it was', () => {
    const q = quota('FREQ=DAILY')
    rolloverTrackedPeriods(THU_10AM)
    incrementProgress({ userId: TEST_USER_ID, taskId: q.id })
    incrementProgress({ userId: TEST_USER_ID, taskId: q.id })

    vi.setSystemTime(FRI_0002)
    const { task } = incrementProgress({ userId: TEST_USER_ID, taskId: q.id })
    expect(task.progress_current).toBe(1)

    // The cron arriving later finds nothing left to close.
    expect(rolloverTrackedPeriods(new Date('2026-01-16T06:05:00Z')).rolled).toBe(0)
    expect(getTaskById(q.id)!.progress_current).toBe(1)

    const closed = getDb()
      .prepare('SELECT logged, met FROM progress_periods WHERE task_id = ?')
      .all(q.id) as { logged: number; met: number }[]
    expect(closed).toEqual([{ logged: 2, met: 1 }])
  })

  test('TR-044: progress_events records the applied delta; a clamped −1 records nothing', () => {
    const q = quota('FREQ=WEEKLY')
    incrementProgress({ userId: TEST_USER_ID, taskId: q.id, delta: -1 })
    expect(getTaskById(q.id)!.progress_current).toBe(0)
    expect(events(q.id)).toEqual([])

    incrementProgress({ userId: TEST_USER_ID, taskId: q.id, delta: 2 })
    incrementProgress({ userId: TEST_USER_ID, taskId: q.id, delta: -5 })
    expect(getTaskById(q.id)!.progress_current).toBe(0)
    expect(events(q.id)).toEqual([2, -2])
  })
})
