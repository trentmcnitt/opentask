/**
 * Completions purge - deletes completion records older than retention period
 *
 * Per-task stats (completion_count, first_completed_at, last_completed_at)
 * and daily user stats survive beyond this retention since they're captured
 * at completion time.
 */

import { purgeOlderThan } from '@/core/db/purge'

export function purgeOldCompletions(): number {
  return purgeOlderThan({
    table: 'completions',
    column: 'completed_at',
    envVar: 'OPENTASK_RETENTION_COMPLETIONS_DAYS',
    defaultDays: 30,
    label: 'completion records',
  })
}
