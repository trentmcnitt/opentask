/**
 * Warm quick take slot
 *
 * Keeps a dedicated Claude Code subprocess warm for quick take queries. The
 * lifecycle (init, warmup, reuse, recycle, circuit breaker, shutdown) is the
 * shared warm-slot engine in warm-slot.ts; this file configures it and adds
 * the query entry point.
 *
 * Differences from the enrichment slot:
 * - Concurrency: latest-wins instead of a FIFO queue. Only the most recent
 *   quick take matters, so a new request supersedes the in-flight one.
 * - Output: plain text (no JSON schema), so warmup checks for the word READY.
 * - Lower max reuses (4 vs 8) since quick takes are less frequent.
 * - Errors RETURN NULL instead of throwing: the caller falls back to a cold
 *   subprocess.
 */

import { log } from '@/lib/logger'
import { logAIActivity } from './activity'
import { QUICK_TAKE_SYSTEM_PROMPT } from './quick-take'
import { resolveSDKModel } from './models'
import { type BaseSlotStats, validateWarmup, parseEnvInt } from './slot-shared'
import {
  createWarmSlot,
  latestWinsPolicy,
  SlotChannelMissingError,
  type LatestWinsState,
} from './warm-slot'

// --- Configuration ---

const DEFAULT_MAX_REUSES = 4
const DEFAULT_QUERY_TIMEOUT_MS = 40_000

function getModel(): string {
  return resolveSDKModel('quick_take')
}

function getQueryTimeout(): number {
  return parseEnvInt(process.env.OPENTASK_AI_QUICKTAKE_TIMEOUT_MS, DEFAULT_QUERY_TIMEOUT_MS)
}

export interface QuickTakeSlotStats extends BaseSlotStats {
  totalSuperseded: number
  currentOperation: {
    inputText: string | null
    startedAt: string | null
  } | null
}

const slot = createWarmSlot<{ inputText: string | null }, LatestWinsState>(
  {
    name: 'Quick Take',
    globalKey: '__quickTakeSlotState',
    getModel,
    getMaxReuses: () =>
      parseEnvInt(process.env.OPENTASK_AI_QUICKTAKE_MAX_REUSES, DEFAULT_MAX_REUSES),
    maxTurns: 15,
    // A getter: quick-take.ts imports this module back (see WarmSlotConfig)
    getSystemPrompt: () => QUICK_TAKE_SYSTEM_PROMPT,
    validateWarmup: (r) => validateWarmup(r.text),
  },
  latestWinsPolicy,
)

/**
 * Initialize the quick take slot. Called from instrumentation.ts on startup
 * and on demand from quickTakeSlotQuery() to recover from `dead` (with
 * backoff — see WarmSlot.init).
 */
export function initQuickTakeSlot(): Promise<void> {
  return slot.init()
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
  // If the slot died at runtime, attempt one re-init before giving up. The
  // init function respects the cooldown internally — repeated failures back
  // off so a permanently broken SDK won't be retried on every request.
  if (slot.getState() === 'dead') {
    await slot.init()
  }

  // If the slot is still not usable, signal the caller to fall back to the cold path
  if (!slot.isUsable()) return null

  const startTime = Date.now()
  const timeoutMs = options?.timeoutMs ?? getQueryTimeout()

  try {
    const result = await slot.send(prompt, timeoutMs, { inputText: options?.inputText ?? null })
    const text = result?.text ?? null
    const durationMs = Date.now() - startTime

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
        provider: 'sdk',
      })
    }

    log.info('ai', `Quick Take slot query completed in ${durationMs}ms`)

    return { text, durationMs }
  } catch (err) {
    const durationMs = Date.now() - startTime

    // No channel to push into: the slot is already released (the policy set
    // it available); nothing ran, so there is nothing to log as activity.
    if (err instanceof SlotChannelMissingError) return { text: null, durationMs }

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
        provider: 'sdk',
      })
    }

    log.error('ai', `Quick Take slot query failed after ${durationMs}ms:`, err)
    return { text: null, durationMs }
  }
}

/** Get quick take slot statistics for observability. */
export function getQuickTakeSlotStats(): QuickTakeSlotStats {
  const { currentOperation, ...base } = slot.getStats()
  return {
    ...base,
    totalSuperseded: slot.getPolicyState().totalSuperseded,
    currentOperation,
  }
}

/** Graceful shutdown for SIGTERM. */
export function shutdownQuickTakeSlot(): void {
  slot.shutdown()
}

// --- Test helpers ---

/** Reset all slot state for test isolation. */
export function _resetSlotForTesting(): void {
  slot.resetForTests()
}
