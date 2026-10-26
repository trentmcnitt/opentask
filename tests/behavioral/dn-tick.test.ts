/**
 * THE TICK COORDINATOR (2026-10-26; src/core/notifications/tick.ts,
 * minute-tick.ts; plan "named pushes and marks" Part D). `dn-` tests:
 *  - the lead pick: one alerting push per user per tick, the rest passive,
 *    the lead's body gets " · N more waiting";
 *  - the lead order, a tie to the earlier send, users apart;
 *  - Urgent overdue is critical lead or not (`alwaysAlerts`);
 *  - lost claims drop out, a throwing source never silences the others;
 *  - the plan's 10:00 worked case and the After School / Dinnertime handover,
 *    through the real minute-tick sources;
 *  - what the delivered payloads say (APNs passive, Web Push silent).
 *
 * Reminder kinds (`reminder_*`) are the named reminder pushes
 * (reminder-nags.ts, 2026-10-26); their own suite is rm-reminder-nags.test.ts.
 *
 * Synthetic data only. Clock frozen: Thu 2026-01-15 in the test zone
 * (America/Chicago). The task-queue switch is off: the day turns at midnight.
 */
import { describe, test, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { DateTime } from 'luxon'

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
  sendApnsSlotReminder: vi.fn().mockResolvedValue(undefined),
  sendApnsDeadlinesNag: vi.fn().mockResolvedValue(undefined),
  sendApnsReminderNag: vi.fn().mockResolvedValue(undefined),
  sendApnsNotification: vi.fn().mockResolvedValue(undefined),
  sendApnsSummaryNotification: vi.fn().mockResolvedValue(undefined),
  sendApnsBadgeUpdate: vi.fn().mockResolvedValue(undefined),
}))

import { getDb } from '@/core/db'
import { log } from '@/lib/logger'
import { createTask } from '@/core/tasks'
import {
  AS_BUILT,
  LEAD_ORDER,
  assignDeliveries,
  planTick,
  runTick,
  type TickSend,
  type TickSource,
} from '@/core/notifications/tick'
import { MINUTE_TICK_SOURCES } from '@/core/notifications/minute-tick'
import { sendPushNotification } from '@/core/notifications/web-push'
import {
  sendApnsDeadlinesNag,
  sendApnsNotification,
  sendApnsReminderNag,
  sendApnsSlotReminder,
} from '@/core/notifications/apns'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

const tz = TEST_TIMEZONE
const CHANNELS = { apns: true, webPush: true }
const sources = () => [...MINUTE_TICK_SOURCES]

/** A UTC instant for a wall-clock time on 2026-01-15 in the test zone. */
function at(hour: number, minute = 0): Date {
  return DateTime.fromObject(
    { year: 2026, month: 1, day: 15, hour, minute },
    { zone: tz },
  ).toJSDate()
}
const iso = (d: Date) => d.toISOString()

function reminder(hour: number, minute = 0, priority = 0) {
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
function quota() {
  return createTask({
    userId: TEST_USER_ID,
    userTimezone: tz,
    input: { title: 'Synthetic quota', rrule: 'FREQ=WEEKLY', progress_target: 3, is_tracked: true },
  })
}
function overdue(hour: number, priority: number, minute = 0) {
  return createTask({
    userId: TEST_USER_ID,
    userTimezone: tz,
    input: { title: 'Synthetic task', due_at: iso(at(hour, minute)), priority },
  })
}
/** Replace the seeded periods with these (label, HH:MM). */
function periods(list: [string, string][]) {
  const db = getDb()
  db.prepare('DELETE FROM time_slots WHERE user_id = ?').run(TEST_USER_ID)
  const insert = db.prepare(
    'INSERT INTO time_slots (user_id, label, start_time, sort_order) VALUES (?, ?, ?, ?)',
  )
  list.forEach(([label, start], i) => insert.run(TEST_USER_ID, label, start, i))
}

/** A bare tick send for the pure tests. */
function send(kind: TickSend['kind'], extra: Partial<TickSend> = {}): TickSend {
  return { userId: TEST_USER_ID, kind, items: 1, deliver: async () => {}, ...extra }
}

beforeEach(() => {
  vi.setSystemTime(at(8))
  setupTestDb()
  vi.clearAllMocks()
})
afterEach(() => vi.useRealTimers())
afterAll(() => teardownTestDb())

describe('DN-T01 the lead pick (assignDeliveries, pure)', () => {
  test('a send alone in its tick goes out as built: no suffix, not passive', () => {
    const [only] = assignDeliveries([send('period', { items: 3 })])
    expect(only.delivery).toEqual(AS_BUILT)
  })

  test('the lead is first in LEAD_ORDER, wherever it sits; the rest go passive', () => {
    const planned = assignDeliveries([
      send('period', { items: 4 }),
      send('deadlines', { items: 2 }),
      send('overdue_high'),
      send('overdue_medium'),
    ])
    expect(planned.map((p) => [p.kind, p.delivery])).toEqual([
      ['period', { passive: true, suffix: null }],
      ['deadlines', { passive: true, suffix: null }],
      // N counts what every OTHER banner speaks for: 4 + 2 + 1.
      ['overdue_high', { passive: false, suffix: ' · 7 more waiting' }],
      ['overdue_medium', { passive: true, suffix: null }],
    ])
  })

  test('a tie goes to the earlier send (the sender’s own order)', () => {
    const [first, second] = assignDeliveries([send('overdue_high'), send('overdue_high')])
    expect(first.delivery).toEqual({ passive: false, suffix: ' · 1 more waiting' })
    expect(second.delivery).toEqual({ passive: true, suffix: null })
  })

  test('Urgent overdue always alerts, lead or not', () => {
    const planned = assignDeliveries([
      send('overdue_urgent', { alwaysAlerts: true }),
      send('overdue_urgent', { alwaysAlerts: true }),
      send('period', { items: 2 }),
    ])
    expect(planned.map((p) => p.delivery)).toEqual([
      { passive: false, suffix: ' · 3 more waiting' },
      { passive: false, suffix: null },
      { passive: true, suffix: null },
    ])
  })

  test('each user has their own lead', () => {
    const planned = assignDeliveries([
      send('period', { userId: 1 }),
      send('deadlines', { userId: 2 }),
      send('overdue_other', { userId: 1 }),
    ])
    expect(planned.map((p) => p.delivery)).toEqual([
      { passive: true, suffix: null },
      AS_BUILT,
      { passive: false, suffix: ' · 1 more waiting' },
    ])
  })

  test('the lead order is the plan’s (Trent, 2026-10-26)', () => {
    expect(LEAD_ORDER).toEqual([
      'overdue_urgent',
      'overdue_high',
      'reminder_urgent',
      'prompt_urgent',
      'reminder_high',
      'prompt_high',
      'deadlines_safety_net',
      'overdue_medium',
      'overdue_other',
      'reminder_medium',
      'prompt_medium',
      'period',
      'deadlines',
    ])
  })
})

/**
 * Trent, 2026-10-26 (on #362): the lead is the highest-ranked send that would
 * SOUND on its own. A silent one (period pushes and nags, the deadlines nag
 * and its safety net) never leads a minute in which something sounds; with
 * nothing sounding, the highest-ranked leads silently, suffix and all.
 */
describe('DN-T06 silent sends never take the lead from a sounding one (pure)', () => {
  test('a safety net and a Medium overdue: the Medium leads and sounds', () => {
    const planned = assignDeliveries([
      send('deadlines_safety_net', { items: 2, silent: true }),
      send('overdue_medium'),
    ])
    expect(planned.map((p) => [p.kind, p.delivery])).toEqual([
      ['deadlines_safety_net', { passive: true, suffix: null }],
      ['overdue_medium', { passive: false, suffix: ' · 2 more waiting' }],
    ])
  })

  test('an all-silent minute: the highest-ranked leads, silently, with the suffix', () => {
    const planned = assignDeliveries([
      send('period', { items: 3, silent: true }),
      send('deadlines_safety_net', { items: 2, silent: true }),
    ])
    expect(planned.map((p) => [p.kind, p.delivery])).toEqual([
      ['period', { passive: true, suffix: null }],
      ['deadlines_safety_net', { passive: false, suffix: ' · 3 more waiting' }],
    ])
  })

  test('the lowest sounding send still outranks every silent one', () => {
    const planned = assignDeliveries([
      send('deadlines_safety_net', { silent: true }),
      send('period', { items: 2, silent: true }),
      send('overdue_other'),
    ])
    expect(planned.map((p) => p.delivery)).toEqual([
      { passive: true, suffix: null },
      { passive: true, suffix: null },
      { passive: false, suffix: ' · 3 more waiting' },
    ])
  })
})

describe('DN-T02 planTick: claims and failures', () => {
  test('a lost claim drops the send, and it is not counted in the lead’s N', () => {
    const source: TickSource = {
      name: 'synthetic',
      minuteKey: 'tick-synthetic',
      plan: () => ({
        sends: [
          send('overdue_high'),
          send('period', { items: 5, claim: () => false }),
          send('deadlines', { items: 2, claim: () => true }),
        ],
      }),
    }
    const { sends } = planTick([source], at(10), CHANNELS)
    expect(sends.map((s) => [s.kind, s.delivery])).toEqual([
      ['overdue_high', { passive: false, suffix: ' · 2 more waiting' }],
      ['deadlines', { passive: true, suffix: null }],
    ])
  })

  test('a source that throws is left out; the others still plan', () => {
    const broken: TickSource = {
      name: 'broken',
      minuteKey: 'tick-broken',
      plan: () => {
        throw new Error('synthetic failure')
      },
    }
    const fine: TickSource = {
      name: 'fine',
      minuteKey: 'tick-fine',
      plan: () => ({ sends: [send('period')] }),
    }
    const logged = vi.spyOn(log, 'error').mockImplementation(() => {})
    const { sends } = planTick([broken, fine], at(10), CHANNELS)
    expect(sends.map((s) => s.kind)).toEqual(['period'])
    expect(logged).toHaveBeenCalledWith('notifications', 'broken error:', expect.any(Error))
    logged.mockRestore()
  })
})

/**
 * The plan's worked case at 10:00, with PR 2's named reminder pushes.
 * Morning (08:00) opened with 3 reminders (2 Medium, 1 Unset) and 1 quota
 * prompt waiting. The Mediums are pushed by name (reminder-nags.ts) and
 * repeat at the Medium rung, 120: 08:00, then 10:00. The period's push and
 * nag count the Unset reminder and the prompt only, at the Unset pace, 60:
 * 08:00 push, 09:00 and 10:00 nags. A High task is due at 10:00 too. The
 * overdue High leads, "Overdue task · 4 more waiting" (2 Mediums + the
 * nag's 2 items); the two Medium pushes and the Morning nag go passive.
 */
describe('DN-T03 the 10:00 worked case', () => {
  function seed() {
    periods([
      ['Morning', '08:00'],
      ['Midday', '12:00'],
    ])
    reminder(8, 0, 2)
    reminder(8, 0, 2)
    reminder(8)
    quota()
    overdue(10, 3)
  }
  const shape = (sends: { kind: string; items: number; delivery: unknown }[]) =>
    sends.map((s) => [s.kind, s.items, s.delivery])

  test('planned: 08:00 an all-silent minute, 09:00 the nag alone, 10:00 the overdue High leads', () => {
    seed()
    // 08:00: everything is silent by its own rule, so the highest-ranked
    // leads, silently, with the suffix: a Medium reminder outranks a period.
    expect(shape(planTick(sources(), at(8), CHANNELS).sends)).toEqual([
      ['period', 2, { passive: true, suffix: null }],
      ['reminder_medium', 1, { passive: false, suffix: ' · 3 more waiting' }],
      ['reminder_medium', 1, { passive: true, suffix: null }],
    ])
    expect(shape(planTick(sources(), at(9), CHANNELS).sends)).toEqual([['period', 2, AS_BUILT]])
    expect(shape(planTick(sources(), at(10), CHANNELS).sends)).toEqual([
      ['overdue_high', 1, { passive: false, suffix: ' · 4 more waiting' }],
      ['period', 2, { passive: true, suffix: null }],
      ['reminder_medium', 1, { passive: true, suffix: null }],
      ['reminder_medium', 1, { passive: true, suffix: null }],
    ])
  })

  test('delivered: the High active with the suffix; the nag and the Mediums passive', async () => {
    seed()
    await runTick(sources(), at(8), CHANNELS)
    await runTick(sources(), at(9), CHANNELS)
    vi.clearAllMocks()
    await runTick(sources(), at(10), CHANNELS)

    expect(sendApnsNotification).toHaveBeenCalledTimes(1)
    expect(vi.mocked(sendApnsNotification).mock.calls[0][1]).toMatchObject({
      body: 'Overdue task · 4 more waiting',
      interruptionLevel: 'active',
    })
    expect(sendPushNotification).toHaveBeenCalledWith(
      TEST_USER_ID,
      expect.objectContaining({ body: 'Overdue task · 4 more waiting', renotify: true }),
    )
    expect(sendApnsSlotReminder).toHaveBeenCalledTimes(1)
    expect(vi.mocked(sendApnsSlotReminder).mock.calls[0][1]).toMatchObject({
      slotLabel: 'Morning',
      body: '1 reminder · 1 quota waiting',
      passive: true,
      suffix: undefined,
    })
    expect(sendApnsReminderNag).toHaveBeenCalledTimes(2)
    for (const [, p] of vi.mocked(sendApnsReminderNag).mock.calls) {
      expect(p).toMatchObject({ body: 'Morning · Medium reminder', sound: false, passive: true })
    }
  })
})

describe('DN-T04 Urgent overdue stays critical', () => {
  test('two Urgent and a High due together: both Urgent critical, the High passive', async () => {
    const first = overdue(10, 4)
    const second = overdue(10, 4)
    const high = overdue(10, 3)
    await runTick(sources(), at(10), CHANNELS)

    const levels = new Map(
      vi
        .mocked(sendApnsNotification)
        .mock.calls.map(([, p]) => [p.taskId, [p.interruptionLevel, p.body]]),
    )
    expect(levels.get(first.id)).toEqual(['critical', 'Overdue task · 2 more waiting'])
    expect(levels.get(second.id)).toEqual(['critical', 'Overdue task'])
    expect(levels.get(high.id)).toEqual(['passive', 'Overdue task'])

    // Web Push: the passive High is silent; the Urgent ones renotify.
    const web = vi.mocked(sendPushNotification).mock.calls.map(([, p]) => p)
    expect(web.find((p) => p.tag === `task-${high.id}`)).toMatchObject({ silent: true })
    expect(web.find((p) => p.tag === `task-${second.id}`)).toMatchObject({ renotify: true })
  })

  test('an Urgent repeat leads a period push: the period goes passive', async () => {
    periods([['Morning', '09:00']])
    reminder(9)
    // Urgent due 08:55 repeats every 5: 09:00 is a mark.
    overdue(8, 4, 55)
    await runTick(sources(), at(9), CHANNELS)
    expect(vi.mocked(sendApnsNotification).mock.calls[0][1]).toMatchObject({
      interruptionLevel: 'critical',
      body: 'Overdue task · 1 more waiting',
    })
    expect(vi.mocked(sendApnsSlotReminder).mock.calls[0][1]).toMatchObject({ passive: true })
  })
})

/**
 * The plan's handover, two periods at the Unset pace (60), neither finished:
 *   16:30 After School pushes → 17:00 nag → 18:00 Dinnertime pushes (the nag
 *   stands down and the push stamps its clock: no After School nag at 18:00)
 *   → 19:00 nag naming Dinnertime, "and 1 earlier slot".
 */
describe('DN-T05 the After School / Dinnertime handover', () => {
  test('every banner from 16:00 to 19:30, through the whole minute tick', async () => {
    periods([
      ['Morning', '09:00'],
      ['After School', '16:30'],
      ['Dinnertime', '18:00'],
    ])
    reminder(16, 30)
    reminder(18)
    // Morning has nothing waiting, so it never pushes or nags.
    const fired: string[] = []
    for (let t = at(16).getTime(); t <= at(19, 30).getTime(); t += 60_000) {
      const now = new Date(t)
      vi.mocked(sendApnsSlotReminder).mockClear()
      await runTick(sources(), now, { apns: true, webPush: false })
      for (const [, p] of vi.mocked(sendApnsSlotReminder).mock.calls) {
        const hhmm = DateTime.fromJSDate(now).setZone(tz).toFormat('HH:mm')
        fired.push(`${hhmm} ${p.slotLabel}: ${p.body ?? '(opens)'}${p.passive ? ' [passive]' : ''}`)
      }
    }
    expect(fired).toEqual([
      '16:30 After School: (opens)',
      '17:00 After School: 1 reminder waiting',
      '18:00 Dinnertime: (opens)',
      '19:00 Dinnertime: 1 reminder waiting, and 1 earlier slot',
    ])
  })
})

/**
 * DN-T07: the same ruling through the real senders, with the task queue on
 * (the deadlines page exists) — the senders themselves mark their sends
 * silent. Tue 2026-10-20 10:00; a deadline tomorrow puts a row in the
 * safety net, whose nag has never sent, so it is due at 10:00.
 */
describe('DN-T07 silent senders, end to end', () => {
  const day = (hhmm: string) => DateTime.fromISO(`2026-10-20T${hhmm}`, { zone: tz }).toJSDate()
  const inNet = (priority: number) =>
    createTask({
      userId: TEST_USER_ID,
      userTimezone: tz,
      input: {
        title: 'Synthetic deadline task',
        deadline_at: DateTime.fromISO('2026-10-21T23:59', { zone: tz }).toUTC().toISO()!,
        priority,
      },
    })

  beforeEach(() => {
    vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
    vi.setSystemTime(day('09:00'))
    setupTestDb()
    getDb()
      .prepare(
        "UPDATE users SET day_start_time = '06:30', last_rollover_date = '2026-10-20' WHERE id = ?",
      )
      .run(TEST_USER_ID)
    vi.clearAllMocks()
  })
  afterEach(() => vi.unstubAllEnvs())

  test('a safety net and a Medium overdue: the Medium leads and sounds; the net goes passive', async () => {
    periods([['Morning', '06:30']])
    inNet(2)
    createTask({
      userId: TEST_USER_ID,
      userTimezone: tz,
      input: { title: 'Synthetic task', due_at: iso(day('10:00')), priority: 2 },
    })
    await runTick(sources(), day('10:00'), CHANNELS)

    expect(vi.mocked(sendApnsNotification).mock.calls[0][1]).toMatchObject({
      body: 'Overdue task · 1 more waiting',
      interruptionLevel: 'active',
    })
    expect(sendApnsDeadlinesNag).toHaveBeenCalledWith(
      TEST_USER_ID,
      expect.objectContaining({ body: 'Deadline tomorrow: 1 unplanned', passive: true }),
    )
  })

  test('an all-silent minute: the safety net leads silently with the suffix; the period push goes passive', async () => {
    periods([
      ['Morning', '06:30'],
      ['Late morning', '10:00'],
    ])
    inNet(2)
    createTask({
      userId: TEST_USER_ID,
      userTimezone: tz,
      input: {
        title: 'Synthetic reminder',
        is_reminder: true,
        rrule: 'FREQ=DAILY',
        due_at: iso(day('10:00')),
      },
    })
    await runTick(sources(), day('10:00'), CHANNELS)

    expect(sendApnsNotification).not.toHaveBeenCalled()
    expect(sendApnsDeadlinesNag).toHaveBeenCalledWith(
      TEST_USER_ID,
      expect.objectContaining({
        body: 'Deadline tomorrow: 1 unplanned · 1 more waiting',
        passive: false,
      }),
    )
    expect(vi.mocked(sendApnsSlotReminder).mock.calls[0][1]).toMatchObject({
      slotLabel: 'Late morning',
      passive: true,
      suffix: undefined,
    })
  })
})

/**
 * DN-T08 (review of #362): the lead goes out FIRST. If it reaches no device
 * on any channel, the next send that would sound is promoted and alerts
 * instead; nothing is delivered twice. An Urgent overdue left over is
 * critical anyway, so it ends the search.
 */
describe('DN-T08 a lead that reaches nothing', () => {
  /** APNs reaches nothing for these task ids, every device for the rest. */
  function apnsFailsFor(ids: number[]) {
    vi.mocked(sendApnsNotification).mockImplementation(async (_userId, payload) =>
      ids.includes(payload.taskId)
        ? { attempted: 1, delivered: 0 }
        : { attempted: 1, delivered: 1 },
    )
  }
  afterEach(() => {
    vi.mocked(sendApnsNotification).mockResolvedValue({ attempted: 0, delivered: 0 })
    vi.mocked(sendPushNotification).mockResolvedValue({ attempted: 0, delivered: 0 })
  })
  const callsOf = () =>
    vi
      .mocked(sendApnsNotification)
      .mock.calls.map(([, p]) => [p.taskId, p.interruptionLevel, p.body])

  test('the lead fails: the next sounding send is promoted, with its own suffix', async () => {
    const high = overdue(10, 3)
    const medium = overdue(10, 2)
    const low = overdue(10, 1)
    apnsFailsFor([high.id])
    await runTick(sources(), at(10), { apns: true, webPush: false })

    expect(callsOf()).toEqual([
      [high.id, 'active', 'Overdue task · 2 more waiting'],
      [medium.id, 'active', 'Overdue task · 1 more waiting'],
      [low.id, 'passive', 'Overdue task'],
    ])
  })

  test('APNs fails but Web Push reaches the browser: the lead got through, nothing promoted', async () => {
    const high = overdue(10, 3)
    const medium = overdue(10, 2)
    apnsFailsFor([high.id])
    vi.mocked(sendPushNotification).mockResolvedValueOnce({ attempted: 1, delivered: 1 })
    await runTick(sources(), at(10), CHANNELS)
    expect(callsOf()).toEqual([
      [high.id, 'active', 'Overdue task · 1 more waiting'],
      [medium.id, 'passive', 'Overdue task'],
    ])
  })

  test('a lead that only throws counts as failed too', async () => {
    const high = overdue(10, 3)
    const medium = overdue(10, 2)
    vi.mocked(sendApnsNotification).mockImplementation(async (_userId, payload) => {
      if (payload.taskId === high.id) throw new Error('synthetic network error')
      return { attempted: 1, delivered: 1 }
    })
    const logged = vi.spyOn(log, 'error').mockImplementation(() => {})
    await runTick(sources(), at(10), { apns: true, webPush: false })
    logged.mockRestore()

    expect(callsOf()).toEqual([
      [high.id, 'active', 'Overdue task · 1 more waiting'],
      [medium.id, 'active', 'Overdue task'],
    ])
  })

  test('the lead gets through: nothing is promoted', async () => {
    const high = overdue(10, 3)
    const medium = overdue(10, 2)
    apnsFailsFor([])
    await runTick(sources(), at(10), { apns: true, webPush: false })
    expect(callsOf()).toEqual([
      [high.id, 'active', 'Overdue task · 1 more waiting'],
      [medium.id, 'passive', 'Overdue task'],
    ])
  })

  test('an Urgent lead fails with another Urgent left: that one alerts anyway, nothing promoted', async () => {
    const first = overdue(10, 4)
    const second = overdue(10, 4)
    const high = overdue(10, 3)
    apnsFailsFor([first.id])
    await runTick(sources(), at(10), { apns: true, webPush: false })
    const calls = callsOf()
    expect(calls[0]).toEqual([first.id, 'critical', 'Overdue task · 2 more waiting'])
    expect(calls.slice(1)).toEqual(
      expect.arrayContaining([
        [second.id, 'critical', 'Overdue task'],
        [high.id, 'passive', 'Overdue task'],
      ]),
    )
  })
})

/**
 * DN-T09 (review of #362): one minute's pushes go out once, however many
 * runs reach it — the startup check beside the cron, a deploy's new process
 * overlapping the old one's last tick (`claimTickMinute`, persisted).
 */
describe('DN-T09 a minute sends once', () => {
  test('a second run of the same minute sends nothing again; the next minute is its own', async () => {
    periods([['Morning', '10:00']])
    reminder(10)
    overdue(10, 3)
    await runTick(sources(), at(10), CHANNELS)
    // Same minute, 40 s later: the startup check of a process that just booted.
    await runTick(sources(), new Date(at(10).getTime() + 40_000), CHANNELS)
    expect(sendApnsNotification).toHaveBeenCalledTimes(1)
    expect(sendApnsSlotReminder).toHaveBeenCalledTimes(1)
    expect(sendPushNotification).toHaveBeenCalledTimes(1)

    // 10:15 is the High repeat's mark: a new minute claims afresh.
    await runTick(sources(), at(10, 15), CHANNELS)
    expect(sendApnsNotification).toHaveBeenCalledTimes(2)
  })

  test('planTick: the second plan of a minute is empty', () => {
    overdue(10, 3)
    expect(planTick(sources(), at(10), CHANNELS).sends).toHaveLength(1)
    expect(planTick(sources(), at(10), CHANNELS).sends).toHaveLength(0)
  })
})
