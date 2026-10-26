/**
 * Quota enrichment — create and the write path (2026-10-24)
 *
 * A quota made from words: `createTask({title, is_tracked: true})` stores a
 * PROVISIONAL weekly quota (target 1, `ai-to-process`) when enrichment will
 * run, and refuses as before when it will not. The enrichment then routes the
 * row to the quota prompt and writes its answer through `collectFieldChanges`
 * (`applyQuotaEnrichment`): the stated period and count, the reminder period,
 * one explicit label — with the undo, race and kind-change rules of the task
 * path. Runs the real pipeline with the model call mocked.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { setupTestDb, teardownTestDb, TEST_USER_ID, TEST_TIMEZONE } from '../helpers/setup'

process.env.OPENTASK_AI_PROVIDER = 'anthropic'
process.env.ANTHROPIC_API_KEY = 'test-key'
process.env.OPENTASK_AI_ENRICHMENT_MODEL = 'test-model'

const { enrichmentQueryMock, ai } = vi.hoisted(() => ({
  enrichmentQueryMock: vi.fn(),
  ai: { enabled: true },
}))

vi.mock('@/core/ai/sdk', () => ({
  isAIEnabled: () => ai.enabled,
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

import { getDb } from '@/core/db'
import { createTask, getTaskById, updateTask } from '@/core/tasks'
import { incrementProgress } from '@/core/tasks/progress'
import { listTimeSlots } from '@/core/time-slots'
import {
  _resetCircuitBreaker,
  _resetProcessingState,
  describeEnrichment,
  enrichSingleTask,
  processEnrichmentQueue,
} from '@/core/ai/enrichment'
import { QUOTA_PROVISIONAL_RULE } from '@/core/ai/quota-enrichment'
import { _resetEnrichmentNotifyState } from '@/core/notifications/enrichment-notify'
import { sendApnsEnrichedNotification } from '@/core/notifications/apns'
import { QUOTA_PERIOD_MESSAGE } from '@/core/validation'
import { ValidationError } from '@/core/errors'

// 10:00 AM Chicago on Thursday 2026-01-15.
const NOW = new Date('2026-01-15T16:00:00Z')

function answer(fields: Record<string, unknown>) {
  return {
    structuredOutput: {
      reasoning: 'test',
      due_at: null,
      deadline_at: null,
      horizon: null,
      priority: 0,
      labels: [],
      project_name: null,
      rrule: null,
      auto_snooze_minutes: null,
      recurrence_mode: null,
      notes: null,
      quota_target: null,
      quota_period: null,
      quota_interval: null,
      quota_prompt_time: null,
      quota_prompt_enabled: null,
      ...fields,
    },
    text: null,
    durationMs: 1,
  }
}

function newQuota(title: string) {
  return createTask({
    userId: TEST_USER_ID,
    userTimezone: TEST_TIMEZONE,
    input: { title, is_tracked: true },
  })
}

function undoCount(taskId: number): number {
  return (
    getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM undo_log WHERE user_id = ? AND EXISTS (
           SELECT 1 FROM json_each(snapshot) WHERE json_extract(value, '$.task_id') = ?)`,
      )
      .get(TEST_USER_ID, taskId) as { n: number }
  ).n
}

function setMode(mode: string): void {
  getDb().prepare('UPDATE users SET ai_enrichment_mode = ? WHERE id = ?').run(mode, TEST_USER_ID)
}

function slotId(label: string): number {
  return listTimeSlots(TEST_USER_ID).find((s) => s.label === label)!.id
}

const apns = vi.mocked(sendApnsEnrichedNotification)

beforeAll(() => {
  setupTestDb()
})

afterAll(() => {
  teardownTestDb()
})

beforeEach(() => {
  vi.setSystemTime(NOW)
  ai.enabled = true
  setMode('sdk')
  getDb()
    .prepare('UPDATE users SET notifications_enabled = 1, enrichment_notifications_enabled = 1')
    .run()
  enrichmentQueryMock.mockReset()
  apns.mockClear()
  _resetProcessingState()
  _resetCircuitBreaker()
  _resetEnrichmentNotifyState()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('QE-C: creating a quota from words', () => {
  test('QE-C01: with enrichment on, a rule-less quota is stored provisional (weekly, target 1) and queued', () => {
    const quota = newQuota('eggs twice a week')
    expect(quota.rrule).toBe(QUOTA_PROVISIONAL_RULE)
    expect(quota.progress_target).toBe(1)
    expect(quota.is_tracked).toBe(true)
    expect(quota.due_at).toBeNull()
    expect(quota.labels).toContain('ai-to-process')
  })

  test('QE-C02: with the user’s enrichment off, it is refused — saying how to avoid it', () => {
    setMode('off')
    expect(() => newQuota('eggs twice a week')).toThrow(QUOTA_PERIOD_MESSAGE)
    expect(() => newQuota('eggs twice a week')).toThrow(/turn on AI enrichment/)
  })

  test('QE-C03: with AI off on the server, it is refused', () => {
    ai.enabled = false
    expect(() => newQuota('eggs twice a week')).toThrow(ValidationError)
  })

  test('QE-C04: an explicit rrule null, or a stated count with no rule, is still refused', () => {
    expect(() =>
      createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'x', is_tracked: true, rrule: null },
      }),
    ).toThrow(QUOTA_PERIOD_MESSAGE)
    // A count above 1 is structured input: no enrichment, so no provisional period.
    expect(() =>
      createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'x', progress_target: 3 },
      }),
    ).toThrow(QUOTA_PERIOD_MESSAGE)
  })

  test('QE-C05: a quota sent with its rule is untouched (not title-only, no enrichment)', () => {
    const quota = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Read', is_tracked: true, rrule: 'FREQ=DAILY' },
    })
    expect(quota.rrule).toBe('FREQ=DAILY')
    expect(quota.labels).not.toContain('ai-to-process')
  })
})

describe('QE-A: applying a quota’s enrichment', () => {
  test('QE-A01: the stated period, count, reminder period and label land; no undo entry of its own', async () => {
    const quota = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'stretch twice a day at lunch, label it fitness', is_tracked: true },
    })
    enrichmentQueryMock.mockResolvedValue(
      answer({
        title: 'Stretch',
        labels: ['fitness'],
        quota_target: 2,
        quota_period: 'day',
        quota_prompt_time: 'Midday',
      }),
    )

    const fields = await enrichSingleTask(quota.id, TEST_USER_ID)

    const after = getTaskById(quota.id)!
    expect(after).toMatchObject({
      title: 'Stretch',
      rrule: 'FREQ=DAILY',
      progress_target: 2,
      is_tracked: true,
      due_at: null,
      quota_prompt_config: { slot_id: slotId('Midday') },
    })
    expect(after.labels).toEqual(['fitness'])
    // The quota prompt was the one sent.
    expect(enrichmentQueryMock.mock.calls[0][0]).toContain('This one is a quota, not a task')
    // Initial enrichment: the create's entry is the only one (undoing it trashes the quota).
    expect(undoCount(quota.id)).toBe(1)
    expect(fields).toEqual(
      expect.arrayContaining(['title', 'rrule', 'progress_target', 'quota_prompt_config']),
    )
    expect(describeEnrichment(quota.id, TEST_USER_ID, fields!)?.description).toBe(
      '2× a day · Reminds at Midday · fitness',
    )
  })

  test('QE-A02: no period said → the provisional period stays; a task-style rule falls back to its day count', async () => {
    const a = newQuota('piano scales')
    enrichmentQueryMock.mockResolvedValue(answer({ title: 'Piano scales', quota_target: 1 }))
    await enrichSingleTask(a.id, TEST_USER_ID)
    expect(getTaskById(a.id)).toMatchObject({ rrule: 'FREQ=WEEKLY', progress_target: 1 })
    expect(getTaskById(a.id)!.labels).not.toContain('ai-to-process')

    const b = newQuota('eggs twice a week')
    enrichmentQueryMock.mockResolvedValue(
      answer({ title: 'Eggs', rrule: 'FREQ=WEEKLY;BYDAY=TU,TH' }),
    )
    await enrichSingleTask(b.id, TEST_USER_ID)
    expect(getTaskById(b.id)).toMatchObject({ rrule: 'FREQ=WEEKLY', progress_target: 2 })
  })

  test('QE-A03: "don’t remind me" turns the prompt off; no label is inferred', async () => {
    const quota = newQuota("floss daily, don't remind me")
    enrichmentQueryMock.mockResolvedValue(
      answer({
        title: 'Floss',
        labels: ['health'],
        quota_target: 1,
        quota_period: 'day',
        quota_prompt_enabled: false,
      }),
    )
    await enrichSingleTask(quota.id, TEST_USER_ID)
    const after = getTaskById(quota.id)!
    expect(after.quota_prompt_config).toEqual({ enabled: false })
    expect(after.labels).toEqual([])
  })

  test('QE-A04: a +1 logged while the model ran is carried through the period change', async () => {
    const quota = newQuota('read every day')
    enrichmentQueryMock.mockImplementation(async () => {
      incrementProgress({ userId: TEST_USER_ID, taskId: quota.id })
      return answer({ title: 'Read', quota_target: 1, quota_period: 'day' })
    })
    await enrichSingleTask(quota.id, TEST_USER_ID)
    const after = getTaskById(quota.id)!
    expect(after.rrule).toBe('FREQ=DAILY')
    expect(after.progress_current).toBe(1)
  })

  test('QE-A05: edited by the user while the model ran → nothing applied', async () => {
    const quota = newQuota('lift 3x a week')
    enrichmentQueryMock.mockImplementation(async () => {
      updateTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        taskId: quota.id,
        input: { title: 'My lifting' },
      })
      return answer({ title: 'Lift', quota_target: 3, quota_period: 'week' })
    })
    await enrichSingleTask(quota.id, TEST_USER_ID)
    expect(getTaskById(quota.id)).toMatchObject({ title: 'My lifting', progress_target: 1 })
  })

  test('QE-A06: no longer a quota when the answer lands → dropped, the trigger label removed', async () => {
    const quota = newQuota('lift 3x a week')
    enrichmentQueryMock.mockImplementation(async () => {
      // A conversion that leaves the label (raw, as a writer that does not cancel enrichment).
      getDb()
        .prepare('UPDATE tasks SET is_tracked = 0, progress_target = 1, rrule = NULL WHERE id = ?')
        .run(quota.id)
      return answer({ title: 'Lift', quota_target: 3, quota_period: 'week' })
    })
    await enrichSingleTask(quota.id, TEST_USER_ID)
    const after = getTaskById(quota.id)!
    expect(after.title).toBe('lift 3x a week')
    expect(after.rrule).toBeNull()
    expect(after.labels).not.toContain('ai-to-process')
  })

  test('QE-A07: a re-enrichment (ai-failed reprocessed) logs one undo entry of its own', async () => {
    const quota = newQuota('journal 5x a week')
    enrichmentQueryMock.mockRejectedValue(new Error('model down'))
    await enrichSingleTask(quota.id, TEST_USER_ID)
    await enrichSingleTask(quota.id, TEST_USER_ID)
    expect(getTaskById(quota.id)!.labels).toContain('ai-failed')

    const { reprocessTask } = await import('@/core/tasks/reprocess')
    reprocessTask({ userId: TEST_USER_ID, taskId: quota.id })
    const before = undoCount(quota.id)
    enrichmentQueryMock.mockReset()
    enrichmentQueryMock.mockResolvedValue(
      answer({ title: 'Journal', quota_target: 5, quota_period: 'week' }),
    )
    await enrichSingleTask(quota.id, TEST_USER_ID)
    expect(getTaskById(quota.id)).toMatchObject({ title: 'Journal', progress_target: 5 })
    expect(undoCount(quota.id)).toBe(before + 1)
    const last = getDb()
      .prepare('SELECT description FROM undo_log WHERE user_id = ? ORDER BY id DESC LIMIT 1')
      .get(TEST_USER_ID) as { description: string }
    expect(last.description).toMatch(/^AI: Enriched quota — set /)
  })

  test('QE-A08: the cron safety net routes a quota the same way', async () => {
    const quota = newQuota('call grandma once a fortnight')
    enrichmentQueryMock.mockResolvedValue(
      answer({ title: 'Call grandma', quota_target: 1, quota_period: 'week', quota_interval: 2 }),
    )
    await processEnrichmentQueue()
    expect(getTaskById(quota.id)!.rrule).toBe('FREQ=WEEKLY;INTERVAL=2')
  })
})

describe('QE-N: the "AI finished" push for a quota', () => {
  test('QE-N01: says it was added to Quotas, its count and reminder period; no buttons', async () => {
    const quota = newQuota('swim 3x a week, remind me at lunch')
    enrichmentQueryMock.mockResolvedValue(
      answer({
        title: 'Swim',
        quota_target: 3,
        quota_period: 'week',
        quota_prompt_time: 'Midday',
      }),
    )
    await enrichSingleTask(quota.id, TEST_USER_ID)
    await vi.waitFor(() => expect(apns).toHaveBeenCalledTimes(1))
    expect(apns).toHaveBeenCalledWith(TEST_USER_ID, {
      title: 'Swim',
      body: 'Added to Quotas · 3× a week · Reminds at Midday',
      taskId: quota.id,
      quota: true,
    })
  })
})
