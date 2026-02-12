/**
 * Behavioral tests for AI Review
 *
 * Tests the review logic: batch processing, result caching, session tracking,
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
  startReviewGeneration,
  getReviewSessionStatus,
  getReviewResults,
  hasReviewResults,
  getActiveReviewSession,
  REVIEW_SIGNALS,
  SIGNAL_MAP,
} from '@/core/ai/review'
import { getDb } from '@/core/db'
import { aiQuery } from '@/core/ai/sdk'
import { REVIEW_SIGNAL_KEYS } from '@/core/ai/types'

const mockAiQuery = vi.mocked(aiQuery)

/**
 * Create TaskSummary objects AND insert corresponding task rows in the DB.
 * The ai_review_results table has a FK constraint on task_id → tasks(id),
 * so actual task rows must exist for storeReviewResults to succeed.
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

function makeReviewResponse(taskIds: number[]) {
  // Review returns an array, but AIQueryResult types structuredOutput as Record<string, unknown>.
  // At runtime the array passes through to Zod's safeParse, which handles it correctly.
  const items = taskIds.map((id) => ({
    task_id: id,
    score: 50 + id,
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
  // Clear review tables and test tasks between tests
  const db = getDb()
  db.prepare('DELETE FROM ai_review_results WHERE user_id = ?').run(TEST_USER_ID)
  db.prepare('DELETE FROM ai_review_sessions').run()
  db.prepare('DELETE FROM tasks WHERE user_id = ?').run(TEST_USER_ID)
})

describe('Signal vocabulary', () => {
  test('REVIEW_SIGNALS has 6 entries', () => {
    expect(REVIEW_SIGNALS).toHaveLength(6)
  })

  test('REVIEW_SIGNAL_KEYS matches REVIEW_SIGNALS keys', () => {
    const signalKeys = REVIEW_SIGNALS.map((s) => s.key)
    expect(signalKeys).toEqual([...REVIEW_SIGNAL_KEYS])
  })

  test('SIGNAL_MAP provides lookup by key', () => {
    for (const signal of REVIEW_SIGNALS) {
      const found = SIGNAL_MAP.get(signal.key)
      expect(found).toBeDefined()
      expect(found!.label).toBe(signal.label)
      expect(found!.color).toBeTruthy()
      expect(found!.icon).toBeTruthy()
    }
  })

  test('every signal has required display properties', () => {
    for (const signal of REVIEW_SIGNALS) {
      expect(signal.key).toBeTruthy()
      expect(signal.label).toBeTruthy()
      expect(signal.color).toBeTruthy()
      expect(signal.icon).toBeTruthy()
      expect(signal.description).toBeTruthy()
    }
  })
})

describe('startReviewGeneration', () => {
  test('creates session and returns session ID', () => {
    mockAiQuery.mockResolvedValue(makeReviewResponse([1, 2, 3]))

    const tasks = makeTasks(3)
    const { sessionId, totalTasks } = startReviewGeneration(TEST_USER_ID, TEST_TIMEZONE, tasks)

    expect(sessionId).toBeTruthy()
    expect(typeof sessionId).toBe('string')
    expect(totalTasks).toBe(3)
  })

  test('creates a running session in the database', () => {
    mockAiQuery.mockResolvedValue(makeReviewResponse([1]))

    const tasks = makeTasks(1)
    const { sessionId } = startReviewGeneration(TEST_USER_ID, TEST_TIMEZONE, tasks)

    const session = getReviewSessionStatus(sessionId, TEST_USER_ID)
    expect(session).not.toBeNull()
    expect(session!.status).toBe('running')
    expect(session!.total_tasks).toBe(1)
  })

  test('clears old results before starting', () => {
    // Create a task row for the FK constraint, then insert a fake old result
    const db = getDb()
    db.prepare(
      `INSERT OR IGNORE INTO tasks (id, user_id, project_id, title, priority, created_at, labels)
       VALUES (999, ?, 1, 'Old task', 0, '2026-01-01T00:00:00Z', '[]')`,
    ).run(TEST_USER_ID)
    db.prepare(
      `INSERT INTO ai_review_results (user_id, task_id, score, commentary, signals, generated_at)
       VALUES (?, ?, ?, ?, NULL, ?)`,
    ).run(TEST_USER_ID, 999, 50, 'Old result', '2026-01-01T00:00:00Z')

    expect(hasReviewResults(TEST_USER_ID)).toBe(true)

    mockAiQuery.mockResolvedValue(makeReviewResponse([1]))
    const tasks = makeTasks(1)
    startReviewGeneration(TEST_USER_ID, TEST_TIMEZONE, tasks)

    // Old results should be cleared (even before AI completes)
    const { results } = getReviewResults(TEST_USER_ID)
    const oldResult = results.find((r) => r.task_id === 999)
    expect(oldResult).toBeUndefined()
  })
})

describe('Result storage and retrieval', () => {
  test('stores results after batch processing completes', async () => {
    mockAiQuery.mockResolvedValue(makeReviewResponse([1, 2, 3]))

    const tasks = makeTasks(3)
    startReviewGeneration(TEST_USER_ID, TEST_TIMEZONE, tasks)

    // Wait for async processing
    await vi.waitFor(() => {
      const { results } = getReviewResults(TEST_USER_ID)
      expect(results.length).toBe(3)
    })

    const { results } = getReviewResults(TEST_USER_ID)
    expect(results).toHaveLength(3)
    // Results sorted by score descending
    expect(results[0].score).toBeGreaterThanOrEqual(results[1].score)
    expect(results[1].score).toBeGreaterThanOrEqual(results[2].score)
  })

  test('results include commentary', async () => {
    mockAiQuery.mockResolvedValue(makeReviewResponse([1]))

    const tasks = makeTasks(1)
    startReviewGeneration(TEST_USER_ID, TEST_TIMEZONE, tasks)

    await vi.waitFor(() => {
      expect(hasReviewResults(TEST_USER_ID)).toBe(true)
    })

    const { results } = getReviewResults(TEST_USER_ID)
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

    const tasks = makeTasks(2)
    startReviewGeneration(TEST_USER_ID, TEST_TIMEZONE, tasks)

    await vi.waitFor(() => {
      const { results } = getReviewResults(TEST_USER_ID)
      expect(results.length).toBe(2)
    })

    const { results, signalCounts } = getReviewResults(TEST_USER_ID)
    const staleTask = results.find((r) => r.task_id === 1)
    expect(staleTask!.signals).toEqual(['stale', 'vague'])

    const fineTask = results.find((r) => r.task_id === 2)
    expect(fineTask!.signals).toEqual([])

    expect(signalCounts['stale']).toBe(1)
    expect(signalCounts['vague']).toBe(1)
  })

  test('generatedAt is set after processing', async () => {
    mockAiQuery.mockResolvedValue(makeReviewResponse([1]))

    const tasks = makeTasks(1)
    startReviewGeneration(TEST_USER_ID, TEST_TIMEZONE, tasks)

    await vi.waitFor(() => {
      expect(hasReviewResults(TEST_USER_ID)).toBe(true)
    })

    const { generatedAt } = getReviewResults(TEST_USER_ID)
    expect(generatedAt).toBeTruthy()
    expect(new Date(generatedAt!).getTime()).toBeGreaterThan(0)
  })

  test('multi-user isolation — results are per-user', async () => {
    mockAiQuery.mockResolvedValue(makeReviewResponse([1]))

    const tasks = makeTasks(1)
    startReviewGeneration(TEST_USER_ID, TEST_TIMEZONE, tasks)

    await vi.waitFor(() => {
      expect(hasReviewResults(TEST_USER_ID)).toBe(true)
    })

    // Different user should not see results
    expect(hasReviewResults(99999)).toBe(false)
    const { results } = getReviewResults(99999)
    expect(results).toHaveLength(0)
  })
})

describe('Session tracking', () => {
  test('session status transitions from running to complete', async () => {
    mockAiQuery.mockResolvedValue(makeReviewResponse([1]))

    const tasks = makeTasks(1)
    const { sessionId } = startReviewGeneration(TEST_USER_ID, TEST_TIMEZONE, tasks)

    // Initially running
    const initial = getReviewSessionStatus(sessionId, TEST_USER_ID)
    expect(initial).not.toBeNull()
    expect(initial!.status).toBe('running')

    // Wait for completion
    await vi.waitFor(() => {
      const session = getReviewSessionStatus(sessionId, TEST_USER_ID)
      expect(session!.status).toBe('complete')
    })

    const final = getReviewSessionStatus(sessionId, TEST_USER_ID)
    expect(final!.status).toBe('complete')
    expect(final!.completed).toBe(1)
    expect(final!.finished_at).toBeTruthy()
  })

  test('getActiveReviewSession returns running session', () => {
    mockAiQuery.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(makeReviewResponse([1])), 100)),
    )

    const tasks = makeTasks(1)
    startReviewGeneration(TEST_USER_ID, TEST_TIMEZONE, tasks)

    const active = getActiveReviewSession(TEST_USER_ID)
    expect(active).not.toBeNull()
    expect(active!.status).toBe('running')
  })

  test('session status returns null for wrong user', () => {
    mockAiQuery.mockResolvedValue(makeReviewResponse([1]))

    const tasks = makeTasks(1)
    const { sessionId } = startReviewGeneration(TEST_USER_ID, TEST_TIMEZONE, tasks)

    const wrongUser = getReviewSessionStatus(sessionId, 99999)
    expect(wrongUser).toBeNull()
  })
})

describe('Batch splitting', () => {
  test('processes small batch in a single AI call', async () => {
    mockAiQuery.mockResolvedValue(makeReviewResponse([1, 2, 3]))

    const tasks = makeTasks(3)
    startReviewGeneration(TEST_USER_ID, TEST_TIMEZONE, tasks)

    await vi.waitFor(() => {
      expect(hasReviewResults(TEST_USER_ID)).toBe(true)
    })

    // Should only need 1 call for 3 tasks (batch size is 25)
    expect(mockAiQuery).toHaveBeenCalledOnce()
  })

  test('splits 30 tasks into 2 batches', async () => {
    const taskIds = Array.from({ length: 30 }, (_, i) => i + 1)
    // First batch: tasks 1-25, second batch: tasks 26-30
    mockAiQuery
      .mockResolvedValueOnce(makeReviewResponse(taskIds.slice(0, 25)))
      .mockResolvedValueOnce(makeReviewResponse(taskIds.slice(25)))

    const tasks = makeTasks(30)
    startReviewGeneration(TEST_USER_ID, TEST_TIMEZONE, tasks)

    await vi.waitFor(() => {
      const { results } = getReviewResults(TEST_USER_ID)
      expect(results.length).toBe(30)
    })

    expect(mockAiQuery).toHaveBeenCalledTimes(2)

    const { results } = getReviewResults(TEST_USER_ID)
    expect(results).toHaveLength(30)
  })
})

describe('Error handling', () => {
  test('continues on batch error — partial results are stored', async () => {
    // First batch succeeds, second batch fails
    mockAiQuery
      .mockResolvedValueOnce(makeReviewResponse([1, 2, 3]))
      .mockRejectedValueOnce(new Error('AI service unavailable'))

    const tasks = makeTasks(30)
    startReviewGeneration(TEST_USER_ID, TEST_TIMEZONE, tasks)

    await vi.waitFor(() => {
      const session = getActiveReviewSession(TEST_USER_ID)
      expect(session).toBeNull() // No longer active = completed
    })

    // First batch of results should be stored
    const { results } = getReviewResults(TEST_USER_ID)
    expect(results.length).toBeGreaterThan(0)
    expect(results.length).toBeLessThan(30) // Not all tasks processed
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
    startReviewGeneration(TEST_USER_ID, TEST_TIMEZONE, tasks)

    await vi.waitFor(() => {
      expect(hasReviewResults(TEST_USER_ID)).toBe(true)
    })

    const { results } = getReviewResults(TEST_USER_ID)
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

    const tasks = makeTasks(1)
    startReviewGeneration(TEST_USER_ID, TEST_TIMEZONE, tasks)

    await vi.waitFor(() => {
      expect(hasReviewResults(TEST_USER_ID)).toBe(true)
    })

    const { results } = getReviewResults(TEST_USER_ID)
    expect(results[0].commentary).toBe('From text fallback')
    expect(results[0].signals).toEqual(['stale'])
  })
})

describe('hasReviewResults', () => {
  test('returns false when no results exist', () => {
    expect(hasReviewResults(TEST_USER_ID)).toBe(false)
  })

  test('returns true after results are stored', async () => {
    mockAiQuery.mockResolvedValue(makeReviewResponse([1]))

    const tasks = makeTasks(1)
    startReviewGeneration(TEST_USER_ID, TEST_TIMEZONE, tasks)

    await vi.waitFor(() => {
      expect(hasReviewResults(TEST_USER_ID)).toBe(true)
    })
  })
})
