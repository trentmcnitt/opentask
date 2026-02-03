/**
 * Completions purge - deletes completion records older than retention period
 *
 * Per-task stats (completion_count, first_completed_at, last_completed_at)
 * and daily user stats survive beyond this retention since they're captured
 * at completion time.
 */

import { getDb } from '@/core/db'

const DEFAULT_RETENTION_DAYS = 30

export function purgeOldCompletions(): number {
  const retentionDays = parseInt(
    process.env.OPENTASK_RETENTION_COMPLETIONS_DAYS || String(DEFAULT_RETENTION_DAYS),
    10,
  )

  const db = getDb()

  const cutoffDate = new Date()
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays)
  const cutoffIso = cutoffDate.toISOString()

  const result = db.prepare(`DELETE FROM completions WHERE completed_at < ?`).run(cutoffIso)

  if (result.changes > 0) {
    console.log(
      `[completions-purge] Deleted ${result.changes} completion records older than ${retentionDays} days`,
    )
  }

  return result.changes
}
