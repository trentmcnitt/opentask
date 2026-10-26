/**
 * Task update (PATCH semantics)
 *
 * Only fields included in the input are updated.
 * This prevents clobbering of concurrent edits.
 */

import { getDb, withTransaction } from '@/core/db'
import type { Task, TaskUpdateInput } from '@/types'
import { nowUtc } from '@/core/recurrence'
import { logAction } from '@/core/undo'
import { logActivity } from '@/core/activity'
import { emitSyncEvent } from '@/lib/sync-events'
import { dispatchWebhookEvent } from '@/core/webhooks/dispatch'
import { dismissNotificationsForTasks } from '@/core/notifications/dismiss'
import { namedPushEndCheck } from '@/core/notifications/reminder-nags'
import {
  dismissEndedPromptPushes,
  promptPushEndCheckForEdit,
} from '@/core/notifications/prompt-nags'
import { formatTaskResponse } from '@/lib/format-task'
import { incrementDailyStat } from '@/core/stats'
import { dayBoundaryForUser } from './rollover-time'
import { NotFoundError, ForbiddenError, ValidationError } from '@/core/errors'
import { formatEditDescription } from '@/lib/field-labels'
import { getTaskById } from './read'
import { canUserAccessTask } from './access'
import { applyFieldChanges, collectFieldChanges, settleQuotaPeriod } from './helpers'
import { validateLabelsExist } from '@/core/labels'

// `canUserAccessTask` moved to `./access`; re-exported so existing `./update`
// imports keep working.
export { canUserAccessTask }

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
  /** §8.2: the requested target was past the deadline and stopped AT it. */
  cappedAtDeadline?: boolean
}

/** Task fields no widget (iOS, macOS, watchOS) decodes or draws. */
const WIDGET_INVISIBLE_FIELDS = new Set(['notes'])

/** The labels a widget reads: it skips reserved `ai-` labels (case-sensitive, as in TrackWidget.swift). */
function widgetLabels(labels: string[]): string {
  return JSON.stringify(labels.filter((l) => !l.startsWith('ai-')))
}

/**
 * Could this edit change anything a widget shows? False only when every
 * changed field is one widgets never read — `notes`, or a `labels` change
 * that touches nothing but `ai-*` labels (the Track widget files a quota
 * under its first non-`ai-` label, so order matters and is compared too).
 * Drives `emitSyncEvent`'s `widgets` flag, which spares the budgeted WidgetKit
 * push (see `SyncEventInfo` in `@/lib/sync-events`); open tabs refresh anyway.
 */
export function isWidgetVisibleEdit(
  fieldsChanged: string[],
  labelsBefore: string[],
  labelsAfter: string[],
): boolean {
  return fieldsChanged.some((field) => {
    if (WIDGET_INVISIBLE_FIELDS.has(field)) return false
    if (field === 'labels') return widgetLabels(labelsBefore) !== widgetLabels(labelsAfter)
    return true
  })
}

/**
 * Update a task using PATCH semantics
 *
 * Only fields present in input are updated.
 * Returns the updated task and list of changed fields.
 */
export function updateTask(options: UpdateTaskOptions): UpdateTaskResult {
  const { userId, userTimezone, taskId, input, prefetchedTask, skipWebhookDispatch } = options

  const found = prefetchedTask ?? getTaskById(taskId)
  if (!found) throw new NotFoundError('Task not found')
  if (!prefetchedTask) {
    // Only validate access if caller didn't pre-validate
    if (!canUserAccessTask(userId, found)) throw new ForbiddenError('Access denied')
  }
  // A rule sent to a quota may re-anchor it: close an expired period first,
  // so the edit carries this period's count, not a finished one's.
  const task = found.deleted_at ? found : settleQuotaPeriod(found, input)
  // Always check deleted_at, even for prefetched tasks — prevents future callers
  // from accidentally bypassing this guard by passing prefetchedTask
  if (task.deleted_at) throw new ValidationError('Cannot edit trashed task')

  // §7.2: only labels being NEWLY added are held to the registry. Passing the
  // task's current labels as `existing` is what lets an unrelated edit (a title
  // fix, a priority bump) succeed on a task that happens to carry a legacy
  // unregistered label — otherwise one stray tag would make that task
  // permanently uneditable.
  if (input.labels !== undefined) {
    validateLabelsExist(userId, input.labels, task.labels, input.create_label === true)
  }

  // Also enforces the quota/reminder invariants (a quota is never a reminder,
  // a reminder is never snoozed) — see its docblock. They live there so bulk
  // edit is held to them too.
  const data = collectFieldChanges({
    task,
    input,
    userId,
    userTimezone,
  })

  if (data.setClauses.length === 0) {
    return { task, fieldsChanged: [], description: '', cappedAtDeadline: data.cappedAtDeadline }
  }

  // Whether this reminder's named push stands before the edit (only asked of
  // an edit that could end it): if it no longer stands after, its banner goes.
  const endedNamedPush = namedPushEndCheck(task, data.fieldsChanged)
  // The same for a quota's named prompt pushes (prompt-nags.ts): priority
  // below Medium, no longer a quota, its prompt moved to another period.
  const endedPromptPush = promptPushEndCheckForEdit(task, data.fieldsChanged)

  // Relative targets (2026-10-24): the period a linked target follows, named
  // in the description ("Target the day before at Evening (8:30 PM)").
  let targetSlotLabel: string | undefined
  if (typeof data.afterState.target_slot_id === 'number') {
    const slot = getDb()
      .prepare('SELECT label FROM time_slots WHERE id = ?')
      .get(data.afterState.target_slot_id) as { label: string } | undefined
    targetSlotLabel = slot?.label
  }

  // Look up project name if project_id changed
  let projectName: string | undefined
  if (data.fieldsChanged.includes('project_id') && data.afterState.project_id) {
    const db = getDb()
    const project = db
      .prepare('SELECT name FROM projects WHERE id = ?')
      .get(data.afterState.project_id) as { name: string } | undefined
    if (project) projectName = project.name
  }

  const result = withTransaction((tx) => {
    const { snapshot, activity } = applyFieldChanges(tx, task, data, nowUtc())
    const description = formatEditDescription(task.title, data.fieldsChanged, {
      isSnooze: data.isSnoozeScenario,
      beforeState: data.beforeState,
      afterState: data.afterState,
      userTimezone,
      dayStart: dayBoundaryForUser(userId),
      projectName,
      cappedAtDeadline: data.cappedAtDeadline,
      targetSlotLabel,
    })
    logAction(userId, 'edit', description, data.fieldsChanged, [snapshot])

    // The single edit records the snapshot's states (id, title and the changed
    // fields) where the batch paths record `activity`'s collected ones.
    logActivity({
      userId,
      ...activity,
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

    return {
      task: updatedTask,
      fieldsChanged: data.fieldsChanged,
      description,
      cappedAtDeadline: data.cappedAtDeadline === true,
    }
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

  emitSyncEvent(userId, {
    widgets: isWidgetVisibleEdit(result.fieldsChanged, task.labels, result.task.labels),
  })

  // A moved date (a snooze, via snoozeTask too) or a completion makes the
  // task's delivered notification stale: dismiss it everywhere and resync the
  // badge. So does an edit that ends a reminder's named push (priority below
  // Medium, converted to a task, moved to Anytime or off today:
  // `namedPushStands`, reminder-nags.ts). Any other field leaves the
  // notification as true as it was. A quota's named prompt pushes the edit
  // ended go by prompt key (`promptPushEndCheckForEdit`): only those banners.
  if (
    result.fieldsChanged.includes('due_at') ||
    result.fieldsChanged.includes('done') ||
    endedNamedPush()
  ) {
    dismissNotificationsForTasks(userId, [taskId])
  }
  dismissEndedPromptPushes(userId, endedPromptPush)

  // Callers like snoozeTask() set skipWebhookDispatch to dispatch their own more specific event
  if (!skipWebhookDispatch) {
    dispatchWebhookEvent(userId, 'task.updated', {
      task: formatTaskResponse(result.task, userTimezone),
      fields_changed: result.fieldsChanged,
    })
  }

  return result
}
