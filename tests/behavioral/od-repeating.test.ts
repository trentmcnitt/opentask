/**
 * OD-RP: ON DECK FOR REPEATING TASKS (2026-10-20; Trent: "It needs to be
 * added." — reverses on-deck rule 6; docs/TASK-MODEL.md § On deck).
 *
 * Decking a repeating task decks its CURRENT occurrence for the day: the
 * target is NULL while decked (never a held value), `occurrence_at` stays.
 * It never nags; taking it off deck puts the target back on the occurrence;
 * done / skip complete that occurrence; the rollover hands an un-done deck to
 * the repeating rules. The day-by-day rollover cases are golden timelines
 * (`tests/golden/on-deck-repeating.ts`); this file pins each write.
 *
 * The user: periods 06:30 / 12:00 / 20:30 (rollover 06:30), morning 08:30,
 * America/Chicago, the task queue on. The clock is Tue 2026-10-20 10:00.
 */

import { CALENDAR_DAY_START } from '@/lib/opentask-day'
import { describe, test, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { DateTime } from 'luxon'

vi.mock('@/core/notifications/dismiss', () => ({
  dismissNotificationsForTasks: vi.fn(),
  syncBadgeCount: vi.fn(),
}))
vi.mock('@/core/webhooks/dispatch', () => ({ dispatchWebhookEvent: vi.fn() }))

import { getDb } from '@/core/db'
import { bulkEdit, bulkSnooze, createTask, markDone, markUndone, updateTask } from '@/core/tasks'
import { getTaskById, getTasks } from '@/core/tasks/read'
import { skipOccurrence } from '@/core/tasks/skip'
import { deckTasks, onDeckToday } from '@/core/tasks/deck'
import { clearDecks } from '@/core/tasks/clear-decks'
import { getTaskSegments, targetTasksToday } from '@/core/tasks/task-segments'
import { runTaskRollover } from '@/core/tasks/task-rollover'
import { runRolloverNow } from '@/core/tasks/rollover-now'
import {
  countCurrentlyDue,
  countCurrentlyDueByProject,
  getCurrentlyDueTaskIds,
} from '@/core/tasks/currently-due'
import { effectiveDueAt } from '@/core/recurrence/occurrence'
import { executeUndo, executeRedo } from '@/core/undo'
import { deckLimit, deckMenuDays, offersDeck } from '@/lib/deck-menu'
import { deckErrorMessage } from '@/lib/deck-request'
import { deckRefusal, deckSkip } from '@/lib/task-segments'
import { validateTaskUpdate } from '@/core/validation'
import type { Task } from '@/types'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

const tz = TEST_TIMEZONE
const u = { userId: TEST_USER_ID, userTimezone: tz }
const ctx = { timezone: tz, morningTime: '08:30' }
const DAILY_8 = 'FREQ=DAILY;BYHOUR=8;BYMINUTE=0'
const MONDAY_8 = 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=8;BYMINUTE=0'

function at(local: string): string {
  return DateTime.fromISO(local, { zone: tz }).toUTC().toISO()!
}
function setClock(local: string) {
  vi.setSystemTime(new Date(at(local)))
}
function make(input: Record<string, unknown> = {}): Task {
  return createTask({ ...u, input: { title: 'Task', ...input } })
}
/**
 * A repeating task made at `created` (local), then the clock back to `now`:
 * its first occurrence is the rule's first at or after `created`.
 */
function repeating(
  rrule: string,
  created: string,
  input: Record<string, unknown> = {},
  now = '2026-10-20T10:00',
): Task {
  setClock(created)
  const t = make({ rrule, ...input })
  setClock(now)
  return t
}
/** A daily at 08:00 made Tue 07:00: its occurrence today (Tue 08:00) has come — over target. */
function daily(input: Record<string, unknown> = {}): Task {
  const t = repeating(DAILY_8, '2026-10-20T07:00', input)
  expect(t.due_at).toBe(at('2026-10-20T08:00'))
  return t
}
/** A weekly Monday 08:00 made Mon Oct 19 07:00: Monday's occurrence missed. */
function weekly(): Task {
  const t = repeating(MONDAY_8, '2026-10-19T07:00')
  expect(t.due_at).toBe(at('2026-10-19T08:00'))
  return t
}
/**
 * A DEADLINE-ANCHORED weekly (2026-10-21) made Tue 07:00: deadline Fridays
 * 17:00 (Fri Oct 23), target 3 days before at 08:00 — Tue Oct 20 08:00, over
 * target by 10:00.
 */
function fridayDeadline(): Task {
  const t = repeating('FREQ=WEEKLY;BYDAY=FR;BYHOUR=17;BYMINUTE=0', '2026-10-20T07:00', {
    deadline_at: at('2026-10-23T17:00'),
    target_days_before: 3,
    target_time: '08:00',
  })
  expect(t).toMatchObject({
    due_at: at('2026-10-20T08:00'),
    occurrence_at: at('2026-10-23T17:00'),
    deadline_at: at('2026-10-23T17:00'),
  })
  return t
}
function task(id: number): Task {
  return getTaskById(id)!
}
function deck(ids: number[], day?: string | null) {
  return deckTasks({ userId: TEST_USER_ID, timezone: tz, ids, day })
}
function due(): number[] {
  return getCurrentlyDueTaskIds(TEST_USER_ID)
}
function placesOf(id: number, opts = { queuePanels: true, deckRows: true }): string[] {
  return getTaskSegments(TEST_USER_ID, tz, new Date(), opts)
    .filter((s) => s.tasks.some((r) => r.task.id === id))
    .map((s) => s.horizon)
}
function roll(local: string) {
  setClock(local)
  return runTaskRollover({ now: new Date(at(local)), userId: TEST_USER_ID })
}

beforeEach(() => {
  setupTestDb()
  const db = getDb()
  db.prepare('DELETE FROM time_slots WHERE user_id = ?').run(TEST_USER_ID)
  const insert = db.prepare(
    'INSERT INTO time_slots (user_id, label, start_time, sort_order) VALUES (?, ?, ?, ?)',
  )
  ;['06:30', '12:00', '20:30'].forEach((s, i) => insert.run(TEST_USER_ID, `Period ${i}`, s, i))
  db.prepare("UPDATE users SET morning_time = '08:30', notifications_enabled = 1 WHERE id = ?").run(
    TEST_USER_ID,
  )
  vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
  setClock('2026-10-20T10:00')
  db.prepare("UPDATE users SET last_rollover_date = '2026-10-20' WHERE id = ?").run(TEST_USER_ID)
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})
afterAll(() => teardownTestDb())

describe('OD-RP: the pure rules', () => {
  test('OD-RP01: a repeating task is no longer skipped; reminders and quotas still are', () => {
    expect(deckSkip({ rrule: DAILY_8 } as never)).toBeNull()
    expect(deckSkip({ is_reminder: true })).toBe('reminder')
    expect(deckSkip({ is_tracked: true })).toBe('quota')
    expect(offersDeck({ due_at: at('2026-10-20T08:00'), rrule: DAILY_8 })).toBe(true)
    expect(offersDeck({ due_at: null, rrule: DAILY_8, on_deck_day: '2026-10-20' })).toBe(true)
    expect(offersDeck({ due_at: null, rrule: DAILY_8, is_reminder: true })).toBe(false)
  })

  test('OD-RP02: A1 for a repeating deadline — up to the deadline’s day, while it is ahead', () => {
    const now = new Date(at('2026-10-20T10:00'))
    // Deadline Fri Oct 23 17:00: Fri is the last day (the deadlines page, 2026-10-22).
    const t = {
      due_at: at('2026-10-22T08:00'),
      deadline_at: at('2026-10-23T17:00'),
      rrule: DAILY_8,
    }
    expect(deckRefusal(t, '2026-10-22', ctx, now, null)).toBeNull()
    expect(deckRefusal(t, '2026-10-23', ctx, now, null)).toBeNull()
    expect(deckRefusal(t, '2026-10-24', ctx, now, null)).toBe('after_auto_target')
    const passed = { ...t, deadline_at: at('2026-10-20T09:00') }
    expect(deckRefusal(passed, '2026-10-20', ctx, now, null)).toBe('deadline_nagging')
    // The web greys the same days.
    expect(deckLimit(t, tz, now, null, null)).toEqual({
      latestDay: '2026-10-23',
      caption: 'deadline Fri',
    })
    const days = deckMenuDays(tz, now, CALENDAR_DAY_START, 6, deckLimit(t, tz, now, null, null))
    expect(days.filter((d) => !d.disabled).map((d) => d.day)).toEqual([
      '2026-10-21',
      '2026-10-22',
      '2026-10-23',
    ])
    expect(deckLimit(passed, tz, now, null, null)).toEqual({
      latestDay: '2026-10-19',
      caption: 'deadline passed',
    })
  })

  test('OD-RP03: effectiveDueAt is null for a target-less deck, whatever the schedule says', () => {
    const decked = {
      due_at: null,
      rrule: DAILY_8,
      anchor_time: '08:00',
      occurrence_at: at('2026-10-20T08:00'),
      on_deck_day: '2026-10-20',
    }
    expect(
      effectiveDueAt(decked, tz, CALENDAR_DAY_START, new Date(at('2026-10-20T10:00'))),
    ).toBeNull()
    // Off deck, the schedule answers (today's 08:00 occurrence).
    expect(
      effectiveDueAt(
        { ...decked, on_deck_day: null },
        tz,
        CALENDAR_DAY_START,
        new Date(at('2026-10-20T10:00')),
      ),
    ).not.toBeNull()
  })
})

describe('OD-RP: the deck write', () => {
  test('OD-RP10: decking keeps the occurrence, drops the target, and it never nags', () => {
    const t = daily()
    const other = make({ due_at: at('2026-10-20T09:00') })
    expect(due()).toEqual(expect.arrayContaining([t.id, other.id]))
    const r = deck([t.id])
    expect(r).toMatchObject({ decked: 1, skipped_recurring: 0 })
    expect(task(t.id)).toMatchObject({
      on_deck_day: '2026-10-20',
      due_at: null,
      occurrence_at: at('2026-10-20T08:00'),
      queued_at: null,
    })
    // Not over target anywhere: the badge's set, its count, each project's,
    // `?overdue=true`, so the snooze-overdue sweep (which reads the same set).
    expect(due()).toEqual([other.id])
    expect(countCurrentlyDue(TEST_USER_ID)).toBe(1)
    expect(countCurrentlyDueByProject(TEST_USER_ID).get(t.project_id)).toBe(1)
    expect(getTasks({ userId: TEST_USER_ID, overdue: true }).map((x) => x.id)).toEqual([other.id])
    // On deck today (the section and the push's count).
    expect(onDeckToday(TEST_USER_ID, tz).map((x) => x.id)).toEqual([t.id])
    // Hours later the schedule's next occurrence passes: still quiet.
    setClock('2026-10-20T23:00')
    expect(due()).not.toContain(t.id)
  })

  test('OD-RP11: a waiting queue row decked "try the missed one, quietly": out of the queue', () => {
    const t = weekly()
    getDb()
      .prepare("UPDATE users SET last_rollover_date = '2026-10-19' WHERE id = ?")
      .run(TEST_USER_ID)
    roll('2026-10-20T06:30')
    expect(task(t.id)).toMatchObject({
      due_at: at('2026-10-26T08:00'),
      occurrence_at: at('2026-10-19T08:00'),
    })
    expect(placesOf(t.id)).toEqual(['queue_today'])
    setClock('2026-10-20T10:00')
    deck([t.id])
    expect(task(t.id)).toMatchObject({
      on_deck_day: '2026-10-20',
      due_at: null,
      occurrence_at: at('2026-10-19T08:00'),
      queued_at: null,
    })
    expect(placesOf(t.id)).toEqual([])
    // Done advances normally: from the later of the occurrence and now.
    markDone({ ...u, taskId: t.id })
    expect(task(t.id)).toMatchObject({
      due_at: at('2026-10-26T08:00'),
      occurrence_at: at('2026-10-26T08:00'),
      on_deck_day: null,
    })
  })

  test('OD-RP12: High and Urgent repeating tasks can be decked', () => {
    const t = daily({ priority: 4 })
    expect(deck([t.id]).decked).toBe(1)
    expect(due()).not.toContain(t.id)
  })

  test('OD-RP13: a PATCH with a rule and a deck day is a 400, in the schema and in the core', () => {
    const t = daily()
    expect(() => validateTaskUpdate({ rrule: MONDAY_8, on_deck_day: '2026-10-21' })).toThrow()
    expect(() =>
      updateTask({ ...u, taskId: t.id, input: { rrule: MONDAY_8, on_deck_day: '2026-10-21' } }),
    ).toThrow(/without rrule/)
    expect(() =>
      bulkEdit({ ...u, taskIds: [t.id], changes: { rrule: MONDAY_8, on_deck_day: '2026-10-21' } }),
    ).toThrow(/without rrule/)
    expect(task(t.id).on_deck_day).toBeNull()
    // PATCH alone decks it, like the endpoint.
    updateTask({ ...u, taskId: t.id, input: { on_deck_day: '2026-10-21' } })
    expect(task(t.id)).toMatchObject({ on_deck_day: '2026-10-21', due_at: null })
  })

  test('OD-RP14: an edit keeps a repeating deck — a new rule too (PR 4a); Today and a snooze clear it', () => {
    const a = daily()
    deck([a.id])
    updateTask({ ...u, taskId: a.id, input: { title: 'Renamed', priority: 2, notes: 'x' } })
    expect(task(a.id)).toMatchObject({ on_deck_day: '2026-10-20', due_at: null })

    targetTasksToday(TEST_USER_ID, tz, [a.id])
    expect(task(a.id).on_deck_day).toBeNull()
    expect(task(a.id).due_at).not.toBeNull()

    const b = daily()
    deck([b.id], '2026-10-22')
    bulkSnooze({ ...u, taskIds: [b.id], until: at('2026-10-21T09:00') })
    expect(task(b.id)).toMatchObject({ on_deck_day: null, due_at: at('2026-10-21T09:00') })

    // A new rule is a schedule change: the decked occurrence is the user's,
    // so it keeps its day (Tue Oct 20) at the new rule's time (08:00 still).
    const c = daily()
    deck([c.id], '2026-10-22')
    updateTask({ ...u, taskId: c.id, input: { rrule: MONDAY_8 } })
    expect(task(c.id)).toMatchObject({
      rrule: MONDAY_8,
      on_deck_day: '2026-10-22',
      due_at: null,
      occurrence_at: at('2026-10-20T08:00'),
      // Decking took the origin with the target; the rule change leaves it.
      original_due_at: null,
    })
  })

  test('OD-RP15: taking it off deck puts the target back on the occurrence — the debt returns', () => {
    const t = daily()
    deck([t.id])
    const r = deck([t.id], null)
    expect(r.undecked).toBe(1)
    expect(task(t.id)).toMatchObject({
      on_deck_day: null,
      due_at: at('2026-10-20T08:00'),
      original_due_at: at('2026-10-20T08:00'),
      occurrence_at: at('2026-10-20T08:00'),
    })
    expect(due()).toContain(t.id)
    // PATCH null the same.
    deck([t.id], '2026-10-21')
    updateTask({ ...u, taskId: t.id, input: { on_deck_day: null } })
    expect(task(t.id)).toMatchObject({ on_deck_day: null, due_at: at('2026-10-20T08:00') })
    // Undo of the un-deck puts the deck (and the NULL target) back.
    executeUndo(TEST_USER_ID)
    expect(task(t.id)).toMatchObject({ on_deck_day: '2026-10-21', due_at: null })
    executeRedo(TEST_USER_ID)
    expect(task(t.id)).toMatchObject({ on_deck_day: null, due_at: at('2026-10-20T08:00') })
  })

  test('OD-RP16: A1 per task — a repeating deadline refuses days after its own day', () => {
    // Deadline Fri Oct 23 17:00 for the current occurrence.
    const t = fridayDeadline()
    expect(deck([t.id], '2026-10-24').refused).toEqual([{ id: t.id, reason: 'after_auto_target' }])
    expect(deck([t.id], '2026-10-22').decked).toBe(1)
    expect(task(t.id)).toMatchObject({ on_deck_day: '2026-10-22', due_at: null })
    // A deadline moved BEFORE the deck's day wins: the deck goes, the
    // occurrence is rescheduled to it and its derived target comes back
    // (3 days before: Sun Oct 18 08:00).
    updateTask({ ...u, taskId: t.id, input: { deadline_at: at('2026-10-21T17:00') } })
    expect(task(t.id)).toMatchObject({
      on_deck_day: null,
      due_at: at('2026-10-18T08:00'),
      occurrence_at: at('2026-10-21T17:00'),
      deadline_at: at('2026-10-21T17:00'),
    })
    expect(due()).toContain(t.id)
  })

  test('OD-RP17: undo of a repeating deck gives the target back; redo takes it again', () => {
    const t = daily()
    deck([t.id])
    executeUndo(TEST_USER_ID)
    expect(task(t.id)).toMatchObject({ on_deck_day: null, due_at: at('2026-10-20T08:00') })
    executeRedo(TEST_USER_ID)
    expect(task(t.id)).toMatchObject({ on_deck_day: '2026-10-20', due_at: null })
  })
})

describe('OD-RP: done, skip, put-back', () => {
  test('OD-RP20: done completes the decked occurrence; undo restores the deck; redo again', () => {
    const t = daily()
    deck([t.id])
    markDone({ ...u, taskId: t.id })
    expect(task(t.id)).toMatchObject({
      on_deck_day: null,
      due_at: at('2026-10-21T08:00'),
      occurrence_at: at('2026-10-21T08:00'),
      completion_count: 1,
    })
    executeUndo(TEST_USER_ID)
    expect(task(t.id)).toMatchObject({
      on_deck_day: '2026-10-20',
      due_at: null,
      occurrence_at: at('2026-10-20T08:00'),
      completion_count: 0,
    })
    expect(due()).not.toContain(t.id)
    executeRedo(TEST_USER_ID)
    expect(task(t.id)).toMatchObject({ on_deck_day: null, due_at: at('2026-10-21T08:00') })
  })

  test('OD-RP21: skip passes over the decked occurrence; undo restores the deck', () => {
    const t = daily()
    deck([t.id])
    skipOccurrence({ ...u, taskId: t.id })
    expect(task(t.id)).toMatchObject({
      on_deck_day: null,
      due_at: at('2026-10-21T08:00'),
      skip_count: 1,
    })
    executeUndo(TEST_USER_ID)
    expect(task(t.id)).toMatchObject({ on_deck_day: '2026-10-20', due_at: null, skip_count: 0 })
  })

  test('OD-RP22: put-back of a decked occurrence brings it back as debt, never target-less', () => {
    const t = daily()
    deck([t.id])
    markDone({ ...u, taskId: t.id })
    const back = markUndone({ ...u, taskId: t.id })
    expect(back).toMatchObject({
      due_at: at('2026-10-20T08:00'),
      original_due_at: at('2026-10-20T08:00'),
      occurrence_at: at('2026-10-20T08:00'),
      on_deck_day: null,
      completion_count: 0,
    })
    // Its attempts checkpoint is a valid day (a NULL target-was reads as "not arrived").
    expect(back.attempts_counted_through).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(due()).toContain(t.id)
  })

  test('OD-RP23: a deck on the NEXT occurrence goes with a put-back; its undo brings it back', () => {
    const t = daily()
    markDone({ ...u, taskId: t.id }) // → Wed 08:00
    deck([t.id], '2026-10-21')
    expect(task(t.id)).toMatchObject({ on_deck_day: '2026-10-21', due_at: null })
    markUndone({ ...u, taskId: t.id })
    expect(task(t.id)).toMatchObject({ on_deck_day: null, due_at: at('2026-10-20T08:00') })
    executeUndo(TEST_USER_ID)
    expect(task(t.id)).toMatchObject({ on_deck_day: '2026-10-21', due_at: null })
  })
})

describe('OD-RP: Upcoming, the rollover, the rollback', () => {
  test('OD-RP30: a future repeating deck is in Upcoming on its heads-up days, for ?deck=1 only', () => {
    const t = daily()
    deck([t.id], '2026-10-23') // wait 3: the day-before heads-up, Thu
    expect(placesOf(t.id)).toEqual([])
    setClock('2026-10-22T10:00')
    expect(placesOf(t.id)).toEqual(['upcoming'])
    expect(placesOf(t.id, { queuePanels: true, deckRows: false })).toEqual([])
    const row = getTaskSegments(TEST_USER_ID, tz, new Date(), { deckRows: true })
      .find((s) => s.horizon === 'upcoming')!
      .tasks.find((r) => r.task.id === t.id)!
    expect(row.task).toMatchObject({ on_deck_day: '2026-10-23', due_at: null })
    // Its day: in the On deck section, not Upcoming.
    setClock('2026-10-23T10:00')
    expect(placesOf(t.id)).toEqual([])
    expect(onDeckToday(TEST_USER_ID, tz).map((x) => x.id)).toEqual([t.id])
  })

  test('OD-RP31: the rollover never leaves a repeating task target-less; a deadline one is only restored', () => {
    const plain = daily()
    const deadline = fridayDeadline()
    deck([plain.id, deadline.id])
    const r = roll('2026-10-21T06:30')
    expect(r.deckStripped).toBe(2)
    expect(task(plain.id)).toMatchObject({
      on_deck_day: null,
      due_at: at('2026-10-21T08:00'),
      occurrence_at: at('2026-10-21T08:00'),
      skip_count: 1,
    })
    // Deadline repeating tasks are never rolled: the derived target is back, it nags.
    expect(task(deadline.id)).toMatchObject({
      on_deck_day: null,
      due_at: at('2026-10-20T08:00'),
      occurrence_at: at('2026-10-23T17:00'),
      deadline_at: at('2026-10-23T17:00'),
      skip_count: 0,
      queued_at: null,
    })
    expect(due()).toEqual(expect.arrayContaining([deadline.id]))
  })

  test('OD-RP32: a deck made before its occurrence came gets it back as an ordinary future target', () => {
    // Weekly Monday, next occurrence Mon Oct 26: decked for today (Tue).
    const t = repeating(MONDAY_8, '2026-10-20T07:00')
    expect(t.due_at).toBe(at('2026-10-26T08:00'))
    deck([t.id])
    roll('2026-10-21T06:30')
    expect(task(t.id)).toMatchObject({
      on_deck_day: null,
      due_at: at('2026-10-26T08:00'),
      occurrence_at: at('2026-10-26T08:00'),
      queued_at: null,
      skip_count: 0,
    })
  })

  test('OD-RP33: Roll over now ends a repeating deck the same way, and its undo puts the deck back', () => {
    const t = weekly()
    deck([t.id])
    setClock('2026-10-20T20:00')
    const r = runRolloverNow({ userId: TEST_USER_ID, now: new Date(at('2026-10-20T20:00')) })
    expect(r.ids.deck_stripped).toEqual([t.id])
    expect(task(t.id)).toMatchObject({
      on_deck_day: null,
      due_at: at('2026-10-26T08:00'),
      occurrence_at: at('2026-10-19T08:00'),
      queued_from_deck_day: '2026-10-20',
      queued_from_due_at: null,
    })
    expect(task(t.id).queued_at).not.toBeNull()
    executeUndo(TEST_USER_ID)
    expect(task(t.id)).toMatchObject({
      on_deck_day: '2026-10-20',
      due_at: null,
      occurrence_at: at('2026-10-19T08:00'),
      queued_at: null,
    })
  })

  test('OD-RP34: the rollback (clear-decks) gives a repeating deck its target back', () => {
    const t = daily()
    const one = make()
    deck([t.id, one.id])
    clearDecks(TEST_USER_ID)
    expect(task(t.id)).toMatchObject({
      on_deck_day: null,
      due_at: at('2026-10-20T08:00'),
      original_due_at: at('2026-10-20T08:00'),
    })
    expect(task(one.id)).toMatchObject({ on_deck_day: null, due_at: null })
  })
})

describe('OD-RP: review round (2026-10-20)', () => {
  test('OD-RP40: the target that comes back is the occurrence’s derived one — rollover and rollback', () => {
    // Deadline Mondays 08:00 (Mon Oct 26), target the day before at 17:00
    // (2026-10-21: deadline-anchored; the target never after the deadline).
    const decked = () => {
      const t = repeating(MONDAY_8, '2026-10-20T07:00', {
        deadline_at: at('2026-10-26T08:00'),
        target_days_before: 1,
        target_time: '17:00',
      })
      expect(t.due_at).toBe(at('2026-10-25T17:00'))
      deck([t.id])
      expect(task(t.id)).toMatchObject({
        on_deck_day: '2026-10-20',
        due_at: null,
        occurrence_at: at('2026-10-26T08:00'),
      })
      return t
    }
    const cleared = decked()
    clearDecks(TEST_USER_ID)
    expect(task(cleared.id)).toMatchObject({
      on_deck_day: null,
      due_at: at('2026-10-25T17:00'),
      occurrence_at: at('2026-10-26T08:00'),
    })
    const rolled = decked()
    roll('2026-10-21T06:30')
    expect(task(rolled.id)).toMatchObject({
      on_deck_day: null,
      due_at: at('2026-10-25T17:00'),
      original_due_at: at('2026-10-25T17:00'),
      occurrence_at: at('2026-10-26T08:00'),
    })
  })

  test('OD-RP41: a deck that rolls or waits counts as rolled / waiting too; the wait’s activity row names its deck day', () => {
    const d = daily()
    const w = weekly()
    deck([d.id, w.id])
    setClock('2026-10-20T20:00')
    const r = runRolloverNow({ userId: TEST_USER_ID, now: new Date(at('2026-10-20T20:00')) })
    expect([...r.ids.deck_stripped].sort()).toEqual([d.id, w.id].sort())
    // Both wait for their next occurrence (Roll over now's M is now; the
    // daily's next, Wed 08:00, is after the next real rollover).
    expect([...r.ids.waiting].sort()).toEqual([d.id, w.id].sort())
    expect(r).toMatchObject({ deck_stripped: 2, waiting: 2, rolled: 0 })
    const row = getDb()
      .prepare(
        `SELECT fields, after FROM activity_log
          WHERE task_id = ? AND json_extract(metadata, '$.rollover') = 'waiting'
          ORDER BY id DESC LIMIT 1`,
      )
      .get(w.id) as { fields: string; after: string }
    expect(JSON.parse(row.fields)).toContain('queued_from_deck_day')
    expect(JSON.parse(row.after)).toMatchObject({
      queued_from_deck_day: '2026-10-20',
      queued_from_due_at: null,
    })
  })

  test('OD-RP42: the cron counts a deck that rolls as rolled', () => {
    const d = daily()
    deck([d.id])
    const c = roll('2026-10-21T06:30')
    expect(c).toMatchObject({ deckStripped: 1, rolled: 1, waiting: 0 })
  })

  test('OD-RP43: a repeating deadline before the rollover counts as the evening before (A1)', () => {
    const now = new Date(at('2026-10-20T10:00'))
    // Deadline Fri Oct 23 02:00 — before the 06:30 rollover: Thursday's OpenTask day.
    const t = { due_at: null, deadline_at: at('2026-10-23T02:00'), rrule: DAILY_8 }
    // Its day (Thu) is the last one allowed; Fri, the calendar day, is after it.
    expect(deckRefusal(t, '2026-10-23', ctx, now, '06:30')).toBe('after_auto_target')
    expect(deckRefusal(t, '2026-10-22', ctx, now, '06:30')).toBeNull()
    // Without a rollover time, the calendar day (Fri): Fri allowed.
    expect(deckRefusal(t, '2026-10-23', ctx, now, null)).toBeNull()
    expect(deckLimit(t, tz, now, null, '06:30')).toMatchObject({ latestDay: '2026-10-22' })
    expect(deckLimit(t, tz, now, null, null)).toMatchObject({ latestDay: '2026-10-23' })
    // The server judges with the owner's rollover time (06:30 here). A
    // deadline-anchored weekly (2026-10-21): deadline Fridays 02:00, target
    // the day before at 20:00.
    const real = repeating('FREQ=WEEKLY;BYDAY=FR;BYHOUR=2;BYMINUTE=0', '2026-10-20T07:00', {
      deadline_at: at('2026-10-23T02:00'),
      target_days_before: 1,
      target_time: '20:00',
    })
    expect(deck([real.id], '2026-10-23').refused).toEqual([
      { id: real.id, reason: 'after_auto_target' },
    ])
    expect(() =>
      updateTask({ ...u, taskId: real.id, input: { on_deck_day: '2026-10-23' } }),
    ).toThrow("That day is after this task's deadline.")
    expect(deck([real.id], '2026-10-22').decked).toBe(1)
  })

  test('OD-RP44: the web words a repeating deadline refusal as the deadline, not a reminder', () => {
    const refused = {
      day: '2026-10-23',
      decked: 0,
      undecked: 0,
      skipped_recurring: 0,
      skipped_reminder: 0,
      skipped_quota: 0,
      skipped_done: 0,
      skipped_trashed: 0,
      refused: [{ id: 7, reason: 'after_auto_target' as const }],
      summary: 'That day is after this deadline starts reminding you.',
    }
    expect(deckErrorMessage(refused, { id: 7, rrule: DAILY_8 })).toBe(
      "That day is after this task's deadline.",
    )
    expect(deckErrorMessage(refused, { id: 7, rrule: null })).toBe(refused.summary)
  })
})

/**
 * PR 4a (2026-10-22; plan RT-1, ruling A1): a SCHEDULE change — a new rule,
 * new offsets, a new mode, an anchor switch; PATCH or bulk edit — on a decked
 * repeating task keeps the deck: no target is computed, the occurrence keeps
 * its DAY at the new rule's time (as over-target debt does). On a
 * deadline-anchored repeat the A1 check is re-run against the deadline the
 * write leaves, and if it refuses, the deadline wins as before: the deck goes
 * and the target comes back — from the NEW schedule.
 */
describe('OD-RP: a schedule change keeps the deck (PR 4a)', () => {
  const MONDAY_6PM = 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=18;BYMINUTE=0'
  const FRIDAY_7PM = 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=19;BYMINUTE=0'

  test('OD-RP50: target-anchored — the deck stays, the occurrence is re-timed; off deck it comes back there', () => {
    const t = daily()
    deck([t.id], '2026-10-22')
    const before = task(t.id)
    const { fieldsChanged } = updateTask({ ...u, taskId: t.id, input: { rrule: MONDAY_6PM } })
    expect(fieldsChanged).not.toContain('due_at')
    expect(fieldsChanged).not.toContain('on_deck_day')
    expect(fieldsChanged).not.toContain('original_due_at')
    expect(task(t.id)).toMatchObject({
      rrule: MONDAY_6PM,
      on_deck_day: '2026-10-22',
      due_at: null,
      occurrence_at: at('2026-10-20T18:00'),
      original_due_at: before.original_due_at,
    })
    expect(due()).not.toContain(t.id)

    // Undo restores the row exactly; redo again.
    executeUndo(TEST_USER_ID)
    const undone = task(t.id)
    for (const f of [
      'rrule',
      'due_at',
      'occurrence_at',
      'on_deck_day',
      'anchor_time',
      'anchor_dow',
      'original_due_at',
      'target_set_at',
    ] as const) {
      expect(undone[f], f).toEqual(before[f])
    }
    executeRedo(TEST_USER_ID)
    expect(task(t.id)).toMatchObject({
      on_deck_day: '2026-10-22',
      occurrence_at: at('2026-10-20T18:00'),
    })

    // Off deck, the target is the occurrence's — at the new time.
    deck([t.id], null)
    expect(task(t.id)).toMatchObject({ on_deck_day: null, due_at: at('2026-10-20T18:00') })
  })

  test('OD-RP51: bulk edit — the same (collectFieldChanges is shared)', () => {
    const t = daily()
    deck([t.id], '2026-10-22')
    const origin = task(t.id).original_due_at
    bulkEdit({ ...u, taskIds: [t.id], changes: { rrule: MONDAY_6PM } })
    expect(task(t.id)).toMatchObject({
      on_deck_day: '2026-10-22',
      due_at: null,
      occurrence_at: at('2026-10-20T18:00'),
      original_due_at: origin,
    })
  })

  test('OD-RP52: deadline-anchored — a rule, offsets and mode change keep the deck; the deadline is re-timed', () => {
    const t = fridayDeadline()
    expect(deck([t.id], '2026-10-22').decked).toBe(1)
    const origin = task(t.id).original_due_at
    updateTask({ ...u, taskId: t.id, input: { rrule: FRIDAY_7PM } })
    expect(task(t.id)).toMatchObject({
      rrule: FRIDAY_7PM,
      on_deck_day: '2026-10-22',
      due_at: null,
      occurrence_at: at('2026-10-23T19:00'),
      deadline_at: at('2026-10-23T19:00'),
      original_due_at: origin,
    })
    updateTask({ ...u, taskId: t.id, input: { target_days_before: 1, target_time: '09:00' } })
    expect(task(t.id)).toMatchObject({
      on_deck_day: '2026-10-22',
      due_at: null,
      target_days_before: 1,
      target_time: '09:00',
    })
    bulkEdit({ ...u, taskIds: [t.id], changes: { recurrence_mode: 'from_completion' } })
    expect(task(t.id)).toMatchObject({ on_deck_day: '2026-10-22', due_at: null })
    expect(due()).not.toContain(t.id)
    // Off deck: the target the NEW offsets derive (Thu Oct 22 09:00).
    deck([t.id], null)
    expect(task(t.id)).toMatchObject({ on_deck_day: null, due_at: at('2026-10-22T09:00') })
  })

  test('OD-RP53: deadline-anchored — A1 re-run: a new deadline the deck no longer comes before wins', () => {
    const t = fridayDeadline()
    // On deck for the deadline's own day (allowed since 2026-10-22).
    deck([t.id], '2026-10-23')
    // 01:00 is before the 06:30 rollover, so the Fri Oct 23 01:00 deadline
    // belongs to Thursday Oct 22 — BEFORE the deck's day (A1): refused, the
    // deck goes, and the target comes back from the NEW schedule (1 day
    // before at 00:30 → Thu Oct 22 00:30), not the old one's Tue 08:00.
    updateTask({
      ...u,
      taskId: t.id,
      input: {
        rrule: 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=1;BYMINUTE=0',
        target_days_before: 1,
        target_time: '00:30',
      },
    })
    expect(task(t.id)).toMatchObject({
      on_deck_day: null,
      deadline_at: at('2026-10-23T01:00'),
      occurrence_at: at('2026-10-23T01:00'),
      due_at: at('2026-10-22T00:30'),
    })
    executeUndo(TEST_USER_ID)
    expect(task(t.id)).toMatchObject({
      on_deck_day: '2026-10-23',
      due_at: null,
      deadline_at: at('2026-10-23T17:00'),
      target_days_before: 3,
    })
  })

  test('OD-RP54: an anchor switch keeps the deck — deadline → target lands on the target’s day', () => {
    const t = fridayDeadline()
    deck([t.id], '2026-10-22')
    // The occurrence's target was Tue Oct 20 08:00; target-anchored Tuesdays 08:00.
    updateTask({
      ...u,
      taskId: t.id,
      input: { repeat_anchor: 'target', rrule: 'FREQ=WEEKLY;BYDAY=TU;BYHOUR=8;BYMINUTE=0' },
    })
    expect(task(t.id)).toMatchObject({
      repeat_anchor: 'target',
      deadline_at: null,
      on_deck_day: '2026-10-22',
      due_at: null,
      occurrence_at: at('2026-10-20T08:00'),
    })
  })

  test('OD-RP56: deadline-anchored — this occurrence’s deadline rescheduled later keeps the deck (no target derived)', () => {
    const t = fridayDeadline()
    deck([t.id], '2026-10-22')
    updateTask({ ...u, taskId: t.id, input: { deadline_at: at('2026-10-24T17:00') } })
    expect(task(t.id)).toMatchObject({
      on_deck_day: '2026-10-22',
      due_at: null,
      deadline_at: at('2026-10-24T17:00'),
      occurrence_at: at('2026-10-24T17:00'),
    })
  })

  test('OD-RP57: deadline-anchored — a moved target kept across a rule change keeps its origin', () => {
    // Moved this occurrence to Wed Oct 21 12:00, then the deadline re-timed to 19:00.
    const t = fridayDeadline()
    updateTask({ ...u, taskId: t.id, input: { due_at: at('2026-10-21T12:00') } })
    const moved = task(t.id)
    expect(moved.original_due_at).not.toBeNull()
    const { fieldsChanged } = updateTask({ ...u, taskId: t.id, input: { rrule: FRIDAY_7PM } })
    expect(fieldsChanged).not.toContain('original_due_at')
    expect(task(t.id)).toMatchObject({
      due_at: at('2026-10-21T12:00'),
      deadline_at: at('2026-10-23T19:00'),
      original_due_at: moved.original_due_at,
    })
  })

  test('OD-RP55: a reminder conversion with a new rule still takes the deck off and dates it', () => {
    const t = daily()
    deck([t.id], '2026-10-22')
    updateTask({ ...u, taskId: t.id, input: { rrule: MONDAY_6PM, is_reminder: true } })
    const r = task(t.id)
    expect(r.on_deck_day).toBeNull()
    expect(r.due_at).toBe(at('2026-10-26T18:00'))
  })
})
