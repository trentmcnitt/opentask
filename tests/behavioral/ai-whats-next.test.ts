/**
 * Behavioral tests for AI What's Next recommendations
 *
 * Tests the recommendation logic, caching, and task selection.
 * SDK is mocked — no real AI calls.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { setupTestDb, teardownTestDb, TEST_USER_ID, TEST_TIMEZONE } from '../helpers/setup'
import type { TaskSummary } from '@/core/ai/types'

// Set provider and models so resolveFeatureAIConfig() works in tests (no real API calls are made)
process.env.OPENTASK_AI_PROVIDER = 'anthropic'
process.env.ANTHROPIC_API_KEY = 'test-key'
process.env.OPENTASK_AI_WHATS_NEXT_MODEL = 'test-model'

// Mock the SDK to prevent real subprocess spawning
vi.mock('@/core/ai/sdk', () => ({
  isAIEnabled: () => true,
  initAI: vi.fn(),
  aiQuery: vi.fn(),
}))

import { generateWhatsNext, getCachedWhatsNext } from '@/core/ai/whats-next'
import { getDb } from '@/core/db'
import { aiQuery } from '@/core/ai/sdk'

const mockAiQuery = vi.mocked(aiQuery)

function makeTasks(count: number, overrides?: Partial<TaskSummary>[]): TaskSummary[] {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    title: `Task ${i + 1}`,
    priority: 0,
    due_at: null,
    original_due_at: null,
    created_at: '2026-02-01T12:00:00Z',
    labels: [],
    project_name: 'Inbox',
    is_recurring: false,
    rrule: null,
    notes: null,
    recurrence_mode: 'from_due' as const,
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
  // Clear cached whats_next entries so tests don't leak state
  getDb().prepare("DELETE FROM ai_activity_log WHERE action = 'whats_next'").run()
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
    const result = await generateWhatsNext(TEST_USER_ID, TEST_TIMEZONE, tasks)

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
    const result = await generateWhatsNext(TEST_USER_ID, TEST_TIMEZONE, tasks)

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
    const result = await generateWhatsNext(TEST_USER_ID, TEST_TIMEZONE, tasks)
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
    const result = await generateWhatsNext(TEST_USER_ID, TEST_TIMEZONE, tasks)
    expect(result).not.toBeNull()
    expect(result!.summary).toBe('Parsed from text')
  })

  test('parses JSON from markdown code block with missing summary', async () => {
    // Real-world: AI returns text with JSON in a code block but puts summary as prose
    const jsonBlock = JSON.stringify({
      generated_at: '2026-02-09T18:26:35.354Z',
      tasks: [
        { task_id: 1, summary: 'Jump starter overdue', reason: 'Snoozed 3 times' },
        { task_id: 3, reason: 'Social obligation delayed' },
      ],
    })
    mockAiQuery.mockResolvedValueOnce({
      structuredOutput: null,
      textResult: `Here are tasks that need attention:\n\n\`\`\`json\n${jsonBlock}\n\`\`\`\n\n**The pattern:** You have snoozed items and overdue social obligations.`,
      durationMs: 14000,
      success: true,
      error: null,
    })

    const tasks = makeTasks(5)
    const result = await generateWhatsNext(TEST_USER_ID, TEST_TIMEZONE, tasks)
    expect(result).not.toBeNull()
    expect(result!.tasks).toHaveLength(2)
    expect(result!.tasks[0].task_id).toBe(1)
    // summary should get a default since it's missing from the JSON
    expect(result!.summary).toBeTruthy()
  })

  test('handles tasks_to_surface field name variant', async () => {
    // Real-world: AI uses "tasks_to_surface" instead of "tasks"
    const jsonBlock = JSON.stringify({
      generated_at: '2026-02-09T18:13:09.603Z',
      tasks_to_surface: [
        { task_id: 2, reason: 'Overdue and snoozed', summary: 'Ignored for days' },
      ],
    })
    mockAiQuery.mockResolvedValueOnce({
      structuredOutput: null,
      textResult: `\`\`\`json\n${jsonBlock}\n\`\`\``,
      durationMs: 14000,
      success: true,
      error: null,
    })

    const tasks = makeTasks(5)
    const result = await generateWhatsNext(TEST_USER_ID, TEST_TIMEZONE, tasks)
    expect(result).not.toBeNull()
    expect(result!.tasks).toHaveLength(1)
    expect(result!.tasks[0].task_id).toBe(2)
  })

  test('handles text response with extra per-task fields', async () => {
    // Real-world: AI adds title/summary fields per task that aren't in schema
    const jsonBlock = JSON.stringify({
      generated_at: '2026-02-09T18:11:50.373Z',
      tasks: [
        { task_id: 1, title: 'Charge jump starter', reason: 'Snoozed 3 times', summary: 'Overdue' },
        { task_id: 3, title: 'Call Granddaddy', reason: 'Social obligation', summary: 'Delayed' },
      ],
      summary: 'Two tasks need decisions.',
    })
    mockAiQuery.mockResolvedValueOnce({
      structuredOutput: null,
      textResult: jsonBlock,
      durationMs: 13000,
      success: true,
      error: null,
    })

    const tasks = makeTasks(5)
    const result = await generateWhatsNext(TEST_USER_ID, TEST_TIMEZONE, tasks)
    expect(result).not.toBeNull()
    expect(result!.tasks).toHaveLength(2)
    // Extra per-task fields (title, summary) should be stripped by Zod
    expect(result!.tasks[0]).toEqual({ task_id: 1, reason: 'Snoozed 3 times' })
    expect(result!.summary).toBe('Two tasks need decisions.')
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
    await generateWhatsNext(TEST_USER_ID, TEST_TIMEZONE, tasks)

    // getCachedWhatsNext should return the cached result
    const cached = getCachedWhatsNext(TEST_USER_ID)
    expect(cached).not.toBeNull()
    expect(cached!.result.summary).toBe('Cached')
    expect(cached!.result.tasks).toHaveLength(1)
  })
})

describe('getCachedWhatsNext', () => {
  test('returns null when no cached data', () => {
    // Use a user ID that has no cached data
    const result = getCachedWhatsNext(99999)
    expect(result).toBeNull()
  })
})

describe('cache expiry', () => {
  test('cache expires after midnight', () => {
    vi.setSystemTime(new Date('2026-02-09T23:00:00Z'))

    // Insert a cache entry from "yesterday" — getCachedWhatsNext should ignore it
    const db = getDb()
    const yesterday = '2026-02-08T22:00:00Z'
    db.prepare(
      `INSERT INTO ai_activity_log (user_id, task_id, action, status, input, output, model, duration_ms, error, created_at)
       VALUES (?, NULL, 'whats_next', 'success', NULL, ?, 'haiku', 100, NULL, ?)`,
    ).run(
      TEST_USER_ID,
      JSON.stringify({ tasks: [], summary: 'Old', generated_at: yesterday }),
      yesterday,
    )

    const cached = getCachedWhatsNext(TEST_USER_ID)
    expect(cached).toBeNull()

    vi.useRealTimers()
  })

  test('multi-user cache isolation', async () => {
    mockAiQuery.mockResolvedValueOnce({
      structuredOutput: {
        tasks: [{ task_id: 1, reason: 'Test' }],
        summary: 'User 1 result',
        generated_at: new Date().toISOString(),
      },
      textResult: null,
      durationMs: 100,
      success: true,
      error: null,
    })

    const tasks = makeTasks(3)
    await generateWhatsNext(TEST_USER_ID, TEST_TIMEZONE, tasks)

    // Different user should not see user 1's cache
    const cached = getCachedWhatsNext(99998)
    expect(cached).toBeNull()
  })
})
