/**
 * GT-001..: `getTasks` filters behind GET /api/tasks (2026-09-24).
 *
 * - `kind` narrows to one population (task / reminder / quota), in SQL, so it
 *   applies before pagination.
 * - `overdue` is the badge's set (`getCurrentlyDueTaskIds`), not a bare
 *   `due_at < now`: reminders (§6) and quotas (§5) are never overdue, and a
 *   recurring task's due-ness comes from its schedule.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTask, getTasks } from '@/core/tasks'
import { getCurrentlyDueTaskIds } from '@/core/tasks/currently-due'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

const NOW = new Date('2026-01-15T16:00:00Z') // 10:00 Chicago
const PAST = '2026-01-15T13:00:00.000Z' // 07:00 Chicago
const FUTURE = '2026-01-16T15:00:00.000Z'

const base = { userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE }

function seed() {
  const overdueTask = createTask({ ...base, input: { title: 'Overdue task', due_at: PAST } })
  const futureTask = createTask({ ...base, input: { title: 'Future task', due_at: FUTURE } })
  const reminder = createTask({
    ...base,
    input: { title: 'Past reminder', due_at: PAST, rrule: 'FREQ=DAILY', is_reminder: true },
  })
  const quota = createTask({
    ...base,
    input: { title: 'Quota', rrule: 'FREQ=WEEKLY', progress_target: 3 },
  })
  const flagQuota = createTask({
    ...base,
    input: { title: 'Flag quota', rrule: 'FREQ=MONTHLY', is_tracked: true },
  })
  return { overdueTask, futureTask, reminder, quota, flagQuota }
}

const ids = (tasks: { id: number }[]) => tasks.map((t) => t.id).sort((a, b) => a - b)

describe('getTasks filters', () => {
  beforeEach(() => {
    vi.setSystemTime(NOW)
    setupTestDb()
  })
  afterEach(() => {
    vi.useRealTimers()
    teardownTestDb()
  })

  test('GT-001: kind narrows to one population', () => {
    const s = seed()
    expect(ids(getTasks({ userId: TEST_USER_ID, kind: 'task' }))).toEqual(
      ids([s.overdueTask, s.futureTask]),
    )
    expect(ids(getTasks({ userId: TEST_USER_ID, kind: 'reminder' }))).toEqual(ids([s.reminder]))
    // Both ways of being a quota: target > 1, and the flag alone.
    expect(ids(getTasks({ userId: TEST_USER_ID, kind: 'quota' }))).toEqual(
      ids([s.quota, s.flagQuota]),
    )
    // No kind = everything, as before.
    expect(getTasks({ userId: TEST_USER_ID })).toHaveLength(5)
  })

  test('GT-002: kind applies before pagination', () => {
    const s = seed()
    // Quotas sort last (no due_at → NULLS LAST); a post-filter over the first
    // page would find none of them.
    const page = getTasks({ userId: TEST_USER_ID, kind: 'quota', limit: 1 })
    expect(page).toHaveLength(1)
    expect([s.quota.id, s.flagQuota.id]).toContain(page[0].id)
    const next = getTasks({ userId: TEST_USER_ID, kind: 'quota', limit: 1, offset: 1 })
    expect(next).toHaveLength(1)
    expect(next[0].id).not.toBe(page[0].id)
  })

  test('GT-003: overdue is the badge set — no reminders, no quotas', () => {
    const s = seed()
    const overdue = getTasks({ userId: TEST_USER_ID, overdue: true })
    expect(ids(overdue)).toEqual([s.overdueTask.id])
    expect(ids(overdue)).toEqual(ids(getCurrentlyDueTaskIds(TEST_USER_ID).map((id) => ({ id }))))
  })

  test('GT-004: overdue follows the schedule for a recurring task', () => {
    // A daily 09:00 task whose stored due_at is still yesterday's is due now
    // (it carries debt); one whose next occurrence is tomorrow is not.
    const late = createTask({
      ...base,
      input: { title: 'Daily 9am', rrule: 'FREQ=DAILY', due_at: '2026-01-14T15:00:00.000Z' },
    })
    createTask({
      ...base,
      input: { title: 'Daily 5pm tomorrow', rrule: 'FREQ=DAILY', due_at: FUTURE },
    })
    expect(ids(getTasks({ userId: TEST_USER_ID, overdue: true }))).toEqual([late.id])
  })

  test('GT-005: overdue combines with kind and returns nothing when nothing is due', () => {
    seed()
    expect(getTasks({ userId: TEST_USER_ID, overdue: true, kind: 'reminder' })).toEqual([])
    expect(getTasks({ userId: TEST_USER_ID, overdue: true, kind: 'quota' })).toEqual([])
  })
})
