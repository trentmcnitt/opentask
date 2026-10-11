/**
 * TM: the 2026-10-10 task model — deadline, target, horizon, task segments
 * (docs/TASK-MODEL.md § Deadline, target, horizon).
 *
 * Clock: Saturday 2026-10-10, 10:00 Chicago (15:00Z) unless a test moves it.
 * Tasks made "old" have their created_at rewritten, since creation counts as
 * seeing a task (it waits for its segment's next day).
 */
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
  getTaskSegments,
  targetTasksToday,
  targetTodayTime,
} from '@/core/tasks/task-segments'
import { getCurrentlyDueTaskIds } from '@/core/tasks/currently-due'
import {
  effectiveHorizon,
  latestSegmentDay,
  targetAgeDays,
  impliedTargetAt,
  effectiveTargetAt,
  advanceDeadline,
} from '@/lib/task-segments'
import { countTasks } from '@/lib/task-counts'
import { normalizeTargetAliases } from '@/core/validation/task'
import { formatTaskResponse } from '@/lib/format-task'
import { DEADLINE_TODAY_HOLDS } from '@/lib/task-model-words'
import { PastDeadlineError, ValidationError } from '@/core/errors'
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
    test('TM-010: an old untargeted task shows in its segment; one created today waits', () => {
      const old = make({ title: 'Squeaky door' })
      age(old.id, '2026-10-01T09:00')
      const fresh = make({ title: 'Just added' })
      expect(segmentOf(old.id)).toEqual({ horizon: 'weeks', state: 'waiting' })
      expect(segmentOf(fresh.id)).toBeNull()
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

    test('TM-012: a target today or earlier takes it out of the segment; a future target leaves it in', () => {
      const today = make({ due_at: at('2026-10-10T20:00') })
      const later = make({ due_at: at('2026-11-01T09:00') })
      age(today.id, '2026-10-01T09:00')
      age(later.id, '2026-10-01T09:00')
      expect(segmentOf(today.id)).toBeNull()
      expect(segmentOf(later.id)?.state).toBe('waiting')
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

    test('TM-018: a segment over 50 items asks for help', () => {
      const ids = Array.from({ length: 51 }, () => make().id)
      for (const id of ids) age(id, '2026-10-01T09:00')
      expect(getTaskSegments(TEST_USER_ID, tz)[0].nudge).toBe(true)
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
  })

  describe('deadline', () => {
    test('TM-030: a single snooze past a future deadline is refused unless confirmed', () => {
      const t = make({ due_at: at('2026-10-10T09:00'), deadline_at: at('2026-10-10T18:00') })
      const snooze = (allow?: boolean) =>
        updateTask({
          userId: TEST_USER_ID,
          userTimezone: tz,
          taskId: t.id,
          input: { due_at: at('2026-10-11T09:00'), allow_past_deadline: allow },
        })
      expect(() => snooze()).toThrow(PastDeadlineError)
      expect(snooze(true).task.due_at).toBe(at('2026-10-11T09:00'))
      expect(getTaskById(t.id)!.deadline_at).toBe(at('2026-10-10T18:00'))
    })

    test('TM-031: once the deadline has passed, snooze works as before', () => {
      const t = make({ due_at: at('2026-10-09T09:00'), deadline_at: at('2026-10-09T18:00') })
      const r = updateTask({
        userId: TEST_USER_ID,
        userTimezone: tz,
        taskId: t.id,
        input: { due_at: at('2026-10-11T09:00') },
      })
      expect(r.task.due_at).toBe(at('2026-10-11T09:00'))
    })

    test('TM-032: a deliberate re-target past the deadline is not capped', () => {
      const t = make({ due_at: at('2026-10-10T09:00'), deadline_at: at('2026-10-10T18:00') })
      const r = updateTask({
        userId: TEST_USER_ID,
        userTimezone: tz,
        taskId: t.id,
        input: { due_at: at('2026-10-12T09:00'), reset_original_due_at: true },
      })
      expect(r.task.due_at).toBe(at('2026-10-12T09:00'))
    })

    test('TM-033: bulk snooze leaves a deadline-capped task where it is and reports it', () => {
      const capped = make({ due_at: at('2026-10-10T09:00'), deadline_at: at('2026-10-10T18:00') })
      const free = make({ due_at: at('2026-10-10T09:00') })
      const r = bulkSnooze({
        userId: TEST_USER_ID,
        userTimezone: tz,
        taskIds: [capped.id, free.id],
        until: at('2026-10-11T09:00'),
      })
      expect(r.tasksAffected).toBe(1)
      expect(r.deadlineSkipped).toBe(1)
      expect(getTaskById(capped.id)!.due_at).toBe(at('2026-10-10T09:00'))
      const confirmed = bulkSnooze({
        userId: TEST_USER_ID,
        userTimezone: tz,
        taskIds: [capped.id],
        until: at('2026-10-11T09:00'),
        allowPastDeadlineIds: [capped.id],
      })
      expect(confirmed.tasksAffected).toBe(1)
    })

    test('TM-034: a deadline with no target nags from 4 days before, unless turned off', () => {
      const t = make({ deadline_at: at('2026-10-13T18:00') })
      expect(impliedTargetAt(t)).toBe(at('2026-10-09T18:00'))
      expect(getCurrentlyDueTaskIds(TEST_USER_ID)).toContain(t.id)
      expect(countTasks([getTaskById(t.id)!], tz, SAT).overdue).toBe(1)
      expect(segmentOf(t.id)).toBeNull()
      updateTask({
        userId: TEST_USER_ID,
        userTimezone: tz,
        taskId: t.id,
        input: { due_at: null, deadline_nag_off: true },
      })
      expect(getCurrentlyDueTaskIds(TEST_USER_ID)).not.toContain(t.id)
      // Back in its effective-horizon segment: 3 days out is "days".
      age(t.id, '2026-10-01T09:00')
      expect(segmentOf(t.id)).toEqual({ horizon: 'days', state: 'waiting' })
      // Undo and redo of that write (a boolean column) work and leave the
      // stack usable — the remove-target Undo used to throw and wedge it.
      executeUndo(TEST_USER_ID)
      expect(getTaskById(t.id)!.deadline_nag_off).toBe(false)
      executeRedo(TEST_USER_ID)
      expect(getTaskById(t.id)!.deadline_nag_off).toBe(true)
      // A new deadline turns the nag back on.
      updateTask({
        userId: TEST_USER_ID,
        userTimezone: tz,
        taskId: t.id,
        input: { deadline_at: at('2026-10-12T18:00') },
      })
      expect(getTaskById(t.id)!.deadline_nag_off).toBe(false)
    })

    test('TM-037: a deadline-only task already nagging is snoozed, capped and keeps its age', () => {
      // Deadline Oct 12 18:00 → implied target Oct 8 09:00: nagging since then.
      const t = make({ deadline_at: at('2026-10-12T18:00') })
      age(t.id, '2026-10-01T09:00')
      // A sweep past the deadline leaves it and reports it.
      const swept = bulkSnooze({
        userId: TEST_USER_ID,
        userTimezone: tz,
        taskIds: [t.id],
        until: at('2026-10-13T09:00'),
      })
      expect(swept.deadlineSkipped).toBe(1)
      expect(getTaskById(t.id)!.due_at).toBeNull()
      // A single snooze past it is refused unless confirmed.
      expect(() =>
        updateTask({
          userId: TEST_USER_ID,
          userTimezone: tz,
          taskId: t.id,
          input: { due_at: at('2026-10-13T09:00') },
        }),
      ).toThrow(PastDeadlineError)
      // A snooze inside the deadline is a snooze: the age counts from the
      // implied target, not from the snooze.
      const snoozed = updateTask({
        userId: TEST_USER_ID,
        userTimezone: tz,
        taskId: t.id,
        input: { due_at: at('2026-10-10T16:00') },
      }).task
      // The implied target is the MORNING of the lead day (ruling B2).
      expect(snoozed.original_due_at).toBe(at('2026-10-08T09:00'))
      expect(snoozed.snooze_count).toBe(1)
      vi.setSystemTime(new Date(at('2026-10-10T17:00')))
      expect(targetAgeDays(snoozed, tz, new Date())).toBe(2)
    })

    test('TM-038: a target set past its own deadline never hides the deadline (A2)', () => {
      const ctx = { timezone: tz, morningTime: '09:00' }
      // Target Oct 20, deadline Oct 13 18:00 → nags from Oct 9 09:00.
      const t = make({ due_at: at('2026-10-20T09:00'), deadline_at: at('2026-10-13T18:00') })
      expect(effectiveTargetAt(t, ctx)).toBe(at('2026-10-09T09:00'))
      expect(getCurrentlyDueTaskIds(TEST_USER_ID)).toContain(t.id)
      // A target at or before the deadline is honoured as set.
      const ok = make({ due_at: at('2026-10-13T08:00'), deadline_at: at('2026-10-13T18:00') })
      expect(effectiveTargetAt(ok, ctx)).toBe(at('2026-10-13T08:00'))
      expect(getCurrentlyDueTaskIds(TEST_USER_ID)).not.toContain(ok.id)
    })

    test('TM-039: a confirmed snooze past the deadline turns the implied nag off, so it holds', () => {
      const t = make({ due_at: at('2026-10-10T09:00'), deadline_at: at('2026-10-11T18:00') })
      updateTask({
        userId: TEST_USER_ID,
        userTimezone: tz,
        taskId: t.id,
        input: { due_at: at('2026-10-12T09:00'), allow_past_deadline: true },
      })
      expect(getTaskById(t.id)!.deadline_nag_off).toBe(true)
      expect(getCurrentlyDueTaskIds(TEST_USER_ID)).not.toContain(t.id)
      // A deliberate re-target past the deadline is not a snooze: nag stays on.
      const r = make({ due_at: at('2026-10-10T09:00'), deadline_at: at('2026-10-11T18:00') })
      updateTask({
        userId: TEST_USER_ID,
        userTimezone: tz,
        taskId: r.id,
        input: { due_at: at('2026-10-12T09:00'), reset_original_due_at: true },
      })
      expect(getTaskById(r.id)!.deadline_nag_off).toBe(false)
      expect(getCurrentlyDueTaskIds(TEST_USER_ID)).toContain(r.id)
    })

    test('TM-040: the implied nag starts at the morning of the lead day, not at 23:59 (B2)', () => {
      expect(
        impliedTargetAt(
          { due_at: null, deadline_at: at('2026-10-17T23:59') },
          { timezone: tz, morningTime: '08:30' },
        ),
      ).toBe(at('2026-10-13T08:30'))
    })

    test('TM-041: a recurring deadline keeps its local time across DST', () => {
      // Sunday 08:00 occurrence, deadline that Sunday 18:00 local. Next
      // occurrence is after the Nov 1 DST change: still 18:00 local.
      const next = advanceDeadline(
        {
          deadline_at: at('2026-10-25T18:00'),
          due_at: at('2026-10-25T08:00'),
          original_due_at: at('2026-10-25T08:00'),
        },
        at('2026-11-01T08:00'),
        tz,
      )
      expect(DateTime.fromISO(next!).setZone(tz).toFormat('yyyy-LL-dd HH:mm')).toBe(
        '2026-11-01 18:00',
      )
    })

    test('TM-035: a recurring deadline moves with the occurrence on done and on skip', () => {
      const t = make({
        rrule: 'FREQ=WEEKLY;BYDAY=SU;BYHOUR=8;BYMINUTE=0',
        due_at: at('2026-10-11T08:00'),
        deadline_at: at('2026-10-11T18:00'),
      })
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

    test('TM-036: advanceDeadline measures from the origin, so a snoozed occurrence does not shift it', () => {
      expect(
        advanceDeadline(
          {
            deadline_at: at('2026-10-11T18:00'),
            due_at: at('2026-10-11T13:00'),
            original_due_at: at('2026-10-11T08:00'),
          },
          at('2026-10-18T08:00'),
          tz,
        ),
      ).toBe(at('2026-10-18T18:00'))
    })
  })

  describe('target age', () => {
    test('TM-040: counts from the first target; a snooze keeps it, a re-target restarts it', () => {
      const t = make({ due_at: at('2026-10-07T09:00') })
      age(t.id, '2026-10-01T09:00')
      const snoozed = updateTask({
        userId: TEST_USER_ID,
        userTimezone: tz,
        taskId: t.id,
        input: { due_at: at('2026-10-10T09:00') },
      }).task
      expect(targetAgeDays(snoozed, tz, SAT)).toBe(3)
      const retargeted = updateTask({
        userId: TEST_USER_ID,
        userTimezone: tz,
        taskId: t.id,
        input: { due_at: at('2026-10-10T08:00'), reset_original_due_at: true },
      }).task
      // The target day itself: blank.
      expect(targetAgeDays(retargeted, tz, SAT)).toBeNull()
    })

    test('TM-041: a cleared then re-set target starts fresh', () => {
      const t = make({ due_at: at('2026-09-20T09:00') })
      updateTask({ userId: TEST_USER_ID, userTimezone: tz, taskId: t.id, input: { due_at: null } })
      const r = updateTask({
        userId: TEST_USER_ID,
        userTimezone: tz,
        taskId: t.id,
        input: { due_at: at('2026-10-10T09:00') },
      }).task
      expect(r.original_due_at).toBe(at('2026-10-10T09:00'))
      expect(targetAgeDays(r, tz, SAT)).toBeNull()
    })
    test('TM-042: the age never counts from before the task existed', () => {
      // Created today with a deadline in 3 days: the implied target (deadline −
      // 4 days, morning) is yesterday — the task is over target at once, but its
      // age is blank today, not "1d".
      const t = make({ deadline_at: at('2026-10-13T18:00') })
      expect(getCurrentlyDueTaskIds(TEST_USER_ID)).toContain(t.id)
      expect(targetAgeDays(t, tz, SAT, { timezone: tz, morningTime: '09:00' })).toBeNull()
      vi.setSystemTime(new Date(at('2026-10-12T10:00')))
      expect(targetAgeDays(t, tz, new Date(), { timezone: tz, morningTime: '09:00' })).toBe(2)
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
      const out = formatTaskResponse(t)
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

  describe('rulings A3 and A4 (Trent, 2026-10-11)', () => {
    test('TM-060: a quick snooze stops AT the deadline, says so, and keeps the nag on (A3)', () => {
      const t = make({ due_at: at('2026-10-10T09:00'), deadline_at: at('2026-10-10T18:00') })
      const r = snoozeTask({
        userId: TEST_USER_ID,
        userTimezone: tz,
        taskId: t.id,
        until: at('2026-10-11T09:00'),
        capAtDeadline: true,
      })
      expect(r.task.due_at).toBe(at('2026-10-10T18:00'))
      expect(getTaskById(t.id)!.deadline_nag_off).toBe(false)
      // Under the deadline it is an ordinary snooze.
      const free = make({ due_at: at('2026-10-10T09:00'), deadline_at: at('2026-10-14T18:00') })
      const r2 = snoozeTask({
        userId: TEST_USER_ID,
        userTimezone: tz,
        taskId: free.id,
        until: at('2026-10-11T09:00'),
        capAtDeadline: true,
      })
      expect(r2.task.due_at).toBe(at('2026-10-11T09:00'))
      // A passed deadline caps nothing: a snooze after it goes where asked.
      const late = make({ due_at: at('2026-10-09T09:00'), deadline_at: at('2026-10-09T18:00') })
      const r3 = snoozeTask({
        userId: TEST_USER_ID,
        userTimezone: tz,
        taskId: late.id,
        until: at('2026-10-11T09:00'),
        capAtDeadline: true,
      })
      expect(r3.task.due_at).toBe(at('2026-10-11T09:00'))
    })

    test('TM-061: bulk snooze and bulk edit cap the listed ids and count them (A3)', () => {
      const capped = make({ due_at: at('2026-10-10T09:00'), deadline_at: at('2026-10-10T18:00') })
      const free = make({ due_at: at('2026-10-10T09:00') })
      const r = bulkSnooze({
        userId: TEST_USER_ID,
        userTimezone: tz,
        taskIds: [capped.id, free.id],
        until: at('2026-10-11T09:00'),
        capAtDeadlineIds: [capped.id, free.id],
      })
      expect(r.tasksAffected).toBe(2)
      expect(r.deadlineCapped).toBe(1)
      expect(r.deadlineSkipped).toBe(0)
      expect(getTaskById(capped.id)!.due_at).toBe(at('2026-10-10T18:00'))
      expect(getTaskById(free.id)!.due_at).toBe(at('2026-10-11T09:00'))

      const viaEdit = make({ due_at: at('2026-10-10T09:00'), deadline_at: at('2026-10-10T20:00') })
      bulkEdit({
        userId: TEST_USER_ID,
        userTimezone: tz,
        taskIds: [viaEdit.id],
        changes: { due_at: at('2026-10-12T09:00') },
        capAtDeadlineIds: [viaEdit.id],
      })
      expect(getTaskById(viaEdit.id)!.due_at).toBe(at('2026-10-10T20:00'))
    })

    test('TM-062: remove-target silences the 4-day nag but it re-arms on the deadline day (A4)', () => {
      const t = make({ deadline_at: at('2026-10-13T18:00') })
      updateTask({
        userId: TEST_USER_ID,
        userTimezone: tz,
        taskId: t.id,
        input: { due_at: null, deadline_nag_off: true },
      })
      const ctx = { timezone: tz, morningTime: '09:00' }
      expect(getCurrentlyDueTaskIds(TEST_USER_ID)).not.toContain(t.id)
      // The deadline's own day, at the morning time.
      expect(impliedTargetAt(getTaskById(t.id)!, ctx)).toBe(at('2026-10-13T09:00'))
      vi.setSystemTime(new Date(at('2026-10-13T09:30')))
      expect(getCurrentlyDueTaskIds(TEST_USER_ID)).toContain(t.id)
      // And stays on after the deadline passes, until done.
      vi.setSystemTime(new Date(at('2026-10-14T09:30')))
      expect(getCurrentlyDueTaskIds(TEST_USER_ID)).toContain(t.id)
    })

    test('TM-063: re-arming leaves a target at or before the deadline alone (A4)', () => {
      const ctx = { timezone: tz, morningTime: '09:00' }
      const base = {
        rrule: null,
        deadline_at: at('2026-10-13T18:00'),
        deadline_nag_off: true,
      }
      // The user's own target before the deadline is honored as set.
      expect(impliedTargetAt({ ...base, due_at: at('2026-10-13T15:00') }, ctx)).toBeNull()
      // A target past the deadline: the deadline morning comes first.
      const past = { ...base, due_at: at('2026-10-15T09:00') }
      expect(effectiveTargetAt(past, ctx, SAT)).toBe(at('2026-10-13T09:00'))
      // Once the deadline has passed, that target (a deliberate snooze past it) holds.
      expect(effectiveTargetAt(past, ctx, new Date(at('2026-10-14T09:00')))).toBe(
        at('2026-10-15T09:00'),
      )
      // A deadline earlier than the morning re-arms at the deadline itself.
      const early = { ...base, due_at: null, deadline_at: at('2026-10-13T07:00') }
      expect(impliedTargetAt(early, ctx)).toBe(at('2026-10-13T07:00'))
    })

    test('TM-065: a snooze on the deadline day is saved, and says why the nag stays (A4)', () => {
      vi.setSystemTime(new Date(at('2026-10-13T10:00')))
      const t = make({ deadline_at: at('2026-10-13T18:00') })
      const r = updateTask({
        userId: TEST_USER_ID,
        userTimezone: tz,
        taskId: t.id,
        input: { due_at: at('2026-10-14T09:00'), allow_past_deadline: true },
      })
      expect(r.task.due_at).toBe(at('2026-10-14T09:00'))
      expect(r.description).toBe(DEADLINE_TODAY_HOLDS)
      expect(getCurrentlyDueTaskIds(TEST_USER_ID)).toContain(t.id)
      // An ordinary snooze before the deadline says what it did.
      const u = make({ due_at: at('2026-10-13T09:00'), deadline_at: at('2026-10-13T18:00') })
      const r2 = updateTask({
        userId: TEST_USER_ID,
        userTimezone: tz,
        taskId: u.id,
        input: { due_at: at('2026-10-13T15:00') },
      })
      expect(r2.description).not.toBe(DEADLINE_TODAY_HOLDS)
    })

    test('TM-064: a new user starts on the horizon sort', () => {
      expect(getPreferences(TEST_USER_ID).default_sort).toBe('horizon')
    })
  })
})
