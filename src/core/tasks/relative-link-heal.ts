/**
 * A RESTORED LINK IS ALWAYS RE-VALIDATED AGAINST THE CURRENT PERIOD
 * (relative targets, 2026-10-24; docs/TASK-MODEL.md § Relative targets).
 *
 * The invariant — a linked row's `target_time` IS its period's current start
 * — is kept by every writer that resolves a link (`linkTargetTime`) and by the
 * period hooks. But undo and redo write a task's columns back exactly as an
 * entry snapshotted them, and an entry can be older than the period's current
 * state:
 *  - undo stacks are per USER: a collaborator's undo of a defer on a shared,
 *    linked task restores a link and a time from before the owner retimed (or
 *    deleted) the period since;
 *  - a fence (the rollover's `rolledOverSince`, a quota's period) can SKIP a
 *    snapshot whole — a decked repeat the rollover took off deck after a
 *    retime keeps the retime's time when the retime is undone.
 * So every undo / redo runs ONE rule over every task its entry touched
 * (snapshots applied or skipped, and a period entry's linked rows):
 *  - a link without offsets: unlinked (a link never sits alone);
 *  - a link to a period the owner no longer has: unlinked, the time kept;
 *  - a link whose time is not the period's start (or, on an open one-off,
 *    whose target is not the derivation): the row is written as the period
 *    retime writes it — an OPEN row through `collectFieldChanges` with the
 *    period sent again (`retime`: the target re-derived — a one-off's, a
 *    deadline-anchored repeat's unmoved one — attempts checkpointed,
 *    `target_set_at` kept), or unlinked keeping its time where the period's
 *    start would be refused (`retimeRefused`); a CLOSED row gets the start as
 *    its `target_time` only (its target is re-derived when reopened).
 * The heal is a consequence of the undo, not an entry of its own: nothing is
 * logged, and a later redo / undo heals again from whatever it restores.
 */
import type Database from 'better-sqlite3'
import { ValidationError } from '@/core/errors'
import { listTimeSlots } from '@/core/time-slots'
import { nowUtc } from '@/core/recurrence'
import { isDeadlineAnchored, relativeOf, relativeTargetAt } from '@/lib/task-segments'
import type { TimeSlot } from '@/lib/time-slot-assign'
import type { Task } from '@/types'
import { collectFieldChanges } from './helpers/collect-field-changes'
import { rowToTask, taskColumns, type TaskRow } from './read'
import { retimeRefused } from './relative-target'
import { rolloverTimeForUser } from './rollover-time'
import { getTargetContext } from './target-context'

/** Whether a row is closed for the period hooks: done, archived or trashed. */
function closed(task: Task): boolean {
  return task.done || task.archived_at !== null || task.deleted_at !== null
}

/** An open one-off whose target is not what its offsets derive. */
function staleOneOff(task: Task, timezone: string): boolean {
  if (task.rrule || closed(task) || !task.deadline_at || task.on_deck_day) return false
  const relative = relativeOf(task)
  if (!relative) return false
  const derived = relativeTargetAt(task.deadline_at, relative, timezone)
  return task.due_at === null || Date.parse(task.due_at) !== Date.parse(derived)
}

/** Write an open row as the retime hook would: through `collectFieldChanges`. */
function rewriteOpen(
  tx: Database.Database,
  task: Task,
  slot: TimeSlot,
  slots: readonly TimeSlot[],
): void {
  const ctx = getTargetContext(task.user_id)
  const refused = retimeRefused(task, slot.start_time, ctx.timezone)
  const collect = (input: { target_slot_id: number | null; retime: true }) =>
    collectFieldChanges({
      task,
      input,
      userId: task.user_id,
      userTimezone: ctx.timezone,
      skipProjectValidation: true,
      targetCtx: ctx,
      slotsFor: () => slots,
      rolloverTime: rolloverTimeForUser(task.user_id),
    })
  let data
  try {
    data = collect({ target_slot_id: refused ? null : slot.id, retime: true })
  } catch (err) {
    // A row some OTHER rule now refuses (a restored snapshot can be any
    // shape): never let the heal throw — a throw inside an undo rolls the
    // whole undo back and wedges the stack (see apply-fields.ts). Unlinked,
    // its time kept: the invariant holds either way.
    if (!(err instanceof ValidationError)) throw err
    tx.prepare('UPDATE tasks SET target_slot_id = NULL WHERE id = ?').run(task.id)
    return
  }
  if (data.setClauses.length === 0) return
  tx.prepare(`UPDATE tasks SET ${data.setClauses.join(', ')}, updated_at = ? WHERE id = ?`).run(
    ...data.values,
    nowUtc(),
    task.id,
  )
}

/**
 * THE RULE (see the header) over the given tasks, inside the undo / redo
 * transaction. One read of the rows, one read of each owner's periods.
 */
export function healRelativeLinks(tx: Database.Database, taskIds: Iterable<number>): void {
  const ids = [...new Set(taskIds)]
  if (ids.length === 0) return
  const rows = tx
    .prepare(
      `SELECT ${taskColumns()} FROM tasks
        WHERE target_slot_id IS NOT NULL AND id IN (${ids.map(() => '?').join(', ')})`,
    )
    .all(...ids) as TaskRow[]
  const periods = new Map<number, TimeSlot[]>()
  const slotsOf = (ownerId: number) => {
    if (!periods.has(ownerId)) periods.set(ownerId, listTimeSlots(ownerId))
    return periods.get(ownerId)!
  }
  for (const task of rows.map(rowToTask)) {
    const slots = slotsOf(task.user_id)
    const slot = slots.find((s) => s.id === task.target_slot_id)
    if (!slot || !relativeOf(task)) {
      tx.prepare('UPDATE tasks SET target_slot_id = NULL WHERE id = ?').run(task.id)
      continue
    }
    const timezone = getTargetContext(task.user_id).timezone
    const timeOff = task.target_time !== slot.start_time
    if (!timeOff && !staleOneOff(task, timezone)) continue
    if (closed(task)) {
      tx.prepare('UPDATE tasks SET target_time = ? WHERE id = ?').run(slot.start_time, task.id)
    } else if (task.rrule && !isDeadlineAnchored(task)) {
      // A target-anchored repeat has no relative target: the link goes.
      tx.prepare('UPDATE tasks SET target_slot_id = NULL WHERE id = ?').run(task.id)
    } else {
      rewriteOpen(tx, task, slot, slots)
    }
  }
}

/** The rows linked to a period (any state) — a period entry's undo / redo heals them too. */
export function rowsLinkedTo(tx: Database.Database, slotIds: Iterable<number>): number[] {
  const ids = [...new Set(slotIds)]
  if (ids.length === 0) return []
  return (
    tx
      .prepare(`SELECT id FROM tasks WHERE target_slot_id IN (${ids.map(() => '?').join(', ')})`)
      .all(...ids) as { id: number }[]
  ).map((r) => r.id)
}
