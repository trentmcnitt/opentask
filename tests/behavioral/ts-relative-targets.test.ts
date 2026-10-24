/**
 * TS-RT: a reminder period's retime and delete carry the RELATIVE TARGETS
 * linked to it (2026-10-24; docs/TASK-MODEL.md § Relative targets; plan §2),
 * inside the period's own transaction and its one undo entry:
 *  - retime: an OPEN linked row follows the period (a one-off re-derives its
 *    target; a deadline-anchored repeat its unmoved one, a moved one kept),
 *    without restamping `target_set_at` but checkpointing attempts; a row
 *    the new time would be refused for is unlinked and keeps its old time;
 *    CLOSED rows (done, archived, trashed) move their `target_time` only, in
 *    one compare-and-set statement undo and redo mirror;
 *  - delete: linked rows keep the period's start as a custom time; undo
 *    re-links them, redo unlinks again.
 * Default periods (setupTestDb): Early morning 07:00, Morning 09:00, Midday
 * 12:00, Afternoon 16:00, Evening 20:30. America/Chicago.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { DateTime } from 'luxon'
import { getDb } from '@/core/db'
import { createTask, markDone, snoozeTask } from '@/core/tasks'
import { getTaskById } from '@/core/tasks/read'
import { executeRedo, executeUndo } from '@/core/undo'
import { listTimeSlots } from '@/core/time-slots'
import { deleteTimeSlot, retimeDescription, updateTimeSlot } from '@/core/time-slots/edit'
import {
  seedTestProject,
  seedTestUser,
  setupTestDb,
  teardownTestDb,
  TEST_TIMEZONE,
  TEST_USER_ID,
} from '../helpers/setup'

const tz = TEST_TIMEZONE
const u = { userId: TEST_USER_ID, userTimezone: tz }
function at(local: string): string {
  return DateTime.fromISO(local, { zone: tz }).toUTC().toISO()!
}
function setClock(local: string) {
  vi.setSystemTime(new Date(at(local)))
}
function evening() {
  return listTimeSlots(TEST_USER_ID).find((s) => s.label === 'Evening')!
}
function linked(deadlineLocal: string, days = 1, extra: Record<string, unknown> = {}) {
  return createTask({
    ...u,
    input: {
      title: 'Linked',
      deadline_at: at(deadlineLocal),
      target_days_before: days,
      target_slot_id: evening().id,
      ...extra,
    },
  })
}
function retime(start: string) {
  return updateTimeSlot({ ...u, slotId: evening().id, input: { start_time: start } })
}
function raw(id: number) {
  return getDb()
    .prepare(
      'SELECT attempts, attempts_counted_through, target_set_at, target_time, target_slot_id, due_at FROM tasks WHERE id = ?',
    )
    .get(id) as {
    attempts: number
    attempts_counted_through: string | null
    target_set_at: string
    target_time: string | null
    target_slot_id: number | null
    due_at: string | null
  }
}

beforeEach(() => {
  setupTestDb()
  setClock('2026-10-26T10:00')
})
afterEach(() => {
  vi.useRealTimers()
  teardownTestDb()
})

describe('TS-RT: a period retime carries its linked targets', () => {
  test('TS-RT01: open rows follow; no restamp, attempts checkpointed for an overdue one', () => {
    const ahead = linked('2026-11-03T08:30')
    const overdue = linked('2026-10-27T08:30')
    expect(overdue.due_at).toBe(at('2026-10-26T20:30'))
    // 21:10: the overdue one is over target (1×), but the cron has not yet
    // persisted it — the stored count is still 0.
    setClock('2026-10-26T21:10')
    expect(raw(overdue.id).attempts).toBe(0)
    const stamps = [raw(ahead.id).target_set_at, raw(overdue.id).target_set_at]
    const origins = [
      getTaskById(ahead.id)!.original_due_at,
      getTaskById(overdue.id)!.original_due_at,
    ]

    const result = retime('21:00')
    expect(result).toMatchObject({ targets_moved: 2, targets_kept: 0, reminders_moved: 0 })
    expect(getTaskById(ahead.id)).toMatchObject({
      due_at: at('2026-11-02T21:00'),
      target_time: '21:00',
      target_slot_id: evening().id,
    })
    expect(getTaskById(overdue.id)!.due_at).toBe(at('2026-10-26T21:00'))
    // Decision 11: the heads-up anchor stays; the attempts checkpoint fires.
    expect([raw(ahead.id).target_set_at, raw(overdue.id).target_set_at]).toEqual(stamps)
    expect(raw(overdue.id).attempts).toBe(1)
    expect(raw(overdue.id).attempts_counted_through).not.toBeNull()
    expect([
      getTaskById(ahead.id)!.original_due_at,
      getTaskById(overdue.id)!.original_due_at,
    ]).toEqual(origins)
    const entry = getDb()
      .prepare('SELECT description FROM undo_log WHERE id = ?')
      .get(result.undo_id) as { description: string }
    expect(entry.description).toBe('Moved "Evening" to 9:00 PM (2 targets)')
  })

  test('TS-RT02: a row the new time would be refused for is unlinked and keeps its time', () => {
    // Deadline 21:00 on the deadline day, target that day at Evening 20:30.
    const t = linked('2026-11-03T21:00', 0)
    expect(t.due_at).toBe(at('2026-11-03T20:30'))
    const result = retime('21:30')
    expect(result).toMatchObject({ targets_moved: 0, targets_kept: 1 })
    expect(getTaskById(t.id)).toMatchObject({
      target_slot_id: null,
      target_time: '20:30',
      due_at: at('2026-11-03T20:30'),
    })
    const entry = getDb()
      .prepare('SELECT description FROM undo_log WHERE id = ?')
      .get(result.undo_id) as { description: string }
    expect(entry.description).toBe('Moved "Evening" to 9:30 PM (1 target kept its time)')
    // Undo re-links it with the period.
    executeUndo(TEST_USER_ID)
    expect(getTaskById(t.id)).toMatchObject({ target_slot_id: evening().id, target_time: '20:30' })
  })

  test('TS-RT03: a linked repeat — the unmoved target follows, a moved one is kept; a daily overlap is kept', () => {
    const rule = 'FREQ=WEEKLY;BYDAY=TU;BYHOUR=8;BYMINUTE=30'
    const onSchedule = linked('2026-11-03T08:30', 1, { rrule: rule })
    const moved = linked('2026-11-03T08:30', 1, { rrule: rule })
    snoozeTask({ ...u, taskId: moved.id, until: at('2026-11-01T09:00') })
    // Daily at 20:00, target the day before at 20:30 (after the previous
    // deadline). Evening at 19:30 would put it ON the previous day's 20:00
    // deadline's wrong side: `overlaps_previous` → unlinked, kept.
    const daily = linked('2026-10-27T20:00', 1, { rrule: 'FREQ=DAILY;BYHOUR=20;BYMINUTE=0' })
    expect(daily.due_at).toBe(at('2026-10-26T20:30'))

    const result = retime('21:00')
    expect(getTaskById(onSchedule.id)).toMatchObject({
      due_at: at('2026-11-02T21:00'),
      target_time: '21:00',
      target_slot_id: evening().id,
    })
    expect(getTaskById(moved.id)).toMatchObject({
      due_at: at('2026-11-01T09:00'),
      target_time: '21:00',
      target_slot_id: evening().id,
    })
    // 21:00 the day before is after the previous 20:00 deadline: fine.
    expect(getTaskById(daily.id)).toMatchObject({
      target_time: '21:00',
      due_at: at('2026-10-26T21:00'),
    })
    expect(result.targets_moved).toBe(3)

    const back = retime('19:30')
    expect(back).toMatchObject({ targets_kept: 1, targets_moved: 2 })
    expect(getTaskById(daily.id)).toMatchObject({
      target_slot_id: null,
      target_time: '21:00',
      due_at: at('2026-10-26T21:00'),
    })
    // A done advances from the stored time (it follows the period).
    markDone({ ...u, taskId: onSchedule.id })
    expect(getTaskById(onSchedule.id)).toMatchObject({
      deadline_at: at('2026-11-10T08:30'),
      due_at: at('2026-11-09T19:30'),
    })
  })

  test('TS-RT04: closed rows — one compare-and-set statement, mirrored by undo and redo', () => {
    const done = linked('2026-11-03T08:30')
    markDone({ ...u, taskId: done.id })
    const doneDue = getTaskById(done.id)!.due_at
    const open = linked('2026-11-04T08:30')
    const result = retime('21:00')
    expect(result.targets_moved).toBe(1)
    expect(raw(done.id)).toMatchObject({ target_time: '21:00', due_at: doneDue })
    const state = JSON.parse(
      (
        getDb().prepare('SELECT slot_state FROM undo_log WHERE id = ?').get(result.undo_id) as {
          slot_state: string
        }
      ).slot_state,
    )
    expect(state.target_times).toEqual({ slot_id: evening().id, before: '20:30', after: '21:00' })

    executeUndo(TEST_USER_ID)
    expect(evening().start_time).toBe('20:30')
    expect(raw(done.id).target_time).toBe('20:30')
    expect(getTaskById(open.id)).toMatchObject({
      target_time: '20:30',
      due_at: at('2026-11-03T20:30'),
    })
    executeRedo(TEST_USER_ID)
    expect(raw(done.id).target_time).toBe('21:00')
    expect(getTaskById(open.id)).toMatchObject({
      target_time: '21:00',
      due_at: at('2026-11-03T21:00'),
    })
  })

  test('TS-RT05: the retime of another period touches nothing linked to this one', () => {
    const t = linked('2026-11-03T08:30')
    const morning = listTimeSlots(TEST_USER_ID).find((s) => s.label === 'Morning')!
    const result = updateTimeSlot({ ...u, slotId: morning.id, input: { start_time: '09:30' } })
    expect(result.targets_moved).toBe(0)
    expect(getTaskById(t.id)).toMatchObject({
      target_time: '20:30',
      due_at: at('2026-11-02T20:30'),
    })
  })

  test('TS-RT06: the description words', () => {
    expect(retimeDescription('Evening', '21:00', { reminders: 2, targets: 5, kept: 1 })).toBe(
      'Moved "Evening" to 9:00 PM (2 reminders, 5 targets; 1 kept its time)',
    )
    expect(retimeDescription('Evening', '21:00', { reminders: 0, targets: 0, kept: 2 })).toBe(
      'Moved "Evening" to 9:00 PM (2 targets kept their time)',
    )
    expect(retimeDescription('Evening', '21:00', { reminders: 0, targets: 0, kept: 0 })).toBe(
      'Moved "Evening" to 9:00 PM',
    )
  })
})

describe('TS-RT: a period delete keeps its linked targets at its start', () => {
  test('TS-RT10: open and closed rows unlinked, time kept; undo re-links; redo unlinks again', () => {
    const open = linked('2026-11-03T08:30')
    const closed = linked('2026-11-04T08:30')
    markDone({ ...u, taskId: closed.id })
    const slotId = evening().id
    const result = deleteTimeSlot({ ...u, slotId })
    expect(result.targets_converted).toBe(1)
    expect(getTaskById(open.id)).toMatchObject({
      target_slot_id: null,
      target_time: '20:30',
      due_at: at('2026-11-02T20:30'),
    })
    expect(raw(closed.id)).toMatchObject({ target_slot_id: null, target_time: '20:30' })
    const entry = getDb()
      .prepare('SELECT description, slot_state FROM undo_log WHERE id = ?')
      .get(result.undo_id) as { description: string; slot_state: string }
    expect(entry.description).toBe('Removed "Evening"; kept 1 target at 8:30 PM')
    expect(JSON.parse(entry.slot_state).target_unlinked).toEqual([closed.id])

    executeUndo(TEST_USER_ID)
    expect(getTaskById(open.id)!.target_slot_id).toBe(slotId)
    expect(raw(closed.id).target_slot_id).toBe(slotId)
    executeRedo(TEST_USER_ID)
    expect(getTaskById(open.id)!.target_slot_id).toBeNull()
    expect(raw(closed.id).target_slot_id).toBeNull()
    // And a later undo again puts back exactly what the redo unlinked.
    executeUndo(TEST_USER_ID)
    expect(raw(closed.id).target_slot_id).toBe(slotId)
  })

  test('TS-RT11: undo re-links compare-and-set — a closed row whose time changed stays custom', () => {
    const closed = linked('2026-11-04T08:30')
    markDone({ ...u, taskId: closed.id })
    const slotId = evening().id
    deleteTimeSlot({ ...u, slotId })
    getDb().prepare("UPDATE tasks SET target_time = '19:00' WHERE id = ?").run(closed.id)
    executeUndo(TEST_USER_ID)
    expect(raw(closed.id)).toMatchObject({ target_slot_id: null, target_time: '19:00' })
  })

  test('TS-RT12: the retime runs over the owner’s tasks only — another user’s links are theirs', () => {
    seedTestUser(2, 'other@example.com')
    seedTestProject(2, 'Other inbox', 2)
    const theirs = listTimeSlots(2).find((s) => s.label === 'Evening')!
    const other = createTask({
      userId: 2,
      userTimezone: tz,
      input: {
        title: 'Theirs',
        project_id: 2,
        deadline_at: at('2026-11-03T08:30'),
        target_days_before: 1,
        target_slot_id: theirs.id,
      },
    })
    const mine = linked('2026-11-03T08:30')
    retime('21:00')
    expect(getTaskById(mine.id)!.target_time).toBe('21:00')
    expect(getTaskById(other.id)).toMatchObject({
      target_slot_id: theirs.id,
      target_time: '20:30',
      due_at: at('2026-11-02T20:30'),
    })
  })
})
