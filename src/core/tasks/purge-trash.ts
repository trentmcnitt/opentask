/**
 * Trash purge - permanently deletes tasks trashed more than retention period
 *
 * Default retention is 30 days.
 */

import { withTransaction } from '@/core/db'

const DEFAULT_RETENTION_DAYS = 30

export function purgeOldTrash(): number {
  const retentionDays = parseInt(
    process.env.OPENTASK_RETENTION_TRASH_DAYS || String(DEFAULT_RETENTION_DAYS),
    10,
  )

  const cutoffDate = new Date()
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays)
  const cutoffIso = cutoffDate.toISOString()

  // Execute all deletes in a transaction
  const changes = withTransaction((tx) => {
    // First, delete any notes associated with the tasks we're about to purge
    tx.prepare(
      `
      DELETE FROM notes
      WHERE task_id IN (
        SELECT id FROM tasks
        WHERE deleted_at IS NOT NULL AND deleted_at < ?
      )
    `,
    ).run(cutoffIso)

    // Delete any completions associated with these tasks
    tx.prepare(
      `
      DELETE FROM completions
      WHERE task_id IN (
        SELECT id FROM tasks
        WHERE deleted_at IS NOT NULL AND deleted_at < ?
      )
    `,
    ).run(cutoffIso)

    // Finally, delete the tasks themselves
    const result = tx
      .prepare(`DELETE FROM tasks WHERE deleted_at IS NOT NULL AND deleted_at < ?`)
      .run(cutoffIso)

    return result.changes
  })

  if (changes > 0) {
    console.log(
      `[trash-purge] Permanently deleted ${changes} tasks trashed more than ${retentionDays} days ago`,
    )
  }

  return changes
}
