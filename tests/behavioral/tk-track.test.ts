/**
 * Track / Quota Behavioral Tests (TK-001 through TK-014)
 *
 * Covers REDESIGN-V03 §5. The decisive behavior is period-anchored at-target
 * (TK-004..TK-007): reaching the target marks the row "met" but does NOT
 * complete it, so overflow stays observable and the period boundary owns the
 * reset. The rejected alternative — auto-complete at target — made the third
 * egg meal in a 2x/week target impossible to record.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { getDb } from '@/core/db'
import { createTask, getTaskById, updateTask, markDone } from '@/core/tasks'
import { incrementProgress, computePace, isTracked } from '@/core/tasks/progress'
import { executeUndo } from '@/core/undo'
import { ValidationError } from '@/core/errors'
import {
  setupTestDb,
  teardownTestDb,
  localTime,
  TEST_TIMEZONE,
  TEST_USER_ID,
} from '../helpers/setup'

function makeTracked(target = 2, extra: Record<string, unknown> = {}) {
  return createTask({
    userId: TEST_USER_ID,
    userTimezone: TEST_TIMEZONE,
    input: { title: 'Eggs', progress_target: target, ...extra },
  })
}

describe('Track (quotas)', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-01-15T16:00:00Z'))
    setupTestDb()
  })

  afterEach(() => {
    vi.useRealTimers()
    teardownTestDb()
  })

  /**
   * TK-001: Opting in is just setting a target above 1 — no separate flag.
   */
  test('TK-001: setting progress_target > 1 makes a task tracked', () => {
    const task = makeTracked(3)
    expect(task.progress_target).toBe(3)
    expect(task.progress_current).toBe(0)
    expect(isTracked(task)).toBe(true)
  })

  /**
   * TK-002: Every ordinary task is a quota with target 1, and is not "tracked".
   */
  test('TK-002: an ordinary task defaults to target 1 and is not tracked', () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Plain' },
    })
    expect(task.progress_target).toBe(1)
    expect(isTracked(task)).toBe(false)
  })

  /**
   * TK-003: +1 records progress.
   */
  test('TK-003: incrementing raises progress_current', () => {
    const task = makeTracked(2)
    const result = incrementProgress({ userId: TEST_USER_ID, taskId: task.id })
    expect(result.task.progress_current).toBe(1)
    expect(result.met).toBe(false)
    expect(getTaskById(task.id)!.progress_current).toBe(1)
  })

  /**
   * TK-004: Reaching the target reports "met"...
   */
  test('TK-004: reaching the target reports met', () => {
    const task = makeTracked(2)
    incrementProgress({ userId: TEST_USER_ID, taskId: task.id })
    const result = incrementProgress({ userId: TEST_USER_ID, taskId: task.id })
    expect(result.met).toBe(true)
  })

  /**
   * TK-005: ...but does NOT complete the task. This is the period-anchored
   * decision. Auto-completing here would close the row at 2/2 and make the
   * third log impossible.
   */
  test('TK-005: reaching the target does NOT complete the task', () => {
    const task = makeTracked(2)
    incrementProgress({ userId: TEST_USER_ID, taskId: task.id })
    incrementProgress({ userId: TEST_USER_ID, taskId: task.id })

    const after = getTaskById(task.id)!
    expect(after.done).toBe(false)
    expect(after.completion_count).toBe(0)
  })

  /**
   * TK-006: Overflow past target is recorded and observable (3/2).
   */
  test('TK-006: progress can exceed the target and stays visible', () => {
    const task = makeTracked(2)
    incrementProgress({ userId: TEST_USER_ID, taskId: task.id })
    incrementProgress({ userId: TEST_USER_ID, taskId: task.id })
    const third = incrementProgress({ userId: TEST_USER_ID, taskId: task.id })

    expect(third.task.progress_current).toBe(3)
    expect(third.description).toBe('3/2')
  })

  /**
   * TK-007: The period boundary owns the reset. Completing a recurring tracked
   * task advances the occurrence AND zeroes progress — that advance IS the
   * period rolling over.
   */
  test('TK-007: completing a recurring tracked task resets progress at the boundary', () => {
    const task = makeTracked(2, { rrule: 'FREQ=WEEKLY;BYDAY=TH', due_at: localTime(9, 0) })
    incrementProgress({ userId: TEST_USER_ID, taskId: task.id })
    incrementProgress({ userId: TEST_USER_ID, taskId: task.id })
    expect(getTaskById(task.id)!.progress_current).toBe(2)

    markDone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: task.id })

    const after = getTaskById(task.id)!
    expect(after.progress_current).toBe(0)
    expect(after.completion_count).toBe(1)
    // Still open — recurring tasks advance rather than closing.
    expect(after.done).toBe(false)
  })

  /**
   * TK-008: An explicit complete-tap before the boundary still completes early.
   * The user is never prevented from closing something out.
   */
  test('TK-008: an explicit completion before target still completes', () => {
    const task = makeTracked(5)
    incrementProgress({ userId: TEST_USER_ID, taskId: task.id })

    markDone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: task.id })
    expect(getTaskById(task.id)!.completion_count).toBe(1)
  })

  /**
   * TK-009: A negative delta corrects a mis-log, but progress never goes below
   * zero — a correction can't manufacture negative history.
   */
  test('TK-009: progress cannot go below zero', () => {
    const task = makeTracked(3)
    incrementProgress({ userId: TEST_USER_ID, taskId: task.id })
    const result = incrementProgress({ userId: TEST_USER_ID, taskId: task.id, delta: -5 })
    expect(result.task.progress_current).toBe(0)
  })

  /**
   * TK-010: Untracked tasks reject progress — the +1 affordance is meaningless
   * on a target-1 task, and silently accepting it would create a second,
   * invisible completion path.
   */
  test('TK-010: incrementing an untracked task is rejected', () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Plain' },
    })
    expect(() => incrementProgress({ userId: TEST_USER_ID, taskId: task.id })).toThrow(
      ValidationError,
    )
  })

  /**
   * TK-011: Every increment is logged for undo, and undo restores the count.
   * VALID_TASK_COLUMNS must contain progress_current or this 500s.
   */
  test('TK-011: undo restores the previous progress count', () => {
    const task = makeTracked(3)
    incrementProgress({ userId: TEST_USER_ID, taskId: task.id })
    incrementProgress({ userId: TEST_USER_ID, taskId: task.id })
    expect(getTaskById(task.id)!.progress_current).toBe(2)

    executeUndo(TEST_USER_ID)
    expect(getTaskById(task.id)!.progress_current).toBe(1)
  })

  /**
   * TK-012: Increments are recorded as events for pace math.
   */
  test('TK-012: increments write progress_events rows', () => {
    const task = makeTracked(2)
    incrementProgress({ userId: TEST_USER_ID, taskId: task.id })
    incrementProgress({ userId: TEST_USER_ID, taskId: task.id })

    const rows = getDb()
      .prepare('SELECT COUNT(*) as c FROM progress_events WHERE task_id = ?')
      .get(task.id) as { c: number }
    expect(rows.c).toBe(2)
  })

  /**
   * TK-013: Pace is deterministic view logic. Behind means the shortfall is
   * real — but callers must treat it as information, not failure: per L1 a low
   * count late in a period may mean UNLOGGED, not undone.
   */
  test('TK-013: pace reports behind, on-pace, and met', () => {
    expect(computePace({ progress_current: 0, progress_target: 4 }, 0.9).state).toBe('behind')
    expect(computePace({ progress_current: 3, progress_target: 4 }, 0.5).state).toBe('on-pace')
    expect(computePace({ progress_current: 4, progress_target: 4 }, 0.5).state).toBe('met')
    // Overflow still reads as met, never as an error state.
    expect(computePace({ progress_current: 6, progress_target: 4 }, 1).state).toBe('met')
  })

  /**
   * TK-014: With no period to measure, pace never accuses. An instrument that
   * treats "no information" as failure is broken (§1.2).
   */
  test('TK-014: pace with no measurable period is never behind', () => {
    expect(computePace({ progress_current: 0, progress_target: 4 }, null).state).toBe('on-pace')
  })

  /**
   * TK-015: A tracked task is exempt from the notification cadence (§5), so it
   * never appears in the currently-due set that drives the notifier and badge.
   */
  test('TK-015: tracked tasks are excluded from the currently-due set', async () => {
    const { getCurrentlyDueTaskIds } = await import('@/core/tasks/currently-due')

    const plain = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Plain overdue', due_at: localTime(8, 0) },
    })
    const tracked = makeTracked(2, { due_at: localTime(8, 0) })

    const due = getCurrentlyDueTaskIds(TEST_USER_ID)
    expect(due).toContain(plain.id)
    expect(due).not.toContain(tracked.id)
  })

  /**
   * TK-016: Track can be turned on for an existing task via PATCH.
   */
  test('TK-016: progress_target can be set on an existing task', () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Becomes tracked' },
    })
    const { task: updated } = updateTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
      input: { progress_target: 4 },
    })
    expect(updated.progress_target).toBe(4)
    expect(isTracked(updated)).toBe(true)
  })
})
