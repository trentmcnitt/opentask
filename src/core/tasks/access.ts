/**
 * Task access: who may touch a task, and the load-and-guard every single-task
 * mutation starts with.
 */

import { getDb } from '@/core/db'
import type { Task } from '@/types'
import { NotFoundError, ForbiddenError, ValidationError } from '@/core/errors'
import { getTaskById } from './read'

/**
 * Check if a user can access a task: they own it, or it sits in a shared
 * project.
 */
export function canUserAccessTask(userId: number, task: Task): boolean {
  if (task.user_id === userId) return true

  const db = getDb()
  const project = db.prepare('SELECT shared FROM projects WHERE id = ?').get(task.project_id) as
    | { shared: number }
    | undefined

  return project?.shared === 1
}

export interface LoadTaskForMutationOptions {
  /**
   * What a trashed task means for this mutation. Required, so a new caller has
   * to decide rather than inherit a default:
   * - `'allow'` — no trash check here. Either the mutation works on trashed
   *   tasks (restore, put-back) or it checks later, after refusals that must
   *   win first (snooze reports "reminders cannot be snoozed" before "trashed").
   * - `{ reject: message }` — refuse with `ValidationError(message)`. Each
   *   mutation keeps its own wording ("Cannot skip a trashed task", …), which
   *   API clients and tests read.
   */
  trashed: 'allow' | { reject: string }
}

/**
 * Load a task for a single-task mutation and run the shared guards, in the
 * order every caller had them: missing → `NotFoundError('Task not found')`
 * (404), no access → `ForbiddenError('Access denied')` (403), then the
 * trashed check `options.trashed` asks for (400).
 *
 * Bulk operations don't use this: they skip an inaccessible or trashed task
 * rather than failing the whole batch.
 */
export function loadTaskForMutation(
  userId: number,
  taskId: number,
  options: LoadTaskForMutationOptions,
): Task {
  const task = getTaskById(taskId)
  if (!task) throw new NotFoundError('Task not found')
  if (!canUserAccessTask(userId, task)) throw new ForbiddenError('Access denied')
  if (options.trashed !== 'allow' && task.deleted_at) {
    throw new ValidationError(options.trashed.reject)
  }
  return task
}
