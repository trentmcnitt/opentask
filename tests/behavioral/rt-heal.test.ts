/**
 * RT-H: A RESTORED LINK IS ALWAYS RE-VALIDATED AGAINST THE CURRENT PERIOD
 * (relative targets, 2026-10-24; `healRelativeLinks`,
 * src/core/tasks/relative-link-heal.ts). Undo and redo write a task's
 * columns back as an entry snapshotted them; an entry can be older than the
 * period's current state (undo stacks are per user), and a fence can skip a
 * snapshot whole. Each case below reproduces one way a stale link came back
 * before the rule, then redoes.
 * Default periods (setupTestDb): … Evening 20:30. America/Chicago.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { DateTime } from 'luxon'
import { getDb } from '@/core/db'
import { createTask, snoozeTask, updateTask } from '@/core/tasks'
import { getTaskById } from '@/core/tasks/read'
import { deckTasks } from '@/core/tasks/deck'
import { runTaskRollover } from '@/core/tasks/task-rollover'
import { executeRedo, executeUndo } from '@/core/undo'
import { listTimeSlots } from '@/core/time-slots'
import { deleteTimeSlot, updateTimeSlot } from '@/core/time-slots/edit'
import { occurrenceDates } from '@/lib/task-segments'
import {
  seedTestProject,
  seedTestUser,
  setupTestDb,
  teardownTestDb,
  TEST_TIMEZONE,
  TEST_USER_ID,
} from '../helpers/setup'

const tz = TEST_TIMEZONE
const OWNER = { userId: TEST_USER_ID, userTimezone: tz }
const COLLABORATOR = { userId: 2, userTimezone: tz }
function at(local: string): string {
  return DateTime.fromISO(local, { zone: tz }).toUTC().toISO()!
}
function setClock(local: string) {
  vi.setSystemTime(new Date(at(local)))
}
function evening() {
  return listTimeSlots(TEST_USER_ID).find((s) => s.label === 'Evening')
}
function retime(start: string) {
  return updateTimeSlot({ ...OWNER, slotId: evening()!.id, input: { start_time: start } })
}

beforeEach(() => {
  setupTestDb()
  setClock('2026-10-25T10:00')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
  teardownTestDb()
})

describe('RT-H: a fence that skips a snapshot still heals the link', () => {
  test('RT-H01: undo a retime after the rollover took a decked repeat off deck', () => {
    vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
    getDb()
      .prepare("UPDATE users SET last_rollover_date = '2026-10-25' WHERE id = ?")
      .run(TEST_USER_ID)
    const slotId = evening()!.id
    const t = createTask({
      ...OWNER,
      input: {
        title: 'Weekly filing',
        rrule: 'FREQ=WEEKLY;BYDAY=TU;BYHOUR=8;BYMINUTE=30',
        deadline_at: at('2026-10-27T08:30'),
        target_days_before: 1,
        target_slot_id: slotId,
      },
    })
    expect(t.due_at).toBe(at('2026-10-26T20:30'))
    deckTasks({ userId: TEST_USER_ID, timezone: tz, ids: [t.id], day: '2026-10-26' })
    setClock('2026-10-25T11:00')
    retime('21:00')
    expect(getTaskById(t.id)).toMatchObject({ due_at: null, target_time: '21:00' })

    // Tuesday's rollover ends the deck: the derived target comes back (and the
    // rollover's fence stamp means undo skips the retime's snapshot of it).
    setClock('2026-10-27T03:30')
    runTaskRollover({ now: new Date(at('2026-10-27T03:30')), userId: TEST_USER_ID })
    const rolled = getTaskById(t.id)!
    expect(rolled).toMatchObject({ on_deck_day: null, target_time: '21:00' })
    expect(rolled.rolled_over_at).not.toBeNull()
    const derivedAt = (time: string) =>
      occurrenceDates(
        { ...rolled, target_time: time, target_days_before: 1 },
        rolled.occurrence_at!,
        tz,
      ).targetAt
    expect(rolled.due_at).toBe(derivedAt('21:00'))

    setClock('2026-10-27T03:40')
    expect(executeUndo(TEST_USER_ID)?.undone_action).toBe('time_slot_edit')
    expect(evening()!.start_time).toBe('20:30')
    expect(getTaskById(t.id)).toMatchObject({
      target_slot_id: slotId,
      target_time: '20:30',
      due_at: derivedAt('20:30'),
    })
    executeRedo(TEST_USER_ID)
    expect(evening()!.start_time).toBe('21:00')
    expect(getTaskById(t.id)).toMatchObject({
      target_slot_id: slotId,
      target_time: '21:00',
      due_at: derivedAt('21:00'),
    })
  })
})

describe('RT-H: a collaborator’s undo restores a link from before the owner’s period change', () => {
  beforeEach(() => {
    seedTestUser(2, 'collaborator@example.com')
    seedTestProject(2, 'Shared', TEST_USER_ID, true)
  })
  function sharedLinked(deadlineLocal: string, days = 1) {
    return createTask({
      ...OWNER,
      input: {
        title: 'Shared filing',
        project_id: 2,
        deadline_at: at(deadlineLocal),
        target_days_before: days,
        target_slot_id: evening()!.id,
      },
    })
  }

  test('RT-H10: the owner retimed — the restored link follows the period’s current start', () => {
    const t = sharedLinked('2026-11-03T08:30')
    const slotId = evening()!.id
    snoozeTask({ ...COLLABORATOR, taskId: t.id, until: at('2026-10-30T09:00') })
    expect(getTaskById(t.id)!.target_slot_id).toBeNull()
    retime('21:00')
    executeUndo(2)
    expect(getTaskById(t.id)).toMatchObject({
      target_slot_id: slotId,
      target_time: '21:00',
      due_at: at('2026-11-02T21:00'),
    })
    // The next retime's compare-and-set finds it.
    retime('21:30')
    expect(getTaskById(t.id)).toMatchObject({
      target_time: '21:30',
      due_at: at('2026-11-02T21:30'),
    })
    // Redo of the defer: fixed again.
    executeRedo(2)
    expect(getTaskById(t.id)).toMatchObject({
      target_slot_id: null,
      target_days_before: null,
      due_at: at('2026-10-30T09:00'),
    })
  })

  test('RT-H11: the owner deleted the period — the restored link goes, the time kept', () => {
    const t = sharedLinked('2026-11-03T08:30')
    const slotId = evening()!.id
    snoozeTask({ ...COLLABORATOR, taskId: t.id, until: at('2026-10-30T09:00') })
    deleteTimeSlot({ ...OWNER, slotId })
    expect(evening()).toBeUndefined()
    executeUndo(2)
    expect(getTaskById(t.id)).toMatchObject({
      target_slot_id: null,
      target_days_before: 1,
      target_time: '20:30',
      due_at: at('2026-11-02T20:30'),
    })
    executeRedo(2)
    expect(getTaskById(t.id)).toMatchObject({
      target_slot_id: null,
      target_days_before: null,
      due_at: at('2026-10-30T09:00'),
    })
  })

  test('RT-H12: the period’s current start would be refused — unlinked, the restored time kept', () => {
    // The deadline day, 21:00; the target that day at Evening 20:30.
    const t = sharedLinked('2026-11-03T21:00', 0)
    snoozeTask({ ...COLLABORATOR, taskId: t.id, until: at('2026-10-30T09:00') })
    retime('21:30')
    executeUndo(2)
    expect(getTaskById(t.id)).toMatchObject({
      target_slot_id: null,
      target_time: '20:30',
      due_at: at('2026-11-03T20:30'),
    })
  })

  test('RT-H13: the collaborator’s undo moves the deadline back before a linked target — unlinked, clamped, re-derived', () => {
    // Deadline Tue 20:45; the target that day at Evening (20:30).
    const t = sharedLinked('2026-11-03T20:45', 0)
    expect(t.due_at).toBe(at('2026-11-03T20:30'))
    updateTask({ ...COLLABORATOR, taskId: t.id, input: { deadline_at: at('2026-11-03T22:00') } })
    retime('21:00') // allowed against 22:00: the target follows to 21:00
    expect(getTaskById(t.id)!.due_at).toBe(at('2026-11-03T21:00'))
    executeUndo(2) // the deadline back to 20:45
    expect(getTaskById(t.id)).toMatchObject({
      deadline_at: at('2026-11-03T20:45'),
      target_slot_id: null,
      target_days_before: 0,
      target_time: '20:45',
      due_at: at('2026-11-03T20:45'),
    })
    executeRedo(2)
    expect(getTaskById(t.id)).toMatchObject({
      deadline_at: at('2026-11-03T22:00'),
      target_time: '20:45',
      due_at: at('2026-11-03T20:45'),
    })
  })

  test('RT-H14: the same with a custom time — clamped to the deadline and re-derived', () => {
    const t = createTask({
      ...OWNER,
      input: {
        title: 'Shared custom',
        project_id: 2,
        deadline_at: at('2026-11-03T20:45'),
        target_days_before: 0,
        target_time: '20:30',
      },
    })
    updateTask({ ...COLLABORATOR, taskId: t.id, input: { deadline_at: at('2026-11-03T22:00') } })
    updateTask({ ...OWNER, taskId: t.id, input: { target_time: '21:00' } })
    expect(getTaskById(t.id)!.due_at).toBe(at('2026-11-03T21:00'))
    executeUndo(2)
    expect(getTaskById(t.id)).toMatchObject({
      deadline_at: at('2026-11-03T20:45'),
      target_time: '20:45',
      due_at: at('2026-11-03T20:45'),
    })
    executeRedo(2)
    expect(getTaskById(t.id)).toMatchObject({
      deadline_at: at('2026-11-03T22:00'),
      due_at: at('2026-11-03T20:45'),
    })
  })
})
