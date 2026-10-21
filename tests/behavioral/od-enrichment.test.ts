/**
 * OD-E: ON DECK meets AI enrichment (2026-10-20, red-team B1). Enrichment
 * writes its target in raw SQL, so it asks the deck clear itself
 * (`collectEnrichmentTarget` → `collectDeckClear`): a target the AI set is a
 * pick and takes the deck off; a deadline it found leaves an automatic target
 * and the deck stays. (D3 makes enrichment put day-only wording on deck; this
 * only pins the clear.) The model is mocked.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { setupTestDb, teardownTestDb, TEST_USER_ID, TEST_TIMEZONE } from '../helpers/setup'

process.env.OPENTASK_AI_PROVIDER = 'anthropic'
process.env.ANTHROPIC_API_KEY = 'test-key'
process.env.OPENTASK_AI_ENRICHMENT_MODEL = 'test-model'

vi.mock('@/core/ai/sdk', () => ({
  isAIEnabled: () => true,
  initAI: async () => {},
  aiQuery: vi.fn(),
}))

vi.mock('@/core/ai/enrichment-slot', () => ({
  enrichmentQuery: vi.fn(),
  initEnrichmentSlot: vi.fn(),
  getEnrichmentSlotStats: vi.fn(),
  shutdownEnrichmentSlot: vi.fn(),
}))

import { getDb } from '@/core/db'
import { createTask, getTaskById, updateTask } from '@/core/tasks'
import { executeUndo } from '@/core/undo'
import { enrichSingleTask, _resetCircuitBreaker, _resetProcessingState } from '@/core/ai/enrichment'
import { enrichmentQuery } from '@/core/ai/enrichment-slot'
import type { EnrichmentResult } from '@/core/ai/types'

const mockEnrichmentQuery = vi.mocked(enrichmentQuery)

function modelAnswer(overrides: Partial<EnrichmentResult>) {
  return {
    structuredOutput: {
      title: 'Clean title',
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
      reasoning: 'test',
      ...overrides,
    },
    text: null,
    durationMs: 50,
  }
}

/** A title-only task, then put on deck for Wed Oct 14 (straight to the row). */
function deckedTitleOnly(title: string) {
  const task = createTask({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, input: { title } })
  getDb().prepare("UPDATE tasks SET on_deck_day = '2026-10-14' WHERE id = ?").run(task.id)
  return task
}

beforeAll(() => {
  setupTestDb()
  getDb().prepare("UPDATE users SET ai_enrichment_mode = 'sdk' WHERE id = ?").run(TEST_USER_ID)
})
afterAll(() => teardownTestDb())
beforeEach(() => {
  // Sat Oct 10 2026, 8 PM Chicago.
  vi.setSystemTime(new Date('2026-10-11T01:00:00Z'))
})
afterEach(() => {
  vi.useRealTimers()
  mockEnrichmentQuery.mockReset()
  _resetCircuitBreaker()
  _resetProcessingState()
})

describe('OD-E: enrichment and the deck', () => {
  test('OD-E01: a target from the wording is a pick — the deck goes, in the same undo entry', async () => {
    const task = deckedTitleOnly('call the bank wednesday at 2pm')
    // A RE-enrichment (the initial one writes no undo entry of its own): an
    // edit first, then ai-to-process again.
    updateTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
      input: { priority: 1 },
    })
    getDb()
      .prepare(
        "UPDATE tasks SET labels = json_insert(labels, '$[#]', 'ai-to-process') WHERE id = ?",
      )
      .run(task.id)
    mockEnrichmentQuery.mockResolvedValueOnce(
      modelAnswer({ title: 'Call the bank', due_at: '2026-10-14T14:00:00' }),
    )
    await enrichSingleTask(task.id, TEST_USER_ID)
    const after = getTaskById(task.id)!
    expect(after.due_at).toBe('2026-10-14T19:00:00.000Z')
    expect(after.on_deck_day).toBeNull()
    executeUndo(TEST_USER_ID)
    expect(getTaskById(task.id)!).toMatchObject({ due_at: null, on_deck_day: '2026-10-14' })
  })

  test('OD-E02: a deadline found leaves an automatic target — the deck stays', async () => {
    const task = deckedTitleOnly('renew the permit by the 30th')
    mockEnrichmentQuery.mockResolvedValueOnce(
      modelAnswer({ title: 'Renew the permit', deadline_at: '2026-10-30T23:59:00' }),
    )
    await enrichSingleTask(task.id, TEST_USER_ID)
    const after = getTaskById(task.id)!
    expect(after.target_auto).toBe(true)
    expect(after.on_deck_day).toBe('2026-10-14')
  })

  test('OD-E03: nothing dated — the deck stays', async () => {
    const task = deckedTitleOnly('look into a new couch')
    mockEnrichmentQuery.mockResolvedValueOnce(modelAnswer({ title: 'Look into a new couch' }))
    await enrichSingleTask(task.id, TEST_USER_ID)
    expect(getTaskById(task.id)!.on_deck_day).toBe('2026-10-14')
    // Undo of the enrichment leaves it too (nothing about the deck changed).
    executeUndo(TEST_USER_ID)
    expect(getTaskById(task.id)!.on_deck_day).toBe('2026-10-14')
  })
})
