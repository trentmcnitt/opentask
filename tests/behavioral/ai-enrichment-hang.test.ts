/**
 * A hung warm slot must not wedge the enrichment queue
 *
 * The per-minute queue (`processEnrichmentQueue`) enriches its tasks one at a
 * time through the SDK warm slot and holds `pipeline.processing` until the
 * cycle ends; every later cycle returns at once while it is set. So one
 * enrichment call that never settles stops enrichment for good: the claimed
 * tasks never reach `handleFailure`, stay `ai-to-process` until a restart, and
 * the user is never told.
 *
 * That happened when the CLI subprocess stopped answering: the first task's
 * query timed out, but the slot stayed busy, and the second task queued
 * behind it forever. Here the real enrichment slot runs against a fake SDK
 * whose subprocesses warm up and then never answer a query. Each cycle must
 * still finish, with each task counted as a failed attempt, and the second
 * cycle must mark them `ai-failed` (MAX_ATTEMPTS = 2).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { setupTestDb, teardownTestDb, TEST_USER_ID, TEST_TIMEZONE } from '../helpers/setup'
import { createFakeStream, makeSuccessResult } from '../helpers/fake-sdk-stream'

process.env.OPENTASK_AI_ENRICHMENT_SDK_MODEL = 'test-model'

const QUERY_TIMEOUT_MS = 500

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('@/lib/error-notify', () => ({
  notifyError: vi.fn(),
}))

vi.mock('@/core/ai/sdk', () => ({
  isAIEnabled: () => true,
  initAI: async () => {},
  aiQuery: vi.fn(),
}))

// Every subprocess answers its warmup, then hangs: no query ever gets a result.
const mockQuery = vi.fn()
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}))

import { getDb } from '@/core/db'
import { createTask, getTaskById } from '@/core/tasks'
import {
  processEnrichmentQueue,
  _resetProcessingState,
  _resetCircuitBreaker,
} from '@/core/ai/enrichment'
import {
  initEnrichmentSlot,
  getEnrichmentSlotStats,
  _resetSlotForTesting,
} from '@/core/ai/enrichment-slot'

function clearPendingEnrichment(): void {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT id, labels FROM tasks
       WHERE EXISTS (SELECT 1 FROM json_each(labels) WHERE value = 'ai-to-process')`,
    )
    .all() as { id: number; labels: string }[]
  for (const row of rows) {
    const labels = (JSON.parse(row.labels) as string[]).filter((l) => l !== 'ai-to-process')
    db.prepare('UPDATE tasks SET labels = ? WHERE id = ?').run(JSON.stringify(labels), row.id)
  }
}

function newPendingTask(title: string): number {
  const task = createTask({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, input: { title } })
  expect(task.labels).toContain('ai-to-process')
  return task.id
}

/**
 * Run one queue cycle while the fake clock moves 5s. On the fake clock the
 * cycle needs two query timeouts (QUERY_TIMEOUT_MS each) and a recycle; what
 * matters is that it finishes at all. One that never finishes fails the test
 * here rather than hanging it.
 */
async function runCycle(): Promise<void> {
  let finished = false
  const cycle = processEnrichmentQueue().then(() => {
    finished = true
  })
  await vi.advanceTimersByTimeAsync(5_000)
  expect(finished).toBe(true)
  await cycle
}

beforeAll(() => {
  setupTestDb()
  getDb()
    .prepare(
      "UPDATE users SET ai_enrichment_mode = 'sdk', ai_enrichment_timeout_ms = ? WHERE id = ?",
    )
    .run(QUERY_TIMEOUT_MS, TEST_USER_ID)
})

afterAll(() => {
  teardownTestDb()
})

beforeEach(async () => {
  vi.useFakeTimers()
  clearPendingEnrichment()
  _resetProcessingState()
  _resetCircuitBreaker()
  _resetSlotForTesting()
  mockQuery.mockReset()
  mockQuery.mockImplementation(() => {
    const stream = createFakeStream()
    stream.emit(makeSuccessResult('READY'))
    return stream.stream
  })

  const init = initEnrichmentSlot()
  await vi.advanceTimersByTimeAsync(0)
  await init
  expect(getEnrichmentSlotStats().state).toBe('available')
})

afterEach(() => {
  vi.useRealTimers()
})

describe('enrichment queue with a hung warm slot', () => {
  test('each cycle finishes, and the tasks end ai-failed after MAX_ATTEMPTS', async () => {
    const first = newPendingTask('hung slot first task')
    const second = newPendingTask('hung slot second task')

    // Cycle 1: the first task times out; the second, queued behind the hung
    // subprocess, is served by the recycled one and times out in turn.
    await runCycle()
    for (const id of [first, second]) {
      const labels = getTaskById(id)!.labels
      expect(labels).toContain('ai-to-process')
      expect(labels).not.toContain('ai-failed')
    }
    // Two hung queries, two recycles: a fresh subprocess for each
    expect(getEnrichmentSlotStats().totalRecycles).toBe(2)

    // The next cron tick runs: the pipeline lock was released
    await vi.advanceTimersByTimeAsync(60_000)
    const subprocessesBefore = mockQuery.mock.calls.length
    await runCycle()
    expect(mockQuery.mock.calls.length).toBeGreaterThan(subprocessesBefore)

    for (const id of [first, second]) {
      const labels = getTaskById(id)!.labels
      expect(labels).toContain('ai-failed')
      expect(labels).not.toContain('ai-to-process')
    }
  })
})
