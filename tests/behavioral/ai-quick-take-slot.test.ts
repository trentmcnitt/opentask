/**
 * Quick take slot state machine behavioral tests
 *
 * Tests the warm subprocess slot mechanics for quick take: state transitions,
 * latest-wins supersession, recycling, circuit breaker, warmup validation,
 * and shutdown. Uses a controllable fake SDK stream — no real subprocesses.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { createFakeStream, makeSuccessResult, makeErrorResult } from '../helpers/fake-sdk-stream'
import type { FakeStreamControl } from '../helpers/fake-sdk-stream'

// Set model env var so requireFeatureModel() works (no real API calls are made)
process.env.OPENTASK_AI_QUICKTAKE_MODEL = 'test-model'

// --- Mocks ---

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('@/core/ai/activity', () => ({
  logAIActivity: vi.fn(),
}))

vi.mock('@/core/ai/quick-take', () => ({
  QUICK_TAKE_SYSTEM_PROMPT: 'test quick take system prompt',
}))

// Mock the SDK — intercept the dynamic import inside initQuickTakeSlot
let currentStream: FakeStreamControl
const mockQuery = vi.fn()

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}))

// Import the module under test (after mocks are set up)
import {
  initQuickTakeSlot,
  quickTakeSlotQuery,
  getQuickTakeSlotStats,
  shutdownQuickTakeSlot,
  _resetSlotForTesting,
} from '@/core/ai/quick-take-slot'

// --- Setup ---

beforeEach(() => {
  vi.useFakeTimers()
  _resetSlotForTesting()

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
 * The dynamic `await import()` inside initQuickTakeSlot resolves as a microtask,
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
  const initPromise = initQuickTakeSlot()
  await waitForStream()
  currentStream.emit(makeSuccessResult('READY'))
  await vi.advanceTimersByTimeAsync(0)
  await initPromise
}

// --- Tests ---

describe('quick take slot initialization', () => {
  test('happy path: uninitialized → initializing → available', async () => {
    expect(getQuickTakeSlotStats().state).toBe('uninitialized')

    const initPromise = initQuickTakeSlot()
    await waitForStream()

    expect(getQuickTakeSlotStats().state).toBe('initializing')

    currentStream.emit(makeSuccessResult('READY'))
    await vi.advanceTimersByTimeAsync(0)
    await initPromise

    const stats = getQuickTakeSlotStats()
    expect(stats.state).toBe('available')
    expect(stats.activatedAt).not.toBeNull()
  })

  test('warmup failure: response without READY → dead', async () => {
    const initPromise = initQuickTakeSlot()
    await waitForStream()

    currentStream.emit(makeSuccessResult('SOMETHING ELSE'))
    await vi.advanceTimersByTimeAsync(0)
    await initPromise

    expect(getQuickTakeSlotStats().state).toBe('dead')
  })

  test('warmup with empty text → dead', async () => {
    const initPromise = initQuickTakeSlot()
    await waitForStream()

    currentStream.emit(makeSuccessResult(''))
    await vi.advanceTimersByTimeAsync(0)
    await initPromise

    expect(getQuickTakeSlotStats().state).toBe('dead')
  })

  test('double init when already available is a no-op', async () => {
    await initWithWarmup()
    expect(getQuickTakeSlotStats().state).toBe('available')

    await initQuickTakeSlot()
    expect(getQuickTakeSlotStats().state).toBe('available')
    expect(mockQuery).toHaveBeenCalledTimes(1)
  })
})

describe('quick take query - happy path', () => {
  test('returns text result', async () => {
    await initWithWarmup()

    const queryPromise = quickTakeSlotQuery('test prompt', { userId: 1 })
    await vi.advanceTimersByTimeAsync(0)

    currentStream.emit(makeSuccessResult('a pithy observation'))
    await vi.advanceTimersByTimeAsync(0)

    const result = await queryPromise
    expect(result).not.toBeNull()
    expect(result!.text).toBe('a pithy observation')
    expect(result!.durationMs).toBeGreaterThanOrEqual(0)
  })

  test('state transitions: available → busy → available', async () => {
    await initWithWarmup()
    expect(getQuickTakeSlotStats().state).toBe('available')

    const queryPromise = quickTakeSlotQuery('test')
    expect(getQuickTakeSlotStats().state).toBe('busy')

    await vi.advanceTimersByTimeAsync(0)
    currentStream.emit(makeSuccessResult('result'))
    await vi.advanceTimersByTimeAsync(0)
    await queryPromise

    expect(getQuickTakeSlotStats().state).toBe('available')
  })

  test('totalRequests increments on each query', async () => {
    await initWithWarmup()

    expect(getQuickTakeSlotStats().totalRequests).toBe(0)

    const q1 = quickTakeSlotQuery('p1')
    await vi.advanceTimersByTimeAsync(0)
    currentStream.emit(makeSuccessResult('r1'))
    await vi.advanceTimersByTimeAsync(0)
    await q1

    expect(getQuickTakeSlotStats().totalRequests).toBe(1)

    const q2 = quickTakeSlotQuery('p2')
    await vi.advanceTimersByTimeAsync(0)
    currentStream.emit(makeSuccessResult('r2'))
    await vi.advanceTimersByTimeAsync(0)
    await q2

    expect(getQuickTakeSlotStats().totalRequests).toBe(2)
  })
})

describe('latest-wins concurrency', () => {
  test('new request while busy supersedes old — old caller gets null', async () => {
    await initWithWarmup()

    // Start first query
    const q1 = quickTakeSlotQuery('prompt 1')
    expect(getQuickTakeSlotStats().state).toBe('busy')

    // Supersede with second query — q1 should resolve with null immediately
    const q2 = quickTakeSlotQuery('prompt 2')

    // q1 gets null (superseded)
    const r1 = await q1
    expect(r1).not.toBeNull()
    expect(r1!.text).toBeNull()

    expect(getQuickTakeSlotStats().totalSuperseded).toBe(1)

    // Now the stream processes prompt 1 first (it was already pushed).
    // The consumer should skip it (skipCount=1) and wait for prompt 2's result.
    await vi.advanceTimersByTimeAsync(0)

    // Emit result for prompt 1 — should be skipped
    currentStream.emit(makeSuccessResult('result for prompt 1'))
    await vi.advanceTimersByTimeAsync(0)

    // Emit result for prompt 2 — should be delivered
    currentStream.emit(makeSuccessResult('result for prompt 2'))
    await vi.advanceTimersByTimeAsync(0)

    const r2 = await q2
    expect(r2).not.toBeNull()
    expect(r2!.text).toBe('result for prompt 2')
  })

  test('multiple supersessions accumulate skipCount', async () => {
    await initWithWarmup()

    // q1 → q2 → q3: each supersedes the previous
    const q1 = quickTakeSlotQuery('p1')
    const q2 = quickTakeSlotQuery('p2') // supersedes q1
    const q3 = quickTakeSlotQuery('p3') // supersedes q2

    // q1 and q2 get null immediately
    const r1 = await q1
    const r2 = await q2
    expect(r1!.text).toBeNull()
    expect(r2!.text).toBeNull()
    expect(getQuickTakeSlotStats().totalSuperseded).toBe(2)

    await vi.advanceTimersByTimeAsync(0)

    // Emit 3 results — first 2 are skipped (skipCount=2), third delivered
    currentStream.emit(makeSuccessResult('skip1'))
    await vi.advanceTimersByTimeAsync(0)
    currentStream.emit(makeSuccessResult('skip2'))
    await vi.advanceTimersByTimeAsync(0)
    currentStream.emit(makeSuccessResult('delivered'))
    await vi.advanceTimersByTimeAsync(0)

    const r3 = await q3
    expect(r3!.text).toBe('delivered')
  })

  test('skipped results do not count toward reuse limit', async () => {
    vi.stubEnv('OPENTASK_AI_QUICKTAKE_MAX_REUSES', '2')

    await initWithWarmup()

    // q1 → superseded by q2 (skipCount=1)
    const q1 = quickTakeSlotQuery('p1')
    const q2 = quickTakeSlotQuery('p2')
    await q1 // null

    await vi.advanceTimersByTimeAsync(0)

    // Emit result for p1 (skipped — does NOT count as reuse)
    currentStream.emit(makeSuccessResult('skipped'))
    await vi.advanceTimersByTimeAsync(0)

    // Emit result for p2 (delivered — reuse count = 1)
    currentStream.emit(makeSuccessResult('r2'))
    await vi.advanceTimersByTimeAsync(0)
    await q2

    // q3 — reuse count becomes 2, triggers recycle
    const q3 = quickTakeSlotQuery('p3')
    await vi.advanceTimersByTimeAsync(0)
    currentStream.emit(makeSuccessResult('r3'))
    await vi.advanceTimersByTimeAsync(0)
    await q3

    // Let recycle fire
    await vi.advanceTimersByTimeAsync(0)

    expect(getQuickTakeSlotStats().totalRecycles).toBe(1)
    // Total delivered was 2 (r2, r3), matching max reuses of 2

    vi.unstubAllEnvs()
  })

  test('totalSuperseded counter increments correctly', async () => {
    await initWithWarmup()

    expect(getQuickTakeSlotStats().totalSuperseded).toBe(0)

    const q1 = quickTakeSlotQuery('p1')
    quickTakeSlotQuery('p2') // supersedes q1
    await q1

    expect(getQuickTakeSlotStats().totalSuperseded).toBe(1)
  })
})

describe('non-usable states return null (not throw)', () => {
  test('query when dead returns null', async () => {
    // Fail warmup to get dead state
    const initPromise = initQuickTakeSlot()
    await waitForStream()
    currentStream.emit(makeSuccessResult('NOPE'))
    await vi.advanceTimersByTimeAsync(0)
    await initPromise
    expect(getQuickTakeSlotStats().state).toBe('dead')

    const result = await quickTakeSlotQuery('test')
    expect(result).toBeNull()
  })

  test('query when uninitialized returns null', async () => {
    expect(getQuickTakeSlotStats().state).toBe('uninitialized')
    const result = await quickTakeSlotQuery('test')
    expect(result).toBeNull()
  })

  test('query when initializing returns null', async () => {
    // Start init but don't complete warmup
    initQuickTakeSlot() // don't await
    await vi.advanceTimersByTimeAsync(0)
    expect(getQuickTakeSlotStats().state).toBe('initializing')

    const result = await quickTakeSlotQuery('test')
    expect(result).toBeNull()

    // Clean up: complete warmup to avoid dangling promises
    currentStream.emit(makeSuccessResult('READY'))
    await vi.advanceTimersByTimeAsync(0)
  })
})

describe('max reuses and recycling', () => {
  test('slot recycles after reaching max delivered results', async () => {
    vi.stubEnv('OPENTASK_AI_QUICKTAKE_MAX_REUSES', '2')

    await initWithWarmup()

    const q1 = quickTakeSlotQuery('p1')
    await vi.advanceTimersByTimeAsync(0)
    currentStream.emit(makeSuccessResult('r1'))
    await vi.advanceTimersByTimeAsync(0)
    await q1

    const q2 = quickTakeSlotQuery('p2')
    await vi.advanceTimersByTimeAsync(0)
    currentStream.emit(makeSuccessResult('r2'))
    await vi.advanceTimersByTimeAsync(0)
    await q2

    // Let recycle fire
    await vi.advanceTimersByTimeAsync(0)

    expect(getQuickTakeSlotStats().totalRecycles).toBe(1)

    vi.unstubAllEnvs()
  })

  test('recycled slot can reinit and serve', async () => {
    vi.stubEnv('OPENTASK_AI_QUICKTAKE_MAX_REUSES', '1')

    await initWithWarmup()
    const firstStream = currentStream

    // Query triggers recycle
    const q1 = quickTakeSlotQuery('p1')
    await vi.advanceTimersByTimeAsync(0)
    firstStream.emit(makeSuccessResult('r1'))
    await vi.advanceTimersByTimeAsync(0)
    await q1

    // Let recycle fire — creates new stream
    await vi.advanceTimersByTimeAsync(0)
    const secondStream = currentStream
    expect(secondStream).not.toBe(firstStream)

    // Complete warmup on new stream
    await vi.advanceTimersByTimeAsync(0)
    secondStream.emit(makeSuccessResult('READY'))
    await vi.advanceTimersByTimeAsync(0)

    expect(getQuickTakeSlotStats().state).toBe('available')

    // Query on new stream
    const q2 = quickTakeSlotQuery('p2')
    await vi.advanceTimersByTimeAsync(0)
    secondStream.emit(makeSuccessResult('r2'))
    await vi.advanceTimersByTimeAsync(0)
    const r2 = await q2
    expect(r2!.text).toBe('r2')

    vi.unstubAllEnvs()
  })
})

describe('circuit breaker', () => {
  test('5 rapid recycles mark slot as dead', async () => {
    vi.stubEnv('OPENTASK_AI_QUICKTAKE_MAX_REUSES', '1')

    await initWithWarmup()

    for (let i = 0; i < 4; i++) {
      const q = quickTakeSlotQuery(`p${i}`)
      await vi.advanceTimersByTimeAsync(0)
      currentStream.emit(makeSuccessResult(`r${i}`))
      await vi.advanceTimersByTimeAsync(0)
      await q

      // Recycle fires, reinit creates new stream
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(0)
      currentStream.emit(makeSuccessResult('READY'))
      await vi.advanceTimersByTimeAsync(0)
    }

    // 5th cycle triggers circuit breaker
    const q5 = quickTakeSlotQuery('p5')
    await vi.advanceTimersByTimeAsync(0)
    currentStream.emit(makeSuccessResult('r5'))
    await vi.advanceTimersByTimeAsync(0)
    await q5

    await vi.advanceTimersByTimeAsync(0)

    expect(getQuickTakeSlotStats().state).toBe('dead')
    expect(getQuickTakeSlotStats().totalRecycles).toBe(5)

    vi.unstubAllEnvs()
  })
})

describe('shutdown', () => {
  test('shutdown sets state to dead', async () => {
    await initWithWarmup()
    shutdownQuickTakeSlot()
    expect(getQuickTakeSlotStats().state).toBe('dead')
  })

  test('query after shutdown returns null', async () => {
    await initWithWarmup()
    shutdownQuickTakeSlot()

    const result = await quickTakeSlotQuery('test')
    expect(result).toBeNull()
  })

  test('shutdown resolves in-flight query with null text', async () => {
    await initWithWarmup()

    const queryPromise = quickTakeSlotQuery('test')
    expect(getQuickTakeSlotStats().state).toBe('busy')

    shutdownQuickTakeSlot()
    await vi.advanceTimersByTimeAsync(0)

    const result = await queryPromise
    expect(result).not.toBeNull()
    expect(result!.text).toBeNull()
  })
})

describe('error handling', () => {
  test('SDK stream error delivers null to current caller', async () => {
    await initWithWarmup()

    const queryPromise = quickTakeSlotQuery('test')
    await vi.advanceTimersByTimeAsync(0)

    currentStream.error(new Error('stream crashed'))
    await vi.advanceTimersByTimeAsync(0)

    const result = await queryPromise
    expect(result).not.toBeNull()
    expect(result!.text).toBeNull()
  })

  test('SDK error result delivers null text', async () => {
    await initWithWarmup()

    const queryPromise = quickTakeSlotQuery('test')
    await vi.advanceTimersByTimeAsync(0)

    currentStream.emit(makeErrorResult('error_during_execution'))
    await vi.advanceTimersByTimeAsync(0)

    const result = await queryPromise
    expect(result).not.toBeNull()
    expect(result!.text).toBeNull()
  })

  test('premature stream end triggers recycle', async () => {
    await initWithWarmup()
    expect(getQuickTakeSlotStats().totalRecycles).toBe(0)

    const queryPromise = quickTakeSlotQuery('test')
    await vi.advanceTimersByTimeAsync(0)

    currentStream.end()
    await vi.advanceTimersByTimeAsync(0)

    // recycleSlot fires via setTimeout(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(getQuickTakeSlotStats().totalRecycles).toBe(1)

    // Clean up dangling query
    shutdownQuickTakeSlot()
    await vi.advanceTimersByTimeAsync(0)
    const result = await queryPromise
    expect(result!.text).toBeNull()
  })

  test('timeout returns { text: null } instead of throwing', async () => {
    vi.stubEnv('OPENTASK_AI_QUICKTAKE_TIMEOUT_MS', '500')

    await initWithWarmup()

    const queryPromise = quickTakeSlotQuery('test')
    await vi.advanceTimersByTimeAsync(0)

    // Don't emit result — advance past timeout
    await vi.advanceTimersByTimeAsync(500)

    // Quick take slot catches timeout and returns null text (does NOT throw)
    const result = await queryPromise
    expect(result).not.toBeNull()
    expect(result!.text).toBeNull()

    vi.unstubAllEnvs()
  })
})

describe('stats', () => {
  test('getQuickTakeSlotStats returns correct values', async () => {
    const initial = getQuickTakeSlotStats()
    expect(initial.state).toBe('uninitialized')
    expect(initial.totalRequests).toBe(0)
    expect(initial.totalRecycles).toBe(0)
    expect(initial.totalSuperseded).toBe(0)

    await initWithWarmup()

    const afterInit = getQuickTakeSlotStats()
    expect(afterInit.state).toBe('available')
    expect(afterInit.activatedAt).not.toBeNull()

    const q = quickTakeSlotQuery('test', { userId: 1 })
    await vi.advanceTimersByTimeAsync(0)
    currentStream.emit(makeSuccessResult('result'))
    await vi.advanceTimersByTimeAsync(0)
    await q

    const afterQuery = getQuickTakeSlotStats()
    expect(afterQuery.totalRequests).toBe(1)
    expect(afterQuery.lastRequestAt).not.toBeNull()
  })

  test('currentOperation is populated while busy', async () => {
    await initWithWarmup()

    // Before query — no current operation
    expect(getQuickTakeSlotStats().currentOperation).toBeNull()

    // Start query with inputText
    const queryPromise = quickTakeSlotQuery('test prompt', {
      userId: 1,
      inputText: 'my task list summary',
    })

    // While busy — currentOperation should be populated
    const duringQuery = getQuickTakeSlotStats()
    expect(duringQuery.state).toBe('busy')
    expect(duringQuery.currentOperation).not.toBeNull()
    expect(duringQuery.currentOperation!.inputText).toBe('my task list summary')
    expect(duringQuery.currentOperation!.startedAt).not.toBeNull()

    // Complete the query
    await vi.advanceTimersByTimeAsync(0)
    currentStream.emit(makeSuccessResult('result'))
    await vi.advanceTimersByTimeAsync(0)
    await queryPromise

    // After query — currentOperation should be cleared
    expect(getQuickTakeSlotStats().currentOperation).toBeNull()
  })

  test('currentOperation is cleared after supersession', async () => {
    await initWithWarmup()

    // First query
    const q1 = quickTakeSlotQuery('p1', { inputText: 'first' })

    // Supersede — currentOperation should show the new request's input
    const q2 = quickTakeSlotQuery('p2', { inputText: 'second' })

    const stats = getQuickTakeSlotStats()
    expect(stats.currentOperation).not.toBeNull()
    expect(stats.currentOperation!.inputText).toBe('second')

    await q1 // null (superseded)

    // Complete
    await vi.advanceTimersByTimeAsync(0)
    currentStream.emit(makeSuccessResult('skip'))
    await vi.advanceTimersByTimeAsync(0)
    currentStream.emit(makeSuccessResult('delivered'))
    await vi.advanceTimersByTimeAsync(0)
    await q2

    expect(getQuickTakeSlotStats().currentOperation).toBeNull()
  })
})

describe('warmup edge cases', () => {
  test('warmup timeout: subprocess hangs → dead', async () => {
    const initPromise = initQuickTakeSlot()
    await waitForStream()

    // Don't emit anything — let warmup timeout (15s)
    await vi.advanceTimersByTimeAsync(15_000)
    await initPromise

    expect(getQuickTakeSlotStats().state).toBe('dead')
  })

  test('stream error during warmup → dead', async () => {
    const initPromise = initQuickTakeSlot()
    await waitForStream()

    currentStream.error(new Error('subprocess crashed'))
    await vi.advanceTimersByTimeAsync(0)
    await initPromise

    expect(getQuickTakeSlotStats().state).toBe('dead')
  })

  test('shutdown during initialization → dead', async () => {
    const initPromise = initQuickTakeSlot()
    await waitForStream()

    // Shutdown before warmup completes
    shutdownQuickTakeSlot()
    await vi.advanceTimersByTimeAsync(0)
    await initPromise

    expect(getQuickTakeSlotStats().state).toBe('dead')
  })
})
