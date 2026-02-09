/**
 * Behavioral tests for AI Bubble recommendations
 *
 * Tests the recommendation logic, caching, and task selection.
 * SDK is mocked — no real AI calls.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { setupTestDb, teardownTestDb, TEST_USER_ID, TEST_TIMEZONE } from '../helpers/setup'
import type { TaskSummary } from '@/core/ai/types'

// Mock the SDK to prevent real subprocess spawning
vi.mock('@/core/ai/sdk', () => ({
  isAIEnabled: () => true,
  initAI: vi.fn(),
  aiQuery: vi.fn(),
}))

import { generateBubble, getCachedBubble } from '@/core/ai/bubble'
import { aiQuery } from '@/core/ai/sdk'

const mockAiQuery = vi.mocked(aiQuery)

function makeTasks(count: number, overrides?: Partial<TaskSummary>[]): TaskSummary[] {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    title: `Task ${i + 1}`,
    priority: 0,
    due_at: null,
    labels: [],
    project_name: 'Inbox',
    is_recurring: false,
    snooze_count: 0,
    ...(overrides?.[i] ?? {}),
  }))
}

beforeAll(() => {
  setupTestDb()
})

afterAll(() => {
  teardownTestDb()
})

afterEach(() => {
  mockAiQuery.mockReset()
})

describe('generateBubble', () => {
  test('returns empty summary when no tasks', async () => {
    const result = await generateBubble(TEST_USER_ID, TEST_TIMEZONE, [])
    expect(result).not.toBeNull()
    expect(result!.tasks).toEqual([])
    expect(result!.summary).toContain('No active tasks')
  })

  test('calls aiQuery with task data and returns parsed result', async () => {
    mockAiQuery.mockResolvedValueOnce({
      structuredOutput: {
        tasks: [
          { task_id: 1, reason: 'Sitting idle for weeks' },
          { task_id: 3, reason: 'Snoozed 5 times' },
        ],
        summary: 'Two tasks need your attention.',
        generated_at: new Date().toISOString(),
      },
      textResult: null,
      durationMs: 500,
      success: true,
      error: null,
    })

    const tasks = makeTasks(5)
    const result = await generateBubble(TEST_USER_ID, TEST_TIMEZONE, tasks)

    expect(result).not.toBeNull()
    expect(result!.tasks).toHaveLength(2)
    expect(result!.tasks[0].task_id).toBe(1)
    expect(result!.summary).toBe('Two tasks need your attention.')
    expect(mockAiQuery).toHaveBeenCalledOnce()
  })

  test('filters out task IDs not in the provided task list', async () => {
    mockAiQuery.mockResolvedValueOnce({
      structuredOutput: {
        tasks: [
          { task_id: 1, reason: 'Good task' },
          { task_id: 999, reason: 'Non-existent task' },
        ],
        summary: 'Test',
        generated_at: new Date().toISOString(),
      },
      textResult: null,
      durationMs: 100,
      success: true,
      error: null,
    })

    const tasks = makeTasks(3)
    const result = await generateBubble(TEST_USER_ID, TEST_TIMEZONE, tasks)

    expect(result).not.toBeNull()
    expect(result!.tasks).toHaveLength(1)
    expect(result!.tasks[0].task_id).toBe(1)
  })

  test('returns null on AI failure', async () => {
    mockAiQuery.mockResolvedValueOnce({
      structuredOutput: null,
      textResult: null,
      durationMs: 100,
      success: false,
      error: 'Connection failed',
    })

    const tasks = makeTasks(5)
    const result = await generateBubble(TEST_USER_ID, TEST_TIMEZONE, tasks)
    expect(result).toBeNull()
  })

  test('falls back to text parsing when structured output is null', async () => {
    mockAiQuery.mockResolvedValueOnce({
      structuredOutput: null,
      textResult: JSON.stringify({
        tasks: [{ task_id: 2, reason: 'From text' }],
        summary: 'Parsed from text',
        generated_at: new Date().toISOString(),
      }),
      durationMs: 100,
      success: true,
      error: null,
    })

    const tasks = makeTasks(5)
    const result = await generateBubble(TEST_USER_ID, TEST_TIMEZONE, tasks)
    expect(result).not.toBeNull()
    expect(result!.summary).toBe('Parsed from text')
  })

  test('caches result in ai_activity_log', async () => {
    mockAiQuery.mockResolvedValueOnce({
      structuredOutput: {
        tasks: [{ task_id: 1, reason: 'Cached result' }],
        summary: 'Cached',
        generated_at: new Date().toISOString(),
      },
      textResult: null,
      durationMs: 200,
      success: true,
      error: null,
    })

    const tasks = makeTasks(3)
    await generateBubble(TEST_USER_ID, TEST_TIMEZONE, tasks)

    // getCachedBubble should return the cached result
    const cached = getCachedBubble(TEST_USER_ID)
    expect(cached).not.toBeNull()
    expect(cached!.summary).toBe('Cached')
    expect(cached!.tasks).toHaveLength(1)
  })
})

describe('getCachedBubble', () => {
  test('returns null when no cached data', () => {
    // Use a user ID that has no cached data
    const result = getCachedBubble(99999)
    expect(result).toBeNull()
  })
})
