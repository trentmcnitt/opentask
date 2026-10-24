/**
 * Shared field application logic for undo/redo operations.
 *
 * Both undo and redo need to surgically update specific fields on a task.
 * This module provides the shared implementation.
 */

import { getDb } from '@/core/db'
import type { Task } from '@/types'
import { nowUtc } from '@/core/recurrence'
import { ValidationError } from '@/core/errors'

/**
 * Field name mapping for backward compatibility.
 * Maps old field names in undo snapshots to current database column names.
 */
const LEGACY_FIELD_MAP: Record<string, string> = {
  snoozed_from: 'original_due_at',
}

/** Allowlist of task columns that undo/redo may write to (from schema.sql). */
const VALID_TASK_COLUMNS = new Set([
  'title',
  'original_title',
  'short_title',
  'done',
  'done_at',
  'priority',
  'due_at',
  'rrule',
  'recurrence_mode',
  'anchor_time',
  'anchor_dow',
  'anchor_dom',
  // Deadline-anchored repeats (2026-10-21): an anchor switch, a deadline
  // reschedule and an offset edit all put these in undo snapshots.
  'repeat_anchor',
  'target_days_before',
  'target_time',
  // Relative targets (2026-10-24): the period a relative target follows —
  // every link, unlink and retime puts it in a snapshot.
  'target_slot_id',
  // Repeat ends (2026-10-22): done, skip and the end edits write these, and
  // their undo puts them back — missing here would throw and wedge the stack.
  'repeat_count',
  'repeat_count_used',
  'repeat_until',
  'original_due_at',
  // Task model (2026-10-10). Must be here: this allowlist throws on an unknown
  // field, and a throw inside undoEntry wedges the stack (see is_tracked below).
  'deadline_at',
  'horizon',
  'horizon_set_at',
  'last_considered_at',
  'segment_deferred_at',
  'segment_targeted_at',
  // Upcoming (2026-10-12): every target/deadline write stamps it, so every
  // such undo restores it — missing here would throw and wedge the stack.
  'target_set_at',
  // §8 / §6 (2026-10-12): the auto-target flag and the repeating occurrence.
  'target_auto',
  'occurrence_at',
  // §7 (2026-10-12): done / skip reset attempts, put-back restores them, and
  // Process "keep" stamps growth_kept_at — all in undo snapshots.
  'attempts',
  'attempts_counted_through',
  'growth_kept_at',
  // The task queue (2026-10-19): a marking sweep's undo clears the mark, and
  // the undo of a pick that cleared it puts it back.
  'queue_mark',
  'try_tomorrow',
  'queued_at',
  'queued_from_due_at',
  // On deck (2026-10-20): a deck write, a pick that clears a deck, and Roll
  // over now's deck strip all put these in undo snapshots.
  'on_deck_day',
  'queued_from_deck_day',
  // The deadlines page (2026-10-22): a deadline write re-derives the lead
  // day, Defer moves it, PATCH sets the override — all in undo snapshots.
  'lead_days',
  'lead_from',
  // Retired 2026-10-12 but KEPT: undo entries written before then name them,
  // and an unknown field throws (wedging the stack — see `is_tracked`).
  'deadline_nag_off',
  'deleted_at',
  'archived_at',
  'labels',
  'last_notified_at',
  'last_critical_alert_at',
  'auto_snooze_minutes',
  'completion_count',
  'snooze_count',
  'first_completed_at',
  'last_completed_at',
  'notes',
  'project_id',
  // §5 / §7.5. These MUST be here before Track and skip ship — this is a
  // static allowlist that throws on unknown fields, so the first undo of a
  // tracked completion or a skip would 500 without them.
  'progress_target',
  'progress_current',
  // Interval quotas (2026-10-16): a period edit re-anchors the quota in the
  // same write, and its undo puts the old anchor back with the old rule.
  'progress_period_start',
  'skip_count',
  // §5: the explicit quota flag. Missing here until 2026-09-08, which was not
  // merely "undo does nothing": this allowlist THROWS on an unknown field, and
  // `undoEntry` runs inside the caller's transaction, so the throw rolled back
  // the `undone = 1` write too. The entry stayed at `undone = 0` and every
  // later Undo found it again — one retire wedged the whole stack. Reached by
  // retiring a quota (`is_tracked: false`) and by the quota editor, which
  // sends `is_tracked: true` whenever the target or period is touched.
  'is_tracked',
  // §6
  'is_reminder',
  // Quota reminders (2026-09-24). Both are JSON objects, written below with
  // their own branch — see the throw-wedges-the-stack note on `is_tracked`
  // for why missing them here is never "undo does nothing".
  'quota_prompt_config',
  'quota_day_state',
])

/**
 * 0/1 flag columns the snapshot holds as booleans: the retired nag flag, the
 * automatic target (§8), and the task queue's mark and Try Tomorrow flag.
 */
const FLAG_COLUMNS = new Set(['deadline_nag_off', 'target_auto', 'queue_mark', 'try_tomorrow'])

/** Task columns holding a JSON object; undo writes them back serialized. */
const JSON_OBJECT_COLUMNS = new Set(['quota_prompt_config', 'quota_day_state'])

/**
 * Apply a partial state to a task, updating only the specified fields.
 *
 * Used by both undo (applying before_state) and redo (applying after_state).
 * Handles backward compatibility for old undo entries with renamed fields.
 */
export function applyFieldsToTask(
  taskId: number,
  state: Partial<Task>,
  fieldsChanged: string[],
): void {
  const db = getDb()

  const setClauses: string[] = []
  const values: unknown[] = []

  for (const field of fieldsChanged) {
    // Map legacy field names to current names
    const dbColumn = LEGACY_FIELD_MAP[field] || field
    // Check both old and new field names in state object
    const stateKey = field in state ? field : dbColumn

    // Validate column name against allowlist to prevent SQL injection
    if (!VALID_TASK_COLUMNS.has(dbColumn)) {
      if (dbColumn === 'id' || dbColumn === 'created_at') continue
      throw new ValidationError(`Invalid field name in undo snapshot: ${dbColumn}`)
    }

    if (stateKey in state) {
      if (dbColumn === 'labels') {
        // Strip AI state labels to prevent re-enrichment loops when undoing
        let labels = state[stateKey as keyof Task] as string[]
        if (Array.isArray(labels)) {
          labels = labels.filter((l: string) => l !== 'ai-to-process' && l !== 'ai-failed')
        }
        setClauses.push(`${dbColumn} = ?`)
        values.push(JSON.stringify(labels))
      } else if (dbColumn === 'done') {
        setClauses.push(`${dbColumn} = ?`)
        values.push((state as { done?: boolean }).done ? 1 : 0)
      } else if (dbColumn === 'is_reminder') {
        // Same reason as `done`: SQLite has no boolean type (§6).
        setClauses.push(`${dbColumn} = ?`)
        values.push((state as { is_reminder?: boolean }).is_reminder ? 1 : 0)
      } else if (dbColumn === 'is_tracked') {
        // Same reason again (§5). The snapshot holds the domain value, because
        // `trackField` records `true`/`false` while binding 0/1 to the column —
        // so without this branch better-sqlite3 refuses the raw JS boolean.
        setClauses.push(`${dbColumn} = ?`)
        values.push((state as { is_tracked?: boolean }).is_tracked ? 1 : 0)
      } else if (FLAG_COLUMNS.has(dbColumn)) {
        // A boolean in the snapshot, 0/1 in the column. Without this an Undo
        // that names one throws and wedges the stack.
        setClauses.push(`${dbColumn} = ?`)
        values.push((state as Record<string, unknown>)[stateKey] ? 1 : 0)
      } else if (JSON_OBJECT_COLUMNS.has(dbColumn)) {
        // The snapshot holds the parsed object (rowToTask's shape);
        // better-sqlite3 cannot bind a plain object.
        const value = (state as Record<string, unknown>)[stateKey]
        setClauses.push(`${dbColumn} = ?`)
        values.push(value === null || value === undefined ? null : JSON.stringify(value))
      } else {
        setClauses.push(`${dbColumn} = ?`)
        values.push((state as Record<string, unknown>)[stateKey])
      }
    }
  }

  if (setClauses.length === 0) {
    return
  }

  setClauses.push('updated_at = ?')
  values.push(nowUtc())

  values.push(taskId)

  const sql = `UPDATE tasks SET ${setClauses.join(', ')} WHERE id = ?`
  db.prepare(sql).run(...values)
}
