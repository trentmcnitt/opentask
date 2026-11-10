/**
 * THE BANNER RECONCILE (2026-11-10; src/core/notifications/stale.ts and
 * apns-dismiss-batch.ts). `nr-` tests:
 *  - NR-01 a named reminder banner stands while it waits, is stale once considered;
 *  - NR-02 an overdue task banner stands while overdue, is stale once done or
 *    deferred; a fake or another user's id is stale;
 *  - NR-03 a banner with a taskId and no icon (AI finished) is stale only when
 *    the task is gone or done — never for not being overdue;
 *  - NR-04 a prompt banner of another day is stale;
 *  - NR-05 a period banner: stale before its period opens and once nothing it
 *    counts is waiting; stands while something is;
 *  - NR-06 the deadlines banner: stands while a page row waits, stale once it
 *    is considered, and with the task queue off;
 *  - NR-07 banners the rules don't know (summary, sweep result) never are;
 *  - NR-08 dismisses in one window go out as ONE APNs push, the union.
 *
 * Synthetic data only. Clock frozen: Tue 2026-10-20 10:00 in the test zone
 * (America/Chicago). Periods 06:30, 12:00, 20:30; the day starts at 06:30.
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
vi.mock('@/core/notifications/apns', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/core/notifications/apns')>()),
  isApnsConfigured: vi.fn().mockReturnValue(true),
  dismissApnsNotifications: vi.fn().mockResolvedValue(undefined),
}))

import { getDb } from '@/core/db'
import { createTask, markDone, updateTask } from '@/core/tasks'
import { considerTasks } from '@/core/tasks/task-segments'
import { staleBannerIds, type DeliveredBannerInfo } from '@/core/notifications/stale'
import {
  DISMISS_WINDOW_MS,
  dropApnsDismiss,
  flushApnsDismiss,
  queueApnsDismiss,
} from '@/core/notifications/apns-dismiss-batch'
import { dismissApnsNotifications } from '@/core/notifications/apns'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

const tz = TEST_TIMEZONE
const at = (local: string) => DateTime.fromISO(local, { zone: tz }).toUTC().toISO()!
const NOW = () => new Date()

function make(input: Record<string, unknown>) {
  return createTask({
    userId: TEST_USER_ID,
    userTimezone: tz,
    input: { title: 'Synthetic', ...input },
  })
}
function slotId(start: string): number {
  return (
    getDb()
      .prepare('SELECT id FROM time_slots WHERE user_id = ? AND start_time = ?')
      .get(TEST_USER_ID, start) as { id: number }
  ).id
}
const stale = (banners: DeliveredBannerInfo[]) => staleBannerIds(TEST_USER_ID, banners, NOW())

beforeEach(() => {
  setupTestDb()
  const db = getDb()
  db.prepare('DELETE FROM time_slots WHERE user_id = ?').run(TEST_USER_ID)
  const insert = db.prepare(
    'INSERT INTO time_slots (user_id, label, start_time, sort_order) VALUES (?, ?, ?, ?)',
  )
  ;['06:30', '12:00', '20:30'].forEach((s, i) => insert.run(TEST_USER_ID, `Period ${i}`, s, i))
  db.prepare(
    "UPDATE users SET day_start_time = '06:30', last_rollover_date = '2026-10-20' WHERE id = ?",
  ).run(TEST_USER_ID)
  vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(at('2026-10-20T10:00')))
  vi.clearAllMocks()
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})
afterAll(() => teardownTestDb())

describe('NR-01 named reminder banners', () => {
  test('stands while it waits in an opened period; stale once considered', () => {
    const task = make({ is_reminder: true, due_at: at('2026-10-20T07:00'), priority: 2 })
    const banner = { id: `reminder-${task.id}`, task_id: task.id, icon: 'reminder' }
    expect(stale([banner])).toEqual([])
    markDone({ userId: TEST_USER_ID, userTimezone: tz, taskId: task.id })
    expect(stale([banner])).toEqual([banner.id])
  })
})

describe('NR-02 overdue task banners', () => {
  test('stands while overdue; stale once done, or moved ahead', () => {
    const a = make({ due_at: at('2026-10-20T08:00'), priority: 2 })
    const b = make({ due_at: at('2026-10-20T08:30'), priority: 2 })
    const banners = [
      { id: `task-${a.id}`, task_id: a.id, icon: 'task' },
      { id: `task-${b.id}`, task_id: b.id, icon: 'task' },
    ]
    expect(stale(banners)).toEqual([])
    markDone({ userId: TEST_USER_ID, userTimezone: tz, taskId: a.id })
    updateTask({
      userId: TEST_USER_ID,
      userTimezone: tz,
      taskId: b.id,
      input: { due_at: at('2026-10-20T15:00') },
    })
    expect(stale(banners)).toEqual([`task-${a.id}`, `task-${b.id}`])
  })

  test("a fake id, and another user's task, are stale", () => {
    const db = getDb()
    db.prepare(
      "INSERT OR IGNORE INTO users (id, email, name, password_hash, timezone) VALUES (77, 'nr@example.com', 'nr', 'x', ?)",
    ).run(tz)
    const theirs = db
      .prepare(
        "INSERT INTO tasks (user_id, project_id, title, due_at) VALUES (77, (SELECT id FROM projects WHERE owner_id = ? LIMIT 1), 'Theirs', ?) RETURNING id",
      )
      .get(TEST_USER_ID, at('2026-10-20T08:00')) as { id: number }
    expect(
      stale([
        { id: 'task-999999303', task_id: 999999303, icon: 'task' },
        { id: 'theirs', task_id: theirs.id, icon: 'task' },
      ]),
    ).toEqual(['task-999999303', 'theirs'])
  })
})

describe('NR-03 a taskId with no icon', () => {
  test('stands while the task is open, even far from overdue; stale once done', () => {
    const task = make({ due_at: at('2026-10-25T09:00') })
    const banner = { id: `enriched-${task.id}`, task_id: task.id }
    expect(stale([banner])).toEqual([])
    markDone({ userId: TEST_USER_ID, userTimezone: tz, taskId: task.id })
    expect(stale([banner])).toEqual([banner.id])
  })
})

describe('NR-04 prompt banners', () => {
  test("another day's key, or a key nothing stands for, is stale", () => {
    expect(
      stale([
        { id: 'p-old', task_id: 5, prompt_key: 'q:5:0:2026-10-19', icon: 'quota' },
        { id: 'p-none', task_id: 5, prompt_key: 'q:5:0:2026-10-20', icon: 'quota' },
      ]),
    ).toEqual(['p-old', 'p-none'])
  })
})

describe('NR-05 period banners', () => {
  test('stale before the period opens; stands while it holds a reminder; stale once none waits', () => {
    const task = make({ is_reminder: true, due_at: at('2026-10-20T07:00'), priority: 1 })
    const opened = { id: 'slot-a', slot_id: slotId('06:30'), icon: 'period' }
    const ahead = { id: 'slot-b', slot_id: slotId('20:30'), icon: 'period' }
    expect(stale([opened, ahead])).toEqual(['slot-b'])
    markDone({ userId: TEST_USER_ID, userTimezone: tz, taskId: task.id })
    expect(stale([opened])).toEqual(['slot-a'])
  })
})

describe('NR-06 the deadlines banner', () => {
  test('stands while a page row waits; stale once it is considered', () => {
    // On the page from its lead day, outside the safety net (a net row keeps
    // nagging after a consider: only a target or Done ends it).
    const task = make({ deadline_at: at('2026-10-27T23:59'), lead_days: 7, priority: 2 })
    const banner = { id: 'deadlines-nag', kind: 'deadlines', icon: 'deadline' }
    expect(stale([banner])).toEqual([])
    considerTasks(TEST_USER_ID, [task.id])
    expect(stale([banner])).toEqual(['deadlines-nag'])
  })

  test('a safety-net row still waiting holds it; the task queue off: no page, so stale', () => {
    const net = make({ deadline_at: at('2026-10-21T23:59'), priority: 2 })
    considerTasks(TEST_USER_ID, [net.id])
    expect(stale([{ id: 'deadlines-nag', kind: 'deadlines' }])).toEqual([])
    vi.stubEnv('OPENTASK_TASK_QUEUE', '')
    expect(stale([{ id: 'deadlines-nag', kind: 'deadlines' }])).toEqual(['deadlines-nag'])
  })
})

describe('NR-07 banners the rules do not know', () => {
  test('a summary, a sweep result, a deadline cap: never stale', () => {
    expect(
      stale([
        { id: 'summary' },
        { id: 'sweep-result', kind: 'sweep-result' },
        { id: 'deadline-cap', kind: 'deadline-cap' },
      ]),
    ).toEqual([])
  })
})

describe('NR-08 one APNs dismiss per window', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    dropApnsDismiss(TEST_USER_ID)
  })

  test('the window gathers every dismiss into one push carrying the union', async () => {
    queueApnsDismiss(TEST_USER_ID, [1, 2])
    queueApnsDismiss(TEST_USER_ID, [2, 3], ['q:3:0:2026-10-20'])
    expect(dismissApnsNotifications).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(DISMISS_WINDOW_MS)
    expect(dismissApnsNotifications).toHaveBeenCalledTimes(1)
    expect(dismissApnsNotifications).toHaveBeenCalledWith(
      TEST_USER_ID,
      [1, 2, 3],
      ['q:3:0:2026-10-20'],
    )
  })

  test('a fixed window: a steady stream still flushes when the first one ends', async () => {
    queueApnsDismiss(TEST_USER_ID, [1])
    await vi.advanceTimersByTimeAsync(DISMISS_WINDOW_MS - 1000)
    queueApnsDismiss(TEST_USER_ID, [2])
    await vi.advanceTimersByTimeAsync(1000)
    expect(dismissApnsNotifications).toHaveBeenCalledWith(TEST_USER_ID, [1, 2], undefined)
    queueApnsDismiss(TEST_USER_ID, [3])
    await flushApnsDismiss(TEST_USER_ID)
    expect(dismissApnsNotifications).toHaveBeenLastCalledWith(TEST_USER_ID, [3], undefined)
  })

  test('a dismiss-all drops the pending one', async () => {
    queueApnsDismiss(TEST_USER_ID, [1])
    dropApnsDismiss(TEST_USER_ID)
    await vi.advanceTimersByTimeAsync(DISMISS_WINDOW_MS)
    expect(dismissApnsNotifications).not.toHaveBeenCalled()
  })
})
