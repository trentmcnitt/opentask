/**
 * Shared webhook dispatch for undo/redo operations
 *
 * Dispatches task.updated webhooks after undo/redo, notifying
 * external systems that task state has changed due to a reversal.
 */

import { dispatchWebhookEvent } from '@/core/webhooks/dispatch'
import { formatTaskResponse } from '@/lib/format-task'
import { getTaskById } from '@/core/tasks/create'
import type { UndoSnapshot } from '@/types'

/**
 * Dispatch task.updated webhooks for each affected task in an undo/redo operation.
 *
 * @param userId - The user who performed the undo/redo
 * @param snapshots - The undo snapshots containing task IDs
 * @param fieldsChanged - The fields that were restored/re-applied
 * @param trigger - Whether this was an 'undo' or 'redo' operation
 */
export function dispatchUndoRedoWebhooks(
  userId: number,
  snapshots: UndoSnapshot[],
  fieldsChanged: string[],
  trigger: 'undo' | 'redo',
): void {
  for (const snapshot of snapshots) {
    const task = getTaskById(snapshot.task_id)
    if (task) {
      dispatchWebhookEvent(userId, 'task.updated', {
        task: formatTaskResponse(task),
        fields_changed: fieldsChanged,
        trigger,
      })
    }
  }
}
