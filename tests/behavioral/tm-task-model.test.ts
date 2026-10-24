/**
 * TM: the 2026-10-10 task model — deadline, target, horizon, task segments
 * (docs/TASK-MODEL.md § Deadline, target, horizon).
 *
 * Clock: Saturday 2026-10-10, 10:00 Chicago (15:00Z) unless a test moves it.
 * Tasks made "old" have their created_at rewritten, since creation counts as
 * seeing a task (it waits for its segment's next day).
 */
import { CALENDAR_DAY_START } from '@/lib/opentask-day'
import { describe, test, expect, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { DateTime } from 'luxon'
import { getDb } from '@/core/db'
import { createTask, updateTask, markDone, bulkSnooze, bulkEdit } from '@/core/tasks'
import { skipOccurrence } from '@/core/tasks/skip'
import { getTaskById } from '@/core/tasks/read'
import { snoozeTask } from '@/core/tasks/snooze'
import { getPreferences } from '@/core/users/preferences'
import { executeUndo, executeRedo } from '@/core/undo'
import {
  considerTasks,
  deferTasks,
  restoreTasks,
  getTaskSegments,
  targetTasksToday,
  targetTodayTime,
} from '@/core/tasks/task-segments'
import { getCurrentlyDueTaskIds } from '@/core/tasks/currently-due'
import {
  effectiveHorizon,
  latestSegmentDay,
  autoTargetAt,
  occurrenceDates,
} from '@/lib/task-segments'
import { countTasks } from '@/lib/task-counts'
import { normalizeTargetAliases } from '@/core/validation/task'
import { formatTaskResponse } from '@/lib/format-task'
import { ValidationError } from '@/core/errors'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

const tz = TEST_TIMEZONE
const SAT = new Date('2026-10-10T15:00:00Z')

function at(iso: string) {
  return DateTime.fromISO(iso, { zone: tz }).toUTC().toISO()!
}

function make(input: Record<string, unknown> = {}) {
  return createTask({
    userId: TEST_USER_ID,
    userTimezone: tz,
    input: { title: 'Task', ...input },
  })
}

function age(id: number, createdLocal: string) {
  getDb().prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run(at(createdLocal), id)
}

/** As `age`, and the target was set then too (attempts never count before it). */
function ageTargeted(id: number, createdLocal: string) {
  getDb()
    .prepare('UPDATE tasks SET created_at = ?, target_set_at = ? WHERE id = ?')
    .run(at(createdLocal), at(createdLocal), id)
}

function segmentOf(id: number) {
  for (const seg of getTaskSegments(TEST_USER_ID, tz)) {
    const hit = seg.tasks.find((t) => t.task.id === id)
    if (hit) return { horizon: seg.horizon, state: hit.state }
  }
  return null
}

describe('Task model', () => {
  afterAll(() => teardownTestDb())
  beforeEach(() => {
    vi.setSystemTime(SAT)
    setupTestDb()
    getDb().prepare('DELETE FROM time_slots WHERE user_id = ?').run(TEST_USER_ID)
    getDb()
      .prepare(
        "INSERT INTO time_slots (user_id, label, start_time, sort_order) VALUES (?, 'Morning', '08:30', 0), (?, 'After school', '16:00', 1), (?, 'Evening', '21:00', 2)",
      )
      .run(TEST_USER_ID, TEST_USER_ID, TEST_USER_ID)
  })
  afterEach(() => vi.useRealTimers())

  describe('segment schedule', () => {
    const day = (s: string) => DateTime.fromISO(s, { zone: tz }).startOf('day')
    test('TM-001: weeks come round on Saturday, months on the first Saturday, eventually quarterly', () => {
      expect(latestSegmentDay('weeks', day('2026-10-14')).toISODate()).toBe('2026-10-10')
      expect(latestSegmentDay('weeks', day('2026-10-10')).toISODate()).toBe('2026-10-10')
      expect(latestSegmentDay('months', day('2026-10-14')).toISODate()).toBe('2026-10-03')
      // Before October's first Saturday: September's.
      expect(latestSegmentDay('months', day('2026-10-02')).toISODate()).toBe('2026-09-05')
      expect(latestSegmentDay('eventually', day('2026-12-20')).toISODate()).toBe('2026-10-03')
      expect(latestSegmentDay('eventually', day('2026-10-01')).toISODate()).toBe('2026-07-04')
      expect(latestSegmentDay('days', day('2026-10-14')).toISODate()).toBe('2026-10-14')
    })

    test('TM-002: unset reads as weeks; a near deadline pulls the horizon in, never out', () => {
      const now = SAT
      expect(effectiveHorizon({ horizon: null, deadline_at: null }, now)).toBe('weeks')
      expect(
        effectiveHorizon({ horizon: 'months', deadline_at: at('2026-10-15T12:00') }, now),
      ).toBe('days')
      expect(
        effectiveHorizon({ horizon: 'months', deadline_at: at('2026-10-25T12:00') }, now),
      ).toBe('weeks')
      expect(effectiveHorizon({ horizon: 'days', deadline_at: at('2027-06-01T12:00') }, now)).toBe(
        'days',
      )
    })
  })

  describe('segments', () => {
    test("TM-010: a task shows from its segment's first shown day on or after its creation", () => {
      const old = make({ title: 'Squeaky door' })
      age(old.id, '2026-10-01T09:00')
      expect(segmentOf(old.id)).toEqual({ horizon: 'weeks', state: 'waiting' })
      // Created ON a shown day (Saturday, weeks): it shows today.
      const fresh = make({ title: 'Just added' })
      expect(segmentOf(fresh.id)).toEqual({ horizon: 'weeks', state: 'waiting' })
      // A days task shows the day it is written down.
      vi.setSystemTime(new Date(at('2026-10-11T12:00'))) // Sunday
      const today = make({ title: 'Days, new', horizon: 'days' })
      expect(segmentOf(today.id)).toEqual({ horizon: 'days', state: 'waiting' })
      // A weeks task created AFTER Saturday waits for the next one.
      const sunday = make({ title: 'Weeks, Sunday' })
      expect(segmentOf(sunday.id)).toBeNull()
      vi.setSystemTime(new Date(at('2026-10-17T09:00'))) // next Saturday
      expect(segmentOf(sunday.id)).toEqual({ horizon: 'weeks', state: 'waiting' })
    })

    test('TM-011: a weeks task not considered on Saturday carries over daily until it is', () => {
      const t = make({ horizon: 'weeks' })
      age(t.id, '2026-10-01T09:00')
      vi.setSystemTime(new Date(at('2026-10-13T09:00'))) // Tuesday
      expect(segmentOf(t.id)?.state).toBe('waiting')
      considerTasks(TEST_USER_ID, [t.id])
      expect(segmentOf(t.id)?.state).toBe('considered')
      vi.setSystemTime(new Date(at('2026-10-14T09:00')))
      expect(segmentOf(t.id)).toBeNull()
      vi.setSystemTime(new Date(at('2026-10-17T09:00'))) // next Saturday
      expect(segmentOf(t.id)?.state).toBe('waiting')
    })

    test('TM-012: a target of its own takes a one-off out of the horizon segments, today or later (2026-10-12)', () => {
      const today = make({ due_at: at('2026-10-10T20:00') })
      const later = make({ due_at: at('2026-11-01T09:00') })
      age(today.id, '2026-10-01T09:00')
      age(later.id, '2026-10-01T09:00')
      expect(segmentOf(today.id)).toBeNull()
      // Spec §1: a target makes it quiet until its date (Upcoming aside).
      expect(segmentOf(later.id)).toBeNull()
    })

    test('TM-013: reminders, quotas and recurring tasks never appear', () => {
      const r = make({ is_reminder: true, rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0' })
      const q = make({ is_tracked: true, progress_target: 3, rrule: 'FREQ=WEEKLY' })
      const rec = make({ rrule: 'FREQ=WEEKLY;BYDAY=MO' })
      for (const t of [r, q, rec]) age(t.id, '2026-10-01T09:00')
      for (const t of [r, q, rec]) expect(segmentOf(t.id)).toBeNull()
    })

    test('TM-014: order is priority then id, and acting on one never reorders the rest', () => {
      const ids = [0, 3, 1, 3].map((p) => make({ priority: p }).id)
      for (const id of ids) age(id, '2026-10-01T09:00')
      const order = () => getTaskSegments(TEST_USER_ID, tz)[0].tasks.map((t) => t.task.id)
      expect(order()).toEqual([ids[1], ids[3], ids[2], ids[0]])
      considerTasks(TEST_USER_ID, [ids[3]])
      expect(order()).toEqual([ids[1], ids[3], ids[2], ids[0]])
    })

    test('TM-015: Defer All hides the rest today, is not a consider, and they return tomorrow', () => {
      const t = make()
      age(t.id, '2026-10-01T09:00')
      deferTasks(TEST_USER_ID, [t.id])
      expect(segmentOf(t.id)?.state).toBe('deferred')
      expect(getTaskById(t.id)!.last_considered_at).toBeNull()
      vi.setSystemTime(new Date(at('2026-10-11T09:00')))
      expect(segmentOf(t.id)?.state).toBe('waiting')
    })

    test('TM-016: consider is one undo entry and Undo puts it back to waiting', () => {
      const t = make()
      age(t.id, '2026-10-01T09:00')
      considerTasks(TEST_USER_ID, [t.id])
      expect(segmentOf(t.id)?.state).toBe('considered')
      executeUndo(TEST_USER_ID)
      expect(segmentOf(t.id)?.state).toBe('waiting')
    })

    test("TM-017: consider refuses a task that is not the caller's own open task", () => {
      const t = make()
      markDone({ userId: TEST_USER_ID, userTimezone: tz, taskId: t.id })
      expect(() => considerTasks(TEST_USER_ID, [t.id])).toThrow(ValidationError)
    })

    test('TM-019: put back undoes a consider or a defer, and the row waits again', () => {
      const a = make({ title: 'Put back a' })
      const b = make({ title: 'Put back b' })
      age(a.id, '2026-10-01T09:00')
      age(b.id, '2026-10-01T09:00')
      considerTasks(TEST_USER_ID, [a.id])
      deferTasks(TEST_USER_ID, [b.id])
      expect(segmentOf(a.id)?.state).toBe('considered')
      expect(segmentOf(b.id)?.state).toBe('deferred')
      restoreTasks(TEST_USER_ID, [a.id, b.id])
      expect(segmentOf(a.id)?.state).toBe('waiting')
      expect(segmentOf(b.id)?.state).toBe('waiting')
      // One undo entry takes the put-back back.
      executeUndo(TEST_USER_ID)
      expect(segmentOf(a.id)?.state).toBe('considered')
      expect(segmentOf(b.id)?.state).toBe('deferred')
    })

    test('TM-018: a segment over 50 items asks for help', () => {
      const ids = Array.from({ length: 51 }, () => make().id)
      for (const id of ids) age(id, '2026-10-01T09:00')
      expect(getTaskSegments(TEST_USER_ID, tz)[0].nudge).toBe(true)
      // Only what still waits counts: considered rows aren't "here" any more.
      considerTasks(TEST_USER_ID, ids.slice(0, 49))
      expect(getTaskSegments(TEST_USER_ID, tz)[0].nudge).toBe(false)
    })
  })

  describe('target today', () => {
    test('TM-020: goes to the next period today, restarts the age, marks considered', () => {
      const t = make({ due_at: at('2026-09-20T09:00') })
      updateTask({ userId: TEST_USER_ID, userTimezone: tz, taskId: t.id, input: { due_at: null } })
      age(t.id, '2026-09-01T09:00')
      const { until } = targetTasksToday(TEST_USER_ID, tz, [t.id])
      expect(until).toBe(at('2026-10-10T16:00'))
      const after = getTaskById(t.id)!
      expect(after.due_at).toBe(until)
      expect(after.original_due_at).toBe(until)
      expect(after.last_considered_at).not.toBeNull()
      expect(segmentOf(t.id)).toBeNull()
      // One Undo puts back both the target and the considered stamp.
      executeUndo(TEST_USER_ID)
      expect(getTaskById(t.id)!.due_at).toBeNull()
      expect(getTaskById(t.id)!.last_considered_at).toBeNull()
    })

    test('TM-021: with no period left today, the top of the next hour', () => {
      vi.setSystemTime(new Date(at('2026-10-10T22:10')))
      expect(targetTodayTime(TEST_USER_ID, tz)).toBe(at('2026-10-10T23:00'))
    })

    test('TM-022: stamps segment_targeted_at in the same undo entry; Undo puts the old stamp back', () => {
      const t = make()
      age(t.id, '2026-10-01T09:00')
      targetTasksToday(TEST_USER_ID, tz, [t.id])
      const first = getTaskById(t.id)!.segment_targeted_at
      expect(first).toBe(SAT.toISOString())
      // Re-targeted later: a new stamp; Undo restores the FIRST one, not null.
      vi.setSystemTime(new Date(at('2026-10-10T10:05')))
      targetTasksToday(TEST_USER_ID, tz, [t.id], at('2026-10-10T14:00'))
      expect(getTaskById(t.id)!.segment_targeted_at).toBe(
        new Date(at('2026-10-10T10:05')).toISOString(),
      )
      executeUndo(TEST_USER_ID)
      expect(getTaskById(t.id)!.segment_targeted_at).toBe(first)
      executeUndo(TEST_USER_ID)
      expect(getTaskById(t.id)!.segment_targeted_at).toBeNull()
      expect(getTaskById(t.id)!.due_at).toBeNull()
      // Redo brings it back with the target.
      executeRedo(TEST_USER_ID)
      expect(getTaskById(t.id)!.segment_targeted_at).toBe(first)
      expect(formatTaskResponse(getTaskById(t.id)!, tz).segment_targeted_at).toBe(first)
    })

    test('TM-023: only the segment action stamps it — not a snooze, an edit or a create', () => {
      const t = make({ due_at: at('2026-10-10T09:00') })
      expect(t.segment_targeted_at).toBeNull()
      snoozeTask({
        userId: TEST_USER_ID,
        userTimezone: tz,
        taskId: t.id,
        until: at('2026-10-10T12:00'),
      })
      updateTask({
        userId: TEST_USER_ID,
        userTimezone: tz,
        taskId: t.id,
        input: { due_at: at('2026-10-11T09:00'), priority: 2 },
      })
      bulkSnooze({
        userId: TEST_USER_ID,
        userTimezone: tz,
        taskIds: [t.id],
        until: at('2026-10-12T09:00'),
      })
      expect(getTaskById(t.id)!.segment_targeted_at).toBeNull()
    })

    test('TM-024: `at` targets at that moment — today, or a later day; a past day is refused', () => {
      const t = make()
      age(t.id, '2026-10-01T09:00')
      // Earlier today is a commitment for today: allowed (over target at once).
      const { until } = targetTasksToday(TEST_USER_ID, tz, [t.id], at('2026-10-10T07:15'))
      expect(until).toBe(at('2026-10-10T07:15'))
      expect(getTaskById(t.id)!.due_at).toBe(until)
      expect(getTaskById(t.id)!.original_due_at).toBe(until)
      // A later day: targeted then. It leaves the horizon segment (spec §1) and,
      // set today, has no heads-up today either.
      targetTasksToday(TEST_USER_ID, tz, [t.id], at('2026-10-13T15:00'))
      expect(getTaskById(t.id)!.due_at).toBe(at('2026-10-13T15:00'))
      expect(segmentOf(t.id)).toBeNull()
      // Yesterday: refused, nothing written.
      expect(() => targetTasksToday(TEST_USER_ID, tz, [t.id], at('2026-10-09T23:30'))).toThrow(
        ValidationError,
      )
      expect(getTaskById(t.id)!.due_at).toBe(at('2026-10-13T15:00'))
    })

    test('TM-025: like every move, a picked time is capped at the deadline (§8.2)', () => {
      // Deadline Mon Oct 12 12:00: its automatic target is now (a 2-day wait,
      // lead 3 → a morning already past).
      const t = make({ deadline_at: at('2026-10-12T12:00') })
      age(t.id, '2026-10-01T09:00')
      targetTasksToday(TEST_USER_ID, tz, [t.id], at('2026-10-13T09:00'))
      const after = getTaskById(t.id)!
      expect(after.due_at).toBe(at('2026-10-12T12:00'))
      expect(after.target_auto).toBe(false)
      expect(after.deadline_at).toBe(at('2026-10-12T12:00'))
    })
  })

  describe('deadline', () => {
    test('TM-030: a single snooze past a future deadline stops AT it — never refused (§8.2)', () => {
      const t = make({ due_at: at('2026-10-10T09:00'), deadline_at: at('2026-10-10T18:00') })
      const snooze = (allow?: boolean) =>
        updateTask({
          userId: TEST_USER_ID,
          userTimezone: tz,
          taskId: t.id,
          input: { due_at: at('2026-10-11T09:00'), allow_past_deadline: allow },
        })
      const r = snooze()
      expect(r.task.due_at).toBe(at('2026-10-10T18:00'))
      expect(r.cappedAtDeadline).toBe(true)
      expect(r.description).toMatch(/^Deferred to deadline/)
      // `allow_past_deadline` is accepted from old clients and ignored.
      expect(snooze(true).task.due_at).toBe(at('2026-10-10T18:00'))
      expect(getTaskById(t.id)!.deadline_at).toBe(at('2026-10-10T18:00'))
    })

    test('TM-031: once the deadline has passed, a snooze past it is allowed (2026-10-12 ruling)', () => {
      const t = make({ due_at: at('2026-10-09T09:00'), deadline_at: at('2026-10-09T18:00') })
      const r = updateTask({
        userId: TEST_USER_ID,
        userTimezone: tz,
        taskId: t.id,
        input: { due_at: at('2026-10-11T09:00') },
      })
      expect(r.task.due_at).toBe(at('2026-10-11T09:00'))
      expect(r.cappedAtDeadline).toBe(false)
      expect(r.description).toMatch(/^Deferred/)
      expect(r.task.deadline_at).toBe(at('2026-10-09T18:00'))
      expect(getCurrentlyDueTaskIds(TEST_USER_ID)).not.toContain(t.id)
    })

    test('TM-032: a re-target past the deadline is a move like any other: capped', () => {
      const t = make({ due_at: at('2026-10-10T09:00'), deadline_at: at('2026-10-10T18:00') })
      const r = updateTask({
        userId: TEST_USER_ID,
        userTimezone: tz,
        taskId: t.id,
        input: { due_at: at('2026-10-12T09:00'), reset_original_due_at: true },
      })
      expect(r.task.due_at).toBe(at('2026-10-10T18:00'))
      expect(r.task.original_due_at).toBe(at('2026-10-10T09:00'))
    })

    test('TM-033: bulk snooze stops at a future deadline; a passed one waits like High (2026-10-12)', () => {
      const capped = make({ due_at: at('2026-10-10T09:00'), deadline_at: at('2026-10-10T18:00') })
      const passed = make({ due_at: at('2026-10-09T09:00'), deadline_at: at('2026-10-09T18:00') })
      const free = make({ due_at: at('2026-10-10T09:00') })
      const r = bulkSnooze({
        userId: TEST_USER_ID,
        userTimezone: tz,
        taskIds: [capped.id, passed.id, free.id],
        until: at('2026-10-11T09:00'),
      })
      expect(r.tasksAffected).toBe(2)
      expect(r.deadlineCapped).toBe(1)
      expect(r.deadlineSkipped).toBe(1)
      expect(getTaskById(capped.id)!.due_at).toBe(at('2026-10-10T18:00'))
      expect(getTaskById(passed.id)!.due_at).toBe(at('2026-10-09T09:00'))
      expect(getTaskById(free.id)!.due_at).toBe(at('2026-10-11T09:00'))
    })

    test('TM-034: a deadline with no target gets a stored automatic target that follows it (§8.1, §8.4)', () => {
      // Deadline Sat Oct 10 18:00, set Sat Oct 10 10:00: wait 0 → the deadline
      // day at 09:00, already past → now. Over target at once.
      const t = make({ deadline_at: at('2026-10-10T18:00') })
      expect(t.due_at).toBe(SAT.toISOString())
      expect(t.target_auto).toBe(true)
      expect(getCurrentlyDueTaskIds(TEST_USER_ID)).toContain(t.id)
      // "Overdue" in the counts is strictly past, so a minute on.
      const minuteOn = new Date(SAT.getTime() + 60_000)
      expect(countTasks([getTaskById(t.id)!], tz, CALENDAR_DAY_START, minuteOn).overdue).toBe(1)
      expect(formatTaskResponse(getTaskById(t.id)!, tz).deadline_nag_off).toBe(false)

      // A picked target replaces it.
      const u = { userId: TEST_USER_ID, userTimezone: tz, taskId: t.id }
      updateTask({ ...u, input: { due_at: at('2026-10-10T12:00') } })
      expect(getTaskById(t.id)!).toMatchObject({
        due_at: at('2026-10-10T12:00'),
        target_auto: false,
      })
      expect(getCurrentlyDueTaskIds(TEST_USER_ID)).not.toContain(t.id)
      // Undo and redo carry target_auto (a boolean column) both ways.
      executeUndo(TEST_USER_ID)
      expect(getTaskById(t.id)!).toMatchObject({ due_at: SAT.toISOString(), target_auto: true })
      executeRedo(TEST_USER_ID)
      expect(getTaskById(t.id)!.target_auto).toBe(false)

      // "Back to auto" — clearing the target of a deadline one-off (an old
      // client's Remove target sends deadline_nag_off too, ignored).
      updateTask({ ...u, input: { due_at: null, deadline_nag_off: true } })
      expect(getTaskById(t.id)!).toMatchObject({ due_at: SAT.toISOString(), target_auto: true })

      // The automatic target follows a new deadline: Tue Oct 20 18:00 → a
      // 10-day wait, lead 3 → Sat Oct 17, 9:00 AM.
      updateTask({ ...u, input: { deadline_at: at('2026-10-20T18:00') } })
      expect(getTaskById(t.id)!).toMatchObject({
        due_at: at('2026-10-17T09:00'),
        target_auto: true,
      })
      // And goes with the deadline when it is removed.
      updateTask({ ...u, input: { deadline_at: null } })
      expect(getTaskById(t.id)!).toMatchObject({ due_at: null, target_auto: false })
    })

    test('TM-037: a deadline-only task already nagging is snoozed, capped and keeps its attempts', () => {
      // Deadline Sat Oct 10 23:30 (wait 0) → its automatic target is now (Sat 10:00).
      const t = make({ deadline_at: at('2026-10-10T23:30') })
      expect(t.due_at).toBe(SAT.toISOString())
      const u = { userId: TEST_USER_ID, userTimezone: tz, taskId: t.id }
      // A sweep past the deadline stops AT it and reports it.
      const swept = bulkSnooze({
        userId: TEST_USER_ID,
        userTimezone: tz,
        taskIds: [t.id],
        until: at('2026-10-13T09:00'),
      })
      expect(swept.deadlineCapped).toBe(1)
      expect(swept.deadlineSkipped).toBe(0)
      expect(getTaskById(t.id)!).toMatchObject({
        due_at: at('2026-10-10T23:30'),
        target_auto: false,
      })
      // A single snooze past it is capped too — never refused.
      const past = updateTask({ ...u, input: { due_at: at('2026-10-13T09:00') } })
      expect(past.task.due_at).toBe(at('2026-10-10T23:30'))
      expect(past.cappedAtDeadline).toBe(true)
      // A snooze inside the deadline is a move: the first target (the
      // automatic one) is kept, and the attempts go on — 1× on Saturday the
      // moment it was made (ruling Q10), the same-day moves add nothing, then
      // one a day: Sat, Sun, Mon → 3×.
      const snoozed = updateTask({ ...u, input: { due_at: at('2026-10-10T16:00') } }).task
      expect(snoozed.due_at).toBe(at('2026-10-10T16:00'))
      expect(snoozed.original_due_at).toBe(SAT.toISOString())
      expect(snoozed.attempts).toBe(1)
      vi.setSystemTime(new Date(at('2026-10-12T17:00')))
      expect(getTaskById(t.id)!.attempts).toBe(3)
    })

    test('TM-038: a target set past its own deadline is stored AT the deadline (A2, §8.2)', () => {
      // Asked for Oct 20, deadline Oct 13 18:00: stored at the deadline, still
      // the user's pick.
      const t = make({ due_at: at('2026-10-20T09:00'), deadline_at: at('2026-10-13T18:00') })
      expect(t.due_at).toBe(at('2026-10-13T18:00'))
      expect(t.target_auto).toBe(false)
      expect(getCurrentlyDueTaskIds(TEST_USER_ID)).not.toContain(t.id)
      vi.setSystemTime(new Date(at('2026-10-13T18:30')))
      expect(getCurrentlyDueTaskIds(TEST_USER_ID)).toContain(t.id)
      // A target at or before the deadline is honoured as set.
      vi.setSystemTime(SAT)
      const ok = make({ due_at: at('2026-10-13T08:00'), deadline_at: at('2026-10-13T18:00') })
      expect(ok.due_at).toBe(at('2026-10-13T08:00'))
      expect(getCurrentlyDueTaskIds(TEST_USER_ID)).not.toContain(ok.id)
    })

    test('TM-039: allow_past_deadline no longer lets a snooze past the deadline; it nags from it', () => {
      const t = make({ due_at: at('2026-10-10T09:00'), deadline_at: at('2026-10-11T18:00') })
      updateTask({
        userId: TEST_USER_ID,
        userTimezone: tz,
        taskId: t.id,
        input: { due_at: at('2026-10-12T09:00'), allow_past_deadline: true },
      })
      expect(getTaskById(t.id)!.due_at).toBe(at('2026-10-11T18:00'))
      expect(getCurrentlyDueTaskIds(TEST_USER_ID)).not.toContain(t.id)
      vi.setSystemTime(new Date(at('2026-10-11T18:30')))
      expect(getCurrentlyDueTaskIds(TEST_USER_ID)).toContain(t.id)
    })

    test('TM-040: the automatic target starts at the morning of the lead day, not at 23:59 (B2)', () => {
      const ctx = { timezone: tz, morningTime: '08:30' }
      // Sat Oct 17 23:59, set Sat Oct 10: a 7-day wait → the day before, Fri Oct 16.
      expect(autoTargetAt(at('2026-10-17T23:59'), ctx, SAT)).toBe(at('2026-10-16T08:30'))
      // 8–15 days: 3 before (Tue Oct 20 → Sat Oct 17); 16 or more: 4 (Fri Oct 30 → Mon Oct 26).
      expect(autoTargetAt(at('2026-10-20T23:59'), ctx, SAT)).toBe(at('2026-10-17T08:30'))
      expect(autoTargetAt(at('2026-10-30T23:59'), ctx, SAT)).toBe(at('2026-10-26T08:30'))
      // The deadline day (wait 1) with the deadline before the morning: the deadline itself.
      expect(autoTargetAt(at('2026-10-11T07:00'), ctx, SAT)).toBe(at('2026-10-11T07:00'))
    })

    test('TM-041: a repeating deadline and its derived target keep their local times across DST', () => {
      // Deadline Sundays 18:00, target the same day 08:00 (2026-10-21: the
      // rule walks the deadline). The next occurrence is after the Nov 1 DST
      // change: still 18:00 and 08:00 local.
      const schedule = {
        rrule: 'FREQ=WEEKLY;BYDAY=SU;BYHOUR=18;BYMINUTE=0',
        repeat_anchor: 'deadline' as const,
        target_days_before: 0,
        target_time: '08:00',
      }
      const next = occurrenceDates(schedule, at('2026-11-01T18:00'), tz)
      const local = (iso: string) => DateTime.fromISO(iso).setZone(tz).toFormat('yyyy-LL-dd HH:mm')
      expect(local(next.deadlineAt!)).toBe('2026-11-01 18:00')
      expect(local(next.targetAt!)).toBe('2026-11-01 08:00')
    })

    test('TM-035: a repeating deadline moves with the occurrence on done and on skip', () => {
      // Deadline-anchored (2026-10-21): the rule walks the deadline (18:00),
      // the target is derived the same day at 08:00.
      const t = make({
        rrule: 'FREQ=WEEKLY;BYDAY=SU;BYHOUR=18;BYMINUTE=0',
        due_at: at('2026-10-11T08:00'),
        deadline_at: at('2026-10-11T18:00'),
      })
      expect(t.repeat_anchor).toBe('deadline')
      expect([t.target_days_before, t.target_time]).toEqual([0, '08:00'])
      markDone({ userId: TEST_USER_ID, userTimezone: tz, taskId: t.id })
      let after = getTaskById(t.id)!
      expect(after.due_at).toBe(at('2026-10-18T08:00'))
      expect(after.deadline_at).toBe(at('2026-10-18T18:00'))
      skipOccurrence({ userId: TEST_USER_ID, userTimezone: tz, taskId: t.id })
      after = getTaskById(t.id)!
      expect(after.deadline_at).toBe(at('2026-10-25T18:00'))
      executeUndo(TEST_USER_ID)
      expect(getTaskById(t.id)!.deadline_at).toBe(at('2026-10-18T18:00'))
    })
  })

  describe('attempts (spec §7 — replaced the target-age badge)', () => {
    test('TM-040: one per local day over target; moves keep the count, a re-target too (§6)', () => {
      const t = make({ due_at: at('2026-10-07T09:00') })
      ageTargeted(t.id, '2026-10-01T09:00')
      // Over target Wed Oct 7 … Sat Oct 10: 4×.
      expect(getTaskById(t.id)!.attempts).toBe(4)
      const snoozed = updateTask({
        userId: TEST_USER_ID,
        userTimezone: tz,
        taskId: t.id,
        input: { due_at: at('2026-10-10T09:00') },
      }).task
      expect(snoozed.attempts).toBe(4)
      const retargeted = updateTask({
        userId: TEST_USER_ID,
        userTimezone: tz,
        taskId: t.id,
        input: { due_at: at('2026-10-11T08:00'), reset_original_due_at: true },
      }).task
      // `reset_original_due_at` is ignored on a task: the first target stays.
      expect(retargeted.original_due_at).toBe(at('2026-10-07T09:00'))
      // Moved to tomorrow: frozen at 4 until it arrives, then 5.
      expect(retargeted.attempts).toBe(4)
      expect(formatTaskResponse(retargeted, tz).attempts_label).toBe('4×')
      vi.setSystemTime(new Date(at('2026-10-11T07:59')))
      expect(getTaskById(t.id)!.attempts).toBe(4)
      vi.setSystemTime(new Date(at('2026-10-11T08:00')))
      expect(getTaskById(t.id)!.attempts).toBe(5)
    })

    test('TM-041: a removed target freezes the count; a new one resumes it', () => {
      const t = make({ due_at: at('2026-10-08T09:00') })
      ageTargeted(t.id, '2026-10-01T09:00')
      updateTask({ userId: TEST_USER_ID, userTimezone: tz, taskId: t.id, input: { due_at: null } })
      // Oct 8, 9, 10 counted at the removal; no target, no badge, no new days.
      let r = getTaskById(t.id)!
      expect(r.attempts).toBe(3)
      expect(formatTaskResponse(r, tz).attempts_label).toBeNull()
      vi.setSystemTime(new Date(at('2026-10-14T10:00')))
      expect(getTaskById(t.id)!.attempts).toBe(3)
      // Re-set to a moment already past: today counts (once), the days it
      // had no target never do.
      r = updateTask({
        userId: TEST_USER_ID,
        userTimezone: tz,
        taskId: t.id,
        input: { due_at: at('2026-10-12T09:00') },
      }).task
      expect(r.original_due_at).toBe(at('2026-10-12T09:00'))
      expect(r.attempts).toBe(4)
    })

    test('TM-042: never from before the task existed; an auto target already past is 1× at once (Q10)', () => {
      // Created today with a deadline tonight (wait 0): the deadline day's
      // morning is already past, so the target is now — over target at once.
      const t = make({ deadline_at: at('2026-10-10T23:30') })
      expect(getCurrentlyDueTaskIds(TEST_USER_ID)).toContain(t.id)
      expect(t.attempts).toBe(1)
      vi.setSystemTime(new Date(at('2026-10-12T10:00')))
      expect(getTaskById(t.id)!.attempts).toBe(3)
    })
  })

  describe('API names', () => {
    test('TM-050: target_at and retarget are accepted; both names come back', () => {
      expect(normalizeTargetAliases({ target_at: 'x', retarget: true })).toEqual({
        due_at: 'x',
        reset_original_due_at: true,
      })
      expect(() => normalizeTargetAliases({ target_at: 'x', due_at: 'y' })).toThrow(ValidationError)
      const t = make({ due_at: at('2026-10-12T09:00') })
      const out = formatTaskResponse(t, tz)
      expect(out.target_at).toBe(out.due_at)
    })

    test('TM-051: a horizon change restarts its clock; the same value does not', () => {
      const t = make({ horizon: 'weeks' })
      const first = getTaskById(t.id)!.horizon_set_at
      vi.setSystemTime(new Date(at('2026-10-11T09:00')))
      updateTask({
        userId: TEST_USER_ID,
        userTimezone: tz,
        taskId: t.id,
        input: { horizon: 'weeks' },
      })
      expect(getTaskById(t.id)!.horizon_set_at).toBe(first)
      updateTask({
        userId: TEST_USER_ID,
        userTimezone: tz,
        taskId: t.id,
        input: { horizon: 'months' },
      })
      expect(getTaskById(t.id)!.horizon_set_at).not.toBe(first)
    })
  })

  describe('rulings A3 and A4 (Trent, 2026-10-11), as revised by §8 (2026-10-12)', () => {
    test('TM-060: a quick snooze stops AT the deadline and says so (A3)', () => {
      const t = make({ due_at: at('2026-10-10T09:00'), deadline_at: at('2026-10-10T18:00') })
      const r = snoozeTask({
        userId: TEST_USER_ID,
        userTimezone: tz,
        taskId: t.id,
        until: at('2026-10-11T09:00'),
      })
      expect(r.task.due_at).toBe(at('2026-10-10T18:00'))
      expect(r.cappedAtDeadline).toBe(true)
      // Under the deadline it is an ordinary snooze.
      const free = make({ due_at: at('2026-10-10T09:00'), deadline_at: at('2026-10-14T18:00') })
      const r2 = snoozeTask({
        userId: TEST_USER_ID,
        userTimezone: tz,
        taskId: free.id,
        until: at('2026-10-11T09:00'),
      })
      expect(r2.task.due_at).toBe(at('2026-10-11T09:00'))
      expect(r2.cappedAtDeadline).toBe(false)
      // A passed deadline caps nothing: the snooze goes where it was sent
      // (Trent's ruling, 2026-10-12).
      const late = make({ due_at: at('2026-10-09T09:00'), deadline_at: at('2026-10-09T18:00') })
      const r3 = snoozeTask({
        userId: TEST_USER_ID,
        userTimezone: tz,
        taskId: late.id,
        until: at('2026-10-11T09:00'),
      })
      expect(r3.task.due_at).toBe(at('2026-10-11T09:00'))
      expect(r3.cappedAtDeadline).toBe(false)
    })

    test('TM-061: bulk snooze and bulk edit cap every task and count them (A3)', () => {
      const capped = make({ due_at: at('2026-10-10T09:00'), deadline_at: at('2026-10-10T18:00') })
      const free = make({ due_at: at('2026-10-10T09:00') })
      const r = bulkSnooze({
        userId: TEST_USER_ID,
        userTimezone: tz,
        taskIds: [capped.id, free.id],
        until: at('2026-10-11T09:00'),
      })
      expect(r.tasksAffected).toBe(2)
      expect(r.deadlineCapped).toBe(1)
      expect(r.deadlineSkipped).toBe(0)
      expect(getTaskById(capped.id)!.due_at).toBe(at('2026-10-10T18:00'))
      expect(getTaskById(free.id)!.due_at).toBe(at('2026-10-11T09:00'))

      const viaEdit = make({ due_at: at('2026-10-10T09:00'), deadline_at: at('2026-10-10T20:00') })
      const e = bulkEdit({
        userId: TEST_USER_ID,
        userTimezone: tz,
        taskIds: [viaEdit.id],
        changes: { due_at: at('2026-10-12T09:00') },
      })
      expect(e.deadlineCapped).toBe(1)
      expect(getTaskById(viaEdit.id)!.due_at).toBe(at('2026-10-10T20:00'))
    })

    test('TM-062: Remove target on a deadline task goes back to auto, which nags past the deadline (§8.3)', () => {
      // A picked target with a deadline Tue Oct 20 18:00.
      const t = make({ due_at: at('2026-10-12T09:00'), deadline_at: at('2026-10-20T18:00') })
      expect(t.target_auto).toBe(false)
      // What an old client's Remove target sends.
      updateTask({
        userId: TEST_USER_ID,
        userTimezone: tz,
        taskId: t.id,
        input: { due_at: null, deadline_nag_off: true },
      })
      // Back to auto: a 10-day wait, lead 3 → Sat Oct 17, 9:00 AM.
      expect(getTaskById(t.id)!).toMatchObject({
        due_at: at('2026-10-17T09:00'),
        target_auto: true,
      })
      expect(getCurrentlyDueTaskIds(TEST_USER_ID)).not.toContain(t.id)
      vi.setSystemTime(new Date(at('2026-10-17T09:30')))
      expect(getCurrentlyDueTaskIds(TEST_USER_ID)).toContain(t.id)
      // And stays on after the deadline passes, until done.
      vi.setSystemTime(new Date(at('2026-10-21T09:30')))
      expect(getCurrentlyDueTaskIds(TEST_USER_ID)).toContain(t.id)
    })

    test('TM-063: a picked target stays on a deadline change (pulled back if earlier); an auto one goes with it (§8.4)', () => {
      const u = { userId: TEST_USER_ID, userTimezone: tz }
      const picked = make({ due_at: at('2026-10-13T15:00'), deadline_at: at('2026-10-13T18:00') })
      // A later deadline: the pick stays as set.
      updateTask({ ...u, taskId: picked.id, input: { deadline_at: at('2026-10-20T18:00') } })
      expect(getTaskById(picked.id)!).toMatchObject({
        due_at: at('2026-10-13T15:00'),
        target_auto: false,
      })
      // An earlier deadline than the pick: pulled back to it.
      updateTask({ ...u, taskId: picked.id, input: { deadline_at: at('2026-10-12T12:00') } })
      expect(getTaskById(picked.id)!.due_at).toBe(at('2026-10-12T12:00'))
      // The deadline removed: the pick survives.
      updateTask({ ...u, taskId: picked.id, input: { deadline_at: null } })
      expect(getTaskById(picked.id)!.due_at).toBe(at('2026-10-12T12:00'))

      // An automatic target is re-derived on a deadline change, and removed
      // with the deadline.
      const auto = make({ deadline_at: at('2026-10-20T18:00') })
      expect(auto.due_at).toBe(at('2026-10-17T09:00'))
      updateTask({ ...u, taskId: auto.id, input: { deadline_at: at('2026-11-06T18:00') } })
      // Fri Nov 6: a 27-day wait, lead 4 → Mon Nov 2, 9:00 AM (CST).
      expect(getTaskById(auto.id)!.due_at).toBe(at('2026-11-02T09:00'))
      updateTask({ ...u, taskId: auto.id, input: { deadline_at: null } })
      expect(getTaskById(auto.id)!).toMatchObject({ due_at: null, target_auto: false })
    })

    test('TM-065: a snooze on the deadline day stops at the deadline; after it, any target can be picked', () => {
      vi.setSystemTime(new Date(at('2026-10-13T10:00')))
      const t = make({ deadline_at: at('2026-10-13T18:00') })
      const u = { userId: TEST_USER_ID, userTimezone: tz, taskId: t.id }
      const r = updateTask({ ...u, input: { due_at: at('2026-10-14T09:00') } })
      expect(r.task.due_at).toBe(at('2026-10-13T18:00'))
      expect(r.description).toMatch(/^Deferred to deadline/)
      // The deadline passes: the cap no longer applies, the snooze moves it.
      vi.setSystemTime(new Date(at('2026-10-13T19:00')))
      expect(getCurrentlyDueTaskIds(TEST_USER_ID)).toContain(t.id)
      const moved = updateTask({ ...u, input: { due_at: at('2026-10-14T09:00') } })
      expect(moved.task.due_at).toBe(at('2026-10-14T09:00'))
      expect(moved.cappedAtDeadline).toBe(false)
      expect(getCurrentlyDueTaskIds(TEST_USER_ID)).not.toContain(t.id)
      // An ordinary snooze before a deadline says what it did.
      vi.setSystemTime(new Date(at('2026-10-14T08:00')))
      const v = make({ due_at: at('2026-10-14T09:00'), deadline_at: at('2026-10-14T18:00') })
      const r2 = updateTask({
        userId: TEST_USER_ID,
        userTimezone: tz,
        taskId: v.id,
        input: { due_at: at('2026-10-14T15:00') },
      })
      expect(r2.description).not.toMatch(/deadline/)
    })

    test('TM-064: a new user starts on the horizon sort', () => {
      expect(getPreferences(TEST_USER_ID).default_sort).toBe('horizon')
    })
  })
})
