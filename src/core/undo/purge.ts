/**
 * Undo log purge - deletes entries older than retention period
 *
 * Default retention is 30 days to match other data retention policies.
 */

import { purgeOlderThan } from '@/core/db/purge'

export function purgeOldUndoLogs(): number {
  return purgeOlderThan({
    table: 'undo_log',
    column: 'created_at',
    envVar: 'OPENTASK_RETENTION_UNDO_DAYS',
    defaultDays: 30,
    label: 'undo log entries',
  })
}
