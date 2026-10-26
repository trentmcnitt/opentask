/**
 * THE DEADLINES PAGE (2026-10-22; docs/TASK-MODEL.md § The deadlines page;
 * plan-deadlines-page-1022.md, PR A — the server model). `dl-` tests:
 *  - the lead day (`leadFrom`, `leadFor`, `defaultLeadDays`) and the page's
 *    placement (`deadlinePlace`), pure;
 *  - every writer: create, PATCH, bulk edit, done, skip, Remove target (A5),
 *    with the task-queue switch on — and off, where nothing changes (A1);
 *  - `POST /api/task-segments/defer-lead`'s core, `deferLeads`;
 *  - the segment opt-in, its order, `nativeNagOff` (L5) and the Now rule;
 *  - the migration on a synthetic copy of production's shape (plan §6), its
 *    undo fence, idempotence, and the A6 list;
 *  - TM-INV-10 / TM-INV-11, seeded random (plan §10 named them INV-09/10;
 *    TM-INV-09 was already repeat ends).
 */
import { CALENDAR_DAY_START } from '@/lib/opentask-day'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'
import { describe, test, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { DateTime } from 'luxon'

vi.mock('@/core/notifications/dismiss', () => ({
  dismissNotificationsForTasks: vi.fn(),
  syncBadgeCount: vi.fn(),
}))
vi.mock('@/core/webhooks/dispatch', () => ({ dispatchWebhookEvent: vi.fn() }))

import { getDb } from '@/core/db'
import {
  bulkEdit,
  createTask,
  deleteTask,
  markDone,
  markUndone,
  restoreTask,
  updateTask,
} from '@/core/tasks'
import { skipUntil } from '@/core/tasks/skip-until'
import { dispatchWebhookEvent } from '@/core/webhooks/dispatch'
import { migrateDeadlineTargets } from '@/core/db/migrate-deadline-targets'
import { skipOccurrence } from '@/core/tasks/skip'
import { getTaskById } from '@/core/tasks/read'
import { deckTasks } from '@/core/tasks/deck'
import {
  considerTasks,
  deferLeads,
  getTaskSegments,
  targetTasksToday,
} from '@/core/tasks/task-segments'
import { runTaskRollover } from '@/core/tasks/task-rollover'
import { getCurrentlyDueTaskIds } from '@/core/tasks/currently-due'
import { executeUndo } from '@/core/undo'
import { formatTaskResponse } from '@/lib/format-task'
import { isRelevantNow } from '@/lib/now-view'
import {
  LEAD_DAYS_TOO_LONG_MESSAGE,
  deadlineDay,
  deadlinePlace,
  defaultLeadDays,
  leadFor,
  leadFrom,
  openTaskToday,
  shiftDay,
} from '@/lib/task-segments'
import { migrateDeadlineLeads, planDeadlineLeadMigration } from '@/core/db/migrate-deadline-leads'
import { ValidationError } from '@/core/errors'
import type { Task } from '@/types'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

const tz = TEST_TIMEZONE
const u = { userId: TEST_USER_ID, userTimezone: tz }
const ROLLOVER = '06:30'

function at(local: string): string {
  return DateTime.fromISO(local, { zone: tz }).toUTC().toISO()!
}
function setClock(local: string) {
  vi.setSystemTime(new Date(at(local)))
}
function make(input: Record<string, unknown> = {}): Task {
  return createTask({ ...u, input: { title: 'Synthetic task', ...input } })
}
function task(id: number): Task {
  return getTaskById(id)!
}
const ALL = { queuePanels: true, deckRows: true, deadlineRows: true }
function placesOf(id: number, opts: Record<string, boolean> = ALL): string[] {
  return getTaskSegments(TEST_USER_ID, tz, new Date(), opts)
    .filter((s) => s.tasks.some((r) => r.task.id === id))
    .map((s) => s.horizon)
}
function page() {
  return (
    getTaskSegments(TEST_USER_ID, tz, new Date(), ALL).find((s) => s.horizon === 'deadlines')
      ?.tasks ?? []
  )
}
function undoCount(): number {
  return (
    getDb().prepare('SELECT COUNT(*) AS n FROM undo_log WHERE user_id = ?').get(TEST_USER_ID) as {
      n: number
    }
  ).n
}

function setup({ queue = true }: { queue?: boolean } = {}) {
  setupTestDb()
  const db = getDb()
  db.prepare('DELETE FROM time_slots WHERE user_id = ?').run(TEST_USER_ID)
  const insert = db.prepare(
    'INSERT INTO time_slots (user_id, label, start_time, sort_order) VALUES (?, ?, ?, ?)',
  )
  ;[ROLLOVER, '12:00', '20:30'].forEach((s, i) => insert.run(TEST_USER_ID, `Period ${i}`, s, i))
  db.prepare(
    "UPDATE users SET morning_time = '08:30', last_rollover_date = '2026-10-20' WHERE id = ?",
  ).run(TEST_USER_ID)
  if (queue) vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
  setClock('2026-10-20T10:00')
}

function hooks(opts?: { queue?: boolean }) {
  beforeEach(() => setup(opts))
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })
  afterAll(() => teardownTestDb())
}

const NO_SCHEDULE = {
  rrule: null,
  repeat_anchor: null,
  target_days_before: null,
  target_time: null,
}

// ===========================================================================
// DL-L: the lead day (pure)
// ===========================================================================

describe('DL-L: the lead day (pure)', () => {
  const now = new Date(at('2026-10-20T10:00'))
  const lead = { rolloverTime: ROLLOVER, now }
  const oneOff = (deadline: string, lead_days: number | null = null) =>
    leadFor({ ...NO_SCHEDULE, deadline_at: at(deadline), lead_days }, tz, lead)

  test('DL-L01: one-offs — the wait from today, the one lead table, clamped to [today, D−1]', () => {
    expect(oneOff('2026-10-30T23:59')).toBe('2026-10-27') // wait 10 → 3
    expect(oneOff('2026-11-09T23:59')).toBe('2026-11-05') // wait 20 → 4
    expect(oneOff('2026-10-25T23:59')).toBe('2026-10-24') // wait 5 → the day before
    expect(oneOff('2026-10-21T23:59')).toBe('2026-10-20') // wait 1 → lead 0 → D−1, today
    expect(oneOff('2026-10-20T23:59')).toBe('2026-10-20') // D today: D−1 has come → D
    expect(oneOff('2026-10-19T17:00')).toBe('2026-10-19') // passed → D (on the page at once)
    // The deadline's OPENTASK day: Sat 02:00 belongs to Friday (L9).
    expect(oneOff('2026-10-31T02:00')).toBe('2026-10-27')
    expect(deadlineDay(at('2026-10-31T02:00'), tz, ROLLOVER)).toBe('2026-10-30')
    // The override: lead_days, still clamped.
    expect(oneOff('2026-10-30T23:59', 7)).toBe('2026-10-23')
    expect(oneOff('2026-10-25T23:59', 10)).toBe('2026-10-20')
    expect(leadFrom(at('2026-10-30T23:59'), 0, tz, ROLLOVER, now)).toBe('2026-10-29')
  })

  test('DL-L02: a repeat — its rule’s smallest gap (`defaultLeadDays`)', () => {
    const rule = (rrule: string) => ({
      rrule,
      recurrence_mode: 'from_due' as const,
      anchor_time: null,
    })
    const first = at('2026-10-24T08:00')
    expect(defaultLeadDays(rule('FREQ=DAILY;BYHOUR=8;BYMINUTE=0'), first, tz)).toBe(0)
    expect(defaultLeadDays(rule('FREQ=WEEKLY;BYDAY=SA;BYHOUR=8;BYMINUTE=0'), first, tz)).toBe(1)
    expect(
      defaultLeadDays(rule('FREQ=WEEKLY;INTERVAL=2;BYDAY=SA;BYHOUR=8;BYMINUTE=0'), first, tz),
    ).toBe(3)
    expect(defaultLeadDays(rule('FREQ=MONTHLY;BYMONTHDAY=24;BYHOUR=8;BYMINUTE=0'), first, tz)).toBe(
      4,
    )
    // A repeat WITH a relative target has no lead day (ruling 2).
    expect(
      leadFor(
        {
          rrule: 'FREQ=WEEKLY;BYDAY=SA;BYHOUR=8;BYMINUTE=0',
          repeat_anchor: 'deadline',
          target_days_before: 1,
          target_time: '18:00',
          deadline_at: first,
        },
        tz,
        lead,
      ),
    ).toBeNull()
  })

  test('DL-L03: deadlinePlace — window, safety net, quiet before it (rule 3), deck day', () => {
    const base = {
      due_at: null,
      deadline_at: at('2026-10-30T23:59'),
      lead_from: '2026-10-27',
      last_considered_at: null,
      target_set_at: at('2026-10-20T09:00'),
      created_at: at('2026-10-20T09:00'),
    }
    const on = (local: string, over: Record<string, unknown> = {}) =>
      deadlinePlace({ ...base, ...over }, tz, new Date(at(local)), ROLLOVER)
    expect(on('2026-10-25T21:00')).toBeNull()
    // Rule 3 (the Upcoming split, 2026-10-25): the day before the lead day is
    // quiet — no Upcoming heads-up counted to the lead day any more.
    expect(on('2026-10-26T21:00')).toBeNull()
    expect(on('2026-10-27T21:00')).toEqual({
      kind: 'page',
      state: 'waiting',
      safetyNet: false,
      seen: false,
    })
    // Seen on the OpenTask day: considered until the next rollover (A7).
    const seen = { last_considered_at: at('2026-10-27T23:50') }
    expect(on('2026-10-28T00:30', seen)).toMatchObject({ state: 'considered', seen: true })
    expect(on('2026-10-28T07:00', seen)).toMatchObject({ state: 'waiting', seen: false })
    // The safety net from D−1: seen, still waiting.
    const thu = { last_considered_at: at('2026-10-29T09:00') }
    expect(on('2026-10-29T10:00', thu)).toEqual({
      kind: 'page',
      state: 'waiting',
      safetyNet: true,
      seen: true,
    })
    // Past the deadline (A8): still the safety net.
    expect(on('2026-11-02T10:00')).toMatchObject({ kind: 'page', safetyNet: true })
    // The deck day itself, outside the net: the On deck section holds it.
    expect(on('2026-10-28T10:00', { on_deck_day: '2026-10-28' })).toBeNull()
    // In the net the page always shows it.
    expect(on('2026-10-29T10:00', { on_deck_day: '2026-10-29' })).toMatchObject({
      kind: 'page',
    })
    // A future deck before the window: quiet too (rule 3, strict — no deck
    // Upcoming row on a target-less deadline task).
    expect(on('2026-10-22T10:00', { on_deck_day: '2026-10-24' })).toBeNull()
  })
})

// ===========================================================================
// DL-W: the writers
// ===========================================================================

describe('DL-W: every writer, switch on', () => {
  hooks()

  test('DL-W01: create — no automatic target, a lead day; a picked target keeps a dormant one', () => {
    const bare = make({ deadline_at: at('2026-10-30T23:59') })
    expect(task(bare.id)).toMatchObject({
      due_at: null,
      original_due_at: null,
      target_auto: false,
      lead_from: '2026-10-27',
      lead_days: null,
    })
    expect(getCurrentlyDueTaskIds(TEST_USER_ID)).toEqual([])
    const picked = make({ deadline_at: at('2026-10-30T23:59'), due_at: at('2026-10-22T09:00') })
    expect(task(picked.id)).toMatchObject({
      due_at: at('2026-10-22T09:00'),
      target_auto: false,
      lead_from: '2026-10-27',
    })
    const override = make({ deadline_at: at('2026-10-30T23:59'), lead_days: 5 })
    expect(task(override.id)).toMatchObject({ lead_days: 5, lead_from: '2026-10-25' })
    const plain = make()
    expect(task(plain.id).lead_from).toBeNull()
  })

  test('DL-W02: a new deadline-anchored repeat gets NO default target (L1)', () => {
    const t = make({
      rrule: 'FREQ=WEEKLY;BYDAY=SA;BYHOUR=8;BYMINUTE=0',
      deadline_at: at('2026-10-24T08:00'),
    })
    expect(task(t.id)).toMatchObject({
      repeat_anchor: 'deadline',
      target_days_before: null,
      target_time: null,
      due_at: null,
      occurrence_at: at('2026-10-24T08:00'),
      lead_from: '2026-10-23',
    })
    // Offsets sent are a real target, as ever (no lead day).
    const withTarget = make({
      rrule: 'FREQ=WEEKLY;BYDAY=SA;BYHOUR=8;BYMINUTE=0',
      deadline_at: at('2026-10-24T08:00'),
      target_days_before: 1,
      target_time: '18:00',
    })
    expect(task(withTarget.id)).toMatchObject({
      due_at: at('2026-10-23T18:00'),
      lead_from: null,
    })
    // A target picked on one occurrence of a target-less repeat is a pick,
    // not the series' offsets.
    updateTask({ ...u, taskId: t.id, input: { due_at: at('2026-10-22T15:00') } })
    expect(task(t.id)).toMatchObject({
      due_at: at('2026-10-22T15:00'),
      target_days_before: null,
      target_time: null,
    })
  })

  test('DL-W03: PATCH — a deadline change re-derives the lead day (a deferral is dropped)', () => {
    const t = make({ deadline_at: at('2026-10-30T23:59') })
    deferLeads(TEST_USER_ID, tz, [t.id], '2026-10-28')
    expect(task(t.id).lead_from).toBe('2026-10-28')
    // A title edit keeps the deferral.
    updateTask({ ...u, taskId: t.id, input: { title: 'Renamed' } })
    expect(task(t.id).lead_from).toBe('2026-10-28')
    updateTask({ ...u, taskId: t.id, input: { deadline_at: at('2026-11-09T23:59') } })
    expect(task(t.id)).toMatchObject({ lead_from: '2026-11-05', due_at: null, target_auto: false })
    // The override re-derives it too.
    updateTask({ ...u, taskId: t.id, input: { lead_days: 2 } })
    expect(task(t.id)).toMatchObject({ lead_days: 2, lead_from: '2026-11-07' })
    // Bulk edit writes it as well.
    bulkEdit({ ...u, taskIds: [t.id], changes: { lead_days: null } })
    expect(task(t.id)).toMatchObject({ lead_days: null, lead_from: '2026-11-05' })
    // The deadline removed: no lead day.
    updateTask({ ...u, taskId: t.id, input: { deadline_at: null } })
    expect(task(t.id)).toMatchObject({ lead_from: null, due_at: null })
    // Undo walks it back.
    executeUndo(TEST_USER_ID)
    expect(task(t.id).lead_from).toBe('2026-11-05')
  })

  test('DL-W04: Remove target on a deadline one-off is real — the page holds it, not an auto target', () => {
    const t = make({ deadline_at: at('2026-10-23T23:59'), due_at: at('2026-10-21T09:00') })
    expect(task(t.id).lead_from).toBe('2026-10-22') // wait 3 → the day before
    updateTask({ ...u, taskId: t.id, input: { due_at: null } })
    expect(task(t.id)).toMatchObject({ due_at: null, target_auto: false, lead_from: '2026-10-22' })
    expect(getCurrentlyDueTaskIds(TEST_USER_ID)).toEqual([])
    // Quiet until its lead day Thu (rule 3, 2026-10-25: no Upcoming
    // heads-up before it), then the page.
    expect(placesOf(t.id)).toEqual([])
    setClock('2026-10-21T10:00')
    expect(placesOf(t.id)).toEqual([])
    setClock('2026-10-22T10:00')
    expect(placesOf(t.id)).toEqual(['deadlines'])
  })

  test('DL-W05: A5 — target_at null on ONE occurrence of a repeat with a relative target', () => {
    const t = make({
      rrule: 'FREQ=WEEKLY;BYDAY=SA;BYHOUR=12;BYMINUTE=0',
      deadline_at: at('2026-10-24T12:00'),
      target_days_before: 1,
      target_time: '18:00',
    })
    updateTask({ ...u, taskId: t.id, input: { due_at: null } })
    expect(task(t.id)).toMatchObject({
      due_at: null,
      target_days_before: 1,
      target_time: '18:00',
      lead_from: '2026-10-20',
    })
    expect(placesOf(t.id)).toEqual(['deadlines'])
    // Decking an offset repeat drops its target too, but it is no Remove
    // target: no lead day, and not on the page while the deck is ahead.
    const decked = make({
      rrule: 'FREQ=WEEKLY;BYDAY=SA;BYHOUR=12;BYMINUTE=0',
      deadline_at: at('2026-10-31T12:00'),
      target_days_before: 1,
      target_time: '18:00',
    })
    deckTasks({ userId: TEST_USER_ID, timezone: tz, ids: [decked.id], day: '2026-10-22' })
    expect(task(decked.id)).toMatchObject({
      on_deck_day: '2026-10-22',
      due_at: null,
      lead_from: null,
    })
    expect(placesOf(decked.id)).not.toContain('deadlines')
    // The next advance gives the next occurrence its derived target again.
    markDone({ ...u, taskId: t.id })
    expect(task(t.id)).toMatchObject({ due_at: at('2026-10-30T18:00'), lead_from: null })
  })

  test('DL-W06: done and skip of a target-less repeat re-derive the lead day', () => {
    const t = make({
      rrule: 'FREQ=WEEKLY;BYDAY=SA;BYHOUR=8;BYMINUTE=0',
      deadline_at: at('2026-10-31T08:00'),
    })
    expect(task(t.id).lead_from).toBe('2026-10-30')
    skipOccurrence({ ...u, taskId: t.id })
    expect(task(t.id)).toMatchObject({
      deadline_at: at('2026-11-07T08:00'),
      due_at: null,
      lead_from: '2026-11-06',
    })
    markDone({ ...u, taskId: t.id })
    expect(task(t.id)).toMatchObject({
      deadline_at: at('2026-11-14T08:00'),
      lead_from: '2026-11-13',
    })
    executeUndo(TEST_USER_ID)
    expect(task(t.id)).toMatchObject({
      deadline_at: at('2026-11-07T08:00'),
      lead_from: '2026-11-06',
    })
  })

  test('DL-W07: Today on a page row targets it — off the page, over target', () => {
    const t = make({ deadline_at: at('2026-10-21T23:59') })
    expect(placesOf(t.id)).toEqual(['deadlines'])
    targetTasksToday(TEST_USER_ID, tz, [t.id], at('2026-10-20T11:00'))
    setClock('2026-10-20T12:00')
    expect(placesOf(t.id)).toEqual([])
    expect(getCurrentlyDueTaskIds(TEST_USER_ID)).toEqual([t.id])
  })
})

describe('DL-W: switch off — the old automatic target, unchanged (A1)', () => {
  hooks({ queue: false })

  test('DL-W10: create and Remove target still write the automatic target', () => {
    const t = make({ deadline_at: at('2026-10-30T23:59') })
    expect(task(t.id)).toMatchObject({
      due_at: at('2026-10-27T08:30'),
      target_auto: true,
      lead_from: '2026-10-27',
    })
    const r = make({
      rrule: 'FREQ=WEEKLY;BYDAY=SA;BYHOUR=8;BYMINUTE=0',
      deadline_at: at('2026-10-24T08:00'),
    })
    expect(task(r.id)).toMatchObject({ target_days_before: 1, target_time: '08:30' })
    expect(placesOf(t.id)).not.toContain('deadlines')
    expect(() => deferLeads(TEST_USER_ID, tz, [t.id])).toThrow(
      expect.objectContaining({ statusCode: 409 }),
    )
  })
})

// ===========================================================================
// DL-D: Defer (POST /api/task-segments/defer-lead)
// ===========================================================================

describe('DL-D: defer-lead', () => {
  hooks()

  test('DL-D01: the answer, the default day, one undo entry, per-task refusals', () => {
    // On the page today (lead_days 10 clamps the lead day to today).
    const a = make({ deadline_at: at('2026-10-30T23:59'), lead_days: 10 })
    const b = make({ deadline_at: at('2026-10-31T23:59'), lead_days: 20 })
    const close = make({ deadline_at: at('2026-10-21T23:59') }) // the net already
    const targeted = make({ deadline_at: at('2026-10-30T23:59'), due_at: at('2026-10-22T09:00') })
    const before = undoCount()
    const r = deferLeads(TEST_USER_ID, tz, [a.id, b.id, close.id, targeted.id])
    expect(r).toEqual({
      day: '2026-10-21',
      deferred: 2,
      refused: [
        {
          id: close.id,
          reason: 'safety_net',
          message: 'The deadline is close: only a target or done takes it off the deadlines page',
        },
        {
          id: targeted.id,
          reason: 'not_on_page',
          message: 'Only a deadline task with no target is on the deadlines page',
        },
      ],
      summary: 'Deferred 2 tasks to Wed Oct 21',
    })
    expect(undoCount()).toBe(before + 1)
    expect([task(a.id).lead_from, task(b.id).lead_from]).toEqual(['2026-10-21', '2026-10-21'])
    executeUndo(TEST_USER_ID)
    expect([task(a.id).lead_from, task(b.id).lead_from]).toEqual(['2026-10-20', '2026-10-20'])
  })

  test('DL-D03: a deferred row counts as handled in the day roster ("· deferred to Wed")', () => {
    // Its lead day is today (lead_days 10 clamps to today), outside the net.
    const t = make({ deadline_at: at('2026-10-30T23:59'), lead_days: 10 })
    const other = make({ deadline_at: at('2026-10-30T23:59'), lead_days: 10 })
    const read = () =>
      getTaskSegments(TEST_USER_ID, tz, new Date(), { ...ALL, handledRows: true }).find(
        (s) => s.horizon === 'deadlines',
      )!
    expect(read().tasks.map((r) => r.task.id)).toEqual([t.id, other.id]) // remembered
    deferLeads(TEST_USER_ID, tz, [t.id], '2026-10-21')
    const page = read()
    // Still in M, now in N: a considered row that left deferred.
    expect(page.tasks.map((r) => [r.task.id, r.state, r.left ?? null])).toEqual([
      [t.id, 'considered', 'deferred'],
      [other.id, 'waiting', null],
    ])
    expect([page.considered, page.waiting]).toEqual([1, 1])
    expect(task(t.id).lead_from).toBe('2026-10-21')
    // Without the roster (a native build): simply off the page.
    expect(placesOf(t.id)).toEqual([])
  })

  test('DL-D02: from tomorrow to D−2; nothing moved → no undo entry', () => {
    const t = make({ deadline_at: at('2026-10-30T23:59') })
    const before = undoCount()
    for (const [day, reason] of [
      ['2026-10-20', 'not_later'],
      ['2026-10-29', 'after_safety_net'],
    ]) {
      const r = deferLeads(TEST_USER_ID, tz, [t.id], day)
      expect(r.refused.map((x) => x.reason)).toEqual([reason])
    }
    expect(undoCount()).toBe(before)
    expect(deferLeads(TEST_USER_ID, tz, [t.id], '2026-10-28').deferred).toBe(1)
    expect(() => deferLeads(TEST_USER_ID, tz, [t.id], 'friday')).toThrow(ValidationError)
    expect(() => deferLeads(TEST_USER_ID, tz, [99999])).toThrow(ValidationError)
  })
})

// ===========================================================================
// DL-S: the segment, the opt-in, the order; nativeNagOff; Now
// ===========================================================================

describe('DL-S: the page', () => {
  hooks()

  test('DL-S01: opt-in — without ?deadlines=1 a target-less one-off is in its horizon segment', () => {
    const t = make({ deadline_at: at('2026-10-21T23:59') })
    expect(placesOf(t.id)).toEqual(['deadlines'])
    // A shipped native build: the deadline pulls it into Days, a dated degrade.
    expect(placesOf(t.id, { queuePanels: true, deckRows: true })).toEqual(['days'])
    vi.stubEnv('OPENTASK_TASK_QUEUE', '')
    expect(placesOf(t.id)).not.toContain('deadlines')
  })

  test('DL-S02: first in the order; priority, then the nearest deadline, then id (A4)', () => {
    const lowNear = make({ deadline_at: at('2026-10-21T23:59') })
    const highFar = make({ deadline_at: at('2026-10-21T23:59'), priority: 3 })
    const highNear = make({ deadline_at: at('2026-10-21T20:00'), priority: 3 })
    const lowSame = make({ deadline_at: at('2026-10-21T23:59') })
    make({ due_at: at('2026-10-24T09:00') }) // something in Upcoming too
    const segs = getTaskSegments(TEST_USER_ID, tz, new Date(), ALL)
    expect(segs[0].horizon).toBe('deadlines')
    expect(segs[0].tasks.map((r) => r.task.id)).toEqual([
      highNear.id,
      highFar.id,
      lowNear.id,
      lowSame.id,
    ])
    considerTasks(TEST_USER_ID, [lowNear.id])
    expect(page().find((r) => r.task.id === lowNear.id)).toMatchObject({
      state: 'waiting',
      safetyNet: true,
      seen: true,
    })
  })

  test('DL-S03: nativeNagOff (L5) — a target-less deadline one-off reads nag-off to old builds', () => {
    const t = make({ deadline_at: at('2026-10-30T23:59') })
    expect(formatTaskResponse(task(t.id), tz).deadline_nag_off).toBe(true)
    const picked = make({ deadline_at: at('2026-10-30T23:59'), due_at: at('2026-10-22T09:00') })
    expect(formatTaskResponse(task(picked.id), tz).deadline_nag_off).toBe(false)
  })

  test('DL-S04: Now — a target-less deadline task is relevant only in its safety net', () => {
    const t = make({ deadline_at: at('2026-10-30T23:59'), priority: 4 })
    const opts = { queue: true, dayStart: ROLLOVER }
    expect(isRelevantNow(task(t.id), tz, new Date(), opts)).toBe(false)
    expect(isRelevantNow(task(t.id), tz, new Date(at('2026-10-29T10:00')), opts)).toBe(true)
    expect(isRelevantNow(task(t.id), tz, new Date(at('2026-11-01T10:00')), opts)).toBe(true)
    // Queue off (the web's flag): undated Urgent, relevant as before.
    expect(isRelevantNow(task(t.id), tz, new Date(), { dayStart: CALENDAR_DAY_START })).toBe(true)
  })

  test('DL-S05: the rollover never touches a page row; a deadline deck is cleared, never queued', () => {
    const t = make({ deadline_at: at('2026-10-30T23:59') })
    deckTasks({ userId: TEST_USER_ID, timezone: tz, ids: [t.id], day: '2026-10-20' })
    setClock('2026-10-21T06:30')
    runTaskRollover({ now: new Date(at('2026-10-21T06:30')), userId: TEST_USER_ID })
    expect(task(t.id)).toMatchObject({
      on_deck_day: null,
      queued_at: null,
      due_at: null,
      lead_from: '2026-10-27',
    })
  })

  test('DL-S06: a deck keeps a page row on the page, WAITING with its deck day — never stamped considered (Trent, 10-22)', () => {
    // On the page today (a 20-day lead clamps to today), outside the net.
    const later = make({ deadline_at: at('2026-10-30T23:59'), lead_days: 20 })
    expect(task(later.id).lead_from).toBe('2026-10-20')
    deckTasks({ userId: TEST_USER_ID, timezone: tz, ids: [later.id], day: '2026-10-24' })
    expect(task(later.id)).toMatchObject({ on_deck_day: '2026-10-24', last_considered_at: null })
    const row = page().find((r) => r.task.id === later.id)!
    expect(row).toMatchObject({ state: 'waiting', seen: false })
    // The same through PATCH (the Quick panel's deck).
    const patched = make({ deadline_at: at('2026-10-30T23:59'), lead_days: 20 })
    updateTask({ ...u, taskId: patched.id, input: { on_deck_day: '2026-10-23' } })
    expect(task(patched.id).last_considered_at).toBeNull()
    expect(page().find((r) => r.task.id === patched.id)?.state).toBe('waiting')
    // In the safety net a deck for today stays on the page too, unseen.
    const net = make({ deadline_at: at('2026-10-21T17:00') })
    deckTasks({ userId: TEST_USER_ID, timezone: tz, ids: [net.id] })
    expect(task(net.id).last_considered_at).toBeNull()
    expect(page().find((r) => r.task.id === net.id)).toMatchObject({
      state: 'waiting',
      safetyNet: true,
      seen: false,
    })
    // Seeing it is still its own tap.
    considerTasks(TEST_USER_ID, [later.id])
    expect(page().find((r) => r.task.id === later.id)?.state).toBe('considered')
  })

  test('DL-S07: a deck for today outside the net is the On deck section’s, and stamps considered as before', () => {
    const t = make({ deadline_at: at('2026-10-30T23:59'), lead_days: 20 })
    deckTasks({ userId: TEST_USER_ID, timezone: tz, ids: [t.id] })
    expect(task(t.id).last_considered_at).not.toBeNull()
    expect(page().some((r) => r.task.id === t.id)).toBe(false)
    // A plain task's deck stamps it as ever (A7).
    const plain = make({ horizon: 'days' })
    deckTasks({ userId: TEST_USER_ID, timezone: tz, ids: [plain.id], day: '2026-10-22' })
    expect(task(plain.id).last_considered_at).not.toBeNull()
  })
})

// ===========================================================================
// DL-M: the migration (plan §6) on a synthetic copy of production's shape
// ===========================================================================

describe('DL-M: migrateDeadlineLeads', () => {
  hooks({ queue: false })

  test('DL-M01: production’s shape — 1 auto-target one-off among 8 open deadline tasks — counts, writes, fence, idempotence, A6', () => {
    // Built with the switch OFF, as production was: automatic targets, and
    // default repeat offsets.
    setClock('2026-10-12T10:00')
    const auto = make({ deadline_at: at('2026-10-30T23:59') }) // auto Mon Oct 26 08:30
    const picked = [
      make({ deadline_at: at('2026-10-30T23:59'), due_at: at('2026-10-21T09:00') }),
      make({ deadline_at: at('2026-11-20T23:59'), due_at: at('2026-11-02T09:00') }),
      make({ deadline_at: at('2026-10-25T17:00'), due_at: at('2026-10-24T09:00') }),
      make({ deadline_at: at('2026-10-15T17:00'), due_at: at('2026-10-22T09:00') }), // past deadline
    ]
    const defaulted = make({
      rrule: 'FREQ=WEEKLY;BYDAY=SA;BYHOUR=8;BYMINUTE=0',
      deadline_at: at('2026-10-24T08:00'),
    })
    const chosen = make({
      rrule: 'FREQ=WEEKLY;BYDAY=SA;BYHOUR=12;BYMINUTE=0',
      deadline_at: at('2026-10-24T12:00'),
      target_days_before: 1,
      target_time: '18:00',
    })
    const closed = make({ deadline_at: at('2026-10-29T23:59') })
    markDone({ ...u, taskId: closed.id })
    // Back to auto, then picked again: two undo entries hold `target_auto`.
    const rePicked = make({ deadline_at: at('2026-11-30T23:59'), due_at: at('2026-11-10T09:00') })
    updateTask({ ...u, taskId: rePicked.id, input: { due_at: null } })
    expect(task(rePicked.id).target_auto).toBe(true)
    updateTask({ ...u, taskId: rePicked.id, input: { due_at: at('2026-11-12T09:00') } })
    expect(task(rePicked.id).target_auto).toBe(false)
    // Decided Mon Oct 12: wait 18 → 4 days before → Mon Oct 26 08:30.
    expect(task(auto.id)).toMatchObject({ target_auto: true, due_at: at('2026-10-26T08:30') })
    // Production has no lead_from yet: the column is new.
    getDb().prepare('UPDATE tasks SET lead_from = NULL').run()

    setClock('2026-10-22T10:00')
    const plan = planDeadlineLeadMigration(getDb())
    expect(plan.autoToLead).toEqual([auto.id])
    expect(plan.oneOffLead).toEqual([...picked.map((t) => t.id), rePicked.id])
    expect(plan.repeatLead).toEqual([])
    expect(plan.closedAuto).toEqual([closed.id])
    expect(plan.undoTaskIdsWithAuto).toEqual([rePicked.id])
    expect(plan.undoEntriesWithAuto).toBe(2)
    expect(plan.repeatOffsets.map((r) => [r.id, r.matchesDefault])).toEqual([
      [defaulted.id, true],
      [chosen.id, false],
    ])

    vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
    const counts = migrateDeadlineLeads(getDb())
    expect(counts).toMatchObject({ autoToLead: 1, oneOffLead: 5, repeatLead: 0 })
    expect(task(auto.id)).toMatchObject({
      due_at: null,
      original_due_at: null,
      target_auto: false,
      lead_from: '2026-10-26',
    })
    expect(task(picked[0].id)).toMatchObject({
      due_at: at('2026-10-21T09:00'),
      lead_from: '2026-10-27',
    })
    expect(task(picked[3].id)).toMatchObject({
      due_at: at('2026-10-15T17:00'), // capped at create, the deadline then ahead
      lead_from: '2026-10-15',
    })
    // A6: offsets kept exactly as they are.
    expect(task(defaulted.id)).toMatchObject({ target_days_before: 1, target_time: '08:30' })
    expect(task(defaulted.id).lead_from).toBeNull()
    // The fence: every touched row, the closed auto row, every undo-held one.
    for (const id of [auto.id, closed.id, rePicked.id, ...picked.map((t) => t.id)]) {
      expect(task(id).rolled_over_at, `fence ${id}`).toBe(at('2026-10-22T10:00'))
    }
    // Undo of the re-pick no longer brings the automatic target back: the
    // entry is from before the fence, so its snapshot of the task is skipped.
    executeUndo(TEST_USER_ID)
    expect(task(rePicked.id)).toMatchObject({ due_at: at('2026-11-12T09:00'), target_auto: false })
    expect(planDeadlineLeadMigration(getDb())).toMatchObject({
      autoToLead: [],
      oneOffLead: [],
      repeatLead: [],
    })
    // Idempotent: a second start writes nothing and fences nothing new.
    setClock('2026-10-23T10:00')
    expect(migrateDeadlineLeads(getDb())).toEqual({
      autoToLead: 0,
      oneOffLead: 0,
      repeatLead: 0,
      unqueued: 0,
      fenced: 0,
    })
    expect(task(auto.id).rolled_over_at).toBe(at('2026-10-22T10:00'))
    // On the page from its old auto day.
    setClock('2026-10-26T10:00')
    expect(placesOf(auto.id)).toEqual(['deadlines'])
  })

  test('DL-M03: the dry run reads a copy from BEFORE this build (no lead columns)', () => {
    setClock('2026-10-12T10:00')
    const auto = make({ deadline_at: at('2026-10-30T23:59') })
    const offsets = make({
      rrule: 'FREQ=WEEKLY;BYDAY=SA;BYHOUR=8;BYMINUTE=0',
      deadline_at: at('2026-10-24T08:00'),
    })
    const file = path.join(os.tmpdir(), `dl-m03-${process.pid}.db`)
    fs.rmSync(file, { force: true })
    getDb().exec(`VACUUM INTO '${file}'`)
    const copy = new Database(file)
    try {
      copy.exec('ALTER TABLE tasks DROP COLUMN lead_from')
      copy.exec('ALTER TABLE tasks DROP COLUMN lead_days')
      const plan = planDeadlineLeadMigration(copy)
      expect(plan.autoToLead).toEqual([auto.id])
      expect(plan.repeatOffsets.map((r) => [r.id, r.matchesDefault])).toEqual([[offsets.id, true]])
    } finally {
      copy.close()
      fs.rmSync(file, { force: true })
    }
  })

  test('DL-M02: the attempts of an arrived automatic target are checkpointed, then frozen', () => {
    setClock('2026-10-19T10:00')
    const t = make({ deadline_at: at('2026-10-21T23:59') }) // auto: the day before, Tue 08:30
    getDb().prepare('UPDATE tasks SET lead_from = NULL').run()
    setClock('2026-10-21T10:00') // over target since Tue: 2 attempts (Tue, Wed)
    vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
    migrateDeadlineLeads(getDb())
    expect(task(t.id)).toMatchObject({ due_at: null, attempts: 2, lead_from: '2026-10-20' })
    expect(placesOf(t.id)).toEqual(['deadlines'])
  })
})

// ===========================================================================
// DL-F: the fresh-eyes review's fixes (2026-10-22)
// ===========================================================================

describe('DL-F: review fixes', () => {
  hooks()
  const weekly = (deadline: string, extra: Record<string, unknown> = {}) =>
    make({ rrule: 'FREQ=WEEKLY;BYDAY=SA;BYHOUR=8;BYMINUTE=0', deadline_at: at(deadline), ...extra })

  test('DL-F01: Skip until leaves a target-less repeat already after the date; a deck before it goes', () => {
    const monthly = make({
      rrule: 'FREQ=MONTHLY;BYMONTHDAY=30;BYHOUR=17;BYMINUTE=0',
      deadline_at: at('2026-11-30T17:00'),
    })
    const r = skipUntil({ ...u, taskIds: [monthly.id], until: '2026-11-10' })
    expect(r.alreadyClear).toBe(1)
    expect(task(monthly.id)).toMatchObject({ occurrence_at: at('2026-11-30T17:00'), skip_count: 0 })
    // Decked before the date: the deck goes, and no target comes back (none to).
    const w = weekly('2026-10-24T08:00')
    deckTasks({ userId: TEST_USER_ID, timezone: tz, ids: [w.id], day: '2026-10-21' })
    skipUntil({ ...u, taskIds: [w.id], until: '2026-10-23' })
    expect(task(w.id)).toMatchObject({ on_deck_day: null, due_at: null, skip_count: 0 })
    executeUndo(TEST_USER_ID)
    expect(task(w.id).on_deck_day).toBe('2026-10-21')
  })

  test('DL-F02: without ?deadlines=1 a target-less repeat is in its horizon segment, never nowhere', () => {
    const w = weekly('2026-10-24T08:00')
    const plain = { queuePanels: true, deckRows: true }
    expect(placesOf(w.id, plain)).toEqual(['days'])
    setClock('2026-10-24T10:00')
    expect(placesOf(w.id, plain)).toEqual(['days'])
    expect(placesOf(w.id)).toEqual(['deadlines'])
  })

  test('DL-F03: the roster never sends a `deadlines` kind to a caller without the opt-in', () => {
    const t = make({ deadline_at: at('2026-10-30T23:59'), lead_days: 10 })
    const handled = { queuePanels: true, deckRows: true, handledRows: true }
    getTaskSegments(TEST_USER_ID, tz, new Date(), { ...handled, deadlineRows: true })
    deferLeads(TEST_USER_ID, tz, [t.id], '2026-10-23')
    const kinds = getTaskSegments(TEST_USER_ID, tz, new Date(), handled).map((s) => s.horizon)
    expect(kinds).not.toContain('deadlines')
  })

  test('DL-F04: "deferred" comes only from a Defer — a deadline change is not one', () => {
    const t = make({ deadline_at: at('2026-10-30T23:59'), lead_days: 10 })
    const read = () =>
      getTaskSegments(TEST_USER_ID, tz, new Date(), { ...ALL, handledRows: true }).find(
        (s) => s.horizon === 'deadlines',
      )
    read()
    // A deadline moved out: off the page, unhandled — out of M, not "deferred".
    updateTask({
      ...u,
      taskId: t.id,
      input: { deadline_at: at('2026-12-30T23:59'), lead_days: null },
    })
    expect(read()).toBeUndefined()
  })

  test('DL-F05: a lead_days override must be shorter than the rule’s wait (a 400)', () => {
    expect(() => weekly('2026-10-31T08:00', { lead_days: 7 })).toThrow(LEAD_DAYS_TOO_LONG_MESSAGE)
    const w = weekly('2026-10-31T08:00', { lead_days: 6 })
    expect(task(w.id).lead_days).toBe(6)
    expect(() => updateTask({ ...u, taskId: w.id, input: { lead_days: 10 } })).toThrow(
      LEAD_DAYS_TOO_LONG_MESSAGE,
    )
    // A one-off has no rule: any override 1–90.
    expect(make({ deadline_at: at('2026-10-30T23:59'), lead_days: 30 }).lead_days).toBe(30)
  })

  test('DL-F06: defer — later than the current lead day; activity and a webhook', () => {
    const t = make({ deadline_at: at('2026-10-30T23:59') }) // lead day Tue Oct 27
    expect(deferLeads(TEST_USER_ID, tz, [t.id], '2026-10-26').refused[0].reason).toBe('not_later')
    vi.mocked(dispatchWebhookEvent).mockClear()
    expect(deferLeads(TEST_USER_ID, tz, [t.id], '2026-10-28').deferred).toBe(1)
    expect(vi.mocked(dispatchWebhookEvent).mock.calls.map((c) => c[1])).toEqual(['task.updated'])
    const activity = getDb()
      .prepare('SELECT action, fields FROM activity_log WHERE task_id = ? ORDER BY id DESC LIMIT 1')
      .get(t.id) as { action: string; fields: string }
    expect(activity.action).toBe('edit')
    expect(JSON.parse(activity.fields)).toEqual(['lead_from', 'target_set_at'])
  })

  test('DL-F07: a row with no stored lead day reads the derived one', () => {
    // lead_days 10: the derived lead day is always today (clamped), outside the net.
    const t = make({ deadline_at: at('2026-10-30T23:59'), lead_days: 10 })
    getDb().prepare('UPDATE tasks SET lead_from = NULL WHERE id = ?').run(t.id)
    expect(deadlinePlace(task(t.id), tz, new Date(at('2026-10-22T10:00')), ROLLOVER)).toMatchObject(
      {
        kind: 'page',
        safetyNet: false,
      },
    )
    expect(placesOf(t.id)).toEqual(['deadlines'])
  })
})

describe('DL-F: migration and rollback (switch off at build time)', () => {
  hooks({ queue: false })

  test('DL-F08: queued auto-target and target-less deadline one-offs are unqueued and counted', () => {
    const queuedAuto = make({ deadline_at: at('2026-10-30T17:00') })
    const queuedBare = make({ deadline_at: at('2026-10-31T17:00') })
    const db = getDb()
    db.prepare(
      "UPDATE tasks SET queued_at = ?, queued_from_deck_day = '2026-10-19' WHERE id = ?",
    ).run(at('2026-10-20T06:30'), queuedAuto.id)
    db.prepare(
      'UPDATE tasks SET due_at = NULL, target_auto = 0, queued_at = ?, try_tomorrow = 1 WHERE id = ?',
    ).run(at('2026-10-20T06:30'), queuedBare.id)
    expect(planDeadlineLeadMigration(db).unqueued).toEqual([queuedAuto.id, queuedBare.id])
    vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
    expect(migrateDeadlineLeads(db)).toMatchObject({ autoToLead: 1, unqueued: 2 })
    for (const id of [queuedAuto.id, queuedBare.id]) {
      expect(task(id)).toMatchObject({ queued_at: null, try_tomorrow: false, due_at: null })
    }
    setClock('2026-10-29T10:00')
    expect(placesOf(queuedAuto.id)).toEqual(['deadlines'])
  })

  test('DL-F09: a done or trashed auto-target task is converted when reopened or restored; later starts fence only what they write', () => {
    const doneAuto = make({ deadline_at: at('2026-10-24T17:00') })
    markDone({ ...u, taskId: doneAuto.id })
    const trashedAuto = make({ deadline_at: at('2026-10-25T17:00') })
    deleteTask({ userId: TEST_USER_ID, taskId: trashedAuto.id })
    const openAuto = make({ deadline_at: at('2026-10-30T17:00') })
    vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
    const db = getDb()
    migrateDeadlineLeads(db) // the first start: converts openAuto, fences the closed ones too
    const fencedAt = task(doneAuto.id).rolled_over_at
    expect(fencedAt).toBe(at('2026-10-20T10:00'))

    setClock('2026-10-21T10:00')
    markUndone({ ...u, taskId: doneAuto.id })
    expect(task(doneAuto.id)).toMatchObject({ done: false, due_at: null, target_auto: false })
    expect(task(doneAuto.id).lead_from).toBe('2026-10-23')
    restoreTask({ userId: TEST_USER_ID, taskId: trashedAuto.id })
    expect(task(trashedAuto.id)).toMatchObject({ due_at: null, target_auto: false })
    expect(task(trashedAuto.id).lead_from).not.toBeNull()
    // The restore's undo would put the automatic target back (its before is
    // `target_auto: true`): with the switch on it is applied WITHOUT it
    // (2026-10-24, `auto-target-fence.ts` — nothing writes target_auto = 1):
    // the task goes back to the trash with no target, and the lead day its
    // before lacked is derived. Until 10-24 it went back whole.
    executeUndo(TEST_USER_ID)
    const undone = task(trashedAuto.id)
    expect(undone.deleted_at).not.toBeNull()
    expect(undone).toMatchObject({ due_at: null, original_due_at: null, target_auto: false })
    expect(undone.lead_from).not.toBeNull()

    // A later start writes a row with no lead day: it fences that row only.
    const late = make({ deadline_at: at('2026-11-30T17:00') })
    db.prepare('UPDATE tasks SET lead_from = NULL WHERE id = ?').run(late.id)
    setClock('2026-10-22T10:00')
    expect(migrateDeadlineLeads(db)).toMatchObject({ autoToLead: 0, oneOffLead: 1, fenced: 1 })
    expect(task(late.id).rolled_over_at).toBe(at('2026-10-22T10:00'))
    expect(task(openAuto.id).rolled_over_at).toBe(at('2026-10-20T10:00'))
  })

  test('DL-F10: switch off — a target-less deadline repeat gets the default offsets back at start', () => {
    vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
    const w = make({
      rrule: 'FREQ=WEEKLY;BYDAY=SA;BYHOUR=8;BYMINUTE=0',
      deadline_at: at('2026-10-24T08:00'),
    })
    expect(task(w.id)).toMatchObject({ target_days_before: null, due_at: null })
    vi.stubEnv('OPENTASK_TASK_QUEUE', '')
    const counts = migrateDeadlineTargets(getDb(), new Date(), { leads: false })
    expect(counts.targetlessRepeatToDefault).toBe(1)
    // The old default: weekly → the day before, at the morning.
    expect(task(w.id)).toMatchObject({
      target_days_before: 1,
      target_time: '08:30',
      due_at: at('2026-10-23T08:30'),
    })
    // With the switch on, the step leaves them alone.
    expect(
      migrateDeadlineTargets(getDb(), new Date(), { leads: true }).targetlessRepeatToDefault,
    ).toBe(0)
  })
})

// ===========================================================================
// TM-INV-10 / TM-INV-11 (seeded random)
// ===========================================================================

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** One random write on a task (TM-INV-10/11): a refusal (400) is part of the contract. */
function randomWrite(id: number, r: () => number, clock: DateTime): void {
  const t = task(id)
  if (t.done || t.archived_at || r() < 0.6) return
  const op = Math.floor(r() * 8)
  const day = (from: number, span: number) =>
    clock.plus({ days: from + Math.floor(r() * span) }).toISODate()!
  const writes: (() => unknown)[] = [
    () => considerTasks(TEST_USER_ID, [id]),
    () => deferLeads(TEST_USER_ID, tz, [id], day(1, 4)),
    () => deckTasks({ userId: TEST_USER_ID, timezone: tz, ids: [id], day: day(0, 4) }),
    () => targetTasksToday(TEST_USER_ID, tz, [id], clock.plus({ hours: 2 }).toUTC().toISO()!),
    () => t.rrule || updateTask({ ...u, taskId: id, input: { due_at: null } }),
    () =>
      t.rrule ||
      updateTask({
        ...u,
        taskId: id,
        input: {
          deadline_at: clock
            .plus({ days: Math.floor(r() * 12) - 2, hours: 5 })
            .toUTC()
            .toISO()!,
        },
      }),
    () => markDone({ ...u, taskId: id }),
    () => undefined,
  ]
  try {
    writes[op]()
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err
  }
}

/** Read one tick and check TM-INV-10 and TM-INV-11 for every task. */
function checkTick(ids: number[], clock: DateTime, at: string): { checks: number; onPage: number } {
  const now = clock.toJSDate()
  const segs = getTaskSegments(TEST_USER_ID, tz, now, ALL)
  const idsOf = (kind: string) =>
    new Set(segs.find((s) => s.horizon === kind)?.tasks.map((x) => x.task.id))
  const pageIds = idsOf('deadlines')
  const upcomingIds = idsOf('upcoming')
  const due = new Set(getCurrentlyDueTaskIds(TEST_USER_ID, now))
  const today = openTaskToday(tz, now, ROLLOVER)
  let checks = 0
  let onPage = 0
  for (const id of ids) {
    const l = `${at} task ${id}`
    if (pageIds.has(id)) {
      onPage++
      expect(due.has(id), `${l}: on the page AND over target (TM-INV-10)`).toBe(false)
      expect(upcomingIds.has(id), `${l}: on the page AND in Upcoming (TM-INV-10)`).toBe(false)
    }
    const t = task(id)
    const open = !t.done && !t.archived_at && !t.deleted_at
    const targetLess = open && t.deadline_at !== null && t.due_at === null
    // A repeat WITH a relative target has no lead day (ruling 2).
    if (!targetLess || (t.rrule && t.target_days_before !== null)) continue
    expect(
      t.lead_from,
      `${l}: target-less deadline task with no lead day (TM-INV-11)`,
    ).not.toBeNull()
    const lastDay = shiftDay(deadlineDay(t.deadline_at!, tz, ROLLOVER), -1, tz)
    const ok = t.lead_from! <= today || t.lead_from! <= lastDay
    expect(ok, `${l}: a future lead day after D−1 (TM-INV-11)`).toBe(true)
    checks++
  }
  return { checks, onPage }
}

describe('TM-INV: the deadlines page (seeded random)', () => {
  hooks()

  /**
   * TM-INV-10: a task is never on the deadlines page AND over target, nor on
   * the page AND in Upcoming, on the same tick.
   * TM-INV-11: an open target-less deadline task always has a lead day, and
   * one still in the future is at most D−1.
   * Random deadline one-offs and target-less weekly repeats through random
   * considers, defers, decks, targets, target removals, deadline moves,
   * dones and rollovers, read twice a day for 21 days (across Nov 1).
   */
  test('TM-INV-10 / TM-INV-11: one place a day; the lead day never past D−1', () => {
    const SEED = 20261022
    const r = rng(SEED)
    const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)]
    let clock = DateTime.fromISO('2026-10-20T09:00', { zone: tz })
    const ids: number[] = []
    for (let i = 0; i < 24; i++) {
      const deadline = clock.plus({ days: Math.floor(r() * 18), hours: Math.floor(r() * 14) })
      const repeating = r() < 0.25
      const t = make({
        title: `inv ${i}`,
        priority: Math.floor(r() * 5),
        deadline_at: deadline.toUTC().toISO()!,
        ...(repeating
          ? {
              rrule: `FREQ=WEEKLY;BYDAY=${pick(['MO', 'TH', 'SA'])};BYHOUR=${deadline.hour};BYMINUTE=0`,
            }
          : {}),
        ...(!repeating && r() < 0.25
          ? {
              due_at: clock
                .plus({ days: Math.floor(r() * 5) })
                .toUTC()
                .toISO()!,
            }
          : {}),
      })
      ids.push(t.id)
    }
    let checks = 0
    let onPage = 0
    for (let d = 0; d < 21; d++) {
      for (const hour of [10, 21]) {
        clock = DateTime.fromISO(clock.toISODate()!, { zone: tz }).set({ hour })
        vi.setSystemTime(clock.toJSDate())
        if (hour === 10) {
          runTaskRollover({ now: clock.toJSDate(), userId: TEST_USER_ID })
          for (const id of ids) randomWrite(id, r, clock)
        }
        const tick = checkTick(ids, clock, `seed ${SEED} ${clock.toISO()}`)
        checks += tick.checks
        onPage += tick.onPage
      }
      clock = clock.plus({ days: 1 })
    }
    expect(checks).toBeGreaterThan(200)
    expect(onPage).toBeGreaterThan(50)
  }, 60_000)
})
