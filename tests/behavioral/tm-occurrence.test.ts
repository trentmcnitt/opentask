/**
 * TM6: one "move target" gesture; a repeating task's occurrence kept apart
 * from its target (spec §6, rulings Q1–Q4, 2026-10-12; docs/TASK-MODEL.md
 * § Recurrence Model). `occurrence_at` is the schedule, `due_at` the target.
 * A move (any snooze, Today, the picker) changes only the target; done and
 * skip advance from the occurrence and set both; the deadline measures from
 * the occurrence. Every date is a LOCAL time in America/Chicago.
 */
import { describe, test, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { DateTime } from 'luxon'
import { getDb } from '@/core/db'
import { createTask, updateTask, markDone, markUndone } from '@/core/tasks'
import { snoozeTask } from '@/core/tasks/snooze'
import { skipOccurrence } from '@/core/tasks/skip'
import { getTaskById } from '@/core/tasks/read'
import { executeUndo } from '@/core/undo'
import { getCurrentlyDueTaskIds } from '@/core/tasks/currently-due'
import { getTaskSegments, targetTasksToday } from '@/core/tasks/task-segments'
import { formatTaskResponse } from '@/lib/format-task'
import { upcomingRowActions } from '@/lib/task-segments'
import { occurrenceDiffers } from '@/lib/editor-target-labels'
import { REMINDER_SNOOZE_MESSAGE } from '@/core/validation'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

const tz = TEST_TIMEZONE
function at(local: string): string {
  return DateTime.fromISO(local, { zone: tz }).toUTC().toISO()!
}
function setClock(local: string) {
  vi.setSystemTime(new Date(at(local)))
}
const u = { userId: TEST_USER_ID, userTimezone: tz }
function make(input: Record<string, unknown>) {
  return createTask({ ...u, input: { title: 'Task', ...input } })
}
function patch(id: number, input: Record<string, unknown>) {
  return updateTask({ ...u, taskId: id, input })
}
function done(id: number) {
  return markDone({ ...u, taskId: id })
}
function due(id: number): boolean {
  return getCurrentlyDueTaskIds(TEST_USER_ID).includes(id)
}
function upcomingRows(id: number): number {
  return getTaskSegments(TEST_USER_ID, tz)
    .filter((s) => s.horizon === 'upcoming')
    .flatMap((s) => s.tasks)
    .filter((r) => r.task.id === id).length
}

/**
 * codes-blog: deadline Sundays at 11 PM, target the same Sunday at noon — a
 * DEADLINE-ANCHORED repeat since 2026-10-21 (the rule walks the deadline;
 * the target sent with it gives the offset: 0 days, 12:00).
 */
function codesBlog() {
  setClock('2026-10-12T12:00')
  return make({
    rrule: 'FREQ=WEEKLY;BYDAY=SU;BYHOUR=23;BYMINUTE=0',
    due_at: at('2026-10-18T12:00'),
    deadline_at: at('2026-10-18T23:00'),
  })
}

describe('TM6: the occurrence apart from the target', () => {
  beforeAll(() => setupTestDb())
  afterAll(() => teardownTestDb())
  beforeEach(() => {
    getDb().prepare('DELETE FROM completions').run()
    getDb().prepare('DELETE FROM tasks').run()
    getDb().prepare('DELETE FROM undo_log').run()
    setClock('2026-10-12T12:00')
  })
  afterEach(() => vi.useRealTimers())

  test('TM6-001: a repeating task starts on its occurrence; a one-off has none', () => {
    const plain = make({ rrule: 'FREQ=WEEKLY;BYDAY=SU', due_at: at('2026-10-18T12:00') })
    expect(plain.occurrence_at).toBe(at('2026-10-18T12:00'))
    expect(plain.due_at).toBe(plain.occurrence_at)
    // Deadline-anchored: the occurrence is the deadline, the target derived.
    const t = codesBlog()
    expect(t.occurrence_at).toBe(at('2026-10-18T23:00'))
    expect(t.deadline_at).toBe(t.occurrence_at)
    expect(t.due_at).toBe(at('2026-10-18T12:00'))
    expect(make({ due_at: at('2026-10-20T09:00') }).occurrence_at).toBeNull()
  })

  test('TM6-002: a move changes only the target — the occurrence and the first target stay', () => {
    const t = codesBlog()
    const r = snoozeTask({ ...u, taskId: t.id, until: at('2026-10-18T15:00') })
    expect(r.task.due_at).toBe(at('2026-10-18T15:00'))
    expect(r.task.occurrence_at).toBe(at('2026-10-18T23:00'))
    expect(r.task.original_due_at).toBe(at('2026-10-18T12:00'))
    // No snooze state anywhere (§6, ruling Q1).
    const json: object = formatTaskResponse(r.task, tz)
    expect(json).not.toHaveProperty('is_snoozed')
    expect(json).not.toHaveProperty('snooze_count')
  })

  test('TM6-003: `retarget` from an old client is a plain move (ruling Q4)', () => {
    const t = codesBlog()
    const r = patch(t.id, { due_at: at('2026-10-17T20:00'), reset_original_due_at: true })
    expect(r.task.occurrence_at).toBe(at('2026-10-18T23:00'))
    expect(r.task.original_due_at).toBe(at('2026-10-18T12:00'))
  })

  describe("the red team's B1 (codes-blog): Today on Saturday, done Saturday", () => {
    test('TM6-010: no double fire — the next one is a week on, not the next day', () => {
      const t = codesBlog()
      setClock('2026-10-17T10:00')
      const r = targetTasksToday(TEST_USER_ID, tz, [t.id])
      expect(r).toMatchObject({ affected: 1, skipped_recurring: [] })
      const moved = getTaskById(t.id)!
      expect(DateTime.fromISO(moved.due_at!).setZone(tz).toISODate()).toBe('2026-10-17')
      expect(moved.occurrence_at).toBe(at('2026-10-18T23:00'))
      setClock('2026-10-17T21:00')
      done(t.id)
      const next = getTaskById(t.id)!
      expect(next.occurrence_at).toBe(at('2026-10-25T23:00'))
      expect(next.due_at).toBe(at('2026-10-25T12:00'))
      // Sunday the 18th: nothing due.
      setClock('2026-10-18T13:00')
      expect(due(t.id)).toBe(false)
    })

    test('TM6-011: no deadline drift — measured from the occurrence (Sun), not the moved target (Sat)', () => {
      const t = codesBlog()
      setClock('2026-10-17T10:00')
      targetTasksToday(TEST_USER_ID, tz, [t.id])
      setClock('2026-10-17T21:00')
      done(t.id)
      expect(getTaskById(t.id)!.deadline_at).toBe(at('2026-10-25T23:00'))
    })

    test('TM6-012: Today is offered on a repeating Upcoming row now', () => {
      expect(
        upcomingRowActions({
          recurring: true,
          task: { due_at: at('2026-10-18T12:00'), deadline_at: null },
        }).today,
      ).toBe(true)
    })
  })

  describe('ruling Q3: a weekly target moved past its next occurrence (+10 days)', () => {
    function movedWeekly() {
      const t = codesBlog()
      setClock('2026-10-14T12:00')
      patch(t.id, { due_at: at('2026-10-28T12:00') })
      return t
    }

    test('TM6-020: the target may pass the next occurrence (no cap but the deadline)', () => {
      const t = codesBlog()
      setClock('2026-10-14T12:00')
      // Its deadline (Sun Oct 18 23:00) caps it — the move stops there.
      const capped = patch(t.id, { due_at: at('2026-10-28T12:00') })
      expect(capped.task.due_at).toBe(at('2026-10-18T23:00'))
      // With no deadline it goes where asked.
      const plain = make({ rrule: 'FREQ=WEEKLY;BYDAY=SU', due_at: at('2026-10-18T12:00') })
      const r = patch(plain.id, { due_at: at('2026-10-28T12:00') })
      expect(r.task.due_at).toBe(at('2026-10-28T12:00'))
      expect(r.task.occurrence_at).toBe(at('2026-10-18T12:00'))
    })

    test('TM6-021: nothing fires in between, and one row at most each day', () => {
      const plain = make({ rrule: 'FREQ=WEEKLY;BYDAY=SU', due_at: at('2026-10-18T12:00') })
      setClock('2026-10-14T12:00')
      patch(plain.id, { due_at: at('2026-10-28T12:00') })
      for (let d = 14; d <= 27; d++) {
        setClock(`2026-10-${d}T13:00`)
        expect(due(plain.id)).toBe(false)
        expect(upcomingRows(plain.id)).toBeLessThanOrEqual(1)
      }
      setClock('2026-10-28T13:00')
      expect(due(plain.id)).toBe(true)
      expect(upcomingRows(plain.id)).toBe(0)
    })

    test('TM6-022: done on the moved day → the next occurrence after now, no catch-up', () => {
      const plain = make({ rrule: 'FREQ=WEEKLY;BYDAY=SU', due_at: at('2026-10-18T12:00') })
      setClock('2026-10-14T12:00')
      patch(plain.id, { due_at: at('2026-10-28T12:00') })
      setClock('2026-10-28T13:00')
      done(plain.id)
      const next = getTaskById(plain.id)!
      expect(next.occurrence_at).toBe(at('2026-11-01T12:00'))
      expect(next.due_at).toBe(at('2026-11-01T12:00'))
      expect(due(plain.id)).toBe(false)
    })

    test('TM6-023: done early (before the moved target) → the next occurrence after now', () => {
      const plain = make({ rrule: 'FREQ=WEEKLY;BYDAY=SU', due_at: at('2026-10-18T12:00') })
      setClock('2026-10-14T12:00')
      patch(plain.id, { due_at: at('2026-10-28T12:00') })
      setClock('2026-10-23T13:00')
      done(plain.id)
      expect(getTaskById(plain.id)!.occurrence_at).toBe(at('2026-10-25T12:00'))
    })

    test('TM6-024: the helper names the occurrence while the target is moved', () => {
      const t = movedWeekly()
      expect(occurrenceDiffers(getTaskById(t.id)!, tz, false)).toBe('Sun Oct 18')
      done(t.id)
      expect(occurrenceDiffers(getTaskById(t.id)!, tz, false)).toBeNull()
    })
  })

  describe('skip, put-back, undo', () => {
    test('TM6-030: skip advances from the occurrence and sets both', () => {
      const t = make({ rrule: 'FREQ=WEEKLY;BYDAY=SU', due_at: at('2026-10-18T12:00') })
      patch(t.id, { due_at: at('2026-10-17T20:00') })
      setClock('2026-10-17T21:00')
      const r = skipOccurrence({ ...u, taskId: t.id })
      expect(r.task.occurrence_at).toBe(at('2026-10-25T12:00'))
      expect(r.task.due_at).toBe(at('2026-10-25T12:00'))
    })

    test('TM6-031: put-back restores the moved target AND the occurrence', () => {
      const t = make({ rrule: 'FREQ=WEEKLY;BYDAY=SU', due_at: at('2026-10-18T12:00') })
      patch(t.id, { due_at: at('2026-10-17T20:00') })
      setClock('2026-10-17T21:00')
      done(t.id)
      const back = markUndone({ ...u, taskId: t.id })
      expect(back.due_at).toBe(at('2026-10-17T20:00'))
      expect(back.occurrence_at).toBe(at('2026-10-18T12:00'))
      // Done again: still a week on, not the next day.
      done(t.id)
      expect(getTaskById(t.id)!.occurrence_at).toBe(at('2026-10-25T12:00'))
    })

    test('TM6-032: Undo of done restores target, occurrence and the stamp', () => {
      const t = make({ rrule: 'FREQ=WEEKLY;BYDAY=SU', due_at: at('2026-10-18T12:00') })
      patch(t.id, { due_at: at('2026-10-17T20:00') })
      const before = getTaskById(t.id)!
      setClock('2026-10-17T21:00')
      done(t.id)
      executeUndo(TEST_USER_ID)
      const back = getTaskById(t.id)!
      expect(back.due_at).toBe(before.due_at)
      expect(back.occurrence_at).toBe(before.occurrence_at)
      expect(back.target_set_at).toBe(before.target_set_at)
    })

    test('TM6-033: Undo of a move leaves the occurrence where it was', () => {
      const t = make({ rrule: 'FREQ=WEEKLY;BYDAY=SU', due_at: at('2026-10-18T12:00') })
      patch(t.id, { due_at: at('2026-10-20T09:00') })
      executeUndo(TEST_USER_ID)
      const back = getTaskById(t.id)!
      expect(back.due_at).toBe(at('2026-10-18T12:00'))
      expect(back.occurrence_at).toBe(at('2026-10-18T12:00'))
    })
  })

  describe('schedule changes and reminders', () => {
    test('TM6-040: a new rule schedules a new occurrence', () => {
      const t = make({ rrule: 'FREQ=WEEKLY;BYDAY=SU', due_at: at('2026-10-18T12:00') })
      const r = patch(t.id, { rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0' })
      expect(r.task.occurrence_at).toBe(r.task.due_at)
      expect(DateTime.fromISO(r.task.occurrence_at!).setZone(tz).weekday).toBe(1)
      // Dropping the rule drops the occurrence.
      expect(patch(t.id, { rrule: null }).task.occurrence_at).toBeNull()
    })

    test("TM6-041: a reminder's period move moves its occurrence; a bare move is still refused", () => {
      const r = make({ is_reminder: true, rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0' })
      const moved = patch(r.id, { due_at: at('2026-10-13T18:00'), reset_original_due_at: true })
      expect(moved.task.occurrence_at).toBe(at('2026-10-13T18:00'))
      expect(moved.task.original_due_at).toBe(at('2026-10-13T18:00'))
      expect(() => patch(r.id, { due_at: at('2026-10-13T20:00') })).toThrow(REMINDER_SNOOZE_MESSAGE)
    })
  })
})
