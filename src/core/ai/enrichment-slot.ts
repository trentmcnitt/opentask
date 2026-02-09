/**
 * Warm enrichment slot
 *
 * Keeps a dedicated Claude Code subprocess warm for enrichment queries.
 * Reuses the subprocess across requests via the MessageChannel pattern,
 * eliminating cold-start latency for the most frequent AI operation.
 *
 * Adapted from bespoke-ai-vscode-ext's SlotPool + CommandPool pattern,
 * simplified to module-level functions (not a class) with a single slot.
 */

import { log } from '@/lib/logger'
import { logAIActivity } from './activity'
import { createMessageChannel, type MessageChannel } from './message-channel'
import { ENRICHMENT_SYSTEM_PROMPT } from './prompts'
import { EnrichmentResultSchema } from './types'
import { z } from 'zod'
import type { Options, SDKResultSuccess } from '@anthropic-ai/claude-agent-sdk'

// --- Configuration ---

const DEFAULT_MAX_REUSES = 8
const RAPID_RECYCLE_WINDOW_MS = 5_000
const RAPID_RECYCLE_LIMIT = 5
const DEFAULT_QUERY_TIMEOUT_MS = 60_000

function getMaxReuses(): number {
  return parseInt(process.env.OPENTASK_AI_MAX_REUSES || String(DEFAULT_MAX_REUSES), 10)
}

function getModel(): string {
  return process.env.OPENTASK_AI_ENRICHMENT_MODEL || 'haiku'
}

function getQueryTimeout(): number {
  return parseInt(process.env.OPENTASK_AI_QUERY_TIMEOUT_MS || String(DEFAULT_QUERY_TIMEOUT_MS), 10)
}

// --- Slot state ---

type SlotState = 'uninitialized' | 'initializing' | 'available' | 'busy' | 'dead'

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
}

interface SlotResult {
  structuredOutput: Record<string, unknown> | null
  text: string | null
}

const slot: SlotInternals = {
  state: 'uninitialized',
  channel: null,
  generation: 0,
  resultCount: 0,
  resultPromise: null,
  deliverResult: null,
  lastRecycleTime: 0,
  rapidRecycleCount: 0,
}

// --- Stats ---

interface SlotStats {
  state: SlotState
  activatedAt: string | null
  totalRequests: number
  totalRecycles: number
  lastRequestAt: string | null
  model: string
}

let activatedAt: Date | null = null
let totalRequests = 0
let totalRecycles = 0
let lastRequestAt: Date | null = null

// --- FIFO wait queue ---

interface WaitEntry {
  resolve: () => void
  reject: (error: Error) => void
}

const waitQueue: WaitEntry[] = []

// --- Warmup ---

let warmupResolver: ((ok: boolean) => void) | null = null

const WARMUP_MESSAGE = 'Respond with exactly: READY'

function validateWarmup(text: string | null): boolean {
  if (!text) return false
  return text.includes('READY')
}

// --- Core functions ---

/**
 * Initialize the enrichment slot. Called from instrumentation.ts on startup.
 * Loads the SDK, creates a MessageChannel, starts the subprocess, and
 * waits for warmup validation.
 */
export async function initEnrichmentSlot(): Promise<void> {
  if (slot.state === 'available' || slot.state === 'busy') {
    log.warn('ai', 'Enrichment slot already initialized')
    return
  }

  try {
    slot.state = 'initializing'
    slot.resultCount = 0

    const channel = createMessageChannel()
    slot.channel = channel

    // Push warmup message
    channel.push(WARMUP_MESSAGE)
    log.debug('ai', 'Enrichment slot: warmup sent')

    const { query } = await import('@anthropic-ai/claude-agent-sdk')

    const jsonSchema = z.toJSONSchema(EnrichmentResultSchema)

    const queryOptions: Options = {
      model: getModel(),
      maxTurns: 50,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      persistSession: false,
      systemPrompt: ENRICHMENT_SYSTEM_PROMPT,
      outputFormat: {
        type: 'json_schema',
        schema: jsonSchema,
      },
      ...(process.env.OPENTASK_AI_CLI_PATH && {
        pathToClaudeCodeExecutable: process.env.OPENTASK_AI_CLI_PATH,
      }),
    }

    // Reset the result promise
    resetResultPromise()

    // Start background consumer
    const stream = query({ prompt: channel.iterable, options: queryOptions })
    consumeStream(stream)

    // Wait for warmup validation
    const warmupOk = await new Promise<boolean>((resolve) => {
      warmupResolver = resolve
    })

    if (!warmupOk) {
      log.error('ai', 'Enrichment slot: warmup validation failed')
      slot.state = 'dead'
      return
    }

    // Check if something killed the slot during warmup (e.g. SIGTERM during await)
    if ((slot.state as SlotState) === 'dead') return

    slot.state = 'available'
    activatedAt = new Date()
    log.info('ai', `Enrichment slot warm (model: ${getModel()}, max reuses: ${getMaxReuses()})`)
  } catch (err) {
    slot.state = 'dead'
    log.error('ai', 'Enrichment slot init failed:', err)
  }
}

/**
 * Send an enrichment query through the warm slot.
 *
 * If the slot is busy, the caller waits in a FIFO queue. Returns structured
 * output and timing information. The slot is automatically released after
 * the result is delivered.
 */
export async function enrichmentQuery(
  prompt: string,
  options?: { userId?: number; taskId?: number; inputText?: string; timeoutMs?: number },
): Promise<{
  structuredOutput: Record<string, unknown> | null
  text: string | null
  durationMs: number
}> {
  const startTime = Date.now()
  const timeoutMs = options?.timeoutMs ?? getQueryTimeout()

  // If slot is dead, fall back to per-query subprocess
  if (slot.state === 'dead' || slot.state === 'uninitialized') {
    throw new Error(`Enrichment slot is ${slot.state} — cannot process query`)
  }

  // Acquire the slot (wait in FIFO if busy)
  await acquireSlot()

  try {
    // Push the prompt to the warm subprocess
    slot.channel!.push(prompt)

    // Wait for result with timeout
    const result = await Promise.race([
      slot.resultPromise,
      new Promise<null>((_, reject) => {
        setTimeout(
          () => reject(new Error(`Enrichment query timed out after ${timeoutMs}ms`)),
          timeoutMs,
        )
      }),
    ])

    const durationMs = Date.now() - startTime

    totalRequests++
    lastRequestAt = new Date()

    // Log activity
    if (options?.userId) {
      logAIActivity({
        user_id: options.userId,
        task_id: options.taskId ?? null,
        action: 'enrich',
        status: result ? 'success' : 'error',
        input: options.inputText ?? null,
        output: result?.structuredOutput
          ? JSON.stringify(result.structuredOutput)
          : (result?.text ?? null),
        model: getModel(),
        duration_ms: durationMs,
        error: result ? null : 'No output from enrichment slot',
      })
    }

    log.info('ai', `Enrichment slot query completed in ${durationMs}ms`)

    return {
      structuredOutput: result?.structuredOutput ?? null,
      text: result?.text ?? null,
      durationMs,
    }
  } catch (err) {
    const durationMs = Date.now() - startTime

    if (options?.userId) {
      logAIActivity({
        user_id: options.userId,
        task_id: options.taskId ?? null,
        action: 'enrich',
        status: 'error',
        input: options.inputText ?? null,
        output: null,
        model: getModel(),
        duration_ms: durationMs,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    log.error('ai', `Enrichment slot query failed after ${durationMs}ms:`, err)
    throw err
  }
}

/** Get enrichment slot statistics for observability. */
export function getEnrichmentSlotStats(): SlotStats {
  return {
    state: slot.state,
    activatedAt: activatedAt?.toISOString() ?? null,
    totalRequests,
    totalRecycles,
    lastRequestAt: lastRequestAt?.toISOString() ?? null,
    model: getModel(),
  }
}

/** Graceful shutdown for SIGTERM. */
export function shutdownEnrichmentSlot(): void {
  log.info('ai', 'Enrichment slot: shutting down')
  slot.generation++
  slot.deliverResult?.(null)
  slot.state = 'dead'
  try {
    slot.channel?.close()
  } catch {
    // Ignore close errors during shutdown
  }
  slot.channel = null
  slot.resultPromise = null
  slot.deliverResult = null

  // Reject all waiters
  for (const entry of waitQueue) {
    entry.reject(new Error('Enrichment slot shutting down'))
  }
  waitQueue.length = 0
}

// --- Internal helpers ---

function resetResultPromise(): void {
  slot.resultPromise = new Promise<SlotResult | null>((resolve) => {
    slot.deliverResult = resolve
  })
}

async function acquireSlot(): Promise<void> {
  if (slot.state === 'available') {
    slot.state = 'busy'
    return
  }

  // Wait in FIFO queue
  return new Promise<void>((resolve, reject) => {
    waitQueue.push({ resolve, reject })
  })
}

function releaseSlot(): void {
  // Wake the next waiter if any
  if (waitQueue.length > 0) {
    const next = waitQueue.shift()!
    slot.state = 'busy'
    next.resolve()
  } else {
    slot.state = 'available'
  }
}

/**
 * Background consumer loop.
 *
 * First result = warmup validation. Subsequent results delivered to callers.
 * After MAX_REUSES: recycle. Stale consumer safety via generation counter.
 */
async function consumeStream(stream: AsyncIterable<unknown>): Promise<void> {
  const myGeneration = slot.generation
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const iterator = (stream as AsyncIterable<any>)[Symbol.asyncIterator]()
  try {
    let resultCount = 0
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let iterResult: IteratorResult<any>
    while (!(iterResult = await iterator.next()).done) {
      const message = iterResult.value

      if (message.type === 'result') {
        resultCount++

        let structuredOutput: Record<string, unknown> | null = null
        let text: string | null = null

        if (message.subtype === 'success') {
          const result = message as SDKResultSuccess
          if (result.structured_output) {
            structuredOutput = result.structured_output as Record<string, unknown>
          }
          if (result.result != null && result.result !== '') {
            text = result.result
          }
        }

        if (resultCount === 1) {
          // Warmup result
          const warmupOk = validateWarmup(text)
          log.debug(
            'ai',
            `Enrichment slot: warmup ${warmupOk ? 'OK' : 'FAILED'} (text: ${text?.slice(0, 50)})`,
          )
          warmupResolver?.(warmupOk)
          warmupResolver = null
          if (!warmupOk) break
          continue
        }

        // Stale consumer guard
        if (slot.generation !== myGeneration) return

        // Deliver real result to caller
        slot.resultCount++
        slot.deliverResult?.({ structuredOutput, text })

        // Check reuse limit
        if (slot.state === 'dead') break
        if (slot.resultCount >= getMaxReuses()) {
          log.debug('ai', `Enrichment slot reached max reuses (${getMaxReuses()}), recycling`)
          break
        }

        // Reuse: reset promise and release for next request
        resetResultPromise()
        releaseSlot()
      }
    }
  } catch (err) {
    if (slot.generation !== myGeneration) return
    log.error('ai', 'Enrichment slot stream error:', err)
    slot.deliverResult?.(null)
    warmupResolver?.(false)
    warmupResolver = null
  } finally {
    if (slot.generation !== myGeneration) {
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
  if (slot.state === 'dead') return

  totalRecycles++

  // Circuit breaker: detect rapid consecutive recycles
  const now = Date.now()
  if (now - slot.lastRecycleTime < RAPID_RECYCLE_WINDOW_MS) {
    slot.rapidRecycleCount++
  } else {
    slot.rapidRecycleCount = 1
  }
  slot.lastRecycleTime = now

  if (slot.rapidRecycleCount >= RAPID_RECYCLE_LIMIT) {
    log.error(
      'ai',
      `Enrichment slot recycled ${slot.rapidRecycleCount} times in <${RAPID_RECYCLE_WINDOW_MS}ms — marking dead (circuit breaker)`,
    )
    slot.generation++
    slot.state = 'dead'
    try {
      slot.channel?.close()
    } catch {
      // Ignore
    }
    slot.channel = null
    slot.resultPromise = null
    slot.deliverResult = null

    // Reject all waiters
    for (const entry of waitQueue) {
      entry.reject(new Error('Enrichment slot died (circuit breaker)'))
    }
    waitQueue.length = 0
    return
  }

  // Normal recycle: close old, reinit
  slot.generation++
  try {
    slot.channel?.close()
  } catch {
    // Ignore
  }
  slot.channel = null
  slot.resultPromise = null
  slot.deliverResult = null
  slot.resultCount = 0
  slot.state = 'initializing'

  // Release any waiters — they'll get served after reinit
  log.info('ai', 'Enrichment slot recycling...')
  setTimeout(() => {
    initEnrichmentSlot().catch((err) => {
      log.error('ai', 'Enrichment slot recycle init failed:', err)
    })
  }, 0)
}
