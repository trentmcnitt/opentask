/**
 * Field change collection helper for task updates
 *
 * Extracts common logic for tracking field changes, anchor derivation,
 * and snooze detection. Used by both single and bulk edit operations.
 */

import { getDb } from '@/core/db'
import type { Task, TaskUpdateInput } from '@/types'
import { deriveAnchorFields, computeFirstOccurrence } from '@/core/recurrence'

export interface FieldChangeData {
  setClauses: string[]
  values: unknown[]
  fieldsChanged: string[]
  beforeState: Partial<Task> & { id: number }
  afterState: Partial<Task> & { id: number }
  isSnoozeScenario: boolean
}

export interface CollectFieldChangesOptions {
  task: Task
  input: TaskUpdateInput
  userId: number
  userTimezone: string
  /** Current date for overdue detection. Defaults to new Date() */
  now?: Date
  /** Skip project access validation (for bulk operations that validate upfront) */
  skipProjectValidation?: boolean
}

/**
 * Helper to track a single field change
 */
function trackField<K extends keyof Task>(
  data: FieldChangeData,
  field: K,
  oldVal: Task[K],
  newVal: Task[K],
  clause: string = `${field} = ?`,
): void {
  data.setClauses.push(clause)
  data.values.push(newVal)
  data.fieldsChanged.push(field)
  data.beforeState[field] = oldVal
  data.afterState[field] = newVal
}

/**
 * Collect all field changes for a task update
 *
 * Handles:
 * - Basic field tracking (title, priority, labels, etc.)
 * - Project access validation
 * - rrule changes with anchor field derivation
 * - due_at changes with snooze detection
 *
 * Does NOT:
 * - Execute any database writes
 * - Call logAction() for undo
 * - Add updated_at clause (caller adds that)
 *
 * @returns Field change data ready for SQL execution
 */
export function collectFieldChanges(options: CollectFieldChangesOptions): FieldChangeData {
  const { task, input, userId, userTimezone, skipProjectValidation = false } = options
  const now = options.now ?? new Date()

  const data: FieldChangeData = {
    setClauses: [],
    values: [],
    fieldsChanged: [],
    beforeState: { id: task.id },
    afterState: { id: task.id },
    isSnoozeScenario: false,
  }

  // Track basic field changes
  collectBasicFields(data, task, input, userId, skipProjectValidation)

  // Track rrule changes with anchor derivation
  const rruleChanged = collectRruleChanges(data, task, input, userTimezone, now)

  // Track due_at changes with snooze detection
  collectDueAtChanges(data, task, input, rruleChanged)

  return data
}

/**
 * Collect basic field changes (title, priority, project_id, labels, recurrence_mode, meta_notes)
 */
function collectBasicFields(
  data: FieldChangeData,
  task: Task,
  input: TaskUpdateInput,
  userId: number,
  skipProjectValidation: boolean,
): void {
  if (input.title !== undefined && input.title !== task.title) {
    trackField(data, 'title', task.title, input.title)
  }

  if (input.priority !== undefined && input.priority !== task.priority) {
    trackField(data, 'priority', task.priority, input.priority)
  }

  if (input.project_id !== undefined && input.project_id !== task.project_id) {
    // Validate project access unless already validated (bulk operations)
    if (!skipProjectValidation) {
      const db = getDb()
      const project = db
        .prepare('SELECT id, owner_id, shared FROM projects WHERE id = ?')
        .get(input.project_id) as { id: number; owner_id: number; shared: number } | undefined
      if (!project) throw new Error('Project not found')
      if (project.owner_id !== userId && project.shared !== 1) {
        throw new Error('Access denied to project')
      }
    }
    trackField(data, 'project_id', task.project_id, input.project_id)
  }

  if (input.labels !== undefined) {
    const currentLabels = JSON.stringify(task.labels)
    const newLabels = JSON.stringify(input.labels)
    if (currentLabels !== newLabels) {
      data.setClauses.push('labels = ?')
      data.values.push(newLabels)
      data.fieldsChanged.push('labels')
      data.beforeState.labels = task.labels
      data.afterState.labels = input.labels
    }
  }

  if (input.recurrence_mode !== undefined && input.recurrence_mode !== task.recurrence_mode) {
    trackField(data, 'recurrence_mode', task.recurrence_mode, input.recurrence_mode)
  }

  if (input.meta_notes !== undefined && input.meta_notes !== task.meta_notes) {
    trackField(data, 'meta_notes', task.meta_notes, input.meta_notes)
  }
}

/**
 * Collect rrule changes with anchor field derivation
 *
 * @returns Whether rrule changed (used by due_at logic)
 */
function collectRruleChanges(
  data: FieldChangeData,
  task: Task,
  input: TaskUpdateInput,
  userTimezone: string,
  now: Date,
): boolean {
  if (input.rrule === undefined || input.rrule === task.rrule) {
    return false
  }

  trackField(data, 'rrule', task.rrule, input.rrule)

  if (input.rrule === null) {
    // Clearing recurrence - null out anchor fields
    data.setClauses.push('anchor_time = NULL, anchor_dow = NULL, anchor_dom = NULL')
    data.fieldsChanged.push('anchor_time', 'anchor_dow', 'anchor_dom')
    data.beforeState.anchor_time = task.anchor_time
    data.beforeState.anchor_dow = task.anchor_dow
    data.beforeState.anchor_dom = task.anchor_dom
    data.afterState.anchor_time = null
    data.afterState.anchor_dow = null
    data.afterState.anchor_dom = null
  } else {
    // Setting/changing recurrence - derive anchor fields
    const dueAtForAnchors = data.afterState.due_at ?? task.due_at
    const anchors = deriveAnchorFields(input.rrule, dueAtForAnchors, userTimezone)

    // Update anchor_time
    data.setClauses.push('anchor_time = ?')
    data.values.push(anchors.anchor_time)
    if (!data.fieldsChanged.includes('anchor_time')) {
      data.fieldsChanged.push('anchor_time')
      data.beforeState.anchor_time = task.anchor_time
    }
    data.afterState.anchor_time = anchors.anchor_time

    // Update anchor_dow
    data.setClauses.push('anchor_dow = ?')
    data.values.push(anchors.anchor_dow)
    if (!data.fieldsChanged.includes('anchor_dow')) {
      data.fieldsChanged.push('anchor_dow')
      data.beforeState.anchor_dow = task.anchor_dow
    }
    data.afterState.anchor_dow = anchors.anchor_dow

    // Update anchor_dom
    data.setClauses.push('anchor_dom = ?')
    data.values.push(anchors.anchor_dom)
    if (!data.fieldsChanged.includes('anchor_dom')) {
      data.fieldsChanged.push('anchor_dom')
      data.beforeState.anchor_dom = task.anchor_dom
    }
    data.afterState.anchor_dom = anchors.anchor_dom

    // Clear original_due_at when rrule changes
    if (task.original_due_at) {
      data.setClauses.push('original_due_at = NULL')
      if (!data.fieldsChanged.includes('original_due_at')) {
        data.fieldsChanged.push('original_due_at')
        data.beforeState.original_due_at = task.original_due_at
      }
      data.afterState.original_due_at = null
    }

    // Only auto-compute due_at if:
    // 1. User didn't explicitly pass due_at
    // 2. Task is NOT overdue (due_at is in the future or null)
    const isOverdue = task.due_at && new Date(task.due_at) < now
    if (input.due_at === undefined && !isOverdue) {
      const nextOccurrence = computeFirstOccurrence(input.rrule, anchors.anchor_time, userTimezone)
      const nextDueAt = nextOccurrence.toISOString()

      data.setClauses.push('due_at = ?')
      data.values.push(nextDueAt)
      if (!data.fieldsChanged.includes('due_at')) {
        data.fieldsChanged.push('due_at')
        data.beforeState.due_at = task.due_at
      }
      data.afterState.due_at = nextDueAt
    }
  }

  return true
}

/**
 * Collect due_at changes with snooze detection
 *
 * When due_at changes without rrule changing, it's treated as a snooze:
 * - Sets original_due_at if not already set
 * - Increments snooze_count
 * - Sets isSnoozeScenario flag (caller handles stats increment)
 *
 * Note: The caller is responsible for calling incrementDailyStat() when
 * isSnoozeScenario is true. This allows bulk operations to batch the stats.
 */
function collectDueAtChanges(
  data: FieldChangeData,
  task: Task,
  input: TaskUpdateInput,
  rruleChanged: boolean,
): void {
  // If rrule changed, due_at was handled there (if auto-computed)
  // Only process due_at here if it's an explicit change without rrule change
  if (rruleChanged) return
  if (input.due_at === undefined || input.due_at === task.due_at) return

  trackField(data, 'due_at', task.due_at, input.due_at)

  // Apply snooze logic if task had a previous due_at
  if (task.due_at !== null) {
    data.isSnoozeScenario = true

    // Set original_due_at if not already set (preserve existing)
    if (task.original_due_at === null) {
      data.setClauses.push('original_due_at = ?')
      data.values.push(task.due_at)
      data.fieldsChanged.push('original_due_at')
      data.beforeState.original_due_at = null
      data.afterState.original_due_at = task.due_at
    }

    // Always increment snooze_count
    const newSnoozeCount = task.snooze_count + 1
    data.setClauses.push('snooze_count = ?')
    data.values.push(newSnoozeCount)
    data.fieldsChanged.push('snooze_count')
    data.beforeState.snooze_count = task.snooze_count
    data.afterState.snooze_count = newSnoozeCount
  }
}
