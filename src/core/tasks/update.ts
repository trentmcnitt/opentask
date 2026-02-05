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
import { incrementDailyStat } from '@/core/stats'
import { getTaskById } from './create'
import { collectFieldChanges } from './helpers'

export interface UpdateTaskOptions {
  userId: number
  userTimezone: string
  taskId: number
  input: TaskUpdateInput
}

export interface UpdateTaskResult {
  task: Task
  fieldsChanged: string[]
}

/**
 * Update a task using PATCH semantics
 *
 * Only fields present in input are updated.
 * Returns the updated task and list of changed fields.
 */
export function updateTask(options: UpdateTaskOptions): UpdateTaskResult {
  const { userId, userTimezone, taskId, input } = options

  const task = getTaskById(taskId)
  if (!task) throw new Error('Task not found')
  if (!canUserAccessTask(userId, task)) throw new Error('Access denied')
  if (task.deleted_at) throw new Error('Cannot edit trashed task')

  const data = collectFieldChanges({
    task,
    input,
    userId,
    userTimezone,
  })

  if (data.setClauses.length === 0) {
    return { task, fieldsChanged: [] }
  }

  // Add updated_at and task ID for WHERE clause
  data.setClauses.push('updated_at = ?')
  data.values.push(nowUtc())
  data.values.push(taskId)

  return withTransaction((db) => {
    const sql = `UPDATE tasks SET ${data.setClauses.join(', ')} WHERE id = ?`
    db.prepare(sql).run(...data.values)

    const snapshot = createTaskSnapshot(
      data.beforeState as Partial<Task> & { id: number },
      data.afterState as Partial<Task> & { id: number },
      data.fieldsChanged,
    )
    logAction(userId, 'edit', `Edited "${task.title}"`, data.fieldsChanged, [snapshot])

    // Increment snooze stats if this was a snooze operation
    if (data.isSnoozeScenario) {
      incrementDailyStat(userId, 'snoozes', userTimezone)
    }

    const updatedTask = getTaskById(taskId)
    if (!updatedTask) throw new Error('Failed to retrieve updated task')

    return { task: updatedTask, fieldsChanged: data.fieldsChanged }
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
