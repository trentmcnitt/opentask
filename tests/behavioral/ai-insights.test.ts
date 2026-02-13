/**
 * Behavioral tests for AI Insights
 *
 * Tests the insights logic: batch processing, result caching, session tracking,
 * and signal vocabulary. SDK is mocked — no real AI calls.
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

import {
  startInsightsGeneration,
  getInsightsSessionStatus,
  getInsightsResults,
  hasInsightsResults,
  getActiveInsightsSession,
  INSIGHTS_SIGNALS,
  SIGNAL_MAP,
} from '@/core/ai/insights'
import { getDb } from '@/core/db'
import { aiQuery } from '@/core/ai/sdk'
import { INSIGHTS_SIGNAL_KEYS } from '@/core/ai/types'

const mockAiQuery = vi.mocked(aiQuery)

/**
 * Create TaskSummary objects AND insert corresponding task rows in the DB.
 * The ai_insights_results table has a FK constraint on task_id → tasks(id),
 * so actual task rows must exist for storeInsightsResults to succeed.
 */
function makeTasks(count: number, overrides?: Partial<TaskSummary>[]): TaskSummary[] {
  const db = getDb()
  const now = '2026-02-01T12:00:00Z'
  const insert = db.prepare(
    `INSERT OR IGNORE INTO tasks (id, user_id, project_id, title, priority, created_at, labels)
     VALUES (?, ?, 1, ?, ?, ?, '[]')`,
  )

  return Array.from({ length: count }, (_, i) => {
    const task = {
      id: i + 1,
      title: `Task ${i + 1}`,
      priority: 0,
      due_at: null,
      original_due_at: null,
      created_at: now,
      labels: [],
      project_name: 'Inbox',
      is_recurring: false,
      rrule: null,
      notes: null,
      recurrence_mode: 'from_due' as const,
      ...(overrides?.[i] ?? {}),
    }
    insert.run(task.id, TEST_USER_ID, task.title, task.priority, task.created_at)
    return task
  })
}

function makeInsightsResponse(taskIds: number[]) {
  // Insights returns an array, but AIQueryResult types structuredOutput as Record<string, unknown>.
  // At runtime the array passes through to Zod's safeParse, which handles it correctly.
  const items = taskIds.map((id) => ({
    task_id: id,
    score: id % 101, // Keep in 0-100 range for Zod validation
    commentary: `Commentary for task ${id}`,
    signals: [],
  }))
  return {
    structuredOutput: items as unknown as Record<string, unknown>,
    textResult: null,
    durationMs: 500,
    success: true,
    error: null,
  }
}

beforeAll(() => {
  setupTestDb()
})

afterAll(() => {
  teardownTestDb()
})

afterEach(() => {
  mockAiQuery.mockReset()
  // Clear insights tables and test tasks between tests
  const db = getDb()
  db.prepare('DELETE FROM ai_insights_results WHERE user_id = ?').run(TEST_USER_ID)
  db.prepare('DELETE FROM ai_insights_sessions').run()
  db.prepare('DELETE FROM tasks WHERE user_id = ?').run(TEST_USER_ID)
})

describe('Signal vocabulary', () => {
  test('INSIGHTS_SIGNALS has 6 entries', () => {
    expect(INSIGHTS_SIGNALS).toHaveLength(6)
  })

  test('INSIGHTS_SIGNAL_KEYS matches INSIGHTS_SIGNALS keys', () => {
    const signalKeys = INSIGHTS_SIGNALS.map((s) => s.key)
    expect(signalKeys).toEqual([...INSIGHTS_SIGNAL_KEYS])
  })

  test('SIGNAL_MAP provides lookup by key', () => {
    for (const signal of INSIGHTS_SIGNALS) {
      const found = SIGNAL_MAP.get(signal.key)
      expect(found).toBeDefined()
      expect(found!.label).toBe(signal.label)
      expect(found!.color).toBeTruthy()
      expect(found!.icon).toBeTruthy()
    }
  })

  test('every signal has required display properties', () => {
    for (const signal of INSIGHTS_SIGNALS) {
      expect(signal.key).toBeTruthy()
      expect(signal.label).toBeTruthy()
      expect(signal.color).toBeTruthy()
      expect(signal.icon).toBeTruthy()
      expect(signal.description).toBeTruthy()
    }
  })
})

describe('startInsightsGeneration', () => {
  test('creates session and returns session ID', () => {
    mockAiQuery.mockResolvedValue(makeInsightsResponse([1, 2, 3]))

    const tasks = makeTasks(3)
    const { sessionId, totalTasks } = startInsightsGeneration(TEST_USER_ID, TEST_TIMEZONE, tasks)

    expect(sessionId).toBeTruthy()
    expect(typeof sessionId).toBe('string')
    expect(totalTasks).toBe(3)
  })

  test('creates a running session in the database', () => {
    mockAiQuery.mockResolvedValue(makeInsightsResponse([1]))

    const tasks = makeTasks(1)
    const { sessionId } = startInsightsGeneration(TEST_USER_ID, TEST_TIMEZONE, tasks)

    const session = getInsightsSessionStatus(sessionId, TEST_USER_ID)
    expect(session).not.toBeNull()
    expect(session!.status).toBe('running')
    expect(session!.total_tasks).toBe(1)
  })

  test('preserves old results during generation and cleans up stale on completion', async () => {
    // Create a task row for the FK constraint, then insert a fake old result
    const db = getDb()
    db.prepare(
      `INSERT OR IGNORE INTO tasks (id, user_id, project_id, title, priority, created_at, labels)
       VALUES (999, ?, 1, 'Old task', 0, '2026-01-01T00:00:00Z', '[]')`,
    ).run(TEST_USER_ID)
    db.prepare(
      `INSERT INTO ai_insights_results (user_id, task_id, score, commentary, signals, generated_at)
       VALUES (?, ?, ?, ?, NULL, ?)`,
    ).run(TEST_USER_ID, 999, 50, 'Old result', '2026-01-01T00:00:00Z')

    expect(hasInsightsResults(TEST_USER_ID)).toBe(true)

    mockAiQuery.mockResolvedValue(makeInsightsResponse([1]))
    const tasks = makeTasks(1)
    startInsightsGeneration(TEST_USER_ID, TEST_TIMEZONE, tasks)

    // Old results are preserved during generation (not wiped upfront)
    const { results: immediateResults } = getInsightsResults(TEST_USER_ID)
    expect(immediateResults.find((r) => r.task_id === 999)).toBeDefined()

    // After generation completes, stale results (task 999 not in new batch) are cleaned up
    await vi.waitFor(() => {
      const { results } = getInsightsResults(TEST_USER_ID)
      const oldResult = results.find((r) => r.task_id === 999)
      expect(oldResult).toBeUndefined()
    })
  })
})

describe('Result storage and retrieval', () => {
  test('stores results after batch processing completes', async () => {
    mockAiQuery.mockResolvedValue(makeInsightsResponse([1, 2, 3]))

    const tasks = makeTasks(3)
    startInsightsGeneration(TEST_USER_ID, TEST_TIMEZONE, tasks)

    // Wait for async processing
    await vi.waitFor(() => {
      const { results } = getInsightsResults(TEST_USER_ID)
      expect(results.length).toBe(3)
    })

    const { results } = getInsightsResults(TEST_USER_ID)
    expect(results).toHaveLength(3)
    // Results sorted by score descending
    expect(results[0].score).toBeGreaterThanOrEqual(results[1].score)
    expect(results[1].score).toBeGreaterThanOrEqual(results[2].score)
  })

  test('results include commentary', async () => {
    mockAiQuery.mockResolvedValue(makeInsightsResponse([1]))

    const tasks = makeTasks(1)
    startInsightsGeneration(TEST_USER_ID, TEST_TIMEZONE, tasks)

    await vi.waitFor(() => {
      expect(hasInsightsResults(TEST_USER_ID)).toBe(true)
    })

    const { results } = getInsightsResults(TEST_USER_ID)
    expect(results[0].commentary).toBe('Commentary for task 1')
  })

  test('results include signals when present', async () => {
    mockAiQuery.mockResolvedValueOnce({
      structuredOutput: [
        { task_id: 1, score: 80, commentary: 'Stale task', signals: ['stale', 'vague'] },
        { task_id: 2, score: 30, commentary: 'Fine', signals: [] },
      ] as unknown as Record<string, unknown>,
      textResult: null,
      durationMs: 500,
      success: true,
      error: null,
    })

    // Task 1 needs to be 21+ days old so the stale signal passes sanitization
    const tasks = makeTasks(2, [{ created_at: '2025-12-01T12:00:00Z' }])
    startInsightsGeneration(TEST_USER_ID, TEST_TIMEZONE, tasks)

    await vi.waitFor(() => {
      const { results } = getInsightsResults(TEST_USER_ID)
      expect(results.length).toBe(2)
    })

    const { results, signalCounts } = getInsightsResults(TEST_USER_ID)
    const staleTask = results.find((r) => r.task_id === 1)
    expect(staleTask!.signals).toEqual(['stale', 'vague'])

    const fineTask = results.find((r) => r.task_id === 2)
    expect(fineTask!.signals).toEqual([])

    expect(signalCounts['stale']).toBe(1)
    expect(signalCounts['vague']).toBe(1)
  })

  test('generatedAt is set after processing', async () => {
    mockAiQuery.mockResolvedValue(makeInsightsResponse([1]))

    const tasks = makeTasks(1)
    startInsightsGeneration(TEST_USER_ID, TEST_TIMEZONE, tasks)

    await vi.waitFor(() => {
      expect(hasInsightsResults(TEST_USER_ID)).toBe(true)
    })

    const { generatedAt } = getInsightsResults(TEST_USER_ID)
    expect(generatedAt).toBeTruthy()
    expect(new Date(generatedAt!).getTime()).toBeGreaterThan(0)
  })

  test('multi-user isolation — results are per-user', async () => {
    mockAiQuery.mockResolvedValue(makeInsightsResponse([1]))

    const tasks = makeTasks(1)
    startInsightsGeneration(TEST_USER_ID, TEST_TIMEZONE, tasks)

    await vi.waitFor(() => {
      expect(hasInsightsResults(TEST_USER_ID)).toBe(true)
    })

    // Different user should not see results
    expect(hasInsightsResults(99999)).toBe(false)
    const { results } = getInsightsResults(99999)
    expect(results).toHaveLength(0)
  })
})

describe('Session tracking', () => {
  test('session status transitions from running to complete', async () => {
    mockAiQuery.mockResolvedValue(makeInsightsResponse([1]))

    const tasks = makeTasks(1)
    const { sessionId } = startInsightsGeneration(TEST_USER_ID, TEST_TIMEZONE, tasks)

    // Initially running
    const initial = getInsightsSessionStatus(sessionId, TEST_USER_ID)
    expect(initial).not.toBeNull()
    expect(initial!.status).toBe('running')

    // Wait for completion
    await vi.waitFor(() => {
      const session = getInsightsSessionStatus(sessionId, TEST_USER_ID)
      expect(session!.status).toBe('complete')
    })

    const final = getInsightsSessionStatus(sessionId, TEST_USER_ID)
    expect(final!.status).toBe('complete')
    expect(final!.completed).toBe(1)
    expect(final!.finished_at).toBeTruthy()
  })

  test('getActiveInsightsSession returns running session', () => {
    mockAiQuery.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(makeInsightsResponse([1])), 100)),
    )

    const tasks = makeTasks(1)
    startInsightsGeneration(TEST_USER_ID, TEST_TIMEZONE, tasks)

    const active = getActiveInsightsSession(TEST_USER_ID)
    expect(active).not.toBeNull()
    expect(active!.status).toBe('running')
  })

  test('session status returns null for wrong user', () => {
    mockAiQuery.mockResolvedValue(makeInsightsResponse([1]))

    const tasks = makeTasks(1)
    const { sessionId } = startInsightsGeneration(TEST_USER_ID, TEST_TIMEZONE, tasks)

    const wrongUser = getInsightsSessionStatus(sessionId, 99999)
    expect(wrongUser).toBeNull()
  })
})

describe('Chunk splitting', () => {
  test('processes tasks under threshold in a single AI call', async () => {
    mockAiQuery.mockResolvedValue(makeInsightsResponse([1, 2, 3]))

    const tasks = makeTasks(3)
    const { singleCall } = startInsightsGeneration(TEST_USER_ID, TEST_TIMEZONE, tasks)

    expect(singleCall).toBe(true)

    await vi.waitFor(() => {
      expect(hasInsightsResults(TEST_USER_ID)).toBe(true)
    })

    expect(mockAiQuery).toHaveBeenCalledOnce()
  })

  test('splits tasks over 500 into multiple chunks', async () => {
    const taskCount = 600
    const allIds = Array.from({ length: taskCount }, (_, i) => i + 1)

    // Return all task IDs on every call — the code filters by chunk membership.
    // After shuffle + split, each chunk gets ~300 tasks. The filter keeps only
    // the IDs that appear in that chunk, so all 600 end up stored across 2 calls.
    mockAiQuery.mockResolvedValue(makeInsightsResponse(allIds))

    const tasks = makeTasks(taskCount)
    const { singleCall } = startInsightsGeneration(TEST_USER_ID, TEST_TIMEZONE, tasks)

    expect(singleCall).toBe(false)

    await vi.waitFor(() => {
      const { results } = getInsightsResults(TEST_USER_ID)
      expect(results.length).toBe(taskCount)
    })

    // 600 tasks / 500 threshold = 2 chunks
    expect(mockAiQuery).toHaveBeenCalledTimes(2)
  })
})

describe('Error handling', () => {
  test('continues on chunk error — partial results are stored', async () => {
    // Use >500 tasks to trigger multi-chunk processing.
    // First chunk succeeds, second chunk fails.
    const taskCount = 600
    const allIds = Array.from({ length: taskCount }, (_, i) => i + 1)

    mockAiQuery
      .mockResolvedValueOnce(makeInsightsResponse(allIds))
      .mockRejectedValueOnce(new Error('AI service unavailable'))

    const tasks = makeTasks(taskCount)
    startInsightsGeneration(TEST_USER_ID, TEST_TIMEZONE, tasks)

    await vi.waitFor(() => {
      const session = getActiveInsightsSession(TEST_USER_ID)
      expect(session).toBeNull() // No longer active = completed
    })

    // First chunk's results should be stored, second chunk failed
    const { results } = getInsightsResults(TEST_USER_ID)
    expect(results.length).toBeGreaterThan(0)
    expect(results.length).toBeLessThan(taskCount)
  })

  test('filters out task IDs not in the input batch', async () => {
    // AI returns a hallucinated task_id
    mockAiQuery.mockResolvedValueOnce({
      structuredOutput: [
        { task_id: 1, score: 50, commentary: 'Real task', signals: [] },
        { task_id: 999, score: 50, commentary: 'Hallucinated', signals: [] },
      ] as unknown as Record<string, unknown>,
      textResult: null,
      durationMs: 500,
      success: true,
      error: null,
    })

    const tasks = makeTasks(2)
    startInsightsGeneration(TEST_USER_ID, TEST_TIMEZONE, tasks)

    await vi.waitFor(() => {
      expect(hasInsightsResults(TEST_USER_ID)).toBe(true)
    })

    const { results } = getInsightsResults(TEST_USER_ID)
    const hallucinated = results.find((r) => r.task_id === 999)
    expect(hallucinated).toBeUndefined()
  })

  test('handles text fallback parsing', async () => {
    mockAiQuery.mockResolvedValueOnce({
      structuredOutput: null,
      textResult: JSON.stringify([
        { task_id: 1, score: 75, commentary: 'From text fallback', signals: ['stale'] },
      ]),
      durationMs: 500,
      success: true,
      error: null,
    })

    // Task needs to be 21+ days old so stale signal passes sanitization
    const tasks = makeTasks(1, [{ created_at: '2025-12-01T12:00:00Z' }])
    startInsightsGeneration(TEST_USER_ID, TEST_TIMEZONE, tasks)

    await vi.waitFor(() => {
      expect(hasInsightsResults(TEST_USER_ID)).toBe(true)
    })

    const { results } = getInsightsResults(TEST_USER_ID)
    expect(results[0].commentary).toBe('From text fallback')
    expect(results[0].signals).toEqual(['stale'])
  })
})

describe('hasInsightsResults', () => {
  test('returns false when no results exist', () => {
    expect(hasInsightsResults(TEST_USER_ID)).toBe(false)
  })

  test('returns true after results are stored', async () => {
    mockAiQuery.mockResolvedValue(makeInsightsResponse([1]))

    const tasks = makeTasks(1)
    startInsightsGeneration(TEST_USER_ID, TEST_TIMEZONE, tasks)

    await vi.waitFor(() => {
      expect(hasInsightsResults(TEST_USER_ID)).toBe(true)
    })
  })
})
