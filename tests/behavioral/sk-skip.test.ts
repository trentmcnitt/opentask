/**
 * Skip Occurrence Behavioral Tests (SK-001 through SK-010)
 *
 * Covers REDESIGN-V03 §7.5. The point of skip is that it is NOT a completion:
 * before it existed the user had to either lie (mark done, inflating
 * completion_count) or defer (snooze, re-dating something they'd decided not to
 * do). SK-002 and SK-003 are the tests that protect that.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { getDb } from '@/core/db'
import { createTask, getTaskById, markDone } from '@/core/tasks'
import { skipOccurrence } from '@/core/tasks/skip'
import { incrementProgress } from '@/core/tasks/progress'
import { executeUndo } from '@/core/undo'
import { ValidationError } from '@/core/errors'
import {
  setupTestDb,
  teardownTestDb,
  localTime,
  TEST_TIMEZONE,
  TEST_USER_ID,
} from '../helpers/setup'

describe('Skip occurrence', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-01-15T16:00:00Z'))
    setupTestDb()
  })

  afterEach(() => {
    vi.useRealTimers()
    teardownTestDb()
  })

  function makeRecurring() {
    return createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Daily thing', rrule: 'FREQ=DAILY', due_at: localTime(9, 0) },
    })
  }

  /**
   * SK-001: Skipping a recurring task advances it to the next occurrence.
   */
  test('SK-001: skipping advances a recurring task', () => {
    const task = makeRecurring()
    const { task: after, wasRecurring } = skipOccurrence({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
    })

    expect(wasRecurring).toBe(true)
    expect(new Date(after.due_at!).getTime()).toBeGreaterThan(new Date(task.due_at!).getTime())
  })

  /**
   * SK-002: THE point. completion_count is untouched — this is what stops the
   * user having to lie to clear an item.
   */
  test('SK-002: skipping does NOT increment completion_count', () => {
    const task = makeRecurring()
    skipOccurrence({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: task.id })

    const after = getTaskById(task.id)!
    expect(after.completion_count).toBe(0)
    expect(after.last_completed_at).toBeNull()
  })

  /**
   * SK-003: Skip is counted separately, so honesty is preserved in both
   * directions — completions mean completions, skips are visible as skips.
   */
  test('SK-003: skipping increments skip_count', () => {
    const task = makeRecurring()
    skipOccurrence({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: task.id })
    skipOccurrence({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: task.id })

    expect(getTaskById(task.id)!.skip_count).toBe(2)
  })

  /**
   * SK-004: Completing still works normally and is recorded as a completion —
   * skip adds a path, it doesn't change the existing one.
   */
  test('SK-004: completing after skipping still records a completion', () => {
    const task = makeRecurring()
    skipOccurrence({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: task.id })
    markDone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: task.id })

    const after = getTaskById(task.id)!
    expect(after.completion_count).toBe(1)
    expect(after.skip_count).toBe(1)
  })

  /**
   * SK-005: For a one-off, skip archives without completing — it leaves the
   * active list but was never done.
   */
  test('SK-005: skipping a one-off archives it without completing', () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'One off', due_at: localTime(9, 0) },
    })
    const { wasRecurring } = skipOccurrence({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
    })

    const after = getTaskById(task.id)!
    expect(wasRecurring).toBe(false)
    expect(after.archived_at).not.toBeNull()
    expect(after.done).toBe(false)
    expect(after.completion_count).toBe(0)
  })

  /**
   * SK-006: Undo restores the prior state. VALID_TASK_COLUMNS must contain
   * skip_count or this throws.
   */
  test('SK-006: undo restores due_at and skip_count', () => {
    const task = makeRecurring()
    const originalDue = task.due_at

    skipOccurrence({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: task.id })
    expect(getTaskById(task.id)!.skip_count).toBe(1)

    executeUndo(TEST_USER_ID)

    const after = getTaskById(task.id)!
    expect(after.due_at).toBe(originalDue)
    expect(after.skip_count).toBe(0)
  })

  /**
   * SK-007: Skipping is a period boundary, so a tracked task's progress resets
   * exactly as it would on completion (§5).
   */
  test('SK-007: skipping a tracked recurring task resets progress', () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Eggs',
        rrule: 'FREQ=WEEKLY;BYDAY=TH',
        due_at: localTime(9, 0),
        progress_target: 2,
      },
    })
    incrementProgress({ userId: TEST_USER_ID, taskId: task.id })
    expect(getTaskById(task.id)!.progress_current).toBe(1)

    skipOccurrence({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: task.id })
    expect(getTaskById(task.id)!.progress_current).toBe(0)
  })

  /**
   * SK-008: A skip is logged to activity as 'skip', never as 'complete'.
   */
  test('SK-008: activity records skip, not complete', () => {
    const task = makeRecurring()
    skipOccurrence({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: task.id })

    const rows = getDb()
      .prepare('SELECT action FROM activity_log WHERE task_id = ? ORDER BY id DESC')
      .all(task.id) as { action: string }[]

    expect(rows[0].action).toBe('skip')
    expect(rows.map((r) => r.action)).not.toContain('complete')
  })

  /**
   * SK-009: A trashed task can't be skipped — skip is a decision about an
   * active occurrence.
   */
  test('SK-009: skipping a trashed task is rejected', () => {
    const task = makeRecurring()
    getDb()
      .prepare('UPDATE tasks SET deleted_at = ? WHERE id = ?')
      .run(new Date().toISOString(), task.id)

    expect(() =>
      skipOccurrence({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: task.id }),
    ).toThrow(ValidationError)
  })

  /**
   * SK-010: Bulk-skipping is expected and must work repeatedly without
   * corrupting state. Per L1 nothing may be inferred from the pattern.
   */
  test('SK-010: repeated skips accumulate cleanly', () => {
    const task = makeRecurring()
    for (let i = 0; i < 5; i++) {
      skipOccurrence({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: task.id })
    }
    const after = getTaskById(task.id)!
    expect(after.skip_count).toBe(5)
    expect(after.completion_count).toBe(0)
  })
})
