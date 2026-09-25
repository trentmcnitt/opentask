/**
 * Editable time slots (TSE-001..) — Settings → Reminder periods, 2026-09-24.
 *
 * Reminders belong to a slot only through their time of day, so changing a
 * slot's start or removing a slot has to move reminders to keep them in a
 * slot. These pin the rules in src/core/time-slots/edit.ts: boundary
 * reminders follow, off-boundary ones stay unless ejected, other slots and
 * ordinary tasks are untouched, removal goes to the nearest remaining slot,
 * and one Undo puts back the slot AND its reminders.
 *
 * Default slots (seeded by setupTestDb): Early morning 07:00, Morning 09:00,
 * Midday 12:00, Afternoon 16:00, Evening 20:30.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { getDb } from '@/core/db'
import { createTask, getTaskById } from '@/core/tasks'
import { executeUndo, executeRedo } from '@/core/undo'
import {
  createTimeSlot,
  listTimeSlots,
  seedDefaultTimeSlots,
  type TimeSlot,
} from '@/core/time-slots'
import { updateTimeSlot, deleteTimeSlot, planSlotRetime } from '@/core/time-slots/edit'
import { getRemindersBySlot } from '@/core/tasks/reminders'
import { NotFoundError, ValidationError } from '@/core/errors'
import { DateTime } from 'luxon'
import {
  setupTestDb,
  teardownTestDb,
  seedTestUser,
  TEST_TIMEZONE,
  TEST_USER_ID,
} from '../helpers/setup'

const OTHER_USER_ID = 2

function slotByLabel(label: string): TimeSlot {
  const slot = listTimeSlots(TEST_USER_ID).find((s) => s.label === label)
  if (!slot) throw new Error(`no slot ${label}`)
  return slot
}

function reminder(title: string, rrule: string | null, dueLocal?: string) {
  return createTask({
    userId: TEST_USER_ID,
    userTimezone: TEST_TIMEZONE,
    input: {
      title,
      is_reminder: true,
      rrule,
      ...(dueLocal
        ? { due_at: DateTime.fromISO(dueLocal, { zone: TEST_TIMEZONE }).toUTC().toISO()! }
        : {}),
    },
  })
}

function groupOf(taskId: number): string | null {
  const groups = getRemindersBySlot(TEST_USER_ID, TEST_TIMEZONE)
  const group = groups.find((g) => g.reminders.some((t) => t.id === taskId))
  return group ? (group.slot?.label ?? null) : 'missing'
}

function localTimeOf(iso: string | null): string | null {
  if (!iso) return null
  return DateTime.fromISO(iso, { zone: 'utc' }).setZone(TEST_TIMEZONE).toFormat('yyyy-MM-dd HH:mm')
}

function undoCount(): number {
  return (
    getDb().prepare('SELECT COUNT(*) AS c FROM undo_log WHERE user_id = ?').get(TEST_USER_ID) as {
      c: number
    }
  ).c
}

beforeEach(() => {
  // Thursday 2026-01-15, 10:00 Chicago.
  vi.setSystemTime(new Date('2026-01-15T16:00:00Z'))
  setupTestDb()
})
afterEach(() => {
  vi.useRealTimers()
  teardownTestDb()
})

describe('Moving a slot’s start', () => {
  test('TSE-001: a reminder on the slot boundary follows the moved start, keeping its days', () => {
    const daily = reminder('Supplements', 'FREQ=DAILY;BYHOUR=7;BYMINUTE=0')
    const weekly = reminder('Plan the week', 'FREQ=WEEKLY;BYDAY=TU,TH;BYHOUR=7;BYMINUTE=0')
    const early = slotByLabel('Early morning')

    const result = updateTimeSlot({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      slotId: early.id,
      input: { start_time: '06:30' },
    })

    expect(result.reminders_moved).toBe(2)
    expect(result.undo_id).not.toBeNull()
    const d = getTaskById(daily.id)!
    const w = getTaskById(weekly.id)!
    expect(d.rrule).toBe('FREQ=DAILY;BYHOUR=6;BYMINUTE=30')
    expect(d.anchor_time).toBe('06:30')
    expect(localTimeOf(d.due_at)).toBe('2026-01-16 06:30')
    expect(w.rrule).toBe('FREQ=WEEKLY;BYDAY=TU,TH;BYHOUR=6;BYMINUTE=30')
    expect(w.anchor_time).toBe('06:30')
    expect(groupOf(daily.id)).toBe('Early morning')
  })

  test('TSE-002: an off-boundary reminder still inside the slot keeps its own time', () => {
    const inside = reminder('Walk', 'FREQ=DAILY;BYHOUR=18;BYMINUTE=0')
    updateTimeSlot({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      slotId: slotByLabel('Afternoon').id,
      input: { start_time: '17:00' },
    })
    const t = getTaskById(inside.id)!
    expect(t.rrule).toBe('FREQ=DAILY;BYHOUR=18;BYMINUTE=0')
    expect(t.anchor_time).toBe('18:00')
    expect(groupOf(inside.id)).toBe('Afternoon')
  })

  test('TSE-003: an off-boundary reminder the new boundary would eject snaps to the new start', () => {
    const early = reminder('Stretch', 'FREQ=DAILY;BYHOUR=7;BYMINUTE=30')
    updateTimeSlot({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      slotId: slotByLabel('Early morning').id,
      input: { start_time: '08:00' },
    })
    const t = getTaskById(early.id)!
    expect(t.anchor_time).toBe('08:00')
    expect(groupOf(early.id)).toBe('Early morning')
  })

  test('TSE-004: other slots’ reminders and ordinary tasks are left alone', () => {
    // 08:30 is inside Early morning; moving Morning to 08:00 now covers it.
    const covered = reminder('Covered', 'FREQ=DAILY;BYHOUR=8;BYMINUTE=30')
    const otherSlot = reminder('Noon thought', 'FREQ=DAILY;BYHOUR=12;BYMINUTE=0')
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Call dentist',
        due_at: DateTime.fromISO('2026-01-16T09:00', { zone: TEST_TIMEZONE }).toUTC().toISO()!,
      },
    })
    const result = updateTimeSlot({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      slotId: slotByLabel('Morning').id,
      input: { start_time: '08:00' },
    })
    expect(result.reminders_moved).toBe(0)
    expect(getTaskById(covered.id)!.anchor_time).toBe('08:30')
    expect(getTaskById(otherSlot.id)!.anchor_time).toBe('12:00')
    expect(localTimeOf(getTaskById(task.id)!.due_at)).toBe('2026-01-16 09:00')
  })

  test('TSE-005: a one-time reminder keeps its date and moves as a reschedule, not a snooze', () => {
    const once = reminder('Pick up the parcel', null, '2026-01-20T09:00')
    const before = getTaskById(once.id)!
    updateTimeSlot({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      slotId: slotByLabel('Morning').id,
      input: { start_time: '09:30' },
    })
    const after = getTaskById(once.id)!
    expect(localTimeOf(after.due_at)).toBe('2026-01-20 09:30')
    expect(after.snooze_count).toBe(before.snooze_count)
    expect(after.original_due_at).toBe(after.due_at)
  })

  test('TSE-006: one Undo restores the slot start AND the reminders; Redo re-applies both', () => {
    const r = reminder('Supplements', 'FREQ=DAILY;BYHOUR=7;BYMINUTE=0')
    const beforeTask = getTaskById(r.id)!
    const early = slotByLabel('Early morning')
    updateTimeSlot({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      slotId: early.id,
      input: { start_time: '06:00', label: 'Dawn' },
    })

    const undone = executeUndo(TEST_USER_ID)!
    expect(undone.undone_action).toBe('time_slot_edit')
    const restored = listTimeSlots(TEST_USER_ID).find((s) => s.id === early.id)!
    expect(restored.start_time).toBe('07:00')
    expect(restored.label).toBe('Early morning')
    const t = getTaskById(r.id)!
    expect(t.rrule).toBe(beforeTask.rrule)
    expect(t.anchor_time).toBe(beforeTask.anchor_time)
    expect(t.due_at).toBe(beforeTask.due_at)

    executeRedo(TEST_USER_ID)
    expect(listTimeSlots(TEST_USER_ID).find((s) => s.id === early.id)!.start_time).toBe('06:00')
    expect(getTaskById(r.id)!.anchor_time).toBe('06:00')
  })

  test('TSE-007: a rename moves nothing and is not an undo entry', () => {
    const r = reminder('Supplements', 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0')
    const count = undoCount()
    const result = updateTimeSlot({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      slotId: slotByLabel('Morning').id,
      input: { label: 'Work start' },
    })
    expect(result.undo_id).toBeNull()
    expect(result.slot.label).toBe('Work start')
    expect(undoCount()).toBe(count)
    expect(getTaskById(r.id)!.anchor_time).toBe('09:00')
  })
})

describe('Removing a slot, and the rules around it', () => {
  test('TSE-008: removing a slot moves its reminders to the nearest remaining slot', () => {
    // Midday 12:00 → Morning 09:00 (3h) beats Afternoon 16:00 (4h).
    const noon = reminder('Lunch walk', 'FREQ=DAILY;BYHOUR=12;BYMINUTE=0')
    // 15:00 inside Midday → Afternoon 16:00 (1h) beats Morning (6h).
    const late = reminder('Hydrate', 'FREQ=DAILY;BYHOUR=15;BYMINUTE=0')
    const midday = slotByLabel('Midday')
    const result = deleteTimeSlot({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      slotId: midday.id,
    })
    expect(result.reminders_moved).toBe(2)
    expect(listTimeSlots(TEST_USER_ID).some((s) => s.id === midday.id)).toBe(false)
    expect(getTaskById(noon.id)!.anchor_time).toBe('09:00')
    expect(groupOf(noon.id)).toBe('Morning')
    expect(getTaskById(late.id)!.anchor_time).toBe('16:00')
    expect(groupOf(late.id)).toBe('Afternoon')
  })

  test('TSE-009: removing the FIRST slot keeps its reminders in a slot', () => {
    const r = reminder('Supplements', 'FREQ=DAILY;BYHOUR=7;BYMINUTE=0')
    deleteTimeSlot({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      slotId: slotByLabel('Early morning').id,
    })
    expect(groupOf(r.id)).toBe('Morning')
  })

  test('TSE-010: a tie goes to the earlier slot', () => {
    getDb().prepare('DELETE FROM time_slots WHERE user_id = ?').run(TEST_USER_ID)
    createTimeSlot(TEST_USER_ID, 'A', '08:00')
    const mid = createTimeSlot(TEST_USER_ID, 'B', '10:00')
    createTimeSlot(TEST_USER_ID, 'C', '12:00')
    const r = reminder('Tie', 'FREQ=DAILY;BYHOUR=10;BYMINUTE=0')
    deleteTimeSlot({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, slotId: mid.id })
    expect(getTaskById(r.id)!.anchor_time).toBe('08:00')
  })

  test('TSE-011: Undo of a removal brings the slot back under its own id, with its reminders', () => {
    const r = reminder('Lunch walk', 'FREQ=DAILY;BYHOUR=12;BYMINUTE=0')
    const midday = slotByLabel('Midday')
    deleteTimeSlot({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, slotId: midday.id })
    const undone = executeUndo(TEST_USER_ID)!
    expect(undone.undone_action).toBe('time_slot_delete')
    const back = listTimeSlots(TEST_USER_ID).find((s) => s.id === midday.id)
    expect(back).toEqual(midday)
    expect(getTaskById(r.id)!.anchor_time).toBe('12:00')
    expect(groupOf(r.id)).toBe('Midday')

    executeRedo(TEST_USER_ID)
    expect(listTimeSlots(TEST_USER_ID).some((s) => s.id === midday.id)).toBe(false)
    expect(getTaskById(r.id)!.anchor_time).toBe('09:00')
  })

  test('TSE-012: removing an empty slot is still undoable', () => {
    const evening = slotByLabel('Evening')
    const result = deleteTimeSlot({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      slotId: evening.id,
    })
    expect(result.reminders_moved).toBe(0)
    expect(result.undo_id).not.toBeNull()
    executeUndo(TEST_USER_ID)
    expect(listTimeSlots(TEST_USER_ID).find((s) => s.id === evening.id)).toEqual(evening)
  })

  test('TSE-013: the last slot cannot be removed', () => {
    const slots = listTimeSlots(TEST_USER_ID)
    for (const slot of slots.slice(1)) {
      deleteTimeSlot({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, slotId: slot.id })
    }
    expect(() =>
      deleteTimeSlot({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, slotId: slots[0].id }),
    ).toThrow(ValidationError)
    expect(listTimeSlots(TEST_USER_ID)).toHaveLength(1)
  })

  test('TSE-014: start times are unique per user, on create and on update', () => {
    expect(() => createTimeSlot(TEST_USER_ID, 'Dup', '09:00')).toThrow(ValidationError)
    expect(() =>
      updateTimeSlot({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        slotId: slotByLabel('Early morning').id,
        input: { start_time: '12:00' },
      }),
    ).toThrow(ValidationError)
    // Another user may have the same time.
    seedTestUser(OTHER_USER_ID, 'other@example.com')
    expect(listTimeSlots(OTHER_USER_ID).some((s) => s.start_time === '09:00')).toBe(true)
  })

  test('TSE-015: another user’s slot is not found, and is left untouched', () => {
    seedTestUser(OTHER_USER_ID, 'other@example.com')
    seedDefaultTimeSlots(OTHER_USER_ID)
    const theirs = listTimeSlots(OTHER_USER_ID)[0]
    expect(() =>
      updateTimeSlot({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        slotId: theirs.id,
        input: { label: 'Mine now' },
      }),
    ).toThrow(NotFoundError)
    expect(() =>
      deleteTimeSlot({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, slotId: theirs.id }),
    ).toThrow(NotFoundError)
    expect(listTimeSlots(OTHER_USER_ID)[0]).toEqual(theirs)
  })

  test('TSE-016: planner — moving past the next slot still keeps the slot’s reminders', () => {
    const slots = listTimeSlots(TEST_USER_ID)
    const early = slots.find((s) => s.label === 'Early morning')!
    const moved = slots.map((s) => (s.id === early.id ? { ...s, start_time: '10:00' } : s))
    const plan = planSlotRetime(
      [
        { id: 1, anchor_time: '07:00', due_at: null }, // boundary → 10:00
        { id: 2, anchor_time: '08:00', due_at: null }, // would be un-slotted → 10:00
        { id: 3, anchor_time: '09:00', due_at: null }, // Morning's, untouched
      ],
      slots,
      moved,
      early.id,
      TEST_TIMEZONE,
    )
    expect([...plan.entries()]).toEqual([
      [1, 600],
      [2, 600],
    ])
  })
})
