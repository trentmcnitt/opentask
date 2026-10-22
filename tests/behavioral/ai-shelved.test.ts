/**
 * The shelved AI features (2026-10-22; src/core/ai/shelved.ts): What's Next,
 * Insights and Quick Take are shelved unless the server runs with
 * OPENTASK_AI_UNSHELVE=1. Pins the switch itself, the nightly runners (no AI
 * call while shelved, the old behaviour when on), the one shelved response,
 * and the preferences flag the web hides its UI by.
 */

import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { setupTestDb, TEST_USER_ID } from '../helpers/setup'

const { generateWhatsNext, generateInsightsForUser } = vi.hoisted(() => ({
  generateWhatsNext: vi.fn(async (..._args: unknown[]) => null),
  generateInsightsForUser: vi.fn(async (..._args: unknown[]) => undefined),
}))

vi.mock('@/core/ai/sdk', () => ({ isAIEnabled: () => true }))
vi.mock('@/core/ai/whats-next', () => ({ generateWhatsNext }))
vi.mock('@/core/ai/insights', () => ({ generateInsightsForUser }))
// One summary, so the runners reach the AI call for the seeded user.
vi.mock('@/core/ai/task-summaries', () => ({
  buildTaskSummaries: () => [{ id: 1, title: 'A task' }],
}))
vi.mock('@/core/ai/user-context', () => ({
  getUserFeatureModes: () => ({
    enrichment: 'api',
    quick_take: 'api',
    whats_next: 'api',
    insights: 'api',
  }),
  getUserAiContext: () => null,
}))
vi.mock('@/core/ai/models', () => ({ resolveFeatureAIConfig: () => ({}) }))

import { shelvedAiFeaturesOn, AI_SHELVED_MESSAGE, SHELVED_AI_FEATURES } from '@/core/ai/shelved'
import { runScheduledWhatsNext, runScheduledInsights } from '@/core/ai/scheduled'
import { featureShelved } from '@/lib/api-response'
import { parseServerPrefs, DEFAULT_PREFS } from '@/lib/preferences-state'

beforeAll(() => {
  setupTestDb()
})

beforeEach(() => {
  generateWhatsNext.mockClear()
  generateInsightsForUser.mockClear()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('the switch', () => {
  test('unset, empty or anything but "1" is shelved', () => {
    vi.stubEnv('OPENTASK_AI_UNSHELVE', '')
    expect(shelvedAiFeaturesOn()).toBe(false)
    vi.stubEnv('OPENTASK_AI_UNSHELVE', 'true')
    expect(shelvedAiFeaturesOn()).toBe(false)
    vi.stubEnv('OPENTASK_AI_UNSHELVE', '0')
    expect(shelvedAiFeaturesOn()).toBe(false)
  })

  test('"1" unshelves', () => {
    vi.stubEnv('OPENTASK_AI_UNSHELVE', '1')
    expect(shelvedAiFeaturesOn()).toBe(true)
  })

  test("shelves exactly Quick Take, What's Next and Insights — never enrichment", () => {
    expect([...SHELVED_AI_FEATURES].sort()).toEqual(['insights', 'quick_take', 'whats_next'])
  })
})

describe('the nightly runners', () => {
  test("shelved: What's Next makes no AI call", async () => {
    vi.stubEnv('OPENTASK_AI_UNSHELVE', '')
    await runScheduledWhatsNext()
    expect(generateWhatsNext).not.toHaveBeenCalled()
  })

  test('shelved: Insights makes no AI call', async () => {
    vi.stubEnv('OPENTASK_AI_UNSHELVE', '')
    await runScheduledInsights()
    expect(generateInsightsForUser).not.toHaveBeenCalled()
  })

  test("unshelved: What's Next runs for the user, as before", async () => {
    vi.stubEnv('OPENTASK_AI_UNSHELVE', '1')
    await runScheduledWhatsNext()
    expect(generateWhatsNext).toHaveBeenCalledTimes(1)
    expect((generateWhatsNext.mock.calls[0] as unknown[])[0]).toBe(TEST_USER_ID)
  })

  test('unshelved: Insights runs for the user, as before', async () => {
    vi.stubEnv('OPENTASK_AI_UNSHELVE', '1')
    await runScheduledInsights()
    expect(generateInsightsForUser).toHaveBeenCalledTimes(1)
    expect((generateInsightsForUser.mock.calls[0] as unknown[])[0]).toBe(TEST_USER_ID)
  })
})

describe('the shelved response', () => {
  test('410 Gone, FEATURE_SHELVED, no details', async () => {
    const res = featureShelved()
    expect(res.status).toBe(410)
    expect(await res.json()).toEqual({
      error: "What's Next, Insights and Quick Take are shelved",
      code: 'FEATURE_SHELVED',
    })
    expect(AI_SHELVED_MESSAGE).toBe("What's Next, Insights and Quick Take are shelved")
  })
})

describe('the preferences flag', () => {
  test('defaults to shelved until the preferences load', () => {
    expect(DEFAULT_PREFS.aiUnshelved).toBe(false)
  })

  test('ai_unshelved maps onto aiUnshelved; absent or malformed is left alone', () => {
    expect(parseServerPrefs({ ai_unshelved: true }).aiUnshelved).toBe(true)
    expect(parseServerPrefs({ ai_unshelved: false }).aiUnshelved).toBe(false)
    expect(parseServerPrefs({}).aiUnshelved).toBeUndefined()
    expect(parseServerPrefs({ ai_unshelved: 'yes' }).aiUnshelved).toBeUndefined()
  })
})
