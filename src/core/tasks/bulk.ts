/**
 * Bulk operations
 *
 * All bulk operations execute as a single transaction and produce a single undo entry.
 */

import { getDb, withTransaction } from '@/core/db'
import { isTracked } from '@/lib/track'
import type { QuotaPromptConfig, Task, UndoSnapshot } from '@/types'
import { nowUtc, isRecurring } from '@/core/recurrence'
import { logAction, createTaskSnapshot } from '@/core/undo'
import { logActivityBatch } from '@/core/activity'
import { emitSyncEvent } from '@/lib/sync-events'
import { dispatchWebhookEvent } from '@/core/webhooks/dispatch'
import { dismissNotificationsForTasks } from '@/core/notifications/dismiss'
import { formatTaskResponse } from '@/lib/format-task'
import type { ActivityEntry } from '@/core/activity'
import { incrementDailyStat } from '@/core/stats'
import { ValidationError, ForbiddenError } from '@/core/errors'
import { QUOTA_DONE_MESSAGE } from '@/core/validation'
import { formatBulkEditDescription, formatSnoozeTarget } from '@/lib/field-labels'
import { formatDurationDelta } from '@/lib/format-date'
import { validateLabelsExist } from '@/core/labels'
import { getTaskById } from './create'
import { canUserAccessTask } from './update'
import {
  computeMarkDone,
  executeMarkDone,
  collectFieldChanges,
  applyFieldChanges,
  type FieldChangesInput,
} from './helpers'
import { HIGH_PRIORITY_THRESHOLD } from '@/lib/priority'
import {
  describePromptActions,
  dispatchProgressed,
  executePromptActions,
  planPromptActions,
  type PromptAction,
} from './quota-prompt-actions'

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
  /**
   * §5: also complete the quotas in the batch — closing each one's period
   * early and resetting its count to 0. Off by default; see `bulkDone`.
   */
  closePeriod?: boolean
  /**
   * Quota reminders (2026-09-24): prompt actions committed in the SAME
   * transaction and undo entry as the completions — a checklist's mixed
   * commit, a slot's "Considered all". See `quota-prompt-actions.ts`.
   */
  prompts?: PromptAction[]
}

export interface BulkDoneResult {
  tasksAffected: number
  recurringCount: number
  oneOffCount: number
  /** Quotas left alone because `closePeriod` was not set. */
  quotaSkipped: number
  /** Prompts considered (without progress) in this batch. */
  promptsConsidered: number
  /** Prompts "did it" in this batch. */
  promptsDid: number
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
  const { userId, userTimezone, taskIds, closePeriod = false, prompts = [] } = options

  if (taskIds.length === 0 && prompts.length === 0) {
    return {
      tasksAffected: 0,
      recurringCount: 0,
      oneOffCount: 0,
      quotaSkipped: 0,
      promptsConsidered: 0,
      promptsDid: 0,
    }
  }

  const completedAt = new Date()
  const nowStr = nowUtc()

  // Validate all tasks exist and user has access before starting transaction (BO-002: atomic)
  const validated =
    taskIds.length > 0 ? validateBulkTasks(taskIds, userId, { excludeDoneNonRecurring: true }) : []
  // Prompt keys too: a stale or foreign key refuses the whole batch.
  const plannedPrompts = planPromptActions(userId, userTimezone, prompts, completedAt)

  // §5: `done` on a quota closes its period early and silently zeroes the
  // count (`computeMarkDone`'s period reset). Nothing in the app sends a quota
  // here — every done surface filters them out — so a quota in the batch is an
  // API caller that meant "log one" or a stale selection. SKIPPED rather than
  // refused, so one stale id does not abort the whole transaction (the lesson
  // `bulkEdit` learned, TR-023); refused only when nothing else is left, so a
  // caller sending just the quota still gets the explanation. `closePeriod`
  // is the deliberate opt-in.
  const tasks = closePeriod ? validated : validated.filter((t) => !isTracked(t))
  const quotaSkipped = validated.length - tasks.length
  if (tasks.length === 0 && plannedPrompts.length === 0 && quotaSkipped > 0) {
    throw new ValidationError(QUOTA_DONE_MESSAGE)
  }

  const snapshots: UndoSnapshot[] = []
  const activityEntries: ActivityEntry[] = []
  const batchId = crypto.randomUUID()
  let recurringCount = 0
  let oneOffCount = 0
  // The undo entry's `fieldsChanged` is the union of what each completion
  // changed, taken from `computeMarkDone` itself rather than restated here. A
  // hand-built list drifted once already: it left out `progress_current`, so
  // undoing a `closePeriod` batch put a quota's date back but not its count.
  const fieldsChanged = new Set<string>()

  const result = withTransaction((tx) => {
    for (const task of tasks) {
      // Compute state changes using shared helper
      const computation = computeMarkDone(task, userTimezone, completedAt, nowStr)
      computation.fieldsChanged.forEach((f) => fieldsChanged.add(f))

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

    // Single undo entry for entire batch (BO-004).
    //
    // Prompt actions ride the same entry. `fieldsChanged` is one list for the
    // whole entry, so it becomes the union — safe because `applyFieldsToTask`
    // skips any field a snapshot does not carry, and each snapshot carries
    // only its own fields.
    const prompted = executePromptActions(tx, userId, userTimezone, plannedPrompts, completedAt)
    if (tasks.length > 0) {
      logAction(
        userId,
        'bulk_done',
        prompted.snapshots.length > 0
          ? `Marked ${tasks.length} done; ${describePromptActions(prompted.considered, prompted.did)}`
          : `Marked ${tasks.length} tasks done`,
        [...new Set([...fieldsChanged, ...prompted.fieldsChanged])],
        [...snapshots, ...prompted.snapshots],
      )
    } else if (prompted.snapshots.length > 0) {
      // Nothing to log when the batch turned out empty (every id already
      // done): an entry with no snapshots would be an Undo that does nothing.
      logAction(
        userId,
        'quota_prompt',
        describePromptActions(prompted.considered, prompted.did),
        prompted.fieldsChanged,
        prompted.snapshots,
      )
    }
    if (activityEntries.length > 0) logActivityBatch(activityEntries)

    // Increment daily stats for all completed tasks (prompts are not completions)
    if (tasks.length > 0) incrementDailyStat(userId, 'completions', userTimezone, tasks.length)

    return {
      tasksAffected: tasks.length,
      recurringCount,
      oneOffCount,
      quotaSkipped,
      promptsConsidered: prompted.considered,
      promptsDid: prompted.did,
      progressed: prompted.progressed,
    }
  })

  emitSyncEvent(userId)
  // The completed items are handled, so their banners go too. A prompt-only
  // batch completes no task and leaves notifications (and the badge) alone.
  dismissNotificationsForTasks(
    userId,
    tasks.map((t) => t.id),
  )
  dispatchProgressed(userId, result.progressed)

  for (const task of tasks) {
    const fresh = getTaskById(task.id)
    if (fresh) {
      dispatchWebhookEvent(userId, 'task.completed', { task: formatTaskResponse(fresh) })
    }
  }

  const { progressed: _progressed, ...summary } = result
  return summary
}

interface BulkSnoozeFilterResult {
  eligible: Task[]
  urgentSkipped: number
  highSkipped: number
  reminderSkipped: number
}

/**
 * Priority filter for bulk snooze operations.
 *
 * P0-P2 (None through Medium) are always eligible. P4 (Urgent) never is: its
 * due date is a hard deadline, and every change to one has to be a deliberate,
 * individual act.
 *
 * P3 (High) IS BULK-SNOOZABLE, BUT ONLY WHEN NOTHING LOWER IS LEFT (Trent,
 * 2026-09-15). He had four overdue High tasks and one button, and the button
 * said "no snoozable tasks" — the sweep could not touch the only thing that was
 * late, so the list stayed wrong. Excluding High outright was protecting a
 * deadline from a sweep the user did not read; but a sweep aimed at a batch
 * that is ALREADY nothing but deadlines is not that sweep, it is the user
 * looking straight at them and pressing anyway.
 *
 * So: the first press clears P0-P2, and a second press — finding only P3 left —
 * takes it. Two presses, no mode, no second button.
 *
 * THE TEST IS "IS ANYTHING LOWER STILL ELIGIBLE", NOT "IS THE BATCH PURE". A
 * P4 sitting in the batch does NOT hold the P3 sweep back, because a P4 is
 * never swept — it would sit there forever and the second press would never
 * come. Only a still-sweepable P0-P2 defers the High tier.
 *
 * The test is by PRIORITY, deliberately. In relative (`deltaMinutes`) mode a
 * P0-P2 task with no `due_at` is dropped later, after this filter, so such a
 * task counts as "lower and still eligible" here even though this particular
 * call will not move it. Every caller that sweeps — the header button and the
 * iOS notification action — uses absolute mode, where that gap cannot open.
 *
 * `includeTaskIds` still rescues an explicitly chosen task at any priority,
 * P4 included, and a rescued task is never what defers the High tier.
 *
 * COUNTS: `urgentSkipped` is the TOTAL skipped on priority (High + Urgent) and
 * keeps its name for API compatibility (`skipped_urgent` reaches the iOS
 * client); `highSkipped` is the High subset, so a caller can word a message
 * that names the two accurately. Urgent alone is the difference.
 */
function filterForBulkSnooze(tasks: Task[], includeTaskIds?: Set<number>): BulkSnoozeFilterResult {
  // §6: reminders are bucket-locked and can never be snoozed, not even by an
  // explicit selection — `include_task_ids` deliberately does NOT rescue them,
  // because the constraint is about what a reminder IS, not about how carefully
  // the user picked it.
  //
  // Skipped silently and reported as a count, never prompted: §4.3 is explicit
  // that bulk paths must not modal-block, and per L1 sweep participation
  // carries no per-item intent to confirm.
  //
  // §5: a quota is never late either — since 2026-09-08 it has no `due_at` at
  // all, so there is nothing for a sweep to move. Counted with the reminders as
  // "not debt".
  const snoozable = tasks.filter((t) => !t.is_reminder && !isTracked(t))
  const reminderSkipped = tasks.length - snoozable.length

  const priorityOf = (t: Task) => t.priority ?? 0
  const anyLowerLeft = snoozable.some((t) => priorityOf(t) < HIGH_PRIORITY_THRESHOLD)
  // The ceiling this call sweeps up to, inclusive. Normally P2; once nothing
  // lower is left, the High tier joins in. P4 is above both and never included.
  const ceiling = anyLowerLeft ? HIGH_PRIORITY_THRESHOLD - 1 : HIGH_PRIORITY_THRESHOLD

  const eligible: Task[] = []
  let urgentSkipped = 0
  let highSkipped = 0
  for (const task of snoozable) {
    if (priorityOf(task) <= ceiling || includeTaskIds?.has(task.id)) {
      eligible.push(task)
      continue
    }
    urgentSkipped++
    if (priorityOf(task) === HIGH_PRIORITY_THRESHOLD) highSkipped++
  }

  return { eligible, urgentSkipped, highSkipped, reminderSkipped }
}

export interface BulkSnoozeOptions {
  userId: number
  userTimezone: string
  taskIds: number[]
  /** Absolute snooze target (ISO 8601 datetime) - all tasks set to this time */
  until?: string
  /** Relative snooze delta (minutes) - added to each task's current due_at */
  deltaMinutes?: number
  /** Task IDs to include regardless of priority (bypasses the High/Urgent filter) */
  includeTaskIds?: number[]
  /**
   * The ids that were currently due just before this snooze, when the caller
   * has already measured them (`getCurrentlyDueTaskIds`). Lets the post-snooze
   * badge count be worked out by arithmetic instead of measured again — see
   * the dismissal at the end of `bulkSnooze`.
   */
  dueBeforeIds?: number[]
}

export interface BulkSnoozeResult {
  tasksAffected: number
  tasksSkipped: number
  /**
   * Skipped on priority: High AND Urgent together. The name is kept because
   * `skipped_urgent` is in the public API and reaches the iOS client.
   */
  urgentSkipped: number
  /** The High (P3) subset of `urgentSkipped`. Urgent alone is the difference. */
  highSkipped: number
  /**
   * How many of the tasks actually moved were High (P3). A bulk press sweeps
   * High only once nothing lower is left, so the second press of a "double
   * snooze" moves High alone — and its toast should say so (Trent,
   * 2026-09-22).
   */
  highSnoozed: number
  /** §6: reminders excluded because they are bucket-locked. */
  reminderSkipped: number
  noDueDateSkipped: number
  /**
   * The ids actually moved, in the order they were snoozed.
   *
   * The caller used to recover this by walking `getCurrentlyDueTaskIds()` a
   * second time and diffing — an rrule evaluation over every recurring task
   * (~70ms on a 512-task account) to learn something this function already
   * knew. It is also the more truthful answer: the diff inferred "snoozed"
   * from "no longer due", which is only the same thing as long as nothing else
   * changes a due date in between.
   */
  snoozedIds: number[]
}

/**
 * Bulk snooze
 *
 * Snoozes all specified tasks. Supports two modes:
 * - Absolute (until): Sets all tasks to the same target time
 * - Relative (deltaMinutes): Adds minutes to each task's current due_at
 *
 * Follows same original_due_at rules as single snooze. Which tasks it will
 * actually touch is `filterForBulkSnooze`'s decision — P0-P2 always, P3 once
 * nothing lower is left in the batch, P4 never.
 */
export function bulkSnooze(options: BulkSnoozeOptions): BulkSnoozeResult {
  const { userId, userTimezone, taskIds, until, deltaMinutes, includeTaskIds, dueBeforeIds } =
    options

  if (taskIds.length === 0) {
    return {
      tasksAffected: 0,
      tasksSkipped: 0,
      urgentSkipped: 0,
      highSkipped: 0,
      highSnoozed: 0,
      reminderSkipped: 0,
      noDueDateSkipped: 0,
      snoozedIds: [],
    }
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

  // P0-P2 always; P3 once nothing lower is left; P4 never — unless explicitly
  // included. See `filterForBulkSnooze`.
  const includeSet = includeTaskIds?.length ? new Set(includeTaskIds) : undefined
  const { eligible, urgentSkipped, highSkipped, reminderSkipped } = filterForBulkSnooze(
    tasks,
    includeSet,
  )

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
    return {
      tasksAffected: 0,
      tasksSkipped: skippedCount,
      urgentSkipped,
      highSkipped,
      highSnoozed: 0,
      reminderSkipped,
      noDueDateSkipped,
      snoozedIds: [],
    }
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
      highSkipped,
      highSnoozed: snoozeable.filter((t) => t.priority === HIGH_PRIORITY_THRESHOLD).length,
      reminderSkipped,
      noDueDateSkipped,
      snoozedIds: snoozeable.map((t) => t.id),
    }
  })

  emitSyncEvent(userId)
  dismissNotificationsForTasks(
    userId,
    result.snoozedIds,
    stillDueAfterSnooze(dueBeforeIds, result.snoozedIds, until),
  )

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

/**
 * The overdue count after a snooze, when it can be known without measuring.
 *
 * Only the tasks actually moved (`snoozedIds`) have their notifications
 * dismissed — a P4 the priority filter skipped may still be overdue and keep
 * its banner.
 *
 * PERF (2026-09-06): the snooze-overdue sweep used to walk
 * `getCurrentlyDueTaskIds()` a second time and diff, and the dismissal then
 * walked it a THIRD time for the badge. Each walk evaluates an rrule per
 * recurring task — measured at 69ms on a 512-task/193-recurring account, so
 * ~208ms of the request was the same question asked three times. When the
 * caller already measured what was due (`dueBeforeIds`), the surviving count
 * follows from arithmetic: everything snoozed went to `until`, so what stays
 * due is precisely what was due and did not move.
 *
 * That only holds while `until` is an absolute time genuinely in the future.
 * bulkSnooze deliberately permits a past target ("tasks will just appear
 * overdue immediately"), and a relative move can land anywhere, so in those
 * cases this returns undefined and the badge is measured — rather than report
 * one that is too low.
 */
function stillDueAfterSnooze(
  dueBeforeIds: number[] | undefined,
  snoozedIds: number[],
  until: string | undefined,
): number | undefined {
  if (!dueBeforeIds || until === undefined) return undefined
  if (new Date(until).getTime() <= Date.now()) return undefined
  const snoozed = new Set(snoozedIds)
  return dueBeforeIds.filter((id) => !snoozed.has(id)).length
}

/** Type alias for bulk edit changes — same as FieldChangesInput (TaskUpdateInput + label operations) */
export type BulkEditChanges = FieldChangesInput

export interface BulkEditOptions {
  userId: number
  userTimezone: string
  taskIds: number[]
  changes: BulkEditChanges
  /** Per-task values merged over `changes` (see `bulkEditSchema.per_task`). */
  perTask?: Record<string, Partial<BulkEditChanges>>
  /**
   * Task ids the High/Urgent sweep filter must not drop — explicit picks, as
   * in `bulkSnooze`. Without it a date on a selection that holds a P4 would
   * silently leave the P4 where it was.
   */
  includeTaskIds?: number[]
  /** Relative date move: each task's OWN due date plus this many minutes. */
  deltaMinutes?: number
  /**
   * Scope the date part of the edit (`changes.due_at` / `deltaMinutes`) to
   * these ids. Every other field still applies to every id in `taskIds`.
   * Omitted = the date applies to all of them.
   */
  dateTaskIds?: number[]
}

export interface BulkEditResult {
  tasksAffected: number
  tasksSkipped: number
  /** Tasks a relative (`deltaMinutes`) move could not shift — they have no date. */
  noDueDateSkipped: number
}

interface BulkEditDatePlan {
  /** Tasks the date part must NOT be applied to (every other field still is). */
  withheld: Set<number>
  /** Withheld by a rule (quota, sweep filter, no date to shift) — reported as skipped. */
  skipped: number
  noDueDateSkipped: number
}

/**
 * §5: a quota has no due date, so a date-bearing batch skips it rather than
 * failing. `collectFieldChanges` throws QUOTA_DUE_DATE_MESSAGE on a tracked
 * row given a date, and one throw aborts the whole transaction — a mixed
 * selection lost the plain tasks' edits too. The snooze filter in
 * `planBulkEditDates` also leaves quotas out, but only for a date sent
 * WITHOUT an rrule; `{ due_at, rrule }` together, and a per-task date, would
 * go straight through. Runs before that filter so the two never double-count.
 *
 * The quota is dropped WHOLE, not just its date: the rest of such an edit
 * (`rrule: null` beside a date) is exactly what a quota refuses (it needs a
 * period), and TR-023/TR-024 pin that it is left untouched.
 */
function dropQuotasFromDatedBatch(
  tasks: Task[],
  changes: BulkEditChanges,
  perTask: BulkEditOptions['perTask'],
  deltaMinutes: number | undefined,
): { tasks: Task[]; skipped: number } {
  const bearsDate =
    changes.due_at != null ||
    deltaMinutes !== undefined ||
    Object.values(perTask ?? {}).some((p) => (p as { due_at?: string | null }).due_at != null)
  if (!bearsDate) return { tasks, skipped: 0 }
  const kept = tasks.filter((t) => !isTracked(t))
  return { tasks: kept, skipped: tasks.length - kept.length }
}

/**
 * Which tasks in a bulk edit take the DATE part of the edit.
 *
 * ONE SAVE, ONE UNDO (Trent, 2026-09-27). The multi-select quick panel used to
 * send a date change to bulk/snooze and the rest (priority, labels…) to
 * bulk/edit in parallel: two undo entries whose order was a race, and a
 * partial failure left half the change behind. Both now travel in this one
 * request, so the date rules that used to live in bulk/snooze's filtering
 * have to live here, PER TASK: a task the date cannot apply to still takes
 * the rest of the edit — exactly what it got when the two halves were
 * separate requests. (Before, a date-bearing bulk edit dropped such a task
 * from the whole batch; for a date-only edit the result is the same, since
 * a task left with nothing to change is skipped either way.)
 *
 * Quotas are the exception and are not planned here: a date-bearing batch
 * still drops a quota WHOLE (`dropQuotasFromDatedBatch`), since the rest of
 * such an edit (`rrule: null` alongside a date) can be what a quota refuses.
 *
 * The date is withheld from a task when:
 * - it is outside `dateTaskIds` (the snooze confirmation opted it out) — not
 *   counted as skipped, the user chose it;
 * - it is a snooze (a date without an rrule change) and `filterForBulkSnooze`
 *   leaves it out — the same function bulk/snooze uses, with the same
 *   `includeTaskIds` rescue for explicit picks;
 * - it is a relative move and the task has no date to move.
 */
function planBulkEditDates(
  tasks: Task[],
  changes: BulkEditChanges,
  opts: Pick<BulkEditOptions, 'includeTaskIds' | 'deltaMinutes' | 'dateTaskIds'>,
): BulkEditDatePlan {
  const { includeTaskIds, deltaMinutes, dateTaskIds } = opts
  const plan: BulkEditDatePlan = { withheld: new Set(), skipped: 0, noDueDateSkipped: 0 }
  const hasDate = changes.due_at !== undefined || deltaMinutes !== undefined
  if (!hasDate) return plan

  const scope = dateTaskIds ? new Set(dateTaskIds) : null
  let candidates = tasks.filter((t) => {
    if (!scope || scope.has(t.id)) return true
    plan.withheld.add(t.id)
    return false
  })
  const withhold = (keep: (t: Task) => boolean) => {
    candidates = candidates.filter((t) => {
      if (keep(t)) return true
      plan.withheld.add(t.id)
      plan.skipped++
      return false
    })
  }

  // Priority filter for snooze edits — literally the same function as
  // bulkSnooze, so the High tier's "only once nothing lower is left" rule
  // applies here too. A date change is only a snooze when rrule is not being
  // changed; with an rrule (even null) it is part of a schedule change.
  const isSnoozeEdit = changes.rrule === undefined
  if (isSnoozeEdit) {
    const includeSet = includeTaskIds?.length ? new Set(includeTaskIds) : undefined
    const eligible = new Set(filterForBulkSnooze(candidates, includeSet).eligible.map((t) => t.id))
    withhold((t) => eligible.has(t.id))
  }

  if (deltaMinutes !== undefined) {
    const before = plan.skipped
    withhold((t) => t.due_at !== null)
    plan.noDueDateSkipped = plan.skipped - before
  }

  return plan
}

/**
 * §7.2: a label typed while editing SEVERAL rows has to reach the registry.
 *
 * `collectFieldChanges` writes `labels` as raw SQL, so a name that exists on no
 * other task was written to every selected row and then known to nothing: the
 * next editor did not offer the chip, and the filter bar had no idea it
 * existed. The Quotas page routes any selection of two or more through this
 * endpoint, so "select two quotas → Label → + New → kids → Save" was exactly
 * the broken case.
 *
 * Only when the caller asks. `validateLabelsExist` THROWS on an unknown name
 * without the flag, and this endpoint has never validated labels at all —
 * turning that on for every existing caller would start rejecting writes that
 * work today. `existing: []` because the flag means "register whatever is
 * missing", independent of what the selected rows already carry.
 */
function registerBulkEditLabels(userId: number, changes: BulkEditChanges): void {
  if (changes.create_label !== true) return
  const incoming = [...(changes.labels ?? []), ...(changes.labels_add ?? [])]
  if (incoming.length > 0) validateLabelsExist(userId, incoming, [], true)
}

/**
 * A bulk `quota_prompt_config` is a PATCH of each quota's config, not a
 * replacement (2026-09-25, the Quotas page's multi-edit "Remind me daily").
 *
 * The selected quotas each carry their own config — one is switched off,
 * another has its 2nd number in the Evening — and the editor applies only what
 * the user changed. Replacing the whole object would wipe every field the
 * request did not name, on every quota at once. So the fields sent are laid
 * over each row's STORED config, top level only:
 *
 * - `enabled` / `slot_id` replace that field.
 * - `numbers` replaces the per-number map as a unit; an EMPTY map clears it
 *   (the key is dropped, so a cleared config reads exactly like one that never
 *   had overrides). That is how "Reminds me in Morning" on several daily
 *   quotas lands: `slot_id` set, overrides cleared, the numbers spreading from
 *   that base as they do by default.
 * - `null` (the whole config) still clears it — handled by the caller, which
 *   only merges an object. A merge that leaves nothing is stored as NULL too.
 *
 * Merged here against the row as it is NOW, not by the client against the
 * snapshot its modal opened with: a prompt moved from another tab in between
 * keeps its move. The single-task PATCH keeps replace semantics — its callers
 * (the editor, `movedPromptConfig`) already send the merged whole.
 */
function mergePromptConfig(
  stored: QuotaPromptConfig | null,
  patch: QuotaPromptConfig,
): QuotaPromptConfig | null {
  const merged: QuotaPromptConfig = { ...(stored ?? {}), ...patch }
  if (merged.numbers && Object.keys(merged.numbers).length === 0) delete merged.numbers
  // Nothing left is "follow the defaults" — NULL, as an untouched quota has.
  return Object.keys(merged).length > 0 ? merged : null
}

/**
 * Bulk edit
 *
 * Applies the same changes to all specified tasks. `quota_prompt_config` is
 * the exception that merges per task — see `mergePromptConfig`.
 */
export function bulkEdit(options: BulkEditOptions): BulkEditResult {
  const { userId, userTimezone, taskIds, changes, perTask, deltaMinutes } = options

  if (taskIds.length === 0) {
    return { tasksAffected: 0, tasksSkipped: 0, noDueDateSkipped: 0 }
  }
  if (deltaMinutes !== undefined && changes.due_at !== undefined) {
    throw new ValidationError('Cannot provide both due_at and delta_minutes')
  }

  let tasks = validateBulkTasks(taskIds, userId)

  registerBulkEditLabels(userId, changes)

  // Reject rrule changes on done tasks — setting rrule on a done+archived task creates
  // an impossible state (done=1 + rrule set) that the system never produces organically
  let rruleSkippedCount = 0
  const setsRrule =
    (changes.rrule !== undefined && changes.rrule !== null) ||
    Object.values(perTask ?? {}).some((p) => p.rrule !== undefined && p.rrule !== null)
  if (setsRrule) {
    const beforeCount = tasks.length
    tasks = tasks.filter((t) => !t.done)
    rruleSkippedCount = beforeCount - tasks.length
  }

  const quotas = dropQuotasFromDatedBatch(tasks, changes, perTask, deltaMinutes)
  tasks = quotas.tasks

  // Which tasks take the date part — see `planBulkEditDates`.
  const dates = planBulkEditDates(tasks, changes, options)
  const inputFor = (task: Task): BulkEditChanges => {
    const input = { ...changes, ...(perTask?.[String(task.id)] ?? {}) }
    if (dates.withheld.has(task.id)) {
      delete input.due_at
    } else if (deltaMinutes !== undefined && task.due_at) {
      input.due_at = new Date(new Date(task.due_at).getTime() + deltaMinutes * 60_000).toISOString()
    }
    if (input.quota_prompt_config) {
      input.quota_prompt_config = mergePromptConfig(
        task.quota_prompt_config,
        input.quota_prompt_config,
      )
    }
    return input
  }
  // A task left with nothing to change once its date is withheld is not
  // touched at all — which is what a date-only edit always did with it.
  tasks = tasks.filter((t) => Object.keys(inputFor(t)).length > 0)
  const tasksSkipped = rruleSkippedCount + quotas.skipped + dates.skipped
  if (tasks.length === 0) {
    return { tasksAffected: 0, tasksSkipped, noDueDateSkipped: dates.noDueDateSkipped }
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
        input: inputFor(task),
        userId,
        userTimezone,
        now: nowDate,
        skipProjectValidation: true, // Already validated above
      })

      if (data.fieldsChanged.length > 0) {
        const { snapshot, activity } = applyFieldChanges(tx, task, data, nowStr)
        snapshots.push(snapshot)
        activityEntries.push({ userId, ...activity, source: 'bulk', batchId })

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
      tasksSkipped,
      noDueDateSkipped: dates.noDueDateSkipped,
    }
  })

  emitSyncEvent(userId)
  // Only a task whose date actually moved has a stale notification; a
  // priority or label edit leaves the banner as true as it was.
  dismissNotificationsForTasks(
    userId,
    [...perTaskFields].filter(([, fields]) => fields.includes('due_at')).map(([id]) => id),
  )

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
  dismissNotificationsForTasks(
    userId,
    tasks.map((t) => t.id),
  )

  for (const task of tasks) {
    dispatchWebhookEvent(userId, 'task.deleted', { task_id: task.id, title: task.title })
  }

  return result
}
