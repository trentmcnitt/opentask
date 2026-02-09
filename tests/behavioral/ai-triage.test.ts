/**
 * Behavioral tests for AI triage (task ordering)
 *
 * Tests the triage logic, caching, and ID validation.
 * SDK is mocked — no real AI calls.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { setupTestDb, teardownTestDb, TEST_USER_ID, TEST_TIMEZONE } from '../helpers/setup'
import type { TaskSummary } from '@/core/ai/types'

vi.mock('@/core/ai/sdk', () => ({
  isAIEnabled: () => true,
  initAI: vi.fn(),
  aiQuery: vi.fn(),
}))

import { triageTasks, clearTriageCache } from '@/core/ai/triage'
import { aiQuery } from '@/core/ai/sdk'

const mockAiQuery = vi.mocked(aiQuery)

function makeTasks(count: number): TaskSummary[] {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    title: `Task ${i + 1}`,
    priority: 0,
    due_at: null,
    labels: [],
    project_name: 'Inbox',
    is_recurring: false,
    snooze_count: 0,
  }))
}

beforeAll(() => {
  setupTestDb()
})

afterAll(() => {
  teardownTestDb()
})

afterEach(() => {
  clearTriageCache()
  mockAiQuery.mockReset()
})

describe('triageTasks', () => {
  test('returns empty result when no tasks', async () => {
    const result = await triageTasks(TEST_USER_ID, TEST_TIMEZONE, [])
    expect(result).not.toBeNull()
    expect(result!.ordered_task_ids).toEqual([])
  })

  test('returns ordered task IDs from AI', async () => {
    mockAiQuery.mockResolvedValueOnce({
      structuredOutput: {
        ordered_task_ids: [3, 1, 2],
        reasoning: 'Task 3 is most urgent',
      },
      textResult: null,
      durationMs: 200,
      success: true,
      error: null,
    })

    const tasks = makeTasks(3)
    const result = await triageTasks(TEST_USER_ID, TEST_TIMEZONE, tasks)

    expect(result).not.toBeNull()
    expect(result!.ordered_task_ids).toEqual([3, 1, 2])
    expect(result!.reasoning).toBe('Task 3 is most urgent')
  })

  test('filters out invalid task IDs', async () => {
    mockAiQuery.mockResolvedValueOnce({
      structuredOutput: {
        ordered_task_ids: [1, 999, 2, 888],
        reasoning: 'Some are invalid',
      },
      textResult: null,
      durationMs: 100,
      success: true,
      error: null,
    })

    const tasks = makeTasks(3)
    const result = await triageTasks(TEST_USER_ID, TEST_TIMEZONE, tasks)

    expect(result).not.toBeNull()
    expect(result!.ordered_task_ids).toEqual([1, 2])
  })

  test('caches results and avoids duplicate AI calls', async () => {
    mockAiQuery.mockResolvedValueOnce({
      structuredOutput: {
        ordered_task_ids: [1, 2],
        reasoning: 'Cached result',
      },
      textResult: null,
      durationMs: 100,
      success: true,
      error: null,
    })

    const tasks = makeTasks(2)
    await triageTasks(TEST_USER_ID, TEST_TIMEZONE, tasks)
    const result2 = await triageTasks(TEST_USER_ID, TEST_TIMEZONE, tasks)

    expect(result2!.reasoning).toBe('Cached result')
    expect(mockAiQuery).toHaveBeenCalledOnce()
  })

  test('returns null on AI failure', async () => {
    mockAiQuery.mockResolvedValueOnce({
      structuredOutput: null,
      textResult: null,
      durationMs: 100,
      success: false,
      error: 'Timeout',
    })

    const tasks = makeTasks(5)
    const result = await triageTasks(TEST_USER_ID, TEST_TIMEZONE, tasks)
    expect(result).toBeNull()
  })

  test('extracts task IDs from markdown text when structured output fails', async () => {
    mockAiQuery.mockResolvedValueOnce({
      structuredOutput: null,
      textResult: `Here are the tasks ordered by importance:

1. [3] Task 3 — Most urgent, due today
2. [1] Task 1 — High priority
3. [2] Task 2 — Can wait but still important`,
      durationMs: 300,
      success: true,
      error: null,
    })

    const tasks = makeTasks(3)
    const result = await triageTasks(TEST_USER_ID, TEST_TIMEZONE, tasks)

    expect(result).not.toBeNull()
    expect(result!.ordered_task_ids).toEqual([3, 1, 2])
  })

  test('cache expires after 5 minutes', async () => {
    vi.setSystemTime(new Date('2026-02-09T10:00:00Z'))

    mockAiQuery.mockResolvedValueOnce({
      structuredOutput: { ordered_task_ids: [1, 2], reasoning: 'First call' },
      textResult: null,
      durationMs: 100,
      success: true,
      error: null,
    })

    const tasks = makeTasks(2)
    await triageTasks(TEST_USER_ID, TEST_TIMEZONE, tasks)
    expect(mockAiQuery).toHaveBeenCalledOnce()

    // Advance 6 minutes — cache should be stale
    vi.setSystemTime(new Date('2026-02-09T10:06:00Z'))

    mockAiQuery.mockResolvedValueOnce({
      structuredOutput: { ordered_task_ids: [2, 1], reasoning: 'Second call' },
      textResult: null,
      durationMs: 100,
      success: true,
      error: null,
    })

    const result2 = await triageTasks(TEST_USER_ID, TEST_TIMEZONE, tasks)
    expect(result2!.reasoning).toBe('Second call')
    expect(mockAiQuery).toHaveBeenCalledTimes(2)

    vi.useRealTimers()
  })

  test('markdown fallback filters out invalid IDs', async () => {
    mockAiQuery.mockResolvedValueOnce({
      structuredOutput: null,
      textResult: `1. [3] Important
2. [999] Does not exist
3. [1] Also important`,
      durationMs: 100,
      success: true,
      error: null,
    })

    const tasks = makeTasks(3)
    const result = await triageTasks(TEST_USER_ID, TEST_TIMEZONE, tasks)

    expect(result).not.toBeNull()
    expect(result!.ordered_task_ids).toEqual([3, 1])
  })
})
