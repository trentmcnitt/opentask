/**
 * Field change apply helper for task updates
 *
 * The write half of `collectFieldChanges`: given the changes it collected for
 * one task, stamp `updated_at`, run the UPDATE, and build the undo snapshot
 * and the activity entry for that task. Shared by every path that edits task
 * fields through `collectFieldChanges` — `updateTask`, `bulkEdit`,
 * `bulkSnooze`, and the reminder/quota moves in `@/core/time-slots/edit` — so
 * the four stay one write, not four copies that drift.
 *
 * What it deliberately does NOT do (the caller owns these, per the house rule
 * that the mutation and its undo entry commit together):
 *   - open the transaction — call it inside the caller's `withTransaction`
 *   - `logAction` — single edits log one entry, batches one entry for all
 *   - stats, sync events, notification dismissal and webhooks
 *
 * The returned `activity` is the per-task part of an `ActivityEntry`; the
 * caller adds `userId` and, for a batch, `source` and `batchId`. Its
 * `before`/`after` are the collected states (only the changed fields, plus
 * `id` and `title`); `action` is `'snooze'` when the edit is a snooze by
 * `collectFieldChanges`'s measure (`isSnoozeScenario`), else `'edit'`.
 *
 * Call it only when `data.fieldsChanged` is non-empty — an UPDATE with no
 * SET clause is not valid SQL, and a no-op edit has nothing to undo.
 */

import type { Database } from 'better-sqlite3'
import type { Task, UndoSnapshot } from '@/types'
import { createTaskSnapshot } from '@/core/undo'
import type { ActivityEntry } from '@/core/activity'
import type { FieldChangeData } from './collect-field-changes'

export type AppliedActivity = Pick<ActivityEntry, 'taskId' | 'action' | 'fields'> & {
  before: Partial<Task>
  after: Partial<Task>
}

export interface ApplyFieldChangesResult {
  snapshot: UndoSnapshot
  activity: AppliedActivity
}

export function applyFieldChanges(
  tx: Database,
  task: Task,
  data: FieldChangeData,
  nowStr: string,
): ApplyFieldChangesResult {
  // Add updated_at and task ID for WHERE clause
  data.setClauses.push('updated_at = ?')
  data.values.push(nowStr, task.id)
  tx.prepare(`UPDATE tasks SET ${data.setClauses.join(', ')} WHERE id = ?`).run(...data.values)

  const snapshot = createTaskSnapshot(data.beforeState, data.afterState, data.fieldsChanged)

  return {
    snapshot,
    activity: {
      taskId: task.id,
      action: data.isSnoozeScenario ? 'snooze' : 'edit',
      fields: data.fieldsChanged,
      before: data.beforeState,
      after: data.afterState,
    },
  }
}
