/**
 * Task queue PR 2: the rollover (src/core/tasks/task-rollover.ts;
 * docs/TASK-MODEL.md § The rollover). With OPENTASK_TASK_QUEUE on, once per
 * OpenTask day at the user's rollover, a below-High task with no deadline on
 * a previous day's target (or marked by a Snooze-all) is handed to the queue:
 * a one-off is stripped, a repeating task rolls to this day's occurrence or
 * waits for its next one.
 *
 * The user: periods 06:30 / 12:00 / 20:30 (rollover 06:30), morning_time
 * 08:30, America/Chicago. "Today" is Tue 2026-10-20; every test sets the
 * user's `last_rollover_date` itself (never relative to the real date).
 */

import { describe, test, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { DateTime } from 'luxon'

vi.mock('@/core/notifications/dismiss', () => ({
  dismissNotificationsForTasks: vi.fn(),
  syncBadgeCount: vi.fn(),
}))
vi.mock('@/core/webhooks/dispatch', () => ({ dispatchWebhookEvent: vi.fn() }))
vi.mock('@/lib/sync-events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/sync-events')>()
  return { ...actual, emitSyncEvent: vi.fn() }
})

import { getDb, stampRolloverDates } from '@/core/db'
import { dismissNotificationsForTasks, syncBadgeCount } from '@/core/notifications/dismiss'
import { emitSyncEvent } from '@/lib/sync-events'
import { dispatchWebhookEvent } from '@/core/webhooks/dispatch'
import { markUndone } from '@/core/tasks/mark-done'
import { updateTask } from '@/core/tasks'
import { createTask, markDone, bulkSnooze } from '@/core/tasks'
import { getTaskById } from '@/core/tasks/read'
import { targetTasksToday } from '@/core/tasks/task-segments'
import { runTaskRollover } from '@/core/tasks/task-rollover'
import { findStrippedTargets, restoreStrippedTargets } from '@/core/tasks/restore-stripped'
import { executeUndo, executeRedo } from '@/core/undo'
import { formatTaskResponse } from '@/lib/format-task'
import { attemptsOffer } from '@/lib/task-segments'
import { isEarlyMorningPick, targetOpenTaskDay } from '@/lib/opentask-day'
import type { Task } from '@/types'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

const tz = TEST_TIMEZONE
const u = { userId: TEST_USER_ID, userTimezone: tz }

function at(local: string): string {
  return DateTime.fromISO(local, { zone: tz }).toUTC().toISO()!
}
function setClock(local: string) {
  vi.setSystemTime(new Date(at(local)))
}

/** Make a task with the clock at `madeAt` (so `target_set_at` is then), then put it back. */
function makeAt(madeAt: string, input: Record<string, unknown>): Task {
  const now = new Date()
  setClock(madeAt)
  try {
    return createTask({ ...u, input: { title: 'Task', ...input } })
  } finally {
    vi.setSystemTime(now)
  }
}

function task(id: number): Task {
  return getTaskById(id)!
}

function stamp(date: string | null) {
  getDb().prepare('UPDATE users SET last_rollover_date = ? WHERE id = ?').run(date, TEST_USER_ID)
}
function stampOf(): string | null {
  return (
    getDb().prepare('SELECT last_rollover_date FROM users WHERE id = ?').get(TEST_USER_ID) as {
      last_rollover_date: string | null
    }
  ).last_rollover_date
}

/** Run the job at a Chicago wall-clock time (the clock moves there too). */
function roll(local: string) {
  setClock(local)
  return runTaskRollover({ now: new Date(at(local)), userId: TEST_USER_ID })
}

function seedPeriods(
  starts: string[] = ['06:30', '12:00', '20:30'],
  morning = '08:30',
  dayStart: string | null = '06:30',
) {
  const db = getDb()
  db.prepare('DELETE FROM time_slots WHERE user_id = ?').run(TEST_USER_ID)
  const insert = db.prepare(
    'INSERT INTO time_slots (user_id, label, start_time, sort_order) VALUES (?, ?, ?, ?)',
  )
  starts.forEach((s, i) => insert.run(TEST_USER_ID, `Period ${i}`, s, i))
  // The day starts at 06:30, pinned (2026-10-24): this file's timelines were
  // written against a 06:30 rollover (once the first period's start); the
  // unset default is now 3:00 AM.
  db.prepare('UPDATE users SET morning_time = ?, day_start_time = ? WHERE id = ?').run(
    morning,
    dayStart,
    TEST_USER_ID,
  )
}

/** Tue 2026-10-20 06:00, switch on, Monday's rollover already run. */
function setupTuesday() {
  setupTestDb()
  seedPeriods()
  vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
  setClock('2026-10-20T06:00')
  stamp('2026-10-19')
  vi.mocked(dispatchWebhookEvent).mockClear()
  vi.mocked(dismissNotificationsForTasks).mockClear()
  vi.mocked(syncBadgeCount).mockClear()
  vi.mocked(emitSyncEvent).mockClear()
}

function cleanup() {
  vi.unstubAllEnvs()
  vi.useRealTimers()
}

describe('TQ-R: the rollover', () => {
  beforeEach(setupTuesday)
  afterEach(cleanup)
  afterAll(() => teardownTestDb())

  test('TQ-R01: strips a one-off left over target from yesterday, exactly once, at 06:30', () => {
    const t = makeAt('2026-10-19T09:00', { due_at: at('2026-10-19T16:00') })
    expect(roll('2026-10-20T06:29').ran).toBe(0)
    expect(task(t.id).due_at).toBe(at('2026-10-19T16:00'))

    const r = roll('2026-10-20T06:30')
    expect(r).toMatchObject({ ran: 1, stripped: 1 })
    const after = task(t.id)
    expect(after.due_at).toBeNull()
    expect(after.queued_from_due_at).toBe(at('2026-10-19T16:00'))
    expect(Date.parse(after.queued_at!)).toBe(Date.parse(at('2026-10-20T06:30')))
    expect(Date.parse(after.rolled_over_at!)).toBe(Date.parse(at('2026-10-20T06:30')))
    expect(after.queue_mark).toBe(false)
    expect(stampOf()).toBe('2026-10-20')

    // Exactly once: a second tick, later that day, does nothing.
    makeAt('2026-10-20T06:40', { title: 'Later', due_at: at('2026-10-20T07:00') })
    expect(roll('2026-10-20T06:31').ran).toBe(0)
    expect(roll('2026-10-20T23:59').ran).toBe(0)
  })

  test('TQ-R02: a target today (after the rollover) and a target picked for later are kept', () => {
    const today = makeAt('2026-10-19T20:00', { due_at: at('2026-10-20T09:00') })
    const later = makeAt('2026-10-19T20:00', { due_at: at('2026-10-22T09:00') })
    roll('2026-10-20T06:30')
    expect(task(today.id).due_at).toBe(at('2026-10-20T09:00'))
    expect(task(later.id).due_at).toBe(at('2026-10-22T09:00'))
  })

  test('TQ-R03: a timezone change mid-day never runs it twice', () => {
    roll('2026-10-20T06:30')
    expect(stampOf()).toBe('2026-10-20')
    const t = makeAt('2026-10-20T07:00', { due_at: at('2026-10-20T07:30') })
    getDb()
      .prepare("UPDATE users SET timezone = 'America/Los_Angeles' WHERE id = ?")
      .run(TEST_USER_ID)
    // 08:30 Chicago is 06:30 in Los Angeles: a new rollover moment, the same day.
    expect(roll('2026-10-20T08:30').ran).toBe(0)
    expect(roll('2026-10-20T12:00').ran).toBe(0)
    expect(task(t.id).due_at).toBe(at('2026-10-20T07:30'))
  })

  test('TQ-R04: catch-up after two days down runs ONCE, as of the latest rollover', () => {
    stamp('2026-10-17')
    const old = makeAt('2026-10-16T09:00', { due_at: at('2026-10-17T10:00') })
    const daily = makeAt('2026-10-17T07:00', {
      title: 'Daily',
      rrule: 'FREQ=DAILY',
      due_at: at('2026-10-17T08:00'),
    })
    // Moved at 06:45 today — after the rollover moment — while the server was down.
    const sweptLate = makeAt('2026-10-19T09:00', { due_at: at('2026-10-19T10:00') })
    getDb()
      .prepare('UPDATE tasks SET target_set_at = ? WHERE id = ?')
      .run(at('2026-10-20T06:45'), sweptLate.id)
    const skipsBefore = task(daily.id).skip_count

    const r = roll('2026-10-20T07:10')
    expect(r).toMatchObject({ ran: 1, stripped: 1, rolled: 1 })
    expect(stampOf()).toBe('2026-10-20')
    expect(task(old.id).due_at).toBeNull()
    // Rolled to TODAY's occurrence (not one run per missed day), one skip logged.
    expect(task(daily.id).due_at).toBe(at('2026-10-20T08:00'))
    expect(task(daily.id).occurrence_at).toBe(at('2026-10-20T08:00'))
    expect(task(daily.id).skip_count).toBe(skipsBefore + 1)
    // As of M: a target set after 06:30 is left alone.
    expect(task(sweptLate.id).due_at).toBe(at('2026-10-19T10:00'))
  })

  test('TQ-R05: the exclusion filter', () => {
    const due = at('2026-10-19T16:00')
    const make = (title: string, extra: Record<string, unknown> = {}) =>
      makeAt('2026-10-19T09:00', { title, due_at: due, ...extra })
    const control = make('P2 one-off', { priority: 2 })
    const reminder = make('Reminder')
    const quota = make('Quota')
    const multi = make('Progress 2')
    const deadlinePassed = make('Deadline passed', { deadline_at: at('2026-10-19T17:00') })
    const deadlineAhead = make('Deadline ahead', { deadline_at: at('2026-10-25T17:00') })
    const p3 = make('High', { priority: 3 })
    const p4 = make('Urgent', { priority: 4 })
    const db = getDb()
    db.prepare('UPDATE tasks SET is_reminder = 1 WHERE id = ?').run(reminder.id)
    db.prepare('UPDATE tasks SET is_tracked = 1 WHERE id = ?').run(quota.id)
    db.prepare('UPDATE tasks SET progress_target = 2 WHERE id = ?').run(multi.id)
    const before = Object.fromEntries(
      [reminder, quota, multi, deadlinePassed, deadlineAhead, p3, p4].map((t) => [
        t.id,
        task(t.id).due_at,
      ]),
    )

    const r = roll('2026-10-20T06:30')
    expect(r.stripped).toBe(1)
    expect(task(control.id).due_at).toBeNull()
    for (const [id, dueAt] of Object.entries(before)) {
      const t = task(Number(id))
      expect(t.due_at, t.title).toBe(dueAt)
      expect(t.queued_at, t.title).toBeNull()
      expect(t.rolled_over_at, t.title).toBeNull()
    }
  })

  test('TQ-R06: the deploy stamp — NULL becomes the current OpenTask day; nothing strips', () => {
    const t = makeAt('2026-10-18T09:00', { due_at: at('2026-10-19T16:00') })
    stamp(null)
    expect(stampRolloverDates(getDb(), new Date(at('2026-10-20T05:00')))).toBe(1)
    expect(stampOf()).toBe('2026-10-19') // 05:00 still belongs to Monday's OpenTask day
    stamp(null)
    stampRolloverDates(getDb(), new Date(at('2026-10-20T07:00')))
    expect(stampOf()).toBe('2026-10-20')
    expect(roll('2026-10-20T07:01').ran).toBe(0)
    expect(task(t.id).due_at).toBe(at('2026-10-19T16:00'))
    // A second run of the stamp is a no-op.
    expect(stampRolloverDates(getDb(), new Date(at('2026-10-21T07:00')))).toBe(0)
  })

  test('TQ-R07: the job reads NULL as "stamp only", never "never ran"', () => {
    const t = makeAt('2026-10-18T09:00', { due_at: at('2026-10-19T16:00') })
    stamp(null)
    const r = roll('2026-10-20T07:00')
    expect(r).toMatchObject({ stamped: 1, ran: 0, stripped: 0 })
    expect(stampOf()).toBe('2026-10-20')
    expect(task(t.id).due_at).toBe(at('2026-10-19T16:00'))
  })

  test('TQ-R08: switch off → the stamp advances, nothing else', () => {
    vi.stubEnv('OPENTASK_TASK_QUEUE', '')
    const t = makeAt('2026-10-18T09:00', { due_at: at('2026-10-19T16:00') })
    const r = roll('2026-10-20T06:30')
    expect(r).toMatchObject({ stamped: 1, ran: 0 })
    expect(stampOf()).toBe('2026-10-20')
    expect(task(t.id)).toMatchObject({ due_at: at('2026-10-19T16:00'), queued_at: null })
    // Turned on later the same day: today's rollover has run; no catch-up.
    vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
    expect(roll('2026-10-20T09:00').ran).toBe(0)
  })
})

describe('TQ-F: the undo fence, the events, the activity rows', () => {
  beforeEach(setupTuesday)
  afterEach(cleanup)
  afterAll(() => teardownTestDb())

  test('TQ-R09: the undo fence — Undo of last night’s sweep restores only the task not stripped; redo likewise', () => {
    const a = makeAt('2026-10-19T08:00', { title: 'A', due_at: at('2026-10-19T09:00') })
    const b = makeAt('2026-10-19T08:00', { title: 'B', due_at: at('2026-10-19T09:00') })
    const c = makeAt('2026-10-19T08:00', {
      title: 'C (deadline)',
      due_at: at('2026-10-19T09:00'),
      deadline_at: at('2026-10-24T17:00'),
    })
    setClock('2026-10-19T21:00')
    bulkSnooze({
      ...u,
      taskIds: [a.id, b.id, c.id],
      until: at('2026-10-20T08:30'),
      source: 'sweep',
    })
    expect(task(a.id).queue_mark).toBe(true)
    expect(task(c.id).due_at).toBe(at('2026-10-20T08:30'))

    expect(roll('2026-10-20T06:30').stripped).toBe(2)
    setClock('2026-10-20T06:31')
    expect(executeUndo(TEST_USER_ID)).not.toBeNull()
    expect(task(a.id).due_at).toBeNull()
    expect(task(b.id).due_at).toBeNull()
    expect(task(a.id).queued_at).not.toBeNull()
    expect(task(c.id).due_at).toBe(at('2026-10-19T09:00'))
    const entry = getDb()
      .prepare('SELECT undone FROM undo_log WHERE user_id = ? ORDER BY id DESC LIMIT 1')
      .get(TEST_USER_ID) as { undone: number }
    expect(entry.undone).toBe(1)

    expect(executeRedo(TEST_USER_ID)).not.toBeNull()
    expect(task(c.id).due_at).toBe(at('2026-10-20T08:30'))
    expect(task(a.id).due_at).toBeNull()
    expect(task(a.id).queued_at).not.toBeNull()
  })

  test('TQ-R10: an entry written AFTER the rollover is not fenced', () => {
    const t = makeAt('2026-10-19T08:00', { due_at: at('2026-10-19T09:00') })
    roll('2026-10-20T06:30')
    setClock('2026-10-20T07:00')
    targetTasksToday(TEST_USER_ID, tz, [t.id])
    expect(task(t.id).due_at).not.toBeNull()
    expect(task(t.id).queued_at).toBeNull()
    executeUndo(TEST_USER_ID)
    expect(task(t.id).due_at).toBeNull()
    expect(task(t.id).queued_at).not.toBeNull()
  })

  test('TQ-R11: after commit — dismiss the moved tasks, sync the badge, emit sync', () => {
    const t = makeAt('2026-10-19T08:00', { due_at: at('2026-10-19T09:00') })
    vi.mocked(dismissNotificationsForTasks).mockClear()
    vi.mocked(emitSyncEvent).mockClear()
    roll('2026-10-20T06:30')
    expect(dismissNotificationsForTasks).toHaveBeenCalledWith(TEST_USER_ID, [t.id])
    expect(emitSyncEvent).toHaveBeenCalledWith(TEST_USER_ID)
    // A webhook per changed task, after commit, with the target it had.
    expect(dispatchWebhookEvent).toHaveBeenCalledWith(
      TEST_USER_ID,
      'task.updated',
      expect.objectContaining({ previous_due_at: at('2026-10-19T09:00') }),
    )
    expect(vi.mocked(dispatchWebhookEvent).mock.calls.map((c) => c[1])).not.toContain(
      'task.skipped',
    )

    // A run that only releases a wait (no target moved) resyncs the badge itself.
    vi.mocked(syncBadgeCount).mockClear()
    vi.mocked(emitSyncEvent).mockClear()
    const weekly = makeAt('2026-10-12T07:00', {
      title: 'Weekly',
      rrule: 'FREQ=WEEKLY;BYDAY=MO',
      due_at: at('2026-10-12T08:00'),
    })
    getDb()
      .prepare('UPDATE tasks SET queued_at = ?, due_at = ? WHERE id = ?')
      .run(at('2026-10-14T06:30'), at('2026-10-20T06:00'), weekly.id)
    roll('2026-10-21T06:30')
    expect(syncBadgeCount).toHaveBeenCalledWith(TEST_USER_ID)
    expect(emitSyncEvent).toHaveBeenCalledWith(TEST_USER_ID)

    // Nothing to do (the released weekly gone): no badge resync, no
    // dismissals — but the DAY TURNED (2026-10-23, "Day starts at"): the
    // Reminders roster and its prompt keys are a new day's, so exactly one
    // sync event goes out (widgets included), and a second tick the same day
    // sends nothing.
    getDb()
      .prepare('UPDATE tasks SET deleted_at = ? WHERE id = ?')
      .run(at('2026-10-21T07:00'), weekly.id)
    vi.mocked(emitSyncEvent).mockClear()
    vi.mocked(syncBadgeCount).mockClear()
    vi.mocked(dismissNotificationsForTasks).mockClear()
    roll('2026-10-22T06:30')
    expect(vi.mocked(emitSyncEvent).mock.calls).toEqual([[TEST_USER_ID]])
    expect(syncBadgeCount).not.toHaveBeenCalled()
    expect(dismissNotificationsForTasks).not.toHaveBeenCalled()
    vi.mocked(emitSyncEvent).mockClear()
    roll('2026-10-22T06:31')
    roll('2026-10-22T23:59')
    expect(emitSyncEvent).not.toHaveBeenCalled()

    // The switch off: the day stamp still advances, but the Reminders day is
    // midnight, so the rollover's moment sends nothing.
    vi.stubEnv('OPENTASK_TASK_QUEUE', '')
    roll('2026-10-23T06:30')
    expect(emitSyncEvent).not.toHaveBeenCalled()
    vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
  })

  test('TQ-R12: the activity rows carry source "rollover"', () => {
    const t = makeAt('2026-10-19T08:00', { due_at: at('2026-10-19T09:00') })
    roll('2026-10-20T06:30')
    const row = getDb()
      .prepare('SELECT action, source, metadata FROM activity_log WHERE task_id = ? AND source = ?')
      .get(t.id, 'rollover') as { action: string; source: string; metadata: string }
    expect(row.action).toBe('edit')
    expect(JSON.parse(row.metadata).rollover).toBe('stripped')
    // No undo entry.
    const undo = getDb()
      .prepare("SELECT COUNT(*) AS n FROM undo_log WHERE snapshot LIKE '%rolled_over_at%'")
      .get() as { n: number }
    expect(undo.n).toBe(0)
  })
})

describe('TQ-S: what a strip keeps', () => {
  beforeEach(() => {
    setupTestDb()
    seedPeriods()
    vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
    setClock('2026-10-17T06:00')
    stamp('2026-10-16')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })
  afterAll(() => teardownTestDb())

  test('TQ-S01: a marked task (swept to the rollover) is stripped AT it, with no new attempt', () => {
    const t = makeAt('2026-10-16T08:00', { due_at: at('2026-10-16T09:00') })
    roll('2026-10-16T06:30') // stamped 10-16 already: nothing
    setClock('2026-10-16T21:00')
    expect(task(t.id).attempts).toBe(1)
    bulkSnooze({ ...u, taskIds: [t.id], until: at('2026-10-17T08:30'), source: 'sweep' })
    expect(task(t.id).due_at).toBe(at('2026-10-17T06:30'))
    roll('2026-10-17T06:30')
    const after = task(t.id)
    expect(after.due_at).toBeNull()
    // The ORIGINAL target is remembered (rule 2), not the 6:30 the sweep moved it to.
    expect(after.queued_from_due_at).toBe(at('2026-10-16T09:00'))
    expect(after.attempts).toBe(1) // the 6:30 target gave the new day no attempt
  })

  test('TQ-S01b: the marking sweep records the pre-sweep target; undo restores; a second sweep keeps it', () => {
    const t = makeAt('2026-10-16T08:00', { due_at: at('2026-10-16T09:00') })
    setClock('2026-10-16T21:00')
    bulkSnooze({ ...u, taskIds: [t.id], until: at('2026-10-17T08:30'), source: 'sweep' })
    expect(task(t.id)).toMatchObject({
      queue_mark: true,
      due_at: at('2026-10-17T06:30'),
      queued_from_due_at: at('2026-10-16T09:00'),
    })
    executeUndo(TEST_USER_ID)
    expect(task(t.id)).toMatchObject({
      queue_mark: false,
      due_at: at('2026-10-16T09:00'),
      queued_from_due_at: null,
    })
    executeRedo(TEST_USER_ID)
    expect(task(t.id).queued_from_due_at).toBe(at('2026-10-16T09:00'))
    // A second sweep of the marked task (its target is now 6:30) keeps the first value.
    setClock('2026-10-16T22:00')
    bulkSnooze({ ...u, taskIds: [t.id], until: at('2026-10-17T12:00'), source: 'sweep' })
    expect(task(t.id).queued_from_due_at).toBe(at('2026-10-16T09:00'))
    roll('2026-10-17T06:30')
    expect(task(t.id)).toMatchObject({ due_at: null, queued_from_due_at: at('2026-10-16T09:00') })
  })

  test('TQ-S01c: an unmarked task with a stale remembered target gets its current target', () => {
    const t = makeAt('2026-10-16T08:00', { due_at: at('2026-10-16T09:00') })
    setClock('2026-10-16T21:00')
    bulkSnooze({ ...u, taskIds: [t.id], until: at('2026-10-17T08:30'), source: 'sweep' })
    // A pick clears the mark; the remembered value from that sweep is stale.
    bulkSnooze({ ...u, taskIds: [t.id], until: at('2026-10-16T22:00') })
    expect(task(t.id)).toMatchObject({
      queue_mark: false,
      queued_from_due_at: at('2026-10-16T09:00'),
    })
    roll('2026-10-17T06:30')
    expect(task(t.id)).toMatchObject({ due_at: null, queued_from_due_at: at('2026-10-16T22:00') })
  })

  test('TQ-S02: Try Tomorrow keeps its flag while in Stripped today; the next rollover drops it', () => {
    const t = makeAt('2026-10-16T08:00', { due_at: at('2026-10-16T09:00') })
    setClock('2026-10-16T15:00')
    bulkSnooze({ ...u, taskIds: [t.id], source: 'try_tomorrow' })
    expect(task(t.id).try_tomorrow).toBe(true)
    roll('2026-10-17T06:30')
    expect(task(t.id)).toMatchObject({ due_at: null, try_tomorrow: true })
    roll('2026-10-18T06:30')
    expect(task(t.id).try_tomorrow).toBe(false)
    expect(task(t.id).queued_at).not.toBeNull()
  })

  test('TQ-S03: attempts per OpenTask day — a miss at 00:00–06:29 is the previous day', () => {
    // A night owl's 2 AM target on Sat, picked at 1 AM: Friday's OpenTask day.
    const t = makeAt('2026-10-17T01:00', { due_at: at('2026-10-17T02:00') })
    setClock('2026-10-17T02:30')
    expect(task(t.id).attempts).toBe(1)
    expect(task(t.id).attempts_counted_through).toBe('2026-10-16')
    setClock('2026-10-17T06:29')
    expect(task(t.id).attempts).toBe(1)
    // Switch off: calendar days, so 2:30 AM Saturday is Saturday.
    vi.stubEnv('OPENTASK_TASK_QUEUE', '')
    expect(task(t.id).attempts_counted_through).toBe('2026-10-17')
    vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
    // Stripped at 06:30, the count kept (no reset on strip).
    roll('2026-10-17T06:30')
    expect(task(t.id)).toMatchObject({ due_at: null, attempts: 1 })
  })
})

describe('TQ-E: early-morning picks, and the put-back', () => {
  beforeEach(() => {
    setupTestDb()
    seedPeriods()
    vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
    setClock('2026-10-17T06:00')
    stamp('2026-10-16')
  })
  afterEach(cleanup)
  afterAll(() => teardownTestDb())

  test('TQ-S06: an evening pick for early tomorrow is spared at its first rollover', () => {
    // 22:00 Fri: "tomorrow 6:00" — a pick for the coming day.
    const t = makeAt('2026-10-16T22:00', { due_at: at('2026-10-17T06:00') })
    // Over from 06:00: one attempt at once, counted for Saturday (its day).
    setClock('2026-10-17T06:10')
    expect(task(t.id)).toMatchObject({ attempts: 1, attempts_counted_through: '2026-10-17' })
    roll('2026-10-17T06:30')
    expect(task(t.id)).toMatchObject({ due_at: at('2026-10-17T06:00'), queued_at: null })
    setClock('2026-10-17T21:00')
    expect(task(t.id).attempts).toBe(1)
    // Still there at the NEXT rollover: the ordinary rule strips it, 1× kept.
    roll('2026-10-18T06:30')
    expect(task(t.id)).toMatchObject({
      due_at: null,
      queued_from_due_at: at('2026-10-17T06:00'),
      attempts: 1,
    })
  })

  test('TQ-S06b: one rule decides both the spare and the attempts day', () => {
    const tz6 = '06:30'
    // 22:00 the day before, for 06:00: an early-morning pick, its calendar day.
    expect(isEarlyMorningPick(at('2026-10-17T06:00'), at('2026-10-16T22:00'), tz, tz6)).toBe(true)
    expect(targetOpenTaskDay(at('2026-10-17T06:00'), at('2026-10-16T22:00'), tz, tz6)).toBe(
      '2026-10-17',
    )
    // The night owl's 1 AM pick of 2 AM: the evening's day.
    expect(isEarlyMorningPick(at('2026-10-17T02:00'), at('2026-10-17T01:00'), tz, tz6)).toBe(false)
    expect(targetOpenTaskDay(at('2026-10-17T02:00'), at('2026-10-17T01:00'), tz, tz6)).toBe(
      '2026-10-16',
    )
    // At the rollover or after: an ordinary target, never a pick of this kind.
    expect(isEarlyMorningPick(at('2026-10-17T06:30'), at('2026-10-16T22:00'), tz, tz6)).toBe(false)
  })

  test('TQ-S07: the boundary at exactly midnight', () => {
    // Set the evening before for exactly 00:00: spared.
    const kept = makeAt('2026-10-16T23:00', { title: 'Kept', due_at: at('2026-10-17T00:00') })
    // Set AT 00:00 for 00:00 the same calendar day: the evening's day, stripped.
    const night = makeAt('2026-10-17T00:00', { title: 'Night', due_at: at('2026-10-17T00:00') })
    // 23:59 the day before: before midnight, an ordinary leftover, stripped.
    const late = makeAt('2026-10-16T20:00', { title: 'Late', due_at: at('2026-10-16T23:59') })
    roll('2026-10-17T06:30')
    expect(task(kept.id).due_at).toBe(at('2026-10-17T00:00'))
    expect(task(night.id).due_at).toBeNull()
    expect(task(late.id).due_at).toBeNull()
  })

  test('TQ-S08: a marked early-morning task is still stripped', () => {
    // A defer always lands a mark ON the rollover (PR 1), so a mark on an
    // early-morning target only arises from a rollover time moved since; the
    // rule still strips it — the spare is for picks only.
    const t = makeAt('2026-10-16T22:00', { due_at: at('2026-10-17T06:00') })
    getDb().prepare('UPDATE tasks SET queue_mark = 1 WHERE id = ?').run(t.id)
    roll('2026-10-17T06:30')
    expect(task(t.id).due_at).toBeNull()
  })

  test('TQ-S09: a put-back between midnight and the rollover keeps the OpenTask day', () => {
    // Over target Fri 20:00 (Friday's attempt), done Sat 01:00, put back Sat 02:00.
    const t = makeAt('2026-10-16T19:00', { due_at: at('2026-10-16T20:00') })
    setClock('2026-10-17T01:00')
    markDone({ ...u, taskId: t.id })
    setClock('2026-10-17T02:00')
    markUndone({ ...u, taskId: t.id })
    expect(task(t.id)).toMatchObject({ attempts: 1, attempts_counted_through: '2026-10-16' })
    // Saturday's OpenTask day (from 06:30) over target is a new attempt.
    setClock('2026-10-17T07:00')
    expect(task(t.id).attempts).toBe(2)
  })

  test('TQ-S04: a Today tap from the queue is a new attempt', () => {
    const t = makeAt('2026-10-16T08:00', { due_at: at('2026-10-16T09:00') })
    roll('2026-10-17T06:30')
    expect(task(t.id).attempts).toBe(1)
    setClock('2026-10-17T07:00')
    targetTasksToday(TEST_USER_ID, tz, [t.id], at('2026-10-17T07:30'))
    expect(task(t.id).queued_at).toBeNull()
    expect(task(t.id).attempts).toBe(1)
    setClock('2026-10-17T08:00')
    expect(task(t.id).attempts).toBe(2)
  })

  test('TQ-S05: day start unset, no periods → the rollover is the 3:00 AM default, not morning_time', () => {
    seedPeriods([], '08:30', null)
    const t = makeAt('2026-10-16T08:00', { due_at: at('2026-10-16T09:00') })
    expect(roll('2026-10-17T02:59').ran).toBe(0)
    expect(roll('2026-10-17T03:00').stripped).toBe(1)
    expect(task(t.id).due_at).toBeNull()
  })
})

describe('TQ-P: repeating tasks at the rollover', () => {
  beforeEach(() => {
    vi.mocked(dispatchWebhookEvent).mockClear()
    setupTestDb()
    seedPeriods()
    vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
    setClock('2026-10-19T05:00')
    stamp('2026-10-18')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })
  afterAll(() => teardownTestDb())

  test('TQ-P01: a daily missed yesterday rolls to today, logged as a skip; nags normally', () => {
    const t = makeAt('2026-10-18T07:00', { rrule: 'FREQ=DAILY', due_at: at('2026-10-18T08:00') })
    const r = roll('2026-10-19T06:30')
    expect(r.rolled).toBe(1)
    const after = task(t.id)
    expect(after).toMatchObject({
      due_at: at('2026-10-19T08:00'),
      occurrence_at: at('2026-10-19T08:00'),
      skip_count: 1,
      queued_at: null,
      attempts: 0,
    })
    const row = getDb()
      .prepare("SELECT action FROM activity_log WHERE task_id = ? AND source = 'rollover'")
      .get(t.id) as { action: string }
    expect(row.action).toBe('skip')
    expect(
      vi
        .mocked(dispatchWebhookEvent)
        .mock.calls.map((c) => c[1])
        .filter((e) => e !== 'task.created'),
    ).toEqual(['task.updated', 'task.skipped'])
  })

  test('TQ-P02: a daily at 06:30 rolls to the occurrence AT the rollover', () => {
    const t = makeAt('2026-10-18T06:00', { rrule: 'FREQ=DAILY', due_at: at('2026-10-18T06:30') })
    roll('2026-10-19T06:30')
    expect(task(t.id).due_at).toBe(at('2026-10-19T06:30'))
  })

  test('TQ-P03: a manual target ahead wins (not touched)', () => {
    const t = makeAt('2026-10-18T07:00', { rrule: 'FREQ=DAILY', due_at: at('2026-10-18T08:00') })
    setClock('2026-10-18T09:00')
    bulkSnooze({ ...u, taskIds: [t.id], until: at('2026-10-19T10:00') }) // a pick
    roll('2026-10-19T06:30')
    expect(task(t.id)).toMatchObject({ due_at: at('2026-10-19T10:00'), skip_count: 0 })
  })

  test('TQ-P04: a weekly missed Monday waits; done on Wednesday lands next Monday', () => {
    // Mon 10-19 08:00, missed; the rollover is Tue 10-20.
    stamp('2026-10-19')
    const t = makeAt('2026-10-12T09:00', {
      rrule: 'FREQ=WEEKLY;BYDAY=MO',
      due_at: at('2026-10-19T08:00'),
    })
    const r = roll('2026-10-20T06:30')
    expect(r.waiting).toBe(1)
    expect(task(t.id)).toMatchObject({
      due_at: at('2026-10-26T08:00'),
      occurrence_at: at('2026-10-19T08:00'),
      queued_from_due_at: at('2026-10-19T08:00'),
      skip_count: 0,
    })
    expect(task(t.id).queued_at).not.toBeNull()
    // Still waiting on Wednesday's rollover (its occurrence hasn't come).
    roll('2026-10-21T06:30')
    expect(task(t.id).queued_at).not.toBeNull()
    setClock('2026-10-21T10:00')
    markDone({ ...u, taskId: t.id })
    expect(task(t.id)).toMatchObject({
      due_at: at('2026-10-26T08:00'),
      occurrence_at: at('2026-10-26T08:00'),
      queued_at: null,
    })
  })
})

describe('TQ-W: a wait ends on its occurrence day (spec rule 5b)', () => {
  beforeEach(() => {
    setupTestDb()
    seedPeriods()
    vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
    setClock('2026-10-19T05:00')
    stamp('2026-10-18')
  })
  afterEach(cleanup)
  afterAll(() => teardownTestDb())

  test('TQ-P05: on its occurrence day the wait ends with an auto-skip (spec rule 5b)', () => {
    stamp('2026-10-19')
    const t = makeAt('2026-10-12T09:00', {
      rrule: 'FREQ=WEEKLY;BYDAY=MO',
      due_at: at('2026-10-19T08:00'),
    })
    for (const d of ['20', '21', '22', '23', '24', '25']) roll(`2026-10-${d}T06:30`)
    expect(task(t.id).queued_at).not.toBeNull()
    // Mon 10-26 06:30: the occurrence (08:00) is this OpenTask day's — released,
    // and the missed Monday logged as a skip. Never in the queue on its day.
    expect(roll('2026-10-26T06:30').released).toBe(1)
    expect(task(t.id)).toMatchObject({
      queued_at: null,
      queued_from_due_at: null,
      due_at: at('2026-10-26T08:00'),
      occurrence_at: at('2026-10-26T08:00'),
      skip_count: 1,
      attempts: 0,
    })
    const row = getDb()
      .prepare(
        "SELECT action, metadata FROM activity_log WHERE task_id = ? AND source = 'rollover' ORDER BY id DESC",
      )
      .get(t.id) as { action: string; metadata: string }
    expect(row.action).toBe('skip')
    expect(JSON.parse(row.metadata).rollover).toBe('released')
    // Still unhandled at the NEXT rollover: it waits again, for next Monday,
    // from the occurrence it skipped to.
    roll('2026-10-27T06:30')
    expect(task(t.id)).toMatchObject({
      due_at: at('2026-11-02T08:00'),
      occurrence_at: at('2026-10-26T08:00'),
    })
    expect(task(t.id).queued_at).not.toBeNull()
  })

  test('TQ-P05b: done on the arrival day before the occurrence lands on the NEXT one', () => {
    stamp('2026-10-19')
    const t = makeAt('2026-10-12T09:00', {
      rrule: 'FREQ=WEEKLY;BYDAY=MO',
      due_at: at('2026-10-19T08:00'),
    })
    for (const d of ['20', '21', '22', '23', '24', '25', '26']) roll(`2026-10-${d}T06:30`)
    expect(task(t.id).queued_at).toBeNull()
    setClock('2026-10-26T07:00')
    markDone({ ...u, taskId: t.id })
    expect(task(t.id)).toMatchObject({
      due_at: at('2026-11-02T08:00'),
      occurrence_at: at('2026-11-02T08:00'),
    })
  })

  test('TQ-P05c: a from_completion wait is released on its day without re-anchoring', () => {
    // Every 3 days from completion; Sat 10-17 08:00 missed → waits for Tue 10-20 08:00.
    stamp('2026-10-18')
    const t = makeAt('2026-10-17T07:00', {
      rrule: 'FREQ=DAILY;INTERVAL=3',
      recurrence_mode: 'from_completion',
      due_at: at('2026-10-17T08:00'),
    })
    roll('2026-10-19T06:30')
    expect(task(t.id).due_at).toBe(at('2026-10-20T08:00'))
    roll('2026-10-20T06:30')
    expect(task(t.id)).toMatchObject({
      due_at: at('2026-10-20T08:00'),
      occurrence_at: at('2026-10-20T08:00'),
      queued_at: null,
      skip_count: 1,
    })
  })
})

describe('TQ-N: no skip that never happened, archived tasks, the guard', () => {
  beforeEach(() => {
    vi.mocked(dispatchWebhookEvent).mockClear()
    setupTestDb()
    seedPeriods()
    vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
    setClock('2026-10-19T05:00')
    stamp('2026-10-18')
  })
  afterEach(cleanup)
  afterAll(() => teardownTestDb())

  test('TQ-P08: a target pulled ahead of an occurrence and missed: the wait ends with no skip', () => {
    // Weekly Monday 08:00; on Fri the user pulls the target to Sat 09:00 and misses it.
    const t = makeAt('2026-10-19T09:00', {
      rrule: 'FREQ=WEEKLY;BYDAY=MO',
      due_at: at('2026-10-26T08:00'),
    })
    setClock('2026-10-23T10:00')
    updateTask({ ...u, taskId: t.id, input: { due_at: at('2026-10-24T09:00') } })
    for (const d of ['19', '20', '21', '22', '23', '24']) roll(`2026-10-${d}T06:30`)
    // Sun: Sat's target missed, the occurrence (Mon) not this day's — it waits.
    roll('2026-10-25T06:30')
    expect(task(t.id)).toMatchObject({ due_at: at('2026-10-26T08:00'), skip_count: 0 })
    expect(task(t.id).queued_at).not.toBeNull()
    const attempts = task(t.id).attempts
    expect(attempts).toBe(1)
    // Mon, its day: released, but nothing was passed over — no skip.
    roll('2026-10-26T06:30')
    expect(task(t.id)).toMatchObject({
      queued_at: null,
      occurrence_at: at('2026-10-26T08:00'),
      skip_count: 0,
    })
    expect(task(t.id).attempts).toBe(attempts)
    const row = getDb()
      .prepare(
        "SELECT action FROM activity_log WHERE task_id = ? AND source = 'rollover' ORDER BY id DESC",
      )
      .get(t.id) as { action: string }
    expect(row.action).toBe('edit')
  })

  test('TQ-P09: a target pulled ahead of an occurrence later the same day rolls with no skip', () => {
    const t = makeAt('2026-10-19T09:00', {
      rrule: 'FREQ=WEEKLY;BYDAY=MO',
      due_at: at('2026-10-26T08:00'),
    })
    setClock('2026-10-24T10:00')
    updateTask({ ...u, taskId: t.id, input: { due_at: at('2026-10-25T09:00') } })
    for (const d of ['19', '20', '21', '22', '23', '24', '25']) roll(`2026-10-${d}T06:30`)
    vi.mocked(dispatchWebhookEvent).mockClear()
    roll('2026-10-26T06:30')
    expect(task(t.id)).toMatchObject({
      due_at: at('2026-10-26T08:00'),
      occurrence_at: at('2026-10-26T08:00'),
      skip_count: 0,
      attempts: 1,
    })
    const row = getDb()
      .prepare(
        "SELECT action FROM activity_log WHERE task_id = ? AND source = 'rollover' ORDER BY id DESC",
      )
      .get(t.id) as { action: string }
    expect(row.action).toBe('edit')
    expect(vi.mocked(dispatchWebhookEvent).mock.calls.map((c) => c[1])).toEqual(['task.updated'])
  })

  test('TQ-P10: an archived waiting task is left alone (wait, flag, restore)', () => {
    const t = makeAt('2026-10-12T09:00', {
      rrule: 'FREQ=WEEKLY;BYDAY=MO',
      due_at: at('2026-10-19T08:00'),
    })
    getDb()
      .prepare(
        'UPDATE tasks SET queued_at = ?, try_tomorrow = 1, due_at = ?, archived_at = ? WHERE id = ?',
      )
      .run(at('2026-10-13T06:30'), at('2026-10-19T08:00'), at('2026-10-14T09:00'), t.id)
    const one = makeAt('2026-10-12T09:00', { title: 'Archived one-off' })
    getDb()
      .prepare(
        'UPDATE tasks SET queued_at = ?, queued_from_due_at = ?, archived_at = ? WHERE id = ?',
      )
      .run(at('2026-10-13T06:30'), at('2026-10-12T10:00'), at('2026-10-14T09:00'), one.id)
    const r = roll('2026-10-19T06:30')
    expect(r).toMatchObject({ released: 0, flagsCleared: 0 })
    expect(task(t.id)).toMatchObject({ try_tomorrow: true, skip_count: 0 })
    expect(task(t.id).queued_at).not.toBeNull()
    expect(findStrippedTargets(TEST_USER_ID)).toEqual([])
  })

  test('TQ-P11: a from_completion rule that cannot reach M within the guard is left alone', () => {
    const t = makeAt('2026-10-18T07:00', {
      rrule: 'FREQ=DAILY',
      recurrence_mode: 'from_completion',
      due_at: at('2026-10-18T08:00'),
    })
    // An occurrence 20 years stale: more daily steps than the guard allows.
    getDb()
      .prepare('UPDATE tasks SET occurrence_at = ? WHERE id = ?')
      .run(at('2006-10-18T08:00'), t.id)
    const r = roll('2026-10-19T06:30')
    expect(r).toMatchObject({ rolled: 0, waiting: 0 })
    expect(task(t.id)).toMatchObject({ due_at: at('2026-10-18T08:00'), queued_at: null })
  })

  test('TQ-P06: from_completion steps from the existing occurrence, never from now', () => {
    // Every 3 days from completion, last occurrence Sat 10-17 08:00 (missed).
    const t = makeAt('2026-10-17T07:00', {
      rrule: 'FREQ=DAILY;INTERVAL=3',
      recurrence_mode: 'from_completion',
      due_at: at('2026-10-17T08:00'),
    })
    roll('2026-10-19T06:30')
    // Next on the existing grid is Tue 10-20 08:00 (17 + 3), not now + 3.
    expect(task(t.id)).toMatchObject({
      due_at: at('2026-10-20T08:00'),
      occurrence_at: at('2026-10-17T08:00'),
    })
    expect(task(t.id).queued_at).not.toBeNull()
    // And a daily from_completion rolls to today at its time.
    const d = makeAt('2026-10-19T07:00', {
      rrule: 'FREQ=DAILY',
      recurrence_mode: 'from_completion',
      due_at: at('2026-10-19T09:00'),
    })
    roll('2026-10-20T06:30')
    expect(task(d.id)).toMatchObject({
      due_at: at('2026-10-20T09:00'),
      occurrence_at: at('2026-10-20T09:00'),
    })
  })

  test('TQ-P07: a High repeating task is never touched', () => {
    const t = makeAt('2026-10-18T07:00', {
      rrule: 'FREQ=DAILY',
      due_at: at('2026-10-18T08:00'),
      priority: 3,
    })
    roll('2026-10-19T06:30')
    expect(task(t.id)).toMatchObject({ due_at: at('2026-10-18T08:00'), skip_count: 0 })
  })
})

describe('TQ-O: the 3× offer by task kind (resolution 1)', () => {
  beforeEach(() => {
    setupTestDb()
    seedPeriods()
    vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
    setClock('2026-10-20T10:00')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })
  afterAll(() => teardownTestDb())

  /** A task 3 OpenTask days over target. */
  function threeDays(extra: Record<string, unknown>): Task {
    const t = makeAt('2026-10-16T08:00', { due_at: at('2026-10-18T09:00'), ...extra })
    return task(t.id)
  }

  test('TQ-O01: strippable one-off: retired; High one-off: kept; deadline: kept', () => {
    const plain = threeDays({ title: 'P2', priority: 2 })
    const high = threeDays({ title: 'High', priority: 3 })
    const deadline = threeDays({ title: 'Deadline', deadline_at: at('2026-10-30T17:00') })
    expect(plain.attempts).toBe(3)
    expect(formatTaskResponse(plain, tz).attempts_offer).toBeNull()
    expect(formatTaskResponse(high, tz).attempts_offer).toBe('remove')
    // "Back to auto" went 2026-10-22 (the deadlines page): Remove target.
    expect(formatTaskResponse(deadline, tz).attempts_offer).toBe('remove')
    // Switch off: as before.
    vi.stubEnv('OPENTASK_TASK_QUEUE', '')
    expect(formatTaskResponse(task(plain.id), tz).attempts_offer).toBe('remove')
  })

  test('TQ-O02: the web row reads the switch (PR 3) and agrees with the server', () => {
    const plain = threeDays({ title: 'P2', priority: 2 })
    const high = threeDays({ title: 'High', priority: 3 })
    // The browser passes the switch from GET /api/user/preferences
    // (`useTaskQueue`): on, no "Remove target?" on a strippable one-off.
    expect(attemptsOffer(plain, new Date(), { queue: true })).toBeNull()
    expect(formatTaskResponse(plain, tz).attempts_offer).toBeNull()
    // High and deadline tasks keep theirs.
    expect(attemptsOffer(high, new Date(), { queue: true })).toBe('remove')
    // Off: the offer, as on main.
    expect(attemptsOffer(plain, new Date(), { queue: false })).toBe('remove')
  })
})

describe('TQ-X: restoring stripped targets (the rollback script)', () => {
  beforeEach(() => {
    setupTestDb()
    seedPeriods()
    vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
    setClock('2026-10-20T06:00')
    stamp('2026-10-19')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })
  afterAll(() => teardownTestDb())

  test('TQ-X01: dry run lists; apply restores only queued, untargeted one-offs', () => {
    const a = makeAt('2026-10-19T08:00', { title: 'A', due_at: at('2026-10-19T09:00') })
    const b = makeAt('2026-10-19T08:00', { title: 'B', due_at: at('2026-10-19T10:00') })
    const weekly = makeAt('2026-10-12T09:00', {
      rrule: 'FREQ=WEEKLY;BYDAY=MO',
      due_at: at('2026-10-19T08:00'),
    })
    // c: swept last night — its remembered target is the pre-sweep one.
    const c = makeAt('2026-10-19T08:00', { title: 'C', due_at: at('2026-10-19T11:00') })
    setClock('2026-10-19T21:00')
    bulkSnooze({ ...u, taskIds: [c.id], until: at('2026-10-20T08:30'), source: 'sweep' })
    roll('2026-10-20T06:30')
    setClock('2026-10-20T07:00')
    targetTasksToday(TEST_USER_ID, tz, [b.id]) // b left the queue
    expect(findStrippedTargets(TEST_USER_ID).map((t) => t.id)).toEqual([a.id, c.id])
    expect(task(a.id).due_at).toBeNull() // a dry run writes nothing

    const restored = restoreStrippedTargets(TEST_USER_ID)
    expect(restored.map((t) => t.id)).toEqual([a.id, c.id])
    expect(task(a.id)).toMatchObject({ due_at: at('2026-10-19T09:00'), queued_at: null })
    // The swept task gets its real target back, not the 6:30 it was swept to.
    expect(task(c.id)).toMatchObject({ due_at: at('2026-10-19T11:00'), queued_at: null })
    expect(task(weekly.id).queued_at).not.toBeNull() // the waiting repeat is left alone
    expect(findStrippedTargets(TEST_USER_ID)).toEqual([])
  })
})
