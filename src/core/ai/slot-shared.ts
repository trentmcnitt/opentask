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

// --- Shared functions ---

export function validateWarmup(text: string | null): boolean {
  if (!text) return false
  return text.includes('READY')
}

/** Parse an integer from an env var with a default fallback. Returns the default if the value is not a valid integer. */
export function parseEnvInt(envVar: string | undefined, defaultValue: number): number {
  const parsed = parseInt(envVar || '', 10)
  return isNaN(parsed) ? defaultValue : parsed
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
