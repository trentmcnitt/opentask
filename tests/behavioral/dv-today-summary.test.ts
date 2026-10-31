/**
 * Today's all-clear card's counts (2026-10-30, `src/core/tasks/today-summary.ts`):
 * of the tasks that were in Late or Today during this OpenTask day, how many
 * were done and how many moved to tomorrow.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { getDb } from '@/core/db'
import { createTask, markDone, markUndone } from '@/core/tasks'
import { snoozeTask } from '@/core/tasks/snooze'
import { todaySummary } from '@/core/tasks/today-summary'
import { setupTestDb, TEST_USER_ID, TEST_TIMEZONE } from '../helpers/setup'

const DAY_START = '03:00'
// Friday 2026-01-16, 4:00 PM Chicago.
const NOW = '2026-01-16T22:00:00Z'
const chicago = (local: string) => new Date(`${local}-06:00`).toISOString()

function task(title: string, dueLocal: string | null, extra: Record<string, unknown> = {}) {
  return createTask({
    userId: TEST_USER_ID,
    userTimezone: TEST_TIMEZONE,
    input: { title, ...(dueLocal ? { due_at: chicago(dueLocal) } : {}), ...extra },
  })
}
const summary = () => todaySummary(TEST_USER_ID, TEST_TIMEZONE, DAY_START, new Date(NOW))

describe('today summary', () => {
  beforeEach(() => {
    setupTestDb()
    vi.setSystemTime(new Date(NOW))
  })
  afterEach(() => vi.useRealTimers())

  test('done: an occurrence due by the end of today; a future one, an undone one and a reminder do not count', () => {
    markDone({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task('late', '2026-01-15T10:00').id,
    })
    markDone({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task('today', '2026-01-16T20:00').id,
    })
    markDone({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task('next week', '2026-01-23T10:00').id,
    })
    const undone = task('undone', '2026-01-16T09:00')
    markDone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: undone.id })
    markUndone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: undone.id })
    const reminder = task('reminder', '2026-01-16T09:00', {
      is_reminder: true,
      rrule: 'FREQ=DAILY',
    })
    markDone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: reminder.id })
    expect(summary().done).toBe(2)
  })

  test('moved to tomorrow: out of today onto tomorrow; not one moved further, nor one already tomorrow', () => {
    const late = task('late', '2026-01-15T10:00')
    snoozeTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: late.id,
      until: chicago('2026-01-17T09:00'),
    })
    const today = task('today', '2026-01-16T18:00')
    snoozeTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: today.id,
      until: chicago('2026-01-17T12:00'),
    })
    const further = task('further', '2026-01-16T11:00')
    snoozeTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: further.id,
      until: chicago('2026-01-23T09:00'),
    })
    const already = task('already tomorrow', '2026-01-17T08:00')
    snoozeTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: already.id,
      until: chicago('2026-01-17T10:00'),
    })
    // The activity log's `created_at` is SQLite's own 'now' (the real clock,
    // not the frozen one): stamp this test's rows at the frozen instant.
    getDb().prepare('UPDATE activity_log SET created_at = ?').run(NOW)
    expect(summary()).toEqual({ done: 0, moved: 2 })
  })

  test('a quiet day: nothing done, nothing moved', () => {
    task('later', '2026-01-20T09:00')
    expect(summary()).toEqual({ done: 0, moved: 0 })
  })
})
