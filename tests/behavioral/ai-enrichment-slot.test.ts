/**
 * Enrichment slot state machine behavioral tests
 *
 * Tests the actual warm subprocess slot mechanics: state transitions, FIFO
 * queuing, recycling, circuit breaker, generation counter, warmup validation,
 * and shutdown. Uses a controllable fake SDK stream — no real subprocesses.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { createFakeStream, makeSuccessResult, makeErrorResult } from '../helpers/fake-sdk-stream'
import type { FakeStreamControl } from '../helpers/fake-sdk-stream'

// Set SDK model env var so resolveSDKModel() returns a known value (no real API calls are made)
process.env.OPENTASK_AI_ENRICHMENT_SDK_MODEL = 'test-model'

// --- Mocks ---

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('@/core/ai/activity', () => ({
  logAIActivity: vi.fn(),
}))

// Mock the SDK — intercept the dynamic import inside initEnrichmentSlot
let currentStream: FakeStreamControl
const mockQuery = vi.fn()

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}))

// Import the module under test (after mocks are set up)
import {
  initEnrichmentSlot,
  enrichmentQuery,
  getEnrichmentSlotStats,
  shutdownEnrichmentSlot,
  _resetSlotForTesting,
} from '@/core/ai/enrichment-slot'

// --- Setup ---

beforeEach(() => {
  vi.useFakeTimers()
  _resetSlotForTesting()

  // Default: mock query creates a new fake stream
  mockQuery.mockImplementation(() => {
    currentStream = createFakeStream()
    return currentStream.stream
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

/**
 * Flush microtasks until the mock query has been called and currentStream is set.
 * The dynamic `await import()` inside initEnrichmentSlot resolves as a microtask,
 * which may need multiple ticks to propagate.
 */
async function waitForStream(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await vi.advanceTimersByTimeAsync(0)
    if (currentStream) return
  }
}

/** Init the slot and complete warmup. Most tests start from this state. */
async function initWithWarmup(): Promise<void> {
  const initPromise = initEnrichmentSlot()
  await waitForStream()
  currentStream.emit(makeSuccessResult('READY'))
  await vi.advanceTimersByTimeAsync(0)
  await initPromise
}

// --- Tests ---

describe('enrichment slot initialization', () => {
  test('happy path: uninitialized → initializing → available', async () => {
    expect(getEnrichmentSlotStats().state).toBe('uninitialized')

    const initPromise = initEnrichmentSlot()
    await waitForStream()

    // During warmup, state should be initializing
    expect(getEnrichmentSlotStats().state).toBe('initializing')

    currentStream.emit(makeSuccessResult('READY'))
    await vi.advanceTimersByTimeAsync(0)
    await initPromise

    const stats = getEnrichmentSlotStats()
    expect(stats.state).toBe('available')
    expect(stats.activatedAt).not.toBeNull()
  })

  test('warmup failure: response without READY → dead', async () => {
    const initPromise = initEnrichmentSlot()
    await waitForStream()

    currentStream.emit(makeSuccessResult('SOMETHING ELSE'))
    await vi.advanceTimersByTimeAsync(0)

    // consumeStream breaks on bad warmup → finally calls recycleSlot →
    // recycleSlot sets state to 'initializing' and fires setTimeout reinit.
    // But initPromise is still waiting on warmupResolver. The warmup failed,
    // so warmupResolver(false) was called, and initEnrichmentSlot sets dead.
    await initPromise

    expect(getEnrichmentSlotStats().state).toBe('dead')
  })

  test('warmup with empty text → dead', async () => {
    const initPromise = initEnrichmentSlot()
    await waitForStream()

    currentStream.emit(makeSuccessResult(''))
    await vi.advanceTimersByTimeAsync(0)
    await initPromise

    expect(getEnrichmentSlotStats().state).toBe('dead')
  })

  test('warmup with error result → dead', async () => {
    const initPromise = initEnrichmentSlot()
    await waitForStream()

    // Error result: subtype !== 'success', so text stays null → warmup fails
    currentStream.emit(makeErrorResult())
    await vi.advanceTimersByTimeAsync(0)
    await initPromise

    expect(getEnrichmentSlotStats().state).toBe('dead')
  })

  test('double init when already available is a no-op', async () => {
    await initWithWarmup()
    expect(getEnrichmentSlotStats().state).toBe('available')

    await initEnrichmentSlot()
    expect(getEnrichmentSlotStats().state).toBe('available')
    expect(mockQuery).toHaveBeenCalledTimes(1)
  })
})

describe('enrichment query - happy path', () => {
  test('returns structured output and text', async () => {
    await initWithWarmup()

    const queryPromise = enrichmentQuery('test prompt', { userId: 1 })
    await vi.advanceTimersByTimeAsync(0)

    currentStream.emit(makeSuccessResult('some text', { title: 'Clean Title' }))
    await vi.advanceTimersByTimeAsync(0)

    const result = await queryPromise
    expect(result.structuredOutput).toEqual({ title: 'Clean Title' })
    expect(result.text).toBe('some text')
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  test('returns null structured output when not present', async () => {
    await initWithWarmup()

    const queryPromise = enrichmentQuery('test prompt')
    await vi.advanceTimersByTimeAsync(0)

    currentStream.emit(makeSuccessResult('just text'))
    await vi.advanceTimersByTimeAsync(0)

    const result = await queryPromise
    expect(result.structuredOutput).toBeNull()
    expect(result.text).toBe('just text')
  })

  test('state transitions: available → busy → available', async () => {
    await initWithWarmup()
    expect(getEnrichmentSlotStats().state).toBe('available')

    const queryPromise = enrichmentQuery('test prompt')
    expect(getEnrichmentSlotStats().state).toBe('busy')

    await vi.advanceTimersByTimeAsync(0)
    currentStream.emit(makeSuccessResult('result'))
    await vi.advanceTimersByTimeAsync(0)
    await queryPromise

    expect(getEnrichmentSlotStats().state).toBe('available')
  })

  test('totalRequests increments on each query', async () => {
    await initWithWarmup()
    expect(getEnrichmentSlotStats().totalRequests).toBe(0)

    const q1 = enrichmentQuery('prompt 1')
    await vi.advanceTimersByTimeAsync(0)
    currentStream.emit(makeSuccessResult('r1'))
    await vi.advanceTimersByTimeAsync(0)
    await q1

    expect(getEnrichmentSlotStats().totalRequests).toBe(1)

    const q2 = enrichmentQuery('prompt 2')
    await vi.advanceTimersByTimeAsync(0)
    currentStream.emit(makeSuccessResult('r2'))
    await vi.advanceTimersByTimeAsync(0)
    await q2

    expect(getEnrichmentSlotStats().totalRequests).toBe(2)
  })
})

describe('enrichment query - FIFO queuing', () => {
  test('second request waits while first is in progress', async () => {
    await initWithWarmup()

    const q1 = enrichmentQuery('prompt 1')
    const q2 = enrichmentQuery('prompt 2')
    expect(getEnrichmentSlotStats().state).toBe('busy')

    await vi.advanceTimersByTimeAsync(0)
    currentStream.emit(makeSuccessResult('result 1'))
    await vi.advanceTimersByTimeAsync(0)
    const r1 = await q1
    expect(r1.text).toBe('result 1')

    await vi.advanceTimersByTimeAsync(0)
    currentStream.emit(makeSuccessResult('result 2'))
    await vi.advanceTimersByTimeAsync(0)
    const r2 = await q2
    expect(r2.text).toBe('result 2')
  })

  test('3 concurrent requests processed in FIFO order', async () => {
    await initWithWarmup()

    const results: string[] = []
    const q1 = enrichmentQuery('p1').then((r) => {
      results.push(r.text!)
    })
    const q2 = enrichmentQuery('p2').then((r) => {
      results.push(r.text!)
    })
    const q3 = enrichmentQuery('p3').then((r) => {
      results.push(r.text!)
    })

    for (const text of ['r1', 'r2', 'r3']) {
      await vi.advanceTimersByTimeAsync(0)
      currentStream.emit(makeSuccessResult(text))
      await vi.advanceTimersByTimeAsync(0)
    }

    await Promise.all([q1, q2, q3])
    expect(results).toEqual(['r1', 'r2', 'r3'])
    expect(getEnrichmentSlotStats().totalRequests).toBe(3)
  })
})

describe('max reuses and recycling', () => {
  test('slot recycles after reaching max reuses', async () => {
    vi.stubEnv('OPENTASK_AI_MAX_REUSES', '2')

    await initWithWarmup()
    expect(getEnrichmentSlotStats().totalRecycles).toBe(0)

    const q1 = enrichmentQuery('p1')
    await vi.advanceTimersByTimeAsync(0)
    currentStream.emit(makeSuccessResult('r1'))
    await vi.advanceTimersByTimeAsync(0)
    await q1

    const q2 = enrichmentQuery('p2')
    await vi.advanceTimersByTimeAsync(0)
    currentStream.emit(makeSuccessResult('r2'))
    await vi.advanceTimersByTimeAsync(0)
    await q2

    // recycleSlot fires via setTimeout(0)
    await vi.advanceTimersByTimeAsync(0)

    expect(getEnrichmentSlotStats().totalRecycles).toBe(1)

    vi.unstubAllEnvs()
  })

  test('recycled slot can be re-initialized and serve queries', async () => {
    vi.stubEnv('OPENTASK_AI_MAX_REUSES', '1')

    await initWithWarmup()
    const firstStream = currentStream

    const q1 = enrichmentQuery('p1')
    await vi.advanceTimersByTimeAsync(0)
    firstStream.emit(makeSuccessResult('r1'))
    await vi.advanceTimersByTimeAsync(0)
    await q1

    // Let recycleSlot's setTimeout fire — triggers reinit which creates a new stream
    await vi.advanceTimersByTimeAsync(0)
    await waitForStream()
    const secondStream = currentStream
    expect(secondStream).not.toBe(firstStream)

    // Complete warmup on new stream
    secondStream.emit(makeSuccessResult('READY'))
    await vi.advanceTimersByTimeAsync(0)

    expect(getEnrichmentSlotStats().state).toBe('available')

    // Query on the new stream
    const q2 = enrichmentQuery('p2')
    await vi.advanceTimersByTimeAsync(0)
    secondStream.emit(makeSuccessResult('r2'))
    await vi.advanceTimersByTimeAsync(0)
    const r2 = await q2

    expect(r2.text).toBe('r2')
    expect(getEnrichmentSlotStats().totalRequests).toBe(2)

    vi.unstubAllEnvs()
  })
})

describe('circuit breaker', () => {
  test('5 rapid recycles mark slot as dead', async () => {
    vi.stubEnv('OPENTASK_AI_MAX_REUSES', '1')

    await initWithWarmup()

    for (let i = 0; i < 4; i++) {
      const q = enrichmentQuery(`p${i}`)
      await vi.advanceTimersByTimeAsync(0)
      currentStream.emit(makeSuccessResult(`r${i}`))
      await vi.advanceTimersByTimeAsync(0)
      await q

      // recycleSlot fires via setTimeout(0) → reinit
      await vi.advanceTimersByTimeAsync(0)
      await waitForStream()
      currentStream.emit(makeSuccessResult('READY'))
      await vi.advanceTimersByTimeAsync(0)
    }

    // 5th cycle triggers circuit breaker
    const q5 = enrichmentQuery('p5')
    await vi.advanceTimersByTimeAsync(0)
    currentStream.emit(makeSuccessResult('r5'))
    await vi.advanceTimersByTimeAsync(0)
    await q5

    await vi.advanceTimersByTimeAsync(0)

    expect(getEnrichmentSlotStats().state).toBe('dead')
    expect(getEnrichmentSlotStats().totalRecycles).toBe(5)

    vi.unstubAllEnvs()
  })

  test('shutdown rejects queued waiters', async () => {
    await initWithWarmup()

    // Occupy the slot, then queue two waiters
    enrichmentQuery('p1') // occupies slot
    await vi.advanceTimersByTimeAsync(0) // let p1 push its prompt
    const q2 = enrichmentQuery('p2') // queued
    const q3 = enrichmentQuery('p3') // queued

    shutdownEnrichmentSlot()

    await expect(q2).rejects.toThrow('shutting down')
    await expect(q3).rejects.toThrow('shutting down')
  })
})

describe('shutdown', () => {
  test('shutdown sets state to dead', async () => {
    await initWithWarmup()
    expect(getEnrichmentSlotStats().state).toBe('available')

    shutdownEnrichmentSlot()
    expect(getEnrichmentSlotStats().state).toBe('dead')
  })

  test('query after shutdown throws', async () => {
    await initWithWarmup()
    shutdownEnrichmentSlot()

    await expect(enrichmentQuery('test')).rejects.toThrow('dead')
  })

  test('shutdown resolves in-flight query with null', async () => {
    await initWithWarmup()

    // Start a query but don't deliver a result
    const queryPromise = enrichmentQuery('test')
    expect(getEnrichmentSlotStats().state).toBe('busy')

    // Let the query push its prompt before shutting down
    await vi.advanceTimersByTimeAsync(0)

    // Shutdown while query is in-flight — deliverResult(null) called
    shutdownEnrichmentSlot()
    await vi.advanceTimersByTimeAsync(0)

    const result = await queryPromise
    expect(result.structuredOutput).toBeNull()
    expect(result.text).toBeNull()
  })
})

describe('error handling', () => {
  test('SDK stream error delivers null to current caller', async () => {
    await initWithWarmup()

    const queryPromise = enrichmentQuery('test')
    await vi.advanceTimersByTimeAsync(0)

    currentStream.error(new Error('stream crashed'))
    await vi.advanceTimersByTimeAsync(0)

    const result = await queryPromise
    expect(result.structuredOutput).toBeNull()
    expect(result.text).toBeNull()
  })

  test('SDK error result delivers null structured output and text', async () => {
    await initWithWarmup()

    const queryPromise = enrichmentQuery('test')
    await vi.advanceTimersByTimeAsync(0)

    currentStream.emit(makeErrorResult('error_during_execution'))
    await vi.advanceTimersByTimeAsync(0)

    const result = await queryPromise
    expect(result.structuredOutput).toBeNull()
    expect(result.text).toBeNull()
  })

  test('premature stream end triggers recycle', async () => {
    await initWithWarmup()
    expect(getEnrichmentSlotStats().totalRecycles).toBe(0)

    const queryPromise = enrichmentQuery('test')
    await vi.advanceTimersByTimeAsync(0)

    currentStream.end()
    await vi.advanceTimersByTimeAsync(0)

    expect(getEnrichmentSlotStats().totalRecycles).toBe(1)

    // recycleSlot resolves in-flight query with null via deliverResult
    const result = await queryPromise
    expect(result.structuredOutput).toBeNull()
    expect(result.text).toBeNull()
  })

  test('query when uninitialized throws', async () => {
    expect(getEnrichmentSlotStats().state).toBe('uninitialized')
    await expect(enrichmentQuery('test')).rejects.toThrow('uninitialized')
  })
})

describe('query timeout', () => {
  test('query rejects after timeout', async () => {
    vi.stubEnv('OPENTASK_AI_QUERY_TIMEOUT_MS', '500')

    await initWithWarmup()

    const queryPromise = enrichmentQuery('test')
    await vi.advanceTimersByTimeAsync(0)

    // Attach rejection handler before advancing past the timeout
    const assertion = expect(queryPromise).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(500)
    await assertion

    vi.unstubAllEnvs()
  })
})

describe('stats', () => {
  test('getEnrichmentSlotStats returns correct values', async () => {
    const initial = getEnrichmentSlotStats()
    expect(initial.state).toBe('uninitialized')
    expect(initial.totalRequests).toBe(0)
    expect(initial.totalRecycles).toBe(0)
    expect(initial.activatedAt).toBeNull()
    expect(initial.lastRequestAt).toBeNull()

    await initWithWarmup()

    const afterInit = getEnrichmentSlotStats()
    expect(afterInit.state).toBe('available')
    expect(afterInit.activatedAt).not.toBeNull()

    const q = enrichmentQuery('test', { userId: 1 })
    await vi.advanceTimersByTimeAsync(0)
    currentStream.emit(makeSuccessResult('result'))
    await vi.advanceTimersByTimeAsync(0)
    await q

    const afterQuery = getEnrichmentSlotStats()
    expect(afterQuery.totalRequests).toBe(1)
    expect(afterQuery.lastRequestAt).not.toBeNull()
  })

  test('currentOperation is populated while busy and cleared after', async () => {
    await initWithWarmup()

    // Before query — no current operation
    expect(getEnrichmentSlotStats().currentOperation).toBeNull()

    // Start query with tracking options
    const queryPromise = enrichmentQuery('test prompt', {
      userId: 1,
      taskId: 42,
      inputText: 'Buy groceries',
    })
    // Flush past await acquireSlot() so currentOperation gets set
    await vi.advanceTimersByTimeAsync(0)

    // While busy — currentOperation should be populated
    const duringQuery = getEnrichmentSlotStats()
    expect(duringQuery.state).toBe('busy')
    expect(duringQuery.currentOperation).not.toBeNull()
    expect(duringQuery.currentOperation!.taskId).toBe(42)
    expect(duringQuery.currentOperation!.inputText).toBe('Buy groceries')
    expect(duringQuery.currentOperation!.startedAt).not.toBeNull()

    // Complete the query
    await vi.advanceTimersByTimeAsync(0)
    currentStream.emit(makeSuccessResult('result', { title: 'Groceries' }))
    await vi.advanceTimersByTimeAsync(0)
    await queryPromise

    // After query — currentOperation should be cleared
    expect(getEnrichmentSlotStats().currentOperation).toBeNull()
  })
})

describe('warmup edge cases', () => {
  test('warmup timeout: subprocess hangs → dead', async () => {
    const initPromise = initEnrichmentSlot()
    await waitForStream()

    // Don't emit anything — let warmup timeout (15s)
    await vi.advanceTimersByTimeAsync(15_000)
    await initPromise

    expect(getEnrichmentSlotStats().state).toBe('dead')
  })

  test('stream error during warmup → dead', async () => {
    const initPromise = initEnrichmentSlot()
    await waitForStream()

    currentStream.error(new Error('subprocess crashed'))
    await vi.advanceTimersByTimeAsync(0)
    await initPromise

    expect(getEnrichmentSlotStats().state).toBe('dead')
  })

  test('shutdown during initialization → dead', async () => {
    const initPromise = initEnrichmentSlot()
    await waitForStream()

    // Shutdown before warmup completes
    shutdownEnrichmentSlot()
    await vi.advanceTimersByTimeAsync(0)
    await initPromise

    expect(getEnrichmentSlotStats().state).toBe('dead')
  })
})

describe('recycle resilience', () => {
  test('queued waiter survives recycle and gets served', async () => {
    await initWithWarmup()

    // q1 occupies the slot
    const q1 = enrichmentQuery('p1')
    await vi.advanceTimersByTimeAsync(0)

    // q2 waits in FIFO queue
    const q2 = enrichmentQuery('p2')

    // Stream error during q1 → consumeStream catches → recycleSlot
    currentStream.error(new Error('stream error'))
    await vi.advanceTimersByTimeAsync(0)

    // q1 gets null (from consumeStream catch → deliverResult(null))
    const r1 = await q1
    expect(r1.text).toBeNull()

    // recycleSlot fires reinit via setTimeout(0)
    await vi.advanceTimersByTimeAsync(0)
    await waitForStream()

    // Complete warmup on new stream
    currentStream.emit(makeSuccessResult('READY'))
    await vi.advanceTimersByTimeAsync(0)

    // q2 was woken by releaseSlot after init completed
    await vi.advanceTimersByTimeAsync(0)
    currentStream.emit(makeSuccessResult('result for q2', { title: 'Q2' }))
    await vi.advanceTimersByTimeAsync(0)

    const r2 = await q2
    expect(r2.text).toBe('result for q2')
    expect(r2.structuredOutput).toEqual({ title: 'Q2' })
  })

  test('query arriving during reinit waits and gets served', async () => {
    vi.stubEnv('OPENTASK_AI_MAX_REUSES', '1')

    await initWithWarmup()

    // Query triggers recycle (max reuses = 1)
    const q1 = enrichmentQuery('p1')
    await vi.advanceTimersByTimeAsync(0)
    currentStream.emit(makeSuccessResult('r1'))
    await vi.advanceTimersByTimeAsync(0)
    await q1

    // Recycle fires, state becomes 'initializing'
    await vi.advanceTimersByTimeAsync(0)
    expect(getEnrichmentSlotStats().state).toBe('initializing')

    // Query arrives during reinit — waits in queue
    const q2 = enrichmentQuery('p2')

    // Complete reinit warmup
    await waitForStream()
    currentStream.emit(makeSuccessResult('READY'))
    await vi.advanceTimersByTimeAsync(0)

    // q2 was woken by releaseSlot after init completed
    await vi.advanceTimersByTimeAsync(0)
    currentStream.emit(makeSuccessResult('r2'))
    await vi.advanceTimersByTimeAsync(0)

    const r2 = await q2
    expect(r2.text).toBe('r2')

    vi.unstubAllEnvs()
  })
})
