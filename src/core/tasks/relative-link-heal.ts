/**
 * A RESTORED RELATIVE TARGET IS ALWAYS RE-VALIDATED (relative targets,
 * 2026-10-24; docs/TASK-MODEL.md § Relative targets).
 *
 * Two invariants: a linked row's `target_time` IS its period's current start,
 * and an open relative one-off's `due_at` IS `relativeTargetAt(deadline,
 * offsets)` (clamped to the deadline). Every writer that resolves a link
 * (`linkTargetTime`) or a deadline keeps them, and so do the period hooks.
 * But undo and redo write a task's columns back exactly as an entry
 * snapshotted them, and an entry can be older than the task's or the
 * period's current state:
 *  - undo stacks are per USER: a collaborator's undo on a shared task
 *    restores a link, a time or a deadline from before the owner retimed (or
 *    deleted) the period, or before another write moved the target;
 *  - a fence (the rollover's `rolledOverSince`, a quota's period) can SKIP a
 *    snapshot whole — a decked repeat the rollover took off deck after a
 *    retime keeps the retime's time when the retime is undone.
 * So every undo / redo runs ONE rule over every task its entry touched
 * (snapshots applied or skipped, and a period entry's linked rows):
 *  - a link without offsets, or to a period the owner no longer has:
 *    unlinked, the time kept;
 *  - a CLOSED linked row: its `target_time` set to the period's start (its
 *    target is re-derived when reopened);
 *  - an OPEN deadline-anchored repeat whose linked time is not the period's
 *    start: written as the period retime writes it (the period sent again,
 *    its unmoved target re-derived), or unlinked keeping its time where the
 *    start would be refused (`retimeRefused`); a target-anchored repeat's
 *    link goes;
 *  - an OPEN relative ONE-OFF, linked or custom: its time — the period's
 *    start while linked, unless that start is now after the deadline on the
 *    deadline day (then unlinked) — clamped to the deadline's time on the
 *    deadline day, and its target re-derived from it, whenever the time, the
 *    link or the target differs.
 * Every open write goes through `collectFieldChanges` with `retime` — attempts
 * checkpointed, `target_set_at` kept, never a snooze. The heal is a
 * consequence of the undo, not an entry of its own: nothing is logged in the
 * undo log, and a later redo / undo heals again from whatever it restores.
 */
import type Database from 'better-sqlite3'
import { DateTime } from 'luxon'
import { ValidationError } from '@/core/errors'
import { listTimeSlots } from '@/core/time-slots'
import { nowUtc } from '@/core/recurrence'
import { log } from '@/lib/logger'
import {
  isDeadlineAnchored,
  isRelativeOneOff,
  relativeOf,
  relativeOneOffProblem,
  relativeTargetAt,
} from '@/lib/task-segments'
import type { TimeSlot } from '@/lib/time-slot-assign'
import type { Task } from '@/types'
import { collectFieldChanges, type FieldChangesInput } from './helpers/collect-field-changes'
import { rowToTask, taskColumns, type TaskRow } from './read'
import { retimeRefused } from './relative-target'
import { rolloverTimeForUser } from './rollover-time'
import { getTargetContext } from './target-context'

/** Whether a row is closed for the period hooks: done, archived or trashed. */
function closed(task: Task): boolean {
  return task.done || task.archived_at !== null || task.deleted_at !== null
}

function unlink(tx: Database.Database, task: Task): void {
  tx.prepare('UPDATE tasks SET target_slot_id = NULL WHERE id = ?').run(task.id)
}

/**
 * Write an open row as the retime hook would: `input` through
 * `collectFieldChanges` with `retime`. A row some OTHER rule now refuses (a
 * restored snapshot can be any shape) is unlinked and logged, never thrown:
 * a throw inside an undo rolls the whole undo back and wedges the stack
 * (see apply-fields.ts).
 */
function rewrite(
  tx: Database.Database,
  task: Task,
  input: FieldChangesInput,
  slots: readonly TimeSlot[],
): void {
  const ctx = getTargetContext(task.user_id)
  let data
  try {
    data = collectFieldChanges({
      task,
      input: { ...input, retime: true },
      userId: task.user_id,
      userTimezone: ctx.timezone,
      skipProjectValidation: true,
      targetCtx: ctx,
      slotsFor: () => slots,
      rolloverTime: rolloverTimeForUser(task.user_id),
    })
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err
    log.warn('undo', `relative-target heal refused for task ${task.id}: ${err.message}`)
    if (task.target_slot_id !== null) unlink(tx, task)
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
 * An open relative ONE-OFF (linked or custom): the time it should carry —
 * the period's start while linked and allowed, clamped to the deadline's
 * time on the deadline day (as a deadline move clamps the target) — and its
 * derived target. Rewritten whenever the time, the link or the target is off.
 */
function healOneOff(
  tx: Database.Database,
  task: Task,
  slot: TimeSlot | undefined,
  slots: readonly TimeSlot[],
): void {
  const timezone = getTargetContext(task.user_id).timezone
  const deadline = task.deadline_at!
  const days = task.target_days_before!
  let time = task.target_time!
  let link = slot ? slot.id : null
  if (slot) {
    const refused = relativeOneOffProblem(
      { days_before: days, time: slot.start_time },
      deadline,
      timezone,
    )
    if (refused) link = null
    else time = slot.start_time
  }
  if (relativeOneOffProblem({ days_before: days, time }, deadline, timezone)) {
    time = DateTime.fromISO(deadline, { zone: 'utc' }).setZone(timezone).toFormat('HH:mm')
  }
  const derived = relativeTargetAt(deadline, { days_before: days, time }, timezone)
  const onTarget = task.due_at !== null && Date.parse(task.due_at) === Date.parse(derived)
  if (onTarget && time === task.target_time && link === task.target_slot_id) return
  rewrite(tx, task, { target_slot_id: link, target_days_before: days, target_time: time }, slots)
}

/** One row (see the header). */
function healOne(tx: Database.Database, task: Task, slots: readonly TimeSlot[]): void {
  const slot =
    task.target_slot_id !== null ? slots.find((s) => s.id === task.target_slot_id) : undefined
  if (task.target_slot_id !== null && (!slot || !relativeOf(task))) {
    unlink(tx, task)
    task = { ...task, target_slot_id: null }
  }
  if (closed(task)) {
    if (slot && task.target_slot_id !== null && task.target_time !== slot.start_time) {
      tx.prepare('UPDATE tasks SET target_time = ? WHERE id = ?').run(slot.start_time, task.id)
    }
    return
  }
  if (!task.rrule) {
    if (isRelativeOneOff(task) && !task.on_deck_day) {
      healOneOff(tx, task, task.target_slot_id !== null ? slot : undefined, slots)
    }
    return
  }
  if (task.target_slot_id === null || !slot || task.target_time === slot.start_time) return
  if (!isDeadlineAnchored(task)) return unlink(tx, task)
  const timezone = getTargetContext(task.user_id).timezone
  const refused = retimeRefused(task, slot.start_time, timezone)
  rewrite(tx, task, { target_slot_id: refused ? null : slot.id }, slots)
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
        WHERE (target_slot_id IS NOT NULL OR target_days_before IS NOT NULL)
          AND id IN (${ids.map(() => '?').join(', ')})`,
    )
    .all(...ids) as TaskRow[]
  const periods = new Map<number, TimeSlot[]>()
  const slotsOf = (ownerId: number) => {
    if (!periods.has(ownerId)) periods.set(ownerId, listTimeSlots(ownerId))
    return periods.get(ownerId)!
  }
  for (const task of rows.map(rowToTask)) healOne(tx, task, slotsOf(task.user_id))
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
