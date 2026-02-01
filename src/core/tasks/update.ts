/**
 * Task update (PATCH semantics)
 *
 * Only fields included in the input are updated.
 * This prevents clobbering of concurrent edits.
 */

import { getDb, withTransaction } from '@/core/db'
import type { Task, TaskUpdateInput } from '@/types'
import { nowUtc, deriveAnchorFields, computeFirstOccurrence } from '@/core/recurrence'
import { logAction, createTaskSnapshot } from '@/core/undo'
import { getTaskById } from './create'

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
  const db = getDb()

  // Get current task state
  const task = getTaskById(taskId)
  if (!task) {
    throw new Error('Task not found')
  }

  // Verify user has access
  if (!canUserAccessTask(userId, task)) {
    throw new Error('Access denied')
  }

  // Cannot edit trashed tasks
  if (task.deleted_at) {
    throw new Error('Cannot edit trashed task')
  }

  // Build the update
  const setClauses: string[] = []
  const values: unknown[] = []
  const fieldsChanged: string[] = []
  const beforeState: Partial<Task> = { id: taskId }
  const afterState: Partial<Task> = { id: taskId }

  // Track if rrule changed (need to re-derive anchors)
  let rruleChanged = false
  let newRRule = task.rrule

  // Process each potential field
  if (input.title !== undefined && input.title !== task.title) {
    setClauses.push('title = ?')
    values.push(input.title)
    fieldsChanged.push('title')
    beforeState.title = task.title
    afterState.title = input.title
  }

  if (input.priority !== undefined && input.priority !== task.priority) {
    setClauses.push('priority = ?')
    values.push(input.priority)
    fieldsChanged.push('priority')
    beforeState.priority = task.priority
    afterState.priority = input.priority
  }

  if (input.project_id !== undefined && input.project_id !== task.project_id) {
    // Validate new project
    const project = db
      .prepare('SELECT id, owner_id, shared FROM projects WHERE id = ?')
      .get(input.project_id) as { id: number; owner_id: number; shared: number } | undefined
    if (!project) {
      throw new Error('Project not found')
    }
    if (project.owner_id !== userId && project.shared !== 1) {
      throw new Error('Access denied to project')
    }

    setClauses.push('project_id = ?')
    values.push(input.project_id)
    fieldsChanged.push('project_id')
    beforeState.project_id = task.project_id
    afterState.project_id = input.project_id
  }

  if (input.labels !== undefined) {
    const currentLabels = JSON.stringify(task.labels)
    const newLabels = JSON.stringify(input.labels)
    if (currentLabels !== newLabels) {
      setClauses.push('labels = ?')
      values.push(newLabels)
      fieldsChanged.push('labels')
      beforeState.labels = task.labels
      afterState.labels = input.labels
    }
  }

  if (input.due_at !== undefined) {
    const newDueAt = input.due_at // can be null or string
    if (newDueAt !== task.due_at) {
      setClauses.push('due_at = ?')
      values.push(newDueAt)
      fieldsChanged.push('due_at')
      beforeState.due_at = task.due_at
      afterState.due_at = newDueAt
    }
  }

  if (input.recurrence_mode !== undefined && input.recurrence_mode !== task.recurrence_mode) {
    setClauses.push('recurrence_mode = ?')
    values.push(input.recurrence_mode)
    fieldsChanged.push('recurrence_mode')
    beforeState.recurrence_mode = task.recurrence_mode
    afterState.recurrence_mode = input.recurrence_mode
  }

  // Handle rrule change (special case - triggers anchor re-derivation)
  if (input.rrule !== undefined && input.rrule !== task.rrule) {
    rruleChanged = true
    newRRule = input.rrule

    setClauses.push('rrule = ?')
    values.push(input.rrule)
    fieldsChanged.push('rrule')
    beforeState.rrule = task.rrule
    afterState.rrule = input.rrule

    // If changing to/from recurring, handle additional changes
    if (input.rrule === null && task.rrule !== null) {
      // Converting to one-off: clear anchors
      setClauses.push('anchor_time = NULL, anchor_dow = NULL, anchor_dom = NULL')
      fieldsChanged.push('anchor_time', 'anchor_dow', 'anchor_dom')
    }
  }

  // No changes to make
  if (setClauses.length === 0) {
    return { task, fieldsChanged: [] }
  }

  // Re-derive anchor fields if rrule changed
  if (rruleChanged && newRRule) {
    // Determine the due_at to use for derivation
    const dueAtForAnchors = afterState.due_at ?? task.due_at

    // Compute new anchors
    const anchors = deriveAnchorFields(newRRule, dueAtForAnchors, userTimezone)

    // Update anchor fields
    setClauses.push('anchor_time = ?')
    values.push(anchors.anchor_time)
    if (!fieldsChanged.includes('anchor_time')) {
      fieldsChanged.push('anchor_time')
      beforeState.anchor_time = task.anchor_time
    }
    afterState.anchor_time = anchors.anchor_time

    setClauses.push('anchor_dow = ?')
    values.push(anchors.anchor_dow)
    if (!fieldsChanged.includes('anchor_dow')) {
      fieldsChanged.push('anchor_dow')
      beforeState.anchor_dow = task.anchor_dow
    }
    afterState.anchor_dow = anchors.anchor_dow

    setClauses.push('anchor_dom = ?')
    values.push(anchors.anchor_dom)
    if (!fieldsChanged.includes('anchor_dom')) {
      fieldsChanged.push('anchor_dom')
      beforeState.anchor_dom = task.anchor_dom
    }
    afterState.anchor_dom = anchors.anchor_dom

    // Clear snoozed_from when rrule changes (schedule change = new baseline)
    if (task.snoozed_from) {
      setClauses.push('snoozed_from = NULL')
      if (!fieldsChanged.includes('snoozed_from')) {
        fieldsChanged.push('snoozed_from')
        beforeState.snoozed_from = task.snoozed_from
      }
      afterState.snoozed_from = null
    }

    // Recompute due_at if not explicitly provided
    if (input.due_at === undefined) {
      const nextOccurrence = computeFirstOccurrence(newRRule, anchors.anchor_time, userTimezone)
      const nextDueAt = nextOccurrence.toISOString()

      setClauses.push('due_at = ?')
      values.push(nextDueAt)
      if (!fieldsChanged.includes('due_at')) {
        fieldsChanged.push('due_at')
        beforeState.due_at = task.due_at
      }
      afterState.due_at = nextDueAt
    }
  }

  // Always update updated_at
  setClauses.push('updated_at = ?')
  values.push(nowUtc())

  // Add task ID for WHERE clause
  values.push(taskId)

  // Execute update and undo log in a transaction
  return withTransaction((db) => {
    // Execute update
    const sql = `UPDATE tasks SET ${setClauses.join(', ')} WHERE id = ?`
    db.prepare(sql).run(...values)

    // Log to undo
    const snapshot = createTaskSnapshot(
      beforeState as Partial<Task> & { id: number },
      afterState as Partial<Task> & { id: number },
      fieldsChanged,
    )
    logAction(userId, 'edit', `Edited "${task.title}"`, fieldsChanged, [snapshot])

    // Return updated task
    const updatedTask = getTaskById(taskId)
    if (!updatedTask) {
      throw new Error('Failed to retrieve updated task')
    }

    return { task: updatedTask, fieldsChanged }
  })
}

/**
 * Check if a user can access a task
 */
export function canUserAccessTask(userId: number, task: Task): boolean {
  // User owns the task
  if (task.user_id === userId) {
    return true
  }

  // Task is in a shared project
  const db = getDb()
  const project = db.prepare('SELECT shared FROM projects WHERE id = ?').get(task.project_id) as
    | { shared: number }
    | undefined

  return project?.shared === 1
}
