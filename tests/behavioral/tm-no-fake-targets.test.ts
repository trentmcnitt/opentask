/**
 * NF-G01..: NO FAKE AUTOMATIC TARGETS (Trent, 2026-10-24). With the task-queue
 * switch on, nothing may ever write `target_auto = 1`: a deadline with no
 * target sits on the deadlines page from its lead day.
 *
 * THE BUG THIS GUARDS: `runMigrations()` runs on every `getDb()`, in every
 * process, and the switch lives in the server's environment only. A tsx
 * script opening the production database (the 4-hourly demo reset,
 * create-token) ran the switch-OFF data step and stored an automatic target
 * on every deadlines-page task; the server's next start converted it back.
 * The switch-dependent steps now run in the server only
 * (src/core/db/process-role.ts, `runDeadlineSteps` in src/core/db/index.ts).
 *
 * NF-G01 is the behavioural guard: a script-context start with the env var
 * unset leaves such a task exactly as the server left it — with a positive
 * control (a server start with the switch off DOES write the automatic
 * target), so the guard cannot pass vacuously.
 *
 * NF-G02 is the source guard, in the style of TQ-G01 (tq-day-guard.test.ts):
 * every statement in src/core and src/app/api that can write `target_auto`
 * with a value other than 0 — an SQL `target_auto = 1 | ? | true` outside a
 * WHERE, a `'target_auto'` column named to a generic writer, an INSERT INTO
 * tasks naming the column — is on the allowlist below with its reason and the
 * GATE that keeps it from writing 1 with the switch on (a string that must
 * occur in the same file). A new writer fails NF-G02a; a writer that goes
 * away fails NF-G02b, so the list stays exact.
 */
import { describe, test, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { DateTime } from 'luxon'
import { closeDb, getDb } from '@/core/db'
import { markServerProcess, unmarkServerProcess } from '@/core/db/process-role'
import { createTask } from '@/core/tasks'
import { getTaskById } from '@/core/tasks/read'
import type { Task } from '@/types'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

const tz = TEST_TIMEZONE
const u = { userId: TEST_USER_ID, userTimezone: tz }

function at(local: string): string {
  return DateTime.fromISO(local, { zone: tz }).toUTC().toISO()!
}
function task(id: number): Task {
  return getTaskById(id)!
}

/** Close and reopen the database: `runMigrations()` runs again, as a process start does. */
function start({ server, queue }: { server: boolean; queue: boolean }) {
  vi.stubEnv('OPENTASK_TASK_QUEUE', queue ? '1' : '')
  if (server) markServerProcess()
  else unmarkServerProcess()
  closeDb()
  getDb()
}

describe('NF-G01: a script start never writes a fake automatic target', () => {
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

  /** A deadline one-off with no target, made with the switch on: on the deadlines page. */
  function deadlinesPageTask(): Task {
    vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
    const t = createTask({
      ...u,
      input: { title: 'Synthetic task', deadline_at: at('2026-10-30T17:00') },
    })
    expect(t).toMatchObject({ due_at: null, target_auto: false })
    expect(t.lead_from).not.toBeNull()
    return t
  }

  test('NF-G01: switch on at the server, a script start (env unset) leaves the task untouched', () => {
    const t = deadlinesPageTask()
    start({ server: false, queue: false })
    expect(task(t.id)).toMatchObject({
      due_at: null,
      original_due_at: null,
      target_auto: false,
      lead_from: t.lead_from,
    })
  })

  test('NF-G01b (positive control): a SERVER start with the switch off does write the automatic target', () => {
    const t = deadlinesPageTask()
    start({ server: true, queue: false })
    const after = task(t.id)
    expect(after.target_auto).toBe(true)
    expect(after.due_at).not.toBeNull()
  })

  test('NF-G01c: and a server start with the switch on leaves it untouched too', () => {
    const t = deadlinesPageTask()
    start({ server: true, queue: true })
    expect(task(t.id)).toMatchObject({ due_at: null, target_auto: false, lead_from: t.lead_from })
  })
})

// ===========================================================================
// NF-G02: the source guard
// ===========================================================================

const ROOT = process.cwd()
const SCAN_DIRS = ['src/core', 'src/app/api']

const RESOLVE =
  'its value is `resolveTarget(…, { leads: taskQueueEnabled() })`.auto — with the switch on an automatic target is only ever KEPT (an existing one, unchanged), never turned on'
const UNDO =
  'undo/redo write a snapshot back; with the switch on `withoutAutoTarget` (auto-target-fence.ts) applies every snapshot that would write a truthy target_auto WITHOUT it: due_at / original_due_at NULL, target_auto 0'

/** `file: trimmed line` → [occurrences, reason, gate — a string that must occur in that file]. */
const ALLOWLIST: Record<string, [number, string, string]> = {
  'src/core/db/migrate-deadline-targets.ts: `UPDATE tasks SET due_at = ?, original_due_at = ?, target_auto = 1, deadline_nag_off = 0':
    [
      1,
      'the switch-OFF automatic target (steps 2 and 4): runs only with `leads` false AND `switchSteps` — which `runMigrations` sets in the server only (isServerProcess), never in a script',
      'switchSteps',
    ],
  'src/core/tasks/create.ts: INSERT INTO tasks … target_auto': [
    1,
    `createTask: ${RESOLVE} (a new task has nothing to keep)`,
    'leads: taskQueueEnabled()',
  ],
  "src/core/tasks/helpers/collect-field-changes.ts: trackField(data, 'target_auto', task.target_auto, target.auto, undefined, target.auto ? 1 : 0)":
    [
      1,
      `PATCH, bulk edit, snooze, snooze-overdue (collectFieldChanges): ${RESOLVE}`,
      'leads: taskQueueEnabled()',
    ],
  "src/core/ai/enrichment.ts: changes.setClauses.push('target_auto = ?')": [
    1,
    `AI enrichment: ${RESOLVE}`,
    'leads: taskQueueEnabled()',
  ],
  "src/core/ai/enrichment.ts: changes.fieldsChanged.push('target_auto')": [
    1,
    'AI enrichment: the same write as its SET clause (its undo snapshot field)',
    'leads: taskQueueEnabled()',
  ],
  "src/core/undo/apply-fields.ts: 'target_auto',": [
    1,
    `the undo/redo column allowlist: ${UNDO}`,
    'target_auto',
  ],
  "src/core/undo/apply-fields.ts: const FLAG_COLUMNS = new Set(['deadline_nag_off', 'target_auto', 'queue_mark', 'try_tomorrow'])":
    [1, `the undo/redo boolean columns: ${UNDO}`, 'target_auto'],
  "src/core/undo/auto-target-fence.ts: 'target_auto',": [
    1,
    "the undo fence's drop list: these columns are written as NULL / 0 in place of a snapshot's automatic target — never 1",
    'target_auto: false',
  ],
  "src/core/undo/auto-target-fence.ts: fieldsChanged.includes('target_auto') &&": [
    1,
    'not a write: the undo fence itself, reading whether a snapshot would write target_auto',
    'taskQueueEnabled()',
  ],
  "src/core/tasks/read.ts: 'target_auto',": [
    1,
    'not a write: the SELECT column list `rowToTask` reads',
    'TASK_COLUMNS',
  ],
}

/** Every .ts file under the scanned dirs. */
function sources(): string[] {
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) return walk(p)
      return /\.tsx?$/.test(e.name) ? [p] : []
    })
  return SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d)))
}

const isComment = (line: string) => /^(\/\/|\*|\/\*)/.test(line)

/**
 * An SQL assignment of a non-zero value: `target_auto = 1`, `= ?` or `= true`,
 * not table-qualified (`t.target_auto` is a WHERE: SQLite's SET takes bare
 * columns) and not after a WHERE on the same line. Not `===` / `==`.
 */
const SQL_WRITE = /(?<![.\w])target_auto\s*=\s*(?:1\b|true\b|\?)/
/** The column named as a string — to a generic writer (trackField, setClauses, undo). */
const NAMED = /'target_auto'/

function flagged(): Map<string, number> {
  const found = new Map<string, number>()
  const add = (key: string) => found.set(key, (found.get(key) ?? 0) + 1)
  for (const file of sources()) {
    const rel = path.relative(ROOT, file)
    const text = fs.readFileSync(file, 'utf8')
    for (const raw of text.split('\n')) {
      const line = raw.trim()
      if (!line || isComment(line)) continue
      const sql = SQL_WRITE.exec(line)
      if (sql && !/\bWHERE\b/i.test(line.slice(0, sql.index))) add(`${rel}: ${line}`)
      else if (NAMED.test(line) && !/\bhasColumn\(/.test(line)) add(`${rel}: ${line}`)
    }
    // An INSERT naming the column: one entry per statement.
    for (const m of text.matchAll(/`[^`]*`/g)) {
      if (/INSERT\s+INTO\s+tasks\b/i.test(m[0]) && /\btarget_auto\b/.test(m[0])) {
        add(`${rel}: INSERT INTO tasks … target_auto`)
      }
    }
  }
  return found
}

describe('NF-G02: every writer of target_auto = 1 in src/ is switch-gated and listed', () => {
  const found = flagged()

  test('NF-G02a: nothing outside the allowlist can write target_auto = 1', () => {
    const offenders = [...found.keys()].filter((key) => !(key in ALLOWLIST))
    expect(offenders).toEqual([])
  })

  test('NF-G02b: the allowlist is exact — every entry still occurs, as often as it says', () => {
    const stale = Object.entries(ALLOWLIST)
      .filter(([key, [count]]) => found.get(key) !== count)
      .map(([key, [count]]) => `${key} (listed ${count}, found ${found.get(key) ?? 0})`)
    expect(stale).toEqual([])
  })

  test('NF-G02c: every entry gives its reason, and its gate is still in its file', () => {
    for (const [key, [, reason, gate]] of Object.entries(ALLOWLIST)) {
      expect(reason.length, key).toBeGreaterThan(10)
      const file = key.slice(0, key.indexOf(': '))
      expect(fs.readFileSync(path.join(ROOT, file), 'utf8'), `${key} — gate "${gate}"`).toContain(
        gate,
      )
    }
  })
})
