/**
 * Load user AI preferences from the database.
 *
 * Single-purpose helpers kept separate from AuthUser so that AI preferences
 * don't need to flow through auth, session, or JWT callbacks.
 */

import { getDb } from '@/core/db'
import type { AIFeature } from './models'

export type FeatureMode = 'off' | 'sdk' | 'api'

export function getUserAiContext(userId: number): string | null {
  const db = getDb()
  const row = db.prepare('SELECT ai_context FROM users WHERE id = ?').get(userId) as
    | { ai_context: string | null }
    | undefined
  return row?.ai_context ?? null
}

/**
 * Get a user's per-feature AI modes.
 * Returns the mode for each feature (off / sdk / api).
 */
export function getUserFeatureModes(userId: number): {
  enrichment: FeatureMode
  quick_take: FeatureMode
  whats_next: FeatureMode
  insights: FeatureMode
} {
  const db = getDb()
  const row = db
    .prepare(
      'SELECT ai_enrichment_mode, ai_quicktake_mode, ai_whats_next_mode, ai_insights_mode FROM users WHERE id = ?',
    )
    .get(userId) as
    | {
        ai_enrichment_mode: string
        ai_quicktake_mode: string
        ai_whats_next_mode: string
        ai_insights_mode: string
      }
    | undefined

  return {
    enrichment: parseMode(row?.ai_enrichment_mode),
    quick_take: parseMode(row?.ai_quicktake_mode),
    whats_next: parseMode(row?.ai_whats_next_mode),
    insights: parseMode(row?.ai_insights_mode),
  }
}

/** DB column names for per-feature timeouts. */
const FEATURE_TIMEOUT_COLUMNS: Record<AIFeature, string> = {
  enrichment: 'ai_enrichment_timeout_ms',
  quick_take: 'ai_quicktake_timeout_ms',
  whats_next: 'ai_whats_next_timeout_ms',
  insights: 'ai_insights_timeout_ms',
}

/**
 * Built-in default timeouts per feature (ms), split by mode.
 * SDK spawns a subprocess and has higher overhead than direct API calls,
 * so SDK defaults are ~2x higher to avoid spurious timeouts.
 */
const FEATURE_DEFAULT_TIMEOUTS: Record<AIFeature, { api: number; sdk: number }> = {
  enrichment: { api: 60_000, sdk: 90_000 },
  quick_take: { api: 40_000, sdk: 60_000 },
  whats_next: { api: 60_000, sdk: 120_000 },
  insights: { api: 180_000, sdk: 300_000 },
}

/**
 * Get a user's per-feature AI query timeout override.
 * Returns the timeout in ms, or null if no override is set.
 */
export function getUserFeatureTimeout(userId: number, feature: AIFeature): number | null {
  const db = getDb()
  const col = FEATURE_TIMEOUT_COLUMNS[feature]
  const row = db.prepare(`SELECT ${col} FROM users WHERE id = ?`).get(userId) as
    | Record<string, number | null>
    | undefined
  return row?.[col] ?? null
}

/** Get the built-in default timeout for a feature, adjusted by mode. */
export function getFeatureDefaultTimeout(feature: AIFeature, mode: FeatureMode = 'api'): number {
  const defaults = FEATURE_DEFAULT_TIMEOUTS[feature]
  return mode === 'sdk' ? defaults.sdk : defaults.api
}

/** Resolve the effective timeout for a feature: per-user override → mode-aware default. */
export function resolveFeatureTimeout(
  userId: number,
  feature: AIFeature,
  mode: FeatureMode,
): number {
  return getUserFeatureTimeout(userId, feature) ?? getFeatureDefaultTimeout(feature, mode)
}

function parseMode(value: string | null | undefined): FeatureMode {
  if (value === 'off' || value === 'sdk' || value === 'api') return value
  return 'api'
}
