/**
 * `target_set_at` — when a task's target was last SET, by any path
 * (2026-10-12, docs/TASK-MODEL.md § Upcoming). It is the anchor of Upcoming's
 * wait: the heads-up days are counted from the local day the target was set
 * to the local day it arrives (`src/lib/task-segments.ts`).
 *
 * THE RULE: every write that changes `due_at` or `deadline_at` stamps it, in
 * the same UPDATE, and puts it in the undo snapshot so undo and redo restore
 * it. A deadline change counts because it moves the EFFECTIVE target (the
 * deadline's implied one).
 *
 * WHY A HELPER AND NOT ONE CALL SITE. `collectFieldChanges` covers update, bulk
 * edit, bulk snooze, snooze-overdue, the snooze endpoint, Today and the
 * time-slot moves, but create, a completion advance, skip, put-back
 * (`markUndone`) and AI enrichment write `due_at` with SQL of their own. Each
 * of those imports this module; the `target_set_at` writers and guard tests in
 * `tests/behavioral/up-upcoming.test.ts` (UP-080…UP-090) fail when a file
 * under `src` writes `due_at` / `deadline_at` without importing it (and
 * exercise every path), so a new writer can't skip it. The queue-state guard
 * (TQ-G10, `tests/behavioral/tq-summary.test.ts`) does the same for clearing.
 *
 * Undo / redo never stamp: they restore the snapshot's value.
 * Distinct from `segment_targeted_at` (targeted FROM a task segment only).
 *
 * THE ATTEMPTS CHECKPOINT (spec §7, 2026-10-12) rides on the same stamp. The
 * attempts read (`effectiveAttempts`) assumes the target has not moved since
 * `attempts_counted_through`; so every write that moves the target first
 * persists the count as of now, read from the row BEFORE the move (the
 * `Task` every writer already holds is read through `rowToTask`, which
 * computes it). Without it, a task that went over target at 9:00 and was
 * moved at 9:00:30, before the minute cron, would lose that day's attempt.
 * The checkpoint is an observation of the past, like the cron's, so it is
 * not in `fieldsChanged`: undo of the move restores the old target and leaves
 * the count, which is still true.
 */

import type { Task } from '@/types'

/*
 * THE QUEUE MARK RIDES ON THE SAME STAMP (task queue, 2026-10-19; spec
 * "Picks and defers"). "Any target, auto included, clears the queue mark. A
 * pick clears the mark." So every write that moves the target also clears
 * `queue_mark`, `try_tomorrow` and `queued_at` (a queued task that gets a
 * target leaves the queue, spec rule 8). The defer that SETS the mark
 * (`bulkSnooze`) writes `queue_mark` / `try_tomorrow` itself and passes
 * `keepQueue`, so those two are left to it — `queued_at` is cleared even
 * then. `queued_from_due_at` is left alone: it is the remembered
 * original target. Only the fields that are actually set are written into the
 * snapshot, so a task with no queue state gets no noise fields.
 *
 * The fixed-SQL writers (completion advance, skip, put-back) clear them in
 * their own statements, with `QUEUE_CLEAR_SQL` and `queueStateToClear`. Done
 * of a one-off clears the mark and the flag too (its row leaves every list).
 */

/** The queue columns a target write clears, as a SQL fragment (always safe to run). */
export const QUEUE_CLEAR_SQL = 'queue_mark = 0, try_tomorrow = 0, queued_at = NULL'

/**
 * RULE TGT-ATTEMPTS-RESET: Done of a one-off, and done or skip of a repeat, set attempts to 0 and
 *   clear the checkpoint; the completion row keeps the count. Removing the target freezes the
 *   count, and the queue strip keeps it. Put-back restores the count.
 * Why: A new occurrence is a new debt, and the completion row keeps the old count. One fragment, so
 *   the fixed-SQL writers cannot drift.
 * Ruling: Spec §7, 2026-10-12; no reset on the strip, B7 2026-10-19.
 * Restated at: src/core/tasks/task-rollover.ts (rollRepeating's skipped roll).
 */
export const ATTEMPTS_RESET_SQL = 'attempts = 0, attempts_counted_through = NULL'

type QueueState = Pick<Task, 'queue_mark' | 'try_tomorrow' | 'queued_at'>

/**
 * The queue fields this task has SET, and the cleared values — for a snapshot.
 * Empty when the task has no queue state (nothing to restore on undo).
 */
export function queueStateToClear(
  task: Partial<QueueState>,
  /** false: only the mark and the flag (done of a one-off: no target, so `queued_at` stays). */
  { includeQueued = true }: { includeQueued?: boolean } = {},
): {
  fields: (keyof QueueState)[]
  before: Partial<QueueState>
  after: Partial<QueueState>
} {
  const fields: (keyof QueueState)[] = []
  const before: Partial<QueueState> = {}
  const after: Partial<QueueState> = {}
  if (task.queue_mark) {
    fields.push('queue_mark')
    before.queue_mark = true
    after.queue_mark = false
  }
  if (task.try_tomorrow) {
    fields.push('try_tomorrow')
    before.try_tomorrow = true
    after.try_tomorrow = false
  }
  if (includeQueued && task.queued_at) {
    fields.push('queued_at')
    before.queued_at = task.queued_at
    after.queued_at = null
  }
  return { fields, before, after }
}

/** The column, for the writers whose SQL is a fixed statement. */
export const TARGET_SET_FIELD = 'target_set_at'

/** Whether a write that changed these fields moves the target (and so must stamp). */
export function movesTarget(fieldsChanged: readonly string[]): boolean {
  return fieldsChanged.includes('due_at') || fieldsChanged.includes('deadline_at')
}

/** A write being collected clause by clause (`collectFieldChanges`, enrichment). */
export interface CollectedWrite {
  setClauses: string[]
  values: unknown[]
  fieldsChanged: string[]
  beforeState?: Partial<Task>
  afterState?: Partial<Task>
}

/**
 * RULE TGT-SET-AT: Every write that changes due_at or deadline_at stamps target_set_at in the same
 *   UPDATE and undo snapshot. It anchors Upcoming's wait. A new deck day also stamps it, while a
 *   period retime keeps it. Undo and redo restore it and never stamp. Rows from before the column
 *   read created_at instead, or a repeat's later last completion.
 * Why: It is the anchor of Upcoming's wait, and undo and redo must restore it, so it rides in the
 *   same write and snapshot (the module comment).
 * Ruling: 2026-10-12 (src/core/tasks/target-set.ts:3); keepSetAt: relative-targets decision 11,
 *   2026-10-24.
 * Restated at: src/lib/task-segments.ts (targetSetAtOf).
 */
/**
 * RULE TGT-ATTEMPTS-CHECKPOINT: Before a write moves due_at or deadline_at, it saves the attempt
 *   count as of now, read from the row before the move. The minute cron saves the stored columns
 *   for every target that has arrived. Neither creates an undo entry, bumps updated_at or emits a
 *   sync event.
 * Why: Without it, a task that went over target and was moved before the minute cron would lose
 *   that day's attempt.
 * Ruling: Spec §7, 2026-10-12.
 */
/**
 * RULE TQ-CLEAR-ON-TARGET: Every write that changes due_at or deadline_at clears queue_mark,
 *   try_tomorrow and queued_at in the same write and snapshot, and keeps queued_from_due_at. The
 *   defer that sets the mark keeps it. A deck write leaves the queue the same way and stamps
 *   target_set_at, but only when the day changes. Fixed-SQL writers use QUEUE_CLEAR_SQL.
 * Why: A queued task that gets a target leaves the queue (spec rule 8), and one write keeps the
 *   undo whole.
 * Ruling: Spec 'Picks and defers' and rule 8 (quoted at src/core/tasks/target-set.ts:41); B8, A6
 *   for decks.
 */
/**
 * Add `target_set_at = now` to a collected write when it moves the target.
 * Pushes the clause and its value together (they are bound in order), the
 * field, and — when the write keeps snapshot states — the before/after
 * values, so the undo entry restores it. Returns whether it stamped.
 */
export function stampTargetSet(
  write: CollectedWrite,
  task: Pick<Task, 'target_set_at'> &
    Partial<Pick<Task, 'attempts' | 'attempts_counted_through'> & QueueState>,
  nowStr: string,
  /**
   * `deck`: this write puts the task ON DECK (2026-10-20). A deck is a plan
   * for a day, like a picked target, so it stamps too even when `due_at` does
   * not move (A6: `target_set_at` is the deck's heads-up anchor), and clears
   * the queue state (rule 3, B8: decking a queued task takes it out).
   */
  /**
   * `keepSetAt` (relative targets, 2026-10-24): a period RETIME moves linked
   * targets without the user setting one (decision 11) — the attempts
   * checkpoint and the queue clear still run, but `target_set_at` (the
   * heads-up anchor) stays as it was. Returns false (nothing stamped).
   */
  opts: { keepQueue?: boolean; deck?: boolean; keepSetAt?: boolean } = {},
): boolean {
  if (
    !(opts.deck || movesTarget(write.fieldsChanged)) ||
    write.fieldsChanged.includes(TARGET_SET_FIELD)
  ) {
    return false
  }
  // The queue state (see above): a target write clears it. The defer that
  // sets the mark keeps the mark and the flag (it wrote them itself) — but
  // never `queued_at`: a task that gets a target leaves the queue, the
  // defer's own write included (spec rule 8; Try Tomorrow on a queued task).
  const keepMark = opts.keepQueue || write.fieldsChanged.includes('queue_mark')
  const clear = queueStateToClear(task)
  for (const field of clear.fields) {
    if (keepMark && field !== 'queued_at') continue
    write.setClauses.push(field === 'queued_at' ? 'queued_at = NULL' : `${field} = 0`)
    write.fieldsChanged.push(field)
    if (write.beforeState) Object.assign(write.beforeState, { [field]: clear.before[field] })
    if (write.afterState) Object.assign(write.afterState, { [field]: clear.after[field] })
  }
  if (typeof task.attempts === 'number' && !write.fieldsChanged.includes('attempts')) {
    write.setClauses.push('attempts = ?', 'attempts_counted_through = ?')
    write.values.push(task.attempts, task.attempts_counted_through ?? null)
  }
  if (opts.keepSetAt) return false
  write.setClauses.push(`${TARGET_SET_FIELD} = ?`)
  write.values.push(nowStr)
  write.fieldsChanged.push(TARGET_SET_FIELD)
  if (write.beforeState) write.beforeState.target_set_at = task.target_set_at
  if (write.afterState) write.afterState.target_set_at = nowStr
  return true
}
