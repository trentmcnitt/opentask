/**
 * Warm slot factory
 *
 * A warm slot keeps one Claude Code subprocess alive and reuses it across
 * requests via the MessageChannel pattern, so a query skips the cold-start
 * latency. Enrichment (enrichment-slot.ts) and Quick Take (quick-take-slot.ts)
 * each own one. Adapted from bespoke-ai-vscode-ext's SlotPool + CommandPool
 * pattern, simplified to a single slot.
 *
 * The factory owns the whole lifecycle, which the two slots share line for
 * line:
 * - init: spawn the subprocess, send the warmup message, wait (with a
 *   timeout) for `validateWarmup` to accept the first result
 * - the background stream consumer: the first result is the warmup, every
 *   later one goes to the waiting caller; after `getMaxReuses()` delivered
 *   results the subprocess is recycled
 * - recycling, with a circuit breaker (5 recycles in 5 seconds = dead)
 * - re-init backoff out of `dead` (computeReinitBackoff), a single-flight
 *   init guard, and a `slot-failure` alert on every death
 * - stats, graceful shutdown, and a reset for tests
 *
 * What differs between the two slots is how concurrent callers share the one
 * subprocess. That is the `policy`:
 * - `fifoQueuePolicy` (enrichment): a busy slot queues the caller; every
 *   request gets its own answer, in order.
 * - `latestWinsPolicy` (quick take): a new request supersedes the in-flight
 *   one, whose caller gets null, and the superseded answer is discarded when
 *   it arrives. Only the latest quick take matters.
 *
 * Error handling stays in each wrapper, and differs on purpose (see
 * slot-shared.ts): the enrichment slot THROWS so the enrichment pipeline
 * retries; the quick-take slot RETURNS NULL so its caller falls back to a
 * cold subprocess.
 *
 * All mutable state lives on globalThis under the slot's own key, to survive
 * module duplication. Next.js Turbopack may bundle these modules into separate
 * chunks for instrumentation.ts and the API routes, creating independent
 * module scopes. Without globalThis, an API route would read fresh defaults
 * ("uninitialized") while the real slot lives in the instrumentation chunk.
 */

import { log } from '@/lib/logger'
import { notifyError } from '@/lib/error-notify'
import { toCliJsonSchema } from './json-schema'
import { createMessageChannel, type MessageChannel } from './message-channel'
import {
  type SlotState,
  type BaseSlotStats,
  WARMUP_MESSAGE,
  WARMUP_TIMEOUT_MS,
  checkCircuitBreaker,
  computeReinitBackoff,
  CIRCUIT_BREAKER_INITIAL_FAILURES,
} from './slot-shared'
import { z } from 'zod'
import type { Options, SDKResultSuccess } from '@anthropic-ai/claude-agent-sdk'

// --- Types ---

/** What one `result` message from the subprocess carried. */
export interface SlotResult {
  structuredOutput: Record<string, unknown> | null
  text: string | null
}

interface SlotInternals {
  state: SlotState
  channel: MessageChannel | null
  generation: number
  resultCount: number
  resultPromise: Promise<SlotResult | null> | null
  deliverResult: ((result: SlotResult | null) => void) | null
  // Circuit breaker
  lastRecycleTime: number
  rapidRecycleCount: number
  // Re-init backoff: tracks consecutive failures so the slot can recover
  // from `dead` without thrashing. Reset to 0 on successful warmup.
  consecutiveInitFailures: number
  nextReinitAllowedAt: number
}

/** Everything a slot keeps on globalThis. `S` is the policy's own state. */
export interface WarmSlotGlobals<TOp, S> {
  slot: SlotInternals
  activatedAt: Date | null
  totalRequests: number
  totalRecycles: number
  lastRequestAt: Date | null
  warmupResolver: ((ok: boolean) => void) | null
  // Single-flight guard for init(). The public `state` field can read
  // 'initializing' from two paths (recycleSlot pre-set it, or init itself is
  // running) — this flag distinguishes them so concurrent callers don't spawn
  // duplicate subprocesses.
  initInProgress: boolean
  // Set by shutdown() — blocks any further re-init attempts even after the
  // cooldown expires (the process is going away).
  shutdownInitiated: boolean
  // Current operation tracking (for in-progress visibility)
  currentOp: TOp | null
  currentStartedAt: Date | null
  policy: S
}

/** What a policy hook can reach: the slot's globals, its name, and the promise reset. */
export interface SlotContext<S> {
  g: WarmSlotGlobals<unknown, S>
  name: string
  resetResultPromise: () => void
}

/**
 * How concurrent callers share the one subprocess. Every hook is called at the
 * point the two hand-written slots used to differ; see the two implementations
 * below.
 */
export interface SlotPolicy<S> {
  initialState(): S
  /** Whether a query may proceed (and wait) while the slot is `initializing`. */
  acceptsWhileInitializing: boolean
  /**
   * Claim the slot for a caller. Return a promise only if the caller must
   * wait: a synchronous claim must stay synchronous, or a second caller could
   * run in between the claim and the prompt push.
   */
  acquire(ctx: SlotContext<S>): Promise<void> | void
  /** Hand the slot on after a delivered result (the result promise is already reset). */
  release(ctx: SlotContext<S>): void
  /** True if this result belongs to a superseded request and must be dropped. */
  shouldSkipResult(ctx: SlotContext<S>): boolean
  /** The slot's channel was gone when a claimed caller went to push its prompt. */
  onChannelMissing(ctx: SlotContext<S>): void
  /** A fresh subprocess is being started (init or recycle). */
  onFreshSubprocess(ctx: SlotContext<S>): void
  /** The subprocess passed warmup and the slot is available. */
  onWarm(ctx: SlotContext<S>): void
  /** Init threw (not a failed warmup, which leaves waiters for the next init). */
  onInitError(ctx: SlotContext<S>): void
  /** The slot died for good (circuit breaker or shutdown). */
  onKilled(ctx: SlotContext<S>, reason: string): void
}

/** Thrown by `send()` when the slot has no channel to push the prompt into. */
export class SlotChannelMissingError extends Error {}

export interface WarmSlotConfig {
  /** Display name for logs, alerts and errors: "Enrichment" → "Enrichment slot …". */
  name: string
  /** The globalThis key holding this slot's state. */
  globalKey: string
  getModel: () => string
  getMaxReuses: () => number
  maxTurns: number
  /**
   * The system prompt and (optional) output schema are getters, read only when
   * a subprocess starts. quick-take.ts and quick-take-slot.ts import each
   * other, so reading QUICK_TAKE_SYSTEM_PROMPT while the slot module is still
   * being evaluated hits the temporal dead zone in the production bundle.
   */
  getSystemPrompt: () => string
  /** When set, the subprocess answers as JSON matching this schema. */
  getOutputSchema?: () => z.ZodType
  /** Accept or reject the first (warmup) result. */
  validateWarmup: (result: SlotResult) => boolean
}

// --- Policies ---

interface WaitEntry {
  resolve: () => void
  reject: (error: Error) => void
}

export interface FifoQueueState {
  waitQueue: WaitEntry[]
}

/** Reject every queued caller (copy first — timeout callbacks may splice the array). */
function rejectWaiters(state: FifoQueueState, message: string): void {
  const waitersToReject = [...state.waitQueue]
  state.waitQueue.length = 0
  for (const entry of waitersToReject) {
    entry.reject(new Error(message))
  }
}

/**
 * FIFO queue (enrichment). A caller that finds the slot busy — or still
 * initializing, e.g. mid-recycle — waits in line and is woken when the slot
 * frees up. If the slot dies, every waiter is rejected.
 */
export const fifoQueuePolicy: SlotPolicy<FifoQueueState> = {
  initialState: () => ({ waitQueue: [] }),
  acceptsWhileInitializing: true,
  async acquire({ g }) {
    if (g.slot.state === 'available') {
      g.slot.state = 'busy'
      return
    }
    return new Promise<void>((resolve, reject) => {
      g.policy.waitQueue.push({ resolve, reject })
    })
  },
  release({ g }) {
    // Wake the next waiter if any
    if (g.policy.waitQueue.length > 0) {
      const next = g.policy.waitQueue.shift()!
      g.slot.state = 'busy'
      next.resolve()
    } else {
      g.slot.state = 'available'
    }
  },
  shouldSkipResult: () => false,
  // Left as it was: the caller throws and the slot stays busy until recycled.
  onChannelMissing: () => {},
  onFreshSubprocess: () => {},
  onWarm(ctx) {
    // Wake any waiters queued during a previous recycle cycle
    if (ctx.g.policy.waitQueue.length > 0) fifoQueuePolicy.release(ctx)
  },
  onInitError({ g, name }) {
    rejectWaiters(g.policy, `${name} slot init failed`)
  },
  onKilled({ g }, reason) {
    rejectWaiters(g.policy, reason)
  },
}

export interface LatestWinsState {
  // Number of results still to come from superseded requests; each is dropped.
  skipCount: number
  totalSuperseded: number
}

/**
 * Latest wins (quick take). A request that finds the slot busy resolves the
 * in-flight caller with null, takes over the result promise, and bumps
 * skipCount so the consumer drops the superseded answer when it arrives.
 * Dropped results don't count toward reuses. There is no queue, so the slot
 * refuses callers while initializing and a death rejects no one.
 */
export const latestWinsPolicy: SlotPolicy<LatestWinsState> = {
  initialState: () => ({ skipCount: 0, totalSuperseded: 0 }),
  acceptsWhileInitializing: false,
  acquire({ g, name, resetResultPromise }) {
    if (g.slot.state === 'busy') {
      // Latest-wins: supersede the in-flight request
      g.policy.totalSuperseded++
      log.debug('ai', `${name} slot: superseding in-flight request`)
      // Resolve the current caller's promise with null
      g.slot.deliverResult?.(null)
      // Tell the consumer to discard the next result
      g.policy.skipCount++
    } else {
      // Slot is available — claim it
      g.slot.state = 'busy'
    }
    resetResultPromise()
  },
  release({ g }) {
    g.slot.state = 'available'
  },
  shouldSkipResult({ g, name }) {
    if (g.policy.skipCount === 0) return false
    g.policy.skipCount--
    log.debug('ai', `${name} slot: skipped superseded result (${g.policy.skipCount} remaining)`)
    return true
  },
  onChannelMissing({ g }) {
    g.slot.state = 'available'
  },
  onFreshSubprocess({ g }) {
    g.policy.skipCount = 0
  },
  onWarm: () => {},
  onInitError: () => {},
  onKilled: () => {},
}

// --- Factory ---

export interface WarmSlot<TOp, S> {
  /**
   * Start (or restart) the subprocess. Called from instrumentation.ts on
   * startup, from recycleSlot(), and on demand by the wrapper's query to
   * recover from `dead`.
   *
   * Recovery from `dead` is gated by `nextReinitAllowedAt` — repeated failures
   * back off exponentially (see computeReinitBackoff). After shutdown() the
   * slot will not re-init, regardless of cooldown.
   */
  init(): Promise<void>
  getState(): SlotState
  /** Whether a query can go ahead now (the policy decides about `initializing`). */
  isUsable(): boolean
  /**
   * Claim the slot, push the prompt, and wait up to `timeoutMs` for its
   * result (null when superseded or the slot recycled underneath it). Throws
   * SlotChannelMissingError if there was no channel, or a timeout error.
   */
  send(prompt: string, timeoutMs: number, op: TOp): Promise<SlotResult | null>
  getStats(): BaseSlotStats & { currentOperation: (TOp & { startedAt: string }) | null }
  getPolicyState(): S
  /** Graceful shutdown for SIGTERM. */
  shutdown(): void
  /** Reset all slot state for test isolation. */
  resetForTests(): void
}

function freshSlotInternals(): SlotInternals {
  return {
    state: 'uninitialized',
    channel: null,
    generation: 0,
    resultCount: 0,
    resultPromise: null,
    deliverResult: null,
    lastRecycleTime: 0,
    rapidRecycleCount: 0,
    consecutiveInitFailures: 0,
    nextReinitAllowedAt: 0,
  }
}

export function createWarmSlot<TOp, S>(
  config: WarmSlotConfig,
  policy: SlotPolicy<S>,
): WarmSlot<TOp, S> {
  const store = globalThis as unknown as Record<string, WarmSlotGlobals<TOp, S> | undefined>
  if (!store[config.globalKey]) {
    store[config.globalKey] = {
      slot: freshSlotInternals(),
      activatedAt: null,
      totalRequests: 0,
      totalRecycles: 0,
      lastRequestAt: null,
      warmupResolver: null,
      initInProgress: false,
      shutdownInitiated: false,
      currentOp: null,
      currentStartedAt: null,
      policy: policy.initialState(),
    }
  }
  const g = store[config.globalKey]!

  const rt: Runtime<TOp, S> = {
    config,
    policy,
    g,
    label: `${config.name} slot`,
    ctx: {
      g: g as WarmSlotGlobals<unknown, S>,
      name: config.name,
      resetResultPromise: () => resetResultPromise(g),
    },
  }

  return {
    init: () => init(rt),
    getState: () => g.slot.state,
    isUsable: () => isUsable(rt),
    send: (prompt, timeoutMs, op) => send(rt, prompt, timeoutMs, op),
    getStats: () => getStats(rt),
    getPolicyState: () => g.policy,
    shutdown: () => shutdown(rt),
    resetForTests: () => resetForTests(rt),
  }
}

// --- Engine ---
//
// Module-level functions over one slot's runtime (its config, policy and
// globals), so the factory above stays a small wiring function.

interface Runtime<TOp, S> {
  config: WarmSlotConfig
  policy: SlotPolicy<S>
  g: WarmSlotGlobals<TOp, S>
  ctx: SlotContext<S>
  /** "Enrichment slot" / "Quick Take slot", for logs and alerts. */
  label: string
}

function resetResultPromise(g: { slot: SlotInternals }): void {
  g.slot.resultPromise = new Promise<SlotResult | null>((resolve) => {
    g.slot.deliverResult = resolve
  })
}

function closeChannel<TOp, S>({ g, config }: Runtime<TOp, S>): void {
  try {
    g.slot.channel?.close()
  } catch (err) {
    log.debug('ai', `${config.name} channel close failed (subprocess may already be dead):`, err)
  }
  g.slot.channel = null
  g.slot.resultPromise = null
  g.slot.deliverResult = null
}

function buildQueryOptions(config: WarmSlotConfig): Options {
  const outputSchema = config.getOutputSchema?.()
  return {
    model: config.getModel(),
    maxTurns: config.maxTurns,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    persistSession: false,
    systemPrompt: config.getSystemPrompt(),
    ...(outputSchema && {
      outputFormat: {
        type: 'json_schema',
        schema: toCliJsonSchema(z.toJSONSchema(outputSchema)),
      },
    }),
    ...(process.env.OPENTASK_AI_CLI_PATH && {
      pathToClaudeCodeExecutable: process.env.OPENTASK_AI_CLI_PATH,
    }),
  }
}

async function init<TOp, S>(rt: Runtime<TOp, S>): Promise<void> {
  const { g, policy, ctx, label, config } = rt

  // Single-flight: another caller is already running init. The state field
  // alone can't tell us this — recycleSlot() pre-sets state='initializing'
  // before scheduling init, so we use an explicit flag instead.
  if (g.initInProgress) return

  // Already healthy
  if (g.slot.state === 'available' || g.slot.state === 'busy') return

  // Process is shutting down — never spawn a new subprocess
  if (g.shutdownInitiated) return

  // Dead state: respect cooldown so failed inits don't thrash the SDK
  if (g.slot.state === 'dead' && Date.now() < g.slot.nextReinitAllowedAt) return

  g.initInProgress = true
  try {
    g.slot.state = 'initializing'
    g.slot.resultCount = 0
    policy.onFreshSubprocess(ctx)

    const channel = createMessageChannel()
    g.slot.channel = channel

    channel.push(WARMUP_MESSAGE)
    log.debug('ai', `${label}: warmup sent`)

    const { query } = await import('@anthropic-ai/claude-agent-sdk')
    const queryOptions = buildQueryOptions(config)

    resetResultPromise(g)

    // Start the background consumer
    const stream = query({ prompt: channel.iterable, options: queryOptions })
    consumeStream(rt, stream)

    // Wait for warmup validation
    let warmupTimer: ReturnType<typeof setTimeout> | undefined
    const warmupOk = await Promise.race([
      new Promise<boolean>((resolve) => {
        g.warmupResolver = resolve
      }),
      new Promise<boolean>((resolve) => {
        warmupTimer = setTimeout(() => {
          log.error('ai', `${label} warmup timed out after ${WARMUP_TIMEOUT_MS}ms`)
          resolve(false)
        }, WARMUP_TIMEOUT_MS)
      }),
    ])
    clearTimeout(warmupTimer)

    if (!warmupOk) {
      markInitFailure(rt, 'warmup validation failed', null)
      return
    }

    // Check if something killed the slot during warmup (e.g. SIGTERM during await)
    if ((g.slot.state as SlotState) === 'dead') return

    g.slot.state = 'available'
    g.slot.consecutiveInitFailures = 0
    g.slot.nextReinitAllowedAt = 0
    g.activatedAt = new Date()
    log.info(
      'ai',
      `${label} warm (model: ${config.getModel()}, max reuses: ${config.getMaxReuses()})`,
    )

    policy.onWarm(ctx)
  } catch (err) {
    markInitFailure(rt, 'init failed', err)
    policy.onInitError(ctx)
  } finally {
    g.initInProgress = false
  }
}

/**
 * Record a failed init/warmup: increment failure count, schedule the next
 * allowed re-init attempt, mark the slot dead, and notify.
 *
 * Both slots alert. Quick take falls back to a cold query when its slot is
 * dead, so the user still gets a result — but every quick take then pays
 * the cold-start latency until it recovers, and the cause (rate limit,
 * broken CLI) usually hits enrichment next. Both use the `slot-failure`
 * category, so they share one rate limit in error-notify.
 */
function markInitFailure<TOp, S>(
  { g, label }: Runtime<TOp, S>,
  reason: string,
  err: unknown,
): void {
  g.slot.consecutiveInitFailures++
  const backoffMs = computeReinitBackoff(g.slot.consecutiveInitFailures)
  g.slot.nextReinitAllowedAt = Date.now() + backoffMs
  g.slot.state = 'dead'
  log.error(
    'ai',
    `${label} ${reason} (attempt ${g.slot.consecutiveInitFailures}, next attempt in ${Math.round(backoffMs / 1000)}s):`,
    err,
  )
  notifyError(
    'slot-failure',
    `${label} ${reason}`,
    err instanceof Error ? err.message : String(err ?? reason),
  )
}

function isUsable<TOp, S>({ g, policy }: Runtime<TOp, S>): boolean {
  const state = g.slot.state
  if (state === 'dead' || state === 'uninitialized') return false
  return state !== 'initializing' || policy.acceptsWhileInitializing
}

async function send<TOp, S>(
  rt: Runtime<TOp, S>,
  prompt: string,
  timeoutMs: number,
  op: TOp,
): Promise<SlotResult | null> {
  const { g, policy, ctx, label, config } = rt
  // A synchronous claim must stay synchronous (see SlotPolicy.acquire).
  const claim = policy.acquire(ctx)
  if (claim) await claim

  g.currentOp = op
  g.currentStartedAt = new Date()

  let queryTimer: ReturnType<typeof setTimeout> | undefined
  try {
    if (!g.slot.channel) {
      log.warn('ai', `${label} channel null when attempting to push prompt`)
      policy.onChannelMissing(ctx)
      throw new SlotChannelMissingError(`${label} channel is null`)
    }
    g.slot.channel.push(prompt)

    // Wait for the result with a timeout
    const result = await Promise.race([
      g.slot.resultPromise,
      new Promise<null>((_, reject) => {
        queryTimer = setTimeout(
          () => reject(new Error(`${config.name} query timed out after ${timeoutMs}ms`)),
          timeoutMs,
        )
      }),
    ])

    g.totalRequests++
    g.lastRequestAt = new Date()
    return result
  } finally {
    clearTimeout(queryTimer)
    g.currentOp = null
    g.currentStartedAt = null
  }
}

/** Pull the text and structured output out of an SDK `result` message. */
function parseResultMessage(message: { subtype?: string }): SlotResult {
  const result: SlotResult = { structuredOutput: null, text: null }
  if (message.subtype !== 'success') return result
  const success = message as SDKResultSuccess
  if (success.structured_output) {
    result.structuredOutput = success.structured_output as Record<string, unknown>
  }
  if (success.result != null && success.result !== '') {
    result.text = success.result
  }
  return result
}

/**
 * Background consumer loop.
 *
 * First result = warmup validation. Later results go to the caller, unless
 * the policy drops them (superseded requests), in which case they don't
 * count toward reuses. After getMaxReuses() delivered results: recycle.
 * A consumer from an older generation (the slot recycled or shut down under
 * it) stops without touching the current subprocess's state.
 */
async function consumeStream<TOp, S>(
  rt: Runtime<TOp, S>,
  stream: AsyncIterable<unknown>,
): Promise<void> {
  const { g, policy, ctx, label, config } = rt
  const myGeneration = g.slot.generation
  const iterator = stream[Symbol.asyncIterator]()
  try {
    let resultCount = 0
    let iterResult: IteratorResult<unknown>
    while (!(iterResult = await iterator.next()).done) {
      const message = iterResult.value as { type: string; subtype?: string }
      if (message.type !== 'result') continue
      resultCount++
      const result = parseResultMessage(message)

      if (resultCount === 1) {
        // Warmup result
        const warmupOk = config.validateWarmup(result)
        log.debug(
          'ai',
          `${label}: warmup ${warmupOk ? 'OK' : 'FAILED'} (text: ${result.text?.slice(0, 50)}, structured: ${result.structuredOutput ? Object.keys(result.structuredOutput).join(',') : 'none'})`,
        )
        g.warmupResolver?.(warmupOk)
        g.warmupResolver = null
        if (!warmupOk) break
        continue
      }

      // Stale consumer guard
      if (g.slot.generation !== myGeneration) return

      if (policy.shouldSkipResult(ctx)) continue

      // Deliver the result to the caller
      g.slot.resultCount++
      g.slot.deliverResult?.(result)

      // Check the reuse limit
      if (g.slot.state === 'dead') break
      if (g.slot.resultCount >= config.getMaxReuses()) {
        log.debug('ai', `${label} reached max reuses (${config.getMaxReuses()}), recycling`)
        break
      }

      // Reuse: reset the promise and release for the next request
      resetResultPromise(g)
      policy.release(ctx)
    }
  } catch (err) {
    if (g.slot.generation !== myGeneration) return
    log.error('ai', `${label} stream error:`, err)
    g.slot.deliverResult?.(null)
    g.warmupResolver?.(false)
    g.warmupResolver = null
  } finally {
    if (g.slot.generation !== myGeneration) {
      await iterator.return?.()
    } else {
      recycleSlot(rt)
    }
  }
}

/**
 * Recycle the slot: close the old channel, reinitialize.
 * Circuit breaker: 5 recycles in 5 seconds = dead.
 */
function recycleSlot<TOp, S>(rt: Runtime<TOp, S>): void {
  const { g, policy, ctx, label } = rt
  if (g.slot.state === 'dead') return

  g.totalRecycles++

  // Circuit breaker: detect rapid consecutive recycles
  const cb = checkCircuitBreaker(g.slot.lastRecycleTime, g.slot.rapidRecycleCount)
  g.slot.rapidRecycleCount = cb.newCount
  g.slot.lastRecycleTime = cb.newTime

  if (cb.tripped) {
    // Seed the failure counter so auto-recovery starts at a real cooldown.
    // Rapid recycles mean something is genuinely broken; the first attempt
    // should wait at least computeReinitBackoff(CIRCUIT_BREAKER_INITIAL_FAILURES).
    g.slot.consecutiveInitFailures = Math.max(
      g.slot.consecutiveInitFailures,
      CIRCUIT_BREAKER_INITIAL_FAILURES,
    )
    const backoffMs = computeReinitBackoff(g.slot.consecutiveInitFailures)
    g.slot.nextReinitAllowedAt = Date.now() + backoffMs

    log.error(
      'ai',
      `${label} recycled ${cb.newCount} times rapidly — marking dead ` +
        `(circuit breaker, next attempt in ${Math.round(backoffMs / 1000)}s)`,
    )
    notifyError(
      'slot-failure',
      `${label} died (circuit breaker)`,
      `Recycled ${cb.newCount} times rapidly`,
    )
    g.slot.generation++
    g.slot.deliverResult?.(null)
    g.slot.state = 'dead'
    closeChannel(rt)
    policy.onKilled(ctx, `${label} died (circuit breaker)`)
    return
  }

  // Normal recycle: close old, reinit
  g.slot.generation++
  g.slot.deliverResult?.(null)
  closeChannel(rt)
  g.slot.resultCount = 0
  policy.onFreshSubprocess(ctx)
  g.slot.state = 'initializing'

  // A FIFO policy's waiters stay queued — they're woken after reinit completes
  log.info('ai', `${label} recycling...`)
  setTimeout(() => {
    init(rt).catch((err) => {
      log.error('ai', `${label} recycle init failed:`, err)
    })
  }, 0)
}

function getStats<TOp, S>({ g, config }: Runtime<TOp, S>) {
  const op = g.currentOp
  return {
    state: g.slot.state,
    activatedAt: g.activatedAt?.toISOString() ?? null,
    totalRequests: g.totalRequests,
    totalRecycles: g.totalRecycles,
    lastRequestAt: g.lastRequestAt?.toISOString() ?? null,
    model: config.getModel(),
    currentOperation:
      g.slot.state === 'busy' && g.currentStartedAt && op
        ? { ...op, startedAt: g.currentStartedAt.toISOString() }
        : null,
  }
}

function shutdown<TOp, S>(rt: Runtime<TOp, S>): void {
  const { g, policy, ctx, label } = rt
  log.info('ai', `${label}: shutting down`)
  g.shutdownInitiated = true
  g.slot.generation++
  g.slot.deliverResult?.(null)
  g.warmupResolver?.(false)
  g.warmupResolver = null
  g.slot.state = 'dead'
  closeChannel(rt)
  policy.onKilled(ctx, `${label} shutting down`)
}

function resetForTests<TOp, S>({ g, policy }: Runtime<TOp, S>): void {
  try {
    g.slot.channel?.close()
  } catch {
    // Ignore
  }
  g.slot = freshSlotInternals()
  g.activatedAt = null
  g.totalRequests = 0
  g.totalRecycles = 0
  g.lastRequestAt = null
  g.warmupResolver = null
  g.initInProgress = false
  g.shutdownInitiated = false
  g.currentOp = null
  g.currentStartedAt = null
  g.policy = policy.initialState()
}
