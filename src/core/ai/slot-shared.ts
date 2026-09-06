/**
 * Shared utilities for warm slot infrastructure
 *
 * Both enrichment-slot.ts and quick-take-slot.ts share identical warmup
 * validation, circuit breaker logic, and configuration patterns. This module
 * extracts those common pieces while leaving concurrency-specific logic
 * (FIFO queue vs latest-wins) in each slot file.
 *
 * Error handling asymmetry (intentional):
 * - Enrichment slot THROWS on errors — callers retry via the enrichment pipeline
 * - Quick-take slot RETURNS NULL — callers fall back to a cold subprocess path
 * This difference is by design, not an oversight.
 */

// --- Shared types ---

export type SlotState = 'uninitialized' | 'initializing' | 'available' | 'busy' | 'dead'

export interface BaseSlotStats {
  state: SlotState
  activatedAt: string | null
  totalRequests: number
  totalRecycles: number
  lastRequestAt: string | null
  model: string
}

// --- Shared constants ---

export const WARMUP_MESSAGE = 'Respond with exactly: READY'
export const WARMUP_TIMEOUT_MS = 15_000
export const RAPID_RECYCLE_WINDOW_MS = 5_000
export const RAPID_RECYCLE_LIMIT = 5

/**
 * Exponential backoff for re-init attempts after the slot enters `dead`.
 * Indexed by `consecutiveInitFailures - 1`; values past the end use the cap.
 *
 * After a circuit-breaker trip, callers seed `consecutiveInitFailures` to
 * `CIRCUIT_BREAKER_INITIAL_FAILURES` so the first cooldown is meaningful
 * (rapid recycles signal something genuinely broken).
 */
const REINIT_BACKOFF_SCHEDULE_MS = [30_000, 60_000, 120_000, 300_000, 600_000]
export const CIRCUIT_BREAKER_INITIAL_FAILURES = 4

// --- Shared functions ---

/**
 * Warmup for a slot that answers in free text: the subprocess is alive if it
 * echoed the word back.
 */
export function validateWarmup(text: string | null): boolean {
  if (!text) return false
  return text.includes('READY')
}

/**
 * Warmup for a slot that pins a JSON schema.
 *
 * Such a slot cannot answer the warmup with a bare word. The CLI injects a
 * synthetic "you MUST call the StructuredOutput tool" turn, so the model
 * responds with an object matching the schema, and `result` is that object
 * serialized — whether the word READY survives into one of its fields is
 * luck. That is why the plain text check failed the enrichment slot's warmup
 * intermittently for months (27 times in one day on dev), leaving the slot
 * dead and every enrichment, reminder and task alike, unprocessed until a
 * later retry happened to land.
 *
 * Proof of life here is the shape instead: the subprocess spawned, accepted a
 * message, honored the schema, and returned something the slot's own parser
 * accepts. Text is still honored for a model that answers in words despite the
 * schema, so this is strictly more permissive than the check it replaces —
 * never less.
 */
export function validateSchemaWarmup(
  text: string | null,
  structuredOutput: Record<string, unknown> | null,
  schema: { safeParse: (value: unknown) => { success: boolean } },
): boolean {
  if (structuredOutput && schema.safeParse(structuredOutput).success) return true
  return validateWarmup(text)
}

/** Parse an integer from an env var with a default fallback. Returns the default if the value is not a valid integer. */
export function parseEnvInt(envVar: string | undefined, defaultValue: number): number {
  const parsed = parseInt(envVar || '', 10)
  return isNaN(parsed) ? defaultValue : parsed
}

/**
 * Compute the cooldown duration before the slot may attempt re-init.
 * Returns 0 when no failures have been recorded.
 */
export function computeReinitBackoff(consecutiveInitFailures: number): number {
  if (consecutiveInitFailures <= 0) return 0
  const idx = Math.min(consecutiveInitFailures - 1, REINIT_BACKOFF_SCHEDULE_MS.length - 1)
  return REINIT_BACKOFF_SCHEDULE_MS[idx]
}

/**
 * Pure circuit breaker check for rapid recycle detection.
 *
 * Returns whether the breaker tripped and updated tracking values.
 * Each slot file handles the tripped case differently (enrichment
 * rejects waiters; quick-take just marks dead).
 */
export function checkCircuitBreaker(
  lastRecycleTime: number,
  rapidRecycleCount: number,
): { tripped: boolean; newCount: number; newTime: number } {
  const now = Date.now()
  const newCount = now - lastRecycleTime < RAPID_RECYCLE_WINDOW_MS ? rapidRecycleCount + 1 : 1
  return {
    tripped: newCount >= RAPID_RECYCLE_LIMIT,
    newCount,
    newTime: now,
  }
}
