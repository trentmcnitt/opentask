/**
 * Task provenance confirmation (REDESIGN-V03 §7.2)
 *
 * Bless a task the assistant created on its own initiative: removes
 * `ai-proposed`, adds `ai-added`.
 *
 * Deliberately narrow. Confirming is a statement about where a task came from,
 * not an invitation to re-edit it, so this touches no other field. It routes
 * through updateTask() rather than writing labels directly, so the change is
 * transactional and lands in the undo log like any other edit.
 */

import type { Task } from '@/types'
import { confirmProvenance, PROVENANCE_LABELS } from '@/core/labels'
import { loadTaskForMutation } from './access'
import { updateTask } from './update'

export interface ConfirmTaskProvenanceResult {
  task: Task
  /** Whether the task now carries `ai-added`. */
  confirmed: boolean
}

/**
 * Throws `NotFoundError` for a missing task and `ForbiddenError` for one the
 * user can't access. The route answers both with 404, so an id the user
 * can't see is indistinguishable from one that doesn't exist.
 */
export function confirmTaskProvenance(
  userId: number,
  userTimezone: string,
  taskId: number,
): ConfirmTaskProvenanceResult {
  // 'allow': a trashed task that is already confirmed stays a no-op; one still
  // proposed is refused by updateTask ("Cannot edit trashed task").
  const task = loadTaskForMutation(userId, taskId, { trashed: 'allow' })

  // Idempotent: confirming an already-confirmed task is a no-op rather than
  // an error, so a retried call can't fail spuriously.
  if (!task.labels.includes(PROVENANCE_LABELS.proposed)) {
    return { task, confirmed: task.labels.includes(PROVENANCE_LABELS.added) }
  }

  const { task: updated } = updateTask({
    userId,
    userTimezone,
    taskId,
    // `ai-added` is registered by the backfill and by the provenance flags, so
    // create_label is not needed here.
    input: { labels: confirmProvenance(task.labels) },
  })

  return { task: updated, confirmed: true }
}
