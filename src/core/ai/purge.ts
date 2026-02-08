/**
 * AI activity log purge - deletes entries older than retention period
 *
 * The ai_activity_log table stores every AI operation for debugging and
 * cost visibility. Without purging, it grows indefinitely. Default
 * retention is 90 days (longer than undo/completions since activity
 * data is useful for prompt tuning and cost analysis).
 */

import { getDb } from '@/core/db'
import { log } from '@/lib/logger'

const DEFAULT_RETENTION_DAYS = 90

export function purgeOldAIActivity(): number {
  const retentionDays = parseInt(
    process.env.OPENTASK_RETENTION_AI_ACTIVITY_DAYS || String(DEFAULT_RETENTION_DAYS),
    10,
  )

  const db = getDb()

  const cutoffDate = new Date()
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays)
  const cutoffIso = cutoffDate.toISOString()

  const result = db.prepare(`DELETE FROM ai_activity_log WHERE created_at < ?`).run(cutoffIso)

  if (result.changes > 0) {
    log.info(
      'cron',
      `Deleted ${result.changes} AI activity log entries older than ${retentionDays} days`,
    )
  }

  return result.changes
}
