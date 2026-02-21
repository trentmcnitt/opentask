/**
 * Reprocess task for AI enrichment
 *
 * Swaps the `ai-failed` label to `ai-to-process` so the enrichment pipeline
 * picks the task up again. The label swap is atomic with an undo log entry,
 * so the user can Cmd+Z to revert back to `ai-failed`.
 */

import { withTransaction } from '@/core/db'
import type { Task } from '@/types'
import { nowUtc } from '@/core/recurrence'
import { logAction, createTaskSnapshot } from '@/core/undo'
import { logActivity } from '@/core/activity'
import { emitSyncEvent } from '@/lib/sync-events'
import { NotFoundError, ForbiddenError, ValidationError } from '@/core/errors'
import { getTaskById } from './create'
import { canUserAccessTask } from './update'

export interface ReprocessTaskOptions {
  userId: number
  taskId: number
}

/**
 * Swap `ai-failed` → `ai-to-process` to retry AI enrichment.
 *
 * Validates that the task exists, the user has access, the task is not deleted,
 * and the task has the `ai-failed` label. Returns the updated task.
 */
export function reprocessTask(options: ReprocessTaskOptions): Task {
  const { userId, taskId } = options

  const task = getTaskById(taskId)
  if (!task) {
    throw new NotFoundError('Task not found')
  }

  if (!canUserAccessTask(userId, task)) {
    throw new ForbiddenError('Access denied')
  }

  if (task.deleted_at) {
    throw new ValidationError('Cannot reprocess a trashed task')
  }

  if (!task.labels.includes('ai-failed')) {
    throw new ValidationError('Task does not have ai-failed label')
  }

  const now = nowUtc()
  const newLabels = task.labels.map((l) => (l === 'ai-failed' ? 'ai-to-process' : l))
  const labelsJson = JSON.stringify(newLabels)

  const updatedTask = withTransaction((db) => {
    db.prepare('UPDATE tasks SET labels = ?, updated_at = ? WHERE id = ?').run(
      labelsJson,
      now,
      taskId,
    )

    const snapshot = createTaskSnapshot(
      { id: taskId, labels: task.labels },
      { id: taskId, labels: newLabels },
      ['labels'],
    )
    logAction(userId, 'edit', `Retrying AI enrichment for "${task.title}"`, ['labels'], [snapshot])

    logActivity({
      userId,
      taskId,
      action: 'reprocess',
      fields: ['labels'],
      before: snapshot.before_state,
      after: snapshot.after_state,
    })

    const result = getTaskById(taskId)
    if (!result) {
      throw new Error('Failed to retrieve updated task')
    }

    return result
  })

  emitSyncEvent(userId)
  return updatedTask
}
