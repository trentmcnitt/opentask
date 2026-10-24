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
 * ran (`rolled_over_at`); this fence covers every entry, whenever written.
 *
 * So with the switch on, undo and redo SKIP a snapshot that would write a
 * truthy `target_auto` (the field is in the entry's `fieldsChanged`), exactly
 * as `rolledOverSince` and `periodMoved` skip theirs: the task stays as it is
 * (a reopened task stays open, on its lead day), the rest of the entry still
 * applies, and the entry is marked undone (or redone) as usual — never a
 * throw, which would wedge the stack. Switch off: undo restores it, as before.
 */

import { taskQueueEnabled } from '@/core/tasks/task-queue'

/** Whether applying `state` would write `target_auto = 1` while the switch is on. */
export function restoresAutoTarget(state: object, fieldsChanged: string[]): boolean {
  return (
    taskQueueEnabled() &&
    fieldsChanged.includes('target_auto') &&
    Boolean((state as { target_auto?: unknown }).target_auto)
  )
}
