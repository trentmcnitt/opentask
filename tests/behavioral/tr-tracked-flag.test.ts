/**
 * TR-001..004: the explicit tracked flag (REDESIGN-V03 §5).
 *
 * A quota with a target of 1 ("date night, once a month") can't be told apart
 * from an ordinary task by its target, so `is_tracked` marks it. A bare period
 * rule ("FREQ=MONTHLY") is a quota's rule and is only valid on a tracked task.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTask, getTaskById, updateTask } from '@/core/tasks'
import { isTracked } from '@/core/tasks/progress'
import { getCurrentlyDueTaskIds } from '@/core/tasks/currently-due'
import { validateTaskCreate, validateTaskUpdate } from '@/core/validation'
import { PERIOD_RULE_MESSAGE, TRACKED_REMINDER_MESSAGE } from '@/core/validation/task'
import { groupByTimeSlot, trackedItems } from '@/lib/slot-view'
import { ZodError } from 'zod'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

const NOW = new Date('2026-01-15T16:00:00Z')

function messages(fn: () => unknown): string[] {
  try {
    fn()
    return []
  } catch (err) {
    if (err instanceof ZodError) return err.issues.map((i) => i.message)
    throw err
  }
}

describe('Tracked flag', () => {
  beforeEach(() => {
    vi.setSystemTime(NOW)
    setupTestDb()
  })
  afterEach(() => {
    vi.useRealTimers()
    teardownTestDb()
  })

  test('TR-001: a bare period rule is valid only on a tracked task', () => {
    expect(
      messages(() =>
        validateTaskCreate({ title: 'Date night', rrule: 'FREQ=MONTHLY', is_tracked: true }),
      ),
    ).toEqual([])
    expect(
      messages(() =>
        validateTaskCreate({ title: 'Eggs', rrule: 'FREQ=WEEKLY', progress_target: 2 }),
      ),
    ).toEqual([])
    expect(messages(() => validateTaskCreate({ title: 'Rent', rrule: 'FREQ=MONTHLY' }))).toContain(
      PERIOD_RULE_MESSAGE,
    )
    expect(messages(() => validateTaskUpdate({ rrule: 'FREQ=MONTHLY' }))).toContain(
      PERIOD_RULE_MESSAGE,
    )
    expect(messages(() => validateTaskUpdate({ rrule: 'FREQ=MONTHLY', is_tracked: true }))).toEqual(
      [],
    )
  })

  test('TR-002: tracked and reminder stay mutually exclusive, flag included', () => {
    expect(
      messages(() => validateTaskCreate({ title: 'x', is_tracked: true, is_reminder: true })),
    ).toContain(TRACKED_REMINDER_MESSAGE)
  })

  test('TR-003: a target-1 quota is tracked, lives in the panel, and stays out of the day and the due count', () => {
    const night = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Date night',
        rrule: 'FREQ=MONTHLY',
        is_tracked: true,
        due_at: NOW.toISOString(),
      },
    })
    const stored = getTaskById(night.id)!
    expect(stored.is_tracked).toBe(true)
    expect(stored.progress_target).toBe(1)
    expect(isTracked(stored)).toBe(true)

    expect(trackedItems([stored]).map((t) => t.id)).toEqual([night.id])
    expect(groupByTimeSlot([stored], [], TEST_TIMEZONE, NOW)).toEqual([])
    expect(getCurrentlyDueTaskIds(TEST_USER_ID, NOW)).not.toContain(night.id)
  })

  test('TR-004: the flag can be set and cleared by an update', () => {
    const plain = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Call mom' },
    })
    expect(getTaskById(plain.id)!.is_tracked).toBe(false)
    updateTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: plain.id,
      input: { is_tracked: true, rrule: 'FREQ=MONTHLY' },
    })
    expect(getTaskById(plain.id)!.is_tracked).toBe(true)
    updateTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: plain.id,
      input: { is_tracked: false, rrule: null },
    })
    expect(getTaskById(plain.id)!.is_tracked).toBe(false)
  })
})
