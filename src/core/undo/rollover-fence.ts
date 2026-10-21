/**
 * THE ROLLOVER'S UNDO FENCE (task queue B5, 2026-10-19; task-rollover.ts).
 *
 * The rollover writes no undo entry — it is a system action — but it changes
 * tasks that older entries hold snapshots of. Undoing last night's sweep at
 * 6:31 would put a stripped target back (and pull the task out of the queue
 * behind the rollover's back), or drag a rolled repeating task to a missed
 * occurrence. So undo and redo SKIP the snapshot of any task the rollover
 * changed after the entry was written (`tasks.rolled_over_at` > the entry's
 * `created_at`), exactly as `periodMoved` skips a quota count from a closed
 * period: the rest of the entry still applies, and the entry is marked
 * undone (or redone) as usual — never a throw, which would wedge the stack.
 * The Today tap is the way back for a stripped task.
 *
 * The same fence guards the deadline-anchor migration (2026-10-21,
 * `migrate-repeat-anchor.ts`), which stamps `rolled_over_at` on each row it
 * converts: an older entry holds the old meaning of `occurrence_at`. So the
 * column reads as "the last system change older entries must not cross".
 *
 * Compared as instants (`Date.parse`), never as strings: `created_at` is
 * written by `logAction` as an ISO string with milliseconds, but rows from
 * before that carry SQLite's second-precision default, and `…:00.123Z` sorts
 * below `…:00Z` as text.
 */

import type Database from 'better-sqlite3'
import type { UndoSnapshot } from '@/types'

/** Whether the rollover changed this snapshot's task after `entryCreatedAt`. */
export function rolledOverSince(
  tx: Database.Database,
  snapshot: UndoSnapshot,
  entryCreatedAt: string | null | undefined,
): boolean {
  if (!entryCreatedAt) return false
  const row = tx.prepare('SELECT rolled_over_at FROM tasks WHERE id = ?').get(snapshot.task_id) as
    | { rolled_over_at: string | null }
    | undefined
  if (!row?.rolled_over_at) return false
  const created = Date.parse(entryCreatedAt)
  const rolled = Date.parse(row.rolled_over_at)
  if (Number.isNaN(created) || Number.isNaN(rolled)) return false
  return rolled > created
}
