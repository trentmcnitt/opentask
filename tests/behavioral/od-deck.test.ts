/**
 * OD: ON DECK (2026-10-20; docs/TASK-MODEL.md § On deck; the red team's
 * APPROVED resolutions). A deck is a target's DAY without its nag.
 *
 * - OD-R: the pure rules (src/lib/task-segments.ts, now-view, process-rules).
 * - OD-W: the deck write (`deckTasks`, PATCH, bulk edit): checks, counts,
 *   "never both", the queue clear (B8), the stamps (A6, A7), undo.
 * - OD-B: the pick-only deck clear (B1, load-bearing) through every writer.
 * - OD-G: the guards — every writer of `due_at` applies the deck clear.
 * - OD-RO: the rollover's deck strip (B5) and Roll over now (A3).
 * - OD-P: the period push's "· N on deck" (B10, A12).
 *
 * The user: periods 06:30 / 12:00 / 20:30 (rollover 06:30), morning_time
 * 08:30, America/Chicago, the task queue switch on. The clock is Tue
 * 2026-10-20 10:00 unless a test says otherwise.
 */

import { CALENDAR_DAY_START } from '@/lib/opentask-day'
import fs from 'fs'
import path from 'path'
import { describe, test, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { DateTime } from 'luxon'

vi.mock('@/core/notifications/dismiss', () => ({
  dismissNotificationsForTasks: vi.fn(),
  syncBadgeCount: vi.fn(),
}))
vi.mock('@/core/webhooks/dispatch', () => ({ dispatchWebhookEvent: vi.fn() }))

import { getDb } from '@/core/db'
import { dismissNotificationsForTasks } from '@/core/notifications/dismiss'
import { dispatchWebhookEvent } from '@/core/webhooks/dispatch'
import {
  bulkEdit,
  bulkSnooze,
  createTask,
  deleteTask,
  markDone,
  markUndone,
  snoozeTask,
  updateTask,
} from '@/core/tasks'
import { getTaskById } from '@/core/tasks/read'
import { deckTasks, onDeckToday } from '@/core/tasks/deck'
import { clearDecks, findDecks } from '@/core/tasks/clear-decks'
import { getTaskSegments, targetTasksToday, considerTasks } from '@/core/tasks/task-segments'
import { runTaskRollover } from '@/core/tasks/task-rollover'
import { runRolloverNow } from '@/core/tasks/rollover-now'
import { getCurrentlyDueTaskIds } from '@/core/tasks/currently-due'
import { executeUndo, executeRedo } from '@/core/undo'
import { pendingSlotNotifications } from '@/core/notifications/slot-reminders'
import { pendingSlotNags } from '@/core/notifications/slot-nags'
import { slotWaitingBody, withDeckCount } from '@/core/notifications/apns'
import { formatTaskResponse } from '@/lib/format-task'
import { isRelevantNow } from '@/lib/now-view'
import { growthAsk } from '@/lib/process-rules'
import { deckTomorrowDay } from '@/lib/deck-menu'
import {
  ageLabel,
  compareQueueRows,
  deckDayProblem,
  deckIsToday,
  deckRefusal,
  deckSummary,
  segmentState,
  upcomingGap,
  upcomingState,
} from '@/lib/task-segments'
import type { Task } from '@/types'
import { ValidationError } from '@/core/errors'
import { validateBulkEdit, validateTaskCreate } from '@/core/validation'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

const tz = TEST_TIMEZONE
const u = { userId: TEST_USER_ID, userTimezone: tz }
const ctx = { timezone: tz, morningTime: '08:30' }

function at(local: string): string {
  return DateTime.fromISO(local, { zone: tz }).toUTC().toISO()!
}
function setClock(local: string) {
  vi.setSystemTime(new Date(at(local)))
}
function now(): Date {
  return new Date()
}
function make(input: Record<string, unknown> = {}): Task {
  return createTask({ ...u, input: { title: 'Task', ...input } })
}
function task(id: number): Task {
  return getTaskById(id)!
}
function deck(ids: number[], day?: string | null) {
  return deckTasks({ userId: TEST_USER_ID, timezone: tz, ids, day })
}
function lastUndo(): { action: string; description: string } {
  return getDb()
    .prepare('SELECT action, description FROM undo_log WHERE user_id = ? ORDER BY id DESC LIMIT 1')
    .get(TEST_USER_ID) as { action: string; description: string }
}
function undoCount(): number {
  return (
    getDb().prepare('SELECT COUNT(*) AS n FROM undo_log WHERE user_id = ?').get(TEST_USER_ID) as {
      n: number
    }
  ).n
}
function placesOf(id: number, opts = { queuePanels: true, deckRows: true }): string[] {
  return getTaskSegments(TEST_USER_ID, tz, now(), opts)
    .filter((s) => s.tasks.some((r) => r.task.id === id))
    .map((s) => s.horizon)
}
function roll(local: string) {
  setClock(local)
  return runTaskRollover({ now: new Date(at(local)), userId: TEST_USER_ID })
}
function stamp(date: string) {
  getDb().prepare('UPDATE users SET last_rollover_date = ? WHERE id = ?').run(date, TEST_USER_ID)
}

function setup() {
  setupTestDb()
  const db = getDb()
  db.prepare('DELETE FROM time_slots WHERE user_id = ?').run(TEST_USER_ID)
  const insert = db.prepare(
    'INSERT INTO time_slots (user_id, label, start_time, sort_order) VALUES (?, ?, ?, ?)',
  )
  ;['06:30', '12:00', '20:30'].forEach((s, i) => insert.run(TEST_USER_ID, `Period ${i}`, s, i))
  // The day starts at 06:30, pinned (2026-10-24): this file's timelines were
  // written against a 06:30 rollover (once the first period's start); the
  // unset default is now 3:00 AM.
  db.prepare(
    "UPDATE users SET day_start_time = '06:30', morning_time = '08:30', notifications_enabled = 1 WHERE id = ?",
  ).run(TEST_USER_ID)
  vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
  setClock('2026-10-20T10:00')
  stamp('2026-10-20')
  vi.mocked(dispatchWebhookEvent).mockClear()
  vi.mocked(dismissNotificationsForTasks).mockClear()
}

function hooks() {
  beforeEach(setup)
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })
  afterAll(() => teardownTestDb())
}

// ===========================================================================
// OD-R: the pure rules
// ===========================================================================

/** A bare task for the pure rules (Tue Oct 20, 10:00 Chicago). */
function bare(over: Partial<Task> = {}): Task {
  return {
    id: 1,
    due_at: null,
    deadline_at: null,
    target_auto: false,
    rrule: null,
    horizon: null,
    horizon_set_at: null,
    priority: 0,
    created_at: at('2026-08-01T09:00'),
    target_set_at: at('2026-10-20T10:00'),
    last_considered_at: null,
    segment_deferred_at: null,
    on_deck_day: null,
    queued_at: null,
    is_reminder: false,
    is_tracked: false,
    progress_target: 1,
    done: false,
    deleted_at: null,
    ...over,
  } as Task
}

describe('OD-R: the rules', () => {
  afterEach(() => vi.useRealTimers())
  const tue10 = new Date(at('2026-10-20T10:00'))

  test('OD-R01: the deck day is a calendar date, today or later — 1 AM is the coming day (A2)', () => {
    expect(deckDayProblem('2026-10-20', tz, tue10, CALENDAR_DAY_START)).toBeNull()
    expect(deckDayProblem('2026-10-19', tz, tue10, CALENDAR_DAY_START)).toMatch(/today or later/)
    expect(deckDayProblem('2026-13-01', tz, tue10, CALENDAR_DAY_START)).toMatch(/date/)
    expect(deckDayProblem('Oct 21', tz, tue10, CALENDAR_DAY_START)).toMatch(/date/)
    // 01:00 Wed is still Tuesday's OpenTask day, but the deck is a CALENDAR date.
    const wed1am = new Date(at('2026-10-21T01:00'))
    expect(deckDayProblem('2026-10-21', tz, wed1am, CALENDAR_DAY_START)).toBeNull()
    expect(deckDayProblem('2026-10-20', tz, wed1am, CALENDAR_DAY_START)).toMatch(/today or later/)
    expect(deckIsToday({ on_deck_day: '2026-10-21' }, tz, wed1am, CALENDAR_DAY_START)).toBe(true)
    // Yesterday's leftover still counts as today's until the rollover strips it.
    expect(deckIsToday({ on_deck_day: '2026-10-20' }, tz, wed1am, CALENDAR_DAY_START)).toBe(true)
    expect(deckIsToday({ on_deck_day: '2026-10-22' }, tz, wed1am, CALENDAR_DAY_START)).toBe(false)
  })

  test('OD-R02: A1 (the deadlines page, 2026-10-22) — a deadline deck up to the deadline day, while it is ahead', () => {
    // Deadline Fri Oct 30 23:59, now Tue Oct 20: any day up to Fri Oct 30.
    const t = bare({ deadline_at: at('2026-10-30T23:59') })
    expect(deckRefusal(t, '2026-10-26', ctx, tue10, null)).toBeNull()
    expect(deckRefusal(t, '2026-10-27', ctx, tue10, null)).toBeNull()
    // The deadline's own day is allowed: the safety net still holds it.
    expect(deckRefusal(t, '2026-10-30', ctx, tue10, null)).toBeNull()
    expect(deckRefusal(t, '2026-10-31', ctx, tue10, null)).toBe('after_auto_target')
    // Deadline tonight: still ahead, today allowed.
    expect(
      deckRefusal(bare({ deadline_at: at('2026-10-20T23:59') }), '2026-10-20', ctx, tue10, null),
    ).toBeNull()
    // A passed deadline refuses every day.
    expect(
      deckRefusal(bare({ deadline_at: at('2026-10-19T17:00') }), '2026-10-20', ctx, tue10, null),
    ).toBe('deadline_nagging')
    // A deadline before the rollover belongs to the evening before (its OpenTask day).
    const early = bare({ deadline_at: at('2026-10-31T01:00') })
    expect(deckRefusal(early, '2026-10-31', ctx, tue10, '06:30')).toBe('after_auto_target')
    expect(deckRefusal(early, '2026-10-30', ctx, tue10, '06:30')).toBeNull()
    expect(deckRefusal(bare(), '2027-01-01', ctx, tue10, null)).toBeNull()
  })

  test('OD-R03: quiet like a picked target — no segment; Upcoming on heads-up days (B6)', () => {
    // Decked Tue Oct 20 for Sat Oct 31: wait 11 → heads-ups Wed Oct 28 and Fri Oct 30.
    const t = bare({ on_deck_day: '2026-10-31' })
    expect(segmentState(t, tz, tue10, CALENDAR_DAY_START)).toBeNull()
    const on = (local: string) =>
      upcomingState(t, tz, new Date(at(local)), CALENDAR_DAY_START)?.state ?? null
    expect(on('2026-10-27T10:00')).toBeNull()
    expect(on('2026-10-28T10:00')).toBe('waiting')
    expect(on('2026-10-29T10:00')).toBe('waiting') // carry-over
    expect(on('2026-10-30T10:00')).toBe('waiting')
    expect(on('2026-10-31T10:00')).toBeNull() // its day: the On deck section
    expect(upcomingGap(t, tz, CALENDAR_DAY_START).target).toBe('On deck Sat Oct 31')
    // Decked for tomorrow: no heads-up (wait 1), like a picked target.
    expect(
      upcomingState(bare({ on_deck_day: '2026-10-21' }), tz, tue10, CALENDAR_DAY_START),
    ).toBeNull()
  })

  test('OD-R04: a deck is a plan — no age badge, no growth ask (B7)', () => {
    const old = bare({ created_at: at('2026-01-01T09:00') })
    expect(ageLabel(old, tue10, tz)).toBe('>1 mo')
    expect(ageLabel({ ...old, on_deck_day: '2026-10-24' }, tue10, tz)).toBeNull()
    expect(growthAsk(old, tz, tue10, CALENDAR_DAY_START)).not.toBeNull()
    expect(
      growthAsk({ ...old, on_deck_day: '2026-10-24' }, tz, tue10, CALENDAR_DAY_START),
    ).toBeNull()
  })

  test('OD-R05: the queue sorts a deck-stripped row by its day’s rollover moment', () => {
    const moment = (day: string) => Date.parse(at(`${day}T06:30`))
    const fromTarget = { id: 1, priority: 0, queued_from_due_at: at('2026-10-19T16:00') }
    const fromDeck = { id: 2, priority: 0, queued_from_deck_day: '2026-10-19' }
    const none = { id: 3, priority: 0 }
    const rows = [none, fromTarget, fromDeck].sort((a, b) => compareQueueRows(a, b, moment))
    expect(rows.map((r) => r.id)).toEqual([2, 1, 3])
    // Priority first, at every priority.
    const p4 = { id: 4, priority: 4, queued_from_deck_day: '2026-10-20' }
    expect([fromDeck, p4].sort((a, b) => compareQueueRows(a, b, moment))[0].id).toBe(4)
  })

  test('OD-R06: Now — today’s decks fold; a future deck on its heads-up day; queued High folds (A8, A13)', () => {
    const high = bare({ priority: 3 })
    const on = { queue: true, dayStart: CALENDAR_DAY_START }
    expect(isRelevantNow(high, tz, tue10, { dayStart: CALENDAR_DAY_START })).toBe(true)
    expect(isRelevantNow({ ...high, on_deck_day: '2026-10-20' }, tz, tue10, on)).toBe(false)
    // The deck rules with the queue switch on only (D2 review): off, main's.
    expect(
      isRelevantNow({ ...high, on_deck_day: '2026-10-20' }, tz, tue10, {
        dayStart: CALENDAR_DAY_START,
      }),
    ).toBe(true)
    // A8 with the queue switch on only: off, main's behaviour (relevant).
    const queuedHigh = { ...high, queued_at: at('2026-10-20T06:30') }
    expect(
      isRelevantNow(queuedHigh, tz, tue10, { queue: true, dayStart: CALENDAR_DAY_START }),
    ).toBe(false)
    expect(isRelevantNow(queuedHigh, tz, tue10, { dayStart: CALENDAR_DAY_START })).toBe(true)
    // Decked Tue for Sat Oct 31 → heads-up Wed Oct 28.
    const future = bare({ on_deck_day: '2026-10-31' })
    expect(isRelevantNow(future, tz, tue10, on)).toBe(false)
    expect(isRelevantNow(future, tz, new Date(at('2026-10-28T10:00')), on)).toBe(true)
    // Belt and braces: a deck whose automatic target has arrived (the A1 checks
    // keep this from happening) nags, so it is relevant.
    const nagging = bare({
      on_deck_day: '2026-10-20',
      deadline_at: at('2026-10-23T23:59'),
      due_at: at('2026-10-20T08:30'),
      target_auto: true,
    })
    expect(isRelevantNow(nagging, tz, tue10, on)).toBe(true)
  })

  test('OD-R07: the summary line', () => {
    const base = {
      day: '2026-10-21',
      decked: 3,
      undecked: 0,
      skipped_recurring: 1,
      skipped_reminder: 0,
      skipped_quota: 2,
      skipped_done: 0,
      skipped_trashed: 0,
      refused: [],
    }
    expect(deckSummary(base, tz, tue10, CALENDAR_DAY_START)).toBe(
      '3 tasks on deck for tomorrow · 1 repeating, 2 quotas skipped',
    )
    expect(
      deckSummary(
        {
          ...base,
          decked: 0,
          skipped_recurring: 0,
          skipped_quota: 0,
          refused: [{ id: 1, reason: 'deadline_nagging' }],
        },
        tz,
        tue10,
        CALENDAR_DAY_START,
      ),
    ).toBe('This deadline has passed.')
    expect(
      deckSummary(
        { ...base, day: null, decked: 0, undecked: 2, skipped_recurring: 0, skipped_quota: 0 },
        tz,
        tue10,
        CALENDAR_DAY_START,
      ),
    ).toBe('Took 2 tasks off deck')
  })
})

// ===========================================================================
// OD-W: the deck write
// ===========================================================================

describe('OD-W: deckTasks', () => {
  hooks()

  test('OD-W01: default day is the calendar today; considered + Just-now + target_set_at stamped', () => {
    const t = make()
    const r = deck([t.id])
    expect(r).toMatchObject({ day: '2026-10-20', decked: 1, summary: '1 task on deck for today' })
    expect(task(t.id)).toMatchObject({
      on_deck_day: '2026-10-20',
      last_considered_at: at('2026-10-20T10:00'),
      segment_targeted_at: at('2026-10-20T10:00'),
      target_set_at: at('2026-10-20T10:00'),
    })
    expect(lastUndo().action).toBe('deck')
    expect(onDeckToday(TEST_USER_ID, tz).map((x) => x.id)).toEqual([t.id])
    expect(formatTaskResponse(task(t.id), tz)).toMatchObject({ on_deck_day: '2026-10-20' })
  })

  test('OD-W02: at 1 AM "today" is the OpenTask day that is ending ("Day starts at" PR 2; it was the coming calendar day under A2) — the late night\'s pick is Tomorrow', () => {
    setClock('2026-10-21T01:00')
    const t = make()
    expect(deck([t.id]).day).toBe('2026-10-20')
    expect(deckTomorrowDay(tz, new Date(at('2026-10-21T01:00')), '06:30')).toBe('2026-10-21')
    // A day before today's OpenTask date is refused; today's is fine.
    expect(deckDayProblem('2026-10-19', tz, new Date(at('2026-10-21T01:00')), '06:30')).toBe(
      'The deck day must be today or later',
    )
    expect(deckDayProblem('2026-10-20', tz, new Date(at('2026-10-21T01:00')), '06:30')).toBeNull()
  })

  test('OD-W03: never both — a picked target is dropped (time and all); one Undo puts it back', () => {
    const t = make({ due_at: at('2026-10-20T15:00') })
    deck([t.id], '2026-10-22')
    expect(task(t.id)).toMatchObject({
      due_at: null,
      original_due_at: null,
      on_deck_day: '2026-10-22',
    })
    // The dropped target's banner goes.
    expect(dismissNotificationsForTasks).toHaveBeenCalledWith(TEST_USER_ID, [t.id])
    executeUndo(TEST_USER_ID)
    expect(task(t.id)).toMatchObject({ due_at: at('2026-10-20T15:00'), on_deck_day: null })
    executeRedo(TEST_USER_ID)
    expect(task(t.id)).toMatchObject({ due_at: null, on_deck_day: '2026-10-22' })
  })

  test('OD-W04: a deadline task on deck has no target; a picked one is dropped (the deadlines page)', () => {
    // Deadline Fri Oct 30 23:59: no automatic target (2026-10-22); lead day Tue Oct 27.
    const bareDeadline = make({ deadline_at: at('2026-10-30T23:59') })
    const picked = make({ deadline_at: at('2026-10-30T23:59'), due_at: at('2026-10-21T12:00') })
    expect(deck([bareDeadline.id, picked.id], '2026-10-24')).toMatchObject({
      decked: 2,
      refused: [],
    })
    for (const id of [bareDeadline.id, picked.id]) {
      expect(task(id)).toMatchObject({
        on_deck_day: '2026-10-24',
        due_at: null,
        target_auto: false,
        lead_from: '2026-10-27',
      })
    }
  })

  test('OD-W05: A1 refusals, per task, never the batch', () => {
    const passed = make({ deadline_at: at('2026-10-19T17:00') })
    const sooner = make({ deadline_at: at('2026-10-25T23:59') })
    const later = make({ deadline_at: at('2026-10-30T23:59') })
    const plain = make()
    const r = deck([passed.id, sooner.id, later.id, plain.id], '2026-10-28')
    expect(r.decked).toBe(2)
    expect(r.refused).toEqual([
      { id: passed.id, reason: 'deadline_nagging' },
      { id: sooner.id, reason: 'after_auto_target' },
    ])
    expect(task(plain.id).on_deck_day).toBe('2026-10-28')
    expect(task(later.id).on_deck_day).toBe('2026-10-28')
    expect(task(sooner.id).on_deck_day).toBeNull()
  })

  test('OD-W06: reminders, quotas, done and trashed are skipped and counted (A11); repeating is decked', () => {
    const repeating = make({ rrule: 'FREQ=DAILY', due_at: at('2026-10-21T09:00') })
    const reminder = make({ is_reminder: true, rrule: null })
    const quota = make({ is_tracked: true, progress_target: 2, rrule: 'FREQ=WEEKLY' })
    const done = make()
    markDone({ ...u, taskId: done.id })
    const trashed = make()
    deleteTask({ userId: TEST_USER_ID, taskId: trashed.id })
    const ok = make()
    const r = deck([repeating.id, reminder.id, quota.id, done.id, trashed.id, ok.id])
    // Repeating tasks can be decked since 2026-10-20; `skipped_recurring` stays, always 0.
    expect(r).toMatchObject({
      decked: 2,
      skipped_recurring: 0,
      skipped_reminder: 1,
      skipped_quota: 1,
      skipped_done: 1,
      skipped_trashed: 1,
    })
    expect(task(repeating.id)).toMatchObject({ on_deck_day: '2026-10-20', due_at: null })
  })
})

describe('OD-W: refusals, un-deck, the queue, PATCH, undo', () => {
  hooks()

  test('OD-W07: a past day, someone else’s task, and the switch off are refused whole', () => {
    const t = make()
    expect(() => deck([t.id], '2026-10-19')).toThrow(/today or later/)
    expect(() => deck([t.id, 99999])).toThrow(/your own/)
    vi.stubEnv('OPENTASK_TASK_QUEUE', '')
    expect(() => deck([t.id])).toThrow(expect.objectContaining({ statusCode: 409 }))
    expect(() => updateTask({ ...u, taskId: t.id, input: { on_deck_day: '2026-10-21' } })).toThrow(
      expect.objectContaining({ statusCode: 409 }),
    )
  })

  test('OD-W08: un-deck (day null) touches only decked tasks; stamps nothing new', () => {
    const a = make()
    const b = make()
    deck([a.id], '2026-10-23')
    const before = task(a.id).target_set_at
    setClock('2026-10-20T11:00')
    const r = deck([a.id, b.id], null)
    expect(r).toMatchObject({ day: null, undecked: 1, summary: 'Took 1 task off deck' })
    expect(task(a.id)).toMatchObject({ on_deck_day: null, target_set_at: before })
    // Back in its horizon segment (considered today by the deck, so ticked).
    expect(placesOf(a.id)).toEqual(['weeks'])
  })

  test('OD-W09: decking a queued task takes it out of the queue (rule 3, B8)', () => {
    const t = make({ due_at: at('2026-10-19T16:00') })
    getDb()
      .prepare('UPDATE tasks SET target_set_at = ? WHERE id = ?')
      .run(at('2026-10-19T08:00'), t.id)
    stamp('2026-10-19')
    roll('2026-10-20T06:30')
    expect(task(t.id)).toMatchObject({ due_at: null, queued_at: at('2026-10-20T06:30') })
    setClock('2026-10-20T10:00')
    deck([t.id])
    expect(task(t.id)).toMatchObject({ queued_at: null, on_deck_day: '2026-10-20' })
    expect(placesOf(t.id)).toEqual([])
    // The undo puts it back in the queue.
    executeUndo(TEST_USER_ID)
    expect(task(t.id)).toMatchObject({ queued_at: at('2026-10-20T06:30'), on_deck_day: null })
  })

  test('OD-W10: PATCH and bulk edit accept on_deck_day; an ineligible task is a 400', () => {
    const t = make({ due_at: at('2026-10-21T09:00') })
    const r = updateTask({ ...u, taskId: t.id, input: { on_deck_day: '2026-10-22' } })
    expect(r.fieldsChanged).toEqual(expect.arrayContaining(['on_deck_day', 'due_at']))
    expect(task(t.id)).toMatchObject({ on_deck_day: '2026-10-22', due_at: null })
    updateTask({ ...u, taskId: t.id, input: { on_deck_day: null } })
    expect(task(t.id).on_deck_day).toBeNull()

    const a = make()
    const b = make()
    bulkEdit({ ...u, taskIds: [a.id, b.id], changes: { on_deck_day: '2026-10-23' } })
    expect([task(a.id).on_deck_day, task(b.id).on_deck_day]).toEqual(['2026-10-23', '2026-10-23'])

    const reminder = make({
      is_reminder: true,
      rrule: 'FREQ=DAILY',
      due_at: at('2026-10-21T09:00'),
    })
    expect(() =>
      updateTask({ ...u, taskId: reminder.id, input: { on_deck_day: '2026-10-22' } }),
    ).toThrow(/can go on deck/)
    const passed = make({ deadline_at: at('2026-10-19T17:00') })
    expect(() =>
      updateTask({ ...u, taskId: passed.id, input: { on_deck_day: '2026-10-20' } }),
    ).toThrow(/has passed/)
  })

  test('OD-W11: one undo entry, webhooks for each, a deck never nags', () => {
    const a = make({ priority: 4 })
    const b = make()
    const before = undoCount()
    deck([a.id, b.id])
    expect(undoCount()).toBe(before + 1)
    expect(lastUndo()).toEqual({ action: 'deck', description: '2 tasks on deck for today' })
    expect(
      vi.mocked(dispatchWebhookEvent).mock.calls.filter((c) => c[1] === 'task.updated'),
    ).toHaveLength(2)
    setClock('2026-10-20T23:00')
    expect(getCurrentlyDueTaskIds(TEST_USER_ID)).toEqual([])
    executeUndo(TEST_USER_ID)
    expect([task(a.id).on_deck_day, task(b.id).on_deck_day]).toEqual([null, null])
  })

  test('OD-W12: done keeps the deck; put back brings it back with it', () => {
    const t = make()
    deck([t.id], '2026-10-21')
    markDone({ ...u, taskId: t.id })
    expect(task(t.id).on_deck_day).toBe('2026-10-21')
    expect(onDeckToday(TEST_USER_ID, tz)).toEqual([])
    markUndone({ ...u, taskId: t.id })
    expect(task(t.id)).toMatchObject({ done: false, on_deck_day: '2026-10-21' })
  })
})

// ===========================================================================
// OD-B: the pick-only deck clear (B1)
// ===========================================================================

describe('OD-B: a pick clears the deck; a deadline write does not', () => {
  hooks()

  function decked(input: Record<string, unknown> = {}, day = '2026-10-22'): Task {
    const t = make(input)
    deck([t.id], day)
    return task(t.id)
  }

  test('OD-B01: PATCH a target — cleared in the same write; Undo puts the deck back', () => {
    const t = decked()
    updateTask({ ...u, taskId: t.id, input: { due_at: at('2026-10-21T14:00') } })
    expect(task(t.id)).toMatchObject({ due_at: at('2026-10-21T14:00'), on_deck_day: null })
    executeUndo(TEST_USER_ID)
    expect(task(t.id)).toMatchObject({ due_at: null, on_deck_day: '2026-10-22' })
  })

  test('OD-B02: the snooze endpoint, bulk snooze (pick and sweep), bulk edit and Today', () => {
    const a = decked()
    snoozeTask({ ...u, taskId: a.id, until: at('2026-10-21T14:00') })
    expect(task(a.id).on_deck_day).toBeNull()

    const b = decked()
    bulkSnooze({ ...u, taskIds: [b.id], until: at('2026-10-21T14:00') })
    expect(task(b.id).on_deck_day).toBeNull()

    const c = decked()
    bulkEdit({ ...u, taskIds: [c.id], changes: { due_at: at('2026-10-21T14:00') } })
    expect(task(c.id).on_deck_day).toBeNull()

    const d = decked()
    targetTasksToday(TEST_USER_ID, tz, [d.id])
    expect(task(d.id)).toMatchObject({ on_deck_day: null })
    expect(task(d.id).due_at).not.toBeNull()
  })

  test('OD-B03: a deck up to the deadline day; on its safety-net days the page holds it, a pick takes the deck off', () => {
    // Deadline Fri Oct 23 23:59, decided Sat Oct 17: no target (the deadlines
    // page, 2026-10-22); a deck for the deadline day itself is allowed, the
    // day after is refused (A1).
    setClock('2026-10-17T10:00')
    const t = make({ deadline_at: at('2026-10-23T23:59') })
    expect(task(t.id).due_at).toBeNull()
    expect(deck([t.id], '2026-10-24').refused).toEqual([{ id: t.id, reason: 'after_auto_target' }])
    expect(deck([t.id], '2026-10-23').decked).toBe(1)
    // On the deck day — D, inside the safety net — the page holds it, not
    // the On deck section, and it is never over target.
    setClock('2026-10-23T10:00')
    expect(onDeckToday(TEST_USER_ID, tz)).toEqual([])
    expect(getCurrentlyDueTaskIds(TEST_USER_ID)).toEqual([])
    // A pick (a sweep's move) takes the deck off.
    bulkSnooze({ ...u, taskIds: [t.id], until: at('2026-10-23T15:00'), source: 'sweep' })
    expect(task(t.id)).toMatchObject({ due_at: at('2026-10-23T15:00'), on_deck_day: null })
  })

  test('OD-B04b: a deadline BEFORE the deck day wins: the deck goes', () => {
    // Decked for Sat Oct 24; a deadline Fri Oct 23 23:59 added Tue Oct 20:
    // the deck day is after the deadline's day (A1) — the deadline wins.
    const t = decked({ title: 'Synthetic gloves' }, '2026-10-24')
    const r = updateTask({ ...u, taskId: t.id, input: { deadline_at: at('2026-10-23T23:59') } })
    expect(task(t.id)).toMatchObject({ on_deck_day: null, due_at: null, target_auto: false })
    expect(r.description).toContain('Taken off deck: the deadline is Fri')
    // One undo puts the deck and the old (no) deadline back.
    executeUndo(TEST_USER_ID)
    expect(task(t.id)).toMatchObject({ on_deck_day: '2026-10-24', deadline_at: null })
    // A deadline on the deck day itself keeps it (the safety net still holds it).
    const same = decked({}, '2026-10-24')
    updateTask({ ...u, taskId: same.id, input: { deadline_at: at('2026-10-24T23:59') } })
    expect(task(same.id).on_deck_day).toBe('2026-10-24')
    // Moving a deadline in: the same check.
    const v = decked({}, '2026-10-24')
    updateTask({ ...u, taskId: v.id, input: { deadline_at: at('2026-11-20T23:59') } })
    expect(task(v.id).on_deck_day).toBe('2026-10-24')
    updateTask({ ...u, taskId: v.id, input: { deadline_at: at('2026-10-22T23:59') } })
    expect(task(v.id).on_deck_day).toBeNull()
  })

  test('OD-B04: a deadline added or changed, or the target removed, KEEPS the deck', () => {
    const t = decked()
    updateTask({ ...u, taskId: t.id, input: { deadline_at: at('2026-10-30T23:59') } })
    expect(task(t.id)).toMatchObject({
      on_deck_day: '2026-10-22',
      target_auto: false,
      due_at: null,
    })
    updateTask({ ...u, taskId: t.id, input: { deadline_at: at('2026-11-06T23:59') } })
    expect(task(t.id).on_deck_day).toBe('2026-10-22')
    updateTask({ ...u, taskId: t.id, input: { due_at: null } }) // Remove target: nothing to remove
    expect(task(t.id)).toMatchObject({ on_deck_day: '2026-10-22', due_at: null })
    // A title or priority edit leaves it alone.
    updateTask({ ...u, taskId: t.id, input: { title: 'Renamed', priority: 2 } })
    expect(task(t.id).on_deck_day).toBe('2026-10-22')
  })

  test('OD-B05: becoming a repeating task, a reminder or a quota clears it (rule 6)', () => {
    const a = decked()
    updateTask({ ...u, taskId: a.id, input: { rrule: 'FREQ=DAILY' } })
    expect(task(a.id)).toMatchObject({ on_deck_day: null })
    expect(task(a.id).rrule).toContain('FREQ=DAILY')

    const b = decked()
    updateTask({ ...u, taskId: b.id, input: { is_reminder: true } })
    expect(task(b.id).on_deck_day).toBeNull()

    const c = decked()
    updateTask({ ...u, taskId: c.id, input: { is_tracked: true, rrule: 'FREQ=WEEKLY' } })
    expect(task(c.id).on_deck_day).toBeNull()
  })

  test('OD-B06: the invariant — after any sequence, a deck and a picked target never coexist', () => {
    // Seeded: a fixed pseudo-random walk over every writer.
    let seed = 20261020
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31
      return seed % n
    }
    const ids = Array.from({ length: 6 }, (_, i) =>
      make(i % 2 ? { deadline_at: at('2026-11-20T23:59') } : {}),
    ).map((t) => t.id)
    const days = ['2026-10-20', '2026-10-21', '2026-10-25', '2026-11-02']
    const writes = [
      (id: number) => deck([id], days[rand(days.length)]),
      (id: number) => deck([id], null),
      (id: number) => updateTask({ ...u, taskId: id, input: { due_at: at('2026-10-23T09:00') } }),
      (id: number) => updateTask({ ...u, taskId: id, input: { due_at: null } }),
      (id: number) =>
        updateTask({ ...u, taskId: id, input: { deadline_at: at('2026-11-27T23:59') } }),
      (id: number) => bulkSnooze({ ...u, taskIds: [id], until: at('2026-10-24T09:00') }),
      (id: number) => targetTasksToday(TEST_USER_ID, tz, [id]),
      (id: number) => considerTasks(TEST_USER_ID, [id]),
      // The review's B1 hole: a relative move with a deck in the same bulk
      // edit. Refused whenever it would carry a target (the core's guarantee).
      (id: number) => {
        try {
          bulkEdit({
            ...u,
            taskIds: [id],
            changes: { on_deck_day: days[rand(days.length)] },
            deltaMinutes: 60,
          })
        } catch (err) {
          if (!(err instanceof ValidationError)) throw err
        }
      },
      (id: number) =>
        updateTask({ ...u, taskId: id, input: { deadline_at: at('2026-10-24T23:59') } }),
      () => executeUndo(TEST_USER_ID),
      () => executeRedo(TEST_USER_ID),
    ]
    for (let step = 0; step < 300; step++) {
      const id = ids[rand(ids.length)]
      writes[rand(writes.length)](id)
      for (const each of ids) {
        const t = task(each)
        const picked = t.due_at !== null && !t.target_auto
        expect(picked && t.on_deck_day !== null, `step ${step}, task ${each}`).toBe(false)
        expect(t.on_deck_day !== null && t.queued_at !== null, `step ${step}`).toBe(false)
        // Decks never nag (A1 strict).
        const nagging = t.due_at !== null && Date.parse(t.due_at) <= Date.now()
        expect(t.on_deck_day !== null && nagging, `step ${step}, task ${each} nags`).toBe(false)
      }
    }
  })
})

// ===========================================================================
// OD-G: the guards
// ===========================================================================

describe('OD-G: every writer of a target applies the deck clear', () => {
  function files(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) return files(p)
      return /\.ts$/.test(e.name) ? [p] : []
    })
  }
  const read = (f: string) => fs.readFileSync(f, 'utf8')

  /**
   * Files allowed to write `due_at` without the deck clear, and why. Anything
   * else that writes a target in SQL must import deck-clear.ts.
   */
  const EXEMPT: Record<string, string> = {
    // Migrations and backfills: no deck exists before the column does.
    'src/core/db/index.ts': 'migrations',
    'src/core/db/migrate-deadline-targets.ts': 'migrations',
    // The deadlines page (2026-10-22): only clears automatic targets.
    'src/core/db/migrate-deadline-leads.ts': 'migrations',
    // A pre-migration automatic target converted on reopen / restore (the
    // deadlines page): its SQL fragment runs inside mark-done.ts and delete.ts,
    // which stamp and snapshot it; it never writes a target, only clears one.
    'src/core/tasks/auto-target-lead.ts': 'clears an automatic target (autoTargetToLead)',
    // Relative targets (2026-10-24): a reopened relative one-off's target
    // re-derived (`rederiveOnReopen`) — a fragment mark-done.ts and delete.ts
    // run; a relative one-off is never on deck (a deck drops its offsets).
    'src/core/tasks/relative-target.ts': 'a relative one-off is never on deck (rederiveOnReopen)',
    // A new row starts with `on_deck_day` NULL.
    'src/core/tasks/create.ts': 'new row',
    // The module that defines the stamp; no target of its own.
    'src/core/tasks/target-set.ts': 'the stamp',
    // The rollover never picks a target: it strips, rolls repeating tasks
    // (which can't be decked) and handles decks in its own pass (`stripDecks`).
    'src/core/tasks/task-rollover.ts': 'the rollover',
  }

  test('OD-G01: every SQL writer of due_at imports deck-clear (or is exempt, with a reason)', () => {
    const root = process.cwd()
    const writer = /\bdue_at\s*=\s*(\?|NULL|queued_from_due_at)|INSERT INTO tasks/i
    const offenders = files(path.join(root, 'src'))
      .map((f) => path.relative(root, f))
      .filter((f) => !EXEMPT[f] && f !== 'src/core/tasks/deck-clear.ts')
      .filter((f) => writer.test(read(f)))
      .filter((f) => !/from '(\.\.?\/|@\/core\/tasks\/)deck-clear'/.test(read(f)))
    expect(offenders).toEqual([])
  })

  test('OD-G02: every fixed-SQL target writer clears the deck in the same statement', () => {
    const root = process.cwd()
    const offenders = files(path.join(root, 'src'))
      .map((f) => path.relative(root, f))
      .filter((f) => !EXEMPT[f])
      // The rollover sets the queue state itself and handles decks in its own pass.
      .filter((f) => f !== 'src/core/tasks/task-rollover.ts')
      .filter((f) => /\$\{TARGET_SET_FIELD\} = \?/.test(read(f)))
      .filter((f) => !read(f).includes('DECK_CLEAR_SQL'))
    expect(offenders).toEqual([])
  })

  test('OD-G03: the two collected writers call collectDeckClear', () => {
    for (const f of [
      'src/core/tasks/helpers/collect-field-changes.ts',
      'src/core/ai/enrichment.ts',
    ]) {
      expect(read(path.join(process.cwd(), f)), f).toMatch(/collectDeckClear\(/)
    }
  })
})

// ===========================================================================
// OD-RO: the rollover
// ===========================================================================

describe('OD-RO: the rollover sends an ended deck to the queue', () => {
  hooks()

  test('OD-RO01: an undone deck for today goes to Queued at the next rollover, at every priority, once', () => {
    const low = make()
    const urgent = make({ priority: 4 })
    const done = make()
    const tomorrow = make()
    deck([low.id, urgent.id, done.id])
    deck([tomorrow.id], '2026-10-21')
    markDone({ ...u, taskId: done.id })
    const r = roll('2026-10-21T06:30')
    expect(r.deckStripped).toBe(2)
    for (const id of [low.id, urgent.id]) {
      expect(task(id)).toMatchObject({
        on_deck_day: null,
        queued_from_deck_day: '2026-10-20',
        queued_from_due_at: null,
        queued_at: at('2026-10-21T06:30'),
        rolled_over_at: at('2026-10-21T06:30'),
        due_at: null,
      })
    }
    expect(placesOf(urgent.id)).toEqual(['queue_today'])
    // P4 first in the panel.
    const panel = getTaskSegments(TEST_USER_ID, tz, now(), { queuePanels: true })[0]
    expect(panel.tasks.map((r) => r.task.id)).toEqual([urgent.id, low.id])
    expect(task(done.id).on_deck_day).toBe('2026-10-20') // done: untouched
    expect(task(tomorrow.id).on_deck_day).toBe('2026-10-21') // its day: kept
    expect(onDeckToday(TEST_USER_ID, tz).map((t) => t.id)).toEqual([tomorrow.id])
    // Exactly once: a second call the same OpenTask day does nothing.
    expect(roll('2026-10-21T07:00').deckStripped).toBe(0)
    // Next day: "Previously queued".
    roll('2026-10-22T06:30')
    expect(placesOf(low.id)).toEqual(['queue_previous'])
  })

  test('OD-RO02: at 1 AM a deck for "today" is the ending day\'s — the 6:30 rollover queues it; a deck for Tomorrow survives it ("Day starts at" PR 2, replacing A2)', () => {
    setClock('2026-10-21T01:00')
    const t = make()
    const later = make()
    deck([t.id])
    deck([later.id], '2026-10-21')
    expect(task(t.id).on_deck_day).toBe('2026-10-20')
    roll('2026-10-21T06:30')
    expect(task(t.id)).toMatchObject({ on_deck_day: null, queued_from_deck_day: '2026-10-20' })
    expect(task(later.id).on_deck_day).toBe('2026-10-21')
    roll('2026-10-22T06:30')
    expect(task(later.id)).toMatchObject({ on_deck_day: null, queued_from_deck_day: '2026-10-21' })
  })

  test('OD-RO03: a deadline task’s expired deck is cleared, never queued (the deadlines page)', () => {
    const ahead = make({ deadline_at: at('2026-10-30T23:59') }) // lead day Tue Oct 27
    deck([ahead.id])
    roll('2026-10-21T06:30')
    expect(task(ahead.id)).toMatchObject({
      on_deck_day: null,
      due_at: null,
      queued_at: null,
      queued_from_deck_day: null,
    })
    // Before its lead day: in no queue panel and no segment (its heads-ups come later).
    expect(placesOf(ahead.id)).toEqual([])
    expect(getCurrentlyDueTaskIds(TEST_USER_ID)).not.toContain(ahead.id)
  })

  test('OD-RO04: the fence — an older entry’s undo leaves a stripped deck alone', () => {
    const t = make()
    deck([t.id])
    roll('2026-10-21T06:30')
    executeUndo(TEST_USER_ID) // the deck entry, written before the rollover
    expect(task(t.id)).toMatchObject({ on_deck_day: null, queued_from_deck_day: '2026-10-20' })
  })

  test('OD-RO05: Roll over now strips decks up to the current OpenTask day, not the coming one (A3)', () => {
    setClock('2026-10-21T01:00') // still Tuesday's OpenTask day
    const tueLeftover = make()
    getDb().prepare("UPDATE tasks SET on_deck_day = '2026-10-20' WHERE id = ?").run(tueLeftover.id)
    const wed = make()
    deck([wed.id], '2026-10-21') // the coming day (Tomorrow, at 1 AM)
    const r = runRolloverNow({ userId: TEST_USER_ID, now: new Date(at('2026-10-21T01:00')) })
    expect(r).toMatchObject({ deck_stripped: 1 })
    expect(r.ids.deck_stripped).toEqual([tueLeftover.id])
    expect(task(tueLeftover.id)).toMatchObject({
      on_deck_day: null,
      queued_at: at('2026-10-21T06:30'),
      queued_from_deck_day: '2026-10-20',
    })
    expect(task(wed.id).on_deck_day).toBe('2026-10-21')
    // Its own undo puts the deck back.
    executeUndo(TEST_USER_ID)
    expect(task(tueLeftover.id)).toMatchObject({ on_deck_day: '2026-10-20', queued_at: null })
  })

  test('OD-RO06: switch off, the rollover leaves decks alone (stamp only)', () => {
    const t = make()
    deck([t.id])
    vi.stubEnv('OPENTASK_TASK_QUEUE', '')
    roll('2026-10-21T06:30')
    expect(task(t.id).on_deck_day).toBe('2026-10-20')
  })
})

// ===========================================================================
// OD-P: the period push
// ===========================================================================

describe('OD-P: "· N on deck" rides on slot pushes that already fire', () => {
  hooks()

  function reminderAt(hhmm: string) {
    const [h, m] = hhmm.split(':').map(Number)
    return make({
      is_reminder: true,
      rrule: `FREQ=DAILY;BYHOUR=${h};BYMINUTE=${m}`,
      due_at: at(`2026-10-21T${hhmm}`),
    })
  }

  test('OD-P01: the count is today’s undone decks, a separate key from the reminder count', () => {
    reminderAt('12:00')
    const a = make()
    const b = make()
    const later = make()
    deck([a.id, b.id], '2026-10-21')
    deck([later.id], '2026-10-22')
    // A deck whose (automatic) target has arrived is nagging, not on deck: not
    // counted (put there by hand — the A1 checks keep it from happening).
    const nagging = make({ deadline_at: at('2026-10-22T23:59') })
    getDb().prepare("UPDATE tasks SET on_deck_day = '2026-10-21' WHERE id = ?").run(nagging.id)
    setClock('2026-10-21T12:00')
    const [push] = pendingSlotNotifications(now())
    expect(push).toMatchObject({ count: 1, promptCount: 0, deckCount: 2 })
    expect(withDeckCount(slotWaitingBody(push.count, push.promptCount), push.deckCount)).toBe(
      '1 reminder waiting · 2 on deck',
    )
    expect(withDeckCount('1 reminder waiting', 0)).toBe('1 reminder waiting')
  })

  test('OD-P02: decks never make a slot fire, and never feed the hourly nag', () => {
    const a = make()
    deck([a.id], '2026-10-21')
    setClock('2026-10-21T12:00')
    expect(pendingSlotNotifications(now())).toEqual([])
    getDb()
      .prepare("UPDATE users SET wake_time = '07:00', sleep_time = '23:00' WHERE id = ?")
      .run(TEST_USER_ID)
    setClock('2026-10-21T14:00')
    expect(pendingSlotNags(now())).toEqual([])
  })

  test('OD-P03: switch off — no count', () => {
    reminderAt('12:00')
    const a = make()
    deck([a.id], '2026-10-21')
    vi.stubEnv('OPENTASK_TASK_QUEUE', '')
    setClock('2026-10-21T12:00')
    expect(pendingSlotNotifications(now())[0].deckCount).toBe(0)
  })
})

// ===========================================================================
// OD-C: the rollback
// ===========================================================================

describe('OD-C: clear-decks (rollback)', () => {
  hooks()

  test('OD-C01: lists, then clears every open deck; done and deadline targets untouched', () => {
    const a = make()
    const b = make({ deadline_at: at('2026-10-30T23:59') })
    const done = make()
    deck([a.id, b.id, done.id], '2026-10-23')
    markDone({ ...u, taskId: done.id })
    expect(findDecks(TEST_USER_ID).map((t) => t.id)).toEqual([a.id, b.id])
    expect(clearDecks(TEST_USER_ID).map((t) => t.id)).toEqual([a.id, b.id])
    expect(task(a.id).on_deck_day).toBeNull()
    expect(task(b.id)).toMatchObject({ on_deck_day: null, due_at: null, target_auto: false })
    expect(task(done.id).on_deck_day).toBe('2026-10-23')
    expect(findDecks(TEST_USER_ID)).toEqual([])
  })
})

describe('OD-W: the words', () => {
  hooks()

  test('OD-W13: the undo / History description names the deck', () => {
    const t = make({ title: 'Gloves' })
    const decked = updateTask({ ...u, taskId: t.id, input: { on_deck_day: '2026-10-22' } })
    expect(decked.description).toBe('On deck for Thu Oct 22 — "Gloves"')
    const picked = updateTask({ ...u, taskId: t.id, input: { due_at: at('2026-10-23T09:00') } })
    expect(picked.description).toContain('Taken off deck')
    deck([t.id], '2026-10-24')
    expect(lastUndo().description).toBe('1 task on deck for Sat Oct 24')
  })
})

describe('OD-W: review fixes (10-20)', () => {
  hooks()

  test('OD-W14: a deck never travels with a target — a delta bulk edit is refused, core and schema', () => {
    const t = make({ due_at: at('2026-10-21T09:00') })
    expect(() =>
      bulkEdit({ ...u, taskIds: [t.id], changes: { on_deck_day: '2026-10-22' }, deltaMinutes: 60 }),
    ).toThrow(ValidationError)
    expect(task(t.id)).toMatchObject({ on_deck_day: null, due_at: at('2026-10-21T09:00') })
    expect(() =>
      updateTask({
        ...u,
        taskId: t.id,
        input: { on_deck_day: '2026-10-22', due_at: at('2026-10-23T09:00') },
      }),
    ).toThrow(ValidationError)
    expect(() =>
      validateBulkEdit({ ids: [t.id], changes: { on_deck_day: '2026-10-22' }, delta_minutes: 60 }),
    ).toThrow()
  })

  test('OD-W15: re-decking for the SAME day keeps target_set_at; a new day restamps it', () => {
    const t = make()
    deck([t.id], '2026-10-24')
    const first = task(t.id).target_set_at
    setClock('2026-10-20T11:00')
    deck([t.id], '2026-10-24')
    expect(task(t.id).target_set_at).toBe(first)
    deck([t.id], '2026-10-25')
    expect(task(t.id).target_set_at).toBe(at('2026-10-20T11:00'))
  })

  test('OD-W16: decking cancels a pending AI enrichment (the endpoint and PATCH)', () => {
    const a = make()
    const b = make()
    const pend = getDb().prepare('UPDATE tasks SET labels = ? WHERE id = ?')
    pend.run(JSON.stringify(['ai-to-process']), a.id)
    pend.run(JSON.stringify(['ai-to-process']), b.id)
    deck([a.id])
    expect(task(a.id).labels).not.toContain('ai-to-process')
    updateTask({ ...u, taskId: b.id, input: { on_deck_day: '2026-10-21' } })
    expect(task(b.id).labels).not.toContain('ai-to-process')
  })

  test('OD-W17: create on deck — the same checks as a deck write', () => {
    const t = make({ on_deck_day: '2026-10-22' })
    expect(task(t.id)).toMatchObject({ on_deck_day: '2026-10-22', due_at: null })
    expect(placesOf(t.id)).toEqual([])
    // A deadline in the same body: A1 against it — up to its own day (Sun Oct 25).
    const ok = make({ on_deck_day: '2026-10-25', deadline_at: at('2026-10-25T23:59') })
    expect(task(ok.id)).toMatchObject({
      on_deck_day: '2026-10-25',
      target_auto: false,
      due_at: null,
    })
    expect(() => make({ on_deck_day: '2026-10-26', deadline_at: at('2026-10-25T23:59') })).toThrow(
      /after this task's deadline/,
    )
    expect(() => make({ on_deck_day: '2026-10-19' })).toThrow(/today or later/)
    expect(() =>
      make({ on_deck_day: '2026-10-22', rrule: 'FREQ=DAILY', due_at: at('2026-10-21T09:00') }),
    ).toThrow()
    expect(() => make({ on_deck_day: '2026-10-22', is_reminder: true })).toThrow(/one-off/)
    expect(() => make({ on_deck_day: '2026-10-22', due_at: at('2026-10-23T09:00') })).toThrow()
    expect(() =>
      validateTaskCreate({
        title: 'x',
        on_deck_day: '2026-10-22',
        target_at: at('2026-10-23T09:00'),
      }),
    ).toThrow()
    vi.stubEnv('OPENTASK_TASK_QUEUE', '')
    expect(() => make({ on_deck_day: '2026-10-22' })).toThrow(
      expect.objectContaining({ statusCode: 409 }),
    )
  })
})

describe('OD-C: clear-decks also takes deck strips out of the queue', () => {
  hooks()

  test('OD-C02: a deck the rollover queued leaves the queue; a target strip stays', () => {
    const fromDeck = make()
    deck([fromDeck.id])
    const target = make({ due_at: at('2026-10-20T11:00') })
    roll('2026-10-21T06:30')
    expect(task(fromDeck.id).queued_at).not.toBeNull()
    expect(task(target.id).queued_at).not.toBeNull()
    expect(findDecks(TEST_USER_ID)).toEqual([
      {
        id: fromDeck.id,
        on_deck_day: null,
        queued_from_deck_day: '2026-10-20',
        queued_at: at('2026-10-21T06:30'),
      },
    ])
    clearDecks(TEST_USER_ID)
    expect(task(fromDeck.id)).toMatchObject({ queued_at: null, queued_from_deck_day: '2026-10-20' })
    expect(task(target.id).queued_at).not.toBeNull()
    expect(findDecks(TEST_USER_ID)).toEqual([])
  })
})

describe('OD-D2: the Quick panel’s deck writes (D2 review, 10-20)', () => {
  hooks()

  test('OD-D2-01: a deadline and a deck in ONE write — one undo entry, A7 stamps', () => {
    const t = make()
    const before = undoCount()
    updateTask({
      ...u,
      taskId: t.id,
      input: { deadline_at: at('2026-10-30T23:59'), on_deck_day: '2026-10-22' },
    })
    expect(task(t.id)).toMatchObject({
      on_deck_day: '2026-10-22',
      deadline_at: at('2026-10-30T23:59'),
      target_auto: false,
      due_at: null,
    })
    expect(task(t.id).last_considered_at).not.toBeNull()
    expect(task(t.id).segment_targeted_at).not.toBeNull()
    expect(undoCount()).toBe(before + 1)
    executeUndo(TEST_USER_ID)
    expect(task(t.id)).toMatchObject({ on_deck_day: null, deadline_at: null })
  })

  test('OD-D2-02: A1 is judged against the RESULTING deadline; a refusal saves nothing', () => {
    // Deadline Sun Oct 25 23:59: a deck day after it is refused (A1, 2026-10-22).
    const t = make()
    const before = undoCount()
    expect(() =>
      updateTask({
        ...u,
        taskId: t.id,
        input: { deadline_at: at('2026-10-25T23:59'), on_deck_day: '2026-10-26', priority: 3 },
      }),
    ).toThrow(ValidationError)
    expect(task(t.id)).toMatchObject({ on_deck_day: null, deadline_at: null, priority: 0 })
    expect(undoCount()).toBe(before)
    // The deadline's own day is fine.
    updateTask({
      ...u,
      taskId: t.id,
      input: { deadline_at: at('2026-10-25T23:59'), on_deck_day: '2026-10-25' },
    })
    expect(task(t.id).on_deck_day).toBe('2026-10-25')
    // A target with a deck is still refused.
    expect(() =>
      updateTask({
        ...u,
        taskId: t.id,
        input: { due_at: at('2026-10-22T09:00'), on_deck_day: '2026-10-22' },
      }),
    ).toThrow(ValidationError)
  })

  test('OD-D2-03: un-deck stamps nothing and takes back the Just now stamp', () => {
    const t = make()
    updateTask({ ...u, taskId: t.id, input: { on_deck_day: '2026-10-22' } })
    const considered = task(t.id).last_considered_at
    expect(task(t.id).segment_targeted_at).not.toBeNull()
    setClock('2026-10-20T11:00')
    updateTask({ ...u, taskId: t.id, input: { on_deck_day: null } })
    expect(task(t.id)).toMatchObject({ on_deck_day: null, segment_targeted_at: null })
    expect(task(t.id).last_considered_at).toBe(considered)
  })
})
