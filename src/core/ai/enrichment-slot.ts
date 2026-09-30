/**
 * Warm enrichment slot
 *
 * Keeps a dedicated Claude Code subprocess warm for enrichment queries,
 * eliminating cold-start latency for the most frequent AI operation. The
 * lifecycle (init, warmup, reuse, recycle, circuit breaker, shutdown) is the
 * shared warm-slot engine in warm-slot.ts; this file configures it and adds
 * the query entry point.
 *
 * Concurrency: FIFO queue — a busy slot queues the caller, so every request
 * gets its own answer. The slot pins the enrichment JSON schema, so its
 * warmup is checked by shape (validateSchemaWarmup). Errors THROW, and the
 * enrichment pipeline retries.
 */

import { logAIActivity } from './activity'
import { log } from '@/lib/logger'
import { ENRICHMENT_SYSTEM_PROMPT } from './prompts'
import { type BaseSlotStats, validateSchemaWarmup, parseEnvInt } from './slot-shared'
import { EnrichmentResultSchema } from './types'
import { resolveSDKModel } from './models'
import { createWarmSlot, fifoQueuePolicy, type FifoQueueState } from './warm-slot'

// --- Configuration ---

const DEFAULT_MAX_REUSES = 8
const DEFAULT_QUERY_TIMEOUT_MS = 60_000

function getModel(): string {
  return resolveSDKModel('enrichment')
}

function getQueryTimeout(): number {
  return parseEnvInt(process.env.OPENTASK_AI_QUERY_TIMEOUT_MS, DEFAULT_QUERY_TIMEOUT_MS)
}

export interface EnrichmentSlotStats extends BaseSlotStats {
  currentOperation: {
    taskId: number | null
    inputText: string | null
    startedAt: string | null
  } | null
}

const slot = createWarmSlot<{ taskId: number | null; inputText: string | null }, FifoQueueState>(
  {
    name: 'Enrichment',
    globalKey: '__enrichmentSlotState',
    getModel,
    getMaxReuses: () => parseEnvInt(process.env.OPENTASK_AI_MAX_REUSES, DEFAULT_MAX_REUSES),
    maxTurns: 50,
    getSystemPrompt: () => ENRICHMENT_SYSTEM_PROMPT,
    getOutputSchema: () => EnrichmentResultSchema,
    // This slot pins a JSON schema, so the warmup answer comes back as an
    // object rather than the word READY — see validateSchemaWarmup.
    validateWarmup: (r) => validateSchemaWarmup(r.text, r.structuredOutput, EnrichmentResultSchema),
  },
  fifoQueuePolicy,
)

/**
 * Initialize the enrichment slot. Called from instrumentation.ts on startup
 * and on demand from enrichmentQuery() to recover from `dead` (with backoff —
 * see WarmSlot.init).
 */
export function initEnrichmentSlot(): Promise<void> {
  return slot.init()
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

  // If the slot died at runtime, attempt one re-init before failing. The init
  // function respects the cooldown internally — repeated failures back off so
  // a permanently broken SDK won't be retried on every request.
  if (slot.getState() === 'dead') {
    await slot.init()
  }
  if (!slot.isUsable()) {
    throw new Error(`Enrichment slot is ${slot.getState()} — cannot process query`)
  }

  try {
    const result = await slot.send(prompt, timeoutMs, {
      taskId: options?.taskId ?? null,
      inputText: options?.inputText ?? null,
    })
    const durationMs = Date.now() - startTime

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
        provider: 'sdk',
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
        provider: 'sdk',
      })
    }

    log.error('ai', `Enrichment slot query failed after ${durationMs}ms:`, err)
    throw err
  }
}

/** Get enrichment slot statistics for observability. */
export function getEnrichmentSlotStats(): EnrichmentSlotStats {
  return slot.getStats()
}

/** Graceful shutdown for SIGTERM. Rejects every queued caller. */
export function shutdownEnrichmentSlot(): void {
  slot.shutdown()
}

// --- Test helpers ---

/** Reset all slot state for test isolation. */
export function _resetSlotForTesting(): void {
  slot.resetForTests()
}
