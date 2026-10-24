/**
 * Task queue: "Roll over now" (src/core/tasks/rollover-now.ts) — the
 * rollover run by hand for one user, with M = now: the cron's rules
 * (`applyRollover`), one undo entry, no change to `last_rollover_date`.
 *
 * The user: periods 06:30 / 12:00 / 20:30 (rollover 06:30), morning_time
 * 08:30, America/Chicago. Tue 2026-10-20's rollover has run; the clock is
 * Tue 21:00 unless a test says otherwise.
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

import { getDb } from '@/core/db'
import { dismissNotificationsForTasks } from '@/core/notifications/dismiss'
import { emitSyncEvent } from '@/lib/sync-events'
import { dispatchWebhookEvent } from '@/core/webhooks/dispatch'
import { bulkSnooze, createTask, updateTask } from '@/core/tasks'
import { getTaskById } from '@/core/tasks/read'
import { getTaskSegments } from '@/core/tasks/task-segments'
import { runTaskRollover } from '@/core/tasks/task-rollover'
import { runRolloverNow } from '@/core/tasks/rollover-now'
import { executeUndo, executeRedo } from '@/core/undo'
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
function runNow(local: string, dryRun = false) {
  setClock(local)
  return runRolloverNow({ userId: TEST_USER_ID, now: new Date(at(local)), dryRun })
}
function roll(local: string) {
  setClock(local)
  return runTaskRollover({ now: new Date(at(local)), userId: TEST_USER_ID })
}
function undoCount(): number {
  return (
    getDb().prepare('SELECT COUNT(*) AS n FROM undo_log WHERE user_id = ?').get(TEST_USER_ID) as {
      n: number
    }
  ).n
}

/** The panel (segment kind) a task sits in at a Chicago wall-clock time. */
function panelOf(local: string, id: number): string | undefined {
  setClock(local)
  for (const seg of getTaskSegments(TEST_USER_ID, tz, new Date(at(local)), { queuePanels: true }))
    if (seg.tasks.some((row) => row.task.id === id)) return seg.horizon
  return undefined
}

function clearEvents() {
  vi.mocked(dispatchWebhookEvent).mockClear()
  vi.mocked(dismissNotificationsForTasks).mockClear()
  vi.mocked(emitSyncEvent).mockClear()
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
  db.prepare("UPDATE users SET day_start_time = '06:30', morning_time = '08:30' WHERE id = ?").run(
    TEST_USER_ID,
  )
  vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
  setClock('2026-10-20T21:00')
  stamp('2026-10-20')
  clearEvents()
}

/** One of each kind, made Tue morning; the clock is put back to Tue 21:00. */
function fixture() {
  const passed = makeAt('2026-10-20T08:00', { title: 'Passed', due_at: at('2026-10-20T10:00') })
  const later = makeAt('2026-10-20T08:00', { title: 'Later', due_at: at('2026-10-20T22:00') })
  const high = makeAt('2026-10-20T08:00', {
    title: 'High',
    priority: 3,
    due_at: at('2026-10-20T10:00'),
  })
  const deadline = makeAt('2026-10-20T08:00', {
    title: 'Deadline',
    due_at: at('2026-10-20T10:00'),
    deadline_at: at('2026-10-24T17:00'),
  })
  // A daily at 09:00 missed today: the next one (Wed 09:00) is after the
  // next rollover (Wed 06:30), so it waits (B3).
  const daily = makeAt('2026-10-20T08:00', {
    title: 'Daily',
    rrule: 'FREQ=DAILY',
    due_at: at('2026-10-20T09:00'),
  })
  // A daily at 23:00 whose target was pulled to 15:00 and missed: its
  // occurrence (23:00) is still ahead, before the next rollover → it rolls.
  const pulled = makeAt('2026-10-20T08:00', {
    title: 'Pulled',
    rrule: 'FREQ=DAILY',
    due_at: at('2026-10-20T23:00'),
  })
  setClock('2026-10-20T12:00')
  updateTask({ ...u, taskId: pulled.id, input: { due_at: at('2026-10-20T15:00') } })
  setClock('2026-10-20T21:00')
  clearEvents()
  return { passed, later, high, deadline, daily, pulled }
}

function hooks() {
  beforeEach(setup)
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })
  afterAll(() => teardownTestDb())
}

describe('TQ-N: roll over now — what it moves', () => {
  hooks()

  test('TQ-N01: strips passed targets, rolls / sends repeating to wait; leaves the rest', () => {
    const f = fixture()
    const r = runNow('2026-10-20T21:00')
    expect(r).toMatchObject({ stripped: 1, rolled: 1, waiting: 1, released: 0, dry_run: false })
    expect(r.ids).toEqual({
      stripped: [f.passed.id],
      rolled: [f.pulled.id],
      waiting: [f.daily.id],
      released: [],
      deck_stripped: [],
    })
    expect(task(f.passed.id)).toMatchObject({
      due_at: null,
      queued_from_due_at: at('2026-10-20T10:00'),
    })
    // Handed to the next OpenTask day: queued as of Wed's rollover; the
    // fence stamp is the run's own moment.
    expect(Date.parse(task(f.passed.id).queued_at!)).toBe(Date.parse(at('2026-10-21T06:30')))
    expect(Date.parse(task(f.passed.id).rolled_over_at!)).toBe(Date.parse(at('2026-10-20T21:00')))
    expect(task(f.pulled.id)).toMatchObject({
      due_at: at('2026-10-20T23:00'),
      occurrence_at: at('2026-10-20T23:00'),
      queued_at: null,
    })
    expect(task(f.daily.id).due_at).toBe(at('2026-10-21T09:00'))
    expect(task(f.daily.id).occurrence_at).toBe(at('2026-10-20T09:00'))
    expect(task(f.daily.id).queued_at).not.toBeNull()
    for (const t of [f.later, f.high, f.deadline]) {
      expect(task(t.id).due_at, t.title).toBe(t.due_at)
      expect(task(t.id).queued_at, t.title).toBeNull()
      expect(task(t.id).rolled_over_at, t.title).toBeNull()
    }
  })

  test('TQ-N02: stripped rows land in "Stripped today", the wait too', () => {
    const f = fixture()
    runNow('2026-10-20T21:00')
    expect(panelOf('2026-10-20T21:00', f.passed.id)).toBe('queue_today')
    expect(panelOf('2026-10-20T21:00', f.daily.id)).toBe('queue_today')
  })

  test('TQ-N02b: an evening run hands Try Tomorrow rows to the next day, flag kept', () => {
    const t = makeAt('2026-10-20T08:00', { due_at: at('2026-10-20T10:00') })
    setClock('2026-10-20T15:00')
    bulkSnooze({ ...u, taskIds: [t.id], source: 'try_tomorrow' })
    expect(task(t.id)).toMatchObject({ try_tomorrow: true, queue_mark: true })
    runNow('2026-10-20T21:00')
    expect(task(t.id)).toMatchObject({ due_at: null, try_tomorrow: true })
    expect(panelOf('2026-10-20T21:05', t.id)).toBe('queue_today')
    // Wed's rollover: still "Stripped today", the flag kept.
    roll('2026-10-21T06:30')
    expect(panelOf('2026-10-21T07:00', t.id)).toBe('queue_today')
    expect(task(t.id).try_tomorrow).toBe(true)
    // The rollover after moves it on, as for any strip.
    roll('2026-10-22T06:30')
    expect(panelOf('2026-10-22T07:00', t.id)).toBe('queue_previous')
    expect(task(t.id).try_tomorrow).toBe(false)
  })

  test('TQ-N02c: a morning run shows in "Stripped today"', () => {
    const t = makeAt('2026-10-19T08:00', { due_at: at('2026-10-20T07:00') })
    runNow('2026-10-20T07:30')
    expect(task(t.id).due_at).toBeNull()
    expect(panelOf('2026-10-20T07:31', t.id)).toBe('queue_today')
  })

  test('TQ-N03: does not touch last_rollover_date; tomorrow’s rollover runs as usual', () => {
    const f = fixture()
    runNow('2026-10-20T21:00')
    expect(stampOf()).toBe('2026-10-20')
    expect(roll('2026-10-20T23:59').ran).toBe(0)
    const r = roll('2026-10-21T06:30')
    expect(r.ran).toBe(1)
    expect(stampOf()).toBe('2026-10-21')
    // The 23:00 occurrence it rolled to was missed: the real rollover handles it.
    expect(task(f.pulled.id).due_at).not.toBe(at('2026-10-20T23:00'))
  })

  test('TQ-N04: dry run writes nothing and answers what a real run does', () => {
    fixture()
    const db = getDb()
    const dump = () =>
      JSON.stringify([
        db.prepare('SELECT * FROM tasks ORDER BY id').all(),
        db.prepare('SELECT * FROM undo_log ORDER BY id').all(),
        db.prepare('SELECT * FROM activity_log ORDER BY id').all(),
        db.prepare('SELECT * FROM users ORDER BY id').all(),
      ])
    const before = dump()
    const dry = runNow('2026-10-20T21:00', true)
    expect(dump()).toBe(before)
    expect(dry.dry_run).toBe(true)
    expect(dry.undo_id).toBeNull()
    expect(emitSyncEvent).not.toHaveBeenCalled()
    expect(dispatchWebhookEvent).not.toHaveBeenCalled()
    const real = runNow('2026-10-20T21:00')
    expect({ ...real, dry_run: true, undo_id: null }).toEqual(dry)
  })

  test('TQ-N05: the same rules as the cron — at a rollover moment they agree', () => {
    // At Wed 06:30 with Tuesday's stamp, the cron and run-now see the same M
    // (no early-morning picks or Try Tomorrow flags in the fixture — the two
    // places they differ by design).
    fixture()
    const dry = runNow('2026-10-21T06:30', true)
    const cron = roll('2026-10-21T06:30')
    expect([dry.stripped, dry.rolled, dry.waiting, dry.released]).toEqual([
      cron.stripped,
      cron.rolled,
      cron.waiting,
      cron.released,
    ])
    const touched = (
      getDb()
        .prepare('SELECT id FROM tasks WHERE rolled_over_at = ? ORDER BY id')
        .all(at('2026-10-21T06:30')) as { id: number }[]
    ).map((r) => r.id)
    const ids = [...dry.ids.stripped, ...dry.ids.rolled, ...dry.ids.waiting, ...dry.ids.released]
    expect(ids.sort((a, b) => a - b)).toEqual(touched)
  })

  test('TQ-N06: no early-morning-pick spare (a boundary rule)', () => {
    // Picked Mon 22:00 for Tue 06:00: the 06:30 cron spares it; run-now at
    // 07:00 strips it.
    stamp('2026-10-19')
    const pick = makeAt('2026-10-19T22:00', { due_at: at('2026-10-20T06:00') })
    roll('2026-10-20T06:30')
    expect(task(pick.id).due_at).toBe(at('2026-10-20T06:00'))
    expect(runNow('2026-10-20T07:00').ids.stripped).toEqual([pick.id])
  })

  test('TQ-N07: a marked task strips, remembering its pre-sweep target', () => {
    const t = makeAt('2026-10-20T08:00', { due_at: at('2026-10-20T10:00') })
    setClock('2026-10-20T20:00')
    bulkSnooze({ ...u, taskIds: [t.id], until: at('2026-10-21T08:30'), source: 'sweep' })
    expect(task(t.id).queue_mark).toBe(true)
    runNow('2026-10-20T21:00')
    expect(task(t.id)).toMatchObject({
      due_at: null,
      queue_mark: false,
      queued_from_due_at: at('2026-10-20T10:00'),
    })
  })
})

describe('TQ-N: roll over now — undo, events, refusals', () => {
  hooks()

  test('TQ-N08: one undo entry; undo restores every task, redo re-applies', () => {
    const f = fixture()
    const before = Object.fromEntries([f.passed, f.daily, f.pulled].map((t) => [t.id, task(t.id)]))
    const count = undoCount()
    const r = runNow('2026-10-20T21:00')
    expect(undoCount()).toBe(count + 1)
    expect(r.undo_id).not.toBeNull()
    const entry = getDb().prepare('SELECT action FROM undo_log WHERE id = ?').get(r.undo_id) as {
      action: string
    }
    expect(entry.action).toBe('task_rollover')

    setClock('2026-10-20T21:01')
    expect(executeUndo(TEST_USER_ID)?.tasks_affected).toBe(3)
    for (const [id, was] of Object.entries(before)) {
      const now = task(Number(id))
      for (const k of [
        'due_at',
        'occurrence_at',
        'queued_at',
        'queued_from_due_at',
        'queue_mark',
        'skip_count',
        'target_set_at',
        'attempts',
      ] as const) {
        expect(now[k], `${was.title}.${k}`).toEqual(was[k])
      }
    }

    expect(executeRedo(TEST_USER_ID)).not.toBeNull()
    expect(task(f.passed.id).due_at).toBeNull()
    expect(task(f.passed.id).queued_at).not.toBeNull()
    expect(task(f.daily.id).due_at).toBe(at('2026-10-21T09:00'))
    expect(task(f.pulled.id).due_at).toBe(at('2026-10-20T23:00'))
  })

  test('TQ-N09: the fence still blocks OLDER entries for the tasks it changed', () => {
    const a = makeAt('2026-10-20T08:00', { title: 'A', due_at: at('2026-10-20T09:00') })
    const b = makeAt('2026-10-20T08:00', {
      title: 'B (High)',
      priority: 3,
      due_at: at('2026-10-20T09:00'),
    })
    setClock('2026-10-20T10:00')
    // An ordinary snooze to 11:00 (not a mark), then the target passes.
    bulkSnooze({ ...u, taskIds: [a.id, b.id], until: at('2026-10-20T11:00') })
    expect(task(a.id).due_at).toBe(at('2026-10-20T11:00'))
    runNow('2026-10-20T21:00')
    expect(task(a.id).due_at).toBeNull()

    setClock('2026-10-20T21:01')
    executeUndo(TEST_USER_ID) // the run-now itself: A back on 11:00
    expect(task(a.id).due_at).toBe(at('2026-10-20T11:00'))
    executeUndo(TEST_USER_ID) // the older snooze: fenced for A, applied to B
    expect(task(a.id).due_at).toBe(at('2026-10-20T11:00'))
    expect(task(b.id).due_at).toBe(at('2026-10-20T09:00'))
  })

  test('TQ-N10: events after commit; activity rows say rollover, manual', () => {
    const f = fixture()
    runNow('2026-10-20T21:00')
    expect(dismissNotificationsForTasks).toHaveBeenCalledWith(
      TEST_USER_ID,
      expect.arrayContaining([f.passed.id, f.daily.id, f.pulled.id]),
    )
    expect(emitSyncEvent).toHaveBeenCalledWith(TEST_USER_ID)
    expect(dispatchWebhookEvent).toHaveBeenCalledWith(
      TEST_USER_ID,
      'task.updated',
      expect.objectContaining({
        previous_due_at: at('2026-10-20T10:00'),
        source: 'rollover',
        manual: true,
      }),
    )
    const row = getDb()
      .prepare("SELECT metadata FROM activity_log WHERE task_id = ? AND source = 'rollover'")
      .get(f.passed.id) as { metadata: string }
    expect(JSON.parse(row.metadata)).toMatchObject({ rollover: 'stripped', manual: true })
  })

  test('TQ-N11: nothing eligible → no undo entry, no events', () => {
    makeAt('2026-10-20T08:00', { due_at: at('2026-10-20T22:00') })
    clearEvents()
    const count = undoCount()
    const r = runNow('2026-10-20T21:00')
    expect(r).toMatchObject({ stripped: 0, rolled: 0, waiting: 0, released: 0, undo_id: null })
    expect(undoCount()).toBe(count)
    expect(emitSyncEvent).not.toHaveBeenCalled()
  })

  test('TQ-N12: switch off → refused (409)', () => {
    const f = fixture()
    vi.stubEnv('OPENTASK_TASK_QUEUE', '0')
    expect(() => runNow('2026-10-20T21:00')).toThrow(
      expect.objectContaining({ statusCode: 409 }) as unknown as Error,
    )
    expect(task(f.passed.id).due_at).toBe(at('2026-10-20T10:00'))
  })

  test('TQ-N13: Try Tomorrow flags survive (rows stay in Stripped today)', () => {
    stamp('2026-10-19')
    const t = makeAt('2026-10-19T08:00', { due_at: at('2026-10-19T09:00') })
    setClock('2026-10-19T15:00')
    bulkSnooze({ ...u, taskIds: [t.id], source: 'try_tomorrow' })
    roll('2026-10-20T06:30')
    expect(task(t.id)).toMatchObject({ due_at: null, try_tomorrow: true })
    runNow('2026-10-20T21:00')
    expect(task(t.id).try_tomorrow).toBe(true)
  })
})

describe('TQ-N: roll over now — run twice', () => {
  hooks()

  test('TQ-N14: run twice — the second changes nothing, and the first undoes whole', () => {
    // Settings → Advanced → Roll over now tapped again right after a run
    // (Trent, 2026-10-24: "seems dangerous"). The first run leaves nothing
    // eligible, so the second must be a no-op: no row written, no undo entry
    // (else its Undo would sit on top of the first's), no event.
    const f = fixture()
    const all = [f.passed, f.later, f.high, f.deadline, f.daily, f.pulled]
    const before = Object.fromEntries(all.map((t) => [t.id, task(t.id)]))
    const count = undoCount()
    const first = runNow('2026-10-20T21:00')
    expect(first.stripped + first.rolled + first.waiting + first.released).toBe(3)
    expect(first.undo_id).not.toBeNull()
    expect(undoCount()).toBe(count + 1)

    const db = getDb()
    const dump = () =>
      JSON.stringify([
        db.prepare('SELECT * FROM tasks ORDER BY id').all(),
        db.prepare('SELECT * FROM undo_log ORDER BY id').all(),
        db.prepare('SELECT * FROM activity_log ORDER BY id').all(),
        db.prepare('SELECT * FROM users ORDER BY id').all(),
      ])
    const afterFirst = dump()
    clearEvents()

    const second = runNow('2026-10-20T21:00')
    expect(second).toMatchObject({
      stripped: 0,
      rolled: 0,
      waiting: 0,
      released: 0,
      undo_id: null,
      dry_run: false,
    })
    expect(second.ids).toEqual({
      stripped: [],
      rolled: [],
      waiting: [],
      released: [],
      deck_stripped: [],
    })
    expect(dump()).toBe(afterFirst)
    expect(undoCount()).toBe(count + 1)
    expect(emitSyncEvent).not.toHaveBeenCalled()
    expect(dispatchWebhookEvent).not.toHaveBeenCalled()
    expect(dismissNotificationsForTasks).not.toHaveBeenCalled()

    // The first run is still the newest entry, and its Undo puts every task
    // back (all but `rolled_over_at`, the fence stamp, which stays — TQ-N09).
    const newest = db
      .prepare('SELECT id FROM undo_log WHERE user_id = ? AND undone = 0 ORDER BY id DESC LIMIT 1')
      .get(TEST_USER_ID) as { id: number }
    expect(newest.id).toBe(first.undo_id)
    setClock('2026-10-20T21:01')
    expect(executeUndo(TEST_USER_ID)?.tasks_affected).toBe(3)
    for (const [id, was] of Object.entries(before)) {
      const now = task(Number(id))
      for (const k of [
        'due_at',
        'occurrence_at',
        'queued_at',
        'queued_from_due_at',
        'queue_mark',
        'skip_count',
        'target_set_at',
        'attempts',
      ] as const) {
        expect(now[k], `${was.title}.${k}`).toEqual(was[k])
      }
    }
  })
})
