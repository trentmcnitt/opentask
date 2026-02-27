/**
 * Webhook delivery purge — deletes entries older than retention period
 *
 * Default retention is 7 days. Webhook deliveries are high-volume
 * and only useful for recent debugging.
 */

import { getDb } from '@/core/db'
import { log } from '@/lib/logger'

const DEFAULT_RETENTION_DAYS = 7

export function purgeOldDeliveries(retentionDays: number = DEFAULT_RETENTION_DAYS): number {
  const db = getDb()

  const cutoffDate = new Date()
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays)
  const cutoffIso = cutoffDate.toISOString()

  const result = db
    .prepare('DELETE FROM webhook_deliveries WHERE datetime(created_at) < datetime(?)')
    .run(cutoffIso)

  if (result.changes > 0) {
    log.info(
      'cron',
      `Deleted ${result.changes} webhook deliveries older than ${retentionDays} days`,
    )
  }

  return result.changes
}
