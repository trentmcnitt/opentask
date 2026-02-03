/**
 * User daily stats purge - deletes stats older than retention period
 *
 * Default retention is 365 days (1 year) since daily stats are aggregated
 * and don't take much space.
 */

import { getDb } from '@/core/db'

const DEFAULT_RETENTION_DAYS = 365

export function purgeOldStats(): number {
  const retentionDays = parseInt(
    process.env.OPENTASK_RETENTION_STATS_DAYS || String(DEFAULT_RETENTION_DAYS),
    10,
  )

  const db = getDb()

  const cutoffDate = new Date()
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays)
  // Stats use YYYY-MM-DD format, not ISO
  const cutoffDateStr = cutoffDate.toISOString().split('T')[0]

  const result = db.prepare(`DELETE FROM user_daily_stats WHERE date < ?`).run(cutoffDateStr)

  if (result.changes > 0) {
    console.log(
      `[stats-purge] Deleted ${result.changes} daily stats records older than ${retentionDays} days`,
    )
  }

  return result.changes
}
