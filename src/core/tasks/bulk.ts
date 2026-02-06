/**
 * Bulk operations
 *
 * All bulk operations execute as a single transaction and produce a single undo entry.
 */

import { getDb, withTransaction } from '@/core/db'
import type { Task, UndoSnapshot } from '@/types'
import { nowUtc, isRecurring } from '@/core/recurrence'
import { logAction, createTaskSnapshot } from '@/core/undo'
import { incrementDailyStat } from '@/core/stats'
import { formatBulkEditDescription, formatSnoozeTarget } from '@/lib/field-labels'
import { formatDurationDelta } from '@/lib/format-date'
import { getTaskById } from './create'
import { canUserAccessTask } from './update'
import {
  computeMarkDone,
  executeMarkDone,
  collectFieldChanges,
  type FieldChangesInput,
} from './helpers'
import { HIGH_PRIORITY_THRESHOLD } from '@/lib/priority'

interface ValidateBulkTasksOptions {
  /** Skip tasks that are done AND non-recurring (used by bulkDone) */
  excludeDoneNonRecurring?: boolean
  /** Skip tasks that are done (used by bulkSnooze) */
  excludeDone?: boolean
}

/**
 * Validate and load tasks for bulk operations.
 *
 * Verifies each task exists, belongs to the user, and is not deleted.
 * Additional filters can be applied via options. Throws if any task is invalid.
 */
function validateBulkTasks(
  taskIds: number[],
  userId: number,
  options: ValidateBulkTasksOptions = {},
): Task[] {
  const tasks: Task[] = []
  const failedIds: number[] = []

  for (const taskId of taskIds) {
    const task = getTaskById(taskId)
    if (!task || !canUserAccessTask(userId, task) || task.deleted_at) {
      failedIds.push(taskId)
      continue
    }
    if (options.excludeDoneNonRecurring && task.done && !isRecurring(task.rrule)) {
      failedIds.push(taskId)
      continue
    }
    if (options.excludeDone && task.done) {
      failedIds.push(taskId)
      continue
    }
    tasks.push(task)
  }

  if (failedIds.length > 0) {
    throw new Error(`Invalid task IDs: ${failedIds.join(', ')}`)
  }

  return tasks
}

export interface BulkDoneOptions {
  userId: number
  userTimezone: string
  taskIds: number[]
}

export interface BulkDoneResult {
  tasksAffected: number
  recurringCount: number
  oneOffCount: number
}

/**
 * Bulk mark done
 *
 * Handles both recurring (advance) and one-off (archive) tasks atomically.
 * BO-001: All tasks have recurrence correctly computed
 * BO-002: Atomic - either all succeed or all fail
 * BO-004: Single undo entry for the entire batch
 * BO-005: Mixed types handled correctly
 */
export function bulkDone(options: BulkDoneOptions): BulkDoneResult {
  const { userId, userTimezone, taskIds } = options

  if (taskIds.length === 0) {
    return { tasksAffected: 0, recurringCount: 0, oneOffCount: 0 }
  }

  const completedAt = new Date()
  const nowStr = nowUtc()

  // Validate all tasks exist and user has access before starting transaction (BO-002: atomic)
  const tasks = validateBulkTasks(taskIds, userId, { excludeDoneNonRecurring: true })

  const snapshots: UndoSnapshot[] = []
  let recurringCount = 0
  let oneOffCount = 0

  return withTransaction((tx) => {
    for (const task of tasks) {
      // Compute state changes using shared helper
      const computation = computeMarkDone(task, userTimezone, completedAt, nowStr)

      // Track counts
      if (computation.type === 'recurring') {
        recurringCount++
      } else {
        oneOffCount++
      }

      // Execute database operations using shared helper
      const { snapshot } = executeMarkDone(tx, task, computation, userId, nowStr)
      snapshots.push(snapshot)
    }

    // Single undo entry for entire batch (BO-004)
    // Include stats fields in all cases since they're always updated
    const baseStatsFields = ['completion_count', 'first_completed_at', 'last_completed_at']
    const fieldsChanged =
      recurringCount > 0 && oneOffCount > 0
        ? ['due_at', 'original_due_at', 'done', 'done_at', 'archived_at', ...baseStatsFields]
        : recurringCount > 0
          ? ['due_at', 'original_due_at', ...baseStatsFields]
          : ['done', 'done_at', 'archived_at', ...baseStatsFields]

    logAction(userId, 'bulk_done', `Marked ${tasks.length} tasks done`, fieldsChanged, snapshots)

    // Increment daily stats for all completed tasks
    incrementDailyStat(userId, 'completions', userTimezone, tasks.length)

    return {
      tasksAffected: tasks.length,
      recurringCount,
      oneOffCount,
    }
  })
}

/**
 * Filter high/urgent tasks from mixed-priority selections during snooze operations.
 *
 * High (3) and urgent (4) tasks are skipped when a selection contains both
 * high/urgent AND lower-priority tasks. They are allowed when:
 * - Selected individually (single task)
 * - In a group containing only high/urgent tasks (all priority >= 3)
 */
function filterMixedPriorityForSnooze(tasks: Task[]): { eligible: Task[]; skippedCount: number } {
  if (tasks.length <= 1) return { eligible: tasks, skippedCount: 0 }
  const hasHighUrgent = tasks.some((t) => (t.priority ?? 0) >= HIGH_PRIORITY_THRESHOLD)
  const hasLower = tasks.some((t) => (t.priority ?? 0) < HIGH_PRIORITY_THRESHOLD)
  if (hasHighUrgent && hasLower) {
    const eligible = tasks.filter((t) => (t.priority ?? 0) < HIGH_PRIORITY_THRESHOLD)
    return { eligible, skippedCount: tasks.length - eligible.length }
  }
  return { eligible: tasks, skippedCount: 0 }
}

export interface BulkSnoozeOptions {
  userId: number
  userTimezone: string
  taskIds: number[]
  /** Absolute snooze target (ISO 8601 datetime) - all tasks set to this time */
  until?: string
  /** Relative snooze delta (minutes) - added to each task's current due_at */
  deltaMinutes?: number
}

export interface BulkSnoozeResult {
  tasksAffected: number
  tasksSkipped: number
}

/**
 * Bulk snooze
 *
 * Snoozes all specified tasks. Supports two modes:
 * - Absolute (until): Sets all tasks to the same target time
 * - Relative (deltaMinutes): Adds minutes to each task's current due_at
 *
 * Follows same original_due_at rules as single snooze.
 */
export function bulkSnooze(options: BulkSnoozeOptions): BulkSnoozeResult {
  const { userId, userTimezone, taskIds, until, deltaMinutes } = options

  if (taskIds.length === 0) {
    return { tasksAffected: 0, tasksSkipped: 0 }
  }

  // Validate that exactly one mode is specified
  if (until === undefined && deltaMinutes === undefined) {
    throw new Error('Either until or deltaMinutes must be provided')
  }
  if (until !== undefined && deltaMinutes !== undefined) {
    throw new Error('Cannot provide both until and deltaMinutes')
  }

  // Validate absolute snooze target if provided
  if (until !== undefined) {
    const snoozeTarget = new Date(until)
    if (isNaN(snoozeTarget.getTime())) {
      throw new Error('Invalid snooze target datetime')
    }
  }
  // Note: We allow snoozing to past times - tasks will just appear overdue immediately.

  const nowStr = nowUtc()
  const nowDate = new Date()

  const tasks = validateBulkTasks(taskIds, userId, { excludeDone: true })

  // Skip high/urgent tasks in mixed-priority selections
  const { eligible, skippedCount } = filterMixedPriorityForSnooze(tasks)
  if (eligible.length === 0) {
    return { tasksAffected: 0, tasksSkipped: skippedCount }
  }

  const snapshots: UndoSnapshot[] = []

  return withTransaction((tx) => {
    for (const task of eligible) {
      // Compute the new due_at based on mode
      let newDueAt: string
      if (until !== undefined) {
        // Absolute mode: all tasks get the same target time
        newDueAt = until
      } else {
        // Relative mode: add delta to each task's current due_at
        // Tasks with null due_at use current time as base
        const baseDueAt = task.due_at ? new Date(task.due_at) : nowDate
        newDueAt = new Date(baseDueAt.getTime() + deltaMinutes! * 60 * 1000).toISOString()
      }

      // Set original_due_at if not already set (preserve existing)
      const newOriginalDueAt = task.original_due_at ?? task.due_at

      // ALWAYS increment snooze_count (changed behavior - every snooze increments)
      const newSnoozeCount = task.snooze_count + 1

      tx.prepare(
        `
        UPDATE tasks
        SET due_at = ?, original_due_at = ?, snooze_count = ?, updated_at = ?
        WHERE id = ?
      `,
      ).run(newDueAt, newOriginalDueAt, newSnoozeCount, nowStr, task.id)

      // Build snapshot - always include snooze_count since it always changes
      const fieldsChanged = ['due_at', 'original_due_at', 'snooze_count']
      const beforeState: Partial<Task> & { id: number } = {
        id: task.id,
        due_at: task.due_at,
        original_due_at: task.original_due_at,
        snooze_count: task.snooze_count,
      }
      const afterState: Partial<Task> & { id: number } = {
        id: task.id,
        due_at: newDueAt,
        original_due_at: newOriginalDueAt,
        snooze_count: newSnoozeCount,
      }

      snapshots.push(createTaskSnapshot(beforeState, afterState, fieldsChanged))
    }

    // snooze_count always changes now
    const allFieldsChanged = ['due_at', 'original_due_at', 'snooze_count']

    // Build enriched bulk snooze description
    let bulkSnoozeDesc: string
    if (until !== undefined) {
      const target = formatSnoozeTarget(until, userTimezone)
      bulkSnoozeDesc = `Snoozed ${eligible.length} tasks to ${target}`
    } else {
      const delta = formatDurationDelta(0, deltaMinutes! * 60 * 1000)
      bulkSnoozeDesc = `Snoozed ${eligible.length} tasks (${delta})`
    }

    logAction(userId, 'bulk_snooze', bulkSnoozeDesc, allFieldsChanged, snapshots)

    // Increment daily stats for ALL snoozes (every snooze counts now)
    incrementDailyStat(userId, 'snoozes', userTimezone, eligible.length)

    return {
      tasksAffected: eligible.length,
      tasksSkipped: skippedCount,
    }
  })
}

/** Type alias for bulk edit changes — same as FieldChangesInput (TaskUpdateInput + label operations) */
export type BulkEditChanges = FieldChangesInput

export interface BulkEditOptions {
  userId: number
  userTimezone: string
  taskIds: number[]
  changes: BulkEditChanges
}

export interface BulkEditResult {
  tasksAffected: number
  tasksSkipped: number
}

/**
 * Bulk edit
 *
 * Applies the same changes to all specified tasks.
 */
export function bulkEdit(options: BulkEditOptions): BulkEditResult {
  const { userId, userTimezone, taskIds, changes } = options

  if (taskIds.length === 0) {
    return { tasksAffected: 0, tasksSkipped: 0 }
  }

  let tasks = validateBulkTasks(taskIds, userId)

  // Skip high/urgent tasks in mixed-priority selections when editing due_at (snooze scenario).
  // A due_at change is only a snooze when rrule is not being changed. If rrule is explicitly
  // set (even to null), the due_at change is part of a schedule change, not a snooze.
  let snoozeSkippedCount = 0
  const isSnoozeEdit = changes.due_at !== undefined && changes.rrule === undefined
  if (isSnoozeEdit) {
    const { eligible, skippedCount } = filterMixedPriorityForSnooze(tasks)
    tasks = eligible
    snoozeSkippedCount = skippedCount
    if (tasks.length === 0) {
      return { tasksAffected: 0, tasksSkipped: snoozeSkippedCount }
    }
  }

  const nowStr = nowUtc()
  const nowDate = new Date()
  const snapshots: UndoSnapshot[] = []
  const allFieldsChanged = new Set<string>()
  let totalSnoozedCount = 0

  return withTransaction((tx) => {
    // Validate project access once before processing tasks
    if (changes.project_id !== undefined) {
      const db = getDb()
      const project = db
        .prepare('SELECT owner_id, shared FROM projects WHERE id = ?')
        .get(changes.project_id) as { owner_id: number; shared: number } | undefined
      if (!project || (project.owner_id !== userId && project.shared !== 1)) {
        throw new Error('Access denied to target project')
      }
    }

    for (const task of tasks) {
      // Collect field changes using shared helper
      const data = collectFieldChanges({
        task,
        input: changes,
        userId,
        userTimezone,
        now: nowDate,
        skipProjectValidation: true, // Already validated above
      })

      if (data.fieldsChanged.length > 0) {
        // Add updated_at and task ID for WHERE clause
        data.setClauses.push('updated_at = ?')
        data.values.push(nowStr)
        data.values.push(task.id)

        const sql = `UPDATE tasks SET ${data.setClauses.join(', ')} WHERE id = ?`
        tx.prepare(sql).run(...data.values)

        snapshots.push(
          createTaskSnapshot(
            data.beforeState as Partial<Task> & { id: number },
            data.afterState as Partial<Task> & { id: number },
            data.fieldsChanged,
          ),
        )

        data.fieldsChanged.forEach((f) => allFieldsChanged.add(f))

        // Track snooze count for stats (handled at end)
        if (data.isSnoozeScenario) {
          totalSnoozedCount++
        }
      }
    }

    if (snapshots.length > 0) {
      logAction(
        userId,
        'bulk_edit',
        formatBulkEditDescription(snapshots.length, Array.from(allFieldsChanged)),
        Array.from(allFieldsChanged),
        snapshots,
      )
    }

    // Increment daily snooze stats if any tasks were snoozed
    if (totalSnoozedCount > 0) {
      incrementDailyStat(userId, 'snoozes', userTimezone, totalSnoozedCount)
    }

    return {
      tasksAffected: snapshots.length,
      tasksSkipped: snoozeSkippedCount,
    }
  })
}

export interface BulkDeleteOptions {
  userId: number
  taskIds: number[]
}

export interface BulkDeleteResult {
  tasksAffected: number
}

/**
 * Bulk delete (soft delete)
 */
export function bulkDelete(options: BulkDeleteOptions): BulkDeleteResult {
  const { userId, taskIds } = options

  if (taskIds.length === 0) {
    return { tasksAffected: 0 }
  }

  const nowStr = nowUtc()
  const tasks = validateBulkTasks(taskIds, userId)
  const snapshots: UndoSnapshot[] = []

  return withTransaction((tx) => {
    for (const task of tasks) {
      tx.prepare(
        `
        UPDATE tasks
        SET deleted_at = ?, updated_at = ?
        WHERE id = ?
      `,
      ).run(nowStr, nowStr, task.id)

      snapshots.push(
        createTaskSnapshot({ id: task.id, deleted_at: null }, { id: task.id, deleted_at: nowStr }, [
          'deleted_at',
        ]),
      )
    }

    logAction(userId, 'bulk_delete', `Deleted ${tasks.length} tasks`, ['deleted_at'], snapshots)

    return {
      tasksAffected: tasks.length,
    }
  })
}
