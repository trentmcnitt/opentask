/**
 * The "AI couldn't process" notification (2026-10-05): one quiet push when AI
 * enrichment of a task fails for good (`ai-failed`). See
 * src/core/notifications/enrichment-failed-notify.ts.
 *
 * Runs the real enrichment pipeline with the model call mocked and the two
 * senders mocked, so what is pinned is WHEN a push goes out and what it says.
 * The notifier itself is wrapped in a call-through spy, to pin that the
 * pipeline calls it once per failure transition. The APNs wire payload is
 * pinned in enrichment-notify-payload.test.ts.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { setupTestDb, teardownTestDb, TEST_USER_ID, TEST_TIMEZONE } from '../helpers/setup'

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
  sendApnsEnrichmentFailedNotification: vi.fn().mockResolvedValue(undefined),
}))

// The real notifier, wrapped so the pipeline's calls to it can be counted.
vi.mock('@/core/notifications/enrichment-failed-notify', async (orig) => {
  const real = await orig<typeof import('@/core/notifications/enrichment-failed-notify')>()
  return { ...real, notifyEnrichmentFailed: vi.fn(real.notifyEnrichmentFailed) }
})

import { getDb } from '@/core/db'
import { createTask, getTaskById, reprocessTask } from '@/core/tasks'
import { enrichSingleTask, processEnrichmentQueue } from '@/core/ai/enrichment'
import { _resetProcessingState, _resetCircuitBreaker } from '@/core/ai/enrichment'
import { _resetEnrichmentNotifyState } from '@/core/notifications/enrichment-notify'
import {
  _resetEnrichmentFailedNotifyState,
  buildEnrichmentFailedNotificationContent,
  claimFailureNotification,
  notifyEnrichmentFailed,
  releaseEnrichmentFailedNotice,
  FAILED_BODY_MAX_CHARS,
} from '@/core/notifications/enrichment-failed-notify'
import { sendPushNotification } from '@/core/notifications/web-push'
import {
  sendApnsEnrichedNotification,
  sendApnsEnrichmentFailedNotification,
} from '@/core/notifications/apns'
import type { Task } from '@/types'

// 10:00 AM Chicago on Thursday 2026-01-15.
const NOW = new Date('2026-01-15T16:00:00Z')

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

/** Fail enrichment twice — the fire-and-forget attempt, then the safety net. */
async function failForGood(id: number): Promise<void> {
  enrichmentQueryMock.mockRejectedValue(new Error('model down'))
  await enrichSingleTask(id, TEST_USER_ID)
  await processEnrichmentQueue()
  expect(getTaskById(id)!.labels).toContain('ai-failed')
}

/** Let the fire-and-forget notifier's awaits settle. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

const webPush = vi.mocked(sendPushNotification)
const apnsFailed = vi.mocked(sendApnsEnrichmentFailedNotification)
const apnsEnriched = vi.mocked(sendApnsEnrichedNotification)
const notifier = vi.mocked(notifyEnrichmentFailed)

beforeAll(() => {
  setupTestDb()
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
  apnsFailed.mockClear()
  apnsEnriched.mockClear()
  notifier.mockClear()
  _resetProcessingState()
  _resetCircuitBreaker()
  _resetEnrichmentNotifyState()
  _resetEnrichmentFailedNotifyState()
})

afterEach(() => {
  vi.useRealTimers()
})

function taskFixture(overrides: Partial<Task> = {}): Task {
  return {
    id: 7,
    user_id: TEST_USER_ID,
    title: 'call the dentist tomorrow',
    original_title: null,
    labels: ['ai-failed'],
    is_reminder: false,
    is_tracked: false,
    progress_target: null,
    done: false,
    deleted_at: null,
    ...overrides,
  } as Task
}

describe('content', () => {
  test('title names the kind of item; body is the text the user typed', () => {
    expect(buildEnrichmentFailedNotificationContent(taskFixture())).toEqual({
      title: "AI couldn't process a task",
      body: 'call the dentist tomorrow',
    })
  })

  test('a reminder and a quota say so', () => {
    expect(buildEnrichmentFailedNotificationContent(taskFixture({ is_reminder: true })).title).toBe(
      "AI couldn't process a reminder",
    )
    expect(buildEnrichmentFailedNotificationContent(taskFixture({ is_tracked: true })).title).toBe(
      "AI couldn't process a quota",
    )
  })

  test('the body is the text the AI was given: original_title over a cleaned title', () => {
    const task = taskFixture({ title: 'Call the dentist', original_title: 'call dentist tmrw 9' })
    expect(buildEnrichmentFailedNotificationContent(task).body).toBe('call dentist tmrw 9')
  })

  test('a very long text is cut with an ellipsis, without splitting a character', () => {
    const long = '🦷'.repeat(FAILED_BODY_MAX_CHARS + 50)
    const body = buildEnrichmentFailedNotificationContent(taskFixture({ title: long })).body
    expect(Array.from(body)).toHaveLength(FAILED_BODY_MAX_CHARS)
    expect(body.endsWith('🦷…')).toBe(true)
  })

  test('text at the limit is left whole', () => {
    const exact = 'a'.repeat(FAILED_BODY_MAX_CHARS)
    expect(buildEnrichmentFailedNotificationContent(taskFixture({ title: exact })).body).toBe(exact)
  })
})

describe('the decision (claimFailureNotification)', () => {
  const user = { is_demo: 0, notifications_enabled: 1 }

  test('claims an ai-failed task once; a second claim is refused', () => {
    const task = taskFixture({ id: 101 })
    expect(claimFailureNotification({ task, userId: TEST_USER_ID, user })).toBe(true)
    expect(claimFailureNotification({ task, userId: TEST_USER_ID, user })).toBe(false)
  })

  test('released (the task was claimed for enrichment again) → claimable again', () => {
    const task = taskFixture({ id: 102 })
    expect(claimFailureNotification({ task, userId: TEST_USER_ID, user })).toBe(true)
    releaseEnrichmentFailedNotice(102)
    expect(claimFailureNotification({ task, userId: TEST_USER_ID, user })).toBe(true)
  })

  test('refuses: notifications off, demo user, no user', () => {
    const task = taskFixture({ id: 103 })
    const claim = (u: typeof user | undefined) =>
      claimFailureNotification({ task, userId: TEST_USER_ID, user: u })
    expect(claim({ is_demo: 0, notifications_enabled: 0 })).toBe(false)
    expect(claim({ is_demo: 1, notifications_enabled: 1 })).toBe(false)
    expect(claim(undefined)).toBe(false)
  })

  test('refuses: not ai-failed, done, deleted, gone, someone else’s', () => {
    const claim = (task: Task | null, userId = TEST_USER_ID) =>
      claimFailureNotification({ task, userId, user })
    expect(claim(taskFixture({ id: 104, labels: ['ai-to-process'] }))).toBe(false)
    expect(claim(taskFixture({ id: 105, done: true }))).toBe(false)
    expect(claim(taskFixture({ id: 106, deleted_at: NOW.toISOString() }))).toBe(false)
    expect(claim(null)).toBe(false)
    expect(claim(taskFixture({ id: 107 }), TEST_USER_ID + 1)).toBe(false)
  })
})

describe('the enrichment pipeline', () => {
  test('first failure: no call, no push; second failure: exactly one of each', async () => {
    const id = newTask('call the dentist tomorrow 9am')
    enrichmentQueryMock.mockRejectedValue(new Error('model down'))

    await enrichSingleTask(id, TEST_USER_ID)
    await flush()
    expect(getTaskById(id)!.labels).toContain('ai-to-process')
    expect(notifier).not.toHaveBeenCalled()
    expect(apnsFailed).not.toHaveBeenCalled()
    expect(webPush).not.toHaveBeenCalled()

    await processEnrichmentQueue()
    await flush()
    expect(notifier).toHaveBeenCalledTimes(1)
    expect(notifier).toHaveBeenCalledWith(id, TEST_USER_ID)

    expect(apnsFailed).toHaveBeenCalledTimes(1)
    expect(apnsFailed).toHaveBeenCalledWith(TEST_USER_ID, {
      title: "AI couldn't process a task",
      body: 'call the dentist tomorrow 9am',
      taskId: id,
    })
    expect(webPush).toHaveBeenCalledTimes(1)
    const [userId, payload, options] = webPush.mock.calls[0]
    expect(userId).toBe(TEST_USER_ID)
    expect(payload).toEqual({
      title: "AI couldn't process a task",
      body: 'call the dentist tomorrow 9am',
      data: { url: `http://localhost:3000/?task=${id}`, taskId: id },
      tag: `ai-failed-${id}`,
      silent: true,
    })
    expect(options).toEqual({ urgency: 'normal' })
    // Never the "AI finished" push.
    expect(apnsEnriched).not.toHaveBeenCalled()
  })

  test('the fire-and-forget path announces it when it is the second failure', async () => {
    const id = newTask('renew the passport')
    enrichmentQueryMock.mockRejectedValue(new Error('model down'))

    await processEnrichmentQueue()
    await flush()
    expect(notifier).not.toHaveBeenCalled()

    await enrichSingleTask(id, TEST_USER_ID)
    await flush()
    expect(notifier).toHaveBeenCalledTimes(1)
    expect(apnsFailed).toHaveBeenCalledTimes(1)
  })

  test('a reminder opens the same deep link (the dashboard forwards it to /reminders)', async () => {
    const id = newTask('stretch every evening', { is_reminder: true })
    await failForGood(id)
    await flush()

    expect(apnsFailed.mock.calls[0][1]).toEqual({
      title: "AI couldn't process a reminder",
      body: 'stretch every evening',
      taskId: id,
    })
    expect(webPush.mock.calls[0][1].data).toEqual({
      url: `http://localhost:3000/?task=${id}`,
      taskId: id,
    })
  })

  test('is sent with the "AI finished" switch off — it follows only the master switch', async () => {
    setUser('enrichment_notifications_enabled', 0)
    const id = newTask('success switch off')
    await failForGood(id)
    await flush()

    expect(apnsFailed).toHaveBeenCalledTimes(1)
    expect(webPush).toHaveBeenCalledTimes(1)
  })

  test('is sent for a task added long ago (no Just added window)', async () => {
    const id = newTask('an old task')
    vi.setSystemTime(new Date(NOW.getTime() + 3 * 24 * 60 * 60_000))
    await failForGood(id)
    await flush()

    expect(apnsFailed).toHaveBeenCalledTimes(1)
  })

  test('nothing when notifications as a whole are disabled', async () => {
    setUser('notifications_enabled', 0)
    const id = newTask('notifications off')
    await failForGood(id)
    await flush()

    expect(notifier).toHaveBeenCalledTimes(1)
    expect(apnsFailed).not.toHaveBeenCalled()
    expect(webPush).not.toHaveBeenCalled()
  })

  test('nothing for the demo user', async () => {
    setUser('is_demo', 1)
    const id = newTask('demo task')
    await failForGood(id)
    await flush()

    expect(apnsFailed).not.toHaveBeenCalled()
    expect(webPush).not.toHaveBeenCalled()
  })

  test('a second call for the same failure sends nothing', async () => {
    const id = newTask('pay rent')
    await failForGood(id)
    await flush()
    await notifyEnrichmentFailed(id, TEST_USER_ID)

    expect(apnsFailed).toHaveBeenCalledTimes(1)
    expect(webPush).toHaveBeenCalledTimes(1)
  })

  test('nothing when the task was deleted before the push went out', async () => {
    const id = newTask('deleted meanwhile')
    await failForGood(id)
    // The pipeline's own call already ran; a fresh failure state for a
    // deleted task must not be announced either.
    releaseEnrichmentFailedNotice(id)
    getDb().prepare('UPDATE tasks SET deleted_at = ? WHERE id = ?').run(NOW.toISOString(), id)
    apnsFailed.mockClear()
    webPush.mockClear()

    await notifyEnrichmentFailed(id, TEST_USER_ID)
    expect(apnsFailed).not.toHaveBeenCalled()
    expect(webPush).not.toHaveBeenCalled()
  })

  test('retried and failed again: a new failure, a new alert', async () => {
    const id = newTask('something vague')
    await failForGood(id)
    await flush()
    expect(apnsFailed).toHaveBeenCalledTimes(1)

    reprocessTask({ userId: TEST_USER_ID, taskId: id })
    await failForGood(id)
    await flush()
    expect(notifier).toHaveBeenCalledTimes(2)
    expect(apnsFailed).toHaveBeenCalledTimes(2)
  })

  test('a task that was already ai-failed is never announced (only the transition is)', async () => {
    const id = newTask('failed before this shipped')
    const labels = getTaskById(id)!.labels.map((l) => (l === 'ai-to-process' ? 'ai-failed' : l))
    getDb().prepare('UPDATE tasks SET labels = ? WHERE id = ?').run(JSON.stringify(labels), id)

    await processEnrichmentQueue()
    await flush()

    expect(enrichmentQueryMock).not.toHaveBeenCalled()
    expect(notifier).not.toHaveBeenCalled()
    expect(apnsFailed).not.toHaveBeenCalled()
  })
})
