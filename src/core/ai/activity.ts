/**
 * AI activity logging
 *
 * Every AI operation (enrichment, whats_next, etc.) is logged here
 * for debugging, cost visibility, and future UI. This is separate from
 * the undo log — undo tracks what changed, activity tracks AI operations.
 */

import { getDb } from '@/core/db'
import { nowUtc } from '@/core/recurrence'
import type { AIActivityEntry } from './types'

/**
 * Log an AI activity to the ai_activity_log table.
 */
export function logAIActivity(entry: Omit<AIActivityEntry, 'id' | 'created_at'>): number {
  const db = getDb()
  const now = nowUtc()

  const result = db
    .prepare(
      `INSERT INTO ai_activity_log (user_id, task_id, action, status, input, output, model, duration_ms, error, provider, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      entry.provider ?? null,
      now,
    )

  return result.lastInsertRowid as number
}

/**
 * Filter values that stand for several logged actions: Process logs its two
 * AI steps under their own names (src/core/ai/process.ts), and the AI Status
 * filter has one "Process" chip for both.
 */
const ACTION_GROUPS: Record<string, string[]> = {
  process: ['process_projects', 'process_duplicates'],
}

/**
 * Query AI activity log entries for a user. `action` filters to one logged
 * action, or to a group of them (`ACTION_GROUPS`, e.g. `process`).
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
    const actions = ACTION_GROUPS[action] ?? [action]
    conditions.push(`action IN (${actions.map(() => '?').join(', ')})`)
    params.push(...actions)
  }

  params.push(limit, offset)

  return db
    .prepare(
      `SELECT id, user_id, task_id, action, status, input, output, model, duration_ms, error, provider, created_at
       FROM ai_activity_log
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params) as AIActivityEntry[]
}
