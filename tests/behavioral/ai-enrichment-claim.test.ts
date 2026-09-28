/**
 * Enrichment claim — one task is enriched once, whichever path gets it first
 *
 * Two paths enrich a new task: the fire-and-forget `enrichSingleTask` from
 * POST /api/tasks, and the per-minute `processEnrichmentQueue` safety net
 * started by instrumentation.ts. Both must agree on which tasks are in flight.
 *
 * In production they did not. Next.js bundles instrumentation.ts and the app
 * routes separately, so `enrichment.ts` is instantiated twice (two module ids
 * in the build), each with its own in-flight Set. A task created a second
 * before the cron tick was enriched by both paths — two model calls, two
 * ai_activity_log rows, the second one "no changes needed" (2026-09-28).
 *
 * The first test reproduces that exactly: `vi.resetModules()` between two
 * imports gives two module instances of enrichment.ts, the production
 * condition. The second covers the queue's own stale snapshot — it SELECTs up
 * to ten rows and then awaits them one by one, so a row finished by the
 * fire-and-forget path in the meantime must not be enriched again.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { setupTestDb, teardownTestDb, TEST_USER_ID, TEST_TIMEZONE } from '../helpers/setup'

process.env.OPENTASK_AI_PROVIDER = 'anthropic'
process.env.ANTHROPIC_API_KEY = 'test-key'
process.env.OPENTASK_AI_ENRICHMENT_MODEL = 'test-model'

// One mock function shared by every module instance: the factories below run
// again after vi.resetModules(), and must hand back this same function.
const { enrichmentQueryMock } = vi.hoisted(() => ({ enrichmentQueryMock: vi.fn() }))

vi.mock('@/core/ai/sdk', () => ({
  isAIEnabled: () => true,
  initAI: async () => {},
  aiQuery: vi.fn(),
}))

vi.mock('@/core/ai/enrichment-slot', () => ({
  enrichmentQuery: enrichmentQueryMock,
  initEnrichmentSlot: vi.fn(),
  getEnrichmentSlotStats: vi.fn(),
  shutdownEnrichmentSlot: vi.fn(),
}))

import { getDb } from '@/core/db'
import { createTask, getTaskById } from '@/core/tasks'

type EnrichmentModule = typeof import('@/core/ai/enrichment')

function result(title: string) {
  return {
    structuredOutput: {
      title,
      priority: 0,
      due_at: null,
      labels: [],
      rrule: null,
      project_name: null,
      auto_snooze_minutes: null,
      recurrence_mode: null,
      notes: null,
      reasoning: 'test',
    },
    text: null,
    durationMs: 1,
  }
}

/** A promise plus the function that settles it — lets the test hold a call in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

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
  const task = createTask({
    userId: TEST_USER_ID,
    userTimezone: TEST_TIMEZONE,
    input: { title },
  })
  expect(task.labels).toContain('ai-to-process')
  return task.id
}

beforeAll(() => {
  setupTestDb()
  getDb().prepare("UPDATE users SET ai_enrichment_mode = 'sdk' WHERE id = ?").run(TEST_USER_ID)
})

afterAll(() => {
  teardownTestDb()
})

beforeEach(async () => {
  clearPendingEnrichment()
  enrichmentQueryMock.mockReset()
  const { _resetProcessingState, _resetCircuitBreaker } = await import('@/core/ai/enrichment')
  _resetProcessingState()
  _resetCircuitBreaker()
})

describe('enrichment claim', () => {
  test('route and cron in separate module instances enrich a task once', async () => {
    vi.resetModules()
    const routeInstance: EnrichmentModule = await import('@/core/ai/enrichment')
    vi.resetModules()
    const cronInstance: EnrichmentModule = await import('@/core/ai/enrichment')
    expect(cronInstance).not.toBe(routeInstance)

    const taskId = newPendingTask('claim across instances')
    const gate = deferred<ReturnType<typeof result>>()
    enrichmentQueryMock.mockImplementation(() => gate.promise)

    // The route's call is in flight (waiting on the model) when the cron ticks.
    const fireAndForget = routeInstance.enrichSingleTask(taskId, TEST_USER_ID)
    const cronCycle = cronInstance.processEnrichmentQueue()

    gate.resolve(result('Claim across instances'))
    await Promise.all([fireAndForget, cronCycle])

    expect(enrichmentQueryMock).toHaveBeenCalledTimes(1)
    const after = getTaskById(taskId)!
    expect(after.title).toBe('Claim across instances')
    expect(after.labels).not.toContain('ai-to-process')
  })

  test('queue skips a row the fire-and-forget path finished while the queue was busy', async () => {
    const { enrichSingleTask, processEnrichmentQueue } = await import('@/core/ai/enrichment')

    const first = newPendingTask('queue first')
    const second = newPendingTask('queue second')

    // The queue's call for `first` is held; while it waits, the fire-and-forget
    // path enriches `second` start to finish.
    const firstGate = deferred<ReturnType<typeof result>>()
    const titles: string[] = []
    enrichmentQueryMock.mockImplementation((_prompt: string, opts: { taskId: number }) => {
      titles.push(String(opts.taskId))
      if (opts.taskId === first) return firstGate.promise
      return Promise.resolve(result('Queue second'))
    })

    const cycle = processEnrichmentQueue()
    await enrichSingleTask(second, TEST_USER_ID)
    firstGate.resolve(result('Queue first'))
    await cycle

    // Each task reached the model exactly once.
    expect([...titles].sort()).toEqual([String(first), String(second)].sort())
    expect(getTaskById(first)!.title).toBe('Queue first')
    expect(getTaskById(second)!.title).toBe('Queue second')
  })
})
