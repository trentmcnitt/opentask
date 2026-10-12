/**
 * TM8: a deadline always has a visible target (spec §8, 2026-10-12;
 * docs/TASK-MODEL.md § Deadline). The deadline's target is STORED — the
 * automatic target, `target_auto` — and the target is never after the
 * deadline. Every date is a LOCAL time in America/Chicago (morning 09:00).
 */
import { describe, test, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { DateTime } from 'luxon'
import { getDb } from '@/core/db'
import { createTask, updateTask, bulkSnooze, bulkEdit } from '@/core/tasks'
import { snoozeTask } from '@/core/tasks/snooze'
import { getTaskById } from '@/core/tasks/read'
import { executeUndo } from '@/core/undo'
import { getCurrentlyDueTaskIds } from '@/core/tasks/currently-due'
import { getTaskSegments, targetTasksToday } from '@/core/tasks/task-segments'
import { getProcessData } from '@/core/tasks/process'
import { formatTaskResponse } from '@/lib/format-task'
import { DEADLINE_PASSED_HOLDS } from '@/lib/task-model-words'
import {
  autoTargetAt,
  capAtDeadline,
  deadlineDayTarget,
  leadDaysForWait,
  resolveTarget,
  targetReset,
  HEADS_UP_LONG_WAIT,
} from '@/lib/task-segments'
import { deadlineDayPick, stagedAutoTarget } from '@/lib/editor-target-labels'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

const tz = TEST_TIMEZONE
const ctx = { timezone: tz, morningTime: '09:00' }

/** A local wall-clock time in Chicago, as the UTC ISO string the DB stores. */
function at(local: string): string {
  return DateTime.fromISO(local, { zone: tz }).toUTC().toISO()!
}
function setClock(local: string) {
  vi.setSystemTime(new Date(at(local)))
}
function local(iso: string | null): string | null {
  return iso === null
    ? null
    : DateTime.fromISO(iso, { zone: 'utc' }).setZone(tz).toFormat('ccc LLL d HH:mm')
}
const u = { userId: TEST_USER_ID, userTimezone: tz }
function make(input: Record<string, unknown> = {}) {
  return createTask({ ...u, input: { title: 'Task', ...input } })
}
function patch(id: number, input: Record<string, unknown>) {
  return updateTask({ ...u, taskId: id, input })
}
function places(id: number): string[] {
  return getTaskSegments(TEST_USER_ID, tz).flatMap((s) =>
    s.tasks.filter((r) => r.task.id === id).map(() => s.horizon),
  )
}

describe("TM8: the deadline's automatic target", () => {
  beforeAll(() => setupTestDb())
  afterAll(() => teardownTestDb())
  beforeEach(() => {
    getDb().prepare('DELETE FROM tasks').run()
    getDb().prepare('DELETE FROM undo_log').run()
    setClock('2026-10-12T12:00')
  })
  afterEach(() => vi.useRealTimers())

  describe('§8.1 stored, from the 3/4 lead', () => {
    test('TM8-001: one lead function — 3 days under a 16-day wait, 4 at 16 or more', () => {
      expect(leadDaysForWait(HEADS_UP_LONG_WAIT - 1)).toBe(3)
      expect(leadDaysForWait(HEADS_UP_LONG_WAIT)).toBe(4)
      expect(leadDaysForWait(2)).toBe(3)
    })

    test('TM8-002: created with a deadline 11 days out → target 3 days before, at the morning', () => {
      const t = make({ deadline_at: at('2026-10-23T23:59') })
      expect(local(t.due_at)).toBe('Tue Oct 20 09:00')
      expect(t.target_auto).toBe(true)
      expect(t.original_due_at).toBe(t.due_at)
    })

    test('TM8-003: a deadline 19 days out → 4 days before', () => {
      const t = make({ deadline_at: at('2026-10-31T23:59') })
      expect(local(t.due_at)).toBe('Tue Oct 27 09:00')
    })

    test('TM8-004: the wait is local days from now — 15 is 3 days, 16 is 4', () => {
      expect(local(autoTargetAt(at('2026-10-27T23:59'), ctx))).toBe('Sat Oct 24 09:00')
      expect(local(autoTargetAt(at('2026-10-28T23:59'), ctx))).toBe('Sat Oct 24 09:00')
    })

    test('TM8-005: across the DST change (Nov 1) the morning is still 09:00 local', () => {
      // Deadline Thu Nov 5 → 24 days → lead 4 → Sun Nov 1, the fall-back day.
      const t = autoTargetAt(at('2026-11-05T17:00'), ctx)
      expect(local(t)).toBe('Sun Nov 1 09:00')
      expect(t).toBe('2026-11-01T15:00:00.000Z') // CST, UTC−6
      expect(autoTargetAt(at('2026-10-30T17:00'), ctx)).toBe('2026-10-26T14:00:00.000Z') // CDT
    })

    test('TM8-006: a lead day already past → now: over target at once (ruling Q10)', () => {
      const t = make({ deadline_at: at('2026-10-14T18:00') })
      expect(t.due_at).toBe(new Date().toISOString())
      expect(t.target_auto).toBe(true)
      expect(getCurrentlyDueTaskIds(TEST_USER_ID)).toContain(t.id)
    })

    test('TM8-007: a deadline already past → the deadline itself (never after it)', () => {
      const dl = at('2026-10-10T17:00')
      const t = make({ deadline_at: dl })
      expect(t.due_at).toBe(dl)
    })

    test('TM8-008: a deadline added by PATCH stores it and stamps target_set_at; Undo takes both back', () => {
      const t = make({})
      setClock('2026-10-12T15:00')
      const r = patch(t.id, { deadline_at: at('2026-10-23T23:59') })
      expect(r.fieldsChanged).toEqual(
        expect.arrayContaining(['deadline_at', 'due_at', 'target_auto', 'target_set_at']),
      )
      const after = getTaskById(t.id)!
      expect(local(after.due_at)).toBe('Tue Oct 20 09:00')
      expect(after.target_auto).toBe(true)
      executeUndo(TEST_USER_ID)
      const back = getTaskById(t.id)!
      expect(back.due_at).toBeNull()
      expect(back.target_auto).toBe(false)
      expect(back.target_set_at).toBe(t.target_set_at)
    })

    test('TM8-009: never on a repeating task, a reminder or a quota', () => {
      const rep = make({ rrule: 'FREQ=WEEKLY;BYDAY=SU', deadline_at: at('2026-10-30T23:00') })
      expect(rep.target_auto).toBe(false)
      const rem = make({ is_reminder: true, rrule: null })
      patch(rem.id, { deadline_at: at('2026-10-30T23:00') })
      expect(getTaskById(rem.id)!.due_at).toBeNull()
    })
  })

  describe('§8.2 target ≤ deadline, always', () => {
    const DL = '2026-10-16T17:00'

    test('TM8-010: PATCH past a deadline stops AT it and says so', () => {
      const t = make({ due_at: at('2026-10-13T09:00'), deadline_at: at(DL) })
      const r = patch(t.id, { due_at: at('2026-10-20T09:00') })
      expect(r.task.due_at).toBe(at(DL))
      expect(r.cappedAtDeadline).toBe(true)
      expect(r.description).toContain('Snoozed to deadline')
      expect(r.task.target_auto).toBe(false)
    })

    test("TM8-011: the snooze endpoint caps too; old clients' flags change nothing", () => {
      const t = make({ due_at: at('2026-10-13T09:00'), deadline_at: at(DL) })
      const r = snoozeTask({ ...u, taskId: t.id, until: at('2026-10-20T09:00') })
      expect(r.task.due_at).toBe(at(DL))
      expect(r.cappedAtDeadline).toBe(true)
      const t2 = make({ due_at: at('2026-10-13T09:00'), deadline_at: at(DL) })
      const r2 = patch(t2.id, {
        due_at: at('2026-10-20T09:00'),
        allow_past_deadline: true,
        cap_at_deadline: false,
        reset_original_due_at: true,
      })
      expect(r2.task.due_at).toBe(at(DL))
    })

    test('TM8-012: bulk snooze and bulk edit stop each at its own deadline, and count them', () => {
      const a = make({ due_at: at('2026-10-12T09:00'), deadline_at: at(DL) })
      const b = make({ due_at: at('2026-10-12T09:00') })
      const r = bulkSnooze({ ...u, taskIds: [a.id, b.id], until: at('2026-10-20T09:00') })
      expect(r.deadlineCapped).toBe(1)
      expect(r.deadlineSkipped).toBe(0)
      expect(getTaskById(a.id)!.due_at).toBe(at(DL))
      expect(getTaskById(b.id)!.due_at).toBe(at('2026-10-20T09:00'))
      const c = make({ due_at: at('2026-10-12T09:00'), deadline_at: at(DL) })
      const e = bulkEdit({
        ...u,
        taskIds: [a.id, c.id],
        changes: { due_at: at('2026-10-22T09:00') },
      })
      // `a` was already at its deadline: nothing moved, nothing to report.
      expect(e).toMatchObject({ tasksAffected: 1, deadlineCapped: 1, deadlineSkipped: 0 })
      expect(getTaskById(a.id)!.due_at).toBe(at(DL))
      expect(getTaskById(c.id)!.due_at).toBe(at(DL))
    })

    test('TM8-013: once the deadline has passed a move past it changes nothing', () => {
      const t = make({ due_at: at('2026-10-09T09:00'), deadline_at: at('2026-10-10T17:00') })
      const r = patch(t.id, { due_at: at('2026-10-13T09:00') })
      expect(r.fieldsChanged).toEqual([])
      expect(r.description).toBe(DEADLINE_PASSED_HOLDS)
      expect(getTaskById(t.id)!.due_at).toBe(at('2026-10-09T09:00'))
      const s = bulkSnooze({ ...u, taskIds: [t.id], until: at('2026-10-13T09:00') })
      expect(s).toMatchObject({ tasksAffected: 0, deadlineSkipped: 1, deadlineCapped: 0 })
    })

    test('TM8-014: Today with a time after the deadline (the picker) stops at it', () => {
      const t = make({ deadline_at: at('2026-10-12T18:00'), horizon: 'days' })
      const r = targetTasksToday(TEST_USER_ID, tz, [t.id], at('2026-10-12T20:00'))
      expect(r.affected).toBe(1)
      const after = getTaskById(t.id)!
      expect(after.due_at).toBe(at('2026-10-12T18:00'))
      expect(after.target_auto).toBe(false)
    })

    test('TM8-015: "Deadline day" — the deadline\'s morning, or the deadline itself if earlier', () => {
      expect(local(deadlineDayTarget(at('2026-10-16T17:00'), ctx))).toBe('Fri Oct 16 09:00')
      expect(local(deadlineDayTarget(at('2026-10-16T07:30'), ctx))).toBe('Fri Oct 16 07:30')
      expect(deadlineDayPick(at('2026-10-16T17:00'), ctx)).toEqual({
        label: 'Deadline day · Fri 9:00 AM',
        at: at('2026-10-16T09:00'),
      })
      // Its morning already gone: nothing to offer.
      expect(deadlineDayPick(at('2026-10-12T17:00'), ctx)).toBeNull()
      expect(deadlineDayPick(null, ctx)).toBeNull()
    })

    test('TM8-016: capAtDeadline is the one cap', () => {
      expect(capAtDeadline(at(DL), null)).toBe(at(DL))
      expect(capAtDeadline(at('2026-10-20T09:00'), at(DL))).toBe(at(DL))
      expect(capAtDeadline(at('2026-10-13T09:00'), at(DL))).toBe(at('2026-10-13T09:00'))
    })
  })

  describe('§8.3 Back to auto', () => {
    test('TM8-020: clearing a picked target on a deadline task puts the automatic one back; Undo restores the pick', () => {
      const t = make({ due_at: at('2026-10-14T10:00'), deadline_at: at('2026-10-23T23:59') })
      expect(t.target_auto).toBe(false)
      const r = patch(t.id, { due_at: null })
      expect(local(r.task.due_at)).toBe('Tue Oct 20 09:00')
      expect(r.task.target_auto).toBe(true)
      executeUndo(TEST_USER_ID)
      const back = getTaskById(t.id)!
      expect(back.due_at).toBe(at('2026-10-14T10:00'))
      expect(back.target_auto).toBe(false)
    })

    test("TM8-021: an old client's Remove target ({due_at: null, deadline_nag_off: true}) is Back to auto", () => {
      const t = make({ due_at: at('2026-10-14T10:00'), deadline_at: at('2026-10-23T23:59') })
      const r = patch(t.id, { due_at: null, deadline_nag_off: true })
      expect(r.task.target_auto).toBe(true)
      expect(formatTaskResponse(r.task).deadline_nag_off).toBe(false)
    })

    test('TM8-022: what each target offers (ruling Q9)', () => {
      const base = { due_at: at('2026-10-14T10:00'), deadline_at: null, rrule: null }
      expect(targetReset(base)).toBe('remove')
      expect(targetReset({ ...base, deadline_at: at('2026-10-23T23:59') })).toBe('auto')
      expect(
        targetReset({ ...base, deadline_at: at('2026-10-23T23:59'), target_auto: true }),
      ).toBeNull()
      expect(targetReset({ ...base, rrule: 'FREQ=DAILY' })).toBeNull()
      expect(targetReset({ ...base, due_at: null })).toBeNull()
    })

    test('TM8-023: the editor previews what Save would produce', () => {
      const picked = {
        due_at: at('2026-10-14T10:00'),
        deadline_at: at('2026-10-23T23:59'),
        target_auto: false,
      }
      const none = { pendingDeadline: undefined, targetCleared: false, datePicked: false }
      expect(stagedAutoTarget(picked, none, tz, ctx).label).toBeNull()
      const back = stagedAutoTarget(picked, { ...none, targetCleared: true }, tz, ctx)
      expect(back.staged).toBe(true)
      expect(back.label).toMatchObject({ lead: '3 days before deadline' })
      expect(local(back.label!.at)).toBe('Tue Oct 20 09:00')
      const auto = { ...picked, due_at: at('2026-10-20T09:00'), target_auto: true }
      expect(stagedAutoTarget(auto, none, tz, ctx)).toMatchObject({ staged: false })
      // A new deadline moves the automatic target with it.
      const moved = stagedAutoTarget(
        auto,
        { ...none, pendingDeadline: at('2026-10-31T23:59') },
        tz,
        ctx,
      )
      expect(local(moved.label!.at)).toBe('Tue Oct 27 09:00')
      // A picked date staged wins.
      expect(stagedAutoTarget(auto, { ...none, datePicked: true }, tz, ctx).label).toBeNull()
    })
  })

  describe('§8.4 deadline changes', () => {
    test('TM8-030: an automatic target moves with the deadline', () => {
      const t = make({ deadline_at: at('2026-10-23T23:59') })
      const r = patch(t.id, { deadline_at: at('2026-11-06T23:59') })
      expect(local(r.task.due_at)).toBe('Mon Nov 2 09:00')
      expect(r.task.target_auto).toBe(true)
    })

    test('TM8-031: a picked target stays, pulled back if the new deadline is earlier', () => {
      const t = make({ due_at: at('2026-10-20T10:00'), deadline_at: at('2026-10-23T23:59') })
      expect(patch(t.id, { deadline_at: at('2026-10-30T23:59') }).task.due_at).toBe(
        at('2026-10-20T10:00'),
      )
      const r = patch(t.id, { deadline_at: at('2026-10-18T12:00') })
      expect(r.task.due_at).toBe(at('2026-10-18T12:00'))
      expect(r.task.target_auto).toBe(false)
    })

    test('TM8-032: removing the deadline removes an automatic target, keeps a picked one', () => {
      const auto = make({ deadline_at: at('2026-10-23T23:59') })
      const r = patch(auto.id, { deadline_at: null })
      expect(r.task.due_at).toBeNull()
      expect(r.task.target_auto).toBe(false)
      const picked = make({ due_at: at('2026-10-20T10:00'), deadline_at: at('2026-10-23T23:59') })
      expect(patch(picked.id, { deadline_at: null }).task.due_at).toBe(at('2026-10-20T10:00'))
    })

    test('TM8-033: the resolver, case by case', () => {
      const w = {
        dueAt: null,
        dueWritten: false,
        currentDueAt: null,
        wasAuto: false,
        deadlineAt: at('2026-10-23T23:59'),
        deadlineChanged: true,
        autoEligible: true,
      }
      const now = new Date(at('2026-10-12T12:00'))
      expect(resolveTarget(w, ctx, now)).toMatchObject({ auto: true, capped: false })
      expect(resolveTarget({ ...w, autoEligible: false }, ctx, now).dueAt).toBeNull()
      const picked = { ...w, dueAt: at('2026-10-25T09:00'), dueWritten: true }
      expect(resolveTarget(picked, ctx, now)).toEqual({
        dueAt: at('2026-10-23T23:59'),
        auto: false,
        capped: true,
      })
    })
  })

  describe('§8.5 only a picked target is quiet', () => {
    test('TM8-040: an automatic target keeps the horizon rhythm, no Upcoming rows, then nags', () => {
      // Deadline Fri Oct 23 23:59 (days pull-in from Oct 17) → auto Tue Oct 20.
      const t = make({ deadline_at: at('2026-10-23T23:59') })
      setClock('2026-10-17T12:00')
      expect(places(t.id)).toEqual(['days'])
      setClock('2026-10-19T12:00')
      expect(places(t.id)).toEqual(['days'])
      expect(getCurrentlyDueTaskIds(TEST_USER_ID)).not.toContain(t.id)
      setClock('2026-10-20T12:00')
      expect(places(t.id)).toEqual([])
      expect(getCurrentlyDueTaskIds(TEST_USER_ID)).toContain(t.id)
    })

    test('TM8-041: a picked target on a deadline task is quiet — Upcoming only', () => {
      const t = make({ due_at: at('2026-10-21T09:00'), deadline_at: at('2026-10-23T23:59') })
      setClock('2026-10-17T12:00')
      expect(places(t.id)).toEqual([])
      setClock('2026-10-20T12:00')
      expect(places(t.id)).toEqual(['upcoming'])
    })

    test('TM8-042: Process never lists an automatic target as stale, and asks no growth of a picked one', () => {
      // Both made Sep 25, both over target 7+ days by Oct 12.
      setClock('2026-09-25T12:00')
      const auto = make({ deadline_at: at('2026-10-05T23:59') }) // auto Fri Oct 2
      const picked = make({ due_at: at('2026-10-01T09:00'), deadline_at: at('2026-10-30T23:59') })
      expect(auto.target_auto).toBe(true)
      setClock('2026-10-12T18:00')
      const p = getProcessData(TEST_USER_ID, tz)
      const stale = [...p.stale_targets, ...p.stale_targets_with_deadline].map((s) => s.task.id)
      expect(stale).not.toContain(auto.id)
      expect(stale).toContain(picked.id)
      expect(p.growth.map((g) => g.task.id)).not.toContain(picked.id)
    })
  })
})
