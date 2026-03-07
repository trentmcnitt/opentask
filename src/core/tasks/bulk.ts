/**
 * Bulk operations
 *
 * All bulk operations execute as a single transaction and produce a single undo entry.
 */

import { getDb, withTransaction } from '@/core/db'
import type { Task, UndoSnapshot } from '@/types'
import { nowUtc, isRecurring } from '@/core/recurrence'
import { logAction, createTaskSnapshot } from '@/core/undo'
import { logActivityBatch } from '@/core/activity'
import { emitSyncEvent } from '@/lib/sync-events'
import { dispatchWebhookEvent } from '@/core/webhooks/dispatch'
import { formatTaskResponse } from '@/lib/format-task'
import type { ActivityEntry } from '@/core/activity'
import { incrementDailyStat } from '@/core/stats'
import { ValidationError, ForbiddenError } from '@/core/errors'
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
import { URGENT_PRIORITY } from '@/lib/priority'

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
  // Deduplicate IDs to prevent double-processing (e.g., completing a recurring
  // task multiple times in one call would advance its due_at multiple occurrences)
  const uniqueIds = [...new Set(taskIds)]

  const tasks: Task[] = []
  const failedIds: number[] = []

  for (const taskId of uniqueIds) {
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
    throw new ValidationError(`Invalid task IDs: ${failedIds.join(', ')}`)
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
  const activityEntries: ActivityEntry[] = []
  const batchId = crypto.randomUUID()
  let recurringCount = 0
  let oneOffCount = 0

  const result = withTransaction((tx) => {
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

      activityEntries.push({
        userId,
        taskId: task.id,
        action: 'complete',
        source: 'bulk',
        batchId,
        fields: computation.fieldsChanged,
        before: snapshot.before_state,
        after: snapshot.after_state,
        metadata: {
          recurring: computation.type === 'recurring',
          ...(computation.type === 'recurring' ? { next_due_at: computation.nextDueAt } : {}),
        },
      })
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
    logActivityBatch(activityEntries)

    // Increment daily stats for all completed tasks
    incrementDailyStat(userId, 'completions', userTimezone, tasks.length)

    return {
      tasksAffected: tasks.length,
      recurringCount,
      oneOffCount,
    }
  })

  emitSyncEvent(userId)

  for (const task of tasks) {
    const fresh = getTaskById(task.id)
    if (fresh) {
      dispatchWebhookEvent(userId, 'task.completed', { task: formatTaskResponse(fresh) })
    }
  }

  return result
}

interface BulkSnoozeFilterResult {
  eligible: Task[]
  urgentSkipped: number
}

/**
 * Priority filter for bulk snooze operations.
 *
 * P0-P3 (None through High) are eligible for bulk snooze.
 * P4 (Urgent) is excluded — urgent tasks must be snoozed individually.
 */
function filterForBulkSnooze(tasks: Task[], includeTaskIds?: Set<number>): BulkSnoozeFilterResult {
  const eligible = tasks.filter(
    (t) => (t.priority ?? 0) < URGENT_PRIORITY || includeTaskIds?.has(t.id),
  )
  const urgentSkipped = tasks.length - eligible.length
  return { eligible, urgentSkipped }
}

export interface BulkSnoozeOptions {
  userId: number
  userTimezone: string
  taskIds: number[]
  /** Absolute snooze target (ISO 8601 datetime) - all tasks set to this time */
  until?: string
  /** Relative snooze delta (minutes) - added to each task's current due_at */
  deltaMinutes?: number
  /** Task IDs to include regardless of priority (bypasses P4 filter) */
  includeTaskIds?: number[]
}

export interface BulkSnoozeResult {
  tasksAffected: number
  tasksSkipped: number
  urgentSkipped: number
  noDueDateSkipped: number
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
  const { userId, userTimezone, taskIds, until, deltaMinutes, includeTaskIds } = options

  if (taskIds.length === 0) {
    return { tasksAffected: 0, tasksSkipped: 0, urgentSkipped: 0, noDueDateSkipped: 0 }
  }

  // Validate that exactly one mode is specified
  if (until === undefined && deltaMinutes === undefined) {
    throw new ValidationError('Either until or deltaMinutes must be provided')
  }
  if (until !== undefined && deltaMinutes !== undefined) {
    throw new ValidationError('Cannot provide both until and deltaMinutes')
  }

  // Validate absolute snooze target if provided
  if (until !== undefined) {
    const snoozeTarget = new Date(until)
    if (isNaN(snoozeTarget.getTime())) {
      throw new ValidationError('Invalid snooze target datetime')
    }
  }
  // Note: We allow snoozing to past times - tasks will just appear overdue immediately.

  const nowStr = nowUtc()

  const tasks = validateBulkTasks(taskIds, userId, { excludeDone: true })

  // P0-P3 eligible, P4 (Urgent) excluded — unless explicitly included
  const includeSet = includeTaskIds?.length ? new Set(includeTaskIds) : undefined
  const { eligible, urgentSkipped } = filterForBulkSnooze(tasks, includeSet)

  // In relative mode, skip tasks without a due_at (can't add delta to nothing)
  let noDueDateSkipped = 0
  const snoozeable =
    deltaMinutes !== undefined
      ? eligible.filter((t) => {
          if (!t.due_at) {
            noDueDateSkipped++
            return false
          }
          return true
        })
      : eligible

  const skippedCount = tasks.length - snoozeable.length
  if (snoozeable.length === 0) {
    return { tasksAffected: 0, tasksSkipped: skippedCount, urgentSkipped, noDueDateSkipped }
  }

  const snapshots: UndoSnapshot[] = []
  const activityEntries: ActivityEntry[] = []
  const batchId = crypto.randomUUID()

  const result = withTransaction((tx) => {
    for (const task of snoozeable) {
      // Compute the new due_at based on mode
      let newDueAt: string
      if (until !== undefined) {
        // Absolute mode: all tasks get the same target time
        newDueAt = until
      } else {
        // Relative mode: add delta to each task's current due_at
        const baseDueAt = new Date(task.due_at!)
        newDueAt = new Date(baseDueAt.getTime() + deltaMinutes! * 60 * 1000).toISOString()
      }

      // Set original_due_at if not already set (preserve existing).
      // When the task had no due_at (both null), use the new due_at as the origin timestamp.
      const newOriginalDueAt = task.original_due_at ?? task.due_at ?? newDueAt

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

      activityEntries.push({
        userId,
        taskId: task.id,
        action: 'snooze',
        source: 'bulk',
        batchId,
        fields: fieldsChanged,
        before: beforeState,
        after: afterState,
        metadata: {},
      })
    }

    // snooze_count always changes now
    const allFieldsChanged = ['due_at', 'original_due_at', 'snooze_count']

    // Build enriched bulk snooze description
    let bulkSnoozeDesc: string
    if (until !== undefined) {
      const target = formatSnoozeTarget(until, userTimezone)
      bulkSnoozeDesc = `Snoozed ${snoozeable.length} tasks to ${target}`
    } else {
      const delta = formatDurationDelta(0, deltaMinutes! * 60 * 1000)
      bulkSnoozeDesc = `Snoozed ${snoozeable.length} tasks (${delta})`
    }

    logAction(userId, 'bulk_snooze', bulkSnoozeDesc, allFieldsChanged, snapshots)
    logActivityBatch(activityEntries)

    // Increment daily stats for ALL snoozes (every snooze counts now)
    incrementDailyStat(userId, 'snoozes', userTimezone, snoozeable.length)

    return {
      tasksAffected: snoozeable.length,
      tasksSkipped: skippedCount,
      urgentSkipped,
      noDueDateSkipped,
    }
  })

  emitSyncEvent(userId)

  for (const task of snoozeable) {
    const fresh = getTaskById(task.id)
    if (fresh) {
      dispatchWebhookEvent(userId, 'task.snoozed', {
        task: formatTaskResponse(fresh),
        previous_due_at: task.due_at,
      })
    }
  }

  return result
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

  // Reject rrule changes on done tasks — setting rrule on a done+archived task creates
  // an impossible state (done=1 + rrule set) that the system never produces organically
  let rruleSkippedCount = 0
  if (changes.rrule !== undefined && changes.rrule !== null) {
    const beforeCount = tasks.length
    tasks = tasks.filter((t) => !t.done)
    rruleSkippedCount = beforeCount - tasks.length
    if (tasks.length === 0) {
      return { tasksAffected: 0, tasksSkipped: rruleSkippedCount }
    }
  }

  // Priority filter for snooze edits — same logic as bulkSnooze (P4 excluded).
  // A due_at change is only a snooze when rrule is not being changed. If rrule is explicitly
  // set (even to null), the due_at change is part of a schedule change, not a snooze.
  let snoozeSkippedCount = 0
  const isSnoozeEdit = changes.due_at !== undefined && changes.rrule === undefined
  if (isSnoozeEdit) {
    const { eligible } = filterForBulkSnooze(tasks)
    snoozeSkippedCount = tasks.length - eligible.length
    tasks = eligible
    if (tasks.length === 0) {
      return { tasksAffected: 0, tasksSkipped: snoozeSkippedCount }
    }
  }

  const nowStr = nowUtc()
  const nowDate = new Date()
  const snapshots: UndoSnapshot[] = []
  const activityEntries: ActivityEntry[] = []
  const batchId = crypto.randomUUID()
  const allFieldsChanged = new Set<string>()
  const perTaskFields = new Map<number, string[]>()
  let totalSnoozedCount = 0

  const result = withTransaction((tx) => {
    // Validate project access once before processing tasks
    if (changes.project_id !== undefined) {
      const db = getDb()
      const project = db
        .prepare('SELECT owner_id, shared FROM projects WHERE id = ?')
        .get(changes.project_id) as { owner_id: number; shared: number } | undefined
      if (!project || (project.owner_id !== userId && project.shared !== 1)) {
        throw new ForbiddenError('Access denied to target project')
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

        activityEntries.push({
          userId,
          taskId: task.id,
          action: data.isSnoozeScenario ? 'snooze' : 'edit',
          source: 'bulk',
          batchId,
          fields: data.fieldsChanged,
          before: data.beforeState,
          after: data.afterState,
        })

        data.fieldsChanged.forEach((f) => allFieldsChanged.add(f))
        perTaskFields.set(task.id, data.fieldsChanged)

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
    logActivityBatch(activityEntries)

    // Increment daily snooze stats if any tasks were snoozed
    if (totalSnoozedCount > 0) {
      incrementDailyStat(userId, 'snoozes', userTimezone, totalSnoozedCount)
    }

    return {
      tasksAffected: snapshots.length,
      tasksSkipped: snoozeSkippedCount + rruleSkippedCount,
    }
  })

  emitSyncEvent(userId)

  for (const snapshot of snapshots) {
    const fresh = getTaskById(snapshot.task_id)
    if (fresh) {
      dispatchWebhookEvent(userId, 'task.updated', {
        task: formatTaskResponse(fresh),
        fields_changed: perTaskFields.get(snapshot.task_id) ?? Array.from(allFieldsChanged),
      })
    }
  }

  return result
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
  const activityEntries: ActivityEntry[] = []
  const batchId = crypto.randomUUID()

  const result = withTransaction((tx) => {
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

      activityEntries.push({
        userId,
        taskId: task.id,
        action: 'delete',
        source: 'bulk',
        batchId,
        fields: ['deleted_at'],
        before: { id: task.id, deleted_at: null },
        after: { id: task.id, deleted_at: nowStr },
      })
    }

    logAction(userId, 'bulk_delete', `Deleted ${tasks.length} tasks`, ['deleted_at'], snapshots)
    logActivityBatch(activityEntries)

    return {
      tasksAffected: tasks.length,
    }
  })

  emitSyncEvent(userId)

  for (const task of tasks) {
    dispatchWebhookEvent(userId, 'task.deleted', { task_id: task.id, title: task.title })
  }

  return result
}
