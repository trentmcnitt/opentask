/**
 * Behavioral tests for AI "What's Next?" recommendations
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

import { generateWhatsNext, clearWhatsNextCache } from '@/core/ai/whats-next'
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
  clearWhatsNextCache()
  mockAiQuery.mockReset()
})

describe('generateWhatsNext', () => {
  test('returns empty summary when no tasks', async () => {
    const result = await generateWhatsNext(TEST_USER_ID, TEST_TIMEZONE, [])
    expect(result).not.toBeNull()
    expect(result!.tasks).toEqual([])
    expect(result!.summary).toContain('No active tasks')
  })

  test('calls aiQuery with task data and returns parsed result', async () => {
    mockAiQuery.mockResolvedValueOnce({
      structuredOutput: {
        tasks: [
          { task_id: 1, reason: 'Overdue and important' },
          { task_id: 3, reason: 'Due soon' },
        ],
        summary: 'Focus on the overdue task first.',
      },
      textResult: null,
      durationMs: 500,
      success: true,
      error: null,
    })

    const tasks = makeTasks(5)
    const result = await generateWhatsNext(TEST_USER_ID, TEST_TIMEZONE, tasks)

    expect(result).not.toBeNull()
    expect(result!.tasks).toHaveLength(2)
    expect(result!.tasks[0].task_id).toBe(1)
    expect(result!.summary).toBe('Focus on the overdue task first.')
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
      },
      textResult: null,
      durationMs: 100,
      success: true,
      error: null,
    })

    const tasks = makeTasks(3)
    const result = await generateWhatsNext(TEST_USER_ID, TEST_TIMEZONE, tasks)

    expect(result).not.toBeNull()
    expect(result!.tasks).toHaveLength(1)
    expect(result!.tasks[0].task_id).toBe(1)
  })

  test('caches results for 5 minutes', async () => {
    mockAiQuery.mockResolvedValueOnce({
      structuredOutput: {
        tasks: [{ task_id: 1, reason: 'First call' }],
        summary: 'First',
      },
      textResult: null,
      durationMs: 100,
      success: true,
      error: null,
    })

    const tasks = makeTasks(3)
    await generateWhatsNext(TEST_USER_ID, TEST_TIMEZONE, tasks)

    // Second call should use cache
    const result2 = await generateWhatsNext(TEST_USER_ID, TEST_TIMEZONE, tasks)
    expect(result2!.summary).toBe('First')
    expect(mockAiQuery).toHaveBeenCalledOnce() // Only called once
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
    const result = await generateWhatsNext(TEST_USER_ID, TEST_TIMEZONE, tasks)
    expect(result).toBeNull()
  })

  test('falls back to text parsing when structured output is null', async () => {
    mockAiQuery.mockResolvedValueOnce({
      structuredOutput: null,
      textResult: JSON.stringify({
        tasks: [{ task_id: 2, reason: 'From text' }],
        summary: 'Parsed from text',
      }),
      durationMs: 100,
      success: true,
      error: null,
    })

    const tasks = makeTasks(5)
    const result = await generateWhatsNext(TEST_USER_ID, TEST_TIMEZONE, tasks)
    expect(result).not.toBeNull()
    expect(result!.summary).toBe('Parsed from text')
  })
})

describe('generateWhatsNext — markdown fallback', () => {
  test('parses single-line markdown: "**[1] Title** — reason"', async () => {
    mockAiQuery.mockResolvedValueOnce({
      structuredOutput: null,
      textResult: `## Recommended Tasks

1. **[1] Task 1** — Overdue and needs immediate attention
2. **[3] Task 3** — Due soon, high priority
3. **[5] Task 5** — Has been snoozed many times

## Your Situation

You have 3 urgent tasks today.`,
      durationMs: 500,
      success: true,
      error: null,
    })

    const tasks = makeTasks(5)
    const result = await generateWhatsNext(TEST_USER_ID, TEST_TIMEZONE, tasks)

    expect(result).not.toBeNull()
    expect(result!.tasks.length).toBe(3)
    expect(result!.tasks[0].task_id).toBe(1)
    expect(result!.tasks[0].reason).toBeTruthy()
    expect(result!.summary).toContain('3 urgent tasks')
  })

  test('parses multi-line markdown: title on one line, reason on next', async () => {
    mockAiQuery.mockResolvedValueOnce({
      structuredOutput: null,
      textResult: `## Recommended Tasks

**[1] Task 1**
Overdue by 40 minutes — this is happening now.

**[3] Task 3**
Due in 1 hour and priority 3 — needs immediate attention.

---

**Your situation:** You have immediate commitments this evening.`,
      durationMs: 500,
      success: true,
      error: null,
    })

    const tasks = makeTasks(5)
    const result = await generateWhatsNext(TEST_USER_ID, TEST_TIMEZONE, tasks)

    expect(result).not.toBeNull()
    expect(result!.tasks.length).toBe(2)
    expect(result!.tasks[0].task_id).toBe(1)
    expect(result!.tasks[0].reason).toContain('Overdue')
    expect(result!.tasks[1].task_id).toBe(3)
    expect(result!.summary).toContain('immediate commitments')
  })

  test('markdown fallback filters out invalid task IDs', async () => {
    mockAiQuery.mockResolvedValueOnce({
      structuredOutput: null,
      textResult: `1. **[1] Task 1** — Important
2. **[999] Ghost task** — Not real
3. **[3] Task 3** — Also important`,
      durationMs: 100,
      success: true,
      error: null,
    })

    const tasks = makeTasks(3)
    const result = await generateWhatsNext(TEST_USER_ID, TEST_TIMEZONE, tasks)

    expect(result).not.toBeNull()
    expect(result!.tasks.map((t) => t.task_id)).toEqual([1, 3])
  })
})
