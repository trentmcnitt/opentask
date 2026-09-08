/**
 * TR-010..019: a quota is not a task (REDESIGN-V03 §5, Trent 2026-09-08).
 *
 * It appears on the Quotas page and in the Track panel and nowhere else, it has
 * no due date, and it cannot be snoozed. `due_at` on a quota was vestigial —
 * the period is carried by `progress_period_start` — but it was still a real
 * date, so a quota read as overdue debt in every count and offered a snooze
 * grid it could not honour.
 *
 * The sibling to compare against is the reminder carve-out (§6), which these
 * rules are deliberately shaped like.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTask, getTaskById, updateTask, snoozeTask, bulkEdit } from '@/core/tasks'
import { clearQuotaDueDates, getDb } from '@/core/db'
import { ValidationError } from '@/core/errors'
import { QUOTA_DUE_DATE_MESSAGE } from '@/core/validation'
import { effectiveDueAt } from '@/core/recurrence/occurrence'
import { isTracked } from '@/lib/track'
import { countTasks } from '@/lib/task-counts'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

/** Frozen so "tomorrow" and "this week" mean the same thing on every run. */
const NOW = new Date('2026-01-15T16:00:00Z')

function makeQuota(overrides: Record<string, unknown> = {}) {
  return createTask({
    userId: TEST_USER_ID,
    userTimezone: TEST_TIMEZONE,
    input: { title: 'Eat beef', rrule: 'FREQ=WEEKLY', progress_target: 4, ...overrides },
  })
}

describe('A quota has no due date', () => {
  beforeEach(() => {
    vi.setSystemTime(NOW)
    setupTestDb()
  })
  afterEach(() => {
    vi.useRealTimers()
    teardownTestDb()
  })

  test('TR-010: creating a quota never stamps a due date', () => {
    const byTarget = makeQuota()
    expect(getTaskById(byTarget.id)!.due_at).toBeNull()
    expect(getTaskById(byTarget.id)!.original_due_at).toBeNull()

    // The other way of being a quota: an explicit flag with a target of 1.
    const byFlag = makeQuota({
      title: 'Date night',
      rrule: 'FREQ=MONTHLY',
      progress_target: 1,
      is_tracked: true,
    })
    expect(getTaskById(byFlag.id)!.due_at).toBeNull()

    // With no rule at all there is nothing to compute from either.
    const ruleless = makeQuota({ title: 'Read', rrule: null })
    expect(getTaskById(ruleless.id)!.due_at).toBeNull()
  })

  test('TR-011: an ordinary recurring task still gets its first occurrence', () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Water the plants', rrule: 'FREQ=WEEKLY;BYDAY=MO' },
    })
    // The guard is narrow: only tracked rows lose the computed date.
    expect(getTaskById(task.id)!.due_at).not.toBeNull()
  })

  test('TR-012: a due date cannot be given to a quota, at create or at update', () => {
    expect(() => makeQuota({ due_at: NOW.toISOString() })).toThrow(ValidationError)
    expect(() => makeQuota({ due_at: NOW.toISOString() })).toThrow(QUOTA_DUE_DATE_MESSAGE)

    const quota = makeQuota()
    expect(() =>
      updateTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        taskId: quota.id,
        input: { due_at: NOW.toISOString() },
      }),
    ).toThrow(QUOTA_DUE_DATE_MESSAGE)

    // Converting a task into a quota in the same request that dates it is the
    // same contradiction, and is refused the same way.
    const plain = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Call mom' },
    })
    expect(() =>
      updateTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        taskId: plain.id,
        input: { is_tracked: true, due_at: NOW.toISOString() },
      }),
    ).toThrow(QUOTA_DUE_DATE_MESSAGE)
  })

  test('TR-013: converting a dated task into a quota clears its date', () => {
    const plain = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Go for a walk', due_at: NOW.toISOString() },
    })
    expect(getTaskById(plain.id)!.due_at).not.toBeNull()

    updateTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: plain.id,
      input: { is_tracked: true, progress_target: 3, rrule: 'FREQ=WEEKLY' },
    })

    const after = getTaskById(plain.id)!
    expect(isTracked(after)).toBe(true)
    expect(after.due_at).toBeNull()
    // `original_due_at` goes too, or `is_snoozed` stays true on a row that
    // cannot be snoozed.
    expect(after.original_due_at).toBeNull()
  })

  test('TR-014: a quota cannot be snoozed', () => {
    const quota = makeQuota()
    expect(() =>
      snoozeTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        taskId: quota.id,
        until: new Date(NOW.getTime() + 3_600_000).toISOString(),
      }),
    ).toThrow(ValidationError)
  })

  test('TR-015: retiring a quota takes its period rule with it', () => {
    const quota = makeQuota()
    expect(getTaskById(quota.id)!.rrule).toBe('FREQ=WEEKLY')

    // `is_tracked: false` alone. A bare FREQ left behind on an untracked task
    // with no due_at is evaluated as a schedule, and rrule.js places a bare
    // weekly rule on an arbitrary weekday — the task would surface on a day
    // nobody chose.
    updateTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: quota.id,
      input: { is_tracked: false, progress_target: 1 },
    })

    const retired = getTaskById(quota.id)!
    expect(isTracked(retired)).toBe(false)
    expect(retired.rrule).toBeNull()
    expect(retired.anchor_time).toBeNull()
    expect(retired.anchor_dow).toBeNull()
    expect(effectiveDueAt(retired, TEST_TIMEZONE, NOW)).toBeNull()
  })

  test('TR-016: retiring a quota and dating it in one request keeps the date', () => {
    const quota = makeQuota()
    const when = new Date(NOW.getTime() + 86_400_000).toISOString()

    // Retiring injects `rrule: null`, which makes this look to the collector
    // like a schedule change — the path that otherwise drops an explicit date.
    updateTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: quota.id,
      input: { is_tracked: false, progress_target: 1, due_at: when },
    })

    const after = getTaskById(quota.id)!
    expect(isTracked(after)).toBe(false)
    expect(after.rrule).toBeNull()
    expect(after.due_at).toBe(when)
  })

  test('TR-017: bulk edit retires a quota the same way', () => {
    const one = makeQuota({ title: 'Quota one' })
    const two = makeQuota({ title: 'Quota two' })

    bulkEdit({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskIds: [one.id, two.id],
      changes: { is_tracked: false, progress_target: 1 },
    })

    for (const id of [one.id, two.id]) {
      const after = getTaskById(id)!
      expect(isTracked(after)).toBe(false)
      expect(after.rrule).toBeNull()
    }
  })

  test('TR-018: the startup migration clears stored quota dates, idempotently', () => {
    const quota = makeQuota()
    // Write a date straight past the core, the way the pre-2026-09-08 corpus
    // holds one: every quota carried a leftover from the life it had before.
    getDb()
      .prepare('UPDATE tasks SET due_at = ?, original_due_at = ? WHERE id = ?')
      .run(NOW.toISOString(), NOW.toISOString(), quota.id)
    const plain = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Untracked', due_at: NOW.toISOString() },
    })

    clearQuotaDueDates(getDb())
    expect(getTaskById(quota.id)!.due_at).toBeNull()
    expect(getTaskById(quota.id)!.original_due_at).toBeNull()
    // It touches quotas only.
    expect(getTaskById(plain.id)!.due_at).toBe(NOW.toISOString())

    // Second run changes nothing.
    clearQuotaDueDates(getDb())
    expect(getTaskById(quota.id)!.due_at).toBeNull()
    expect(getTaskById(plain.id)!.due_at).toBe(NOW.toISOString())
  })

  test('TR-019: with no date, a quota cannot reach the counts at all', () => {
    const quota = makeQuota()
    const stored = getTaskById(quota.id)!
    // Two independent reasons now: no due_at, and the explicit tracked guard.
    expect(countTasks([stored], TEST_TIMEZONE, NOW)).toEqual({ total: 1, overdue: 0, today: 0 })
  })
})
