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
import { incrementDailyStat } from '@/core/stats'
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

interface FieldDiff {
  setClauses: string[]
  values: unknown[]
  fieldsChanged: string[]
  beforeState: Partial<Task> & { id: number }
  afterState: Partial<Task> & { id: number }
  rruleChanged: boolean
  newRRule: string | null | undefined
}

function trackField<K extends keyof Task>(
  diff: FieldDiff,
  field: K,
  oldVal: Task[K],
  newVal: Task[K],
  clause: string = `${field} = ?`,
) {
  diff.setClauses.push(clause)
  diff.values.push(newVal)
  diff.fieldsChanged.push(field)
  diff.beforeState[field] = oldVal
  diff.afterState[field] = newVal
}

function collectFieldChanges(task: Task, input: TaskUpdateInput, userId: number): FieldDiff {
  const db = getDb()
  const diff: FieldDiff = {
    setClauses: [],
    values: [],
    fieldsChanged: [],
    beforeState: { id: task.id },
    afterState: { id: task.id },
    rruleChanged: false,
    newRRule: task.rrule,
  }

  if (input.title !== undefined && input.title !== task.title) {
    trackField(diff, 'title', task.title, input.title)
  }

  if (input.priority !== undefined && input.priority !== task.priority) {
    trackField(diff, 'priority', task.priority, input.priority)
  }

  if (input.project_id !== undefined && input.project_id !== task.project_id) {
    const project = db
      .prepare('SELECT id, owner_id, shared FROM projects WHERE id = ?')
      .get(input.project_id) as { id: number; owner_id: number; shared: number } | undefined
    if (!project) throw new Error('Project not found')
    if (project.owner_id !== userId && project.shared !== 1) {
      throw new Error('Access denied to project')
    }
    trackField(diff, 'project_id', task.project_id, input.project_id)
  }

  if (input.labels !== undefined) {
    const currentLabels = JSON.stringify(task.labels)
    const newLabels = JSON.stringify(input.labels)
    if (currentLabels !== newLabels) {
      diff.setClauses.push('labels = ?')
      diff.values.push(newLabels)
      diff.fieldsChanged.push('labels')
      diff.beforeState.labels = task.labels
      diff.afterState.labels = input.labels
    }
  }

  if (input.due_at !== undefined && input.due_at !== task.due_at) {
    trackField(diff, 'due_at', task.due_at, input.due_at)
  }

  if (input.recurrence_mode !== undefined && input.recurrence_mode !== task.recurrence_mode) {
    trackField(diff, 'recurrence_mode', task.recurrence_mode, input.recurrence_mode)
  }

  if (input.rrule !== undefined && input.rrule !== task.rrule) {
    diff.rruleChanged = true
    diff.newRRule = input.rrule
    trackField(diff, 'rrule', task.rrule, input.rrule)

    if (input.rrule === null && task.rrule !== null) {
      diff.setClauses.push('anchor_time = NULL, anchor_dow = NULL, anchor_dom = NULL')
      diff.fieldsChanged.push('anchor_time', 'anchor_dow', 'anchor_dom')
    }
  }

  if (input.meta_notes !== undefined && input.meta_notes !== task.meta_notes) {
    trackField(diff, 'meta_notes', task.meta_notes, input.meta_notes)
  }

  return diff
}

/**
 * Apply snooze-related field updates when due_at changes (without rrule change).
 *
 * This centralizes snooze logic in the PATCH endpoint so all task edits
 * (including due_at changes) create ONE undo entry.
 *
 * - Sets original_due_at if not already set (preserve existing)
 * - ALWAYS increments snooze_count (new behavior)
 * - Increments daily snooze stats
 */
function applySnoozeLogic(diff: FieldDiff, task: Task, userId: number, userTimezone: string): void {
  // Set original_due_at if not already set (preserve existing)
  if (task.original_due_at === null && task.due_at !== null) {
    diff.setClauses.push('original_due_at = ?')
    diff.values.push(task.due_at)
    diff.fieldsChanged.push('original_due_at')
    diff.beforeState.original_due_at = null
    diff.afterState.original_due_at = task.due_at
  }

  // ALWAYS increment snooze_count (changed behavior - every snooze increments)
  const newSnoozeCount = task.snooze_count + 1
  diff.setClauses.push('snooze_count = ?')
  diff.values.push(newSnoozeCount)
  diff.fieldsChanged.push('snooze_count')
  diff.beforeState.snooze_count = task.snooze_count
  diff.afterState.snooze_count = newSnoozeCount

  // Increment daily stats on every snooze
  incrementDailyStat(userId, 'snoozes', userTimezone)
}

function applyAnchorUpdates(
  diff: FieldDiff,
  task: Task,
  input: TaskUpdateInput,
  userTimezone: string,
) {
  if (!diff.rruleChanged || !diff.newRRule) return

  const dueAtForAnchors = diff.afterState.due_at ?? task.due_at
  const anchors = deriveAnchorFields(diff.newRRule, dueAtForAnchors, userTimezone)

  // Update anchor_time
  diff.setClauses.push('anchor_time = ?')
  diff.values.push(anchors.anchor_time)
  if (!diff.fieldsChanged.includes('anchor_time')) {
    diff.fieldsChanged.push('anchor_time')
    diff.beforeState.anchor_time = task.anchor_time
  }
  diff.afterState.anchor_time = anchors.anchor_time

  // Update anchor_dow
  diff.setClauses.push('anchor_dow = ?')
  diff.values.push(anchors.anchor_dow)
  if (!diff.fieldsChanged.includes('anchor_dow')) {
    diff.fieldsChanged.push('anchor_dow')
    diff.beforeState.anchor_dow = task.anchor_dow
  }
  diff.afterState.anchor_dow = anchors.anchor_dow

  // Update anchor_dom
  diff.setClauses.push('anchor_dom = ?')
  diff.values.push(anchors.anchor_dom)
  if (!diff.fieldsChanged.includes('anchor_dom')) {
    diff.fieldsChanged.push('anchor_dom')
    diff.beforeState.anchor_dom = task.anchor_dom
  }
  diff.afterState.anchor_dom = anchors.anchor_dom

  if (task.original_due_at) {
    diff.setClauses.push('original_due_at = NULL')
    if (!diff.fieldsChanged.includes('original_due_at')) {
      diff.fieldsChanged.push('original_due_at')
      diff.beforeState.original_due_at = task.original_due_at
    }
    diff.afterState.original_due_at = null
  }

  if (input.due_at === undefined) {
    const nextOccurrence = computeFirstOccurrence(diff.newRRule, anchors.anchor_time, userTimezone)
    const nextDueAt = nextOccurrence.toISOString()

    diff.setClauses.push('due_at = ?')
    diff.values.push(nextDueAt)
    if (!diff.fieldsChanged.includes('due_at')) {
      diff.fieldsChanged.push('due_at')
      diff.beforeState.due_at = task.due_at
    }
    diff.afterState.due_at = nextDueAt
  }
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

  const diff = collectFieldChanges(task, input, userId)

  if (diff.setClauses.length === 0) {
    return { task, fieldsChanged: [] }
  }

  applyAnchorUpdates(diff, task, input, userTimezone)

  // Apply snooze logic if due_at is changing AND rrule is NOT changing AND task had a due_at
  // This ensures snooze tracking when user changes due_at via PATCH
  const dueAtChanging = input.due_at !== undefined && input.due_at !== task.due_at
  const isSnoozeScenario = dueAtChanging && !diff.rruleChanged && task.due_at !== null

  if (isSnoozeScenario) {
    applySnoozeLogic(diff, task, userId, userTimezone)
  }

  diff.setClauses.push('updated_at = ?')
  diff.values.push(nowUtc())
  diff.values.push(taskId)

  return withTransaction((db) => {
    const sql = `UPDATE tasks SET ${diff.setClauses.join(', ')} WHERE id = ?`
    db.prepare(sql).run(...diff.values)

    const snapshot = createTaskSnapshot(
      diff.beforeState as Partial<Task> & { id: number },
      diff.afterState as Partial<Task> & { id: number },
      diff.fieldsChanged,
    )
    logAction(userId, 'edit', `Edited "${task.title}"`, diff.fieldsChanged, [snapshot])

    const updatedTask = getTaskById(taskId)
    if (!updatedTask) throw new Error('Failed to retrieve updated task')

    return { task: updatedTask, fieldsChanged: diff.fieldsChanged }
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
