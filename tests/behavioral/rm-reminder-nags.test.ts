/**
 * NAMED REMINDER PUSHES (2026-10-26; src/core/notifications/reminder-nags.ts,
 * plan "named pushes and marks" Part A). `rm-` tests:
 *  - RR-01 eligibility, each condition on its own (a reminder's own Nag value
 *    is ignored: priority is the one dial);
 *  - RR-02 the first push at the period's open (exact), repeats on clock
 *    marks at the slot-nag rung;
 *  - RR-03 it stops when considered and at the end of the OpenTask day
 *    (switch off: midnight; switch on: the day start), and a long rung
 *    restarts at the next day's open (the `since` floor);
 *  - RR-04 the period push and nag no longer count Medium+ (RN-028/029 pin
 *    the slot nag's side), through the whole minute tick;
 *  - RR-05 the lead order: a High reminder leads a Medium overdue; a Medium
 *    reminder never sounds or leads a minute in which something sounds;
 *  - RR-06 the payloads (APNs and Web Push);
 *  - RR-07 the Considered button's day guard (`reminderWaitingOn`);
 *  - RR-08 an edit that ends a reminder's named push dismisses its banner;
 *  - RR-09 the weekly purge;
 *  - RR-10 a double tick sends once;
 *  - RR-11 the cheap gate never skips a due push.
 *
 * Synthetic data only. Clock frozen: Thu 2026-01-15 in the test zone
 * (America/Chicago). Default periods (seeded per user): 07:00 Early morning,
 * 09:00 Morning, 12:00 Midday, 16:00 Afternoon, 20:30 Evening. Shipped tiers:
 * the slot-nag rung is Medium 120, High 30, Urgent 10.
 */
import { describe, test, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { DateTime } from 'luxon'

vi.mock('@/core/notifications/dismiss', () => ({
  dismissNotificationsForTasks: vi.fn(),
  syncBadgeCount: vi.fn(),
  getOverdueCount: vi.fn().mockReturnValue(0),
}))
vi.mock('@/core/webhooks/dispatch', () => ({ dispatchWebhookEvent: vi.fn() }))
// A pass-through spy, so RR-11 can see whether the roster was read.
vi.mock('@/core/tasks/reminders', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/core/tasks/reminders')>()
  return { ...real, getRemindersBySlot: vi.fn(real.getRemindersBySlot) }
})
vi.mock('@/core/notifications/web-push', () => ({
  sendPushNotification: vi.fn().mockResolvedValue(undefined),
  isWebPushConfigured: vi.fn().mockReturnValue(true),
}))
vi.mock('@/core/notifications/apns', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/core/notifications/apns')>()),
  isApnsConfigured: vi.fn().mockReturnValue(true),
  sendApnsSlotReminder: vi.fn().mockResolvedValue(undefined),
  sendApnsReminderNag: vi.fn().mockResolvedValue(undefined),
  sendApnsDeadlinesNag: vi.fn().mockResolvedValue(undefined),
  sendApnsNotification: vi.fn().mockResolvedValue(undefined),
  sendApnsSummaryNotification: vi.fn().mockResolvedValue(undefined),
  sendApnsBadgeUpdate: vi.fn().mockResolvedValue(undefined),
}))

import { getDb } from '@/core/db'
import { bulkEdit, createTask, deleteTask, markDone, updateTask } from '@/core/tasks'
import { planTick, runTick } from '@/core/notifications/tick'
import { MINUTE_TICK_SOURCES } from '@/core/notifications/minute-tick'
import {
  REMINDER_NAG_SOURCE,
  pendingReminderNags,
  purgeGoneReminderNags,
  reminderNagKey,
  reminderWaitingOn,
} from '@/core/notifications/reminder-nags'
import { dismissNotificationsForTasks } from '@/core/notifications/dismiss'
import { pendingSlotNotifications } from '@/core/notifications/slot-reminders'
import { pendingSlotNags } from '@/core/notifications/slot-nags'
import { getRemindersBySlot } from '@/core/tasks/reminders'
import { sendPushNotification } from '@/core/notifications/web-push'
import {
  buildReminderNagNotification,
  sendApnsNotification,
  sendApnsReminderNag,
  sendApnsSlotReminder,
} from '@/core/notifications/apns'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

const tz = TEST_TIMEZONE
const CHANNELS = { apns: true, webPush: true }

/** A UTC instant for a wall-clock time on 2026-01-<day> in the test zone. */
function at(hour: number, minute = 0, day = 15): Date {
  return DateTime.fromObject({ year: 2026, month: 1, day, hour, minute }, { zone: tz }).toJSDate()
}
const iso = (d: Date) => d.toISOString()

function reminder(
  hour: number,
  minute: number,
  priority: number,
  extra: Record<string, unknown> = {},
) {
  return createTask({
    userId: TEST_USER_ID,
    userTimezone: tz,
    input: {
      title: 'Synthetic reminder',
      is_reminder: true,
      due_at: iso(at(hour, minute)),
      priority,
      ...extra,
    },
  })
}
function overdue(hour: number, priority: number, minute = 0) {
  return createTask({
    userId: TEST_USER_ID,
    userTimezone: tz,
    input: { title: 'Synthetic task', due_at: iso(at(hour, minute)), priority },
  })
}

/** One tick of the named reminder pushes alone (claims applied): the kinds sent. */
function tick(now: Date): string[] {
  return planTick([REMINDER_NAG_SOURCE], now, CHANNELS).sends.map((s) => s.kind)
}

/** Every minute from `from` to `to` (inclusive): the local "dd HH:mm" a named push went out. */
function firing(from: Date, to: Date): string[] {
  const fired: string[] = []
  for (let t = from.getTime(); t <= to.getTime(); t += 60_000) {
    const now = new Date(t)
    if (tick(now).length > 0) fired.push(DateTime.fromJSDate(now).setZone(tz).toFormat('dd HH:mm'))
  }
  return fired
}

beforeEach(() => {
  vi.setSystemTime(at(8))
  setupTestDb()
  vi.clearAllMocks()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})
afterAll(() => teardownTestDb())

describe('RR-01 eligibility: every condition', () => {
  test('a Medium reminder in an opened period, Nag on: one named push', () => {
    const r = reminder(9, 0, 2)
    expect(pendingReminderNags(at(9))).toMatchObject([
      { taskId: r.id, slotLabel: 'Morning', reminderDay: '2026-01-15', intervalMinutes: 120 },
    ])
  })

  test('below Medium: None and Low are the period’s, never named', () => {
    reminder(9, 0, 0)
    reminder(9, 0, 1)
    expect(pendingReminderNags(at(9))).toEqual([])
  })

  test('not waiting: considered today', () => {
    const r = reminder(9, 0, 3)
    vi.setSystemTime(at(8, 30))
    markDone({ userId: TEST_USER_ID, userTimezone: tz, taskId: r.id })
    expect(pendingReminderNags(at(9))).toEqual([])
  })

  test('Anytime (earlier than every period): no period opens, no named push', () => {
    reminder(5, 0, 4)
    expect(pendingReminderNags(at(9))).toEqual([])
    expect(pendingReminderNags(at(23, 59))).toEqual([])
  })

  test('its period has not opened yet', () => {
    reminder(12, 0, 3)
    expect(pendingReminderNags(at(11, 59))).toEqual([])
    expect(pendingReminderNags(at(12))).toHaveLength(1)
  })

  /**
   * Priority is the one dial (Trent, 2026-10-26: "Turn off every
   * nag-specific option for reminders"). A reminder's stored Nag value is
   * ignored, and left as stored.
   */
  test('a stored Nag 0 on a Medium reminder no longer stops its named push', async () => {
    const r = reminder(9, 0, 2)
    getDb().prepare('UPDATE tasks SET auto_snooze_minutes = 0 WHERE id = ?').run(r.id)
    expect(pendingReminderNags(at(9))).toMatchObject([{ taskId: r.id, intervalMinutes: 120 }])
    // Pushed by name, so not the period's: no period push for it.
    expect(pendingSlotNotifications(at(9))).toEqual([])
    await runTick([...MINUTE_TICK_SOURCES], at(9), CHANNELS)
    expect(sendApnsReminderNag).toHaveBeenCalledTimes(1)
    expect(sendApnsSlotReminder).not.toHaveBeenCalled()
    // Not rewritten.
    const stored = getDb()
      .prepare('SELECT auto_snooze_minutes FROM tasks WHERE id = ?')
      .get(r.id) as { auto_snooze_minutes: number | null }
    expect(stored.auto_snooze_minutes).toBe(0)
  })

  test('a Low reminder with a stored Nag 15 gets no named push; its period paces at Low', () => {
    const r = reminder(9, 0, 1)
    getDb().prepare('UPDATE tasks SET auto_snooze_minutes = 15 WHERE id = ?').run(r.id)
    expect(pendingReminderNags(at(9))).toEqual([])
    expect(pendingSlotNotifications(at(9))).toMatchObject([{ slotLabel: 'Morning', count: 1 }])
    planTick([...MINUTE_TICK_SOURCES], at(9), CHANNELS)
    // The Low rung, 480, from the 09:00 push — never the stored 15.
    expect(pendingSlotNags(at(9, 15))).toEqual([])
    expect(pendingSlotNags(at(16, 59))).toEqual([])
    expect(pendingSlotNags(at(17))).toMatchObject([{ count: 1, intervalMinutes: 480 }])
  })

  test('a task with Nag off still sends no overdue push', () => {
    const t = overdue(9, 3)
    getDb().prepare('UPDATE tasks SET auto_snooze_minutes = 0 WHERE id = ?').run(t.id)
    expect(planTick([...MINUTE_TICK_SOURCES], at(9), CHANNELS).sends).toEqual([])
    // A second one, Nag on (the default), pushes at its due minute.
    overdue(9, 3)
    expect(planTick([...MINUTE_TICK_SOURCES], at(9), CHANNELS).sends).toEqual([
      expect.objectContaining({ kind: 'overdue_high' }),
    ])
  })

  test('notifications off, or the demo user: nothing', () => {
    reminder(9, 0, 3)
    getDb().prepare('UPDATE users SET notifications_enabled = 0 WHERE id = ?').run(TEST_USER_ID)
    expect(pendingReminderNags(at(9))).toEqual([])
    getDb()
      .prepare('UPDATE users SET notifications_enabled = 1, is_demo = 1 WHERE id = ?')
      .run(TEST_USER_ID)
    expect(pendingReminderNags(at(9))).toEqual([])
  })
})

describe('RR-02 first push at the open, repeats on marks at the rung', () => {
  test('High (30): 09:00 exact, then every half hour on the mark', () => {
    reminder(9, 0, 3)
    expect(firing(at(8, 50), at(10, 40))).toEqual(['15 09:00', '15 09:30', '15 10:00', '15 10:30'])
  })

  test('a period at 09:15: the first push is exact; the repeat lands on the mark (09:45 ties → 09:30)', () => {
    getDb()
      .prepare("UPDATE time_slots SET start_time = '09:15' WHERE user_id = ? AND label = 'Morning'")
      .run(TEST_USER_ID)
    reminder(9, 15, 3)
    expect(firing(at(9), at(10, 40))).toEqual(['15 09:15', '15 09:30', '15 10:00', '15 10:30'])
  })

  test('Medium (120): 09:00, 11:00, 13:00', () => {
    reminder(9, 0, 2)
    expect(firing(at(9), at(13, 30))).toEqual(['15 09:00', '15 11:00', '15 13:00'])
  })

  test('Urgent (10): every ten minutes', () => {
    reminder(9, 0, 4)
    expect(firing(at(9), at(9, 35))).toEqual(['15 09:00', '15 09:10', '15 09:20', '15 09:30'])
  })

  test('each reminder its own row: two Highs both push at 09:00', () => {
    reminder(9, 0, 3)
    reminder(9, 0, 3)
    expect(tick(at(9))).toHaveLength(2)
    expect(tick(at(9, 30))).toHaveLength(2)
  })
})

describe('RR-03 it stops', () => {
  test('considered: it leaves the roster and stops', () => {
    const r = reminder(9, 0, 3)
    expect(firing(at(9), at(9, 30))).toEqual(['15 09:00', '15 09:30'])
    vi.setSystemTime(at(9, 40))
    markDone({ userId: TEST_USER_ID, userTimezone: tz, taskId: r.id })
    expect(firing(at(9, 41), at(23, 59))).toEqual([])
  })

  test('switch off: at local midnight; the next day starts again at its open', () => {
    reminder(20, 30, 3, { rrule: 'FREQ=DAILY' })
    expect(firing(at(23), at(23, 59))).toEqual(['15 23:00', '15 23:30'])
    expect(firing(at(0, 0, 16), at(20, 29, 16))).toEqual([])
    expect(firing(at(20, 30, 16), at(20, 30, 16))).toEqual(['16 20:30'])
  })

  test('switch on: until the day start (03:00), not after', () => {
    vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
    reminder(20, 30, 3, { rrule: 'FREQ=DAILY' })
    getDb()
      .prepare("UPDATE users SET last_rollover_date = '2026-01-15' WHERE id = ?")
      .run(TEST_USER_ID)
    expect(firing(at(20, 30), at(20, 30))).toEqual(['15 20:30'])
    // 01:00–03:00 is still the 15th's day: its Evening has opened.
    expect(firing(at(2, 0, 16), at(4, 0, 16))).toEqual(['16 02:00', '16 02:30'])
  })

  test('a rung longer than a day: the next day still starts at its open (the `since` floor)', () => {
    // Medium tier 1440 → a rung of 2880 minutes, two days.
    getDb()
      .prepare('UPDATE users SET auto_snooze_medium_minutes = 1440 WHERE id = ?')
      .run(TEST_USER_ID)
    reminder(9, 0, 2, { rrule: 'FREQ=DAILY' })
    expect(firing(at(9), at(9, 1))).toEqual(['15 09:00'])
    expect(firing(at(8, 59, 16), at(9, 1, 16))).toEqual(['16 09:00'])
  })
})

describe('RR-04 the period push and nag leave Medium+ to the named pushes', () => {
  test('a Medium+-only period: no period push, no period nag; the named pushes go', async () => {
    reminder(9, 0, 2)
    reminder(9, 0, 3)
    for (let t = at(9).getTime(); t <= at(11).getTime(); t += 60_000) {
      await runTick([...MINUTE_TICK_SOURCES], new Date(t), CHANNELS)
    }
    expect(sendApnsSlotReminder).not.toHaveBeenCalled()
    // 09:00 both; High at 09:30, 10:00, 10:30, 11:00; Medium at 11:00.
    expect(sendApnsReminderNag).toHaveBeenCalledTimes(7)
  })

  test('a mixed period: the period push counts the Low one; the High is pushed by name', async () => {
    reminder(9, 0, 1)
    reminder(9, 0, 3)
    await runTick([...MINUTE_TICK_SOURCES], at(9), CHANNELS)
    expect(vi.mocked(sendApnsSlotReminder).mock.calls[0][1]).toMatchObject({
      slotLabel: 'Morning',
      count: 1,
    })
    expect(sendApnsReminderNag).toHaveBeenCalledTimes(1)
  })
})

describe('RR-05 the lead order', () => {
  test('a High reminder and a Medium overdue: the High reminder leads and sounds', () => {
    reminder(9, 0, 3)
    overdue(9, 2)
    const { sends } = planTick([...MINUTE_TICK_SOURCES], at(9), CHANNELS)
    expect(sends.map((s) => [s.kind, s.delivery])).toEqual([
      ['overdue_medium', { passive: true, suffix: null }],
      ['reminder_high', { passive: false, suffix: ' · 1 more waiting' }],
    ])
  })

  test('delivered: the High reminder sounds, active, with the suffix; the overdue goes passive', async () => {
    const r = reminder(9, 0, 3)
    overdue(9, 2)
    await runTick([...MINUTE_TICK_SOURCES], at(9), CHANNELS)
    expect(vi.mocked(sendApnsReminderNag).mock.calls[0][1]).toEqual({
      taskId: r.id,
      title: 'Synthetic reminder',
      body: 'Morning · High reminder · 1 more waiting',
      reminderDay: '2026-01-15',
      sound: true,
      passive: false,
    })
    expect(vi.mocked(sendApnsNotification).mock.calls[0][1]).toMatchObject({
      interruptionLevel: 'passive',
    })
  })

  test('a Medium reminder never leads a minute in which something sounds', () => {
    reminder(9, 0, 2)
    overdue(9, 1)
    const { sends } = planTick([...MINUTE_TICK_SOURCES], at(9), CHANNELS)
    expect(sends.map((s) => [s.kind, s.delivery])).toEqual([
      ['overdue_other', { passive: false, suffix: ' · 1 more waiting' }],
      ['reminder_medium', { passive: true, suffix: null }],
    ])
  })

  test('a Medium reminder alone goes as built: no sound on either channel', async () => {
    reminder(9, 0, 2)
    await runTick([...MINUTE_TICK_SOURCES], at(9), CHANNELS)
    expect(vi.mocked(sendApnsReminderNag).mock.calls[0][1]).toMatchObject({
      body: 'Morning · Medium reminder',
      sound: false,
      passive: false,
    })
    expect(vi.mocked(sendPushNotification).mock.calls[0][1]).toMatchObject({ silent: true })
    expect(vi.mocked(sendPushNotification).mock.calls[0][1]).not.toHaveProperty('renotify')
  })

  test('an Urgent reminder ranks below High overdue', () => {
    reminder(9, 0, 4)
    overdue(9, 3)
    const { sends } = planTick([...MINUTE_TICK_SOURCES], at(9), CHANNELS)
    expect(sends.map((s) => [s.kind, s.delivery.passive])).toEqual([
      ['overdue_high', false],
      ['reminder_urgent', true],
    ])
  })
})

describe('RR-06 the payloads', () => {
  const base = {
    taskId: 41,
    title: 'Synthetic reminder',
    body: 'Morning · High reminder',
    reminderDay: '2026-01-15',
  }

  test('APNs, High: REMINDER_NAG, ot-reminders, reminder-<id>, active, sound; data taskId + reminder_day only', () => {
    const n = buildReminderNagNotification('token', 'topic', { ...base, sound: true })
    const json = JSON.parse(JSON.stringify(n.buildApnsOptions()))
    expect(json.aps).toMatchObject({
      alert: { title: 'Synthetic reminder', body: 'Morning · High reminder' },
      category: 'REMINDER_NAG',
      'thread-id': 'ot-reminders',
      'interruption-level': 'active',
      sound: 'default',
    })
    expect(json.aps).not.toHaveProperty('badge')
    const { aps, ...data } = json
    expect(aps).toBeDefined()
    expect(data).toEqual({ taskId: 41, reminder_day: '2026-01-15' })
    expect(n.options.collapseId).toBe('reminder-41')
  })

  test('APNs, Medium: no sound; passive: no sound, interruption-level passive', () => {
    const medium = JSON.parse(
      JSON.stringify(
        buildReminderNagNotification('token', 'topic', {
          ...base,
          sound: false,
        }).buildApnsOptions(),
      ),
    )
    expect(medium.aps).not.toHaveProperty('sound')
    expect(medium.aps['interruption-level']).toBe('active')
    const passive = JSON.parse(
      JSON.stringify(
        buildReminderNagNotification('token', 'topic', {
          ...base,
          sound: true,
          passive: true,
        }).buildApnsOptions(),
      ),
    )
    expect(passive.aps).not.toHaveProperty('sound')
    expect(passive.aps['interruption-level']).toBe('passive')
  })

  test('Web Push, High: the same words, the Considered button, tag reminder-<id>, renotify', async () => {
    const r = reminder(9, 0, 3)
    await runTick([REMINDER_NAG_SOURCE], at(9), CHANNELS)
    expect(vi.mocked(sendPushNotification).mock.calls[0]).toEqual([
      TEST_USER_ID,
      {
        title: 'Synthetic reminder',
        body: 'Morning · High reminder',
        data: {
          url: expect.stringMatching(/\/reminders$/),
          taskId: r.id,
          reminder_day: '2026-01-15',
        },
        tag: `reminder-${r.id}`,
        actions: [{ action: 'considered', title: 'Considered' }],
        renotify: true,
      },
    ])
  })
})

describe('RR-07 the Considered button’s day guard', () => {
  test('today, waiting: true; another day: false', () => {
    const r = reminder(9, 0, 3)
    expect(reminderWaitingOn(TEST_USER_ID, tz, r.id, '2026-01-15', at(9, 5))).toBe(true)
    expect(reminderWaitingOn(TEST_USER_ID, tz, r.id, '2026-01-14', at(9, 5))).toBe(false)
  })

  test('already considered, or not a reminder: false', () => {
    const r = reminder(9, 0, 3)
    vi.setSystemTime(at(9, 1))
    markDone({ userId: TEST_USER_ID, userTimezone: tz, taskId: r.id })
    expect(reminderWaitingOn(TEST_USER_ID, tz, r.id, '2026-01-15', at(9, 5))).toBe(false)
    const task = overdue(9, 3)
    expect(reminderWaitingOn(TEST_USER_ID, tz, task.id, '2026-01-15', at(9, 5))).toBe(false)
  })

  test('with the switch on, 01:00 is still yesterday’s day', () => {
    vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
    const r = reminder(20, 30, 3, { rrule: 'FREQ=DAILY' })
    expect(reminderWaitingOn(TEST_USER_ID, tz, r.id, '2026-01-15', at(1, 0, 16))).toBe(true)
    expect(reminderWaitingOn(TEST_USER_ID, tz, r.id, '2026-01-16', at(1, 0, 16))).toBe(false)
  })
})

/**
 * RR-08 (review of #368): an edit that ENDS a reminder's named push — its
 * push stood (waiting today, in an opened period, Medium+) and no longer
 * does — dismisses its banner through `dismissNotificationsForTasks`:
 * priority below Medium, converted to a task, moved to Anytime, its schedule
 * moved off today. A Nag change on a reminder ends nothing (priority is the
 * one dial, 2026-10-26). At 09:05 Morning (09:00) has opened. (The two
 * schedule edits also move the stored `due_at`, which dismisses on its own;
 * they pin the outcome. Priority and conversion move no date, so they pin
 * `namedPushEndCheck` itself.)
 */
describe('RR-08 an edit that ends the named push dismisses the banner', () => {
  const dismissed = () => vi.mocked(dismissNotificationsForTasks).mock.calls.map(([, ids]) => ids)
  const edit = (taskId: number, input: Record<string, unknown>) =>
    updateTask({ userId: TEST_USER_ID, userTimezone: tz, taskId, input })

  beforeEach(() => vi.setSystemTime(at(9, 5)))

  test('priority below Medium dismisses; High → Medium, a title edit and a task do not', () => {
    const a = reminder(9, 0, 3)
    const b = reminder(9, 0, 3)
    const c = reminder(9, 0, 3)
    const task = overdue(15, 3)
    vi.clearAllMocks()
    edit(a.id, { priority: 1 })
    edit(b.id, { priority: 2 })
    edit(c.id, { title: 'Synthetic reminder, renamed' })
    edit(task.id, { priority: 0 })
    expect(dismissed()).toEqual([[a.id]])
  })

  test('a Nag change on a reminder dismisses nothing: its named push still stands', () => {
    const r = reminder(9, 0, 3)
    vi.clearAllMocks()
    edit(r.id, { auto_snooze_minutes: 0 })
    expect(dismissed()).toEqual([])
    expect(pendingReminderNags(at(9, 30))).toMatchObject([{ taskId: r.id }])
  })

  test('converted to a task dismisses', () => {
    const r = reminder(9, 0, 3)
    vi.clearAllMocks()
    edit(r.id, { is_reminder: false })
    expect(dismissed()).toEqual([[r.id]])
  })

  test('moved to Anytime (a time before every period) dismisses', () => {
    const r = reminder(9, 0, 3, { rrule: 'FREQ=DAILY' })
    vi.clearAllMocks()
    edit(r.id, { rrule: 'FREQ=DAILY;BYHOUR=5;BYMINUTE=0' })
    expect(dismissed()).toEqual([[r.id]])
  })

  test('its schedule moved off today dismisses (a Thursday reminder made Friday-only)', () => {
    const r = reminder(9, 0, 3, { rrule: 'FREQ=DAILY' })
    vi.clearAllMocks()
    edit(r.id, { rrule: 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=9;BYMINUTE=0' })
    expect(dismissed()).toEqual([[r.id]])
  })

  test('before its period opens there is no banner: a priority drop dismisses nothing', () => {
    vi.setSystemTime(at(8))
    const r = reminder(9, 0, 3)
    vi.clearAllMocks()
    edit(r.id, { priority: 1 })
    expect(dismissed()).toEqual([])
  })

  test('bulkEdit: only the reminders whose named push the edit ended', () => {
    const a = reminder(9, 0, 2)
    const b = reminder(9, 0, 0)
    const c = reminder(9, 0, 4)
    const task = overdue(15, 3)
    vi.clearAllMocks()
    bulkEdit({
      userId: TEST_USER_ID,
      userTimezone: tz,
      taskIds: [a.id, b.id, task.id],
      changes: { priority: 1 },
    })
    bulkEdit({
      userId: TEST_USER_ID,
      userTimezone: tz,
      taskIds: [c.id],
      changes: { auto_snooze_minutes: 0 },
    })
    // The Nag change on `c` ends nothing: its call dismisses no id.
    expect(dismissed()).toEqual([[a.id], []])
  })
})

describe('RR-09 the weekly purge', () => {
  test('drops the rows of reminders that are gone, keeps the rest', () => {
    const live = reminder(9, 0, 3)
    const trashed = reminder(9, 0, 3)
    const considered = reminder(9, 0, 3)
    const converted = reminder(9, 0, 3)
    const db = getDb()
    const stamp = db.prepare('INSERT INTO nag_sends (user_id, key, last_sent_at) VALUES (?, ?, ?)')
    for (const id of [live.id, trashed.id, considered.id, converted.id, 999_999]) {
      stamp.run(TEST_USER_ID, reminderNagKey(id), iso(at(9)))
    }
    stamp.run(TEST_USER_ID, 'slot-nag', iso(at(9)))
    stamp.run(TEST_USER_ID, 'tick-reminder-nags', iso(at(9)))

    deleteTask({ userId: TEST_USER_ID, taskId: trashed.id })
    markDone({ userId: TEST_USER_ID, userTimezone: tz, taskId: considered.id })
    db.prepare('UPDATE tasks SET is_reminder = 0 WHERE id = ?').run(converted.id)

    expect(purgeGoneReminderNags()).toBe(4)
    const keys = (
      db.prepare('SELECT key FROM nag_sends WHERE user_id = ? ORDER BY key').all(TEST_USER_ID) as {
        key: string
      }[]
    ).map((r) => r.key)
    expect(keys).toEqual([reminderNagKey(live.id), 'slot-nag', 'tick-reminder-nags'].sort())
  })
})

describe('RR-10 a double tick sends once', () => {
  test('the same minute twice: one push; the next mark: the next one', () => {
    reminder(9, 0, 3)
    expect(tick(at(9))).toHaveLength(1)
    expect(tick(at(9))).toHaveLength(0)
    expect(tick(at(9, 29))).toHaveLength(0)
    expect(tick(at(9, 30))).toHaveLength(1)
  })
})

/**
 * RR-11 THE CHEAP GATE (review of #368): `pendingReminderNags` skips a user's
 * roster unless some candidate could be due. It must never change the answer:
 * minute by minute through a day of edits, the gated answer equals the
 * ungated one (`skipGate`), claims applied as the tick would.
 */
describe('RR-11 the cheap gate never skips a due push', () => {
  function sweep(from: Date, to: Date, events: Map<number, () => void>): number {
    let sent = 0
    for (let t = from.getTime(); t <= to.getTime(); t += 60_000) {
      const now = new Date(t)
      vi.setSystemTime(now)
      events.get(t)?.()
      const gated = pendingReminderNags(now)
      expect(gated, DateTime.fromJSDate(now).setZone(tz).toFormat('dd HH:mm')).toEqual(
        pendingReminderNags(now, { skipGate: true }),
      )
      sent += planTick([REMINDER_NAG_SOURCE], now, CHANNELS).sends.length
    }
    return sent
  }

  test('a day of edits: created mid-period, raised, considered, Nag value edited, off-day', () => {
    reminder(9, 0, 3, { rrule: 'FREQ=DAILY' })
    const considered = reminder(12, 0, 2, { rrule: 'FREQ=DAILY' })
    const low = reminder(12, 0, 1)
    const toggled = reminder(9, 0, 4)
    reminder(9, 0, 3, { rrule: 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=9;BYMINUTE=0' })
    reminder(5, 0, 4)
    const edit = (taskId: number, input: Record<string, unknown>) =>
      updateTask({ userId: TEST_USER_ID, userTimezone: tz, taskId, input })

    const events = new Map<number, () => void>([
      // A new High reminder in an already-open period: its first push at once.
      [at(10, 17).getTime(), () => reminder(9, 0, 3)],
      // Its Nag value edited (ignored for a reminder): off, then back.
      [at(9, 25).getTime(), () => edit(toggled.id, { auto_snooze_minutes: 0 })],
      [at(11, 3).getTime(), () => edit(toggled.id, { auto_snooze_minutes: null })],
      // Considered after its 12:00 push.
      [
        at(12, 40).getTime(),
        () => markDone({ userId: TEST_USER_ID, userTimezone: tz, taskId: considered.id }),
      ],
      // A Low raised to High mid-period.
      [at(13, 5).getTime(), () => edit(low.id, { priority: 3 })],
    ])
    const sent = sweep(at(8, 55), at(14, 30), events)
    expect(sent).toBeGreaterThan(20)
  })

  test('across midnight and into the next day’s open', () => {
    reminder(20, 30, 3, { rrule: 'FREQ=DAILY' })
    reminder(9, 0, 2, { rrule: 'FREQ=DAILY' })
    sweep(at(20, 25), at(20, 40), new Map())
    sweep(at(23, 50), at(0, 10, 16), new Map())
    sweep(at(8, 55, 16), at(9, 5, 16), new Map())
  })

  test('it does skip the roster when nothing could be due', () => {
    reminder(9, 0, 3)
    planTick([REMINDER_NAG_SOURCE], at(9), CHANNELS)
    vi.mocked(getRemindersBySlot).mockClear()
    expect(pendingReminderNags(at(9, 10))).toEqual([])
    expect(getRemindersBySlot).not.toHaveBeenCalled()
    expect(pendingReminderNags(at(9, 30))).toHaveLength(1)
    expect(getRemindersBySlot).toHaveBeenCalled()
  })
})
