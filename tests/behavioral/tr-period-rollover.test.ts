/**
 * TR-010..015: the period rollover (REDESIGN-V03 §5).
 *
 * A quota's period ends on its own. At the boundary the period is recorded,
 * a met period is also a completion, the count resets, and the anchor
 * advances. Nothing happens inside a period; missed boundaries are caught up.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { getDb } from '@/core/db'
import { createTask, getTaskById, rolloverTrackedPeriods } from '@/core/tasks'
import { incrementProgress } from '@/core/tasks/progress'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

// Thursday 2026-01-15, 10:00 Chicago.
const THU = new Date('2026-01-15T16:00:00Z')
// Monday 2026-01-19, 00:30 Chicago (06:30 UTC): the week has rolled.
const NEXT_MON = new Date('2026-01-19T06:30:00Z')
// Sunday 2026-01-18, 23:30 Chicago (05:30 UTC Monday): still last week locally.
const SUN_LATE = new Date('2026-01-19T05:30:00Z')

function quota(title: string, target: number, rrule = 'FREQ=WEEKLY') {
  return createTask({
    userId: TEST_USER_ID,
    userTimezone: TEST_TIMEZONE,
    input: { title, rrule, progress_target: target, is_tracked: true },
  })
}
function periods(taskId: number) {
  return getDb()
    .prepare(
      'SELECT period_start, period_end, logged, target, met FROM progress_periods WHERE task_id = ? ORDER BY period_start',
    )
    .all(taskId) as {
    period_start: string
    period_end: string
    logged: number
    target: number
    met: number
  }[]
}
function completions(taskId: number): number {
  return (
    getDb().prepare('SELECT COUNT(*) AS n FROM completions WHERE task_id = ?').get(taskId) as {
      n: number
    }
  ).n
}

describe('Track period rollover', () => {
  beforeEach(() => {
    vi.setSystemTime(THU)
    setupTestDb()
  })
  afterEach(() => {
    vi.useRealTimers()
    teardownTestDb()
  })

  test('TR-010: first sight anchors the quota to the start of its period, records nothing', () => {
    const eggs = quota('Eggs', 2)
    const r = rolloverTrackedPeriods(THU)
    expect(r).toEqual({ anchored: 1, rolled: 0 })
    const row = getDb()
      .prepare('SELECT progress_period_start FROM tasks WHERE id = ?')
      .get(eggs.id) as { progress_period_start: string }
    // Monday 2026-01-12 00:00 Chicago = 06:00 UTC
    expect(row.progress_period_start).toBe('2026-01-12T06:00:00.000Z')
    expect(periods(eggs.id)).toEqual([])
  })

  test('TR-011: inside the period nothing happens; at the boundary a met week is recorded as a completion and the count resets', () => {
    const eggs = quota('Eggs', 2)
    rolloverTrackedPeriods(THU)
    incrementProgress({ userId: TEST_USER_ID, taskId: eggs.id, delta: 1 })
    incrementProgress({ userId: TEST_USER_ID, taskId: eggs.id, delta: 1 })
    incrementProgress({ userId: TEST_USER_ID, taskId: eggs.id, delta: 1 }) // overflow, 3/2

    expect(rolloverTrackedPeriods(SUN_LATE)).toEqual({ anchored: 0, rolled: 0 })
    expect(getTaskById(eggs.id)!.progress_current).toBe(3)

    expect(rolloverTrackedPeriods(NEXT_MON)).toEqual({ anchored: 0, rolled: 1 })
    const after = getTaskById(eggs.id)!
    expect(after.progress_current).toBe(0)
    expect(after.completion_count).toBe(1)
    expect(after.last_completed_at).toBe('2026-01-19T06:00:00.000Z')
    expect(periods(eggs.id)).toEqual([
      {
        period_start: '2026-01-12T06:00:00.000Z',
        period_end: '2026-01-19T06:00:00.000Z',
        logged: 3,
        target: 2,
        met: 1,
      },
    ])
    expect(completions(eggs.id)).toBe(1)
    // Idempotent: the same boundary is not crossed twice.
    expect(rolloverTrackedPeriods(NEXT_MON)).toEqual({ anchored: 0, rolled: 0 })
  })

  test('TR-012: a short period is recorded but is not a completion', () => {
    const swim = quota('Owen Swim', 2)
    rolloverTrackedPeriods(THU)
    incrementProgress({ userId: TEST_USER_ID, taskId: swim.id, delta: 1 })
    rolloverTrackedPeriods(NEXT_MON)
    const after = getTaskById(swim.id)!
    expect(after.progress_current).toBe(0)
    expect(after.completion_count).toBe(0)
    expect(periods(swim.id)[0]).toMatchObject({ logged: 1, target: 2, met: 0 })
    expect(completions(swim.id)).toBe(0)
  })

  test('TR-013: boundaries missed while the server was down are caught up, later ones as zero', () => {
    const eggs = quota('Eggs', 2)
    rolloverTrackedPeriods(THU)
    incrementProgress({ userId: TEST_USER_ID, taskId: eggs.id, delta: 2 })
    // Three weeks later.
    const r = rolloverTrackedPeriods(new Date('2026-02-04T16:00:00Z'))
    expect(r.rolled).toBe(3)
    expect(periods(eggs.id).map((p) => [p.logged, p.met])).toEqual([
      [2, 1],
      [0, 0],
      [0, 0],
    ])
    const row = getDb()
      .prepare('SELECT progress_period_start FROM tasks WHERE id = ?')
      .get(eggs.id) as { progress_period_start: string }
    expect(row.progress_period_start).toBe('2026-02-02T06:00:00.000Z') // Monday Feb 2
  })

  test('TR-014: a monthly quota rolls on the 1st, a daily one at midnight, by the local clock', () => {
    const night = quota('Date night', 1, 'FREQ=MONTHLY')
    const water = quota('Water', 3, 'FREQ=DAILY')
    rolloverTrackedPeriods(THU)
    incrementProgress({ userId: TEST_USER_ID, taskId: night.id, delta: 1 })
    // Friday 00:30 Chicago: the day rolled, the month did not.
    const r1 = rolloverTrackedPeriods(new Date('2026-01-16T06:30:00Z'))
    expect(r1.rolled).toBe(1)
    expect(getTaskById(night.id)!.progress_current).toBe(1)
    expect(getTaskById(water.id)!.progress_current).toBe(0)
    // Feb 1, 00:30 Chicago: the month rolled, met.
    const r2 = rolloverTrackedPeriods(new Date('2026-02-01T06:30:00Z'))
    expect(r2.rolled).toBeGreaterThanOrEqual(1)
    expect(getTaskById(night.id)!.progress_current).toBe(0)
    expect(getTaskById(night.id)!.completion_count).toBe(1)
    expect(periods(night.id)[0]).toMatchObject({
      period_start: '2026-01-01T06:00:00.000Z',
      period_end: '2026-02-01T06:00:00.000Z',
      met: 1,
    })
  })

  test('TR-015: an untracked task and a quota with no period are left alone', () => {
    const plain = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Rent', rrule: 'FREQ=MONTHLY;BYMONTHDAY=1' },
    })
    const open = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Read 10 books', progress_target: 10 },
    })
    rolloverTrackedPeriods(THU)
    rolloverTrackedPeriods(new Date('2026-03-01T16:00:00Z'))
    expect(periods(plain.id)).toEqual([])
    expect(periods(open.id)).toEqual([])
  })
})
