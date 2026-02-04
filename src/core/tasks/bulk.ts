/**
 * Bulk operations
 *
 * All bulk operations execute as a single transaction and produce a single undo entry.
 */

import { withTransaction } from '@/core/db'
import type { Task, UndoSnapshot, TaskUpdateInput } from '@/types'
import {
  nowUtc,
  computeNextOccurrence,
  isRecurring,
  deriveAnchorFields,
  computeFirstOccurrence,
} from '@/core/recurrence'
import { logAction, createTaskSnapshot } from '@/core/undo'
import { incrementDailyStat } from '@/core/stats'
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
      // Compute new stats values (same for both recurring and one-off)
      const newCompletionCount = task.completion_count + 1
      const newFirstCompletedAt = task.first_completed_at ?? nowStr
      const newLastCompletedAt = nowStr

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

        // Update task with stats
        tx.prepare(
          `
          UPDATE tasks
          SET due_at = ?, snoozed_from = NULL,
              completion_count = ?, first_completed_at = ?, last_completed_at = ?,
              updated_at = ?
          WHERE id = ?
        `,
        ).run(
          nextDueAt,
          newCompletionCount,
          newFirstCompletedAt,
          newLastCompletedAt,
          nowStr,
          task.id,
        )

        // Build snapshot with completion data and stats
        const afterState: Partial<Task> & { _completion?: unknown } = {
          id: task.id,
          due_at: nextDueAt,
          snoozed_from: null,
          completion_count: newCompletionCount,
          first_completed_at: newFirstCompletedAt,
          last_completed_at: newLastCompletedAt,
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
            completion_count: task.completion_count,
            first_completed_at: task.first_completed_at,
            last_completed_at: task.last_completed_at,
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
          SET done = 1, done_at = ?, archived_at = ?,
              completion_count = ?, first_completed_at = ?, last_completed_at = ?,
              updated_at = ?
          WHERE id = ?
        `,
        ).run(
          nowStr,
          nowStr,
          newCompletionCount,
          newFirstCompletedAt,
          newLastCompletedAt,
          nowStr,
          task.id,
        )

        snapshots.push(
          createTaskSnapshot(
            {
              id: task.id,
              done: false,
              done_at: null,
              archived_at: null,
              completion_count: task.completion_count,
              first_completed_at: task.first_completed_at,
              last_completed_at: task.last_completed_at,
            },
            {
              id: task.id,
              done: true,
              done_at: nowStr,
              archived_at: nowStr,
              completion_count: newCompletionCount,
              first_completed_at: newFirstCompletedAt,
              last_completed_at: newLastCompletedAt,
            },
            [
              'done',
              'done_at',
              'archived_at',
              'completion_count',
              'first_completed_at',
              'last_completed_at',
            ],
          ),
        )
      }
    }

    // Single undo entry for entire batch (BO-004)
    // Include stats fields in all cases since they're always updated
    const baseStatsFields = ['completion_count', 'first_completed_at', 'last_completed_at']
    const fieldsChanged =
      recurringCount > 0 && oneOffCount > 0
        ? ['due_at', 'snoozed_from', 'done', 'done_at', 'archived_at', ...baseStatsFields]
        : recurringCount > 0
          ? ['due_at', 'snoozed_from', ...baseStatsFields]
          : ['done', 'done_at', 'archived_at', ...baseStatsFields]

    logAction(userId, 'bulk_done', `Marked ${tasks.length} tasks done`, fieldsChanged, snapshots)

    // Increment daily stats for all completed tasks
    incrementDailyStat(userId, 'completions', userTimezone, tasks.length)

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
  userTimezone: string
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
  const { userId, userTimezone, taskIds, until, deltaMinutes } = options

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

  // Track first snooze info for stats and fieldsChanged
  let anyFirstSnooze = false
  let firstSnoozeCount = 0

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

      // Only increment snooze_count on first snooze
      const isFirstSnooze = task.snoozed_from === null
      const newSnoozeCount = isFirstSnooze ? task.snooze_count + 1 : task.snooze_count
      if (isFirstSnooze) {
        anyFirstSnooze = true
        firstSnoozeCount++
      }

      tx.prepare(
        `
        UPDATE tasks
        SET due_at = ?, snoozed_from = ?, snooze_count = ?, updated_at = ?
        WHERE id = ?
      `,
      ).run(newDueAt, newSnoozedFrom, newSnoozeCount, nowStr, task.id)

      // Build snapshot - include snooze_count if it changed
      const fieldsChanged = ['due_at', 'snoozed_from']
      const beforeState: Partial<Task> & { id: number } = {
        id: task.id,
        due_at: task.due_at,
        snoozed_from: task.snoozed_from,
      }
      const afterState: Partial<Task> & { id: number } = {
        id: task.id,
        due_at: newDueAt,
        snoozed_from: newSnoozedFrom,
      }

      if (isFirstSnooze) {
        fieldsChanged.push('snooze_count')
        beforeState.snooze_count = task.snooze_count
        afterState.snooze_count = newSnoozeCount
      }

      snapshots.push(createTaskSnapshot(beforeState, afterState, fieldsChanged))
    }

    // Include snooze_count in fieldsChanged if any task had its first snooze
    const allFieldsChanged = anyFirstSnooze
      ? ['due_at', 'snoozed_from', 'snooze_count']
      : ['due_at', 'snoozed_from']

    logAction(userId, 'bulk_snooze', `Snoozed ${tasks.length} tasks`, allFieldsChanged, snapshots)

    // Increment daily stats for all first snoozes
    if (firstSnoozeCount > 0) {
      incrementDailyStat(userId, 'snoozes', userTimezone, firstSnoozeCount)
    }

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
  const { userId, userTimezone, taskIds, changes } = options

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

      // Handle rrule changes - including anchor field derivation
      if (changes.rrule !== undefined && changes.rrule !== task.rrule) {
        setClauses.push('rrule = ?')
        values.push(changes.rrule)
        fieldsChanged.push('rrule')
        beforeState.rrule = task.rrule
        afterState.rrule = changes.rrule

        if (changes.rrule === null) {
          // Clearing recurrence - null out anchor fields
          setClauses.push('anchor_time = NULL, anchor_dow = NULL, anchor_dom = NULL')
          fieldsChanged.push('anchor_time', 'anchor_dow', 'anchor_dom')
          beforeState.anchor_time = task.anchor_time
          beforeState.anchor_dow = task.anchor_dow
          beforeState.anchor_dom = task.anchor_dom
          afterState.anchor_time = null
          afterState.anchor_dow = null
          afterState.anchor_dom = null
        } else {
          // Setting/changing recurrence - derive anchor fields from task's due_at
          const dueAtForAnchors = task.due_at
          const anchors = deriveAnchorFields(changes.rrule, dueAtForAnchors, userTimezone)

          setClauses.push('anchor_time = ?')
          values.push(anchors.anchor_time)
          fieldsChanged.push('anchor_time')
          beforeState.anchor_time = task.anchor_time
          afterState.anchor_time = anchors.anchor_time

          setClauses.push('anchor_dow = ?')
          values.push(anchors.anchor_dow)
          fieldsChanged.push('anchor_dow')
          beforeState.anchor_dow = task.anchor_dow
          afterState.anchor_dow = anchors.anchor_dow

          setClauses.push('anchor_dom = ?')
          values.push(anchors.anchor_dom)
          fieldsChanged.push('anchor_dom')
          beforeState.anchor_dom = task.anchor_dom
          afterState.anchor_dom = anchors.anchor_dom

          // Compute next due_at for the new rrule
          const nextOccurrence = computeFirstOccurrence(
            changes.rrule,
            anchors.anchor_time,
            userTimezone,
          )
          const nextDueAt = nextOccurrence.toISOString()
          setClauses.push('due_at = ?')
          values.push(nextDueAt)
          fieldsChanged.push('due_at')
          beforeState.due_at = task.due_at
          afterState.due_at = nextDueAt

          // Clear snoozed_from when rrule changes (consistent with single-task behavior)
          if (task.snoozed_from) {
            setClauses.push('snoozed_from = NULL')
            fieldsChanged.push('snoozed_from')
            beforeState.snoozed_from = task.snoozed_from
            afterState.snoozed_from = null
          }
        }
      }

      // Handle recurrence_mode changes
      if (
        changes.recurrence_mode !== undefined &&
        changes.recurrence_mode !== task.recurrence_mode
      ) {
        setClauses.push('recurrence_mode = ?')
        values.push(changes.recurrence_mode)
        fieldsChanged.push('recurrence_mode')
        beforeState.recurrence_mode = task.recurrence_mode
        afterState.recurrence_mode = changes.recurrence_mode
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
