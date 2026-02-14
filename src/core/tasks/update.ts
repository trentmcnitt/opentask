/**
 * Task update (PATCH semantics)
 *
 * Only fields included in the input are updated.
 * This prevents clobbering of concurrent edits.
 */

import { getDb, withTransaction } from '@/core/db'
import type { Task, TaskUpdateInput } from '@/types'
import { nowUtc } from '@/core/recurrence'
import { logAction, createTaskSnapshot } from '@/core/undo'
import { logActivity } from '@/core/activity'
import { incrementDailyStat } from '@/core/stats'
import { NotFoundError, ForbiddenError, ValidationError } from '@/core/errors'
import { formatEditDescription } from '@/lib/field-labels'
import { getTaskById } from './create'
import { collectFieldChanges } from './helpers'

export interface UpdateTaskOptions {
  userId: number
  userTimezone: string
  taskId: number
  input: TaskUpdateInput
  /** Pre-fetched task to avoid redundant DB lookups (caller must have already validated access) */
  prefetchedTask?: Task
}

export interface UpdateTaskResult {
  task: Task
  fieldsChanged: string[]
  description: string
}

/**
 * Update a task using PATCH semantics
 *
 * Only fields present in input are updated.
 * Returns the updated task and list of changed fields.
 */
export function updateTask(options: UpdateTaskOptions): UpdateTaskResult {
  const { userId, userTimezone, taskId, input, prefetchedTask } = options

  const task = prefetchedTask ?? getTaskById(taskId)
  if (!task) throw new NotFoundError('Task not found')
  if (!prefetchedTask) {
    // Only validate access if caller didn't pre-validate
    if (!canUserAccessTask(userId, task)) throw new ForbiddenError('Access denied')
    if (task.deleted_at) throw new ValidationError('Cannot edit trashed task')
  }

  const data = collectFieldChanges({
    task,
    input,
    userId,
    userTimezone,
  })

  if (data.setClauses.length === 0) {
    return { task, fieldsChanged: [], description: '' }
  }

  // Add updated_at and task ID for WHERE clause
  data.setClauses.push('updated_at = ?')
  data.values.push(nowUtc())
  data.values.push(taskId)

  // Look up project name if project_id changed
  let projectName: string | undefined
  if (data.fieldsChanged.includes('project_id') && data.afterState.project_id) {
    const db = getDb()
    const project = db
      .prepare('SELECT name FROM projects WHERE id = ?')
      .get(data.afterState.project_id) as { name: string } | undefined
    if (project) projectName = project.name
  }

  return withTransaction((db) => {
    const sql = `UPDATE tasks SET ${data.setClauses.join(', ')} WHERE id = ?`
    db.prepare(sql).run(...data.values)

    const snapshot = createTaskSnapshot(
      data.beforeState as Partial<Task> & { id: number },
      data.afterState as Partial<Task> & { id: number },
      data.fieldsChanged,
    )
    const description = formatEditDescription(task.title, data.fieldsChanged, {
      isSnooze: data.isSnoozeScenario,
      beforeState: data.beforeState,
      afterState: data.afterState,
      userTimezone,
      projectName,
    })
    logAction(userId, 'edit', description, data.fieldsChanged, [snapshot])

    logActivity({
      userId,
      taskId,
      action: data.isSnoozeScenario ? 'snooze' : 'edit',
      fields: data.fieldsChanged,
      before: snapshot.before_state,
      after: snapshot.after_state,
      metadata: data.isSnoozeScenario ? { snooze_detected: true } : undefined,
    })

    // Increment snooze stats if this was a snooze operation
    if (data.isSnoozeScenario) {
      incrementDailyStat(userId, 'snoozes', userTimezone)
    }

    const updatedTask = getTaskById(taskId)
    if (!updatedTask) throw new Error('Failed to retrieve updated task')

    return { task: updatedTask, fieldsChanged: data.fieldsChanged, description }
  })
}

/**
 * Check if a user can access a task
 */
export function canUserAccessTask(userId: number, task: Task): boolean {
  if (task.user_id === userId) return true

  const db = getDb()
  const project = db.prepare('SELECT shared FROM projects WHERE id = ?').get(task.project_id) as
    | { shared: number }
    | undefined

  return project?.shared === 1
}
