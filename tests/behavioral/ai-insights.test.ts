/**
 * Behavioral tests for AI Insights
 *
 * Tests the insights logic: batch processing, result caching, session tracking,
 * and signal vocabulary. SDK is mocked — no real AI calls.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { setupTestDb, teardownTestDb, TEST_USER_ID, TEST_TIMEZONE } from '../helpers/setup'
import type { TaskSummary } from '@/core/ai/types'

// Set provider and models so resolveFeatureAIConfig() works in tests (no real API calls are made)
process.env.OPENTASK_AI_PROVIDER = 'anthropic'
process.env.ANTHROPIC_API_KEY = 'test-key'
process.env.OPENTASK_AI_INSIGHTS_MODEL = 'test-model'

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
  insightsTasksPerCall,
  getLastInsightsUnscoredCount,
  getLastInsightsDurationMs,
  splitIntoChunks,
  INSIGHTS_SIGNALS,
  SIGNAL_MAP,
} from '@/core/ai/insights'
import { getDb } from '@/core/db'
import { aiQuery } from '@/core/ai/sdk'
import { INSIGHTS_SIGNAL_KEYS } from '@/core/ai/types'
import { unscoredTasksText } from '@/lib/insights-text'

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

// The env above (provider anthropic, model 'test-model') plans like the
// production API path: 8192-token cap, no explicit thinking budget → 20 a call.
const API_TASKS_PER_CALL = 20

/** Wait until the session has left 'running', then return it. */
async function waitForFinish(sessionId: string) {
  await vi.waitFor(() => {
    expect(getInsightsSessionStatus(sessionId, TEST_USER_ID)!.status).not.toBe('running')
  })
  return getInsightsSessionStatus(sessionId, TEST_USER_ID)!
}

/** A response cut off at the output cap: half a JSON document, flagged truncated. */
function truncatedResponse() {
  return {
    structuredOutput: null,
    textResult: '{"tasks":[{"task_id":1,"score":40,"commentary":"Cut of',
    durationMs: 500,
    success: true,
    error: null,
    outputTokens: 8192,
    truncated: true,
  }
}

describe('Chunk sizing by output cap', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  test('an 8192-cap API model gets small chunks', () => {
    expect(insightsTasksPerCall({ provider: 'anthropic', model: 'claude-haiku-5-5' })).toBe(
      API_TASKS_PER_CALL,
    )
    // OpenAI sends no max_tokens; it plans against the same conservative 8192
    expect(insightsTasksPerCall({ provider: 'openai', model: 'gpt-5' })).toBe(API_TASKS_PER_CALL)
  })

  test('an explicit thinking budget comes off the cap, and tasks then cost only their JSON', () => {
    // anthropic Opus: (16384 − 10000) × 0.6 / 60
    expect(insightsTasksPerCall({ provider: 'anthropic', model: 'claude-opus-5-5' })).toBe(63)
    // SDK Opus: (32000 − 10000) × 0.6 / 60
    expect(insightsTasksPerCall({ provider: 'sdk', model: 'opus' })).toBe(220)
  })

  test('the SDK cap follows CLAUDE_CODE_MAX_OUTPUT_TOKENS', () => {
    expect(insightsTasksPerCall({ provider: 'sdk', model: 'sonnet' })).toBe(80)
    vi.stubEnv('CLAUDE_CODE_MAX_OUTPUT_TOKENS', '64000')
    expect(insightsTasksPerCall({ provider: 'sdk', model: 'sonnet' })).toBe(160)
    vi.stubEnv('CLAUDE_CODE_MAX_OUTPUT_TOKENS', '1000000')
    expect(insightsTasksPerCall({ provider: 'sdk', model: 'opus' })).toBe(500)
  })

  test('splitIntoChunks makes the fewest near-equal chunks within the limit', () => {
    const items = Array.from({ length: 197 }, (_, i) => i)
    const chunks = splitIntoChunks(items, API_TASKS_PER_CALL)
    expect(chunks).toHaveLength(10)
    expect(chunks.every((c) => c.length <= API_TASKS_PER_CALL)).toBe(true)
    expect(chunks.flat()).toEqual(items)
    expect(splitIntoChunks(items, 500)).toEqual([items])
  })
})

describe('Chunk splitting', () => {
  test('a list that fits one call is sent in one call', async () => {
    mockAiQuery.mockResolvedValue(makeInsightsResponse([1, 2, 3]))

    const tasks = makeTasks(3)
    const { sessionId, singleCall } = startInsightsGeneration(TEST_USER_ID, TEST_TIMEZONE, tasks)
    expect(singleCall).toBe(true)

    await waitForFinish(sessionId)
    expect(mockAiQuery).toHaveBeenCalledOnce()
  })

  test('~200 tasks on an 8192-cap model are split into calls of at most 20', async () => {
    const taskCount = 197
    const allIds = Array.from({ length: taskCount }, (_, i) => i + 1)
    // Return every id on every call — the code keeps only the chunk's own ids
    mockAiQuery.mockResolvedValue(makeInsightsResponse(allIds))

    const tasks = makeTasks(taskCount)
    const { sessionId, singleCall } = startInsightsGeneration(TEST_USER_ID, TEST_TIMEZONE, tasks)
    expect(singleCall).toBe(false)

    const session = await waitForFinish(sessionId)
    expect(mockAiQuery).toHaveBeenCalledTimes(10)
    for (const [call] of mockAiQuery.mock.calls) {
      const lines = call.prompt.split('<tasks>')[1].split('</tasks>')[0].trim().split('\n')
      expect(lines.length).toBeLessThanOrEqual(API_TASKS_PER_CALL)
      // Each subset carries the calibration summary of the whole list
      expect(call.prompt).toContain('Full task list summary')
      expect(call.prompt).toContain(`Total tasks in full list: ${taskCount}`)
    }
    expect(session.status).toBe('complete')
    expect(session.completed).toBe(taskCount)
    expect(session.error).toBeNull()
    expect(getInsightsResults(TEST_USER_ID).results).toHaveLength(taskCount)
  })

  test('~200 tasks on a large-cap provider go in one call', async () => {
    const taskCount = 197
    mockAiQuery.mockResolvedValue(
      makeInsightsResponse(Array.from({ length: taskCount }, (_, i) => i + 1)),
    )

    const tasks = makeTasks(taskCount)
    const { sessionId, singleCall } = startInsightsGeneration(
      TEST_USER_ID,
      TEST_TIMEZONE,
      tasks,
      null,
      'on-demand',
      { provider: 'sdk', model: 'opus' },
    )
    expect(singleCall).toBe(true)

    const session = await waitForFinish(sessionId)
    expect(mockAiQuery).toHaveBeenCalledOnce()
    expect(mockAiQuery.mock.calls[0][0].prompt).not.toContain('Full task list summary')
    expect(session.completed).toBe(taskCount)
  })
})

describe('Session status is truthful', () => {
  test('every task scored → complete, completed = total, no error', async () => {
    mockAiQuery.mockResolvedValue(makeInsightsResponse([1, 2, 3]))
    const { sessionId } = startInsightsGeneration(TEST_USER_ID, TEST_TIMEZONE, makeTasks(3))

    const session = await waitForFinish(sessionId)
    expect(session.status).toBe('complete')
    expect(session.completed).toBe(3)
    expect(session.error).toBeNull()
  })

  test('some chunks fail → complete, completed = tasks scored, error says how many were not', async () => {
    // 60 tasks → 3 calls of 20; the second one errors
    const allIds = Array.from({ length: 60 }, (_, i) => i + 1)
    mockAiQuery
      .mockResolvedValueOnce(makeInsightsResponse(allIds))
      .mockRejectedValueOnce(new Error('AI service unavailable'))
      .mockResolvedValueOnce(makeInsightsResponse(allIds))

    const { sessionId } = startInsightsGeneration(TEST_USER_ID, TEST_TIMEZONE, makeTasks(60))

    const session = await waitForFinish(sessionId)
    expect(mockAiQuery).toHaveBeenCalledTimes(3) // an error is not retried as halves
    expect(session.status).toBe('complete')
    expect(session.completed).toBe(40)
    expect(session.error).toBe('20 of 60 tasks could not be scored')
    expect(getInsightsResults(TEST_USER_ID).results).toHaveLength(40)
  })

  test('tasks the AI leaves out count as not scored', async () => {
    mockAiQuery.mockResolvedValue(makeInsightsResponse([1, 2]))
    const { sessionId } = startInsightsGeneration(TEST_USER_ID, TEST_TIMEZONE, makeTasks(3))

    const session = await waitForFinish(sessionId)
    expect(session.status).toBe('complete')
    expect(session.completed).toBe(2)
    expect(session.error).toBe('1 of 3 tasks could not be scored')
  })

  test('every chunk fails → failed with an error, completed 0, earlier results kept', async () => {
    const db = getDb()
    const tasks = makeTasks(3)
    db.prepare(
      `INSERT INTO ai_insights_results (user_id, task_id, score, commentary, signals, generated_at)
       VALUES (?, 1, 50, 'Earlier result', NULL, '2026-01-01T00:00:00Z')`,
    ).run(TEST_USER_ID)
    mockAiQuery.mockResolvedValue({
      structuredOutput: null,
      textResult: null,
      durationMs: 500,
      success: false,
      error: 'Request failed: 529 overloaded',
    })

    const { sessionId } = startInsightsGeneration(TEST_USER_ID, TEST_TIMEZONE, tasks)

    const session = await waitForFinish(sessionId)
    expect(session.status).toBe('failed')
    expect(session.completed).toBe(0)
    expect(session.error).toBe('None of the 3 tasks could be scored')
    expect(session.finished_at).toBeTruthy()
    expect(getInsightsResults(TEST_USER_ID).results.map((r) => r.commentary)).toEqual([
      'Earlier result',
    ])
  })
})

describe('Partial run note', () => {
  test('the line reads "N tasks couldn\'t be scored", and nothing when all were', () => {
    expect(unscoredTasksText(0)).toBeNull()
    expect(unscoredTasksText(1)).toBe("1 task couldn't be scored")
    expect(unscoredTasksText(20)).toBe("20 tasks couldn't be scored")
  })

  test('the count and duration come from the last finished run, complete or failed', async () => {
    expect(getLastInsightsUnscoredCount(TEST_USER_ID)).toBe(0)
    expect(getLastInsightsDurationMs(TEST_USER_ID)).toBeNull()

    // Partial: 60 tasks in 3 calls of 20, the second errors
    const allIds = Array.from({ length: 60 }, (_, i) => i + 1)
    mockAiQuery
      .mockResolvedValueOnce(makeInsightsResponse(allIds))
      .mockRejectedValueOnce(new Error('AI service unavailable'))
      .mockResolvedValueOnce(makeInsightsResponse(allIds))
    const tasks = makeTasks(60)
    const partial = startInsightsGeneration(TEST_USER_ID, TEST_TIMEZONE, tasks)
    await waitForFinish(partial.sessionId)
    expect(getLastInsightsUnscoredCount(TEST_USER_ID)).toBe(20)
    expect(getLastInsightsDurationMs(TEST_USER_ID)).not.toBeNull()

    // A failed run after it is not masked by the earlier partial one
    mockAiQuery.mockReset()
    mockAiQuery.mockRejectedValue(new Error('AI service unavailable'))
    const failed = startInsightsGeneration(TEST_USER_ID, TEST_TIMEZONE, tasks)
    expect((await waitForFinish(failed.sessionId)).status).toBe('failed')
    expect(getLastInsightsUnscoredCount(TEST_USER_ID)).toBe(60)

    // A full run clears it
    mockAiQuery.mockReset()
    mockAiQuery.mockResolvedValue(makeInsightsResponse(allIds))
    const full = startInsightsGeneration(TEST_USER_ID, TEST_TIMEZONE, tasks)
    await waitForFinish(full.sessionId)
    expect(getLastInsightsUnscoredCount(TEST_USER_ID)).toBe(0)
  })
})

describe('Stale sessions are judged by their heartbeat', () => {
  const MIN = 60 * 1000
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

  function insertRunning(id: string, startedAgoMs: number, heartbeatAgoMs: number | null) {
    getDb()
      .prepare(
        `INSERT INTO ai_insights_sessions (id, user_id, status, total_tasks, completed, started_at, heartbeat_at)
         VALUES (?, ?, 'running', 400, 200, ?, ?)`,
      )
      .run(
        id,
        TEST_USER_ID,
        ago(startedAgoMs),
        heartbeatAgoMs === null ? null : ago(heartbeatAgoMs),
      )
  }

  test('a long run that is still progressing is not marked stale', () => {
    // Started 45 minutes ago (25 chunks), last chunk finished a minute ago
    insertRunning('long-run', 45 * MIN, 1 * MIN)
    const active = getActiveInsightsSession(TEST_USER_ID)
    expect(active?.id).toBe('long-run')
    expect(getInsightsSessionStatus('long-run', TEST_USER_ID)!.status).toBe('running')
  })

  test('a run with no heartbeat for 20+ minutes is dead and marked failed', () => {
    insertRunning('dead-run', 45 * MIN, 25 * MIN)
    expect(getActiveInsightsSession(TEST_USER_ID)).toBeNull()
    const session = getInsightsSessionStatus('dead-run', TEST_USER_ID)!
    expect(session.status).toBe('failed')
    expect(session.error).toBe('Generation timed out')
  })

  test('a run with no heartbeat yet is judged from its start', () => {
    insertRunning('no-beat', 25 * MIN, null)
    expect(getActiveInsightsSession(TEST_USER_ID)).toBeNull()
  })

  test('each finished chunk moves the heartbeat', async () => {
    const allIds = Array.from({ length: 60 }, (_, i) => i + 1)
    const beats: (string | null)[] = []
    // The first call starts before startInsightsGeneration returns the id, so
    // read the (only) running session instead
    mockAiQuery.mockImplementation(async () => {
      const row = getDb()
        .prepare(`SELECT heartbeat_at FROM ai_insights_sessions WHERE status = 'running'`)
        .get() as { heartbeat_at: string | null }
      beats.push(row.heartbeat_at)
      return makeInsightsResponse(allIds)
    })
    const { sessionId } = startInsightsGeneration(TEST_USER_ID, TEST_TIMEZONE, makeTasks(60))
    await waitForFinish(sessionId)
    // Set at the start, then refreshed after chunks 1 and 2 (seen by calls 2 and 3)
    expect(beats).toHaveLength(3)
    expect(beats.every((b) => b !== null)).toBe(true)
    expect(beats[1]! >= beats[0]!).toBe(true)
    expect(beats[2]! >= beats[1]!).toBe(true)
  })
})

describe('Split retry of a truncated chunk', () => {
  test('a truncated call is retried once as two halves, and loses no tasks', async () => {
    const allIds = Array.from({ length: 20 }, (_, i) => i + 1)
    mockAiQuery
      .mockResolvedValueOnce(truncatedResponse())
      .mockResolvedValue(makeInsightsResponse(allIds))

    const { sessionId } = startInsightsGeneration(TEST_USER_ID, TEST_TIMEZONE, makeTasks(20))

    const session = await waitForFinish(sessionId)
    expect(mockAiQuery).toHaveBeenCalledTimes(3)
    const halfPrompts = mockAiQuery.mock.calls.slice(1).map(([call]) => call.prompt)
    for (const prompt of halfPrompts) {
      expect(prompt).toContain('Tasks in this subset: 10')
      expect(prompt).toContain('Full task list summary')
    }
    expect(session.status).toBe('complete')
    expect(session.completed).toBe(20)
    expect(session.error).toBeNull()
  })

  test('an unparsable response is retried as halves too', async () => {
    mockAiQuery
      .mockResolvedValueOnce({
        structuredOutput: null,
        textResult: 'not json at all',
        durationMs: 500,
        success: true,
        error: null,
      })
      .mockResolvedValue(makeInsightsResponse([1, 2, 3, 4]))

    const { sessionId } = startInsightsGeneration(TEST_USER_ID, TEST_TIMEZONE, makeTasks(4))

    const session = await waitForFinish(sessionId)
    expect(mockAiQuery).toHaveBeenCalledTimes(3)
    expect(session.completed).toBe(4)
  })

  test('the retry is one level only: a half that is cut off again is skipped', async () => {
    const allIds = Array.from({ length: 20 }, (_, i) => i + 1)
    mockAiQuery
      .mockResolvedValueOnce(truncatedResponse())
      .mockResolvedValueOnce(truncatedResponse())
      .mockResolvedValueOnce(makeInsightsResponse(allIds))

    const { sessionId } = startInsightsGeneration(TEST_USER_ID, TEST_TIMEZONE, makeTasks(20))

    const session = await waitForFinish(sessionId)
    expect(mockAiQuery).toHaveBeenCalledTimes(3)
    expect(session.status).toBe('complete')
    expect(session.completed).toBe(10)
    expect(session.error).toBe('10 of 20 tasks could not be scored')
  })

  test('a call that errors is not split', async () => {
    mockAiQuery.mockResolvedValue({
      structuredOutput: null,
      textResult: null,
      durationMs: 500,
      success: false,
      error: 'anthropic query timed out after 180000ms',
    })

    const { sessionId } = startInsightsGeneration(TEST_USER_ID, TEST_TIMEZONE, makeTasks(20))

    const session = await waitForFinish(sessionId)
    expect(mockAiQuery).toHaveBeenCalledOnce()
    expect(session.status).toBe('failed')
  })
})

describe('Error handling', () => {
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
