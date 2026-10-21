/**
 * ROLLBACK HELPER for the task queue (task-queue PR 2; build plan "Go-live",
 * step 4). If the queue is ever switched off for good, the targets the
 * rollover stripped can be put back: every one-off still in the queue with
 * no target (`queued_at` set, `due_at` NULL) gets `due_at = queued_from_due_at`
 * again, leaves the queue, and has its target stamped as set now.
 *
 * Only one-offs: a repeating task waiting in the queue (B3) still has a
 * target (its next occurrence), so it is not "untargeted" and is left alone.
 * A task the user has since targeted (a Today tap) is out of the queue and
 * untouched.
 *
 * Driven by `scripts/restore-stripped-targets.ts` (dry run by default). NOT
 * an undo — no undo entry; one activity row per restored task. Written and
 * tested on a temp database (tq-rollover.test.ts); never run on production
 * without Trent.
 */

import { getDb, withTransaction } from '@/core/db'
import { logActivity } from '@/core/activity'
import { QUEUE_CLEAR_SQL, TARGET_SET_FIELD } from './target-set'
import { DECK_CLEAR_SQL } from './deck-clear'

export interface StrippedTarget {
  id: number
  title: string
  /** The target the rollover stripped, which a restore puts back. */
  queued_from_due_at: string
  queued_at: string
}

/** The one-offs a restore would touch: queued, untargeted, with a remembered target. */
export function findStrippedTargets(userId: number): StrippedTarget[] {
  return getDb()
    .prepare(
      `SELECT id, title, queued_from_due_at, queued_at FROM tasks
        WHERE user_id = ? AND queued_at IS NOT NULL AND due_at IS NULL
          AND queued_from_due_at IS NOT NULL AND rrule IS NULL
          AND done = 0 AND deleted_at IS NULL AND archived_at IS NULL
        ORDER BY id`,
    )
    .all(userId) as StrippedTarget[]
}

/** Put the stripped targets back (see the module doc). Returns what it restored. */
export function restoreStrippedTargets(userId: number, now: Date = new Date()): StrippedTarget[] {
  const nowStr = now.toISOString()
  return withTransaction((tx) => {
    const found = findStrippedTargets(userId)
    const update = tx.prepare(
      `UPDATE tasks
          SET due_at = queued_from_due_at, ${QUEUE_CLEAR_SQL}, ${DECK_CLEAR_SQL}, ${TARGET_SET_FIELD} = ?,
              updated_at = ?
        WHERE id = ? AND due_at IS NULL AND queued_at IS NOT NULL`,
    )
    for (const t of found) {
      update.run(nowStr, nowStr, t.id)
      logActivity({
        userId,
        taskId: t.id,
        action: 'edit',
        fields: ['due_at', 'queued_at', TARGET_SET_FIELD],
        before: { id: t.id, title: t.title, due_at: null, queued_at: t.queued_at },
        after: { id: t.id, title: t.title, due_at: t.queued_from_due_at, queued_at: null },
        metadata: { restore_stripped_target: true },
      })
    }
    return found
  })
}
