/**
 * THE DEADLINES NAG (2026-10-22; src/core/notifications/deadline-nags.ts,
 * nag-ladder.ts, notifiable-users.ts). `dn-` tests:
 *  - the ladder table (overdue as set; considering ×2 at every priority; the
 *    safety net's hourly floor);
 *  - pacing by the most demanding waiting row, and what leaves the count
 *    (seen, decks) — seen never silences the safety net;
 *  - `nag_sends`: claim once per interval, minute grid, restart-safe, a
 *    double tick sends once, downtime sends at the first tick;
 *  - who is notified (`notifiableUsers`: on, not demo), the switch;
 *  - the banner's words and payloads (silent, counts only, collapse/tag
 *    `deadlines-page`, the deep link), and the overdue web push's tag (#6).
 *
 * Synthetic data only. Clock frozen: Tue 2026-10-20 10:00 America/Chicago,
 * rollover 06:30 (the first period's start).
 */
import { describe, test, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { DateTime } from 'luxon'
import { PushType, Priority } from 'apns2'

vi.mock('@/core/notifications/dismiss', () => ({
  dismissNotificationsForTasks: vi.fn(),
  syncBadgeCount: vi.fn(),
  getOverdueCount: vi.fn().mockReturnValue(0),
}))
vi.mock('@/core/webhooks/dispatch', () => ({ dispatchWebhookEvent: vi.fn() }))
vi.mock('@/core/notifications/web-push', () => ({
  sendPushNotification: vi.fn().mockResolvedValue(undefined),
  isWebPushConfigured: vi.fn().mockReturnValue(true),
}))
vi.mock('@/core/notifications/apns', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/core/notifications/apns')>()),
  isApnsConfigured: vi.fn().mockReturnValue(true),
  sendApnsDeadlinesNag: vi.fn().mockResolvedValue(undefined),
  sendApnsNotification: vi.fn().mockResolvedValue(undefined),
  sendApnsSummaryNotification: vi.fn().mockResolvedValue(undefined),
  sendApnsBadgeUpdate: vi.fn().mockResolvedValue(undefined),
}))

import { getDb } from '@/core/db'
import { createTask } from '@/core/tasks'
import { deckTasks } from '@/core/tasks/deck'
import { considerTasks, getTaskSegments } from '@/core/tasks/task-segments'
import {
  NAG_LADDER,
  SAFETY_NET_FLOOR_MINUTES,
  nagIntervalMinutes,
  type NagTiers,
} from '@/core/notifications/nag-ladder'
import {
  DEADLINES_NAG_KEY,
  DEADLINES_PAGE_PATH,
  checkDeadlineNags,
  fastestDeadlineInterval,
  pendingDeadlineNags,
} from '@/core/notifications/deadline-nags'
import { claimNagSend } from '@/core/notifications/nag-sends'
import { notifiableUsers, notifiableUserSql } from '@/core/notifications/notifiable-users'
import { checkOverdueTasks } from '@/core/notifications/overdue-checker'
import { sendPushNotification } from '@/core/notifications/web-push'
import { buildDeadlinesNagNotification, sendApnsDeadlinesNag } from '@/core/notifications/apns'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'
import type { Task } from '@/types'
import { tasksPanelLinkIndex, tasksPanelPath, withoutTasksPanelParam } from '@/lib/tasks-panel-link'

const tz = TEST_TIMEZONE
const u = { userId: TEST_USER_ID, userTimezone: tz }

function at(local: string): string {
  return DateTime.fromISO(local, { zone: tz }).toUTC().toISO()!
}
function setClock(local: string) {
  vi.setSystemTime(new Date(at(local)))
}
function make(input: Record<string, unknown>): Task {
  return createTask({ ...u, input: { title: 'Synthetic deadline task', ...input } })
}
/** On the page today, outside the safety net: deadline Tue Oct 27, lead 7 → from today. */
function onPage(priority: number, extra: Record<string, unknown> = {}): Task {
  return make({ deadline_at: at('2026-10-27T23:59'), lead_days: 7, priority, ...extra })
}
/** In the safety net today: deadline Wed Oct 21 (today is D−1). */
function inNet(priority: number, extra: Record<string, unknown> = {}): Task {
  return make({ deadline_at: at('2026-10-21T23:59'), priority, ...extra })
}
function pending() {
  return pendingDeadlineNags(new Date()).filter((n) => n.userId === TEST_USER_ID)
}

const DEFAULT_TIERS: NagTiers = { unset: 30, low: 240, medium: 60, high: 15, urgent: 5 }

beforeEach(() => {
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
    "UPDATE users SET day_start_time = '06:30', last_rollover_date = '2026-10-20' WHERE id = ?",
  ).run(TEST_USER_ID)
  vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
  setClock('2026-10-20T10:00')
  vi.clearAllMocks()
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})
afterAll(() => teardownTestDb())

describe('DN-001 the ladder table', () => {
  test('overdue reads the tiers as set; considering is ×2 at every priority', () => {
    const row = (kind: 'overdue' | 'deadlines', net = false) =>
      [0, 1, 2, 3, 4].map((p) => nagIntervalMinutes(kind, p, DEFAULT_TIERS, { safetyNet: net }))
    expect(row('overdue')).toEqual([30, 240, 60, 15, 5])
    // Trent, 10-22: one considering ladder, no special cases — Low 480, Unset 60.
    expect(row('deadlines')).toEqual([60, 480, 120, 30, 10])
    // The safety net nags at least hourly: Low and Medium brought up to 60.
    expect(row('deadlines', true)).toEqual([60, 60, 60, 30, 10])
    expect(SAFETY_NET_FLOOR_MINUTES).toBe(60)
  })

  test("the considering rungs follow the user's own tiers", () => {
    const tiers = { ...DEFAULT_TIERS, medium: 20, high: 45, urgent: 40 }
    expect(nagIntervalMinutes('deadlines', 2, tiers)).toBe(40)
    expect(nagIntervalMinutes('deadlines', 3, tiers)).toBe(90)
    expect(nagIntervalMinutes('deadlines', 3, tiers, { safetyNet: true })).toBe(60)
    expect(nagIntervalMinutes('deadlines', 2, tiers, { safetyNet: true })).toBe(40)
  })

  test('the slot nag and quota prompts are on the same considering rungs', () => {
    expect(NAG_LADDER.slot_nag).toEqual(NAG_LADDER.deadlines)
    expect(NAG_LADDER.quota_prompt).toEqual(NAG_LADDER.deadlines)
  })
})

describe('DN-002 pacing by the most demanding waiting row', () => {
  test('Medium alone: every 120 min; a High joining sets 30; seeing the High goes back', () => {
    onPage(2)
    expect(pending()).toMatchObject([{ intervalMinutes: 120, count: 1 }])
    const high = onPage(3)
    expect(pending()).toMatchObject([{ intervalMinutes: 30, count: 2 }])
    considerTasks(TEST_USER_ID, [high.id])
    expect(pending()).toMatchObject([{ intervalMinutes: 120, count: 1 }])
  })

  test('Urgent paces at its tier ×2', () => {
    onPage(4)
    expect(pending()).toMatchObject([{ intervalMinutes: 10 }])
  })

  test('the shortest row sets the pace: an Unset row (60) outpaces a Medium (120)', () => {
    onPage(2)
    expect(pending()).toMatchObject([{ intervalMinutes: 120 }])
    onPage(0)
    expect(pending()).toMatchObject([{ intervalMinutes: 60, count: 2 }])
  })

  test('Low nags every 480 min, Unset every 60, outside the safety net', () => {
    onPage(1)
    expect(pending()).toMatchObject([{ intervalMinutes: 480, count: 1 }])
    onPage(0)
    expect(pending()).toMatchObject([{ intervalMinutes: 60, count: 2 }])
  })

  test('a Low tier the user changed moves the Low rung (×2)', () => {
    onPage(1)
    getDb().prepare('UPDATE users SET auto_snooze_low_minutes = 100 WHERE id = ?').run(TEST_USER_ID)
    expect(pending()).toMatchObject([{ intervalMinutes: 200 }])
  })

  test('a Low row in the safety net nags hourly, and sets the pace beside a Medium', () => {
    inNet(1)
    expect(pending()).toMatchObject([{ intervalMinutes: 60, count: 1 }])
    onPage(2)
    expect(pending()).toMatchObject([{ intervalMinutes: 60, count: 2 }])
  })

  test("the user's tiers move the pace", () => {
    onPage(2)
    getDb()
      .prepare('UPDATE users SET auto_snooze_medium_minutes = 45 WHERE id = ?')
      .run(TEST_USER_ID)
    expect(pending()).toMatchObject([{ intervalMinutes: 90 }])
  })
})

describe('DN-003 what silences it', () => {
  test('seeing the only waiting row silences it for the OpenTask day', () => {
    const t = onPage(3)
    considerTasks(TEST_USER_ID, [t.id])
    expect(pending()).toEqual([])
    // The next OpenTask day (after the 06:30 rollover) it waits again.
    setClock('2026-10-21T06:29')
    expect(pending()).toEqual([])
    setClock('2026-10-21T06:30')
    expect(pending()).toMatchObject([{ intervalMinutes: 30 }])
  })

  test('seeing a safety-net row does NOT silence it', () => {
    const t = inNet(2)
    considerTasks(TEST_USER_ID, [t.id])
    expect(pending()).toMatchObject([{ intervalMinutes: 60, count: 1 }])
  })

  test('a target takes it off the page, and so does done', () => {
    make({ deadline_at: at('2026-10-21T23:59'), due_at: at('2026-10-21T09:00'), priority: 3 })
    expect(pending()).toEqual([])
  })

  test('a decked row counts only in the safety net', () => {
    const decked = onPage(4)
    deckTasks({ userId: TEST_USER_ID, timezone: tz, ids: [decked.id], day: '2026-10-22' })
    expect(pending()).toEqual([])
    const netDecked = inNet(2)
    deckTasks({ userId: TEST_USER_ID, timezone: tz, ids: [netDecked.id], day: '2026-10-21' })
    expect(pending()).toMatchObject([{ intervalMinutes: 60, count: 1 }])
  })

  test('a row with its Nag off never counts, in the safety net too', () => {
    onPage(4, { auto_snooze_minutes: 0 })
    inNet(3, { auto_snooze_minutes: 0 })
    expect(pending()).toEqual([])
    // Still on the page: only the push leaves it out.
    const page = getTaskSegments(TEST_USER_ID, tz, new Date(), {
      queuePanels: true,
      deadlineRows: true,
    }).find((s) => s.horizon === 'deadlines')
    expect(page?.tasks).toHaveLength(2)
    // A per-task interval that isn't off leaves the pace to the ladder.
    inNet(2, { auto_snooze_minutes: 5 })
    expect(pending()).toMatchObject([{ intervalMinutes: 60, count: 1 }])
  })

  test('there is no quiet-hours gate: it is due at 3 AM too', () => {
    inNet(2)
    setClock('2026-10-21T03:00')
    // Still the Oct 20 OpenTask day (before the 06:30 rollover): D−1, the net.
    expect(pending()).toMatchObject([{ intervalMinutes: 60 }])
  })

  test('the switch off: no page, no nag', () => {
    inNet(3)
    vi.stubEnv('OPENTASK_TASK_QUEUE', '')
    expect(pending()).toEqual([])
  })
})

describe('DN-004 nag_sends', () => {
  const t0 = new Date(at('2026-10-20T10:00'))
  const plus = (minutes: number, ms = 0) => new Date(t0.getTime() + minutes * 60000 + ms)

  test('one claim per interval; a double tick sends once', () => {
    expect(claimNagSend(TEST_USER_ID, DEADLINES_NAG_KEY, 120, t0, tz)).toBe(true)
    expect(claimNagSend(TEST_USER_ID, DEADLINES_NAG_KEY, 120, t0, tz)).toBe(false)
    expect(claimNagSend(TEST_USER_ID, DEADLINES_NAG_KEY, 120, plus(119), tz)).toBe(false)
    expect(claimNagSend(TEST_USER_ID, DEADLINES_NAG_KEY, 120, plus(120), tz)).toBe(true)
  })

  test('whole minutes: a tick that ran late or early does not slip a minute', () => {
    // Last send at 10:00:00.900; the 12:00 tick runs at 12:00:00.100.
    expect(claimNagSend(TEST_USER_ID, DEADLINES_NAG_KEY, 120, plus(0, 900), tz)).toBe(true)
    expect(claimNagSend(TEST_USER_ID, DEADLINES_NAG_KEY, 120, plus(120, 100), tz)).toBe(true)
  })

  test('restart-safe and catches up: the state is the row, read fresh each tick', () => {
    expect(claimNagSend(TEST_USER_ID, DEADLINES_NAG_KEY, 30, t0, tz)).toBe(true)
    // "Restart": nothing in memory matters — a new claim reads the stored row.
    expect(claimNagSend(TEST_USER_ID, DEADLINES_NAG_KEY, 30, plus(10), tz)).toBe(false)
    // Down from 10:10 to 13:07: the first tick after sends, once.
    expect(claimNagSend(TEST_USER_ID, DEADLINES_NAG_KEY, 30, plus(187), tz)).toBe(true)
    expect(claimNagSend(TEST_USER_ID, DEADLINES_NAG_KEY, 30, plus(188), tz)).toBe(false)
  })

  test('a shorter interval (priority rose) sends as soon as it has passed', () => {
    expect(claimNagSend(TEST_USER_ID, DEADLINES_NAG_KEY, 120, t0, tz)).toBe(true)
    expect(claimNagSend(TEST_USER_ID, DEADLINES_NAG_KEY, 30, plus(30), tz)).toBe(true)
  })

  test('the page is not built while no row could be due yet', () => {
    expect(fastestDeadlineInterval(DEFAULT_TIERS)).toBe(10)
    expect(fastestDeadlineInterval({ ...DEFAULT_TIERS, urgent: 60, high: 60 })).toBe(60)
    inNet(4)
    expect(pending()).toMatchObject([{ intervalMinutes: 10 }])
    claimNagSend(TEST_USER_ID, DEADLINES_NAG_KEY, 10, new Date(), tz)
    setClock('2026-10-20T10:09')
    expect(pending()).toEqual([])
    setClock('2026-10-20T10:10')
    expect(pending()).toMatchObject([{ intervalMinutes: 10 }])
  })

  test('keys and users are independent', () => {
    expect(claimNagSend(TEST_USER_ID, DEADLINES_NAG_KEY, 60, t0, tz)).toBe(true)
    expect(claimNagSend(TEST_USER_ID, 'other', 60, t0, tz)).toBe(true)
  })
})

describe('DN-005 the sender', () => {
  test('sends once per interval, silent, counts only, on both channels', async () => {
    inNet(2)
    await checkDeadlineNags(new Date())
    expect(sendApnsDeadlinesNag).toHaveBeenCalledTimes(1)
    expect(sendApnsDeadlinesNag).toHaveBeenCalledWith(TEST_USER_ID, {
      title: 'Deadlines',
      body: 'Deadline tomorrow: 1 unplanned',
      // Alone in its tick: not passive (tick.ts).
      passive: false,
    })
    expect(sendPushNotification).toHaveBeenCalledWith(
      TEST_USER_ID,
      {
        title: 'Deadlines',
        body: 'Deadline tomorrow: 1 unplanned',
        data: { url: expect.stringMatching(/\/\?tasks=deadlines$/) },
        tag: 'deadlines-page',
        silent: true,
      },
      { urgency: 'normal' },
    )
    // The same minute again (a double tick), then 59 minutes on: nothing.
    await checkDeadlineNags(new Date())
    setClock('2026-10-20T10:59')
    await checkDeadlineNags(new Date())
    expect(sendApnsDeadlinesNag).toHaveBeenCalledTimes(1)
    setClock('2026-10-20T11:00')
    await checkDeadlineNags(new Date())
    expect(sendApnsDeadlinesNag).toHaveBeenCalledTimes(2)
  })

  test('the words: plan, nearest day, today and passed, "more to plan"', async () => {
    make({ deadline_at: at('2026-10-25T23:59'), lead_days: 5, priority: 3 })
    expect(pending()[0].content.body).toBe('1 deadline to plan · nearest Sun')
    onPage(2)
    expect(pending()[0].content.body).toBe('2 deadlines to plan · nearest Sun')
    inNet(2)
    make({ deadline_at: at('2026-10-21T20:00'), priority: 2 })
    expect(pending()[0].content.body).toBe('Deadlines tomorrow: 2 unplanned · 2 more to plan')
    make({ deadline_at: at('2026-10-20T20:00'), priority: 1 })
    expect(pending()[0].content.body).toBe('Deadline today: 1 unplanned · 4 more to plan')
    make({ deadline_at: at('2026-10-19T20:00'), priority: 1 })
    expect(pending()[0].content.body).toBe('Deadline passed: 1 unplanned · 5 more to plan')
  })

  test('a far nearest deadline is a date', () => {
    onPage(2)
    expect(pending()[0].content.body).toBe('1 deadline to plan · nearest Oct 27')
  })

  test('the APNs banner: silent, active, collapse deadlines-page, kind deadlines, no badge', () => {
    const n = buildDeadlinesNagNotification('tok', 'io.mcnitt.opentask', {
      title: 'Deadlines',
      body: '2 deadlines to plan · nearest Fri',
    })
    expect(n.pushType).toBe(PushType.alert)
    expect(n.priority).toBe(Priority.immediate)
    expect(n.options.collapseId).toBe('deadlines-page')
    expect(n.buildApnsOptions()).toEqual({
      aps: {
        alert: { title: 'Deadlines', body: '2 deadlines to plan · nearest Fri' },
        'thread-id': 'ot-tasks',
        'interruption-level': 'active',
      },
      kind: 'deadlines',
    })
    expect(DEADLINES_PAGE_PATH).toBe('/?tasks=deadlines')
  })
})

describe('DN-006 who is notified', () => {
  test('notifications on and not demo', () => {
    const db = getDb()
    db.prepare(
      `INSERT INTO users (id, email, name, password_hash, timezone, is_demo, notifications_enabled)
       VALUES (2, 'demo@example.com', 'demo', 'h', ?, 1, 1),
              (3, 'off@example.com', 'off', 'h', ?, 0, 0),
              (4, 'on@example.com', 'on', 'h', ?, 0, 1)`,
    ).run(tz, tz, tz)
    expect(notifiableUsers().map((x) => x.id)).toEqual([TEST_USER_ID, 4])
    expect(notifiableUserSql('u')).toBe('u.notifications_enabled = 1 AND u.is_demo = 0')
  })

  test('the demo user gets no deadlines nag', () => {
    inNet(3)
    getDb().prepare('UPDATE users SET is_demo = 1 WHERE id = ?').run(TEST_USER_ID)
    expect(pending()).toEqual([])
  })

  test('nor an overdue push', async () => {
    make({ due_at: at('2026-10-20T10:00'), priority: 4 })
    getDb().prepare('UPDATE users SET is_demo = 1 WHERE id = ?').run(TEST_USER_ID)
    await checkOverdueTasks(new Date())
    expect(sendPushNotification).not.toHaveBeenCalled()
  })
})

describe('DN-007 overdue Web Push tag = APNs collapse id (#6)', () => {
  test('a single task push carries tag task-<id> and renotify', async () => {
    const t = make({ due_at: at('2026-10-20T10:00'), priority: 2 })
    await checkOverdueTasks(new Date())
    expect(sendPushNotification).toHaveBeenCalledWith(
      TEST_USER_ID,
      expect.objectContaining({ tag: `task-${t.id}`, renotify: true }),
    )
  })

  test('the overflow summary carries tag overdue-summary', async () => {
    for (let i = 0; i < 5; i++) make({ due_at: at('2026-10-20T10:00'), priority: 2 })
    await checkOverdueTasks(new Date())
    // One alert per tick (tick.ts): the first task's push leads, so the
    // summary goes out silent rather than renotifying.
    expect(sendPushNotification).toHaveBeenCalledWith(
      TEST_USER_ID,
      expect.objectContaining({ tag: 'overdue-summary', silent: true }),
    )
  })
})

describe('DN-008 the /?tasks=<kind> link (tasks-panel-link.ts)', () => {
  const keys = ['tasks:deadlines', 'tasks:days', 'tasks:weeks']
  test('names a page by its kind', () => {
    expect(tasksPanelPath('deadlines')).toBe('/?tasks=deadlines')
    expect(tasksPanelLinkIndex('?tasks=deadlines', keys)).toBe(0)
    expect(tasksPanelLinkIndex('?tasks=weeks&x=1', keys)).toBe(2)
  })
  test('a kind not shown, or no link, is null', () => {
    expect(tasksPanelLinkIndex('?tasks=months', keys)).toBeNull()
    expect(tasksPanelLinkIndex('', keys)).toBeNull()
    expect(tasksPanelLinkIndex('?task=3', keys)).toBeNull()
  })
  test('stripping keeps the rest of the query', () => {
    expect(withoutTasksPanelParam('?tasks=deadlines')).toBe('')
    expect(withoutTasksPanelParam('?tasks=deadlines&filter=overdue')).toBe('?filter=overdue')
  })
})
