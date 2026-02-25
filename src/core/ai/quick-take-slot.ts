/**
 * Warm quick take slot
 *
 * Keeps a dedicated Claude Code subprocess warm for quick take queries.
 * Unlike the enrichment slot (FIFO queue), this uses latest-wins cancellation:
 * only the most recent quick take matters, so new requests supersede in-flight ones.
 *
 * Adapted from enrichment-slot.ts with structural differences:
 * - Concurrency: latest-wins (skipCount) instead of FIFO queue
 * - Output: plain text (no JSON schema)
 * - Lower max reuses (4 vs 8) since quick takes are less frequent
 */

import { log } from '@/lib/logger'
import { logAIActivity } from './activity'
import { createMessageChannel, type MessageChannel } from './message-channel'
import { QUICK_TAKE_SYSTEM_PROMPT } from './quick-take'
import type { Options, SDKResultSuccess } from '@anthropic-ai/claude-agent-sdk'

// --- Configuration ---

const DEFAULT_MAX_REUSES = 4
const RAPID_RECYCLE_WINDOW_MS = 5_000
const RAPID_RECYCLE_LIMIT = 5
const DEFAULT_QUERY_TIMEOUT_MS = 30_000

function getMaxReuses(): number {
  return parseInt(process.env.OPENTASK_AI_QUICKTAKE_MAX_REUSES || String(DEFAULT_MAX_REUSES), 10)
}

function getModel(): string {
  return process.env.OPENTASK_AI_QUICKTAKE_MODEL || 'sonnet'
}

function getQueryTimeout(): number {
  return parseInt(
    process.env.OPENTASK_AI_QUICKTAKE_TIMEOUT_MS || String(DEFAULT_QUERY_TIMEOUT_MS),
    10,
  )
}

// --- Slot state ---
//
// All mutable state on globalThis to survive module duplication (same reason
// as enrichment-slot.ts — Turbopack may create separate module scopes).

type SlotState = 'uninitialized' | 'initializing' | 'available' | 'busy' | 'dead'

interface SlotInternals {
  state: SlotState
  channel: MessageChannel | null
  generation: number
  resultCount: number
  resultPromise: Promise<string | null> | null
  deliverResult: ((result: string | null) => void) | null
  // Latest-wins: number of results to skip (from superseded requests)
  skipCount: number
  // Circuit breaker
  lastRecycleTime: number
  rapidRecycleCount: number
}

interface SlotStats {
  state: SlotState
  activatedAt: string | null
  totalRequests: number
  totalRecycles: number
  totalSuperseded: number
  lastRequestAt: string | null
  model: string
}

interface QuickTakeSlotGlobals {
  slot: SlotInternals
  activatedAt: Date | null
  totalRequests: number
  totalRecycles: number
  totalSuperseded: number
  lastRequestAt: Date | null
  warmupResolver: ((ok: boolean) => void) | null
}

const globalForSlot = globalThis as typeof globalThis & {
  __quickTakeSlotState?: QuickTakeSlotGlobals
}

if (!globalForSlot.__quickTakeSlotState) {
  globalForSlot.__quickTakeSlotState = {
    slot: {
      state: 'uninitialized',
      channel: null,
      generation: 0,
      resultCount: 0,
      resultPromise: null,
      deliverResult: null,
      skipCount: 0,
      lastRecycleTime: 0,
      rapidRecycleCount: 0,
    },
    activatedAt: null,
    totalRequests: 0,
    totalRecycles: 0,
    totalSuperseded: 0,
    lastRequestAt: null,
    warmupResolver: null,
  }
}

const g = globalForSlot.__quickTakeSlotState!

const WARMUP_MESSAGE = 'Respond with exactly: READY'

function validateWarmup(text: string | null): boolean {
  if (!text) return false
  return text.includes('READY')
}

// --- Core functions ---

/**
 * Initialize the quick take slot. Called from instrumentation.ts on startup.
 */
export async function initQuickTakeSlot(): Promise<void> {
  if (g.slot.state === 'available' || g.slot.state === 'busy') {
    log.warn('ai', 'Quick Take slot already initialized')
    return
  }

  try {
    g.slot.state = 'initializing'
    g.slot.resultCount = 0
    g.slot.skipCount = 0

    const channel = createMessageChannel()
    g.slot.channel = channel

    channel.push(WARMUP_MESSAGE)
    log.debug('ai', 'Quick Take slot: warmup sent')

    const { query } = await import('@anthropic-ai/claude-agent-sdk')

    const queryOptions: Options = {
      model: getModel(),
      maxTurns: 15,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      persistSession: false,
      systemPrompt: QUICK_TAKE_SYSTEM_PROMPT,
      ...(process.env.OPENTASK_AI_CLI_PATH && {
        pathToClaudeCodeExecutable: process.env.OPENTASK_AI_CLI_PATH,
      }),
    }

    resetResultPromise()

    const stream = query({ prompt: channel.iterable, options: queryOptions })
    consumeStream(stream)

    const warmupOk = await new Promise<boolean>((resolve) => {
      g.warmupResolver = resolve
    })

    if (!warmupOk) {
      log.error('ai', 'Quick Take slot: warmup validation failed')
      g.slot.state = 'dead'
      return
    }

    // Check if something killed the slot during warmup (e.g. SIGTERM during await)
    if ((g.slot.state as SlotState) === 'dead') return

    g.slot.state = 'available'
    g.activatedAt = new Date()
    log.info('ai', `Quick Take slot warm (model: ${getModel()}, max reuses: ${getMaxReuses()})`)
  } catch (err) {
    g.slot.state = 'dead'
    log.error('ai', 'Quick Take slot init failed:', err)
  }
}

/**
 * Send a quick take query through the warm slot.
 *
 * Latest-wins concurrency: if the slot is busy, the in-flight caller's promise
 * is resolved with null and the new request supersedes it.
 *
 * Returns null if the slot is dead/uninitialized/initializing.
 */
export async function quickTakeSlotQuery(
  prompt: string,
  options?: { userId?: number; inputText?: string; timeoutMs?: number },
): Promise<{ text: string | null; durationMs: number } | null> {
  // If slot is not usable, signal caller to fall back to cold path
  if (
    g.slot.state === 'dead' ||
    g.slot.state === 'uninitialized' ||
    g.slot.state === 'initializing'
  ) {
    return null
  }

  const startTime = Date.now()
  const timeoutMs = options?.timeoutMs ?? getQueryTimeout()

  if (g.slot.state === 'busy') {
    // Latest-wins: supersede the in-flight request
    g.totalSuperseded++
    log.debug('ai', 'Quick Take slot: superseding in-flight request')

    // Resolve current caller's promise with null
    g.slot.deliverResult?.(null)

    // Tell consumeStream to discard the next result
    g.slot.skipCount++

    // Reset for new caller
    resetResultPromise()
  } else {
    // Slot is available — claim it
    g.slot.state = 'busy'
    resetResultPromise()
  }

  // Push the prompt
  g.slot.channel!.push(prompt)

  try {
    // Wait for result with timeout
    const text = await Promise.race([
      g.slot.resultPromise,
      new Promise<null>((_, reject) => {
        setTimeout(
          () => reject(new Error(`Quick Take query timed out after ${timeoutMs}ms`)),
          timeoutMs,
        )
      }),
    ])

    const durationMs = Date.now() - startTime

    g.totalRequests++
    g.lastRequestAt = new Date()

    // Log activity
    if (options?.userId) {
      logAIActivity({
        user_id: options.userId,
        task_id: null,
        action: 'quick_take',
        status: text ? 'success' : 'error',
        input: options.inputText ?? null,
        output: text,
        model: getModel(),
        duration_ms: durationMs,
        error: text ? null : 'No output from Quick Take slot',
      })
    }

    log.info('ai', `Quick Take slot query completed in ${durationMs}ms`)

    return { text, durationMs }
  } catch (err) {
    const durationMs = Date.now() - startTime

    if (options?.userId) {
      logAIActivity({
        user_id: options.userId,
        task_id: null,
        action: 'quick_take',
        status: 'error',
        input: options.inputText ?? null,
        output: null,
        model: getModel(),
        duration_ms: durationMs,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    log.error('ai', `Quick Take slot query failed after ${durationMs}ms:`, err)
    return { text: null, durationMs }
  }
}

/** Get quick take slot statistics for observability. */
export function getQuickTakeSlotStats(): SlotStats {
  return {
    state: g.slot.state,
    activatedAt: g.activatedAt?.toISOString() ?? null,
    totalRequests: g.totalRequests,
    totalRecycles: g.totalRecycles,
    totalSuperseded: g.totalSuperseded,
    lastRequestAt: g.lastRequestAt?.toISOString() ?? null,
    model: getModel(),
  }
}

/** Graceful shutdown for SIGTERM. */
export function shutdownQuickTakeSlot(): void {
  log.info('ai', 'Quick Take slot: shutting down')
  g.slot.generation++
  g.slot.deliverResult?.(null)
  g.slot.state = 'dead'
  try {
    g.slot.channel?.close()
  } catch {
    // Ignore close errors during shutdown
  }
  g.slot.channel = null
  g.slot.resultPromise = null
  g.slot.deliverResult = null
}

// --- Internal helpers ---

function resetResultPromise(): void {
  g.slot.resultPromise = new Promise<string | null>((resolve) => {
    g.slot.deliverResult = resolve
  })
}

/**
 * Background consumer loop.
 *
 * First result = warmup validation. Subsequent results delivered to callers.
 * Skipped results (from superseded requests) decrement skipCount and don't
 * count toward reuses. After MAX_REUSES delivered results: recycle.
 */
async function consumeStream(stream: AsyncIterable<unknown>): Promise<void> {
  const myGeneration = g.slot.generation
  const iterator = stream[Symbol.asyncIterator]()
  try {
    let resultCount = 0
    let iterResult: IteratorResult<unknown>
    while (!(iterResult = await iterator.next()).done) {
      const message = iterResult.value as { type: string; subtype?: string } & Record<
        string,
        unknown
      >

      if (message.type === 'result') {
        resultCount++

        let text: string | null = null

        if (message.subtype === 'success') {
          const result = message as SDKResultSuccess
          if (result.result != null && result.result !== '') {
            text = result.result
          }
        }

        if (resultCount === 1) {
          // Warmup result
          const warmupOk = validateWarmup(text)
          log.debug(
            'ai',
            `Quick Take slot: warmup ${warmupOk ? 'OK' : 'FAILED'} (text: ${text?.slice(0, 50)})`,
          )
          g.warmupResolver?.(warmupOk)
          g.warmupResolver = null
          if (!warmupOk) break
          continue
        }

        // Stale consumer guard
        if (g.slot.generation !== myGeneration) return

        // Check if this result should be skipped (superseded request)
        if (g.slot.skipCount > 0) {
          g.slot.skipCount--
          log.debug(
            'ai',
            `Quick Take slot: skipped superseded result (${g.slot.skipCount} remaining)`,
          )
          continue
        }

        // Deliver result to caller
        g.slot.resultCount++
        g.slot.deliverResult?.(text)

        // Check reuse limit
        if (g.slot.state === 'dead') break
        if (g.slot.resultCount >= getMaxReuses()) {
          log.debug('ai', `Quick Take slot reached max reuses (${getMaxReuses()}), recycling`)
          break
        }

        // Reuse: reset promise and mark available for next request
        resetResultPromise()
        g.slot.state = 'available'
      }
    }
  } catch (err) {
    if (g.slot.generation !== myGeneration) return
    log.error('ai', 'Quick Take slot stream error:', err)
    g.slot.deliverResult?.(null)
    g.warmupResolver?.(false)
    g.warmupResolver = null
  } finally {
    if (g.slot.generation !== myGeneration) {
      await iterator.return?.()
      return
    }
    recycleSlot()
  }
}

/**
 * Recycle the slot: close old channel, reinitialize.
 * Circuit breaker: 5 recycles in 5 seconds = dead.
 */
function recycleSlot(): void {
  if (g.slot.state === 'dead') return

  g.totalRecycles++

  // Circuit breaker: detect rapid consecutive recycles
  const now = Date.now()
  if (now - g.slot.lastRecycleTime < RAPID_RECYCLE_WINDOW_MS) {
    g.slot.rapidRecycleCount++
  } else {
    g.slot.rapidRecycleCount = 1
  }
  g.slot.lastRecycleTime = now

  if (g.slot.rapidRecycleCount >= RAPID_RECYCLE_LIMIT) {
    log.error(
      'ai',
      `Quick Take slot recycled ${g.slot.rapidRecycleCount} times in <${RAPID_RECYCLE_WINDOW_MS}ms — marking dead (circuit breaker)`,
    )
    g.slot.generation++
    g.slot.state = 'dead'
    try {
      g.slot.channel?.close()
    } catch {
      // Ignore
    }
    g.slot.channel = null
    g.slot.resultPromise = null
    g.slot.deliverResult = null
    return
  }

  // Normal recycle: close old, reinit
  g.slot.generation++
  try {
    g.slot.channel?.close()
  } catch {
    // Ignore
  }
  g.slot.channel = null
  g.slot.resultPromise = null
  g.slot.deliverResult = null
  g.slot.resultCount = 0
  g.slot.skipCount = 0
  g.slot.state = 'initializing'

  log.info('ai', 'Quick Take slot recycling...')
  setTimeout(() => {
    initQuickTakeSlot().catch((err) => {
      log.error('ai', 'Quick Take slot recycle init failed:', err)
    })
  }, 0)
}
