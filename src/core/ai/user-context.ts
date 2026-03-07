/**
 * Load user AI preferences from the database.
 *
 * Single-purpose helpers kept separate from AuthUser so that AI preferences
 * don't need to flow through auth, session, or JWT callbacks.
 */

import { getDb } from '@/core/db'

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

/**
 * Get a user's per-user AI query timeout override.
 * Returns the timeout in ms, or null if no override is set (use global default).
 */
export function getUserQueryTimeout(userId: number): number | null {
  const db = getDb()
  const row = db.prepare('SELECT ai_query_timeout_ms FROM users WHERE id = ?').get(userId) as
    | { ai_query_timeout_ms: number | null }
    | undefined
  return row?.ai_query_timeout_ms ?? null
}

function parseMode(value: string | null | undefined): FeatureMode {
  if (value === 'off' || value === 'sdk' || value === 'api') return value
  return 'api'
}
