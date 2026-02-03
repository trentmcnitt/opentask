/**
 * Undo log purge - deletes entries older than retention period
 *
 * Default retention is 30 days to match other data retention policies.
 */

import { getDb } from '@/core/db'

const DEFAULT_RETENTION_DAYS = 30

export function purgeOldUndoLogs(): number {
  const retentionDays = parseInt(
    process.env.OPENTASK_RETENTION_UNDO_DAYS || String(DEFAULT_RETENTION_DAYS),
    10,
  )

  const db = getDb()

  const cutoffDate = new Date()
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays)
  const cutoffIso = cutoffDate.toISOString()

  const result = db.prepare(`DELETE FROM undo_log WHERE created_at < ?`).run(cutoffIso)

  if (result.changes > 0) {
    console.log(
      `[undo-purge] Deleted ${result.changes} undo log entries older than ${retentionDays} days`,
    )
  }

  return result.changes
}
