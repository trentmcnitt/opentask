/**
 * NO AUTOMATIC TARGET COMES BACK THROUGH UNDO (2026-10-24; the deadlines
 * page, docs/TASK-MODEL.md § The deadlines page).
 *
 * With the task-queue switch on, nothing writes `target_auto = 1` (Trent:
 * "no fakes"): a deadline with no target is on the deadlines page, never on
 * an automatic target. Undo and redo write a snapshot's state back, and a
 * snapshot can still hold one — the BEFORE of a reopen or restore that
 * converted a pre-10-22 automatic target (`autoTargetToLead`: its truthful
 * before is `target_auto: true`), or either side of an entry written with the
 * switch off. `migrateDeadlineLeads` fences the entries that existed when it
 * ran (`rolled_over_at`); this covers every entry, whenever written.
 *
 * So with the switch on, a snapshot that would write a truthy `target_auto`
 * (the field is in the entry's `fieldsChanged`) is applied WITHOUT the
 * automatic target (`withoutAutoTarget`): `due_at`, `original_due_at` → NULL
 * and `target_auto` → 0 are written in place of the snapshot's values — and
 * the queue state cleared (`queued_at` NULL, `try_tomorrow` / `queue_mark` 0,
 * as `autoTargetToLead` does: a deadline task is never queued), and the
 * relative target's offsets and link (2026-10-24: never on a row the fence
 * hits — a relative target is never automatic — but nulled so none can
 * appear beside the dropped target) — and every other field is restored as usual — the task comes back done, trashed
 * or open, exactly as the undo means, with no target. Undo over a dead Undo
 * (Trent's rule): the user's Undo always does what it says. The dropped
 * target never becomes a picked one: `target_auto` stays 0, `due_at` NULL,
 * and `target_set_at` is not stamped (only restored, if the entry holds it).
 *
 * A deadline one-off with no target belongs on the deadlines page, so if the
 * restore leaves it without a lead day (`lead_from` NULL: the snapshot's
 * before predates the page), it gets the one the page derives (`leadFor`,
 * via `oneOffLeadFrom`) — the same as the startup step — rather than waiting
 * for the next restart (`ensureLead`).
 *
 * Switch off: undo restores the automatic target, as before.
 */

import type Database from 'better-sqlite3'
import { taskQueueEnabled } from '@/core/tasks/task-queue'
import { oneOffLeadFrom } from '@/core/tasks/auto-target-lead'

/** Whether applying `state` would write `target_auto = 1` while the switch is on. */
export function restoresAutoTarget(state: object, fieldsChanged: string[]): boolean {
  return (
    taskQueueEnabled() &&
    fieldsChanged.includes('target_auto') &&
    Boolean((state as { target_auto?: unknown }).target_auto)
  )
}

const DROPPED = [
  'due_at',
  'original_due_at',
  'target_auto',
  'queued_at',
  'try_tomorrow',
  'queue_mark',
  // Relative targets (2026-10-24): a dropped automatic target leaves no
  // relative target either — the offsets and the link go too, so the task is
  // a plain target-less deadline task (an automatic target was a one-off's,
  // and a one-off with offsets would read as relative).
  'target_days_before',
  'target_time',
  'target_slot_id',
] as const

/**
 * The state and fields to apply: as given, or — when it would restore an
 * automatic target with the switch on — the same with the target dropped.
 */
export function withoutAutoTarget<S extends object>(
  state: S,
  fieldsChanged: string[],
): { state: S; fields: string[]; dropped: boolean } {
  if (!restoresAutoTarget(state, fieldsChanged)) {
    return { state, fields: fieldsChanged, dropped: false }
  }
  return {
    state: {
      ...state,
      due_at: null,
      original_due_at: null,
      target_auto: false,
      // A deadline task is never queued (as autoTargetToLead): no queue state
      // comes back with it, or it would strand in the queue with no target.
      queued_at: null,
      try_tomorrow: false,
      queue_mark: false,
      target_days_before: null,
      target_time: null,
      target_slot_id: null,
    },
    fields: [...new Set([...fieldsChanged, ...DROPPED])],
    dropped: true,
  }
}

interface LeadRow {
  user_id: number
  deadline_at: string | null
  due_at: string | null
  rrule: string | null
  lead_from: string | null
  lead_days: number | null
  is_reminder: number
  is_tracked: number
  progress_target: number
}

/** After a dropped automatic target: a deadline one-off with no lead day gets one. */
export function ensureLead(tx: Database.Database, taskId: number, now: Date = new Date()): void {
  const row = tx
    .prepare(
      `SELECT user_id, deadline_at, due_at, rrule, lead_from, lead_days, is_reminder, is_tracked,
              progress_target FROM tasks WHERE id = ?`,
    )
    .get(taskId) as LeadRow | undefined
  if (!row || !row.deadline_at || row.due_at || row.rrule || row.lead_from) return
  if (row.is_reminder || row.is_tracked || row.progress_target > 1) return
  const leadFrom = oneOffLeadFrom({ ...row, deadline_at: row.deadline_at }, now)
  if (leadFrom) tx.prepare('UPDATE tasks SET lead_from = ? WHERE id = ?').run(leadFrom, taskId)
}
