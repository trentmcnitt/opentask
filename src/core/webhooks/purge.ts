/**
 * Webhook delivery purge — deletes entries older than retention period
 *
 * Default retention is 7 days. Webhook deliveries are high-volume
 * and only useful for recent debugging. There is no env var for this one;
 * a caller (the behavioral test) may pass the retention directly.
 */

import { purgeOlderThan } from '@/core/db/purge'

const DEFAULT_RETENTION_DAYS = 7

export function purgeOldDeliveries(retentionDays: number = DEFAULT_RETENTION_DAYS): number {
  return purgeOlderThan({
    table: 'webhook_deliveries',
    column: 'created_at',
    defaultDays: retentionDays,
    label: 'webhook deliveries',
  })
}
