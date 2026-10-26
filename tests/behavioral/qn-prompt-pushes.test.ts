/**
 * NAMED QUOTA-PROMPT PUSHES (Push PR 4, 2026-10-26;
 * src/core/notifications/prompt-nags.ts). `qn-` tests:
 *  - QN-P01 eligibility, each condition on its own (the quota's priority is
 *    the one dial);
 *  - QN-P02 the first push at the period's open, repeats on clock marks at
 *    the slot-nag rung;
 *  - QN-P03 a daily quota with prompts in two periods: one push per
 *    prompt_key;
 *  - QN-P04 it stops: considered, did it, count met, the end of the day;
 *  - QN-P05 the period push and nag leave Medium+ prompts to the named
 *    pushes, through the whole minute tick;
 *  - QN-P06 the lead order: prompts rank with reminders of their priority;
 *  - QN-P07 a Medium prompt never leads a minute in which something sounds;
 *  - QN-P08 the body text and the payloads (APNs and Web Push);
 *  - QN-P09 the weekly purge;
 *  - QN-P10 a double tick sends once;
 *  - QN-P11 the cheap gate never skips a due push;
 *  - QN-P12 a mutation that ends a prompt's named push dismisses its banner,
 *    by prompt key (a daily quota's other period's banner stays);
 *  - QN-P13 the user-level changes (prompt switch, default period, a period
 *    deleted or retimed) dismiss the prompt banners they end.
 *
 * Synthetic data only. Clock frozen: Thu 2026-01-15 in the test zone
 * (America/Chicago). Default periods (seeded per user): 07:00 Early morning,
 * 09:00 Morning, 12:00 Midday, 16:00 Afternoon, 20:30 Evening. A quota with
 * no chosen period prompts in the first one, Early morning. Shipped tiers:
 * the slot-nag rung is Medium 120, High 30, Urgent 10.
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
// A pass-through spy, so QN-P11 can see whether the prompts were computed.
vi.mock('@/core/tasks/quota-prompts', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/core/tasks/quota-prompts')>()
  return { ...real, getQuotaPromptsBySlot: vi.fn(real.getQuotaPromptsBySlot) }
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
  sendApnsPromptNag: vi.fn().mockResolvedValue(undefined),
  sendApnsDeadlinesNag: vi.fn().mockResolvedValue(undefined),
  sendApnsNotification: vi.fn().mockResolvedValue(undefined),
  sendApnsSummaryNotification: vi.fn().mockResolvedValue(undefined),
  sendApnsBadgeUpdate: vi.fn().mockResolvedValue(undefined),
}))

import { getDb } from '@/core/db'
import { bulkDone, bulkEdit, createTask, updateTask } from '@/core/tasks'
import { actOnPrompts } from '@/core/tasks/quota-prompt-actions'
import { incrementProgress } from '@/core/tasks/progress'
import { getQuotaPromptsBySlot } from '@/core/tasks/quota-prompts'
import { planTick, runTick } from '@/core/notifications/tick'
import { MINUTE_TICK_SOURCES } from '@/core/notifications/minute-tick'
import {
  PROMPT_NAG_SOURCE,
  pendingPromptNags,
  promptNagKey,
  purgeOldPromptNags,
} from '@/core/notifications/prompt-nags'
import {
  dismissNotificationsForTasks,
  dismissPromptNotifications,
} from '@/core/notifications/dismiss'
import { deleteTimeSlot, updateTimeSlot } from '@/core/time-slots/edit'
import { updatePreferences } from '@/core/users/preferences'
import { pendingSlotNotifications } from '@/core/notifications/slot-reminders'
import { pendingSlotNags } from '@/core/notifications/slot-nags'
import { sendPushNotification } from '@/core/notifications/web-push'
import {
  buildPromptNagNotification,
  sendApnsNotification,
  sendApnsPromptNag,
  sendApnsSlotReminder,
} from '@/core/notifications/apns'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

const tz = TEST_TIMEZONE
const CHANNELS = { apns: true, webPush: true }
const DAY = '2026-01-15'

/** A UTC instant for a wall-clock time on 2026-01-<day> in the test zone. */
function at(hour: number, minute = 0, day = 15): Date {
  return DateTime.fromObject({ year: 2026, month: 1, day, hour, minute }, { zone: tz }).toJSDate()
}
const iso = (d: Date) => d.toISOString()

function slotId(label: string): number {
  return (
    getDb()
      .prepare('SELECT id FROM time_slots WHERE user_id = ? AND label = ?')
      .get(TEST_USER_ID, label) as { id: number }
  ).id
}

/** A weekly quota, target 3 (Early morning unless `period` names another). */
function quota(priority: number, extra: Record<string, unknown> = {}, period?: string) {
  return createTask({
    userId: TEST_USER_ID,
    userTimezone: tz,
    input: {
      title: 'Synthetic quota',
      rrule: 'FREQ=WEEKLY',
      progress_target: 3,
      is_tracked: true,
      priority,
      ...(period ? { quota_prompt_config: { slot_id: slotId(period) } } : {}),
      ...extra,
    },
  })
}
/** A daily quota, target 2: #1 in Early morning (07:00), #2 in Morning (09:00). */
function dailyQuota(priority: number) {
  return createTask({
    userId: TEST_USER_ID,
    userTimezone: tz,
    input: {
      title: 'Synthetic daily quota',
      rrule: 'FREQ=DAILY',
      progress_target: 2,
      is_tracked: true,
      priority,
    },
  })
}
function reminder(hour: number, minute: number, priority: number) {
  return createTask({
    userId: TEST_USER_ID,
    userTimezone: tz,
    input: {
      title: 'Synthetic reminder',
      is_reminder: true,
      due_at: iso(at(hour, minute)),
      priority,
    },
  })
}
function overdue(hour: number, priority: number) {
  return createTask({
    userId: TEST_USER_ID,
    userTimezone: tz,
    input: { title: 'Synthetic task', due_at: iso(at(hour)), priority },
  })
}
const key = (taskId: number, k = 0, day = DAY) => `q:${taskId}:${k}:${day}`

/** One tick of the named prompt pushes alone (claims applied): the prompt keys sent. */
function tick(now: Date): string[] {
  return planTick([PROMPT_NAG_SOURCE], now, CHANNELS).sends.map(() => 'sent')
}

/** Every minute from `from` to `to` (inclusive): the local "dd HH:mm" a named prompt push went out. */
function firing(from: Date, to: Date): string[] {
  const fired: string[] = []
  for (let t = from.getTime(); t <= to.getTime(); t += 60_000) {
    const now = new Date(t)
    const n = tick(now).length
    for (let i = 0; i < n; i++)
      fired.push(DateTime.fromJSDate(now).setZone(tz).toFormat('dd HH:mm'))
  }
  return fired
}

beforeEach(() => {
  vi.setSystemTime(at(6))
  setupTestDb()
  vi.clearAllMocks()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})
afterAll(() => teardownTestDb())

describe('QN-P01 eligibility: every condition', () => {
  test('a Medium quota’s waiting prompt in an opened period: one named push', () => {
    const q = quota(2)
    expect(pendingPromptNags(at(7))).toMatchObject([
      {
        taskId: q.id,
        promptKey: key(q.id),
        slotLabel: 'Early morning',
        countText: '0/3 this week',
        intervalMinutes: 120,
      },
    ])
  })

  test('below Medium: None and Low prompts are the period’s, never named', () => {
    quota(0)
    quota(1)
    expect(pendingPromptNags(at(7))).toEqual([])
    expect(pendingSlotNotifications(at(7))).toMatchObject([{ count: 0, promptCount: 2 }])
  })

  test('not waiting: considered today', () => {
    const q = quota(3)
    actOnPrompts({
      userId: TEST_USER_ID,
      userTimezone: tz,
      actions: [{ key: key(q.id), did: false }],
    })
    expect(pendingPromptNags(at(7))).toEqual([])
  })

  test('its period has not opened yet', () => {
    quota(3, {}, 'Midday')
    expect(pendingPromptNags(at(11, 59))).toEqual([])
    expect(pendingPromptNags(at(12))).toHaveLength(1)
  })

  test('Anytime (a user with no periods): no period opens, no named push', () => {
    quota(4)
    getDb().prepare('DELETE FROM time_slots WHERE user_id = ?').run(TEST_USER_ID)
    expect(pendingPromptNags(at(9))).toEqual([])
    expect(pendingPromptNags(at(23, 59))).toEqual([])
  })

  test('the user’s prompts switched off, or the server’s: nothing', () => {
    quota(3)
    getDb().prepare('UPDATE users SET quota_prompts_enabled = 0 WHERE id = ?').run(TEST_USER_ID)
    expect(pendingPromptNags(at(7))).toEqual([])
    getDb().prepare('UPDATE users SET quota_prompts_enabled = 1 WHERE id = ?').run(TEST_USER_ID)
    vi.stubEnv('OPENTASK_QUOTA_PROMPTS', 'off')
    expect(pendingPromptNags(at(7))).toEqual([])
  })

  test('a quota whose prompt is off (its own switch) gets none', () => {
    quota(3, { quota_prompt_config: { enabled: false } })
    expect(pendingPromptNags(at(7))).toEqual([])
  })

  test('notifications off, or the demo user: nothing', () => {
    quota(3)
    getDb().prepare('UPDATE users SET notifications_enabled = 0 WHERE id = ?').run(TEST_USER_ID)
    expect(pendingPromptNags(at(7))).toEqual([])
    getDb()
      .prepare('UPDATE users SET notifications_enabled = 1, is_demo = 1 WHERE id = ?')
      .run(TEST_USER_ID)
    expect(pendingPromptNags(at(7))).toEqual([])
  })
})

describe('QN-P02 first push at the open, repeats on marks at the rung', () => {
  test('High (30): 09:00 exact, then every half hour on the mark', () => {
    quota(3, {}, 'Morning')
    expect(firing(at(8, 50), at(10, 40))).toEqual(['15 09:00', '15 09:30', '15 10:00', '15 10:30'])
  })

  test('a period at 09:15: the first push is exact; the repeat lands on the mark', () => {
    getDb()
      .prepare("UPDATE time_slots SET start_time = '09:15' WHERE user_id = ? AND label = 'Morning'")
      .run(TEST_USER_ID)
    quota(3, {}, 'Morning')
    expect(firing(at(9), at(10, 40))).toEqual(['15 09:15', '15 09:30', '15 10:00', '15 10:30'])
  })

  test('Medium (120): 09:00, 11:00, 13:00', () => {
    quota(2, {}, 'Morning')
    expect(firing(at(9), at(13, 30))).toEqual(['15 09:00', '15 11:00', '15 13:00'])
  })

  test('Urgent (10): every ten minutes', () => {
    quota(4, {}, 'Morning')
    expect(firing(at(9), at(9, 35))).toEqual(['15 09:00', '15 09:10', '15 09:20', '15 09:30'])
  })

  test('the stamp is the prompt’s own row, `prompt-<prompt_key>`', () => {
    const q = quota(3, {}, 'Morning')
    tick(at(9))
    const row = getDb()
      .prepare('SELECT last_sent_at FROM nag_sends WHERE user_id = ? AND key = ?')
      .get(TEST_USER_ID, promptNagKey(key(q.id))) as { last_sent_at: string } | undefined
    expect(row?.last_sent_at).toBe(iso(at(9)))
  })
})

describe('QN-P03 a daily quota with prompts in two periods', () => {
  test('one push per prompt_key: #1 at 07:00, #2 at 09:00, each on its own marks', () => {
    const q = dailyQuota(3)
    expect(pendingPromptNags(at(7)).map((n) => n.promptKey)).toEqual([key(q.id, 1)])
    expect(firing(at(7), at(8, 59))).toEqual(['15 07:00', '15 07:30', '15 08:00', '15 08:30'])
    // 09:00: Morning's #2 opens and Early morning's #1 repeats.
    expect(pendingPromptNags(at(9)).map((n) => [n.promptKey, n.slotLabel, n.countText])).toEqual([
      [key(q.id, 1), 'Early morning', '0/2 today'],
      [key(q.id, 2), 'Morning', '0/2 today'],
    ])
  })

  test('a +1 finishes #1 only: #2 keeps going', () => {
    const q = dailyQuota(3)
    tick(at(7))
    vi.setSystemTime(at(7, 10))
    incrementProgress({ userId: TEST_USER_ID, taskId: q.id })
    expect(firing(at(7, 11), at(8, 59))).toEqual([])
    expect(pendingPromptNags(at(9)).map((n) => [n.promptKey, n.countText])).toEqual([
      [key(q.id, 2), '1/2 today'],
    ])
  })
})

describe('QN-P04 it stops', () => {
  test('considered: it stops', () => {
    const q = quota(3, {}, 'Morning')
    expect(firing(at(9), at(9, 30))).toEqual(['15 09:00', '15 09:30'])
    vi.setSystemTime(at(9, 40))
    actOnPrompts({
      userId: TEST_USER_ID,
      userTimezone: tz,
      actions: [{ key: key(q.id), did: false }],
    })
    expect(firing(at(9, 41), at(23, 59))).toEqual([])
  })

  test('did it: it stops', () => {
    const q = quota(3, {}, 'Morning')
    tick(at(9))
    vi.setSystemTime(at(9, 10))
    actOnPrompts({
      userId: TEST_USER_ID,
      userTimezone: tz,
      actions: [{ key: key(q.id), did: true }],
    })
    expect(firing(at(9, 11), at(23, 59))).toEqual([])
  })

  test('its count met from elsewhere (a +1 from the widget): it stops', () => {
    const q = quota(3, {}, 'Morning')
    tick(at(9))
    vi.setSystemTime(at(9, 10))
    incrementProgress({ userId: TEST_USER_ID, taskId: q.id, source: 'widget' })
    expect(firing(at(9, 11), at(23, 59))).toEqual([])
  })

  test('the slot checklist (bulkDone with prompts): it stops', () => {
    const q = quota(3, {}, 'Morning')
    tick(at(9))
    vi.setSystemTime(at(9, 10))
    bulkDone({
      userId: TEST_USER_ID,
      userTimezone: tz,
      taskIds: [],
      prompts: [{ key: key(q.id), did: false }],
    })
    expect(firing(at(9, 11), at(23, 59))).toEqual([])
  })

  test('switch off: at local midnight; the next day starts again at its open', () => {
    const q = quota(3, {}, 'Evening')
    expect(firing(at(23), at(23, 59))).toEqual(['15 23:00', '15 23:30'])
    expect(firing(at(0, 0, 16), at(20, 29, 16))).toEqual([])
    vi.setSystemTime(at(20, 30, 16))
    expect(pendingPromptNags(at(20, 30, 16)).map((n) => n.promptKey)).toEqual([
      key(q.id, 0, '2026-01-16'),
    ])
  })

  test('switch on: until the day start (03:00), not after', () => {
    vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
    quota(3, {}, 'Evening')
    getDb()
      .prepare("UPDATE users SET last_rollover_date = '2026-01-15' WHERE id = ?")
      .run(TEST_USER_ID)
    expect(firing(at(20, 30), at(20, 30))).toEqual(['15 20:30'])
    // 00:00–03:00 is still the 15th's day: its Evening has opened.
    expect(firing(at(2, 0, 16), at(4, 0, 16))).toEqual(['16 02:00', '16 02:30'])
  })
})

describe('QN-P05 the period push and nag leave Medium+ prompts to the named pushes', () => {
  test('a Medium+-only period: no period push, no period nag; the named pushes go', async () => {
    quota(2)
    quota(3)
    for (let t = at(7).getTime(); t <= at(9).getTime(); t += 60_000) {
      await runTick([...MINUTE_TICK_SOURCES], new Date(t), CHANNELS)
    }
    expect(sendApnsSlotReminder).not.toHaveBeenCalled()
    // 07:00 both; High at 07:30, 08:00, 08:30, 09:00; Medium at 09:00.
    expect(sendApnsPromptNag).toHaveBeenCalledTimes(7)
  })

  test('a mixed period: the period push counts the None reminder and the Low prompt only', async () => {
    reminder(7, 0, 0)
    quota(1)
    quota(3)
    await runTick([...MINUTE_TICK_SOURCES], at(7), CHANNELS)
    expect(vi.mocked(sendApnsSlotReminder).mock.calls[0][1]).toMatchObject({
      slotLabel: 'Early morning',
      count: 1,
      promptCount: 1,
    })
    expect(sendApnsPromptNag).toHaveBeenCalledTimes(1)
  })

  test('the period nag neither counts nor is paced by a Medium+ prompt', () => {
    reminder(7, 0, 0)
    quota(4)
    planTick([...MINUTE_TICK_SOURCES], at(7), CHANNELS)
    // The Urgent prompt would pace it at 10; the Unset reminder's 60 does.
    expect(pendingSlotNags(at(7, 10))).toEqual([])
    expect(pendingSlotNags(at(8))).toMatchObject([
      { count: 1, promptCount: 0, intervalMinutes: 60 },
    ])
  })
})

describe('QN-P06 the lead order: prompts rank with reminders of their priority', () => {
  const kinds = (now: Date) =>
    planTick([...MINUTE_TICK_SOURCES], now, CHANNELS).sends.map((s) => [
      s.kind,
      s.delivery.passive,
      s.delivery.suffix,
    ])

  test('a High prompt and a Medium overdue: the High prompt leads and sounds', () => {
    quota(3)
    overdue(7, 2)
    expect(kinds(at(7))).toEqual([
      ['overdue_medium', true, null],
      ['prompt_high', false, ' · 1 more waiting'],
    ])
  })

  test('delivered: the High prompt sounds, active, with the suffix; the overdue goes passive', async () => {
    const q = quota(3)
    overdue(7, 2)
    await runTick([...MINUTE_TICK_SOURCES], at(7), CHANNELS)
    expect(vi.mocked(sendApnsPromptNag).mock.calls[0][1]).toEqual({
      taskId: q.id,
      promptKey: key(q.id),
      title: 'Synthetic quota',
      body: 'Early morning · 0/3 this week · 1 more waiting',
      sound: true,
      passive: false,
    })
    expect(vi.mocked(sendApnsNotification).mock.calls[0][1]).toMatchObject({
      interruptionLevel: 'passive',
    })
  })

  test('a High reminder and a High prompt tie: the reminder leads (the senders’ order)', () => {
    reminder(7, 0, 3)
    quota(3)
    expect(kinds(at(7))).toEqual([
      ['reminder_high', false, ' · 1 more waiting'],
      ['prompt_high', true, null],
    ])
  })

  test('an Urgent prompt outranks a High reminder', () => {
    reminder(7, 0, 3)
    quota(4)
    expect(kinds(at(7))).toEqual([
      ['reminder_high', true, null],
      ['prompt_urgent', false, ' · 1 more waiting'],
    ])
  })

  test('an Urgent prompt ranks below High overdue', () => {
    quota(4)
    overdue(7, 3)
    expect(kinds(at(7))).toEqual([
      ['overdue_high', false, ' · 1 more waiting'],
      ['prompt_urgent', true, null],
    ])
  })
})

describe('QN-P07 a Medium prompt never leads a minute in which something sounds', () => {
  test('a Medium prompt and a Low overdue: the overdue leads', () => {
    quota(2)
    overdue(7, 1)
    const { sends } = planTick([...MINUTE_TICK_SOURCES], at(7), CHANNELS)
    expect(sends.map((s) => [s.kind, s.delivery])).toEqual([
      ['overdue_other', { passive: false, suffix: ' · 1 more waiting' }],
      ['prompt_medium', { passive: true, suffix: null }],
    ])
  })

  test('a Medium prompt and a Medium overdue: the overdue leads', () => {
    quota(2)
    overdue(7, 2)
    const { sends } = planTick([...MINUTE_TICK_SOURCES], at(7), CHANNELS)
    expect(sends.map((s) => [s.kind, s.delivery.passive])).toEqual([
      ['overdue_medium', false],
      ['prompt_medium', true],
    ])
  })

  test('a Medium prompt alone goes as built: no sound on either channel', async () => {
    quota(2)
    await runTick([...MINUTE_TICK_SOURCES], at(7), CHANNELS)
    expect(vi.mocked(sendApnsPromptNag).mock.calls[0][1]).toMatchObject({
      body: 'Early morning · 0/3 this week',
      sound: false,
      passive: false,
    })
    expect(vi.mocked(sendPushNotification).mock.calls[0][1]).toMatchObject({ silent: true })
    expect(vi.mocked(sendPushNotification).mock.calls[0][1]).not.toHaveProperty('renotify')
  })
})

describe('QN-P08 the body text and the payloads', () => {
  test('the body: the period, then the count in the prompt row’s words — no priority word', () => {
    quota(3, { title: 'Synthetic weekly', progress_target: 3 }, 'Morning')
    createTask({
      userId: TEST_USER_ID,
      userTimezone: tz,
      input: {
        title: 'Synthetic monthly',
        rrule: 'FREQ=MONTHLY',
        progress_target: 4,
        is_tracked: true,
        priority: 4,
        quota_prompt_config: { slot_id: slotId('Morning') },
      },
    })
    const q = quota(3, { title: 'Synthetic counted' }, 'Morning')
    vi.setSystemTime(at(8))
    incrementProgress({ userId: TEST_USER_ID, taskId: q.id })
    // A +1 today makes that one's prompt done: it is not pushed.
    const bodies = pendingPromptNags(at(9)).map((n) => [n.title, `${n.slotLabel} · ${n.countText}`])
    expect(bodies).toEqual([
      ['Synthetic monthly', 'Morning · 0/4 this month'],
      ['Synthetic weekly', 'Morning · 0/3 this week'],
    ])
  })

  test('the title is the quota’s short title when it has one', () => {
    quota(3, { title: 'Drink a full glass of water with every meal', short_title: 'Water' })
    expect(pendingPromptNags(at(7))).toMatchObject([{ title: 'Water' }])
  })

  test('APNs, High: QUOTA_NAG, ot-reminders, prompt-<key>, active, sound; data taskId + prompt_key only', () => {
    const n = buildPromptNagNotification('token', 'topic', {
      taskId: 41,
      promptKey: 'q:41:0:2026-01-15',
      title: 'Synthetic quota',
      body: 'Morning · 1/3 this week',
      sound: true,
    })
    const json = JSON.parse(JSON.stringify(n.buildApnsOptions()))
    expect(json.aps).toMatchObject({
      alert: { title: 'Synthetic quota', body: 'Morning · 1/3 this week' },
      category: 'QUOTA_NAG',
      'thread-id': 'ot-reminders',
      'interruption-level': 'active',
      sound: 'default',
    })
    expect(json.aps).not.toHaveProperty('badge')
    const { aps, ...data } = json
    expect(aps).toBeDefined()
    expect(data).toEqual({ taskId: 41, prompt_key: 'q:41:0:2026-01-15' })
    expect(n.options.collapseId).toBe('prompt-q:41:0:2026-01-15')
  })

  test('APNs, Medium: no sound; passive: no sound, interruption-level passive', () => {
    const base = {
      taskId: 41,
      promptKey: 'q:41:0:2026-01-15',
      title: 'Synthetic quota',
      body: 'Morning · 1/3 this week',
    }
    const build = (extra: { sound: boolean; passive?: boolean }) =>
      JSON.parse(
        JSON.stringify(
          buildPromptNagNotification('token', 'topic', { ...base, ...extra }).buildApnsOptions(),
        ),
      )
    const medium = build({ sound: false })
    expect(medium.aps).not.toHaveProperty('sound')
    expect(medium.aps['interruption-level']).toBe('active')
    const passive = build({ sound: true, passive: true })
    expect(passive.aps).not.toHaveProperty('sound')
    expect(passive.aps['interruption-level']).toBe('passive')
  })

  test('Web Push, High: the same words, Considered and Did it, tag prompt-<key>, renotify', async () => {
    const q = quota(3)
    await runTick([PROMPT_NAG_SOURCE], at(7), CHANNELS)
    expect(vi.mocked(sendPushNotification).mock.calls[0]).toEqual([
      TEST_USER_ID,
      {
        title: 'Synthetic quota',
        body: 'Early morning · 0/3 this week',
        data: {
          url: expect.stringMatching(
            new RegExp(`/reminders\\?prompt=${encodeURIComponent(key(q.id))}$`),
          ),
          taskId: q.id,
          prompt_key: key(q.id),
        },
        tag: `prompt-${key(q.id)}`,
        actions: [
          { action: 'considered', title: 'Considered' },
          { action: 'did', title: 'Did it' },
        ],
        renotify: true,
      },
    ])
  })
})

describe('QN-P09 the weekly purge', () => {
  test('drops prompt rows two days old or more; keeps today’s and every other key', () => {
    const db = getDb()
    const stamp = db.prepare('INSERT INTO nag_sends (user_id, key, last_sent_at) VALUES (?, ?, ?)')
    stamp.run(TEST_USER_ID, promptNagKey('q:1:0:2026-01-12'), iso(at(9, 0, 12)))
    stamp.run(TEST_USER_ID, promptNagKey('q:1:0:2026-01-13'), iso(at(9, 0, 13)))
    // Yesterday evening's: under two days old, kept (its day is over, but harmless).
    stamp.run(TEST_USER_ID, promptNagKey('q:1:0:2026-01-14'), iso(at(23, 0, 14)))
    stamp.run(TEST_USER_ID, promptNagKey('q:1:0:2026-01-15'), iso(at(9)))
    stamp.run(TEST_USER_ID, 'reminder-7', iso(at(9, 0, 10)))
    stamp.run(TEST_USER_ID, 'slot-nag', iso(at(9, 0, 10)))
    stamp.run(TEST_USER_ID, 'tick-prompt-nags', iso(at(9, 0, 10)))

    expect(purgeOldPromptNags(at(9, 30))).toBe(2)
    const keys = (
      db.prepare('SELECT key FROM nag_sends WHERE user_id = ? ORDER BY key').all(TEST_USER_ID) as {
        key: string
      }[]
    ).map((r) => r.key)
    expect(keys).toEqual(
      [
        promptNagKey('q:1:0:2026-01-14'),
        promptNagKey('q:1:0:2026-01-15'),
        'reminder-7',
        'slot-nag',
        'tick-prompt-nags',
      ].sort(),
    )
  })
})

describe('QN-P10 a double tick sends once', () => {
  test('the same minute twice: one push; the next mark: the next one', () => {
    quota(3)
    expect(tick(at(7))).toHaveLength(1)
    expect(tick(at(7))).toHaveLength(0)
    expect(tick(at(7, 29))).toHaveLength(0)
    expect(tick(at(7, 30))).toHaveLength(1)
  })
})

/**
 * QN-P11 THE CHEAP GATE: `pendingPromptNags` skips a user's prompts unless
 * some candidate could be due. It must never change the answer: minute by
 * minute through a day of edits, the gated answer equals the ungated one
 * (`skipGate`), claims applied as the tick would.
 */
describe('QN-P11 the cheap gate never skips a due push', () => {
  function sweep(from: Date, to: Date, events: Map<number, () => void>): number {
    let sent = 0
    for (let t = from.getTime(); t <= to.getTime(); t += 60_000) {
      const now = new Date(t)
      vi.setSystemTime(now)
      events.get(t)?.()
      const gated = pendingPromptNags(now)
      expect(gated, DateTime.fromJSDate(now).setZone(tz).toFormat('dd HH:mm')).toEqual(
        pendingPromptNags(now, { skipGate: true }),
      )
      sent += planTick([PROMPT_NAG_SOURCE], now, CHANNELS).sends.length
    }
    return sent
  }

  test('a day of edits: created mid-period, raised, moved, considered, counted', () => {
    const daily = dailyQuota(3)
    const considered = quota(2, {}, 'Midday')
    const low = quota(1, {}, 'Morning')
    const moved = quota(4, {}, 'Afternoon')
    quota(3, { quota_prompt_config: { enabled: false } })
    const edit = (taskId: number, input: Record<string, unknown>) =>
      updateTask({ userId: TEST_USER_ID, userTimezone: tz, taskId, input })

    const events = new Map<number, () => void>([
      // A new High quota in an already-open period: its first push at once.
      [at(10, 17).getTime(), () => quota(3, {}, 'Morning')],
      // A +1 that finishes the daily #1.
      [at(9, 25).getTime(), () => incrementProgress({ userId: TEST_USER_ID, taskId: daily.id })],
      // Considered after its 12:00 push.
      [
        at(12, 40).getTime(),
        () =>
          actOnPrompts({
            userId: TEST_USER_ID,
            userTimezone: tz,
            actions: [{ key: key(considered.id), did: false }],
          }),
      ],
      // A Low raised to High mid-period.
      [at(13, 5).getTime(), () => edit(low.id, { priority: 3 })],
      // An Urgent moved from Afternoon (not yet open) to Morning (open).
      [
        at(13, 20).getTime(),
        () => edit(moved.id, { quota_prompt_config: { slot_id: slotId('Morning') } }),
      ],
    ])
    const sent = sweep(at(6, 55), at(14, 30), events)
    expect(sent).toBeGreaterThan(20)
  })

  test('across midnight and into the next day’s open', () => {
    quota(3, {}, 'Evening')
    dailyQuota(2)
    sweep(at(20, 25), at(20, 40), new Map())
    sweep(at(23, 50), at(0, 10, 16), new Map())
    sweep(at(6, 55, 16), at(7, 5, 16), new Map())
  })

  test('it does skip the prompts when nothing could be due', () => {
    quota(3)
    planTick([PROMPT_NAG_SOURCE], at(7), CHANNELS)
    vi.mocked(getQuotaPromptsBySlot).mockClear()
    expect(pendingPromptNags(at(7, 10))).toEqual([])
    expect(getQuotaPromptsBySlot).not.toHaveBeenCalled()
    expect(pendingPromptNags(at(7, 30))).toHaveLength(1)
    expect(getQuotaPromptsBySlot).toHaveBeenCalled()
  })

  test('a Medium+ quota in a period not yet open: the prompts are not computed', () => {
    quota(3, {}, 'Evening')
    vi.mocked(getQuotaPromptsBySlot).mockClear()
    expect(pendingPromptNags(at(9))).toEqual([])
    expect(getQuotaPromptsBySlot).not.toHaveBeenCalled()
  })
})

/** The prompt keys each `dismissPromptNotifications` call carried (empty calls left out). */
const dismissed = () =>
  vi
    .mocked(dismissPromptNotifications)
    .mock.calls.map(([, keys]) => keys)
    .filter((keys) => keys.length > 0)

/**
 * QN-P12: a mutation that ENDS a prompt's named push — it was pushed today
 * and stood (waiting, Medium+, in an opened period) and no longer does —
 * dismisses its banner through `dismissPromptNotifications`, BY PROMPT KEY
 * (review of #377): the `dismiss` push carries `promptKeys`, so a daily
 * quota's other period's banner stays. Never through the task path
 * (`dismissNotificationsForTasks`), which would close every banner of the
 * quota. At 09:05 Morning has opened.
 */
describe('QN-P12 a mutation that ends the named push dismisses the banner', () => {
  const edit = (taskId: number, input: Record<string, unknown>) =>
    updateTask({ userId: TEST_USER_ID, userTimezone: tz, taskId, input })
  afterEach(() => {
    // The task path never carries a quota whose prompt push ended.
    expect(vi.mocked(dismissNotificationsForTasks).mock.calls.flatMap(([, ids]) => ids)).toEqual([])
  })
  /** A High quota in Morning, its 09:00 push sent. */
  function pushed(extra: Record<string, unknown> = {}) {
    const q = quota(3, extra, 'Morning')
    planTick([PROMPT_NAG_SOURCE], at(9), CHANNELS)
    vi.setSystemTime(at(9, 5))
    vi.clearAllMocks()
    return q
  }

  test('considered or did it dismisses; a prompt never pushed dismisses nothing', () => {
    const a = pushed()
    actOnPrompts({
      userId: TEST_USER_ID,
      userTimezone: tz,
      actions: [{ key: key(a.id), did: false }],
    })
    expect(dismissed()).toEqual([[key(a.id)]])

    vi.clearAllMocks()
    const later = quota(3, {}, 'Midday')
    actOnPrompts({
      userId: TEST_USER_ID,
      userTimezone: tz,
      actions: [{ key: key(later.id), did: true }],
    })
    expect(dismissed()).toEqual([])
  })

  test('did it from the slot checklist (bulkDone with prompts) dismisses', () => {
    const a = pushed()
    bulkDone({
      userId: TEST_USER_ID,
      userTimezone: tz,
      taskIds: [],
      prompts: [{ key: key(a.id), did: true }],
    })
    expect(dismissed()).toEqual([[key(a.id)]])
  })

  test('the count logged elsewhere dismisses', () => {
    const a = pushed()
    incrementProgress({ userId: TEST_USER_ID, taskId: a.id, source: 'watch' })
    expect(dismissed()).toEqual([[key(a.id)]])
  })

  test('priority below Medium dismisses; High → Medium and a title edit do not', () => {
    const a = pushed()
    edit(a.id, { priority: 2 })
    edit(a.id, { title: 'Synthetic quota, renamed' })
    expect(dismissed()).toEqual([])
    edit(a.id, { priority: 1 })
    expect(dismissed()).toEqual([[key(a.id)]])
  })

  test('its prompt moved to a period not yet open dismisses', () => {
    const a = pushed()
    edit(a.id, { quota_prompt_config: { slot_id: slotId('Evening') } })
    expect(dismissed()).toEqual([[key(a.id)]])
  })

  test('no longer a quota dismisses', () => {
    const a = pushed()
    edit(a.id, { is_tracked: false, progress_target: 1 })
    expect(dismissed()).toEqual([[key(a.id)]])
  })

  test('bulkEdit: only the quotas whose named push the edit ended', () => {
    const a = pushed()
    const b = quota(0, {}, 'Morning')
    const task = overdue(15, 3)
    vi.clearAllMocks()
    bulkEdit({
      userId: TEST_USER_ID,
      userTimezone: tz,
      taskIds: [a.id, b.id, task.id],
      changes: { priority: 1 },
    })
    expect(dismissed()).toEqual([[key(a.id)]])
  })

  test('a daily quota: acting on #1 dismisses #1’s banner only; #2’s stays', () => {
    vi.setSystemTime(at(6))
    const q = dailyQuota(3)
    planTick([PROMPT_NAG_SOURCE], at(9), CHANNELS)
    vi.setSystemTime(at(9, 5))
    vi.clearAllMocks()
    actOnPrompts({
      userId: TEST_USER_ID,
      userTimezone: tz,
      actions: [{ key: key(q.id, 1), did: false }],
    })
    expect(dismissed()).toEqual([[key(q.id, 1)]])
    // #2 still stands: its next push comes at its mark.
    expect(pendingPromptNags(at(9, 30)).map((n) => n.promptKey)).toEqual([key(q.id, 2)])
  })
})

/**
 * QN-P13 (review of #377): the user-level changes that can end a prompt's
 * named push — the prompt switch, the default prompt period, a period
 * deleted (its prompts move to the nearest one) or retimed — dismiss the
 * banners they end, by prompt key.
 */
describe('QN-P13 user-level changes dismiss the prompt banners they end', () => {
  /** A High quota on the default period (Early morning), its 07:00 push sent; now 09:05. */
  function pushed() {
    const q = quota(3)
    planTick([PROMPT_NAG_SOURCE], at(7), CHANNELS)
    vi.setSystemTime(at(9, 5))
    vi.clearAllMocks()
    return q
  }

  test('prompts switched off', () => {
    const q = pushed()
    updatePreferences(TEST_USER_ID, { quota_prompts_enabled: 0 })
    expect(dismissed()).toEqual([[key(q.id)]])
  })

  test('the default prompt period moved to one not yet open', () => {
    const q = pushed()
    updatePreferences(TEST_USER_ID, { quota_prompt_slot_id: slotId('Evening') })
    expect(dismissed()).toEqual([[key(q.id)]])
  })

  test('another preference changes nothing', () => {
    pushed()
    updatePreferences(TEST_USER_ID, { week_start: 'monday' })
    expect(dismissed()).toEqual([])
  })

  test('its period deleted: moved to the nearest, still open — the banner stays', () => {
    const q = quota(3, {}, 'Morning')
    planTick([PROMPT_NAG_SOURCE], at(9), CHANNELS)
    vi.setSystemTime(at(9, 5))
    vi.clearAllMocks()
    deleteTimeSlot({ userId: TEST_USER_ID, userTimezone: tz, slotId: slotId('Morning') })
    expect(dismissed()).toEqual([])
    expect(pendingPromptNags(at(9, 30)).map((n) => n.promptKey)).toEqual([key(q.id)])
  })

  test('its period retimed to later today: not open any more — dismissed', () => {
    const q = quota(3, {}, 'Morning')
    planTick([PROMPT_NAG_SOURCE], at(9), CHANNELS)
    vi.setSystemTime(at(9, 5))
    vi.clearAllMocks()
    updateTimeSlot({
      userId: TEST_USER_ID,
      userTimezone: tz,
      slotId: slotId('Morning'),
      input: { start_time: '10:00' },
    })
    expect(dismissed()).toEqual([[key(q.id)]])
  })
})
