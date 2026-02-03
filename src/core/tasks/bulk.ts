/**
 * Bulk operations
 *
 * All bulk operations execute as a single transaction and produce a single undo entry.
 */

import { withTransaction } from '@/core/db'
import type { Task, UndoSnapshot, TaskUpdateInput } from '@/types'
import { nowUtc, computeNextOccurrence, isRecurring } from '@/core/recurrence'
import { logAction, createTaskSnapshot } from '@/core/undo'
import { getTaskById } from './create'
import { canUserAccessTask } from './update'

export interface BulkDoneOptions {
  userId: number
  userTimezone: string
  taskIds: number[]
}

export interface BulkDoneResult {
  tasksAffected: number
  recurringCount: number
  oneOffCount: number
  failedIds: number[]
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
    return { tasksAffected: 0, recurringCount: 0, oneOffCount: 0, failedIds: [] }
  }

  const now = new Date()
  const nowStr = nowUtc()

  // Validate all tasks exist and user has access before starting transaction
  const tasks: Task[] = []
  const failedIds: number[] = []

  for (const taskId of taskIds) {
    const task = getTaskById(taskId)
    if (!task) {
      failedIds.push(taskId)
      continue
    }
    if (!canUserAccessTask(userId, task)) {
      failedIds.push(taskId)
      continue
    }
    if (task.deleted_at) {
      failedIds.push(taskId)
      continue
    }
    if (task.done && !isRecurring(task.rrule)) {
      failedIds.push(taskId)
      continue
    }
    tasks.push(task)
  }

  // If any task is invalid, fail the entire batch (BO-002: atomic)
  if (failedIds.length > 0) {
    throw new Error(`Invalid task IDs: ${failedIds.join(', ')}`)
  }

  const snapshots: UndoSnapshot[] = []
  let recurringCount = 0
  let oneOffCount = 0

  return withTransaction((tx) => {
    for (const task of tasks) {
      if (isRecurring(task.rrule)) {
        // Recurring task: advance to next occurrence
        recurringCount++

        const nextOccurrence = computeNextOccurrence({
          rrule: task.rrule!,
          recurrenceMode: task.recurrence_mode,
          anchorTime: task.anchor_time,
          timezone: userTimezone,
          completedAt: now,
        })

        const nextDueAt = nextOccurrence.toISOString()
        const prevDueAt = task.due_at

        // Create completion record
        const completionResult = tx
          .prepare(
            `
            INSERT INTO completions (task_id, user_id, completed_at, due_at_was, due_at_next)
            VALUES (?, ?, ?, ?, ?)
          `,
          )
          .run(task.id, userId, nowStr, prevDueAt, nextDueAt)

        const completionId = Number(completionResult.lastInsertRowid)

        // Update task
        tx.prepare(
          `
          UPDATE tasks
          SET due_at = ?, snoozed_from = NULL, updated_at = ?
          WHERE id = ?
        `,
        ).run(nextDueAt, nowStr, task.id)

        // Build snapshot with completion data
        const afterState: Partial<Task> & { _completion?: unknown } = {
          id: task.id,
          due_at: nextDueAt,
          snoozed_from: null,
          _completion: {
            user_id: userId,
            completed_at: nowStr,
            due_at_was: prevDueAt,
            due_at_next: nextDueAt,
          },
        }

        snapshots.push({
          task_id: task.id,
          before_state: {
            id: task.id,
            due_at: task.due_at,
            snoozed_from: task.snoozed_from,
          },
          after_state: afterState,
          completion_id: completionId,
        })
      } else {
        // One-off task: archive
        oneOffCount++

        tx.prepare(
          `
          UPDATE tasks
          SET done = 1, done_at = ?, archived_at = ?, updated_at = ?
          WHERE id = ?
        `,
        ).run(nowStr, nowStr, nowStr, task.id)

        snapshots.push(
          createTaskSnapshot(
            { id: task.id, done: false, done_at: null, archived_at: null },
            { id: task.id, done: true, done_at: nowStr, archived_at: nowStr },
            ['done', 'done_at', 'archived_at'],
          ),
        )
      }
    }

    // Single undo entry for entire batch (BO-004)
    const fieldsChanged =
      recurringCount > 0 && oneOffCount > 0
        ? ['due_at', 'snoozed_from', 'done', 'done_at', 'archived_at']
        : recurringCount > 0
          ? ['due_at', 'snoozed_from']
          : ['done', 'done_at', 'archived_at']

    logAction(userId, 'bulk_done', `Marked ${tasks.length} tasks done`, fieldsChanged, snapshots)

    return {
      tasksAffected: tasks.length,
      recurringCount,
      oneOffCount,
      failedIds: [],
    }
  })
}

export interface BulkSnoozeOptions {
  userId: number
  taskIds: number[]
  /** Absolute snooze target (ISO 8601 datetime) - all tasks set to this time */
  until?: string
  /** Relative snooze delta (minutes) - added to each task's current due_at */
  deltaMinutes?: number
}

export interface BulkSnoozeResult {
  tasksAffected: number
  failedIds: number[]
}

/**
 * Bulk snooze
 *
 * Snoozes all specified tasks. Supports two modes:
 * - Absolute (until): Sets all tasks to the same target time
 * - Relative (deltaMinutes): Adds minutes to each task's current due_at
 *
 * Follows same snoozed_from rules as single snooze.
 */
export function bulkSnooze(options: BulkSnoozeOptions): BulkSnoozeResult {
  const { userId, taskIds, until, deltaMinutes } = options

  if (taskIds.length === 0) {
    return { tasksAffected: 0, failedIds: [] }
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

  // Validate all tasks
  const tasks: Task[] = []
  const failedIds: number[] = []

  for (const taskId of taskIds) {
    const task = getTaskById(taskId)
    if (!task) {
      failedIds.push(taskId)
      continue
    }
    if (!canUserAccessTask(userId, task)) {
      failedIds.push(taskId)
      continue
    }
    if (task.done) {
      failedIds.push(taskId)
      continue
    }
    if (task.deleted_at) {
      failedIds.push(taskId)
      continue
    }
    tasks.push(task)
  }

  if (failedIds.length > 0) {
    throw new Error(`Invalid task IDs: ${failedIds.join(', ')}`)
  }

  const snapshots: UndoSnapshot[] = []

  return withTransaction((tx) => {
    for (const task of tasks) {
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

      // Determine snoozed_from value
      const newSnoozedFrom = task.snoozed_from ?? task.due_at

      tx.prepare(
        `
        UPDATE tasks
        SET due_at = ?, snoozed_from = ?, updated_at = ?
        WHERE id = ?
      `,
      ).run(newDueAt, newSnoozedFrom, nowStr, task.id)

      snapshots.push(
        createTaskSnapshot(
          { id: task.id, due_at: task.due_at, snoozed_from: task.snoozed_from },
          { id: task.id, due_at: newDueAt, snoozed_from: newSnoozedFrom },
          ['due_at', 'snoozed_from'],
        ),
      )
    }

    logAction(
      userId,
      'bulk_snooze',
      `Snoozed ${tasks.length} tasks`,
      ['due_at', 'snoozed_from'],
      snapshots,
    )

    return {
      tasksAffected: tasks.length,
      failedIds: [],
    }
  })
}

export interface BulkEditOptions {
  userId: number
  userTimezone: string
  taskIds: number[]
  changes: TaskUpdateInput
}

export interface BulkEditResult {
  tasksAffected: number
  failedIds: number[]
}

/**
 * Bulk edit
 *
 * Applies the same changes to all specified tasks.
 */
export function bulkEdit(options: BulkEditOptions): BulkEditResult {
  const { userId, taskIds, changes } = options

  if (taskIds.length === 0) {
    return { tasksAffected: 0, failedIds: [] }
  }

  // Validate all tasks first
  const tasks: Task[] = []
  const failedIds: number[] = []

  for (const taskId of taskIds) {
    const task = getTaskById(taskId)
    if (!task) {
      failedIds.push(taskId)
      continue
    }
    if (!canUserAccessTask(userId, task)) {
      failedIds.push(taskId)
      continue
    }
    if (task.deleted_at) {
      failedIds.push(taskId)
      continue
    }
    tasks.push(task)
  }

  if (failedIds.length > 0) {
    throw new Error(`Invalid task IDs: ${failedIds.join(', ')}`)
  }

  const nowStr = nowUtc()
  const snapshots: UndoSnapshot[] = []
  const allFieldsChanged = new Set<string>()

  return withTransaction((tx) => {
    // Validate project access once before processing tasks
    if (changes.project_id !== undefined) {
      const project = tx
        .prepare('SELECT owner_id, shared FROM projects WHERE id = ?')
        .get(changes.project_id) as { owner_id: number; shared: number } | undefined
      if (!project || (project.owner_id !== userId && project.shared !== 1)) {
        throw new Error('Access denied to target project')
      }
    }

    for (const task of tasks) {
      const setClauses: string[] = []
      const values: unknown[] = []
      const fieldsChanged: string[] = []
      const beforeState: Partial<Task> = { id: task.id }
      const afterState: Partial<Task> = { id: task.id }

      // Apply each change
      if (changes.priority !== undefined && changes.priority !== task.priority) {
        setClauses.push('priority = ?')
        values.push(changes.priority)
        fieldsChanged.push('priority')
        beforeState.priority = task.priority
        afterState.priority = changes.priority
      }

      if (changes.project_id !== undefined && changes.project_id !== task.project_id) {
        setClauses.push('project_id = ?')
        values.push(changes.project_id)
        fieldsChanged.push('project_id')
        beforeState.project_id = task.project_id
        afterState.project_id = changes.project_id
      }

      if (changes.labels !== undefined) {
        const newLabels = JSON.stringify(changes.labels)
        setClauses.push('labels = ?')
        values.push(newLabels)
        fieldsChanged.push('labels')
        beforeState.labels = task.labels
        afterState.labels = changes.labels
      }

      if (fieldsChanged.length > 0) {
        setClauses.push('updated_at = ?')
        values.push(nowStr)
        values.push(task.id)

        const sql = `UPDATE tasks SET ${setClauses.join(', ')} WHERE id = ?`
        tx.prepare(sql).run(...values)

        snapshots.push(
          createTaskSnapshot(
            beforeState as Partial<Task> & { id: number },
            afterState as Partial<Task> & { id: number },
            fieldsChanged,
          ),
        )

        fieldsChanged.forEach((f) => allFieldsChanged.add(f))
      }
    }

    if (snapshots.length > 0) {
      logAction(
        userId,
        'bulk_edit',
        `Edited ${snapshots.length} tasks`,
        Array.from(allFieldsChanged),
        snapshots,
      )
    }

    return {
      tasksAffected: snapshots.length,
      failedIds: [],
    }
  })
}

export interface BulkDeleteOptions {
  userId: number
  taskIds: number[]
}

export interface BulkDeleteResult {
  tasksAffected: number
  failedIds: number[]
}

/**
 * Bulk delete (soft delete)
 */
export function bulkDelete(options: BulkDeleteOptions): BulkDeleteResult {
  const { userId, taskIds } = options

  if (taskIds.length === 0) {
    return { tasksAffected: 0, failedIds: [] }
  }

  const nowStr = nowUtc()

  // Validate all tasks
  const tasks: Task[] = []
  const failedIds: number[] = []

  for (const taskId of taskIds) {
    const task = getTaskById(taskId)
    if (!task) {
      failedIds.push(taskId)
      continue
    }
    if (!canUserAccessTask(userId, task)) {
      failedIds.push(taskId)
      continue
    }
    if (task.deleted_at) {
      failedIds.push(taskId)
      continue
    }
    tasks.push(task)
  }

  if (failedIds.length > 0) {
    throw new Error(`Invalid task IDs: ${failedIds.join(', ')}`)
  }

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
      failedIds: [],
    }
  })
}
