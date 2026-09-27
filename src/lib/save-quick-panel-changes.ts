import type { QuickActionPanelChanges } from '@/components/QuickActionPanel'
import { saveTaskChanges } from '@/lib/save-task-changes'

export interface SaveQuickPanelChangesResult {
  /** Server-provided description of what changed (for toast + undo log) */
  description?: string
  /** Number of tasks that were successfully updated */
  tasksAffected: number
  /** Tasks skipped because they had no due date (relative snooze on multi-task) */
  skippedNoDueDate?: number
}

/** The one request a quick-panel save turns into — see `planQuickPanelSave`. */
export type QuickPanelSaveRequest =
  | { kind: 'patch'; taskId: number; body: QuickActionPanelChanges }
  | { kind: 'bulk'; url: '/api/tasks/bulk/snooze' | '/api/tasks/bulk/edit'; body: object }

/**
 * Single entry point for persisting QuickActionPanel changes — used by both
 * the desktop QuickActionPopover (single task) and the mobile SelectionActionSheet
 * (1..N tasks). Unifying on one utility guarantees the two mount points stay
 * in sync and prevents the "works on desktop, silently fails on mobile" class
 * of bug that led to this refactor.
 *
 * `dateTaskIds`, when given, scopes the date part of the change to a subset of
 * `taskIds` (the snooze confirmation dialog opted the others out); every other
 * field still applies to all of `taskIds`.
 */
export async function saveQuickPanelChanges(
  taskIds: number[],
  changes: QuickActionPanelChanges,
  dateTaskIds?: number[],
): Promise<SaveQuickPanelChangesResult> {
  const plan = planQuickPanelSave(taskIds, changes, dateTaskIds)
  if (!plan) return { tasksAffected: 0 }

  if (plan.kind === 'patch') {
    const result = await saveTaskChanges(plan.taskId, plan.body)
    return { description: result.description, tasksAffected: 1 }
  }

  const res = await fetch(plan.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(plan.body),
  })
  const json = (await res.json().catch(() => null)) as {
    data?: { tasks_affected?: number; skipped_no_due_date?: number }
    error?: string
  } | null
  if (!res.ok) throw new Error(json?.error || 'Bulk save failed')
  const skipped = json?.data?.skipped_no_due_date ?? 0
  return {
    tasksAffected: json?.data?.tasks_affected ?? taskIds.length,
    skippedNoDueDate: skipped > 0 ? skipped : undefined,
  }
}

/**
 * Decide the ONE request a quick-panel save becomes. Pure, so it is tested
 * without a server (tests/behavioral/quick-panel-save.test.ts).
 *
 * ONE SAVE, ONE REQUEST, ONE UNDO (Trent, 2026-09-27). A multi-task save that
 * changed the date AND something else used to fire bulk/snooze and bulk/edit
 * together (`Promise.all`): two undo entries whose order was a race — Undo
 * put back only whichever landed last — and a partial failure left half the
 * change applied. The dashboard also split a date scoped to a subset of the
 * selection into a second, parallel save. Now:
 *
 * - One task → PATCH /api/tasks/:id carrying every field (always was one
 *   request). Never a bulk endpoint, so the High/Urgent sweep filter cannot
 *   drop it. `delta_minutes` never reaches it (the panel converts a relative
 *   move to an absolute date for one task; with no date to move there is
 *   nothing to send) and additive label diffs are dropped — the single panel
 *   sends the full `labels` list.
 * - Several tasks, ONLY a date → bulk/snooze, exactly as before: its snooze
 *   bookkeeping (snooze_count, original_due_at, the snooze stat and the
 *   `task.snoozed` webhook) is unchanged for the common case.
 * - Several tasks, a date plus anything else (or a date clear) → bulk/edit,
 *   one request: the date rides in `changes.due_at` or `delta_minutes`, with
 *   `date_task_ids` for a subset. The server applies the date per task with
 *   the same rules bulk/snooze had (see `planBulkEditDates`) and the rest to
 *   every task, in one transaction and one undo entry. Picking a date and
 *   `reset_original_due_at` now land together, so the new date becomes the
 *   origin — before, the reset raced the snooze and read whichever date the
 *   task had at that moment.
 * - `include_task_ids` rides every date-bearing bulk request, so explicit
 *   picks bypass the High/Urgent filter. (The "Snooze All Overdue" sweep is
 *   the only caller that omits it.)
 */
export function planQuickPanelSave(
  taskIds: number[],
  changes: QuickActionPanelChanges,
  dateTaskIds?: number[],
): QuickPanelSaveRequest | null {
  if (taskIds.length === 0) {
    throw new Error('saveQuickPanelChanges requires at least one task ID')
  }

  const dateIds = dateTaskIds ?? taskIds
  const hasDate =
    (changes.due_at !== undefined || changes.delta_minutes !== undefined) && dateIds.length > 0

  if (taskIds.length === 1) {
    const {
      delta_minutes: _delta,
      labels_add: _add,
      labels_remove: _remove,
      due_at,
      ...patchChanges
    } = changes
    void _delta
    void _add
    void _remove
    const body: QuickActionPanelChanges =
      hasDate && due_at !== undefined && dateIds.includes(taskIds[0])
        ? { ...patchChanges, due_at }
        : patchChanges
    if (Object.keys(body).length === 0) return null
    return { kind: 'patch', taskId: taskIds[0], body }
  }

  const edit = editFields(changes)
  const hasEdit = Object.keys(edit).length > 0

  if (hasDate && !hasEdit && changes.due_at !== null) {
    const move =
      changes.due_at !== undefined
        ? { until: changes.due_at }
        : { delta_minutes: changes.delta_minutes }
    return {
      kind: 'bulk',
      url: '/api/tasks/bulk/snooze',
      body: { ids: dateIds, ...move, include_task_ids: dateIds },
    }
  }

  if (!hasDate && !hasEdit) return null

  const body: Record<string, unknown> = { ids: taskIds, changes: edit }
  if (hasDate) {
    if (changes.due_at !== undefined) edit.due_at = changes.due_at
    else body.delta_minutes = changes.delta_minutes
    body.include_task_ids = dateIds
    if (dateTaskIds && !sameIds(dateTaskIds, taskIds)) body.date_task_ids = dateTaskIds
  }
  return { kind: 'bulk', url: '/api/tasks/bulk/edit', body }
}

function sameIds(a: number[], b: number[]): boolean {
  const set = new Set(b)
  return a.length === b.length && a.every((id) => set.has(id))
}

/**
 * The non-date fields of a multi-task save, as bulk/edit takes them. Labels
 * use additive mode (labels_add / labels_remove) so tasks keep labels that
 * aren't in the bulk intersection; an empty diff is no change.
 */
function editFields(changes: QuickActionPanelChanges): Record<string, unknown> {
  const edit: Record<string, unknown> = {}
  if (changes.title !== undefined) edit.title = changes.title
  if (changes.priority !== undefined) edit.priority = changes.priority
  if (changes.labels !== undefined) edit.labels = changes.labels
  if (changes.labels_add !== undefined && changes.labels_add.length > 0) {
    edit.labels_add = changes.labels_add
  }
  if (changes.labels_remove !== undefined && changes.labels_remove.length > 0) {
    edit.labels_remove = changes.labels_remove
  }
  if (changes.rrule !== undefined) edit.rrule = changes.rrule
  if (changes.recurrence_mode !== undefined) edit.recurrence_mode = changes.recurrence_mode
  if (changes.project_id !== undefined) edit.project_id = changes.project_id
  if (changes.auto_snooze_minutes !== undefined) {
    edit.auto_snooze_minutes = changes.auto_snooze_minutes
  }
  if (changes.reset_original_due_at !== undefined) {
    edit.reset_original_due_at = changes.reset_original_due_at
  }
  if (changes.notes !== undefined) edit.notes = changes.notes
  return edit
}
