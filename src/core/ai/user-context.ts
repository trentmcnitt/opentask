/**
 * Load user AI preferences from the database.
 *
 * Single-purpose helpers kept separate from AuthUser so that AI preferences
 * don't need to flow through auth, session, or JWT callbacks.
 */

import { getDb } from '@/core/db'

export function getUserAiContext(userId: number): string | null {
  const db = getDb()
  const row = db.prepare('SELECT ai_context FROM users WHERE id = ?').get(userId) as
    | { ai_context: string | null }
    | undefined
  return row?.ai_context ?? null
}

/**
 * Get the user's preferred model for on-demand Bubble generation.
 * Defaults to 'haiku' (fast) if not set.
 */
export function getUserBubbleModel(userId: number): string {
  const db = getDb()
  const row = db.prepare('SELECT ai_bubble_model FROM users WHERE id = ?').get(userId) as
    | { ai_bubble_model: string | null }
    | undefined
  return row?.ai_bubble_model ?? 'haiku'
}
