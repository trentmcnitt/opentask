/**
 * RL-: PINS FOR THE RULES MAP that need the database (2026-10-30;
 * src/lib/rule-registry.ts). "Today" is Tue 2026-10-20 in Chicago, the day
 * starting at 06:30 (pinned, as in tq-rollover.test.ts); Monday's rollover has
 * already run.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
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
import { createTask, markDone } from '@/core/tasks'
import { skipOccurrence } from '@/core/tasks/skip'
import { getTaskById } from '@/core/tasks/read'
import { runTaskRollover } from '@/core/tasks/task-rollover'
import { queueStrippable } from '@/lib/task-segments'
import type { Task } from '@/types'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

const tz = TEST_TIMEZONE
const u = { userId: TEST_USER_ID, userTimezone: tz }
const at = (local: string) => DateTime.fromISO(local, { zone: tz }).toUTC().toISO()!
const setClock = (local: string) => vi.setSystemTime(new Date(at(local)))

function makeAt(madeAt: string, input: Record<string, unknown>): Task {
  const now = new Date()
  setClock(madeAt)
  try {
    return createTask({ ...u, input: { title: 'Task', ...input } })
  } finally {
    vi.setSystemTime(now)
  }
}

function seedDay() {
  const db = getDb()
  db.prepare('DELETE FROM time_slots WHERE user_id = ?').run(TEST_USER_ID)
  db.prepare(
    'INSERT INTO time_slots (user_id, label, start_time, sort_order) VALUES (?, ?, ?, ?)',
  ).run(TEST_USER_ID, 'Morning', '06:30', 0)
  db.prepare(
    'UPDATE users SET morning_time = ?, day_start_time = ?, last_rollover_date = ? WHERE id = ?',
  ).run('08:30', '06:30', '2026-10-19', TEST_USER_ID)
}

describe('RL: the rollover and the attempts reset (database)', () => {
  beforeAll(() => setupTestDb())
  beforeEach(() => {
    setupTestDb()
    seedDay()
    vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
    setClock('2026-10-20T06:00')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })
  afterAll(() => teardownTestDb())

  test('RL-TQ-ROLLOVER-WHO: the rollover strips exactly the one-offs queueStrippable names — its SQL twin ELIGIBLE_SQL agrees', () => {
    const due = at('2026-10-19T16:00')
    const kinds: [string, Record<string, unknown>][] = [
      ['None', { priority: 0 }],
      ['Medium', { priority: 2 }],
      ['High', { priority: 3 }],
      ['Urgent', { priority: 4 }],
      ['Deadline passed', { priority: 1, deadline_at: at('2026-10-19T17:00') }],
      ['Deadline ahead', { priority: 1, deadline_at: at('2026-10-25T17:00') }],
    ]
    const made = kinds.map(([title, extra]) =>
      makeAt('2026-10-19T09:00', { title, due_at: due, ...extra }),
    )
    const before = made.map((t) => getTaskById(t.id)!)
    setClock('2026-10-20T06:30')
    runTaskRollover({ now: new Date(at('2026-10-20T06:30')), userId: TEST_USER_ID })
    for (const t of before) {
      const after = getTaskById(t.id)!
      const stripped = after.due_at === null && after.queued_at !== null
      expect(stripped, t.title).toBe(queueStrippable(t))
    }
    // The kind test has both answers here.
    expect(before.filter(queueStrippable).map((t) => t.title)).toEqual(['None', 'Medium'])
  })

  test('RL-TGT-ATTEMPTS-RESET: done of a one-off, done and skip of a repeat leave attempts 0 and the checkpoint NULL', () => {
    setClock('2026-10-20T12:00')
    const oneOff = makeAt('2026-10-18T09:00', { title: 'One-off', due_at: at('2026-10-18T10:00') })
    const daily = { rrule: 'FREQ=DAILY;BYHOUR=10;BYMINUTE=0', due_at: at('2026-10-18T10:00') }
    const doneRepeat = makeAt('2026-10-18T09:00', { title: 'Done repeat', ...daily })
    const skipRepeat = makeAt('2026-10-18T09:00', { title: 'Skip repeat', ...daily })
    const db = getDb()
    const counted = db.prepare(
      "UPDATE tasks SET attempts = 3, attempts_counted_through = '2026-10-19' WHERE id = ?",
    )
    for (const t of [oneOff, doneRepeat, skipRepeat]) counted.run(t.id)

    markDone({ ...u, taskId: oneOff.id })
    markDone({ ...u, taskId: doneRepeat.id })
    skipOccurrence({ ...u, taskId: skipRepeat.id })

    const stored = db.prepare('SELECT attempts, attempts_counted_through FROM tasks WHERE id = ?')
    for (const t of [oneOff, doneRepeat, skipRepeat]) {
      expect(stored.get(t.id), t.title).toEqual({ attempts: 0, attempts_counted_through: null })
    }
  })
})

describe('RL: segments never notify (structural)', () => {
  test('RL-SEG-NEVER-NOTIFIED: the slot push, the slot nag and the badge path never import the task segments', () => {
    const ROOT = path.resolve(__dirname, '../..')
    const files = [
      'src/core/notifications/slot-reminders.ts',
      'src/core/notifications/slot-nags.ts',
      'src/core/notifications/dismiss.ts',
      'src/core/tasks/currently-due.ts',
    ]
    const importsSegments = files.filter((f) =>
      /from\s+['"][^'"]*task-segments['"]/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')),
    )
    expect(importsSegments).toEqual([])
  })
})
