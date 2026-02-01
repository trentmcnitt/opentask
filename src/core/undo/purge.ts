/**
 * Undo log purge - deletes entries older than 90 days
 */

import { getDb } from '@/core/db'

const RETENTION_DAYS = 90

export function purgeOldUndoLogs(): number {
  const db = getDb()

  const cutoffDate = new Date()
  cutoffDate.setDate(cutoffDate.getDate() - RETENTION_DAYS)
  const cutoffIso = cutoffDate.toISOString()

  const result = db.prepare(`DELETE FROM undo_log WHERE created_at < ?`).run(cutoffIso)

  if (result.changes > 0) {
    console.log(
      `[undo-purge] Deleted ${result.changes} undo log entries older than ${RETENTION_DAYS} days`,
    )
  }

  return result.changes
}
