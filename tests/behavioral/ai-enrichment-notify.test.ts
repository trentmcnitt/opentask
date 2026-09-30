/**
 * The "AI finished" notification (2026-09-29): one quiet push when enrichment
 * finishes for a task or reminder added in the last 10 minutes — the Just
 * added card, without opening the app. See
 * src/core/notifications/enrichment-notify.ts.
 *
 * Runs the real enrichment pipeline with the model call mocked, and the two
 * senders mocked, so what is pinned is WHEN a push goes out and what it says.
 * The APNs wire payload itself is pinned in enrichment-notify-payload.test.ts.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import {
  setupTestDb,
  teardownTestDb,
  seedTestProject,
  TEST_USER_ID,
  TEST_TIMEZONE,
} from '../helpers/setup'

process.env.OPENTASK_AI_PROVIDER = 'anthropic'
process.env.ANTHROPIC_API_KEY = 'test-key'
process.env.OPENTASK_AI_ENRICHMENT_MODEL = 'test-model'

const { enrichmentQueryMock } = vi.hoisted(() => ({ enrichmentQueryMock: vi.fn() }))

vi.mock('@/core/ai/sdk', () => ({
  isAIEnabled: () => true,
  initAI: async () => {},
  aiQuery: vi.fn(),
}))

vi.mock('@/core/ai/enrichment-slot', () => ({
  enrichmentQuery: enrichmentQueryMock,
  initEnrichmentSlot: vi.fn(),
  getEnrichmentSlotStats: vi.fn(),
  shutdownEnrichmentSlot: vi.fn(),
}))

vi.mock('@/core/notifications/web-push', () => ({
  sendPushNotification: vi.fn().mockResolvedValue(undefined),
  isWebPushConfigured: vi.fn().mockReturnValue(true),
  dismissTaskNotifications: vi.fn().mockResolvedValue(undefined),
  dismissAllWebPushNotifications: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/core/notifications/apns', async (orig) => ({
  ...(await orig<typeof import('@/core/notifications/apns')>()),
  isApnsConfigured: vi.fn().mockReturnValue(true),
  sendApnsEnrichedNotification: vi.fn().mockResolvedValue(undefined),
}))

import { getDb } from '@/core/db'
import { createTask, getTaskById } from '@/core/tasks'
import { enrichSingleTask, processEnrichmentQueue } from '@/core/ai/enrichment'
import { _resetProcessingState, _resetCircuitBreaker } from '@/core/ai/enrichment'
import {
  _resetEnrichmentNotifyState,
  notifyEnrichmentFinished,
} from '@/core/notifications/enrichment-notify'
import { sendPushNotification } from '@/core/notifications/web-push'
import { sendApnsEnrichedNotification } from '@/core/notifications/apns'
import { formatRRule } from '@/lib/format-rrule'

// 10:00 AM Chicago on Thursday 2026-01-15.
const NOW = new Date('2026-01-15T16:00:00Z')

interface ModelFields {
  title: string
  priority?: number
  due_at?: string | null
  labels?: string[]
  rrule?: string | null
  project_name?: string | null
}

function modelResult(fields: ModelFields) {
  return {
    structuredOutput: {
      priority: 0,
      due_at: null,
      labels: [],
      rrule: null,
      project_name: null,
      auto_snooze_minutes: null,
      recurrence_mode: null,
      notes: null,
      reasoning: 'test',
      ...fields,
    },
    text: null,
    durationMs: 1,
  }
}

function newTask(title: string, extra: { is_reminder?: boolean } = {}): number {
  const task = createTask({
    userId: TEST_USER_ID,
    userTimezone: TEST_TIMEZONE,
    input: { title, ...extra },
  })
  expect(task.labels).toContain('ai-to-process')
  return task.id
}

function setUser(column: string, value: number | string): void {
  getDb().prepare(`UPDATE users SET ${column} = ? WHERE id = ?`).run(value, TEST_USER_ID)
}

const webPush = vi.mocked(sendPushNotification)
const apns = vi.mocked(sendApnsEnrichedNotification)

beforeAll(() => {
  setupTestDb()
  seedTestProject(50, 'Work')
})

afterAll(() => {
  teardownTestDb()
})

beforeEach(() => {
  vi.setSystemTime(NOW)
  setUser('ai_enrichment_mode', 'sdk')
  setUser('notifications_enabled', 1)
  setUser('enrichment_notifications_enabled', 1)
  setUser('is_demo', 0)
  enrichmentQueryMock.mockReset()
  webPush.mockClear()
  apns.mockClear()
  _resetProcessingState()
  _resetCircuitBreaker()
  _resetEnrichmentNotifyState()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('on a successful enrichment of a new task', () => {
  test('sends one passive push with the cleaned title and what the AI filled in', async () => {
    const id = newTask('call the dentist tomorrow 9am high priority put it in work')
    enrichmentQueryMock.mockResolvedValue(
      modelResult({
        title: 'Call the dentist',
        priority: 3,
        due_at: '2026-01-16T09:00:00',
        project_name: 'Work',
      }),
    )

    await enrichSingleTask(id, TEST_USER_ID)

    expect(apns).toHaveBeenCalledTimes(1)
    expect(apns).toHaveBeenCalledWith(TEST_USER_ID, {
      title: 'Call the dentist',
      body: 'Added to Work · Tomorrow 9:00 AM · High',
      taskId: id,
    })

    expect(webPush).toHaveBeenCalledTimes(1)
    const [userId, payload, options] = webPush.mock.calls[0]
    expect(userId).toBe(TEST_USER_ID)
    expect(payload).toEqual({
      title: 'Call the dentist',
      body: 'Added to Work · Tomorrow 9:00 AM · High',
      data: { url: `http://localhost:3000/?task=${id}`, taskId: id },
      tag: `enriched-${id}`,
      silent: true,
    })
    expect(options).toEqual({ urgency: 'normal' })
  })

  test('says the recurrence when the AI set one', async () => {
    const id = newTask('water the plants every monday')
    enrichmentQueryMock.mockResolvedValue(
      modelResult({
        title: 'Water the plants',
        due_at: '2026-01-19T09:00:00',
        rrule: 'FREQ=WEEKLY;BYDAY=MO',
      }),
    )

    await enrichSingleTask(id, TEST_USER_ID)

    const task = getTaskById(id)!
    expect(apns.mock.calls[0][1].body).toBe(
      `Added to Inbox · Mon 9:00 AM · ${formatRRule(task.rrule!, task.anchor_time)}`,
    )
  })

  test('nothing filled in still says where it landed', async () => {
    const id = newTask('buy milk')
    enrichmentQueryMock.mockResolvedValue(modelResult({ title: 'Buy milk' }))

    await enrichSingleTask(id, TEST_USER_ID)

    expect(apns).toHaveBeenCalledWith(TEST_USER_ID, {
      title: 'Buy milk',
      body: 'Added to Inbox',
      taskId: id,
    })
  })

  test('a reminder says its period, not a project', async () => {
    const id = newTask('stretch every evening', { is_reminder: true })
    enrichmentQueryMock.mockResolvedValue(
      modelResult({ title: 'Stretch', rrule: 'FREQ=DAILY;BYHOUR=20;BYMINUTE=30' }),
    )

    await enrichSingleTask(id, TEST_USER_ID)

    const task = getTaskById(id)!
    expect(apns.mock.calls[0][1]).toEqual({
      title: 'Stretch',
      body: `Added to Evening · ${formatRRule(task.rrule!, task.anchor_time)}`,
      taskId: id,
    })
  })

  test('the cron safety net sends it too, when it is the path that ran', async () => {
    const id = newTask('renew passport')
    enrichmentQueryMock.mockResolvedValue(modelResult({ title: 'Renew passport' }))

    await processEnrichmentQueue()

    expect(apns).toHaveBeenCalledTimes(1)
    expect(apns.mock.calls[0][1].taskId).toBe(id)
    expect(webPush).toHaveBeenCalledTimes(1)
  })
})

describe('exactly once', () => {
  test('a first failure then a successful retry sends one', async () => {
    const id = newTask('book flights')
    enrichmentQueryMock.mockRejectedValueOnce(new Error('model down'))
    enrichmentQueryMock.mockResolvedValueOnce(modelResult({ title: 'Book flights' }))

    await enrichSingleTask(id, TEST_USER_ID)
    expect(apns).not.toHaveBeenCalled()
    expect(getTaskById(id)!.labels).toContain('ai-to-process')

    await processEnrichmentQueue()
    expect(apns).toHaveBeenCalledTimes(1)
  })

  test('enriching the same task again inside the window does not send a second', async () => {
    const id = newTask('pay rent')
    enrichmentQueryMock.mockResolvedValue(modelResult({ title: 'Pay rent' }))
    await enrichSingleTask(id, TEST_USER_ID)

    // The user re-enriches it (adds ai-to-process back) a minute later.
    vi.setSystemTime(new Date(NOW.getTime() + 60_000))
    const task = getTaskById(id)!
    getDb()
      .prepare('UPDATE tasks SET labels = ? WHERE id = ?')
      .run(JSON.stringify([...task.labels, 'ai-to-process']), id)
    await enrichSingleTask(id, TEST_USER_ID)
    await notifyEnrichmentFinished(id, TEST_USER_ID)

    expect(apns).toHaveBeenCalledTimes(1)
    expect(webPush).toHaveBeenCalledTimes(1)
  })
})

describe('sends nothing', () => {
  test('when enrichment fails for good (ai-failed)', async () => {
    const id = newTask('something vague')
    enrichmentQueryMock.mockRejectedValue(new Error('model down'))

    await enrichSingleTask(id, TEST_USER_ID)
    await processEnrichmentQueue()

    expect(getTaskById(id)!.labels).toContain('ai-failed')
    expect(apns).not.toHaveBeenCalled()
    expect(webPush).not.toHaveBeenCalled()
  })

  test('for a task added more than 10 minutes ago (the safety net sweeping an old task)', async () => {
    const id = newTask('old task')
    vi.setSystemTime(new Date(NOW.getTime() + 11 * 60_000))
    enrichmentQueryMock.mockResolvedValue(modelResult({ title: 'Old task' }))

    await processEnrichmentQueue()

    expect(getTaskById(id)!.title).toBe('Old task')
    expect(apns).not.toHaveBeenCalled()
    expect(webPush).not.toHaveBeenCalled()
  })

  test('when the user turned the notification off', async () => {
    setUser('enrichment_notifications_enabled', 0)
    const id = newTask('prefs off')
    enrichmentQueryMock.mockResolvedValue(modelResult({ title: 'Prefs off' }))

    await enrichSingleTask(id, TEST_USER_ID)

    expect(apns).not.toHaveBeenCalled()
    expect(webPush).not.toHaveBeenCalled()
  })

  test('when notifications as a whole are disabled', async () => {
    setUser('notifications_enabled', 0)
    const id = newTask('notifications off')
    enrichmentQueryMock.mockResolvedValue(modelResult({ title: 'Notifications off' }))

    await enrichSingleTask(id, TEST_USER_ID)

    expect(apns).not.toHaveBeenCalled()
    expect(webPush).not.toHaveBeenCalled()
  })

  test('for the demo user', async () => {
    setUser('is_demo', 1)
    const id = newTask('demo task')
    enrichmentQueryMock.mockResolvedValue(modelResult({ title: 'Demo task' }))

    await enrichSingleTask(id, TEST_USER_ID)

    expect(apns).not.toHaveBeenCalled()
    expect(webPush).not.toHaveBeenCalled()
  })

  test("when the user's enrichment mode is off (no model ran)", async () => {
    const id = newTask('mode off')
    setUser('ai_enrichment_mode', 'off')

    await enrichSingleTask(id, TEST_USER_ID)

    expect(getTaskById(id)!.labels).not.toContain('ai-to-process')
    expect(enrichmentQueryMock).not.toHaveBeenCalled()
    expect(apns).not.toHaveBeenCalled()
    expect(webPush).not.toHaveBeenCalled()
  })
})
