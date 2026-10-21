/**
 * SN-100..: explicit reschedule vs snooze, and the due_at guard gaps
 * (2026-09-24; revised 2026-10-12).
 *
 * Since 2026-10-12 (§6, ruling Q4) there is ONE gesture: every date change of
 * a dated task is a move of its target, and a move keeps the first-target
 * date (`original_due_at`). There is no snooze state (`snooze_count`,
 * `is_snoozed`) and no snooze/re-target split: the picker's
 * `reset_original_due_at: true` is accepted and ignored on a task. On a
 * REMINDER it is still the explicit reschedule (a reminder is never moved).
 *
 * Also here: `{ rrule, due_at }` honors the date (it used to be dropped at
 * 200), a bare `{ due_at }` on a dated reminder is refused like any other
 * reminder snooze, and `skipOccurrence` refuses reminders.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { DateTime } from 'luxon'
import { createTask, getTaskById, updateTask, bulkSnooze, bulkEdit } from '@/core/tasks'
import { snoozeTask } from '@/core/tasks/snooze'
import { skipOccurrence } from '@/core/tasks/skip'
import { executeUndo, executeRedo } from '@/core/undo'
import { formatTaskResponse } from '@/lib/format-task'
import { REMINDER_SNOOZE_MESSAGE } from '@/core/validation'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

// Thursday Jan 15 2026, 10:00 Chicago.
const NOW = new Date('2026-01-15T16:00:00Z')

/** A Chicago wall-clock time `days` after NOW's local date, as UTC ISO. */
function at(hour: number, days = 0, minute = 0): string {
  return DateTime.fromJSDate(NOW)
    .setZone(TEST_TIMEZONE)
    .plus({ days })
    .set({ hour, minute, second: 0, millisecond: 0 })
    .toUTC()
    .toISO()!
}

const base = { userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE }

function snoozedTask(title = 'Call the plumber') {
  const task = createTask({ ...base, input: { title, due_at: at(9, 1) } })
  snoozeTask({ ...base, taskId: task.id, until: at(14, 1) })
  const snoozed = getTaskById(task.id)!
  // Sanity: a move keeps the first-target date, and records nothing else.
  expect(snoozed.original_due_at).toBe(at(9, 1))
  expect(snoozed).not.toHaveProperty('snooze_count')
  return snoozed
}

describe('Explicit reschedule vs snooze', () => {
  beforeEach(() => {
    vi.setSystemTime(NOW)
    setupTestDb()
  })
  afterEach(() => {
    vi.useRealTimers()
    teardownTestDb()
  })

  test('SN-100: a freshly created dated task carries no snooze state', () => {
    const task = createTask({ ...base, input: { title: 'Fresh', due_at: at(9, 1) } })
    // createTask sets the origin to the first due date.
    expect(task.original_due_at).toBe(task.due_at)
    const formatted = formatTaskResponse(task, TEST_TIMEZONE)
    expect(formatted).not.toHaveProperty('is_snoozed')
    expect(formatted).not.toHaveProperty('snooze_count')
  })

  test('SN-101: a picked date (reset_original_due_at + due_at) is a move like any other', () => {
    const snoozed = snoozedTask()
    const picked = at(11, 3)

    const { task, description } = updateTask({
      ...base,
      taskId: snoozed.id,
      input: { due_at: picked, reset_original_due_at: true },
    })

    expect(task.due_at).toBe(picked)
    // The flag is ignored on a task: the first-target date stays.
    expect(task.original_due_at).toBe(at(9, 1))
    expect(description).toMatch(/^Deferred to/)
  })

  test('SN-102: undo of a picked date restores the target; redo re-applies it', () => {
    const snoozed = snoozedTask()

    updateTask({
      ...base,
      taskId: snoozed.id,
      input: { due_at: at(11, 3), reset_original_due_at: true },
    })
    executeUndo(TEST_USER_ID)

    const restored = getTaskById(snoozed.id)!
    expect(restored.due_at).toBe(snoozed.due_at)
    expect(restored.original_due_at).toBe(snoozed.original_due_at)

    executeRedo(TEST_USER_ID)
    const redone = getTaskById(snoozed.id)!
    expect(redone.due_at).toBe(at(11, 3))
    expect(redone.original_due_at).toBe(at(9, 1))
  })

  test('SN-103: a bare PATCH { due_at } is a move and keeps the origin', () => {
    // The quick panel's +1h / preset buttons and the iOS content extension's
    // "snooze to a specific time" both send exactly this.
    const snoozed = snoozedTask()

    const { task, description } = updateTask({
      ...base,
      taskId: snoozed.id,
      input: { due_at: at(16, 1) },
    })

    expect(task.due_at).toBe(at(16, 1))
    expect(task.original_due_at).toBe(at(9, 1))
    expect(description).toMatch(/defer/i)
  })

  test('SN-104: the snooze endpoint and bulk snooze keep the origin', () => {
    const one = snoozedTask('One')
    snoozeTask({ ...base, taskId: one.id, until: at(17, 1) })
    expect(getTaskById(one.id)!.original_due_at).toBe(at(9, 1))

    const two = snoozedTask('Two')
    bulkSnooze({ ...base, taskIds: [two.id], until: at(18, 1), includeTaskIds: [two.id] })
    const afterBulk = getTaskById(two.id)!
    expect(afterBulk.due_at).toBe(at(18, 1))
    expect(afterBulk.original_due_at).toBe(at(9, 1))
  })

  test('SN-105: a snooze after a picked date still counts from the FIRST target', () => {
    const snoozed = snoozedTask()
    updateTask({
      ...base,
      taskId: snoozed.id,
      input: { due_at: at(11, 3), reset_original_due_at: true },
    })
    snoozeTask({ ...base, taskId: snoozed.id, until: at(15, 3) })
    const after = getTaskById(snoozed.id)!
    expect(after.due_at).toBe(at(15, 3))
    expect(after.original_due_at).toBe(at(9, 1))
  })

  test('SN-106: picking a first date for an undated task sets it as the origin once', () => {
    const task = createTask({ ...base, input: { title: 'Someday' } })
    const { task: after, fieldsChanged } = updateTask({
      ...base,
      taskId: task.id,
      input: { due_at: at(9, 2), reset_original_due_at: true },
    })
    expect(after.due_at).toBe(at(9, 2))
    expect(after.original_due_at).toBe(at(9, 2))
    // One entry per field — the reset and the first-date branch both set it.
    expect(fieldsChanged.filter((f) => f === 'original_due_at')).toHaveLength(1)
  })
})

describe('PATCH with rrule and due_at together', () => {
  beforeEach(() => {
    vi.setSystemTime(NOW)
    setupTestDb()
  })
  afterEach(() => {
    vi.useRealTimers()
    teardownTestDb()
  })

  test('SN-110: the explicit date is honored, anchors follow it, and it is not a snooze', () => {
    const task = createTask({ ...base, input: { title: 'Water plants', due_at: at(8, 1) } })
    // Monday Jan 19, 18:30 Chicago.
    const monday = at(18, 4, 30)

    const { task: after, fieldsChanged } = updateTask({
      ...base,
      taskId: task.id,
      input: { rrule: 'FREQ=WEEKLY;BYDAY=MO', due_at: monday },
    })

    // The timeless rule takes the time of the date sent with it (2026-10-12).
    expect(after.rrule).toBe('FREQ=WEEKLY;BYDAY=MO;BYHOUR=18;BYMINUTE=30')
    expect(after.due_at).toBe(monday)
    expect(after.anchor_time).toBe('18:30')
    expect(fieldsChanged).toContain('due_at')
    // A new schedule starts clean — same as clearing recurrence with a date:
    // the old origin goes, and the date sent is the scheduled occurrence (§6).
    expect(after.original_due_at).toBeNull()
    expect(after.occurrence_at).toBe(monday)

    // Undo puts the old date and the one-off shape back.
    executeUndo(TEST_USER_ID)
    const undone = getTaskById(task.id)!
    expect(undone.rrule).toBeNull()
    expect(undone.due_at).toBe(at(8, 1))
    expect(undone.anchor_time).toBeNull()
  })

  test('SN-111: bulk edit with { due_at, rrule } applies the date too', () => {
    const task = createTask({ ...base, input: { title: 'Bulk', due_at: at(8, 0) } })
    const when = at(18, 1)
    bulkEdit({
      ...base,
      taskIds: [task.id],
      changes: { due_at: when, rrule: 'FREQ=DAILY;BYHOUR=18;BYMINUTE=0' },
    })
    const after = getTaskById(task.id)!
    expect(after.due_at).toBe(when)
    expect(after.occurrence_at).toBe(when)
    expect(after.original_due_at).toBeNull()
  })

  test('SN-112: without an explicit date, an rrule change still computes one', () => {
    const task = createTask({ ...base, input: { title: 'Auto', due_at: at(8, 1) } })
    const { task: after } = updateTask({
      ...base,
      taskId: task.id,
      input: { rrule: 'FREQ=DAILY;BYHOUR=20;BYMINUTE=0' },
    })
    expect(after.due_at).toBe(at(20, 0))
  })
})

describe('Reminder due_at guards', () => {
  beforeEach(() => {
    vi.setSystemTime(NOW)
    setupTestDb()
  })
  afterEach(() => {
    vi.useRealTimers()
    teardownTestDb()
  })

  function reminder(extra: Record<string, unknown> = {}) {
    return createTask({
      ...base,
      input: { title: 'Stretch', is_reminder: true, rrule: 'FREQ=DAILY', due_at: at(7), ...extra },
    })
  }

  test('SN-120: a bare PATCH { due_at } on a dated reminder is refused as a snooze', () => {
    const r = reminder()
    expect(() => updateTask({ ...base, taskId: r.id, input: { due_at: at(12) } })).toThrow(
      REMINDER_SNOOZE_MESSAGE,
    )
    const after = getTaskById(r.id)!
    expect(after.due_at).toBe(at(7))
    expect(after.original_due_at).toBe(at(7))
  })

  test('SN-121: an explicit reschedule of a reminder is allowed', () => {
    const r = reminder()
    const { task } = updateTask({
      ...base,
      taskId: r.id,
      input: { due_at: at(12), reset_original_due_at: true },
    })
    expect(task.due_at).toBe(at(12))
    // The reschedule makes the new date the origin, and a reminder's date IS
    // its occurrence.
    expect(task.original_due_at).toBe(at(12))
    expect(task.occurrence_at).toBe(at(12))
  })

  test('SN-122: giving an undated reminder its first date is not a snooze', () => {
    const r = reminder({ rrule: null, due_at: null })
    const { task } = updateTask({ ...base, taskId: r.id, input: { due_at: at(12) } })
    expect(task.due_at).toBe(at(12))
  })

  test('SN-123: converting to a reminder and snoozing in one request is refused', () => {
    const t = createTask({ ...base, input: { title: 'Plain', due_at: at(7) } })
    expect(() =>
      updateTask({ ...base, taskId: t.id, input: { is_reminder: true, due_at: at(12) } }),
    ).toThrow(REMINDER_SNOOZE_MESSAGE)
    expect(getTaskById(t.id)!.is_reminder).toBe(false)
  })

  test('SN-124: skipOccurrence refuses a reminder', () => {
    const r = reminder()
    expect(() => skipOccurrence({ ...base, taskId: r.id })).toThrow(/Reminders cannot be skipped/)
    const after = getTaskById(r.id)!
    expect(after.due_at).toBe(at(7))
    expect(after.skip_count).toBe(0)
  })
})
