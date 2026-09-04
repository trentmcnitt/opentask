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
import { emitSyncEvent } from '@/lib/sync-events'
import { dispatchWebhookEvent } from '@/core/webhooks/dispatch'
import { formatTaskResponse } from '@/lib/format-task'
import { incrementDailyStat } from '@/core/stats'
import { NotFoundError, ForbiddenError, ValidationError } from '@/core/errors'
import { formatEditDescription } from '@/lib/field-labels'
import { getTaskById } from './create'
import { collectFieldChanges } from './helpers'
import { validateLabelsExist } from '@/core/labels'
import { TRACKED_REMINDER_MESSAGE } from '@/core/validation'

export interface UpdateTaskOptions {
  userId: number
  userTimezone: string
  taskId: number
  input: TaskUpdateInput
  /** Pre-fetched task to avoid redundant DB lookups (caller must have already validated access) */
  prefetchedTask?: Task
  /** Skip webhook dispatch — set by callers (e.g. snoozeTask) that dispatch their own event */
  skipWebhookDispatch?: boolean
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
  const { userId, userTimezone, taskId, input, prefetchedTask, skipWebhookDispatch } = options

  const task = prefetchedTask ?? getTaskById(taskId)
  if (!task) throw new NotFoundError('Task not found')
  if (!prefetchedTask) {
    // Only validate access if caller didn't pre-validate
    if (!canUserAccessTask(userId, task)) throw new ForbiddenError('Access denied')
  }
  // Always check deleted_at, even for prefetched tasks — prevents future callers
  // from accidentally bypassing this guard by passing prefetchedTask
  if (task.deleted_at) throw new ValidationError('Cannot edit trashed task')

  // §5/§6 mutual exclusivity, checked against the RESULTING row rather than the
  // payload. The schema-level refusal only sees fields sent together, so it
  // cannot catch "flag this already-tracked task as a reminder" — the single
  // most likely way to reach the incoherent state from the task editor, where
  // the toggle sends `is_reminder` alone.
  const resultingIsReminder = input.is_reminder ?? task.is_reminder
  const resultingTarget = input.progress_target ?? task.progress_target
  if (resultingIsReminder && resultingTarget > 1) {
    throw new ValidationError(TRACKED_REMINDER_MESSAGE)
  }

  // §7.2: only labels being NEWLY added are held to the registry. Passing the
  // task's current labels as `existing` is what lets an unrelated edit (a title
  // fix, a priority bump) succeed on a task that happens to carry a legacy
  // unregistered label — otherwise one stray tag would make that task
  // permanently uneditable.
  if (input.labels !== undefined) {
    validateLabelsExist(userId, input.labels, task.labels, input.create_label === true)
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

  const result = withTransaction((db) => {
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

  // Cancel pending AI enrichment — user's manual edit takes precedence.
  // Done outside the transaction: not a user-visible change, not part of undo snapshot.
  // If the user undoes their edit, ai-to-process is restored and enrichment can resume.
  if (result.task.labels.includes('ai-to-process')) {
    const cleanedLabels = result.task.labels.filter((l) => l !== 'ai-to-process')
    getDb()
      .prepare('UPDATE tasks SET labels = ? WHERE id = ?')
      .run(JSON.stringify(cleanedLabels), taskId)
    result.task.labels = cleanedLabels
  }

  emitSyncEvent(userId)

  // Callers like snoozeTask() set skipWebhookDispatch to dispatch their own more specific event
  if (!skipWebhookDispatch) {
    dispatchWebhookEvent(userId, 'task.updated', {
      task: formatTaskResponse(result.task),
      fields_changed: result.fieldsChanged,
    })
  }

  return result
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
