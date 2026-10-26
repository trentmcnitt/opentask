/**
 * UP: Upcoming — "a date means quiet until the date" (2026-10-12, spec rev 3
 * §1–§5; docs/TASK-MODEL.md § Upcoming).
 *
 * Every date here is a LOCAL day in America/Chicago. A day is "walked" at
 * local noon: the clock is set, today's segments are read, and (in the "tap"
 * model) each Upcoming row is considered, the way the spec's reference table
 * assumes. Repeating rows are produced by the real recurrence path: the task
 * is created and marked done, and `markDone` advances it and stamps
 * `target_set_at`.
 */
import { CALENDAR_DAY_START } from '@/lib/opentask-day'
import fs from 'fs'
import path from 'path'
import { describe, test, expect, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { DateTime } from 'luxon'
import { getDb } from '@/core/db'
import { createTask, updateTask, markDone, bulkSnooze, bulkEdit, bulkDone } from '@/core/tasks'
import { markUndone } from '@/core/tasks/mark-done'
import { skipOccurrence } from '@/core/tasks/skip'
import { snoozeTask } from '@/core/tasks/snooze'
import { getTaskById } from '@/core/tasks/read'
import { ValidationError } from '@/core/errors'
import { executeUndo, executeRedo } from '@/core/undo'
import { updateTimeSlot } from '@/core/time-slots/edit'
import { getCurrentlyDueTaskIds } from '@/core/tasks/currently-due'
import { isCurrentlyDue } from '@/core/recurrence/occurrence'
import {
  considerTasks,
  getTaskSegments,
  targetTasksToday,
  type SegmentKind,
} from '@/core/tasks/task-segments'
import { latestSegmentDay } from '@/lib/task-segments'
import { upcomingDays, upcomingGap, upcomingRowActions, waitDays } from '@/lib/task-segments'
import { horizonHints } from '@/lib/task-model-words'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

const tz = TEST_TIMEZONE

/** A local wall-clock time in Chicago, as the UTC ISO string the DB stores. */
function at(local: string): string {
  return DateTime.fromISO(local, { zone: tz }).toUTC().toISO()!
}

function setClock(local: string) {
  vi.setSystemTime(new Date(at(local)))
}

function make(input: Record<string, unknown> = {}) {
  return createTask({ userId: TEST_USER_ID, userTimezone: tz, input: { title: 'Task', ...input } })
}

function done(id: number) {
  return markDone({ userId: TEST_USER_ID, userTimezone: tz, taskId: id })
}

/** Every place a task shows in today's segments. */
function placesOf(id: number): { kind: SegmentKind; state: string }[] {
  const out: { kind: SegmentKind; state: string }[] = []
  for (const seg of getTaskSegments(TEST_USER_ID, tz)) {
    for (const row of seg.tasks)
      if (row.task.id === id) out.push({ kind: seg.horizon, state: row.state })
  }
  return out
}

/**
 * Walk local days `from`..`to` (inclusive) at noon and return the days the
 * task WAITED in a segment, with the segment. `tap`: consider it each day it
 * shows (the reference table's model). Every day asserts the task is in at
 * most one place — never a double row.
 */
function walk(
  id: number,
  from: string,
  to: string,
  { tap = true }: { tap?: boolean } = {},
): [string, SegmentKind][] {
  const shown: [string, SegmentKind][] = []
  let day = DateTime.fromISO(from, { zone: tz })
  const last = DateTime.fromISO(to, { zone: tz })
  while (day <= last) {
    vi.setSystemTime(day.set({ hour: 12 }).toJSDate())
    const places = placesOf(id)
    expect(places.length, `task ${id} on ${day.toISODate()}`).toBeLessThanOrEqual(1)
    const waiting = places.find((p) => p.state === 'waiting')
    if (waiting) {
      shown.push([day.toISODate()!, waiting.kind])
      if (tap) considerTasks(TEST_USER_ID, [id])
    }
    day = day.plus({ days: 1 })
  }
  return shown
}

/** The Upcoming days of a walk, as ISO dates. */
function shownUpcoming(id: number, from: string, to: string): string[] {
  return walk(id, from, to)
    .filter(([, kind]) => kind === 'upcoming')
    .map(([d]) => d)
}

describe('Upcoming', () => {
  afterAll(() => teardownTestDb())
  beforeEach(() => {
    setClock('2026-10-12T10:00')
    setupTestDb()
  })
  afterEach(() => vi.useRealTimers())

  describe('the rule', () => {
    test('UP-001: wait in local days; T−1 at wait ≥ 2; T−3 (wait 8–15) or T−4 (wait ≥ 16)', () => {
      const d = (iso: string) => DateTime.fromISO(iso, { zone: tz }).startOf('day')
      // The default leads (`upcomingDays(…, null)`): the same days as the
      // 2026-10-12 heads-ups — Later, then Tomorrow, earliest first.
      const heads = (target: string, set: string) => {
        const { later, tomorrow } = upcomingDays(d(target), d(set), null)
        return [later, tomorrow].filter((x) => x !== null).map((x) => x.toISODate())
      }
      expect(heads('2026-10-13', '2026-10-12')).toEqual([])
      expect(heads('2026-10-14', '2026-10-12')).toEqual(['2026-10-13'])
      expect(heads('2026-10-19', '2026-10-12')).toEqual(['2026-10-18']) // wait 7
      expect(heads('2026-10-20', '2026-10-12')).toEqual(['2026-10-17', '2026-10-19']) // 8
      expect(heads('2026-10-27', '2026-10-12')).toEqual(['2026-10-24', '2026-10-26']) // 15
      expect(heads('2026-10-28', '2026-10-12')).toEqual(['2026-10-24', '2026-10-27']) // 16
      // A local wait across the DST change is still whole days.
      expect(waitDays(d('2026-11-01'), d('2026-10-26'))).toBe(6)
      expect(waitDays(d('2026-11-02'), d('2026-10-31'))).toBe(2)
    })

    test('UP-002: a late-night creation counts that day as day 0 (local, not UTC)', () => {
      // Made Mon Oct 12 at 11 PM (Tue 04:00Z) for Wed Oct 14 at 12:30 AM: local
      // wait 2 → a Tuesday row. UTC-day math would say wait 1, no row.
      setClock('2026-10-12T23:00')
      const t = make({ due_at: at('2026-10-14T00:30') })
      expect(shownUpcoming(t.id, '2026-10-12', '2026-10-14')).toEqual(['2026-10-13'])
    })
  })

  describe('the reference dates (spec §2), exactly', () => {
    test('UP-010: made Sat Oct 10, target Tue Oct 13 → Mon Oct 12', () => {
      setClock('2026-10-10T10:00')
      const t = make({ due_at: at('2026-10-13T09:00') })
      expect(shownUpcoming(t.id, '2026-10-10', '2026-10-13')).toEqual(['2026-10-12'])
    })

    test('UP-011: made today, target tomorrow → none', () => {
      const t = make({ due_at: at('2026-10-13T09:00') })
      expect(shownUpcoming(t.id, '2026-10-12', '2026-10-13')).toEqual([])
    })

    test('UP-012: target Tue Oct 20 (wait 8) → Sat Oct 17, Mon Oct 19', () => {
      const t = make({ due_at: at('2026-10-20T09:00') })
      expect(shownUpcoming(t.id, '2026-10-12', '2026-10-20')).toEqual(['2026-10-17', '2026-10-19'])
    })

    test('UP-013: every 2 weeks, done Mon Oct 12 → Mon Oct 26 (wait 14) → Fri Oct 23, Sun Oct 25', () => {
      setClock('2026-10-12T08:00')
      const t = make({ rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO', due_at: at('2026-10-12T09:00') })
      setClock('2026-10-12T10:00')
      done(t.id)
      expect(getTaskById(t.id)!.due_at).toBe(at('2026-10-26T09:00'))
      expect(shownUpcoming(t.id, '2026-10-12', '2026-10-26')).toEqual(['2026-10-23', '2026-10-25'])
    })

    test('UP-014: snowmobile, Sun Nov 1 (wait 20) → Wed Oct 28, Sat Oct 31', () => {
      const t = make({ due_at: at('2026-11-01T09:00') })
      expect(shownUpcoming(t.id, '2026-10-12', '2026-11-01')).toEqual(['2026-10-28', '2026-10-31'])
    })

    test('UP-015: monthly, done Sun Nov 1 → Tue Dec 1 (wait 30) → Fri Nov 27, Mon Nov 30', () => {
      setClock('2026-11-01T08:00')
      const t = make({ rrule: 'FREQ=MONTHLY;BYMONTHDAY=1', due_at: at('2026-11-01T09:00') })
      setClock('2026-11-01T10:00')
      done(t.id)
      expect(getTaskById(t.id)!.due_at).toBe(at('2026-12-01T09:00'))
      expect(shownUpcoming(t.id, '2026-11-01', '2026-12-01')).toEqual(['2026-11-27', '2026-11-30'])
    })

    test('UP-016: monthly, done Tue Dec 1 → Fri Jan 1 (wait 31) → Mon Dec 28, Thu Dec 31', () => {
      setClock('2026-12-01T08:00')
      const t = make({ rrule: 'FREQ=MONTHLY;BYMONTHDAY=1', due_at: at('2026-12-01T09:00') })
      setClock('2026-12-01T10:00')
      done(t.id)
      expect(getTaskById(t.id)!.due_at).toBe(at('2027-01-01T09:00'))
      expect(shownUpcoming(t.id, '2026-12-01', '2027-01-01')).toEqual(['2026-12-28', '2026-12-31'])
    })

    test('UP-017: taxes, Mon Feb 1 (wait 112) → Thu Jan 28, Sun Jan 31', () => {
      const t = make({ due_at: at('2027-02-01T09:00') })
      expect(shownUpcoming(t.id, '2026-10-12', '2027-02-01')).toEqual(['2027-01-28', '2027-01-31'])
    })

    test('UP-018: gutters, Sat Apr 17 (wait 187) → Tue Apr 13, Fri Apr 16', () => {
      const t = make({ due_at: at('2027-04-17T09:00') })
      expect(shownUpcoming(t.id, '2026-10-12', '2027-04-17')).toEqual(['2027-04-13', '2027-04-16'])
    })

    test('UP-019: weekly Sunday done on its day (wait 7) → Saturday', () => {
      setClock('2026-10-18T08:00')
      const t = make({ rrule: 'FREQ=WEEKLY;BYDAY=SU', due_at: at('2026-10-18T12:00') })
      setClock('2026-10-18T13:00')
      done(t.id)
      expect(getTaskById(t.id)!.due_at).toBe(at('2026-10-25T12:00'))
      expect(shownUpcoming(t.id, '2026-10-18', '2026-10-25')).toEqual(['2026-10-24'])
    })

    test('UP-020: codes-blog done Fri for Sun (wait 9) → Thu, Sat', () => {
      setClock('2026-10-16T08:00')
      const t = make({ rrule: 'FREQ=WEEKLY;BYDAY=SU', due_at: at('2026-10-18T12:00') })
      setClock('2026-10-16T20:00')
      done(t.id)
      // Done early is safe: max(Sun, Fri) = Sun, so the next one is Oct 25.
      expect(getTaskById(t.id)!.due_at).toBe(at('2026-10-25T12:00'))
      expect(shownUpcoming(t.id, '2026-10-17', '2026-10-25')).toEqual(['2026-10-22', '2026-10-24'])
    })

    test('UP-021: daily (wait 1) → none', () => {
      setClock('2026-10-12T08:00')
      const t = make({ rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0', due_at: at('2026-10-12T09:00') })
      setClock('2026-10-12T10:00')
      done(t.id)
      expect(getTaskById(t.id)!.due_at).toBe(at('2026-10-13T09:00'))
      expect(shownUpcoming(t.id, '2026-10-12', '2026-10-13')).toEqual([])
    })
  })

  describe('golden timeline', () => {
    /**
     * Day by day, Mon Oct 12 → Sun Nov 1 (America/Chicago), what shows where
     * — every segment, every row, in screen order — for a small mixed list,
     * each row considered the day it shows. The shape batch 2's scenario
     * suite builds on: a scenario, a walk, and the expected day map.
     */
    test('UP-100: one-offs, a repeating task, a deadline-only task and a weeks task', () => {
      setClock('2026-10-10T10:00')
      make({ title: 'A made Sat for Tue Oct 13', due_at: at('2026-10-13T09:00') })
      setClock('2026-10-12T08:00')
      const f = make({
        title: 'F every 2 weeks',
        rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO',
        due_at: at('2026-10-12T09:00'),
      })
      setClock('2026-10-12T10:00')
      done(f.id)
      make({ title: 'B target Tue Oct 20', due_at: at('2026-10-20T09:00') })
      make({ title: 'C snowmobile Nov 1', due_at: at('2026-11-01T09:00') })
      make({ title: 'D deadline Fri Oct 23', deadline_at: at('2026-10-23T23:59') })
      make({ title: 'W weeks, no target', horizon: 'weeks' })

      const seen: Record<string, string[]> = {}
      let day = DateTime.fromISO('2026-10-12', { zone: tz })
      while (day <= DateTime.fromISO('2026-11-01', { zone: tz })) {
        vi.setSystemTime(day.set({ hour: 12 }).toJSDate())
        const rows = getTaskSegments(TEST_USER_ID, tz).flatMap((seg) =>
          seg.tasks
            .filter((r) => r.state === 'waiting')
            .map((r) => ({ id: r.task.id, label: `${seg.horizon}: ${r.task.title}` })),
        )
        seen[day.toISODate()!] = rows.map((r) => r.label)
        if (rows.length > 0) considerTasks(TEST_USER_ID, [...new Set(rows.map((r) => r.id))])
        day = day.plus({ days: 1 })
      }

      const golden: Record<string, string[]> = {
        '2026-10-12': ['upcoming: A made Sat for Tue Oct 13'],
        '2026-10-17': [
          'days: D deadline Fri Oct 23',
          'upcoming: B target Tue Oct 20',
          'weeks: W weeks, no target',
        ],
        '2026-10-18': ['days: D deadline Fri Oct 23'],
        // D's automatic target (§8.1): an 11-day wait, lead 3 → Tue Oct 20,
        // 9:00 — so it still waits in Days on the 19th, over target from the 20th.
        '2026-10-19': ['days: D deadline Fri Oct 23', 'upcoming: B target Tue Oct 20'],
        '2026-10-23': ['upcoming: F every 2 weeks'],
        '2026-10-24': ['weeks: W weeks, no target'],
        '2026-10-25': ['upcoming: F every 2 weeks'],
        '2026-10-28': ['upcoming: C snowmobile Nov 1'],
        '2026-10-31': ['upcoming: C snowmobile Nov 1', 'weeks: W weeks, no target'],
      }
      const expected = Object.fromEntries(Object.keys(seen).map((d) => [d, golden[d] ?? []]))
      expect(seen).toEqual(expected)
    })
  })

  describe('carry-over, never a double row', () => {
    test('UP-030: untapped, it carries day to day as ONE row until the target day, then is over target', () => {
      const t = make({ due_at: at('2026-10-20T09:00') })
      const shown = walk(t.id, '2026-10-12', '2026-10-20', { tap: false })
      expect(shown).toEqual([
        ['2026-10-17', 'upcoming'],
        ['2026-10-18', 'upcoming'],
        ['2026-10-19', 'upcoming'],
      ])
      // The target's day: out of Upcoming, and over target once the hour comes
      // (the over-target SQL reads SQLite's own clock, so the rule is asked
      // directly here).
      setClock('2026-10-20T10:00')
      expect(placesOf(t.id)).toEqual([])
      expect(isCurrentlyDue(getTaskById(t.id)!, tz, CALENDAR_DAY_START, new Date())).toBe(true)
    })

    test('UP-031: considered on the early heads-up, it is back on the day before (chained)', () => {
      const t = make({ due_at: at('2026-10-20T09:00') })
      setClock('2026-10-17T12:00')
      considerTasks(TEST_USER_ID, [t.id])
      // Considered today: listed ticked (X of Y, put-back), still one row.
      expect(placesOf(t.id)).toEqual([{ kind: 'upcoming', state: 'considered' }])
      setClock('2026-10-18T12:00')
      expect(placesOf(t.id)).toEqual([])
      setClock('2026-10-19T12:00')
      expect(placesOf(t.id)).toEqual([{ kind: 'upcoming', state: 'waiting' }])
    })

    test('UP-032: a move restamps — a +1 week move of an over-target task gets a day-before row', () => {
      setClock('2026-10-05T09:00')
      const t = make({ due_at: at('2026-10-10T09:00') })
      setClock('2026-10-12T10:00') // over target
      expect(getCurrentlyDueTaskIds(TEST_USER_ID)).toContain(t.id)
      snoozeTask({
        userId: TEST_USER_ID,
        userTimezone: tz,
        taskId: t.id,
        until: at('2026-10-19T09:00'),
      })
      expect(shownUpcoming(t.id, '2026-10-12', '2026-10-19')).toEqual(['2026-10-18'])
    })

    test('UP-033: a target past its deadline is stored AT the deadline; Upcoming counts to it', () => {
      // Deadline Fri Oct 23 00:00, asked-for target Mon Oct 26: target ≤
      // deadline always (§8.2), so it is stored at the deadline, still a picked
      // target. Wait 11 (Oct 12 → Oct 23) → heads-ups Tue Oct 20 and Thu Oct 22.
      const t = make({ due_at: at('2026-10-26T09:00'), deadline_at: at('2026-10-23T00:00') })
      const stored = getTaskById(t.id)!
      expect(stored.due_at).toBe(at('2026-10-23T00:00'))
      expect(stored.target_auto).toBe(false)
      expect(shownUpcoming(t.id, '2026-10-12', '2026-10-23')).toEqual(['2026-10-20', '2026-10-22'])
      expect(upcomingGap(stored, tz, CALENDAR_DAY_START)).toEqual({
        target: 'Target Fri Oct 23',
        deadline: 'deadline Fri Oct 23',
      })
      expect(
        upcomingGap(
          { due_at: at('2026-11-03T09:00'), deadline_at: at('2026-11-07T23:59') },
          tz,
          CALENDAR_DAY_START,
        ),
      ).toEqual({ target: 'Target Tue Nov 3', deadline: 'deadline Sat Nov 7' })
      expect(
        upcomingGap({ due_at: at('2026-11-03T09:00'), deadline_at: null }, tz, CALENDAR_DAY_START),
      ).toEqual({
        target: 'Target Tue Nov 3',
        deadline: null,
      })
    })

    test('UP-034: Defer all — off today, back tomorrow', async () => {
      const { deferTasks } = await import('@/core/tasks/task-segments')
      const t = make({ due_at: at('2026-10-20T09:00') })
      setClock('2026-10-17T12:00')
      deferTasks(TEST_USER_ID, [t.id])
      expect(placesOf(t.id)).toEqual([{ kind: 'upcoming', state: 'deferred' }])
      setClock('2026-10-18T12:00')
      expect(placesOf(t.id)).toEqual([{ kind: 'upcoming', state: 'waiting' }])
    })

    test('UP-035: reminders, quotas and done tasks never appear; rows are in target order', () => {
      setClock('2026-10-01T09:00')
      const later = make({ due_at: at('2026-10-21T09:00') })
      const sooner = make({ due_at: at('2026-10-20T09:00'), priority: 0 })
      const rem = make({ is_reminder: true, rrule: 'FREQ=WEEKLY;BYDAY=TU;BYHOUR=9;BYMINUTE=0' })
      const q = make({ is_tracked: true, progress_target: 3, rrule: 'FREQ=WEEKLY' })
      setClock('2026-10-17T12:00')
      const seg = getTaskSegments(TEST_USER_ID, tz).find((s) => s.horizon === 'upcoming')!
      expect(seg.tasks.map((r) => r.task.id)).toEqual([sooner.id, later.id])
      for (const t of [rem, q]) expect(placesOf(t.id)).toEqual([])
    })

    test('UP-036: Upcoming sits directly after Days, before Weeks (on a check-in day too)', () => {
      setClock('2026-10-01T09:00')
      make({ horizon: 'days' })
      make({ horizon: 'weeks' })
      make({ due_at: at('2026-10-20T09:00') })
      setClock('2026-10-17T12:00') // a Saturday
      expect(getTaskSegments(TEST_USER_ID, tz).map((s) => s.horizon)).toEqual([
        'days',
        'upcoming',
        'weeks',
      ])
    })
  })

  describe('§1: a target makes a task quiet until its date', () => {
    test('UP-040: a deadline-only task (23:59) shows in its pulled-in segment D−6 to D−4, never Upcoming', () => {
      const t = make({ deadline_at: at('2026-10-23T23:59') })
      // The automatic target (§8.1): set Mon Oct 12, an 11-day wait → lead 3
      // → Tue Oct 20, 9:00 AM. Auto, so it never makes the task quiet.
      const stored = getTaskById(t.id)!
      expect(stored.due_at).toBe(at('2026-10-20T09:00'))
      expect(stored.target_auto).toBe(true)
      expect(walk(t.id, '2026-10-12', '2026-10-23')).toEqual([
        ['2026-10-17', 'days'],
        ['2026-10-18', 'days'],
        ['2026-10-19', 'days'],
      ])
      // D−3: the automatic target, 9:00 AM — over target.
      setClock('2026-10-20T10:00')
      expect(getCurrentlyDueTaskIds(TEST_USER_ID)).toContain(t.id)
    })

    test('UP-041: a targeted one-off leaves the horizon segments; removing the target brings it back', () => {
      setClock('2026-10-05T09:00')
      const t = make({ horizon: 'days', due_at: at('2026-10-20T09:00') })
      setClock('2026-10-17T12:00')
      expect(placesOf(t.id)).toEqual([{ kind: 'upcoming', state: 'waiting' }])
      const before = getTaskById(t.id)!
      // Remove target — the row's one-tap action on a no-deadline one-off
      // (PATCH { target_at: null }).
      updateTask({ userId: TEST_USER_ID, userTimezone: tz, taskId: t.id, input: { due_at: null } })
      expect(placesOf(t.id)).toEqual([{ kind: 'days', state: 'waiting' }])
      expect(getTaskById(t.id)!.target_set_at).not.toBe(before.target_set_at)
      executeUndo(TEST_USER_ID)
      const undone = getTaskById(t.id)!
      expect(undone.due_at).toBe(before.due_at)
      expect(undone.target_set_at).toBe(before.target_set_at)
      expect(placesOf(t.id)).toEqual([{ kind: 'upcoming', state: 'waiting' }])
    })
  })

  describe('row actions', () => {
    test('UP-043: Today on every row; Remove target, with a deadline or without', () => {
      const target = at('2026-11-03T09:00')
      const deadline = at('2026-11-07T23:59')
      const row = (recurring: boolean, deadline_at: string | null, target_auto = false) =>
        upcomingRowActions({ recurring, task: { due_at: target, deadline_at, target_auto } })
      expect(row(false, null)).toEqual({ today: true, reset: 'remove' })
      // "Back to auto" went 2026-10-22: a deadline task goes on the deadlines page.
      expect(row(false, deadline)).toEqual({ today: true, reset: 'remove' })
      // An automatic target (task queue off) offers nothing.
      expect(row(false, deadline, true)).toEqual({ today: true, reset: null })
      // A repeating task's target goes with its recurrence: no reset here.
      expect(row(true, null)).toEqual({ today: true, reset: null })
      expect(row(true, deadline)).toEqual({ today: true, reset: null })
    })
  })

  describe('DST: the 14 targets on Sun Nov 1 2026 (synthetic)', () => {
    test('UP-050: 8 one-offs, 2 monthly and 4 weekly occurrences land on the right local days', () => {
      // The two edge times: 12:30 AM (still CDT) and 8:00 AM CST.
      expect(at('2026-11-01T00:30')).toBe('2026-11-01T05:30:00.000Z')
      expect(at('2026-11-01T08:00')).toBe('2026-11-01T14:00:00.000Z')

      setClock('2026-10-01T08:00')
      const monthly = ['09:00', '12:00'].map((hm) =>
        make({ rrule: 'FREQ=MONTHLY;BYMONTHDAY=1', due_at: at(`2026-10-01T${hm}`) }),
      )
      setClock('2026-10-01T13:00')
      for (const t of monthly) done(t.id)

      setClock('2026-10-12T10:00')
      const oneOffs = ['00:30', '07:00', '08:00', '09:00', '12:00', '17:00', '21:00', '23:59'].map(
        (hm) => make({ due_at: at(`2026-11-01T${hm}`) }),
      )

      setClock('2026-10-25T08:00')
      const weekly = ['09:00', '10:00', '12:00', '18:00'].map((hm) =>
        make({ rrule: 'FREQ=WEEKLY;BYDAY=SU', due_at: at(`2026-10-25T${hm}`) }),
      )
      setClock('2026-10-25T20:00')
      for (const t of weekly) done(t.id)

      // Every occurrence is on Nov 1 at its own local hour, across the change.
      for (const [t, hm] of [
        [monthly[0], '09:00'],
        [monthly[1], '12:00'],
        [weekly[0], '09:00'],
        [weekly[3], '18:00'],
      ] as const) {
        expect(getTaskById(t.id)!.due_at).toBe(at(`2026-11-01T${hm}`))
      }

      const all = [...oneOffs, ...monthly, ...weekly]
      const perDay: Record<string, number> = {}
      let day = DateTime.fromISO('2026-10-26', { zone: tz })
      while (day <= DateTime.fromISO('2026-11-01', { zone: tz })) {
        vi.setSystemTime(day.set({ hour: 12 }).toJSDate())
        const seg = getTaskSegments(TEST_USER_ID, tz).find((s) => s.horizon === 'upcoming')
        const ids = new Set((seg?.tasks ?? []).map((r) => r.task.id))
        expect(ids.size).toBe(seg?.tasks.length ?? 0) // no double row
        perDay[day.toISODate()!] = all.filter((t) => ids.has(t.id)).length
        if (seg) considerTasks(TEST_USER_ID, [...ids])
        day = day.plus({ days: 1 })
      }
      // One-offs and monthlies (wait 20 / 31): Wed Oct 28 and Sat Oct 31.
      // Weeklies done on their day (wait 7): Sat Oct 31 only.
      expect(perDay).toEqual({
        '2026-10-26': 0,
        '2026-10-27': 0,
        '2026-10-28': 10,
        '2026-10-29': 0,
        '2026-10-30': 0,
        '2026-10-31': 14,
        '2026-11-01': 0,
      })
    })
  })

  describe('check-in day (§3)', () => {
    function checkIn(day: number) {
      getDb().prepare('UPDATE users SET check_in_day = ? WHERE id = ?').run(day, TEST_USER_ID)
    }
    function aged(horizon: string, created: string) {
      const t = make({ horizon })
      getDb().prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run(at(created), t.id)
      return t
    }

    test('UP-060: Tuesday — Weeks, Months and Eventually follow it', () => {
      const d = (iso: string) => DateTime.fromISO(iso, { zone: tz }).startOf('day')
      expect(latestSegmentDay('weeks', d('2026-10-14'), 2).toISODate()).toBe('2026-10-13')
      expect(latestSegmentDay('months', d('2026-10-14'), 2).toISODate()).toBe('2026-10-06')
      expect(latestSegmentDay('months', d('2026-10-05'), 2).toISODate()).toBe('2026-09-01')
      expect(latestSegmentDay('eventually', d('2026-12-20'), 2).toISODate()).toBe('2026-10-06')
      expect(latestSegmentDay('eventually', d('2026-10-05'), 2).toISODate()).toBe('2026-07-07')

      checkIn(2)
      const weeks = aged('weeks', '2026-10-07T09:00') // a Wednesday
      const months = aged('months', '2026-09-02T09:00') // after Sep's first Tuesday
      const eventually = aged('eventually', '2026-07-08T09:00') // after Jul's first Tuesday
      // Mon Oct 5 — with Saturday, Months and Eventually would have shown on
      // Sat Oct 3; with Tuesday none has come round yet.
      setClock('2026-10-05T12:00')
      for (const t of [weeks, months, eventually]) expect(placesOf(t.id)).toEqual([])
      // Tue Oct 6, the first Tuesday of October and of the quarter.
      setClock('2026-10-06T12:00')
      expect(placesOf(months.id)).toEqual([{ kind: 'months', state: 'waiting' }])
      expect(placesOf(eventually.id)).toEqual([{ kind: 'eventually', state: 'waiting' }])
      // Sat Oct 10: not the check-in day, so the weeks task (made Wed) waits.
      setClock('2026-10-10T12:00')
      expect(placesOf(weeks.id)).toEqual([])
      setClock('2026-10-13T12:00') // Tuesday Oct 13
      expect(placesOf(weeks.id)).toEqual([{ kind: 'weeks', state: 'waiting' }])
    })

    test('UP-061: Upcoming is unchanged by the check-in day', () => {
      checkIn(2)
      const t = make({ due_at: at('2026-10-20T09:00') })
      expect(shownUpcoming(t.id, '2026-10-12', '2026-10-20')).toEqual(['2026-10-17', '2026-10-19'])
    })

    test('UP-062: the header hints are derived from it', () => {
      expect(horizonHints(6)).toEqual({
        days: 'Daily',
        weeks: 'Saturdays',
        months: '1st Saturday',
        eventually: 'Quarterly',
      })
      expect(horizonHints(2).weeks).toBe('Tuesdays')
      expect(horizonHints(2).months).toBe('1st Tuesday')
    })
  })

  describe('Today on a repeating row (§6, 2026-10-12 — replaces ruling Q1)', () => {
    test("UP-070: target-today moves a repeating task's target only; done advances from the occurrence", () => {
      const rec = make({ rrule: 'FREQ=WEEKLY;BYDAY=SU', due_at: at('2026-10-18T12:00') })
      const one = make({ due_at: at('2026-10-20T09:00') })
      const r = targetTasksToday(TEST_USER_ID, tz, [rec.id, one.id])
      expect(r.skipped_recurring).toEqual([])
      expect(r.affected).toBe(2)
      const moved = getTaskById(rec.id)!
      expect(moved.due_at).toBe(r.until)
      // The scheduled occurrence and the first-target date stay put.
      expect(moved.occurrence_at).toBe(at('2026-10-18T12:00'))
      expect(moved.original_due_at).toBe(at('2026-10-18T12:00'))
      expect(getTaskById(one.id)!.due_at).toBe(r.until)
      // Done today: the next one is the Sunday AFTER the scheduled one — no
      // double fire on Oct 18.
      done(rec.id)
      const next = getTaskById(rec.id)!
      expect(next.due_at).toBe(at('2026-10-25T12:00'))
      expect(next.occurrence_at).toBe(at('2026-10-25T12:00'))
    })

    test('UP-071: only repeating — written as one undo entry; the picker (`at`) too', () => {
      const rec = make({ rrule: 'FREQ=WEEKLY;BYDAY=SU', due_at: at('2026-10-18T12:00') })
      const entries = () =>
        (getDb().prepare('SELECT COUNT(*) AS n FROM undo_log').get() as { n: number }).n
      const n = entries()
      const r = targetTasksToday(TEST_USER_ID, tz, [rec.id], at('2026-10-13T15:00'))
      expect(r).toMatchObject({ affected: 1, skipped_recurring: [] })
      expect(entries()).toBe(n + 1)
      expect(getTaskById(rec.id)!.due_at).toBe(at('2026-10-13T15:00'))
      expect(getTaskById(rec.id)!.occurrence_at).toBe(at('2026-10-18T12:00'))
      executeUndo(TEST_USER_ID)
      expect(getTaskById(rec.id)!.due_at).toBe(at('2026-10-18T12:00'))
    })
  })
})

/**
 * `target_set_at` is stamped by every path that writes a target or a deadline
 * (src/core/tasks/target-set.ts), and undo/redo restore it. Each path below
 * starts from an old stamp; the write must replace it with now, and Undo
 * must put the old one back.
 */
describe('target_set_at writers', () => {
  const OLD = '2026-01-01T00:00:00.000Z'
  afterAll(() => teardownTestDb())
  beforeEach(() => {
    setClock('2026-10-12T10:00')
    setupTestDb()
  })
  afterEach(() => vi.useRealTimers())

  const now = () => new Date().toISOString()
  function old(id: number) {
    getDb().prepare('UPDATE tasks SET target_set_at = ? WHERE id = ?').run(OLD, id)
  }
  function stampedThenRestored(id: number, write: () => void) {
    old(id)
    write()
    expect(getTaskById(id)!.target_set_at).toBe(now())
    executeUndo(TEST_USER_ID)
    expect(getTaskById(id)!.target_set_at).toBe(OLD)
    executeRedo(TEST_USER_ID)
    expect(getTaskById(id)!.target_set_at).toBe(now())
  }
  const u = { userId: TEST_USER_ID, userTimezone: tz }

  test('UP-080: create stamps it (with or without a target)', () => {
    expect(make({ due_at: at('2026-10-20T09:00') }).target_set_at).toBe(now())
    expect(make().target_set_at).toBe(now())
  })

  test('UP-081: PATCH target (move), PATCH deadline, and re-target', () => {
    const t = make({ due_at: at('2026-10-20T09:00') })
    stampedThenRestored(t.id, () =>
      updateTask({ ...u, taskId: t.id, input: { due_at: at('2026-10-27T09:00') } }),
    )
    stampedThenRestored(t.id, () =>
      updateTask({ ...u, taskId: t.id, input: { deadline_at: at('2026-11-27T09:00') } }),
    )
    stampedThenRestored(t.id, () =>
      updateTask({
        ...u,
        taskId: t.id,
        input: { due_at: at('2026-10-29T09:00'), reset_original_due_at: true },
      }),
    )
  })

  test('UP-082: an edit that touches neither date leaves it alone', () => {
    const t = make({ due_at: at('2026-10-20T09:00') })
    old(t.id)
    updateTask({ ...u, taskId: t.id, input: { title: 'Renamed', priority: 2 } })
    expect(getTaskById(t.id)!.target_set_at).toBe(OLD)
  })

  test('UP-083: snooze, bulk snooze, bulk edit, Today', () => {
    const t = make({ due_at: at('2026-10-20T09:00') })
    stampedThenRestored(t.id, () =>
      snoozeTask({ ...u, taskId: t.id, until: at('2026-10-21T09:00') }),
    )
    stampedThenRestored(t.id, () =>
      bulkSnooze({ ...u, taskIds: [t.id], until: at('2026-10-22T09:00') }),
    )
    stampedThenRestored(t.id, () =>
      bulkEdit({ ...u, taskIds: [t.id], changes: { due_at: at('2026-10-23T09:00') } }),
    )
    stampedThenRestored(t.id, () => targetTasksToday(TEST_USER_ID, tz, [t.id]))
  })

  test('UP-084: completion advance (single and bulk), skip, put-back', () => {
    const t = make({ rrule: 'FREQ=WEEKLY;BYDAY=SU', due_at: at('2026-10-18T12:00') })
    stampedThenRestored(t.id, () => done(t.id))
    stampedThenRestored(t.id, () => bulkDone({ ...u, taskIds: [t.id] }))
    stampedThenRestored(t.id, () => skipOccurrence({ ...u, taskId: t.id }))
    done(t.id)
    stampedThenRestored(t.id, () => markUndone({ ...u, taskId: t.id }))
  })

  test('UP-085: a period retime moves its reminders and stamps them', () => {
    getDb().prepare('DELETE FROM time_slots WHERE user_id = ?').run(TEST_USER_ID)
    const slot = getDb()
      .prepare(
        "INSERT INTO time_slots (user_id, label, start_time, sort_order) VALUES (?, 'Morning', '08:30', 0)",
      )
      .run(TEST_USER_ID)
    const r = make({
      is_reminder: true,
      rrule: 'FREQ=DAILY;BYHOUR=8;BYMINUTE=30',
      due_at: at('2026-10-13T08:30'),
    })
    stampedThenRestored(r.id, () =>
      updateTimeSlot({
        ...u,
        slotId: Number(slot.lastInsertRowid),
        input: { start_time: '07:15' },
      }),
    )
  })
})

/**
 * The guard: a file under src/ that writes `due_at` or `deadline_at` in SQL
 * (a `due_at = ?` / `= NULL` clause, or an INSERT into tasks) must import the
 * stamp module, so a new writer can't silently skip `target_set_at`. A coarse
 * textual match with an explicit allowlist (each with its reason) is the
 * point: a precise regex is what a new writer slips past. Paths that build the
 * clause from a variable (`trackField`'s `${field} = ?`) live in files that
 * also carry a literal one, and the behavioral tests above exercise them.
 */
describe('target_set_at guard', () => {
  const ALLOWED: Record<string, string> = {
    // Migrations and backfills: the column's own seed, and clearing quotas'
    // stray dates (a quota is never in Upcoming).
    'src/core/db/index.ts': 'migrations',
    // §8 (2026-10-12): the one-time pass that gives deadline tasks their
    // automatic target and caps targets at their deadline.
    'src/core/db/migrate-deadline-targets.ts': 'migrations',
    // The deadlines page (2026-10-22): removes automatic targets once, under
    // the undo fence; never a target the user sets.
    'src/core/db/migrate-deadline-leads.ts': 'migrations',
    // A pre-migration automatic target converted on reopen / restore (the
    // deadlines page): its SQL fragment runs inside mark-done.ts and delete.ts,
    // which stamp and snapshot it; it never writes a target, only clears one.
    'src/core/tasks/auto-target-lead.ts': 'clears an automatic target (autoTargetToLead)',
    // Relative targets (2026-10-24): a reopened relative one-off's target
    // re-derived from its offsets (`rederiveOnReopen`, run inside mark-done.ts
    // and delete.ts) catches up with a period retime made while it was closed
    // — like the retime itself it is not the user setting a target, so it
    // keeps `target_set_at` (decision 11).
    'src/core/tasks/relative-target.ts': 'a retime catch-up on reopen (rederiveOnReopen)',
  }

  function files(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) return files(p)
      // .ts only: SQL lives in server modules, never in a component.
      return /\.ts$/.test(e.name) ? [p] : []
    })
  }

  test('UP-090: every SQL writer of due_at / deadline_at imports target-set', () => {
    const root = process.cwd()
    const writer = /\b(due_at|deadline_at)\s*=\s*(\?|NULL)|INSERT INTO tasks/i
    const offenders = files(path.join(root, 'src'))
      .map((f) => path.relative(root, f))
      .filter((f) => !ALLOWED[f] && f !== 'src/core/tasks/target-set.ts')
      .filter((f) => writer.test(fs.readFileSync(f, 'utf8')))
      .filter(
        (f) => !/from '(\.\.?\/|@\/core\/tasks\/)target-set'/.test(fs.readFileSync(f, 'utf8')),
      )
    expect(offenders).toEqual([])
  })
})

// ===========================================================================
// UP-110+: Upcoming's two sections (2026-10-25, plan-upcoming-split-1024)
// ===========================================================================

const d = (iso: string) => DateTime.fromISO(iso, { zone: tz }).startOf('day')
const days = (a: string, set: string, lead: number | null) => {
  const { later, tomorrow } = upcomingDays(d(a), d(set), lead)
  return { later: later?.toISODate() ?? null, tomorrow: tomorrow?.toISODate() ?? null }
}

/** The task's Upcoming row today (state and section), or null. */
function upcomingRow(id: number, opts: { handledRows?: boolean } = {}) {
  const seg = getTaskSegments(TEST_USER_ID, tz, new Date(), opts).find(
    (s) => s.horizon === 'upcoming',
  )
  const row = seg?.tasks.find((t) => t.task.id === id)
  return row ? { state: row.state, section: row.section, left: row.left } : null
}

describe('Upcoming sections (2026-10-25)', () => {
  afterAll(() => teardownTestDb())
  beforeEach(() => {
    setClock('2026-10-12T10:00')
    setupTestDb()
  })
  afterEach(() => vi.useRealTimers())

  test('UP-110: the two days — Tomorrow = A − 1 (wait ≥ 2); Later = max(A − lead, set + 1) ≤ A − 2', () => {
    // Defaults: the 10-12 days (UP-001), named.
    expect(days('2026-10-13', '2026-10-12', null)).toEqual({ later: null, tomorrow: null })
    expect(days('2026-10-14', '2026-10-12', null)).toEqual({ later: null, tomorrow: '2026-10-13' })
    expect(days('2026-10-20', '2026-10-12', null)).toEqual({
      later: '2026-10-17',
      tomorrow: '2026-10-19',
    })
    // An override counts from the anchor.
    expect(days('2026-11-01', '2026-10-12', 10)).toEqual({
      later: '2026-10-22',
      tomorrow: '2026-10-31',
    })
    // Lead 1: no Later at all; lead 2: Later on A − 2.
    expect(days('2026-11-01', '2026-10-12', 1)).toEqual({ later: null, tomorrow: '2026-10-31' })
    expect(days('2026-11-01', '2026-10-12', 2)).toEqual({
      later: '2026-10-30',
      tomorrow: '2026-10-31',
    })
    // Longer than the wait: clamped to the day after it was set (Q6)…
    expect(days('2026-10-16', '2026-10-12', 10)).toEqual({
      later: '2026-10-13',
      tomorrow: '2026-10-15',
    })
    // …and none when even that is not two days ahead (wait 2).
    expect(days('2026-10-14', '2026-10-12', 10)).toEqual({ later: null, tomorrow: '2026-10-13' })
    // A short lead on a short wait, and across the DST change (calendar days).
    expect(days('2026-10-15', '2026-10-12', 2)).toEqual({
      later: '2026-10-13',
      tomorrow: '2026-10-14',
    })
    expect(days('2026-11-03', '2026-10-20', 3)).toEqual({
      later: '2026-10-31',
      tomorrow: '2026-11-02',
    })
  })

  test('UP-111: each row carries its section; seeing it in Later does not silence Tomorrow', () => {
    const t = make({ due_at: at('2026-11-01T09:00'), lead_days: 10 })
    setClock('2026-10-21T12:00')
    expect(upcomingRow(t.id)).toBeNull()
    setClock('2026-10-22T12:00')
    expect(upcomingRow(t.id)).toMatchObject({ state: 'waiting', section: 'later' })
    considerTasks(TEST_USER_ID, [t.id])
    expect(upcomingRow(t.id)).toMatchObject({ state: 'considered', section: 'later' })
    // Seen in Later: gone until Tomorrow.
    setClock('2026-10-23T12:00')
    expect(upcomingRow(t.id)).toBeNull()
    setClock('2026-10-30T12:00')
    expect(upcomingRow(t.id)).toBeNull()
    setClock('2026-10-31T12:00')
    expect(upcomingRow(t.id)).toMatchObject({ state: 'waiting', section: 'tomorrow' })
    setClock('2026-11-01T12:00')
    expect(upcomingRow(t.id)).toBeNull()
  })

  test('UP-112: Tomorrow rows come first, then by anchor; a target with a deadline counts its lead from the target', () => {
    // Three targets on Tue Oct 20 (wait 8): Tomorrow on Mon Oct 19.
    const later = make({ due_at: at('2026-10-20T08:00') })
    const lateTomorrow = make({ due_at: at('2026-10-20T23:00') })
    // With a deadline Oct 30 and a lead of 5: Later Oct 15 — 5 days before
    // the TARGET (Oct 20), not the deadline.
    const withDeadline = make({
      due_at: at('2026-10-20T12:00'),
      deadline_at: at('2026-10-30T17:00'),
      lead_days: 5,
    })
    // Wed Oct 21 with a lead of 3: Later on Sun Oct 18, carried over to Mon.
    const farther = make({ due_at: at('2026-10-21T09:00'), lead_days: 3 })
    setClock('2026-10-15T12:00')
    expect(upcomingRow(withDeadline.id)).toMatchObject({ section: 'later' })
    expect(upcomingRow(later.id)).toBeNull()
    setClock('2026-10-19T12:00')
    const seg = getTaskSegments(TEST_USER_ID, tz).find((s) => s.horizon === 'upcoming')!
    expect(seg.tasks.map((r) => [r.task.id, r.section])).toEqual([
      [later.id, 'tomorrow'],
      [withDeadline.id, 'tomorrow'],
      [lateTomorrow.id, 'tomorrow'],
      [farther.id, 'later'],
    ])
  })
})

describe('Upcoming sections: repeat leads and the day roster (2026-10-25)', () => {
  afterAll(() => teardownTestDb())
  beforeEach(() => {
    setClock('2026-10-12T10:00')
    setupTestDb()
  })
  afterEach(() => vi.useRealTimers())

  test('UP-113: a repeat’s lead must be shorter than its rule’s wait — every repeat (400)', () => {
    const weekly = { rrule: 'FREQ=WEEKLY;BYDAY=SU;BYHOUR=12;BYMINUTE=0' }
    expect(() => make({ ...weekly, lead_days: 7 })).toThrow(ValidationError)
    // The words fit a target-anchored repeat with no deadline too.
    expect(() => make({ ...weekly, lead_days: 7 })).toThrow(
      'Lead time (lead_days) must be shorter than the time between occurrences',
    )
    const ok = make({ ...weekly, lead_days: 6 })
    expect(getTaskById(ok.id)!.lead_days).toBe(6)
    expect(() =>
      updateTask({
        userId: TEST_USER_ID,
        userTimezone: tz,
        taskId: ok.id,
        input: { lead_days: 8 },
      }),
    ).toThrow(ValidationError)
    // A rule change judged against the lead it keeps: daily with a lead of 6.
    expect(() =>
      updateTask({
        userId: TEST_USER_ID,
        userTimezone: tz,
        taskId: ok.id,
        input: { rrule: 'FREQ=DAILY;BYHOUR=12;BYMINUTE=0' },
      }),
    ).toThrow(ValidationError)
    // A monthly takes a long lead; a one-off takes any (1–90).
    expect(
      make({ rrule: 'FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0', lead_days: 20 }).lead_days,
    ).toBe(20)
    expect(make({ due_at: at('2026-10-14T09:00'), lead_days: 90 }).lead_days).toBe(90)
    // A deadline-anchored repeat WITH a relative target too (its lead is the
    // Later day ahead of each target now).
    expect(() =>
      make({
        rrule: 'FREQ=WEEKLY;BYDAY=SA;BYHOUR=12;BYMINUTE=0',
        deadline_at: at('2026-10-17T12:00'),
        target_days_before: 1,
        target_time: '18:00',
        lead_days: 7,
      }),
    ).toThrow(ValidationError)
  })

  test('UP-114: a weekly with a lead of 3 — Later Thursday, Tomorrow Saturday, every occurrence', () => {
    setClock('2026-10-11T13:00')
    const t = make({ rrule: 'FREQ=WEEKLY;BYDAY=SU;BYHOUR=12;BYMINUTE=0', lead_days: 3 })
    setClock('2026-10-15T12:00')
    expect(upcomingRow(t.id)).toMatchObject({ section: 'later' })
    setClock('2026-10-17T12:00')
    expect(upcomingRow(t.id)).toMatchObject({ section: 'tomorrow' })
    setClock('2026-10-18T13:00')
    done(t.id)
    setClock('2026-10-22T12:00')
    expect(upcomingRow(t.id)).toMatchObject({ section: 'later' })
  })

  test('UP-115: the day roster remembers the section; a NULL one falls back to the computed one', () => {
    setClock('2026-10-12T10:00')
    const a = make({ due_at: at('2026-10-14T09:00') }) // Tomorrow on Oct 13
    const b = make({ due_at: at('2026-10-20T09:00') }) // wait 8 → Tomorrow Oct 19
    setClock('2026-10-13T12:00')
    expect(upcomingRow(a.id, { handledRows: true })).toMatchObject({ section: 'tomorrow' })
    targetTasksToday(TEST_USER_ID, tz, [a.id])
    // Targeted today: left Upcoming, handled — in the section it was listed in.
    expect(upcomingRow(a.id, { handledRows: true })).toEqual({
      state: 'considered',
      section: 'tomorrow',
      left: 'target',
    })
    const stored = getDb()
      .prepare("SELECT section FROM segment_roster WHERE task_id = ? AND kind = 'upcoming'")
      .get(a.id) as { section: string | null }
    expect(stored.section).toBe('tomorrow')
    // A row remembered before the column (deploy day): NULL → the section
    // computed now from the task — Tomorrow, not the 'later' default.
    setClock('2026-10-19T12:00')
    expect(upcomingRow(b.id, { handledRows: true })).toMatchObject({ section: 'tomorrow' })
    getDb().prepare('UPDATE segment_roster SET section = NULL WHERE task_id = ?').run(b.id)
    markDone({ userId: TEST_USER_ID, userTimezone: tz, taskId: b.id })
    expect(upcomingRow(b.id, { handledRows: true })).toEqual({
      state: 'considered',
      section: 'tomorrow',
      left: 'done',
    })
    // Left Tomorrow via "Today" with a NULL section: its target is now TODAY
    // and `target_set_at` restamped, so the task alone no longer says where it
    // was — the state before the move (today's undo entry) does: Tomorrow.
    const c = make({ due_at: at('2026-10-20T15:00') }) // made Oct 19: wait 1, none
    getDb()
      .prepare('UPDATE tasks SET target_set_at = ? WHERE id = ?')
      .run(at('2026-10-12T10:00'), c.id) // set a week ago: Tomorrow on Oct 19
    expect(upcomingRow(c.id, { handledRows: true })).toMatchObject({ section: 'tomorrow' })
    getDb().prepare('UPDATE segment_roster SET section = NULL WHERE task_id = ?').run(c.id)
    targetTasksToday(TEST_USER_ID, tz, [c.id])
    expect(upcomingRow(c.id, { handledRows: true })).toEqual({
      state: 'considered',
      section: 'tomorrow',
      left: 'target',
    })
  })
})
