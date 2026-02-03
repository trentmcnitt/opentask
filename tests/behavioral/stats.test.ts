/**
 * Stats Behavioral Tests
 *
 * Tests per-task stats (completion_count, snooze_count, etc.) and daily user stats.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTask, getTaskById, markDone } from '@/core/tasks'
import { snoozeTask } from '@/core/tasks/snooze'
import { bulkDone, bulkSnooze } from '@/core/tasks/bulk'
import { executeUndo } from '@/core/undo'
import { getDailyStats, getStatsSummary } from '@/core/stats'
import { DateTime } from 'luxon'
import {
  setupTestDb,
  teardownTestDb,
  localTime,
  TEST_USER_ID,
  TEST_TIMEZONE,
} from '../helpers/setup'

describe('Per-Task Stats Tests', () => {
  beforeEach(() => {
    // Freeze time to Jan 15, 2026 at 10am Chicago (16:00 UTC)
    vi.setSystemTime(new Date('2026-01-15T16:00:00Z'))
    setupTestDb()
  })

  afterEach(() => {
    vi.useRealTimers()
    teardownTestDb()
  })

  test('completion_count increments on mark done', () => {
    // Create recurring task
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Daily task',
        due_at: localTime(8, 0),
        rrule: 'FREQ=DAILY;BYHOUR=8;BYMINUTE=0',
      },
    })

    expect(task.completion_count).toBe(0)

    // Mark done
    const result = markDone({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
    })

    expect(result.task.completion_count).toBe(1)

    // Mark done again
    const result2 = markDone({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
    })

    expect(result2.task.completion_count).toBe(2)
  })

  test('first_completed_at set once on first completion, never changes', () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Daily task',
        due_at: localTime(8, 0),
        rrule: 'FREQ=DAILY;BYHOUR=8;BYMINUTE=0',
      },
    })

    expect(task.first_completed_at).toBeNull()

    // First completion
    const result = markDone({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
    })

    const firstCompletedAt = result.task.first_completed_at
    expect(firstCompletedAt).not.toBeNull()

    // Advance time
    vi.setSystemTime(new Date('2026-01-16T16:00:00Z'))

    // Second completion
    const result2 = markDone({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
    })

    // first_completed_at should not change
    expect(result2.task.first_completed_at).toBe(firstCompletedAt)
    // But last_completed_at should update
    expect(result2.task.last_completed_at).not.toBe(firstCompletedAt)
  })

  test('last_completed_at updates on each completion', () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Daily task',
        due_at: localTime(8, 0),
        rrule: 'FREQ=DAILY;BYHOUR=8;BYMINUTE=0',
      },
    })

    // First completion
    const result = markDone({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
    })

    const firstLastCompletedAt = result.task.last_completed_at

    // Advance time
    vi.setSystemTime(new Date('2026-01-16T16:00:00Z'))

    // Second completion
    const result2 = markDone({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
    })

    // last_completed_at should update
    expect(result2.task.last_completed_at).not.toBe(firstLastCompletedAt)
  })

  test('snooze_count increments only on first snooze', () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Test task',
        due_at: localTime(8, 0),
      },
    })

    expect(task.snooze_count).toBe(0)

    // First snooze
    const result = snoozeTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
      until: localTime(14, 0),
    })

    expect(result.task.snooze_count).toBe(1)

    // Re-snooze (second snooze on same "snooze session")
    const result2 = snoozeTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
      until: localTime(16, 0),
    })

    // Should NOT increment (re-snooze)
    expect(result2.task.snooze_count).toBe(1)
  })

  test('undo decrements completion_count', () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Daily task',
        due_at: localTime(8, 0),
        rrule: 'FREQ=DAILY;BYHOUR=8;BYMINUTE=0',
      },
    })

    // Mark done twice
    markDone({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
    })

    markDone({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
    })

    const afterDone = getTaskById(task.id)!
    expect(afterDone.completion_count).toBe(2)

    // Undo last completion
    executeUndo(TEST_USER_ID)

    const afterUndo = getTaskById(task.id)!
    expect(afterUndo.completion_count).toBe(1)
  })

  test('bulk done increments completion_count for each task', () => {
    const task1 = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Task 1',
        due_at: localTime(8, 0),
        rrule: 'FREQ=DAILY;BYHOUR=8;BYMINUTE=0',
      },
    })

    const task2 = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Task 2',
        due_at: localTime(9, 0),
        rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      },
    })

    bulkDone({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskIds: [task1.id, task2.id],
    })

    const updated1 = getTaskById(task1.id)!
    const updated2 = getTaskById(task2.id)!

    expect(updated1.completion_count).toBe(1)
    expect(updated2.completion_count).toBe(1)
  })

  test('bulk snooze increments snooze_count only for first snooze', () => {
    const task1 = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Task 1',
        due_at: localTime(8, 0),
      },
    })

    const task2 = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Task 2',
        due_at: localTime(9, 0),
      },
    })

    // Snooze task1 first (so it's already snoozed)
    snoozeTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task1.id,
      until: localTime(12, 0),
    })

    const task1AfterFirstSnooze = getTaskById(task1.id)!
    expect(task1AfterFirstSnooze.snooze_count).toBe(1)

    // Now bulk snooze both
    bulkSnooze({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskIds: [task1.id, task2.id],
      until: localTime(14, 0),
    })

    const updated1 = getTaskById(task1.id)!
    const updated2 = getTaskById(task2.id)!

    // task1 was already snoozed, so count should stay 1
    expect(updated1.snooze_count).toBe(1)
    // task2 is getting its first snooze, so count should be 1
    expect(updated2.snooze_count).toBe(1)
  })
})

describe('Daily Stats Tests', () => {
  beforeEach(() => {
    // Freeze time to Jan 15, 2026 at 10am Chicago (16:00 UTC)
    vi.setSystemTime(new Date('2026-01-15T16:00:00Z'))
    setupTestDb()
  })

  afterEach(() => {
    vi.useRealTimers()
    teardownTestDb()
  })

  test('daily stats increment on task creation', () => {
    // Check stats before
    const beforeSummary = getStatsSummary(TEST_USER_ID, TEST_TIMEZONE)
    const beforeCreated = beforeSummary.today?.tasks_created ?? 0

    // Create a task
    createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Test task',
      },
    })

    // Check stats after
    const afterSummary = getStatsSummary(TEST_USER_ID, TEST_TIMEZONE)
    expect(afterSummary.today?.tasks_created).toBe(beforeCreated + 1)
  })

  test('daily stats increment on completion', () => {
    // Create a task (this increments tasks_created)
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'One-off task',
        due_at: localTime(8, 0),
      },
    })

    const beforeSummary = getStatsSummary(TEST_USER_ID, TEST_TIMEZONE)
    const beforeCompletions = beforeSummary.today?.completions ?? 0

    // Mark done
    markDone({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
    })

    const afterSummary = getStatsSummary(TEST_USER_ID, TEST_TIMEZONE)
    expect(afterSummary.today?.completions).toBe(beforeCompletions + 1)
  })

  test('daily stats increment on first snooze only', () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Test task',
        due_at: localTime(8, 0),
      },
    })

    const beforeSummary = getStatsSummary(TEST_USER_ID, TEST_TIMEZONE)
    const beforeSnoozes = beforeSummary.today?.snoozes ?? 0

    // First snooze
    snoozeTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
      until: localTime(12, 0),
    })

    const afterFirstSnooze = getStatsSummary(TEST_USER_ID, TEST_TIMEZONE)
    expect(afterFirstSnooze.today?.snoozes).toBe(beforeSnoozes + 1)

    // Re-snooze
    snoozeTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
      until: localTime(14, 0),
    })

    const afterReSnooze = getStatsSummary(TEST_USER_ID, TEST_TIMEZONE)
    // Should not increment again
    expect(afterReSnooze.today?.snoozes).toBe(beforeSnoozes + 1)
  })

  test('getDailyStats returns stats for date range', () => {
    // Create and complete some tasks
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Recurring task',
        due_at: localTime(8, 0),
        rrule: 'FREQ=DAILY;BYHOUR=8;BYMINUTE=0',
      },
    })

    markDone({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
    })

    // Get today's date in user timezone
    const today = DateTime.now().setZone(TEST_TIMEZONE).toFormat('yyyy-MM-dd')
    const weekAgo = DateTime.now().setZone(TEST_TIMEZONE).minus({ days: 7 }).toFormat('yyyy-MM-dd')

    const stats = getDailyStats(TEST_USER_ID, weekAgo, today)

    // Should have at least one entry for today
    expect(stats.length).toBeGreaterThanOrEqual(1)

    const todayStat = stats.find((s) => s.date === today)
    expect(todayStat).toBeDefined()
    expect(todayStat!.tasks_created).toBeGreaterThanOrEqual(1)
    expect(todayStat!.completions).toBeGreaterThanOrEqual(1)
  })

  test('stats summary aggregates correctly', () => {
    // Create and complete multiple tasks
    for (let i = 0; i < 3; i++) {
      const task = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: {
          title: `Task ${i}`,
          due_at: localTime(8 + i, 0),
          rrule: 'FREQ=DAILY',
        },
      })

      markDone({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        taskId: task.id,
      })
    }

    const summary = getStatsSummary(TEST_USER_ID, TEST_TIMEZONE)

    // Today should have 3 tasks created and 3 completions
    expect(summary.today?.tasks_created).toBe(3)
    expect(summary.today?.completions).toBe(3)

    // Week and month should be at least as much as today
    expect(summary.week.tasks_created).toBeGreaterThanOrEqual(3)
    expect(summary.week.completions).toBeGreaterThanOrEqual(3)
    expect(summary.month.tasks_created).toBeGreaterThanOrEqual(3)
    expect(summary.month.completions).toBeGreaterThanOrEqual(3)
    expect(summary.all_time.tasks_created).toBeGreaterThanOrEqual(3)
    expect(summary.all_time.completions).toBeGreaterThanOrEqual(3)
  })
})
