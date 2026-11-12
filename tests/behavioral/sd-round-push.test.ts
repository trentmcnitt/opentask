/**
 * THE ROUND PUSH (2026-11-12, RULE START-6; src/core/notifications/
 * deadline-nags.ts): an open-window row is announced once on each day it
 * comes round, at the Default task time, silently — never a nag.
 *
 * Synthetic data only. Task queue on, day starts 3:00 AM, Default task time
 * 09:00, check-in day Saturday. A Weeks task, deadline Wed 2027-03-31, start
 * Fri 2027-01-01.
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
vi.mock('@/core/notifications/web-push', () => ({
  sendPushNotification: vi.fn().mockResolvedValue(undefined),
  isWebPushConfigured: vi.fn().mockReturnValue(true),
}))
vi.mock('@/core/notifications/apns', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/core/notifications/apns')>()),
  isApnsConfigured: vi.fn().mockReturnValue(true),
  sendApnsDeadlinesNag: vi.fn().mockResolvedValue(undefined),
}))

import { getDb } from '@/core/db'
import { createTask, updateTask } from '@/core/tasks'
import { considerTasks } from '@/core/tasks/task-segments'
import {
  checkDeadlineNags,
  deadlineRowsWaiting,
  pendingDeadlineNags,
} from '@/core/notifications/deadline-nags'
import { sendApnsDeadlinesNag } from '@/core/notifications/apns'
import { sendPushNotification } from '@/core/notifications/web-push'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

const tz = TEST_TIMEZONE
const u = { userId: TEST_USER_ID, userTimezone: tz }
const at = (local: string) => DateTime.fromISO(local, { zone: tz }).toUTC().toISO()!
const setClock = (local: string) => vi.setSystemTime(new Date(at(local)))
const DEADLINE = at('2027-03-31T23:59')
const make = (input: Record<string, unknown> = {}) =>
  createTask({
    ...u,
    input: {
      title: 'Synthetic fern voucher',
      horizon: 'weeks',
      deadline_at: DEADLINE,
      start_date: '2027-01-01',
      ...input,
    },
  })
const apns = vi.mocked(sendApnsDeadlinesNag)
const bodies = () => apns.mock.calls.map((c) => c[1].body)
const tick = async (local: string) => {
  setClock(local)
  await checkDeadlineNags()
}

beforeEach(() => {
  setupTestDb()
  getDb()
    .prepare("UPDATE users SET notifications_enabled = 1, morning_time = '09:00' WHERE id = ?")
    .run(TEST_USER_ID)
  vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
  vi.useFakeTimers({ toFake: ['Date'] })
  setClock('2026-12-30T10:00')
  vi.clearAllMocks()
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})
afterAll(() => teardownTestDb())

describe('SD-4x the round push (START-6)', () => {
  test('SD-40: once on the start day, at the Default task time, silent, with the title and what is left', async () => {
    make()
    await tick('2026-12-31T12:00')
    await tick('2027-01-01T08:59')
    expect(apns).not.toHaveBeenCalled()
    await tick('2027-01-01T09:00')
    expect(bodies()).toEqual(['Synthetic fern voucher · due Mar 31 · 12 weeks left'])
    expect(vi.mocked(sendPushNotification).mock.calls[0][1]).toMatchObject({
      silent: true,
      tag: 'deadlines-page',
    })
    // No repeat that day, at any pace; a double tick sends once.
    await tick('2027-01-01T09:00')
    await tick('2027-01-01T10:00')
    await tick('2027-01-01T21:00')
    expect(apns).toHaveBeenCalledTimes(1)
  })

  test('SD-41: none on a carry-over day; one on the next round, even never considered', async () => {
    make()
    await tick('2027-01-01T09:00')
    await tick('2027-01-02T09:00') // Sat Jan 2: too close to be a round
    await tick('2027-01-05T09:30')
    expect(apns).toHaveBeenCalledTimes(1)
    await tick('2027-01-09T09:00')
    expect(bodies()[1]).toBe('Synthetic fern voucher · due Mar 31 · 11 weeks left')
    await tick('2027-01-10T09:00')
    expect(apns).toHaveBeenCalledTimes(2)
  })

  test('SD-42: considered before the Default task time: no push that day', async () => {
    const t = make()
    setClock('2027-01-01T07:00')
    considerTasks(TEST_USER_ID, [t.id])
    await tick('2027-01-01T09:00')
    await tick('2027-01-01T15:00')
    expect(apns).not.toHaveBeenCalled()
  })

  test('SD-43: a row that comes round later in the day is announced at the next tick, on its own', async () => {
    make()
    await tick('2027-01-01T09:00')
    const late = make({ title: 'Synthetic moss permit', start_date: null })
    setClock('2027-01-01T14:00')
    updateTask({ ...u, taskId: late.id, input: { start_date: '2027-01-01' } })
    await tick('2027-01-01T14:01')
    expect(bodies()).toEqual([
      'Synthetic fern voucher · due Mar 31 · 12 weeks left',
      'Synthetic moss permit · due Mar 31 · 12 weeks left',
    ])
  })

  test('SD-44: several rows: counts, no titles', async () => {
    make()
    make({ title: 'Synthetic moss permit', deadline_at: at('2027-02-26T23:59') })
    await tick('2027-01-01T09:00')
    expect(bodies()).toEqual(['2 open deadlines this week · nearest Feb 26'])
  })

  test('SD-45: Nag off on the row: no push; it never starts or paces the nag', async () => {
    make({ auto_snooze_minutes: 0 })
    make({ title: 'Synthetic moss permit' })
    setClock('2027-01-01T03:30')
    expect(pendingDeadlineNags(new Date())).toEqual([])
    await tick('2027-01-01T09:00')
    expect(bodies()).toEqual(['Synthetic moss permit · due Mar 31 · 12 weeks left'])
  })

  test('SD-46: with a Coming-due row waiting the push is the nag’s words, the open row in the count; one push', async () => {
    make()
    // On the page daily from today: deadline Jan 8, lead 7.
    make({
      title: 'Synthetic due row',
      start_date: null,
      deadline_at: at('2027-01-08T23:59'),
      lead_days: 7,
    })
    await tick('2027-01-01T03:00') // the nag's first send: something waits
    expect(bodies()).toEqual(['2 deadlines to plan · nearest Jan 8'])
    apns.mockClear()
    await tick('2027-01-01T09:00')
    expect(apns).toHaveBeenCalledTimes(1)
    expect(bodies()[0]).toBe('2 deadlines to plan · nearest Jan 8')
  })

  test('SD-47: the banner stands while the open row waits, and is stale once it is considered', async () => {
    const t = make()
    setClock('2027-01-01T09:00')
    expect(deadlineRowsWaiting(TEST_USER_ID, tz, new Date())).toBe(1)
    considerTasks(TEST_USER_ID, [t.id])
    expect(deadlineRowsWaiting(TEST_USER_ID, tz, new Date())).toBe(0)
  })

  test('SD-48: the simulation: one push on Jan 1 and on each of the eleven Saturdays, none between', async () => {
    const t = make()
    const pushed: string[] = []
    for (
      let day = DateTime.fromISO('2026-12-28', { zone: tz });
      day.toISODate()! <= '2027-03-26';
      day = day.plus({ days: 1 })
    ) {
      for (const hour of [4, 9, 13, 20]) {
        apns.mockClear()
        vi.setSystemTime(day.set({ hour }).toJSDate())
        await checkDeadlineNags()
        if (apns.mock.calls.length > 0) pushed.push(`${day.toISODate()} ${hour}`)
      }
      // He looks at it each evening it waits.
      vi.setSystemTime(day.set({ hour: 21 }).toJSDate())
      if (deadlineRowsWaiting(TEST_USER_ID, tz, new Date()) > 0) considerTasks(TEST_USER_ID, [t.id])
    }
    expect(pushed).toEqual(
      [
        '2027-01-01',
        '2027-01-09',
        '2027-01-16',
        '2027-01-23',
        '2027-01-30',
        '2027-02-06',
        '2027-02-13',
        '2027-02-20',
        '2027-02-27',
        '2027-03-06',
        '2027-03-13',
        '2027-03-20',
      ].map((d) => `${d} 9`),
    )
  })
})
