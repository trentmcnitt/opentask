/**
 * Reminders Surface Behavioral Tests (RM-001 through RM-014)
 *
 * Covers REDESIGN-V03 §6. Reminders are prompted thoughts, not actions, and
 * they differ BEHAVIOURALLY from tasks — which is why they get a surface rather
 * than a tag. The load-bearing property is that they carry NO DEBT: RM-004
 * through RM-007 are the tests that enforce it.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { getDb } from '@/core/db'
import { createTask, getTaskById, updateTask, bulkSnooze } from '@/core/tasks'
import { snoozeTask } from '@/core/tasks/snooze'
import { getTodaysReminders, getRemindersBySlot } from '@/core/tasks/reminders'
import { getCurrentlyDueTaskIds } from '@/core/tasks/currently-due'
import { getOverdueCount } from '@/core/notifications/dismiss'
import { validateTaskCreate } from '@/core/validation'
import { executeUndo } from '@/core/undo'
import { ValidationError } from '@/core/errors'
import { ZodError } from 'zod'
import {
  setupTestDb,
  teardownTestDb,
  localTime,
  TEST_TIMEZONE,
  TEST_USER_ID,
} from '../helpers/setup'

function makeReminder(overrides: Record<string, unknown> = {}) {
  return createTask({
    userId: TEST_USER_ID,
    userTimezone: TEST_TIMEZONE,
    input: {
      title: 'Depressed = Past, Anxious = Future',
      is_reminder: true,
      rrule: 'FREQ=DAILY',
      due_at: localTime(7, 0),
      ...overrides,
    },
  })
}

describe('Reminders surface', () => {
  beforeEach(() => {
    // Thursday 2026-01-15, 10:00 local
    vi.setSystemTime(new Date('2026-01-15T16:00:00Z'))
    setupTestDb()
  })

  afterEach(() => {
    vi.useRealTimers()
    teardownTestDb()
  })

  /**
   * RM-001: The flag is a real column, not a label (§7.1 — kind is never
   * stored as a name).
   */
  test('RM-001: is_reminder round-trips as a boolean column', () => {
    const reminder = makeReminder()
    expect(reminder.is_reminder).toBe(true)
    expect(getTaskById(reminder.id)!.is_reminder).toBe(true)

    const plain = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Plain' },
    })
    expect(plain.is_reminder).toBe(false)
  })

  /**
   * RM-002: §5 and §6 are mutually exclusive — an item is tracked or a
   * reminder, never both. They pull in opposite directions.
   */
  test('RM-002: a task cannot be both tracked and a reminder', () => {
    expect(() =>
      validateTaskCreate({ title: 'Both', is_reminder: true, progress_target: 3 }),
    ).toThrow(ZodError)
  })

  /**
   * RM-003: Either alone is fine.
   */
  test('RM-003: tracked-only and reminder-only both validate', () => {
    expect(() => validateTaskCreate({ title: 'Tracked', progress_target: 3 })).not.toThrow()
    expect(() => validateTaskCreate({ title: 'Reminder', is_reminder: true })).not.toThrow()
  })

  /**
   * RM-004: NO DEBT — a reminder is never counted as due, however overdue its
   * due_at looks. This is what stops the Reminders population inflating the
   * very overdue pile the redesign exists to shrink.
   */
  test('RM-004: reminders never appear in the currently-due set', () => {
    const reminder = makeReminder({ due_at: localTime(7, 0) })
    const plain = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Real task', due_at: localTime(7, 0) },
    })

    const due = getCurrentlyDueTaskIds(TEST_USER_ID)
    expect(due).toContain(plain.id)
    expect(due).not.toContain(reminder.id)
  })

  /**
   * RM-005: ...and therefore never reach the badge.
   */
  test('RM-005: reminders are excluded from the badge count', () => {
    makeReminder({ due_at: localTime(7, 0) })
    expect(getOverdueCount(TEST_USER_ID)).toBe(0)

    createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Real task', due_at: localTime(7, 0) },
    })
    expect(getOverdueCount(TEST_USER_ID)).toBe(1)
  })

  /**
   * RM-006: Bucket-locked — a reminder cannot be snoozed out of its slot. It
   * stays visible until completed, because completion ("I considered it") is
   * the entire interaction.
   */
  test('RM-006: snoozing a reminder is rejected', () => {
    const reminder = makeReminder()
    expect(() =>
      snoozeTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        taskId: reminder.id,
        until: localTime(20, 0),
      }),
    ).toThrow(ValidationError)
  })

  /**
   * RM-007: A bulk sweep skips reminders SILENTLY and reports a count — §4.3
   * forbids bulk paths from modal-blocking, and per L1 sweep participation
   * carries no per-item intent worth confirming.
   */
  test('RM-007: bulk snooze skips reminders and reports the count', () => {
    const reminder = makeReminder({ due_at: localTime(7, 0) })
    const plain = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Real task', due_at: localTime(7, 0), priority: 1 },
    })

    const result = bulkSnooze({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskIds: [reminder.id, plain.id],
      until: localTime(20, 0),
    })

    expect(result.tasksAffected).toBe(1)
    expect(result.reminderSkipped).toBe(1)
    expect(getTaskById(reminder.id)!.due_at).toBe(localTime(7, 0))
  })

  /**
   * RM-008: include_task_ids does NOT rescue a reminder — the constraint is
   * about what a reminder IS, not how deliberately it was picked.
   */
  test('RM-008: an explicit selection still cannot snooze a reminder', () => {
    const reminder = makeReminder({ due_at: localTime(7, 0) })

    const result = bulkSnooze({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskIds: [reminder.id],
      until: localTime(20, 0),
      includeTaskIds: [reminder.id],
    })

    expect(result.tasksAffected).toBe(0)
    expect(result.reminderSkipped).toBe(1)
  })

  /**
   * RM-009: Today's reminders are derived from the schedule (§4.6), so one
   * scheduled for another day simply isn't shown — no debt accrues.
   */
  test('RM-009: a reminder not scheduled today is not in today list', () => {
    // 2026-01-15 is a Thursday.
    const today = makeReminder({ rrule: 'FREQ=WEEKLY;BYDAY=TH', anchor_time: '07:00' })
    const otherDay = makeReminder({ rrule: 'FREQ=WEEKLY;BYDAY=MO', title: 'Monday thought' })

    const ids = getTodaysReminders(TEST_USER_ID, TEST_TIMEZONE).map((t) => t.id)
    expect(ids).toContain(today.id)
    expect(ids).not.toContain(otherDay.id)
  })

  /**
   * RM-010: Completed reminders drop out of the bucket rather than sitting
   * there greyed out — leaving them would bury the ones still worth
   * considering.
   */
  test('RM-010: completed reminders leave the bucket', () => {
    const reminder = makeReminder()
    expect(getTodaysReminders(TEST_USER_ID, TEST_TIMEZONE).map((t) => t.id)).toContain(reminder.id)

    getDb().prepare('UPDATE tasks SET done = 1 WHERE id = ?').run(reminder.id)
    expect(getTodaysReminders(TEST_USER_ID, TEST_TIMEZONE).map((t) => t.id)).not.toContain(
      reminder.id,
    )
  })

  /**
   * RM-011: Reminders group into the SAME time slots the dashboard uses, so
   * "morning" means one thing across the app.
   */
  test('RM-011: reminders group by time slot', () => {
    makeReminder({ anchor_time: '07:00', due_at: localTime(7, 0) })
    makeReminder({ title: 'Evening thought', anchor_time: '20:30', due_at: localTime(20, 30) })

    const groups = getRemindersBySlot(TEST_USER_ID, TEST_TIMEZONE)
    const morning = groups.find((g) => g.slot?.label === 'Early morning')
    const evening = groups.find((g) => g.slot?.label === 'Evening')

    expect(morning?.reminders).toHaveLength(1)
    expect(evening?.reminders).toHaveLength(1)
  })

  /**
   * RM-012: Priority is PROMINENCE, not interruption — within a slot, higher
   * priority sorts first. The canonical high-priority reminder is important
   * without being an interrupt.
   */
  test('RM-012: higher priority sorts first within a slot', () => {
    makeReminder({ title: 'Low thought', anchor_time: '07:00', priority: 0 })
    makeReminder({ title: 'Supplements', anchor_time: '07:00', priority: 3 })

    const morning = getRemindersBySlot(TEST_USER_ID, TEST_TIMEZONE).find(
      (g) => g.slot?.label === 'Early morning',
    )
    expect(morning?.reminders[0].title).toBe('Supplements')
  })

  /**
   * RM-013: A high-priority reminder STILL never notifies. Priority changes
   * position, never interruption — that is the §6 carve-out in one assertion.
   */
  test('RM-013: even an urgent reminder never becomes due', () => {
    makeReminder({ priority: 4, due_at: localTime(7, 0) })
    expect(getCurrentlyDueTaskIds(TEST_USER_ID)).toHaveLength(0)
  })

  /**
   * RM-014: An existing task can be moved onto the surface, and undo restores
   * it. VALID_TASK_COLUMNS must contain is_reminder or the undo throws.
   */
  test('RM-014: toggling is_reminder is undoable', () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Becomes a reminder' },
    })

    updateTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
      input: { is_reminder: true },
    })
    expect(getTaskById(task.id)!.is_reminder).toBe(true)

    executeUndo(TEST_USER_ID)
    expect(getTaskById(task.id)!.is_reminder).toBe(false)
  })
})
