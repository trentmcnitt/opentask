/**
 * The compensating `progress_events` row an undo or redo of a quota count
 * writes (2026-10-16).
 *
 * `progress_events` is the history of what was logged against a quota, and
 * until this existed an undo put `progress_current` back without touching it:
 * an undone +1 stayed in the history as a +1 nobody meant, and a sum over the
 * events (`loggedSince`, the rollover's carry-forward) disagreed with the
 * count. Now the undo writes the opposite row — `source: 'undo'` — and a redo
 * writes it again — `source: 'redo'` — in the SAME transaction as the count
 * moving, so the events always sum to the count's movement.
 *
 * Only a quota-count snapshot (`createQuotaSnapshot`: a +1/−1, a prompt's
 * did-it or put-back) compensates, and only when the count actually moved:
 * the delta is what the undo DID to `progress_current` (read before and
 * after), not the original tap's delta, so a clamp at zero or a skipped
 * period (`periodMoved`) writes exactly what happened — nothing, in the
 * latter case, since the caller skips the snapshot. Other count changes (an
 * early `close_period` resetting to 0) never wrote an event, so their undo
 * writes none either.
 */
import type Database from 'better-sqlite3'
import { nowUtc } from '@/core/recurrence'
import { PERIOD_WITNESS_KEY } from './log-action'
import type { UndoSnapshot } from '@/types'

/** The count before an undo/redo applies `snapshot`, or null if it does not compensate. */
export function countBefore(
  tx: Database.Database,
  snapshot: UndoSnapshot,
  fieldsChanged: string[],
): number | null {
  const before = snapshot.before_state as Record<string, unknown>
  if (!(PERIOD_WITNESS_KEY in before) || !('progress_current' in before)) return null
  if (!fieldsChanged.includes('progress_current')) return null
  return readCount(tx, snapshot.task_id)
}

/** Write the row for how far the count moved since `countBefore`. */
export function compensate(
  tx: Database.Database,
  undoLogId: number,
  snapshot: UndoSnapshot,
  before: number | null,
  source: 'undo' | 'redo',
): void {
  if (before === null) return
  const delta = (readCount(tx, snapshot.task_id) ?? before) - before
  if (delta === 0) return
  const owner = tx.prepare('SELECT user_id FROM undo_log WHERE id = ?').get(undoLogId) as
    | { user_id: number }
    | undefined
  if (!owner) return
  tx.prepare(
    'INSERT INTO progress_events (task_id, user_id, delta, logged_at, source) VALUES (?, ?, ?, ?, ?)',
  ).run(snapshot.task_id, owner.user_id, delta, nowUtc(), source)
}

function readCount(tx: Database.Database, taskId: number): number | null {
  const row = tx.prepare('SELECT progress_current FROM tasks WHERE id = ?').get(taskId) as
    | { progress_current: number | null }
    | undefined
  return row ? (row.progress_current ?? 0) : null
}
