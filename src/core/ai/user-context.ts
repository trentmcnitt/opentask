/**
 * Load user AI context from the database.
 *
 * Single-purpose helper kept separate from AuthUser so that ai_context
 * doesn't need to flow through auth, session, or JWT callbacks.
 */

import { getDb } from '@/core/db'

export function getUserAiContext(userId: number): string | null {
  const db = getDb()
  const row = db.prepare('SELECT ai_context FROM users WHERE id = ?').get(userId) as
    | { ai_context: string | null }
    | undefined
  return row?.ai_context ?? null
}
