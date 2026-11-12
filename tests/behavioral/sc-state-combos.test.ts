/**
 * STATE COMBINATIONS (2026-11-12, the rules-map pass): states that each have
 * their own tests but had none TOGETHER. `sc-`:
 *  - SC-01..05 a decked deadline task, then the deadline moves (D−2, 2026-11-07);
 *  - SC-10..11 a New row gets a deadline: out of New, then the Due page;
 *  - SC-20..23 a New row targeted, decked, carried and considered, deferred twice;
 *  - SC-30..31 New across "Roll over now" and a day-start change;
 *  - SC-40..41 "Queue tomorrow" (a marked defer), then a deadline or a deck.
 *
 * SC-23 and SC-40 are the two the pass found wrong and fixed with it (design
 * session, 2026-11-12): a twice-deferred carried row stays in New that day,
 * and a deadline on a "Queue tomorrow" task drops the marker target.
 *
 * Synthetic data only. Task queue on (the day starts at 3:00 AM), check-in
 * day Saturday. America/Chicago: Mon 2026-11-09 14:00 is "now" at the start.
 */
import { describe, test, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { DateTime } from 'luxon'

vi.mock('@/core/notifications/dismiss', () => ({
  dismissNotificationsForTasks: vi.fn(),
  dismissPromptNotifications: vi.fn(),
  syncBadgeCount: vi.fn(),
  getOverdueCount: vi.fn().mockReturnValue(0),
}))
vi.mock('@/core/webhooks/dispatch', () => ({ dispatchWebhookEvent: vi.fn() }))

import { bulkSnooze, createTask, updateTask } from '@/core/tasks'
import { getDb } from '@/core/db'
import { deckTasks } from '@/core/tasks/deck'
import { getTaskById } from '@/core/tasks/read'
import { runRolloverNow } from '@/core/tasks/rollover-now'
import {
  considerTasks,
  deferTasks,
  getTaskSegments,
  targetTasksToday,
} from '@/core/tasks/task-segments'
import { updatePreferences } from '@/core/users/preferences'
import { executeUndo } from '@/core/undo'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

const tz = TEST_TIMEZONE
const u = { userId: TEST_USER_ID, userTimezone: tz }
const at = (local: string) => DateTime.fromISO(local, { zone: tz }).toUTC().toISO()!
const setClock = (local: string) => vi.setSystemTime(new Date(at(local)))
const task = (id: number) => getTaskById(id)!
const make = (input: Record<string, unknown> = {}) =>
  createTask({ ...u, input: { title: 'Synthetic combo task', horizon: 'days', ...input } })
const deck = (id: number, day: string) =>
  deckTasks({ userId: TEST_USER_ID, timezone: tz, ids: [id], day })

/** The web's question: every page, left rows included. */
const WEB = {
  queuePanels: true,
  deckRows: true,
  handledRows: true,
  deadlineRows: true,
  newRows: true,
  fill: false,
}
/** Where task `id` is now: `<segment>:<state>` with `:carried`, `:left=<how>`, `:net`. */
function where(id: number): string[] {
  return getTaskSegments(TEST_USER_ID, tz, new Date(), WEB).flatMap((s) =>
    s.tasks
      .filter((r) => r.task.id === id)
      .map(
        (r) =>
          `${s.horizon}:${r.state}` +
          (r.carried ? ':carried' : '') +
          (r.left ? `:left=${r.left}` : '') +
          (r.safetyNet ? ':net' : ''),
      ),
  )
}

beforeEach(() => {
  setupTestDb()
  vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
  vi.useFakeTimers({ toFake: ['Date'] })
  setClock('2026-11-09T14:00')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})
afterAll(() => teardownTestDb())

describe('SC-0x a decked deadline task, then the deadline moves (DECK-A1)', () => {
  // Deadline Fri Nov 20 23:59; decked for Wed Nov 18, its D−2 (the last day).
  const decked = () => {
    const t = make({ deadline_at: at('2026-11-20T23:59') })
    expect(deck(t.id, '2026-11-18').refused).toEqual([])
    expect(task(t.id).on_deck_day).toBe('2026-11-18')
    return t.id
  }
  const moveDeadline = (id: number, local: string) =>
    updateTask({ ...u, taskId: id, input: { deadline_at: at(local) } })

  test('SC-01: moved so the deck day is D−1 (inside the net): the deck comes off in the same write; Undo restores both', () => {
    const id = decked()
    moveDeadline(id, '2026-11-19T23:59')
    expect(task(id)).toMatchObject({ on_deck_day: null, due_at: null })
    executeUndo(TEST_USER_ID)
    expect(task(id)).toMatchObject({
      on_deck_day: '2026-11-18',
      deadline_at: at('2026-11-20T23:59'),
    })
  })

  test('SC-02: moved so the deck day is D itself: the deck comes off', () => {
    const id = decked()
    moveDeadline(id, '2026-11-18T23:59')
    expect(task(id).on_deck_day).toBeNull()
  })

  test('SC-03: moved so the deck day is after D: the deck comes off', () => {
    const id = decked()
    moveDeadline(id, '2026-11-17T23:59')
    expect(task(id).on_deck_day).toBeNull()
  })

  test('SC-04: moved later: the deck stays', () => {
    const id = decked()
    moveDeadline(id, '2026-11-21T23:59')
    expect(task(id).on_deck_day).toBe('2026-11-18')
  })

  test('SC-05: a legacy deck already inside the net (made before 2026-11-07): on its day the Due page holds it, waiting, in the net', () => {
    const t = make({ deadline_at: at('2026-11-20T23:59') })
    getDb().prepare('UPDATE tasks SET on_deck_day = ? WHERE id = ?').run('2026-11-19', t.id)
    setClock('2026-11-19T10:00')
    expect(where(t.id)).toEqual(['deadlines:waiting:net'])
  })
})

describe('SC-1x a New row gets a deadline (NEW-LEAVES, then the Due page)', () => {
  test('SC-10: it leaves New at once and is quiet until its lead day', () => {
    const t = make()
    setClock('2026-11-10T10:00')
    expect(where(t.id)).toEqual(['new:waiting'])
    // Deadline Mon Nov 30: 20 days off, so the lead table says 4 days → Thu Nov 26.
    updateTask({ ...u, taskId: t.id, input: { deadline_at: at('2026-11-30T23:59') } })
    expect(task(t.id)).toMatchObject({ lead_from: '2026-11-26', due_at: null })
    // Listed in New today only as the row that left; in no horizon segment.
    expect(where(t.id).filter((w) => !w.startsWith('new:'))).toEqual([])
    setClock('2026-11-25T10:00')
    expect(where(t.id)).toEqual([])
  })

  test('SC-11: from its lead day the Due page holds it; from D−1 the safety net', () => {
    const t = make()
    setClock('2026-11-10T10:00')
    updateTask({ ...u, taskId: t.id, input: { deadline_at: at('2026-11-30T23:59') } })
    setClock('2026-11-26T10:00')
    expect(where(t.id)).toEqual(['deadlines:waiting'])
    setClock('2026-11-29T10:00')
    expect(where(t.id)).toEqual(['deadlines:waiting:net'])
  })
})

describe('SC-2x a New row acted on from New', () => {
  test('SC-20: targeted today: it leaves, and New lists it as the row that left', () => {
    const t = make()
    setClock('2026-11-10T10:00')
    expect(where(t.id)).toEqual(['new:waiting']) // the page was drawn: the roster knows the row
    targetTasksToday(TEST_USER_ID, tz, [t.id])
    expect(task(t.id).due_at).not.toBeNull()
    expect(where(t.id)).toEqual(['new:considered:left=target'])
  })

  test('SC-21: decked for today: New lists it as left (the On deck section holds it)', () => {
    const t = make()
    setClock('2026-11-10T10:00')
    expect(where(t.id)).toEqual(['new:waiting'])
    deck(t.id, '2026-11-10')
    expect(where(t.id)).toEqual(['new:considered:left=deck'])
  })

  test('SC-22: a carried row considered: handled in New that day, its horizon the next', () => {
    const t = make()
    setClock('2026-11-10T10:00')
    deferTasks(TEST_USER_ID, [t.id])
    expect(where(t.id)).toEqual(['new:deferred'])
    setClock('2026-11-11T10:00')
    expect(where(t.id)).toEqual(['new:waiting:carried'])
    considerTasks(TEST_USER_ID, [t.id])
    expect(where(t.id)).toEqual(['new:considered:carried'])
    setClock('2026-11-12T10:00')
    expect(where(t.id)).toEqual(['days:waiting'])
  })

  test('SC-23: a carried row deferred again stays in New that day, deferred; its horizon the day after', () => {
    // NEW-NOT-TODAY: "Deferred again, it goes to its horizon's rhythm the day
    // after." Until 2026-11-12 the second Not today moved it into its horizon
    // segment at once, and New's "N of M" shrank under the finger.
    const t = make()
    setClock('2026-11-10T10:00')
    deferTasks(TEST_USER_ID, [t.id])
    setClock('2026-11-11T10:00')
    expect(where(t.id)).toEqual(['new:waiting:carried'])
    deferTasks(TEST_USER_ID, [t.id])
    expect(where(t.id)).toEqual(['new:deferred:carried'])
    setClock('2026-11-12T10:00')
    expect(where(t.id)).toEqual(['days:waiting'])
  })
})

describe('SC-2x (continued): not every task made two days ago is New\u2019s', () => {
  test('SC-24: left untouched on its New day, it is its horizon\u2019s; a Not today there keeps it there', () => {
    // The first cut of SC-23's fix read "made two days ago and deferred
    // today" as a carried row and pulled this one back into New (caught by
    // tm-task-segments.spec). Only a row New listed today is New's.
    const t = make()
    setClock('2026-11-10T10:00')
    expect(where(t.id)).toEqual(['new:waiting'])
    setClock('2026-11-11T10:00')
    expect(where(t.id)).toEqual(['days:waiting'])
    deferTasks(TEST_USER_ID, [t.id])
    expect(where(t.id)).toEqual(['days:deferred'])
  })
})

describe('SC-3x New and the day boundary', () => {
  test('SC-30: Roll over now does not start a task’s New day: only the real rollover does', () => {
    const t = make()
    setClock('2026-11-09T20:00')
    runRolloverNow({ userId: TEST_USER_ID, now: new Date() })
    expect(where(t.id)).toEqual([])
    setClock('2026-11-10T10:00')
    expect(where(t.id)).toEqual(['new:waiting'])
  })

  test('SC-31: a day-start change moves New’s boundary with it (11 PM: the pass ends at 11 PM)', () => {
    const t = make()
    setClock('2026-11-10T10:00')
    expect(where(t.id)).toEqual(['new:waiting'])
    updatePreferences(TEST_USER_ID, { day_start_time: '23:00', day_start_slot_id: null })
    expect(where(t.id)).toEqual(['new:waiting'])
    setClock('2026-11-10T22:59')
    expect(where(t.id)).toEqual(['new:waiting'])
    // 11 PM Tuesday starts Wednesday's OpenTask day: one pass, then its horizon.
    setClock('2026-11-10T23:30')
    expect(where(t.id)).toEqual(['days:waiting'])
  })
})

describe('SC-4x "Queue tomorrow" (a marked defer), then a deadline or a deck', () => {
  // Over target since 9:00; a sweep past the next rollover marks it: its
  // target becomes the rollover moment (3:00 AM Tuesday) and queue_mark is set.
  const marked = () => {
    const t = make({ due_at: at('2026-11-09T09:00') })
    bulkSnooze({ ...u, taskIds: [t.id], until: at('2026-11-10T09:00'), source: 'sweep' })
    expect(task(t.id)).toMatchObject({ queue_mark: true, due_at: at('2026-11-10T03:00') })
    return t.id
  }

  test('SC-40: a deadline added to a marked task drops the marker target with the mark; Undo restores both; the Due page holds it from its lead day', () => {
    // The marker (the next rollover moment) is not a target the user picked.
    // Until 2026-11-12 it stayed as a real 3:00 AM target that nagged, and the
    // Due page never held the task.
    const id = marked()
    updateTask({ ...u, taskId: id, input: { deadline_at: at('2026-11-30T23:59') } })
    expect(task(id)).toMatchObject({ queue_mark: false, due_at: null, lead_from: '2026-11-26' })
    setClock('2026-11-26T10:00')
    expect(where(id)).toEqual(['deadlines:waiting'])
    setClock('2026-11-09T15:00')
    executeUndo(TEST_USER_ID)
    expect(task(id)).toMatchObject({
      queue_mark: true,
      due_at: at('2026-11-10T03:00'),
      deadline_at: null,
    })
  })

  test('SC-40b: a deadline sent WITH a target keeps that target (a pick), and clears the mark', () => {
    const id = marked()
    updateTask({
      ...u,
      taskId: id,
      input: { deadline_at: at('2026-11-30T23:59'), due_at: at('2026-11-12T09:00') },
    })
    expect(task(id)).toMatchObject({ queue_mark: false, due_at: at('2026-11-12T09:00') })
  })

  test('SC-41: a deck on a marked task takes the marker target and the mark; Upcoming shows it before its day', () => {
    const id = marked()
    expect(deck(id, '2026-11-11').refused).toEqual([])
    expect(task(id)).toMatchObject({ queue_mark: false, due_at: null, on_deck_day: '2026-11-11' })
    setClock('2026-11-10T10:00')
    expect(where(id)).toEqual(['upcoming:waiting'])
  })
})
