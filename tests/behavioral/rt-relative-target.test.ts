/**
 * RT: RELATIVE TARGETS (2026-10-24; docs/TASK-MODEL.md § Relative targets;
 * plan `plan-relative-targets-1024.md` §1, §3, §4, §7, §8). A one-off with a
 * deadline may carry a target RELATIVE to it — `target_days_before` local
 * days before, at `target_time` (a custom time, or a reminder period's start
 * via `target_slot_id`) — derived by ONE function, `relativeTargetAt`, which
 * deadline-anchored repeats share. Any picked date makes it fixed again.
 *
 * Pure rules first, then every write path of §1, the deadlines page / deck /
 * Upcoming of §3, undo and the description of §4, the repeats of §7, then the
 * guards RT-G01..G03 (§8). Every date is a LOCAL time in America/Chicago;
 * Sun Nov 1 2026 and Sun Mar 14 2027 are the DST changes.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { DateTime } from 'luxon'
import {
  bulkEdit,
  bulkSnooze,
  createTask,
  deleteTask,
  markDone,
  markUndone,
  restoreTask,
  snoozeTask,
  updateTask,
} from '@/core/tasks'
import { getTaskById } from '@/core/tasks/read'
import { CALENDAR_DAY_START } from '@/lib/opentask-day'
import { deckTasks } from '@/core/tasks/deck'
import { targetTasksToday } from '@/core/tasks/task-segments'
import { getCurrentlyDueTaskIds } from '@/core/tasks/currently-due'
import { executeRedo, executeUndo } from '@/core/undo'
import { withoutAutoTarget } from '@/core/undo/auto-target-fence'
import { listTimeSlots } from '@/core/time-slots'
import {
  RELATIVE_KIND_MESSAGE,
  RELATIVE_NEEDS_DEADLINE_MESSAGE,
  RELATIVE_PAIR_MESSAGE,
  RELATIVE_WITH_DEADLINE_CLEAR_MESSAGE,
  RELATIVE_WITH_DECK_MESSAGE,
  RELATIVE_WITH_TARGET_MESSAGE,
  TARGET_SLOT_NOT_OWNED_MESSAGE,
  TARGET_SLOT_TIME_MESSAGE,
} from '@/core/tasks/relative-target'
import {
  RELATIVE_TARGET_MESSAGES,
  hasPickedTarget,
  isDeadlinePageTask,
  isRelativeOneOff,
  occurrenceDates,
  relativeOneOffProblem,
  relativeTargetAt,
  upcomingState,
} from '@/lib/task-segments'
import {
  seedTestProject,
  seedTestUser,
  setupTestDb,
  teardownTestDb,
  TEST_TIMEZONE,
  TEST_USER_ID,
} from '../helpers/setup'

const tz = TEST_TIMEZONE
const OTHER = 2
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
function slot(label: string, userId = TEST_USER_ID) {
  const found = listTimeSlots(userId).find((s) => s.label === label)
  if (!found) throw new Error(`no period ${label}`)
  return found
}
/** Deadline Tue Nov 3 8:30 AM; the target the day before at `time` (6 PM by default). */
function dayBefore(extra: Record<string, unknown> = {}) {
  return make({
    deadline_at: at('2026-11-03T08:30'),
    target_days_before: 1,
    target_time: '18:00',
    ...extra,
  })
}

beforeEach(() => {
  setupTestDb()
  // Mon Oct 26 2026, 10:00 Chicago.
  setClock('2026-10-26T10:00')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
  teardownTestDb()
})

describe('RT: relativeTargetAt and its helpers (pure)', () => {
  test('RT01: local calendar days before the deadline, at the time, clamped to the deadline', () => {
    const deadline = at('2026-11-03T08:30')
    expect(relativeTargetAt(deadline, { days_before: 1, time: '20:30' }, tz)).toBe(
      at('2026-11-02T20:30'),
    )
    expect(relativeTargetAt(deadline, { days_before: 0, time: '06:00' }, tz)).toBe(
      at('2026-11-03T06:00'),
    )
    // A later time on the deadline day clamps to the deadline itself.
    expect(relativeTargetAt(deadline, { days_before: 0, time: '09:00' }, tz)).toBe(deadline)
  })

  test('RT02: DST across Nov 1 — calendar days, so the wall time holds on both sides', () => {
    const deadline = at('2026-11-02T09:00') // Monday, CST
    // Sat Oct 31 is still CDT (-5), Sun Nov 1 is CST (-6): the same 10:00.
    expect(relativeTargetAt(deadline, { days_before: 2, time: '10:00' }, tz)).toBe(
      '2026-10-31T15:00:00.000Z',
    )
    expect(relativeTargetAt(deadline, { days_before: 1, time: '10:00' }, tz)).toBe(
      '2026-11-01T16:00:00.000Z',
    )
  })

  test('RT03: a time in the spring-forward gap → the next valid minute', () => {
    const deadline = at('2027-03-15T09:00')
    expect(relativeTargetAt(deadline, { days_before: 1, time: '02:30' }, tz)).toBe(
      at('2027-03-14T03:00'),
    )
  })

  test('RT04: occurrenceDates derives a deadline-anchored target through the same function', () => {
    const schedule = {
      rrule: 'FREQ=WEEKLY;BYDAY=TU;BYHOUR=8;BYMINUTE=30',
      repeat_anchor: 'deadline' as const,
      target_days_before: 1,
      target_time: '20:30',
    }
    const occ = at('2026-11-03T08:30')
    expect(occurrenceDates(schedule, occ, tz).targetAt).toBe(
      relativeTargetAt(occ, { days_before: 1, time: '20:30' }, tz),
    )
  })

  test('RT05: isRelativeOneOff and the same-day refusal', () => {
    const base = {
      rrule: null,
      deadline_at: at('2026-11-03T08:30'),
      target_days_before: 1,
      target_time: '18:00',
    }
    expect(isRelativeOneOff(base)).toBe(true)
    expect(isRelativeOneOff({ ...base, rrule: 'FREQ=DAILY' })).toBe(false)
    expect(isRelativeOneOff({ ...base, deadline_at: null })).toBe(false)
    expect(isRelativeOneOff({ ...base, target_time: null })).toBe(false)
    expect(isRelativeOneOff({ ...base, is_reminder: true })).toBe(false)
    expect(isRelativeOneOff({ ...base, is_tracked: true })).toBe(false)
    const deadline = at('2026-11-03T08:30')
    expect(relativeOneOffProblem({ days_before: 0, time: '08:31' }, deadline, tz)).toBe(
      'after_deadline',
    )
    expect(relativeOneOffProblem({ days_before: 0, time: '08:30' }, deadline, tz)).toBeNull()
    expect(relativeOneOffProblem({ days_before: 1, time: '23:00' }, deadline, tz)).toBeNull()
  })
})

describe('RT: create', () => {
  test('RT10: a relative one-off — derived, picked (not automatic), quiet until its heads-up', () => {
    const t = dayBefore()
    expect(t).toMatchObject({
      rrule: null,
      due_at: at('2026-11-02T18:00'),
      target_days_before: 1,
      target_time: '18:00',
      target_slot_id: null,
      target_auto: false,
    })
    expect(isRelativeOneOff(t)).toBe(true)
    expect(hasPickedTarget(t)).toBe(true)
    // Wait 7 (Oct 26 → Nov 2): only the day before, Sun Nov 1.
    expect(upcomingState(t, tz, new Date(at('2026-10-31T21:00')), CALENDAR_DAY_START)).toBeNull()
    expect(
      upcomingState(t, tz, new Date(at('2026-11-01T21:00')), CALENDAR_DAY_START),
    ).not.toBeNull()
  })

  test('RT11: linked to a period — the time is its start (resolved at write time)', () => {
    const evening = slot('Evening')
    const t = make({
      deadline_at: at('2026-11-03T08:30'),
      target_days_before: 1,
      target_slot_id: evening.id,
    })
    expect(t).toMatchObject({
      due_at: at('2026-11-02T20:30'),
      target_time: '20:30',
      target_slot_id: evening.id,
    })
    // The same time sent with it is fine; another is a 400.
    expect(
      make({
        deadline_at: at('2026-11-03T08:30'),
        target_days_before: 1,
        target_time: '20:30',
        target_slot_id: evening.id,
      }).target_slot_id,
    ).toBe(evening.id)
    expect(() =>
      make({
        deadline_at: at('2026-11-03T08:30'),
        target_days_before: 1,
        target_time: '19:00',
        target_slot_id: evening.id,
      }),
    ).toThrow(TARGET_SLOT_TIME_MESSAGE)
  })

  test('RT12: the 400s', () => {
    const d = at('2026-11-03T08:30')
    expect(() => make({ target_days_before: 1, target_time: '18:00' })).toThrow(
      RELATIVE_NEEDS_DEADLINE_MESSAGE,
    )
    expect(() => make({ deadline_at: d, target_days_before: 1 })).toThrow(RELATIVE_PAIR_MESSAGE)
    expect(() =>
      make({
        deadline_at: d,
        due_at: at('2026-11-01T09:00'),
        target_days_before: 1,
        target_time: '18:00',
      }),
    ).toThrow(RELATIVE_WITH_TARGET_MESSAGE)
    expect(() => make({ deadline_at: d, target_days_before: 0, target_time: '09:00' })).toThrow(
      RELATIVE_TARGET_MESSAGES.after_deadline,
    )
    expect(() =>
      make({ deadline_at: d, is_reminder: true, target_days_before: 1, target_time: '18:00' }),
    ).toThrow(RELATIVE_KIND_MESSAGE)
    expect(() => make({ deadline_at: d, target_days_before: 1, target_slot_id: 999999 })).toThrow(
      TARGET_SLOT_NOT_OWNED_MESSAGE,
    )
  })

  test('RT13: offsets with a deck are refused (a deck has no target)', () => {
    vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
    expect(() =>
      make({
        deadline_at: at('2026-11-03T08:30'),
        target_days_before: 1,
        target_time: '18:00',
        on_deck_day: '2026-10-28',
      }),
    ).toThrow(RELATIVE_WITH_DECK_MESSAGE)
  })

  test('RT14: a derived target already past is overdue at once (ruling 3)', () => {
    const t = make({
      deadline_at: at('2026-10-27T08:30'),
      target_days_before: 1,
      target_time: '09:00',
    })
    expect(t.due_at).toBe(at('2026-10-26T09:00'))
    expect(getCurrentlyDueTaskIds(TEST_USER_ID)).toContain(t.id)
  })
})

describe('RT: PATCH, bulk edit, snooze', () => {
  test('RT20: offsets on a fixed one-off make it relative; the stamp restarts', () => {
    const t = make({ deadline_at: at('2026-11-03T08:30'), due_at: at('2026-10-30T09:00') })
    setClock('2026-10-27T10:00')
    const r = patch(t.id, { target_days_before: 2, target_time: '07:00' })
    expect(r.task).toMatchObject({
      due_at: at('2026-11-01T07:00'),
      target_days_before: 2,
      target_time: '07:00',
      target_auto: false,
      target_set_at: at('2026-10-27T10:00'),
    })
  })

  test('RT21: a deadline move recomputes the target and restamps; not a snooze', () => {
    const t = dayBefore()
    const origin = t.original_due_at
    setClock('2026-10-29T10:00')
    const r = patch(t.id, { deadline_at: at('2026-11-05T08:30') })
    expect(r.task).toMatchObject({
      deadline_at: at('2026-11-05T08:30'),
      due_at: at('2026-11-04T18:00'),
      target_days_before: 1,
      target_time: '18:00',
      target_set_at: at('2026-10-29T10:00'),
      original_due_at: origin,
    })
    expect(r.description).not.toMatch(/Deferred/)
  })

  test('RT22: a deadline moved so the same-day time is after it clamps (no 400)', () => {
    const t = make({
      deadline_at: at('2026-11-03T18:00'),
      target_days_before: 0,
      target_time: '17:00',
    })
    const r = patch(t.id, { deadline_at: at('2026-11-03T16:00') })
    expect(r.task.due_at).toBe(at('2026-11-03T16:00'))
    expect(r.task.target_time).toBe('17:00')
  })

  test('RT23: a pick makes it fixed — the offsets and the link go; the description is the pick', () => {
    const t = dayBefore({ target_time: undefined, target_slot_id: slot('Evening').id })
    const r = patch(t.id, { due_at: at('2026-10-31T09:00') })
    expect(r.task).toMatchObject({
      due_at: at('2026-10-31T09:00'),
      target_days_before: null,
      target_time: null,
      target_slot_id: null,
    })
    expect(r.description).toMatch(/Deferred/)
    expect(r.description).not.toMatch(/Target/)
    // Now a deadline move leaves the fixed target where it is.
    const moved = patch(t.id, { deadline_at: at('2026-11-06T08:30') })
    expect(moved.task.due_at).toBe(at('2026-10-31T09:00'))
  })

  test('RT24: target_at WITH offsets is a 400 (ruling 7); deadline null with offsets too', () => {
    const t = dayBefore()
    expect(() =>
      patch(t.id, { due_at: at('2026-10-31T09:00'), target_days_before: 2, target_time: '09:00' }),
    ).toThrow(RELATIVE_WITH_TARGET_MESSAGE)
    expect(() => patch(t.id, { deadline_at: null, target_days_before: 2 })).toThrow(
      RELATIVE_WITH_DEADLINE_CLEAR_MESSAGE,
    )
    expect(() => patch(t.id, { target_days_before: 0, target_time: '09:00' })).toThrow(
      RELATIVE_TARGET_MESSAGES.after_deadline,
    )
  })

  test('RT25: removing the deadline keeps the target, fixed (ruling 5)', () => {
    const t = dayBefore()
    const r = patch(t.id, { deadline_at: null })
    expect(r.task).toMatchObject({
      deadline_at: null,
      due_at: at('2026-11-02T18:00'),
      target_days_before: null,
      target_time: null,
    })
  })

  test('RT26: {target_days_before: null, target_time: null} makes it fixed where it is', () => {
    const t = dayBefore()
    const r = patch(t.id, { target_days_before: null, target_time: null })
    expect(r.task).toMatchObject({
      due_at: at('2026-11-02T18:00'),
      target_days_before: null,
      target_time: null,
    })
    // Fixed: a deadline move no longer carries it.
    expect(patch(t.id, { deadline_at: at('2026-11-10T08:30') }).task.due_at).toBe(
      at('2026-11-02T18:00'),
    )
  })
})

describe('RT: clearing, the link, defers, bulk edit', () => {
  test('RT27: Remove target clears everything; switch on → the deadlines page', () => {
    vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
    const t = dayBefore({ target_time: undefined, target_slot_id: slot('Evening').id })
    const r = patch(t.id, { due_at: null })
    expect(r.task).toMatchObject({
      due_at: null,
      target_days_before: null,
      target_time: null,
      target_slot_id: null,
    })
    expect(isDeadlinePageTask(r.task)).toBe(true)
    expect(r.task.lead_from).not.toBeNull()
  })

  test('RT28: the link — a time alone is custom; a period alone links; null unlinks', () => {
    const evening = slot('Evening')
    const t = dayBefore()
    const linked = patch(t.id, { target_slot_id: evening.id })
    expect(linked.task).toMatchObject({
      target_slot_id: evening.id,
      target_time: '20:30',
      due_at: at('2026-11-02T20:30'),
    })
    const custom = patch(t.id, { target_time: '19:15' })
    expect(custom.task).toMatchObject({
      target_slot_id: null,
      target_time: '19:15',
      due_at: at('2026-11-02T19:15'),
    })
    patch(t.id, { target_slot_id: evening.id })
    const unlinked = patch(t.id, { target_slot_id: null })
    expect(unlinked.task).toMatchObject({
      target_slot_id: null,
      target_time: '20:30',
      due_at: at('2026-11-02T20:30'),
    })
    // A period of another user's is a 400 — the owner's periods only.
    seedTestUser(OTHER, 'other@example.com')
    expect(() => patch(t.id, { target_slot_id: slot('Evening', OTHER).id })).toThrow(
      TARGET_SLOT_NOT_OWNED_MESSAGE,
    )
  })

  test('RT29: every defer makes it fixed — the snooze endpoint, bulk snooze, Today', () => {
    const a = dayBefore()
    const b = dayBefore()
    const c = dayBefore()
    snoozeTask({ ...u, taskId: a.id, until: at('2026-10-30T09:00') })
    bulkSnooze({ ...u, taskIds: [b.id], until: at('2026-10-30T09:00'), includeTaskIds: [b.id] })
    targetTasksToday(TEST_USER_ID, tz, [c.id])
    for (const id of [a.id, b.id, c.id]) {
      expect(getTaskById(id), `task ${id}`).toMatchObject({
        target_days_before: null,
        target_time: null,
        target_slot_id: null,
      })
    }
    expect(getTaskById(a.id)!.due_at).toBe(at('2026-10-30T09:00'))
  })

  test('RT30: bulk edit sets offsets per task, under the per-task rules (ruling 8)', () => {
    const a = make({ deadline_at: at('2026-11-03T08:30') })
    const b = make({ deadline_at: at('2026-11-10T17:00') })
    const plain = make({ due_at: at('2026-11-01T09:00') })
    bulkEdit({
      ...u,
      taskIds: [a.id, b.id],
      changes: { target_days_before: 1, target_slot_id: slot('Evening').id },
    })
    expect(getTaskById(a.id)!.due_at).toBe(at('2026-11-02T20:30'))
    expect(getTaskById(b.id)!.due_at).toBe(at('2026-11-09T20:30'))
    expect(getTaskById(b.id)!.target_slot_id).toBe(slot('Evening').id)
    // One task with no deadline refuses the whole batch.
    expect(() =>
      bulkEdit({
        ...u,
        taskIds: [a.id, plain.id],
        changes: { target_days_before: 2, target_time: '09:00' },
      }),
    ).toThrow(RELATIVE_NEEDS_DEADLINE_MESSAGE)
    expect(getTaskById(a.id)!.target_days_before).toBe(1)
  })

  test('RT31: becoming a reminder takes the relative target with it', () => {
    const t = dayBefore()
    const r = patch(t.id, { is_reminder: true, deadline_at: null })
    expect(r.task).toMatchObject({ target_days_before: null, target_time: null })
  })
})

describe('RT: deck, deadlines page, Upcoming (plan §3)', () => {
  test('RT40: decking drops the target, the offsets and the link; a relative pick clears a deck', () => {
    vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
    const t = dayBefore({ target_time: undefined, target_slot_id: slot('Evening').id })
    deckTasks({ userId: TEST_USER_ID, timezone: tz, ids: [t.id], day: '2026-10-28' })
    expect(getTaskById(t.id)).toMatchObject({
      on_deck_day: '2026-10-28',
      due_at: null,
      target_days_before: null,
      target_time: null,
      target_slot_id: null,
    })
    const r = patch(t.id, { target_days_before: 1, target_time: '18:00' })
    expect(r.task).toMatchObject({ on_deck_day: null, due_at: at('2026-11-02T18:00') })
  })

  test('RT41: a relative target takes the task off the deadlines page', () => {
    vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
    const t = make({ deadline_at: at('2026-11-03T08:30') })
    expect(isDeadlinePageTask(t)).toBe(true)
    const r = patch(t.id, { target_days_before: 1, target_time: '18:00' })
    expect(isDeadlinePageTask(r.task)).toBe(false)
  })
})

describe('RT: undo, activity (plan §4)', () => {
  test('RT50: one snapshot holds the target, the offsets, the link and the stamp', () => {
    const evening = slot('Evening')
    const t = make({ deadline_at: at('2026-11-03T08:30'), due_at: at('2026-10-30T09:00') })
    const stamp = t.target_set_at
    setClock('2026-10-27T10:00')
    const r = patch(t.id, { target_days_before: 1, target_slot_id: evening.id })
    expect(r.description).toBe('Target the day before at Evening (8:30 PM) — "Task"')
    executeUndo(TEST_USER_ID)
    expect(getTaskById(t.id)).toMatchObject({
      due_at: at('2026-10-30T09:00'),
      target_days_before: null,
      target_time: null,
      target_slot_id: null,
      target_set_at: stamp,
    })
    executeRedo(TEST_USER_ID)
    expect(getTaskById(t.id)).toMatchObject({
      due_at: at('2026-11-02T20:30'),
      target_slot_id: evening.id,
    })
  })

  test('RT51: undo of a pick that made it fixed puts the relative target back', () => {
    const t = dayBefore()
    patch(t.id, { due_at: at('2026-10-31T09:00') })
    executeUndo(TEST_USER_ID)
    expect(getTaskById(t.id)).toMatchObject({
      due_at: at('2026-11-02T18:00'),
      target_days_before: 1,
      target_time: '18:00',
    })
  })

  test('RT52: the undo fence drops the offsets and the link with an automatic target', () => {
    vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
    const applied = withoutAutoTarget(
      { target_auto: true, due_at: at('2026-11-01T09:00'), target_days_before: 1 },
      ['target_auto', 'due_at'],
    )
    expect(applied.dropped).toBe(true)
    expect(applied.state).toMatchObject({
      target_days_before: null,
      target_time: null,
      target_slot_id: null,
    })
    expect(applied.fields).toEqual(
      expect.arrayContaining(['target_days_before', 'target_time', 'target_slot_id']),
    )
  })
})

describe('RT: reopening re-derives (plan §2 "Reopening")', () => {
  test('RT60: put back after a retime while done — the target follows the period', async () => {
    const { updateTimeSlot } = await import('@/core/time-slots/edit')
    const evening = slot('Evening')
    const t = dayBefore({ target_time: undefined, target_slot_id: evening.id })
    markDone({ ...u, taskId: t.id })
    updateTimeSlot({ ...u, slotId: evening.id, input: { start_time: '21:00' } })
    // Closed: only the time moved (one statement), the target as it was.
    expect(getTaskById(t.id)).toMatchObject({
      target_time: '21:00',
      due_at: at('2026-11-02T20:30'),
    })
    const back = markUndone({ ...u, taskId: t.id })
    expect(back).toMatchObject({ done: false, due_at: at('2026-11-02T21:00') })
  })

  test('RT61: restored from the trash, likewise', async () => {
    const { updateTimeSlot } = await import('@/core/time-slots/edit')
    const evening = slot('Evening')
    const t = dayBefore({ target_time: undefined, target_slot_id: evening.id })
    deleteTask({ userId: TEST_USER_ID, taskId: t.id })
    updateTimeSlot({ ...u, slotId: evening.id, input: { start_time: '21:00' } })
    const back = restoreTask({ userId: TEST_USER_ID, taskId: t.id })
    expect(back).toMatchObject({ deleted_at: null, due_at: at('2026-11-02T21:00') })
  })
})

describe('RT: repeats (plan §7)', () => {
  const TUESDAY = 'FREQ=WEEKLY;BYDAY=TU;BYHOUR=8;BYMINUTE=30'

  test('RT70: Stop repeating keeps an unmoved relative target and its link (ruling 6)', () => {
    const evening = slot('Evening')
    const t = make({
      rrule: TUESDAY,
      deadline_at: at('2026-11-03T08:30'),
      target_days_before: 1,
      target_slot_id: evening.id,
    })
    expect(t.due_at).toBe(at('2026-11-02T20:30'))
    const r = patch(t.id, { rrule: null })
    expect(r.task).toMatchObject({
      rrule: null,
      deadline_at: at('2026-11-03T08:30'),
      due_at: at('2026-11-02T20:30'),
      target_days_before: 1,
      target_time: '20:30',
      target_slot_id: evening.id,
    })
    expect(isRelativeOneOff(r.task)).toBe(true)
  })

  test('RT71: Stop repeating after a move this occurrence: the moved target stays, fixed', () => {
    const t = make({
      rrule: TUESDAY,
      deadline_at: at('2026-11-03T08:30'),
      target_days_before: 1,
      target_time: '18:00',
    })
    snoozeTask({ ...u, taskId: t.id, until: at('2026-11-01T09:00') })
    const r = patch(t.id, { rrule: null })
    expect(r.task).toMatchObject({
      due_at: at('2026-11-01T09:00'),
      target_days_before: null,
      target_time: null,
    })
  })

  test('RT72: Stop repeating on deck nulls them', () => {
    vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
    const t = make({
      rrule: TUESDAY,
      deadline_at: at('2026-11-03T08:30'),
      target_days_before: 1,
      target_time: '18:00',
    })
    deckTasks({ userId: TEST_USER_ID, timezone: tz, ids: [t.id], day: '2026-10-28' })
    const r = patch(t.id, { rrule: null })
    expect(r.task).toMatchObject({ target_days_before: null, target_time: null })
  })

  test('RT73: Make it repeat (on the deadline) keeps the offsets and the link, checked against the rule', () => {
    const evening = slot('Evening')
    const t = dayBefore({ target_time: undefined, target_slot_id: evening.id })
    const r = patch(t.id, { rrule: TUESDAY, repeat_anchor: 'deadline' })
    expect(r.task).toMatchObject({
      repeat_anchor: 'deadline',
      occurrence_at: at('2026-11-03T08:30'),
      due_at: at('2026-11-02T20:30'),
      target_days_before: 1,
      target_slot_id: evening.id,
    })
    // A lead the rule refuses (daily, 2 days before → overlaps) is a 400.
    const d = dayBefore({ target_days_before: 2 })
    expect(() =>
      patch(d.id, { rrule: 'FREQ=DAILY;BYHOUR=8;BYMINUTE=30', repeat_anchor: 'deadline' }),
    ).toThrow(RELATIVE_TARGET_MESSAGES.overlaps_previous)
  })

  test('RT74: Make it repeat on its target clears them', () => {
    const t = dayBefore()
    const r = patch(t.id, {
      rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=18;BYMINUTE=0',
      repeat_anchor: 'target',
      deadline_at: null,
    })
    expect(r.task).toMatchObject({
      repeat_anchor: 'target',
      deadline_at: null,
      target_days_before: null,
      target_time: null,
      target_slot_id: null,
    })
  })

  test('RT75: a deadline-anchored repeat links too; done derives the next from the stored time', () => {
    const evening = slot('Evening')
    const t = make({
      rrule: TUESDAY,
      deadline_at: at('2026-11-03T08:30'),
      target_days_before: 1,
      target_slot_id: evening.id,
    })
    expect(t).toMatchObject({ target_time: '20:30', target_slot_id: evening.id })
    markDone({ ...u, taskId: t.id })
    expect(getTaskById(t.id)).toMatchObject({
      deadline_at: at('2026-11-10T08:30'),
      due_at: at('2026-11-09T20:30'),
      target_slot_id: evening.id,
    })
  })
})

describe('RT-G: guards (plan §8)', () => {
  function files(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) return files(p)
      return /\.tsx?$/.test(e.name) ? [p] : []
    })
  }
  const read = (f: string) => fs.readFileSync(f, 'utf8')
  const root = process.cwd()
  const src = () => files(path.join(root, 'src')).map((f) => path.relative(root, f))

  test('RT-G01: only task-segments.ts does date maths on the offsets', () => {
    // Date arithmetic with a relative target's days: `minus({ days: …days_before… })`
    // or `plus(...)`. Everything else calls `relativeTargetAt` / `occurrenceDates`.
    const maths = /\.(minus|plus)\(\s*\{\s*days:\s*[^}]*days_?[bB]efore/
    const offenders = src()
      .filter((f) => f !== 'src/lib/task-segments.ts')
      .filter((f) => maths.test(read(f)))
    expect(offenders).toEqual([])
    expect(maths.test(read(path.join(root, 'src/lib/task-segments.ts')))).toBe(true)
  })

  /**
   * RT-G02: every SQL writer of the offsets goes through the derivation —
   * it imports `relativeTargetAt`, `occurrenceDates` or `resolveTarget` (or
   * the write side, `repeat-schedule.ts` / `relative-target.ts`) — or is
   * exempt, with a reason.
   */
  test('RT-G02: every writer of the offsets derives through the one function (or is exempt)', () => {
    const EXEMPT: Record<string, string> = {
      // Migrations: the shape before the columns, and the 10-21 anchor migration.
      'src/core/db/index.ts': 'migrations',
      'src/core/db/migrate-repeat-anchor.ts': 'migrations',
      'src/core/db/migrate-deadline-targets.ts': 'migrations',
      // The period hooks move a linked row's TIME only (the invariant: a
      // linked time is the period's start); open rows go through
      // collectFieldChanges, closed rows are re-derived when reopened.
      'src/core/time-slots/edit.ts': "the period's start (closed rows)",
      'src/core/undo/slot-row.ts': "undo/redo of the period hooks' closed rows",
    }
    const writer =
      /\btarget_(days_before|time)\s*=\s*(\?|NULL)|INSERT INTO tasks|trackField\(\s*data,\s*'target_(days_before|time)'|for \(const f of fields\) trackField/
    const derives =
      /\b(relativeTargetAt|occurrenceDates|resolveTarget)\b|from '\.\.?\/(repeat-schedule|relative-target)'/
    const offenders = src()
      .filter((f) => !EXEMPT[f])
      .filter((f) => writer.test(read(f)))
      .filter((f) => !derives.test(read(f)))
    expect(offenders).toEqual([])
  })

  /**
   * RT-G03: every writer of `target_slot_id` resolves the link at write time
   * — it imports `resolveTime` (anchor-times) or the module that does
   * (`relative-target.ts`'s `linkTargetTime`) — or is a period hook, or is
   * exempt, with a reason.
   */
  test('RT-G03: every writer of target_slot_id imports resolveTime (or is a period hook)', () => {
    const EXEMPT: Record<string, string> = {
      'src/core/db/index.ts': 'migrations (the column)',
      // The period hooks: unlink (delete) and their undo/redo.
      'src/core/time-slots/edit.ts': 'period hook',
      'src/core/undo/slot-row.ts': 'period hook (undo/redo)',
      // Unlinks only, beside a dropped/fixed target.
      'src/core/undo/auto-target-fence.ts': 'unlinks only (the undo fence)',
      // PR C (2026-10-24): links through `linkTargetTime` (relative-target.ts,
      // `resolveTime` at write time), after relative-wording.ts mapped the
      // period through `resolveTime` too; also unlinks a target it made fixed.
      'src/core/ai/enrichment.ts': 'links via linkTargetTime (@/core/tasks/relative-target)',
      // THE HEAL (2026-10-24): re-validates a link undo / redo restored
      // against the period's current start — resolving it through the retime
      // path (`collectFieldChanges` with the period sent, i.e. `linkTargetTime`)
      // or unlinking it. Its own writes are the rule, not an exception to it.
      'src/core/tasks/relative-link-heal.ts': 'the heal: a restored link re-validated',
    }
    const writer =
      /\btarget_slot_id\s*=\s*(\?|NULL)|INSERT INTO tasks[^;]*target_slot_id|for \(const f of fields\) trackField/
    const resolves = /\bresolveTime\b|from '\.\.?\/(\.\.\/)?relative-target'/
    const offenders = src()
      .filter((f) => !EXEMPT[f])
      .filter((f) => writer.test(read(f)))
      .filter((f) => !resolves.test(read(f)))
    expect(offenders).toEqual([])
    expect(read(path.join(root, 'src/core/tasks/relative-target.ts'))).toMatch(
      /import \{ resolveTime \} from '@\/lib\/anchor-times'/,
    )
    // Enrichment's exemption holds only while it links through those two.
    expect(read(path.join(root, 'src/core/ai/enrichment.ts'))).toMatch(
      /import \{ linkTargetTime\b[^}]*\} from '@\/core\/tasks\/relative-target'/,
    )
    expect(read(path.join(root, 'src/core/ai/relative-wording.ts'))).toMatch(
      /import \{ resolveTime\b[^}]*\} from '@\/lib\/anchor-times'/,
    )
  })

  /**
   * RT-G05: a snapshot written back is a link written without `resolveTime`,
   * so every writer of snapshots (`applyFieldsToTask`'s callers: undo, redo)
   * runs the heal over every task its entry touched — `healRelativeLinks`,
   * which re-validates each restored link against the current period.
   */
  test('RT-G05: every undo / redo writer heals the links it restores', () => {
    const callers = src()
      .filter((f) => f !== 'src/core/undo/apply-fields.ts')
      .filter((f) => /\bapplyFieldsToTask\(/.test(read(f)))
    expect(callers.length).toBeGreaterThan(0)
    for (const f of callers) expect(read(f), f).toMatch(/\bhealRelativeLinks\(/)
    // The heal resolves through the retime path, which links via linkTargetTime.
    const heal = read(path.join(root, 'src/core/tasks/relative-link-heal.ts'))
    expect(heal).toMatch(/collectFieldChanges\(/)
    expect(heal).toMatch(/retimeRefused\(/)
  })

  test('RT-G04: a shared task links only to its OWNER’s periods (a collaborator’s is a 400)', () => {
    seedTestUser(OTHER, 'other@example.com')
    seedTestProject(2, 'Shared', TEST_USER_ID, true)
    const t = make({ project_id: 2, deadline_at: at('2026-11-03T08:30') })
    expect(() =>
      updateTask({
        userId: OTHER,
        userTimezone: tz,
        taskId: t.id,
        input: { target_days_before: 1, target_slot_id: slot('Evening', OTHER).id },
      }),
    ).toThrow(TARGET_SLOT_NOT_OWNED_MESSAGE)
    // A custom time is fine.
    const r = updateTask({
      userId: OTHER,
      userTimezone: tz,
      taskId: t.id,
      input: { target_days_before: 1, target_time: '18:00' },
    })
    expect(r.task.due_at).toBe(at('2026-11-02T18:00'))
  })
})
