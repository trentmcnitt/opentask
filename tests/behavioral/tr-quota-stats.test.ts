/**
 * TR-090..: a quota's record (`getQuotaStats`, `GET /api/tasks/:id/quota-stats`).
 *
 * The chip's bubble shows periods met, periods missed and the streak since the
 * Quotas page's Details list went (2026-10-16). All of it comes from
 * `progress_periods`, the rows the period rollover writes for every closed
 * period — so these tests drive the real rollover day by day rather than
 * inserting rows by hand.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTask, rolloverTrackedPeriods } from '@/core/tasks'
import { incrementProgress } from '@/core/tasks/progress'
import { getQuotaStats } from '@/core/tasks/quotas'
import { getDb } from '@/core/db'
import {
  setupTestDb,
  seedTestProject,
  seedTestUser,
  teardownTestDb,
  TEST_TIMEZONE,
  TEST_USER_ID,
} from '../helpers/setup'

const base = { userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE }

/** Noon in Chicago on 2026-01-<day>. */
const noon = (day: number) => new Date(`2026-01-${String(day).padStart(2, '0')}T18:00:00Z`)

/**
 * A daily quota of one, made on Jan 10, then lived through one day per entry
 * of `days` (true = met that day). The rollover closes each day the morning
 * after, so every entry becomes a recorded period.
 */
function liveDays(days: boolean[]): number {
  vi.setSystemTime(noon(10))
  const q = createTask({
    ...base,
    input: { title: 'Stretch', rrule: 'FREQ=DAILY', progress_target: 1, is_tracked: true },
  })
  rolloverTrackedPeriods(noon(10)) // anchors Jan 10 — the first period is not recorded
  days.forEach((met, i) => {
    const day = 11 + i
    vi.setSystemTime(noon(day))
    rolloverTrackedPeriods(noon(day)) // closes the day before
    if (met) incrementProgress({ userId: TEST_USER_ID, taskId: q.id })
  })
  // Close the last lived day.
  const after = noon(11 + days.length)
  vi.setSystemTime(after)
  rolloverTrackedPeriods(after)
  return q.id
}

describe('Quota stats', () => {
  beforeEach(() => {
    setupTestDb()
  })
  afterEach(() => {
    vi.useRealTimers()
    teardownTestDb()
  })

  test('TR-090: a new quota has no record yet', () => {
    vi.setSystemTime(noon(10))
    const q = createTask({
      ...base,
      input: { title: 'Read', rrule: 'FREQ=WEEKLY', progress_target: 3 },
    })
    expect(getQuotaStats(TEST_USER_ID, q.id)).toEqual({
      periods_met: 0,
      periods_missed: 0,
      current_streak: 0,
      longest_streak: 0,
      last_logged_at: null,
    })
  })

  test('TR-091: met and missed add up to the closed periods; the streak counts back from the latest', () => {
    const id = liveDays([true, true, false, true, true, true, false, true, true])
    const rows = getDb()
      .prepare('SELECT COUNT(*) AS n FROM progress_periods WHERE task_id = ?')
      .get(id) as { n: number }
    const stats = getQuotaStats(TEST_USER_ID, id)
    expect(stats.periods_met + stats.periods_missed).toBe(rows.n)
    expect(stats.periods_met).toBe(7)
    expect(stats.current_streak).toBe(2)
    expect(stats.longest_streak).toBe(3)
  })

  test('TR-092: the latest period missed means no current streak, but the best one stays', () => {
    const id = liveDays([true, true, true, false])
    const stats = getQuotaStats(TEST_USER_ID, id)
    expect(stats.current_streak).toBe(0)
    expect(stats.longest_streak).toBe(3)
    expect(stats.periods_met).toBe(3)
  })

  test('TR-093: not a quota → 400; someone else’s quota → 403; no such task → 404', () => {
    vi.setSystemTime(noon(10))
    const plain = createTask({ ...base, input: { title: 'Plain task' } })
    expect(() => getQuotaStats(TEST_USER_ID, plain.id)).toThrow('Not a quota')

    seedTestUser(2, 'other@example.com')
    seedTestProject(900, 'Inbox', 2)
    const theirs = createTask({
      userId: 2,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Theirs', rrule: 'FREQ=WEEKLY', progress_target: 2 },
    })
    expect(() => getQuotaStats(TEST_USER_ID, theirs.id)).toThrow('Access denied')
    expect(() => getQuotaStats(TEST_USER_ID, 999_999)).toThrow('Task not found')
  })
})
