/**
 * AI activity log purge - deletes entries older than retention period
 *
 * The ai_activity_log table stores every AI operation for debugging and
 * cost visibility. Without purging, it grows indefinitely. Default
 * retention is 90 days (longer than undo/completions since activity
 * data is useful for prompt tuning and cost analysis).
 */

import { purgeOlderThan } from '@/core/db/purge'

export function purgeOldAIActivity(): number {
  return purgeOlderThan({
    table: 'ai_activity_log',
    column: 'created_at',
    envVar: 'OPENTASK_RETENTION_AI_ACTIVITY_DAYS',
    defaultDays: 90,
    label: 'AI activity log entries',
  })
}
