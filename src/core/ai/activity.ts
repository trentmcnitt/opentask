/**
 * AI activity logging
 *
 * Every AI operation (enrichment, chat, briefing, etc.) is logged here
 * for debugging, cost visibility, and future UI. This is separate from
 * the undo log — undo tracks what changed, activity tracks AI operations.
 */

import { getDb } from '@/core/db'
import type { AIActivityEntry } from './types'

/**
 * Log an AI activity to the ai_activity_log table.
 */
export function logAIActivity(entry: Omit<AIActivityEntry, 'id' | 'created_at'>): number {
  const db = getDb()
  const now = new Date().toISOString()

  const result = db
    .prepare(
      `INSERT INTO ai_activity_log (user_id, task_id, action, status, input, output, model, duration_ms, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      entry.user_id,
      entry.task_id,
      entry.action,
      entry.status,
      entry.input,
      entry.output,
      entry.model,
      entry.duration_ms,
      entry.error,
      now,
    )

  return result.lastInsertRowid as number
}

/**
 * Query AI activity log entries for a user.
 */
export function getAIActivity(
  userId: number,
  options: { limit?: number; offset?: number; action?: string } = {},
): AIActivityEntry[] {
  const db = getDb()
  const { limit = 50, offset = 0, action } = options

  const conditions = ['user_id = ?']
  const params: unknown[] = [userId]

  if (action) {
    conditions.push('action = ?')
    params.push(action)
  }

  params.push(limit, offset)

  return db
    .prepare(
      `SELECT id, user_id, task_id, action, status, input, output, model, duration_ms, error, created_at
       FROM ai_activity_log
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params) as AIActivityEntry[]
}
