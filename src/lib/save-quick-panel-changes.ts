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

/**
 * Single entry point for persisting QuickActionPanel changes — used by both
 * the desktop QuickActionPopover (single task) and the mobile SelectionActionSheet
 * (1..N tasks). Unifying on one utility guarantees the two mount points stay
 * in sync and prevents the "works on desktop, silently fails on mobile" class
 * of bug that led to this refactor.
 *
 * Routing rules:
 * - `taskIds.length === 1` → PATCH /api/tasks/:id (same path the desktop popover
 *   has always used). Never goes through bulk endpoints, so the P4/Urgent skip
 *   filter in `bulkSnooze` cannot drop the task.
 * - `taskIds.length > 1` → fans out to /api/tasks/bulk/snooze (date operations)
 *   and /api/tasks/bulk/edit (priority/labels/project/recurrence/etc.). For
 *   the snooze call we always pass `include_task_ids: taskIds` so explicit
 *   user selections bypass the default P4 skip. (The "Snooze All Overdue"
 *   sweep remains the only caller that omits `include_task_ids` and therefore
 *   still leaves urgent tasks alone.)
 *
 * `changes.delta_minutes` is accepted as a bulk-only relative snooze input.
 * For single-task saves, the panel converts relative deltas to an absolute
 * due_at before calling this function, so we never route a delta through a
 * single PATCH.
 */
export async function saveQuickPanelChanges(
  taskIds: number[],
  changes: QuickActionPanelChanges,
): Promise<SaveQuickPanelChangesResult> {
  if (taskIds.length === 0) {
    throw new Error('saveQuickPanelChanges requires at least one task ID')
  }

  if (taskIds.length === 1) {
    return saveSingleTaskPanelChanges(taskIds[0], changes)
  }

  return saveBulkPanelChanges(taskIds, changes)
}

/**
 * Single-task path: delegate to the existing PATCH helper. `delta_minutes`
 * should never reach here (the panel converts to absolute due_at for single
 * tasks), but strip it defensively so the PATCH body validator doesn't choke.
 * Additive label diffs are also stripped — single PATCH uses the full label set.
 */
async function saveSingleTaskPanelChanges(
  taskId: number,
  changes: QuickActionPanelChanges,
): Promise<SaveQuickPanelChangesResult> {
  const {
    delta_minutes: _delta,
    labels_add: _add,
    labels_remove: _remove,
    ...patchChanges
  } = changes
  void _delta
  void _add
  void _remove
  if (Object.keys(patchChanges).length === 0) {
    return { tasksAffected: 0 }
  }
  const result = await saveTaskChanges(taskId, patchChanges)
  return { description: result.description, tasksAffected: 1 }
}

/**
 * Multi-task path: split changes into a date-op bucket and an edit bucket and
 * fan out to the bulk endpoints.
 */
async function saveBulkPanelChanges(
  taskIds: number[],
  changes: QuickActionPanelChanges,
): Promise<SaveQuickPanelChangesResult> {
  const requests: Promise<Response>[] = []

  const dateRequest = buildDateRequest(taskIds, changes)
  if (dateRequest) requests.push(dateRequest)

  const editRequest = buildEditRequest(taskIds, changes)
  if (editRequest) requests.push(editRequest)

  if (requests.length === 0) {
    return { tasksAffected: 0 }
  }

  const responses = await Promise.all(requests)
  for (const res of responses) {
    if (!res.ok) throw new Error('Bulk save failed')
  }

  return aggregateBulkResults(responses, taskIds.length)
}

/**
 * Build the bulk request for date changes. A null `due_at` clears the date —
 * bulk/snooze can't express "clear", so route clears through bulk/edit instead.
 * Absolute (`due_at`) and relative (`delta_minutes`) snoozes always pass
 * `include_task_ids` so the P4/Urgent skip filter is bypassed for explicit
 * user selections.
 */
function buildDateRequest(
  taskIds: number[],
  changes: QuickActionPanelChanges,
): Promise<Response> | null {
  if (changes.due_at === null) {
    return fetch('/api/tasks/bulk/edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: taskIds, changes: { due_at: null } }),
    })
  }
  if (changes.due_at !== undefined) {
    return fetch('/api/tasks/bulk/snooze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ids: taskIds,
        until: changes.due_at,
        include_task_ids: taskIds,
      }),
    })
  }
  if (changes.delta_minutes !== undefined) {
    return fetch('/api/tasks/bulk/snooze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ids: taskIds,
        delta_minutes: changes.delta_minutes,
        include_task_ids: taskIds,
      }),
    })
  }
  return null
}

/**
 * Build the bulk/edit request for non-date fields. Labels use additive mode
 * (labels_add / labels_remove) so tasks keep labels that aren't in the bulk
 * intersection.
 */
function buildEditRequest(
  taskIds: number[],
  changes: QuickActionPanelChanges,
): Promise<Response> | null {
  const editChanges: Record<string, unknown> = {}
  if (changes.title !== undefined) editChanges.title = changes.title
  if (changes.priority !== undefined) editChanges.priority = changes.priority
  if (changes.labels !== undefined) editChanges.labels = changes.labels
  if (changes.labels_add !== undefined && changes.labels_add.length > 0) {
    editChanges.labels_add = changes.labels_add
  }
  if (changes.labels_remove !== undefined && changes.labels_remove.length > 0) {
    editChanges.labels_remove = changes.labels_remove
  }
  if (changes.rrule !== undefined) editChanges.rrule = changes.rrule
  if (changes.recurrence_mode !== undefined) editChanges.recurrence_mode = changes.recurrence_mode
  if (changes.project_id !== undefined) editChanges.project_id = changes.project_id
  if (changes.auto_snooze_minutes !== undefined) {
    editChanges.auto_snooze_minutes = changes.auto_snooze_minutes
  }
  if (changes.reset_original_due_at !== undefined) {
    editChanges.reset_original_due_at = changes.reset_original_due_at
  }
  if (changes.notes !== undefined) editChanges.notes = changes.notes

  if (Object.keys(editChanges).length === 0) return null

  return fetch('/api/tasks/bulk/edit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: taskIds, changes: editChanges }),
  })
}

/**
 * Aggregate bulk responses into a single result object. Uses the smallest
 * `tasks_affected` from the endpoints so the toast reflects the actual subset
 * that received the date change.
 */
async function aggregateBulkResults(
  responses: Response[],
  fallbackCount: number,
): Promise<SaveQuickPanelChangesResult> {
  let skippedNoDueDate = 0
  let tasksAffected = fallbackCount
  for (const res of responses) {
    try {
      const data = await res.clone().json()
      if (typeof data?.data?.skipped_no_due_date === 'number') {
        skippedNoDueDate += data.data.skipped_no_due_date
      }
      if (typeof data?.data?.tasks_affected === 'number') {
        tasksAffected = Math.min(tasksAffected, data.data.tasks_affected)
      }
    } catch {
      // Response body may have already been consumed or not JSON — ignore.
    }
  }
  return {
    tasksAffected,
    skippedNoDueDate: skippedNoDueDate > 0 ? skippedNoDueDate : undefined,
  }
}
