/**
 * Attempts — the minute job that PERSISTS them (spec §7, 2026-10-12; rules in
 * `src/lib/task-segments.ts` § the two badges).
 *
 * The count is already correct on every read: `rowToTask` adds the
 * over-target local days since the stored checkpoint (`effectiveAttempts`),
 * and every write that moves a target persists the checkpoint first
 * (`stampTargetSet`). This job is the backstop that keeps the STORED columns
 * current too — for anything that reads them raw (an export, a SQL query, a
 * database copy replayed by the day simulator) — the same shape as quotas
 * (`effectiveProgress` on read, the rollover cron behind it).
 *
 * Only tasks whose target has arrived can gain an attempt, so only those are
 * read. The write is an observation of the past, not a user action: no undo
 * entry, no activity, and `updated_at` is left alone (it would churn the
 * "modified" sort every day). No sync event either: every client computes the
 * same count from the same rule at render.
 */

import { getDb } from '@/core/db'
import { rowToTask, taskColumns, type TaskRow } from './read'

/** Write each over-target task's attempts as of now where they moved. Returns how many. */
export function persistAttempts(): number {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT ${taskColumns()} FROM tasks
        WHERE done = 0 AND deleted_at IS NULL AND due_at IS NOT NULL AND due_at <= ?
          AND is_reminder = 0 AND is_tracked = 0 AND progress_target <= 1`,
    )
    .all(new Date().toISOString()) as TaskRow[]
  const update = db.prepare(
    'UPDATE tasks SET attempts = ?, attempts_counted_through = ? WHERE id = ?',
  )
  let written = 0
  db.transaction(() => {
    for (const row of rows) {
      const task = rowToTask(row)
      if (
        task.attempts !== row.attempts ||
        task.attempts_counted_through !== row.attempts_counted_through
      ) {
        update.run(task.attempts, task.attempts_counted_through, row.id)
        written++
      }
    }
  })()
  return written
}
