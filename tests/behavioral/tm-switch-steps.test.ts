/**
 * SW-01..: THE TASK-QUEUE SWITCH'S DATA STEPS RUN IN THE SERVER ONLY
 * (2026-10-24; src/core/db/process-role.ts, `runDeadlineSteps` in
 * src/core/db/index.ts), and undo never brings an automatic target back with
 * the switch on (src/core/undo/auto-target-fence.ts) — each both ways.
 *
 * A "start" here closes and reopens the database, so `runMigrations()` runs
 * again, as a process start does; `markServerProcess()` is what
 * instrumentation's `register()` does in the server. The steps themselves
 * are covered in depth by tm-migration (migrateDeadlineTargets) and
 * tm-deadlines DL-M / DL-F (migrateDeadlineLeads), which call them directly.
 *
 * Two rows per start:
 *  - PAGE: a deadline one-off with no target, made with the switch on — on
 *    the deadlines page from its lead day;
 *  - FAKE: the same, but holding an automatic target (`target_auto = 1`, no
 *    lead day), the shape a script run used to leave behind.
 */
import { describe, test, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { DateTime } from 'luxon'
import { closeDb, getDb } from '@/core/db'
import { isServerProcess, markServerProcess, unmarkServerProcess } from '@/core/db/process-role'
import { planDeadlineTargetMigration } from '@/core/db/migrate-deadline-targets'
import { createTask, updateTask } from '@/core/tasks'
import { getTaskById } from '@/core/tasks/read'
import { executeRedo, executeUndo } from '@/core/undo'
import type { Task } from '@/types'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

const tz = TEST_TIMEZONE
const u = { userId: TEST_USER_ID, userTimezone: tz }
const DEADLINE = '2026-10-30T17:00'

function at(local: string): string {
  return DateTime.fromISO(local, { zone: tz }).toUTC().toISO()!
}
function task(id: number): Task {
  return getTaskById(id)!
}
function queue(on: boolean) {
  vi.stubEnv('OPENTASK_TASK_QUEUE', on ? '1' : '')
}
function start({ server, on }: { server: boolean; on: boolean }) {
  queue(on)
  if (server) markServerProcess()
  else unmarkServerProcess()
  closeDb()
  getDb()
}

function rows(): { page: Task; fake: Task } {
  queue(true)
  const page = createTask({ ...u, input: { title: 'Synthetic page', deadline_at: at(DEADLINE) } })
  const fake = createTask({ ...u, input: { title: 'Synthetic fake', deadline_at: at(DEADLINE) } })
  const auto = at('2026-10-27T08:30')
  getDb()
    .prepare(
      'UPDATE tasks SET due_at = ?, original_due_at = ?, target_auto = 1, lead_from = NULL WHERE id = ?',
    )
    .run(auto, auto, fake.id)
  return { page, fake: task(fake.id) }
}

beforeEach(() => {
  setupTestDb()
  getDb().prepare("UPDATE users SET morning_time = '08:30' WHERE id = ?").run(TEST_USER_ID)
  vi.setSystemTime(new Date(at('2026-10-20T10:00')))
})
afterEach(() => {
  unmarkServerProcess()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})
afterAll(() => teardownTestDb())

describe('SW: the server-vs-script rule, both ways', () => {
  test('SW-00: a process is not the server until it is marked', () => {
    expect(isServerProcess()).toBe(false)
    markServerProcess()
    expect(isServerProcess()).toBe(true)
    unmarkServerProcess()
    expect(isServerProcess()).toBe(false)
  })

  test('SW-01: server, switch on — no automatic target written; a left-over one becomes a lead', () => {
    const { page, fake } = rows()
    start({ server: true, on: true })
    expect(task(page.id)).toMatchObject({
      due_at: null,
      target_auto: false,
      lead_from: page.lead_from,
    })
    expect(task(fake.id)).toMatchObject({ due_at: null, original_due_at: null, target_auto: false })
    expect(task(fake.id).lead_from).not.toBeNull()
  })

  test('SW-02: server, switch off — the automatic target is stored (as before the deadlines page)', () => {
    const { page, fake } = rows()
    start({ server: true, on: false })
    expect(task(page.id).target_auto).toBe(true)
    expect(task(page.id).due_at).not.toBeNull()
    // The left-over one stays an automatic target: migrateDeadlineLeads does not run.
    expect(task(fake.id)).toMatchObject({ due_at: fake.due_at, target_auto: true, lead_from: null })
  })

  test('SW-03: script, env unset (the demo reset on prod) — neither direction runs', () => {
    const { page, fake } = rows()
    start({ server: false, on: false })
    expect(task(page.id)).toMatchObject({
      due_at: null,
      target_auto: false,
      lead_from: page.lead_from,
    })
    expect(task(fake.id)).toMatchObject({ due_at: fake.due_at, target_auto: true, lead_from: null })
  })

  test('SW-04: script, env set — still neither direction: only the server applies them', () => {
    const { page, fake } = rows()
    start({ server: false, on: true })
    expect(task(page.id)).toMatchObject({
      due_at: null,
      target_auto: false,
      lead_from: page.lead_from,
    })
    expect(task(fake.id)).toMatchObject({ due_at: fake.due_at, target_auto: true, lead_from: null })
  })

  test('SW-05: a script start still runs the switch-independent steps (pull-back, nag-off kept)', () => {
    queue(true)
    const late = createTask({
      ...u,
      input: { title: 'Synthetic late', deadline_at: at(DEADLINE), due_at: at('2026-10-29T09:00') },
    })
    // A target after its deadline (still ahead), and a retired nag-off flag on a picked target.
    getDb()
      .prepare('UPDATE tasks SET due_at = ?, deadline_nag_off = 1 WHERE id = ?')
      .run(at('2026-11-02T09:00'), late.id)
    start({ server: false, on: false })
    expect(task(late.id)).toMatchObject({ due_at: at(DEADLINE), target_auto: false })
    const flag = getDb()
      .prepare('SELECT deadline_nag_off FROM tasks WHERE id = ?')
      .get(late.id) as {
      deadline_nag_off: number
    }
    expect(flag.deadline_nag_off).toBe(0)
  })

  test('SW-06: the plan agrees — not the server, every switch-dependent step is empty', () => {
    const { page } = rows()
    const nagOff = createTask({
      ...u,
      input: { title: 'Synthetic nag', deadline_at: at(DEADLINE) },
    })
    const db = getDb()
    db.prepare('UPDATE tasks SET deadline_nag_off = 1 WHERE id = ?').run(nagOff.id)
    const server = planDeadlineTargetMigration(db, new Date(), { leads: false })
    expect(server.nagOffToAuto).toEqual([nagOff.id])
    expect(server.deadlineNoTargetToAuto).toEqual([page.id])
    const script = planDeadlineTargetMigration(db, new Date(), { leads: false, switchSteps: false })
    expect(script).toMatchObject({
      nagOffToAuto: [],
      deadlineNoTargetToAuto: [],
      targetlessRepeatToDefault: [],
    })
  })
})

describe('SW-U: undo and redo never write target_auto = 1 with the switch on', () => {
  /** Switch off: a deadline task on its automatic target, then a target picked. */
  function pickedOverAuto(): Task {
    queue(false)
    const t = createTask({ ...u, input: { title: 'Synthetic undo', deadline_at: at(DEADLINE) } })
    expect(t.target_auto).toBe(true)
    updateTask({ ...u, taskId: t.id, input: { due_at: at('2026-10-22T15:00') } })
    expect(task(t.id)).toMatchObject({ due_at: at('2026-10-22T15:00'), target_auto: false })
    return t
  }
  /** The clock moves on, so a stamp from the undo itself would show. */
  function later() {
    vi.setSystemTime(new Date(at('2026-10-21T11:00')))
  }

  test('SW-U01: switch off — undo puts the automatic target back, redo the pick (as before)', () => {
    const t = pickedOverAuto()
    executeUndo(TEST_USER_ID)
    expect(task(t.id)).toMatchObject({ due_at: t.due_at, target_auto: true })
    executeRedo(TEST_USER_ID)
    expect(task(t.id)).toMatchObject({ due_at: at('2026-10-22T15:00'), target_auto: false })
  })

  test('SW-U02: switch on — the undo applies WITHOUT the automatic target: no target, on the page', () => {
    const t = pickedOverAuto()
    const setAt = task(t.id).target_set_at
    queue(true)
    later()
    executeUndo(TEST_USER_ID)
    const after = task(t.id)
    // Not a picked target either: no due_at, target_auto 0, target_set_at not stamped.
    expect(after).toMatchObject({ due_at: null, original_due_at: null, target_auto: false })
    expect(after.target_set_at).not.toBe(new Date().toISOString())
    expect([setAt, t.target_set_at]).toContain(after.target_set_at)
    expect(after.lead_from).not.toBeNull()
    // Redo puts the pick back (its after has no automatic target).
    executeRedo(TEST_USER_ID)
    expect(task(t.id)).toMatchObject({ due_at: at('2026-10-22T15:00'), target_auto: false })
  })

  test('SW-U03: switch on — the redo that would restore it applies without it too', () => {
    // Switch off: "Back to auto" (clear the picked target) is an entry whose AFTER is automatic.
    const t = pickedOverAuto()
    updateTask({ ...u, taskId: t.id, input: { due_at: null } })
    expect(task(t.id).target_auto).toBe(true)
    executeUndo(TEST_USER_ID)
    expect(task(t.id)).toMatchObject({ due_at: at('2026-10-22T15:00'), target_auto: false })
    queue(true)
    later()
    executeRedo(TEST_USER_ID)
    expect(task(t.id)).toMatchObject({ due_at: null, original_due_at: null, target_auto: false })
    expect(task(t.id).lead_from).not.toBeNull()
  })

  test('SW-U04: switch on — a lead day left NULL by the restore is derived, as the startup step does', () => {
    const t = pickedOverAuto()
    // The entry's before predates the deadlines page: no lead day in it.
    getDb()
      .prepare(
        `UPDATE undo_log SET snapshot = json_set(snapshot, '$[0].before_state.lead_from', NULL),
                fields_changed = json_insert(fields_changed, '$[#]', 'lead_from')
          WHERE id = (SELECT MAX(id) FROM undo_log)`,
      )
      .run()
    // ...and holds queue state (a pre-page queued task): none of it comes back.
    getDb()
      .prepare(
        `UPDATE undo_log SET snapshot = json_set(snapshot,
                  '$[0].before_state.queued_at', '2026-10-19T11:30:00.000Z',
                  '$[0].before_state.try_tomorrow', json('true'),
                  '$[0].before_state.queue_mark', json('true')),
                fields_changed = json_insert(fields_changed, '$[#]', 'queued_at',
                  '$[#]', 'try_tomorrow', '$[#]', 'queue_mark')
          WHERE id = (SELECT MAX(id) FROM undo_log)`,
      )
      .run()
    queue(true)
    executeUndo(TEST_USER_ID)
    expect(task(t.id)).toMatchObject({
      due_at: null,
      target_auto: false,
      queued_at: null,
      try_tomorrow: false,
      queue_mark: false,
    })
    expect(task(t.id).lead_from).not.toBeNull()
  })
})
