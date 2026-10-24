/**
 * THE UPGRADE TEST (2026-10-24): this change's code opened on a database an
 * older release made — the path every deploy takes, and the one no other
 * suite does (every other test database is built fresh).
 *
 * WHY: getDb() runs schema.sql and THEN runMigrations(). On an existing
 * database each CREATE TABLE IF NOT EXISTS is skipped, so schema.sql sees the
 * OLD tables: a CREATE INDEX on a column only a migration adds fails on "no
 * such column" before the migration can run. That took prod down on
 * 2026-10-24 (`idx_tasks_target_slot`, rolled back). The same class covers a
 * migration whose column or index never reaches an old table, a default or
 * NOT NULL that differs from a fresh install, and a startup backfill that
 * throws on real rows.
 *
 * Two starting databases (tests/upgrade/start-dbs.ts) — the previous
 * release's schema.sql, and a production-shaped schema replayed through every
 * release since 2026-02 (tests/fixtures/schema/prod-shape.sql) — each seeded
 * with a few synthetic rows, each opened with the task-queue switch off and
 * on (the switch picks which startup data steps run), as the SERVER
 * (`markServerProcess`, so the server-only steps run too). Then:
 *   1. it opens — schema.sql and runMigrations() run without an error;
 *   2. it has every table, column and index a fresh database has, declared
 *      the same (tests/upgrade/schema-shape.ts);
 *   3. the startup data steps did their work on its rows;
 *   4. core calls work on it: the task list, GET /api/reminders' reads, the
 *      task rollover, the quota period rollover, create + update + done and
 *      undo of each;
 *   5. nothing was logged at error level.
 *
 * `npm run test:upgrade`; UPGRADE_BASE_REF picks the base (default
 * origin/main). CI runs it on every PR and push (the Upgrade job).
 */

import { afterAll, beforeAll, describe, expect, test, vi, type MockInstance } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { baseRef, buildStartDb, TZ, USER_A, USER_B, type StartKind } from './start-dbs'
import { describeSchema, schemaGaps, type SchemaShape } from './schema-shape'

/**
 * The old DEFAULTs a long-lived `users` table keeps (SQLite cannot change a
 * column's default without rebuilding the table), each harmless for the
 * reason given. A DEFAULT only applies to an INSERT that omits the column.
 * Add one only with its reason: a new entry means a long-lived database
 * behaves differently from a fresh one.
 */
const ALLOWED_DRIFT: Record<string, { legacyDefault: string | null; why: string }> = {
  'users.timezone': {
    legacyDefault: "'America/Chicago'",
    why: 'every INSERT INTO users names its timezone (create-user requires one)',
  },
  'users.default_sort': {
    legacyDefault: "'due_date'",
    // seed-demo.ts and seed-dev.ts omitted it until this test found it (10-24).
    why: "the scripts that create users on a real database (create-user, seed-demo, seed-dev) set default_sort = 'horizon' explicitly",
  },
  'users.priority_display': {
    legacyDefault: `'{"trailingDot":true,"colorTitle":false,"rightBorder":false}'`,
    why: 'read merged over DEFAULT_PRIORITY_DISPLAY (GET /api/user/preferences), so the missing keys read as the defaults',
  },
}

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'opentask-upgrade-'))
const NOW = new Date()
const ENV_KEYS = ['OPENTASK_DB_PATH', 'OPENTASK_TASK_QUEUE'] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))

type DbModule = typeof import('@/core/db')

/** A new instance of the app's modules, pointed at `dbPath` (DB_PATH is read at import). */
async function appCodeFor(dbPath: string, queue: boolean): Promise<DbModule> {
  vi.resetModules()
  process.env.OPENTASK_DB_PATH = dbPath
  if (queue) process.env.OPENTASK_TASK_QUEUE = '1'
  else delete process.env.OPENTASK_TASK_QUEUE
  ;(await import('@/core/db/process-role')).markServerProcess()
  return import('@/core/db')
}

let fresh: SchemaShape

beforeAll(async () => {
  const db = await appCodeFor(path.join(WORK, 'fresh.db'), false)
  fresh = describeSchema(db.getDb())
  db.closeDb()
})

afterAll(async () => {
  ;(await import('@/core/db/process-role')).unmarkServerProcess()
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  fs.rmSync(WORK, { recursive: true, force: true })
})

const SCENARIOS: [StartKind, boolean][] = [
  ['base', false],
  ['base', true],
  ['prod-shape', false],
  ['prod-shape', true],
]

describe.each(SCENARIOS)('upgrading the %s schema (task queue on: %s)', (kind, queue) => {
  const dbPath = path.join(WORK, `${kind}-${queue ? 'queue' : 'plain'}.db`)
  let dbModule: DbModule
  let openError: unknown
  let errorSpy: MockInstance<typeof console.error>

  beforeAll(async () => {
    buildStartDb(kind, dbPath, NOW)
    dbModule = await appCodeFor(dbPath, queue)
    errorSpy = vi.spyOn(console, 'error')
    try {
      dbModule.getDb()
    } catch (err) {
      openError = err
    }
  })

  afterAll(() => {
    dbModule?.closeDb()
    errorSpy.mockRestore()
  })

  function opened(): Database.Database {
    if (openError) throw openError
    return dbModule.getDb()
  }

  test(`opens: schema.sql and runMigrations() run on it (base: ${kind === 'base' ? baseRef() : 'the fixture'})`, () => {
    expect(openError, String(openError)).toBeUndefined()
  })

  test('has every table, column and index a fresh database has', () => {
    expect(schemaGaps(fresh, describeSchema(opened()), ALLOWED_DRIFT)).toEqual([])
  })

  test('the startup data steps did their work on its rows', () => {
    const db = opened()
    const one = <T>(sql: string, ...args: unknown[]) => db.prepare(sql).get(...args) as T
    // backfillLabelRegistry: a task's label and a styled one.
    const labels = db.prepare('SELECT name FROM labels WHERE user_id = ?').all(USER_A) as {
      name: string
    }[]
    expect(labels.map((l) => l.name)).toEqual(expect.arrayContaining(['errand', 'styled-only']))
    // backfillTimeSlots: the user with none gets the defaults; the other keeps its two.
    expect(
      one<{ n: number }>('SELECT COUNT(*) n FROM time_slots WHERE user_id = ?', USER_B).n,
    ).toBe(5)
    expect(
      one<{ n: number }>('SELECT COUNT(*) n FROM time_slots WHERE user_id = ?', USER_A).n,
    ).toBe(2)
    // stampRolloverDates, restoreProjectGrouping, clearQuotaDueDates.
    const b = one<{ last_rollover_date: string | null }>(
      'SELECT last_rollover_date FROM users WHERE id = ?',
      USER_B,
    )
    expect(b.last_rollover_date).not.toBeNull()
    const groupings = db.prepare('SELECT DISTINCT default_grouping g FROM users').all()
    expect(groupings).toEqual([{ g: 'project' }])
    expect(
      one<{ due_at: string | null }>('SELECT due_at FROM tasks WHERE id = 4').due_at,
    ).toBeNull()
  })

  test('core calls work on it: reads, both rollovers, writes and undo', async () => {
    opened()
    const tasks = await import('@/core/tasks')
    const { getRemindersBySlot, getRemindersNotToday } = await import('@/core/tasks/reminders')
    const { getQuotaPromptsBySlot } = await import('@/core/tasks/quota-prompts')
    const { getTaskSegments } = await import('@/core/tasks/task-segments')
    const { runTaskRollover } = await import('@/core/tasks/task-rollover')
    const { validateTaskCreate, validateTaskUpdate } = await import('@/core/validation')
    const { executeUndo } = await import('@/core/undo')
    const { formatTaskResponse } = await import('@/lib/format-task')
    const ctx = { userId: USER_A, userTimezone: TZ }

    // Reads: the task list and GET /api/reminders' calls, formatted as the routes do.
    const list = tasks.getTasks({ userId: USER_A })
    expect(list.map((t) => t.id).sort()).toEqual([1, 2, 3, 4, 5, 6])
    list.forEach((t) => formatTaskResponse(t, TZ))
    getRemindersBySlot(USER_A, TZ, NOW).forEach((g) =>
      g.reminders.forEach((t) => formatTaskResponse(t, TZ)),
    )
    getRemindersNotToday(USER_A, TZ, NOW)
    getQuotaPromptsBySlot(USER_A, TZ, NOW)
    const flags = {
      queuePanels: true,
      deckRows: true,
      deadlineRows: true,
      handledRows: true,
      fill: true,
    }
    getTaskSegments(USER_A, TZ, NOW, flags)

    // The task rollover (seeded two days back, so it has a day to run) and
    // the quota period rollover (the quota's week ended).
    const rolled = runTaskRollover({ now: NOW, userId: USER_A })
    expect(rolled.stamped).toBe(1)
    expect(rolled.ran).toBe(queue ? 1 : 0)
    expect(tasks.rolloverTrackedPeriods(NOW, USER_A).rolled).toBeGreaterThan(0)

    // Writes, each undone.
    const created = tasks.createTask({
      ...ctx,
      input: validateTaskCreate({ title: 'Upgrade smoke', project_id: 1 }),
    })
    tasks.updateTask({
      ...ctx,
      taskId: created.id,
      input: validateTaskUpdate({ title: 'Upgrade smoke, renamed', priority: 2 }),
    })
    const before = tasks.getTaskById(3)!
    const done = tasks.markDone({ ...ctx, taskId: 3 })
    expect(done.task.due_at).not.toBe(before.due_at)

    expect(executeUndo(USER_A)).not.toBeNull()
    expect(tasks.getTaskById(3)!.due_at).toBe(before.due_at)
    expect(executeUndo(USER_A)).not.toBeNull()
    expect(tasks.getTaskById(created.id)!.title).toBe('Upgrade smoke')
    expect(executeUndo(USER_A)).not.toBeNull()
    expect(tasks.getTaskById(created.id)!.deleted_at).not.toBeNull()
  })

  test('logged nothing at error level', () => {
    opened()
    expect(errorSpy.mock.calls).toEqual([])
  })
})
