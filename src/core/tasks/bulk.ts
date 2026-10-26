/**
 * Bulk operations
 *
 * All bulk operations execute as a single transaction and produce a single undo entry.
 */

import { getTargetContext } from './target-context'
import { ownerSlots, type SlotsFor } from './relative-target'
import type { TargetContext } from '@/lib/task-segments'

/**
 * The target context (`getTargetContext`: the zone and morning time an
 * automatic target and a relative target are derived in) of each task's
 * OWNER, memoized: a batch over a shared project reads each owner once.
 */
function ownerContexts(): (ownerId: number) => TargetContext {
  const cache = new Map<number, TargetContext>()
  return (ownerId) => {
    if (!cache.has(ownerId)) cache.set(ownerId, getTargetContext(ownerId))
    return cache.get(ownerId)!
  }
}
import { getDb, withTransaction } from '@/core/db'
import { isTracked } from '@/lib/track'
import type { QuotaPromptConfig, Task, UndoAction, UndoSnapshot } from '@/types'
import { nowUtc, isRecurring } from '@/core/recurrence'
import { nextOccurrenceAfterSkip } from './skip'
import { logAction, createTaskSnapshot } from '@/core/undo'
import { logActivityBatch } from '@/core/activity'
import { emitSyncEvent } from '@/lib/sync-events'
import { dispatchWebhookEvent } from '@/core/webhooks/dispatch'
import { dismissNotificationsForTasks } from '@/core/notifications/dismiss'
import { namedPushEndCheck } from '@/core/notifications/reminder-nags'
import {
  dismissEndedPromptPushes,
  promptPushEndCheck,
  promptPushEndCheckForEdit,
} from '@/core/notifications/prompt-nags'
import { formatTaskResponse } from '@/lib/format-task'
import type { ActivityEntry } from '@/core/activity'
import { incrementDailyStat } from '@/core/stats'
import { ValidationError, ForbiddenError } from '@/core/errors'
import { QUOTA_DONE_MESSAGE } from '@/core/validation'
import { formatBulkEditDescription, formatSnoozeTarget } from '@/lib/field-labels'
import { formatDurationDelta, formatTimeInTimezone } from '@/lib/format-date'
import { bulkSnoozeMessage } from '@/lib/snooze'
import { taskWord } from '@/lib/utils'
import { nextRollover } from '@/lib/opentask-day'
import { taskQueueEnabled } from './task-queue'
import { dayBoundaryForUser, rolloverTimeForUser } from './rollover-time'
import { validateLabelsExist } from '@/core/labels'
import { getTaskById } from './create'
import { canUserAccessTask } from './update'
import {
  computeMarkDone,
  executeMarkDone,
  collectFieldChanges,
  applyFieldChanges,
  settleQuotaPeriod,
  type FieldChangesInput,
} from './helpers'
import { HIGH_PRIORITY_THRESHOLD } from '@/lib/priority'
import { isPastDeadline, occurrenceDates, seriesEndedBySkip } from '@/lib/task-segments'
import type { ClientProgressSource } from '@/lib/progress-source'
import {
  describePromptActions,
  dispatchProgressed,
  executePromptActions,
  planPromptActions,
  type PromptAction,
} from './quota-prompt-actions'

interface ValidateBulkTasksOptions {
  /**
   * Refuse tasks that cannot be completed (used by bulkDone): done — a
   * one-off, or (repeat ends, 2026-10-22) a repeat whose series ended on a
   * done — and a repeat whose series ended on a skip (archived).
   */
  excludeClosed?: boolean
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
    if (options.excludeClosed && (task.done || seriesEndedBySkip(task))) {
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
  /** Where a prompt's did-it was logged from (`progress_events.source`). */
  source?: ClientProgressSource
}

export interface BulkDoneResult {
  tasksAffected: number
  recurringCount: number
  /** Repeat ends (2026-10-22): repeats whose last occurrence this batch completed (in `recurringCount`). */
  seriesEndedCount: number
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
  const { userId, userTimezone, taskIds, closePeriod = false, prompts = [], source } = options

  if (taskIds.length === 0 && prompts.length === 0) {
    return {
      tasksAffected: 0,
      recurringCount: 0,
      seriesEndedCount: 0,
      oneOffCount: 0,
      quotaSkipped: 0,
      promptsConsidered: 0,
      promptsDid: 0,
    }
  }

  const completedAt = new Date()
  const nowStr = nowUtc()
  // A from_completion repeat counts from the completion's OpenTask date.
  const dayStart = dayBoundaryForUser(userId)

  // Validate all tasks exist and user has access before starting transaction (BO-002: atomic)
  const validated =
    taskIds.length > 0 ? validateBulkTasks(taskIds, userId, { excludeClosed: true }) : []
  // Prompt keys too: a stale or foreign key refuses the whole batch.
  const plannedPrompts = planPromptActions(userId, userTimezone, prompts, completedAt)
  // A named prompt push (prompt-nags.ts) this batch ends: its banner goes too.
  const endedPromptPush = promptPushEndCheck(userId, [
    ...new Set(plannedPrompts.map((p) => p.taskId)),
  ])

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
  let seriesEndedCount = 0
  let oneOffCount = 0
  // The undo entry's `fieldsChanged` is the union of what each completion
  // changed, taken from `computeMarkDone` itself rather than restated here. A
  // hand-built list drifted once already: it left out `progress_current`, so
  // undoing a `closePeriod` batch put a quota's date back but not its count.
  const fieldsChanged = new Set<string>()

  const result = withTransaction((tx) => {
    for (const task of tasks) {
      // Compute state changes using shared helper
      const computation = computeMarkDone(task, userTimezone, completedAt, nowStr, dayStart, () =>
        rolloverTimeForUser(task.user_id),
      )
      computation.fieldsChanged.forEach((f) => fieldsChanged.add(f))

      // Track counts (an ended series counts as recurring — repeat ends)
      if (computation.type !== 'one_off') {
        recurringCount++
        if (computation.type === 'series_end') seriesEndedCount++
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
          recurring: computation.type !== 'one_off',
          ...(computation.type === 'recurring' ? { next_due_at: computation.nextDueAt } : {}),
          ...(computation.type === 'series_end' ? { series_ended: true } : {}),
        },
      })
    }

    // Single undo entry for entire batch (BO-004).
    //
    // Prompt actions ride the same entry. `fieldsChanged` is one list for the
    // whole entry, so it becomes the union — safe because `applyFieldsToTask`
    // skips any field a snapshot does not carry, and each snapshot carries
    // only its own fields.
    const prompted = executePromptActions(
      tx,
      userId,
      userTimezone,
      plannedPrompts,
      completedAt,
      source,
    )
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
      seriesEndedCount,
      oneOffCount,
      quotaSkipped,
      promptsConsidered: prompted.considered,
      promptsDid: prompted.did,
      progressed: prompted.progressed,
    }
  })

  emitSyncEvent(userId)
  // The completed items are handled, so their banners go too — and the
  // prompts whose named push the batch ended (`promptPushEndCheck`), by
  // prompt key. A prompt-only batch that ended none leaves notifications
  // (and the badge) alone.
  dismissNotificationsForTasks(
    userId,
    tasks.map((t) => t.id),
  )
  dismissEndedPromptPushes(userId, endedPromptPush)
  dispatchProgressed(userId, result.progressed)

  for (const task of tasks) {
    const fresh = getTaskById(task.id)
    if (fresh) {
      dispatchWebhookEvent(userId, 'task.completed', {
        task: formatTaskResponse(fresh, userTimezone),
        // Repeat ends: a repeating task left done is a series that ended here.
        ...(fresh.done && fresh.rrule ? { series_ended: true } : {}),
      })
    }
  }

  const { progressed: _progressed, ...summary } = result
  return summary
}

interface BulkSnoozeFilterResult {
  eligible: Task[]
  urgentSkipped: number
  highSkipped: number
  /** Below High by priority, held to the High tier by a passed deadline. */
  deadlineSkipped: number
  reminderSkipped: number
  /** The one High-tier task "one High per press" let through (`oneHigh`), if any. */
  oneHighId?: number
}

/**
 * The tier a bulk sweep reads a task at (Trent's ruling, 2026-10-12): its
 * priority — except that a task whose deadline has PASSED counts as at least
 * High (P3), so it is swept only once nothing lower is left in the batch. A
 * P3 with a passed deadline is still P3; a P4 is never swept, deadline or not.
 */
export function bulkSnoozeTier(
  task: Pick<Task, 'priority' | 'deadline_at'>,
  now: Date = new Date(),
): number {
  const priority = task.priority ?? 0
  return isPastDeadline(task.deadline_at, now)
    ? Math.max(priority, HIGH_PRIORITY_THRESHOLD)
    : priority
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
 * A PASSED DEADLINE JOINS THE HIGH TIER (Trent's ruling, 2026-10-12): the
 * test reads `bulkSnoozeTier`, not the bare priority. A P1 whose deadline has
 * passed waits for the second press like a High task; on its own it moves.
 *
 * COUNTS: `urgentSkipped` is the TOTAL skipped on priority (High + Urgent) and
 * keeps its name for API compatibility (`skipped_urgent` reaches the iOS
 * client); `highSkipped` is the High subset, so a caller can word a message
 * that names the two accurately. Urgent alone is the difference.
 * `deadlineSkipped` counts the tasks held back ONLY by a passed deadline (their
 * own priority is below High). It is not in `urgentSkipped`, so the native
 * apps' High/Urgent lines stay true; it reaches the API as `skipped_deadline`.
 */
function filterForBulkSnooze(
  tasks: Task[],
  includeTaskIds?: Set<number>,
  now: Date = new Date(),
  { oneHigh = false }: { oneHigh?: boolean } = {},
): BulkSnoozeFilterResult {
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
  const tierOf = (t: Task) => bulkSnoozeTier(t, now)
  const anyLowerLeft = snoozable.some((t) => tierOf(t) < HIGH_PRIORITY_THRESHOLD)
  // The ceiling this call sweeps up to, inclusive. Normally P2; once nothing
  // lower is left, the High tier joins in. P4 is above both and never included.
  //
  // ONE HIGH PER PRESS (task queue, B8 / resolution 8, switch on, defers only): once
  // nothing lower is left, the press takes ONE task of the High tier instead
  // of all of it — the oldest target first, then the nearest deadline, then
  // the lowest id (`pickOneHigh`) — and the toast names it. The rest stay
  // skipped and counted exactly as before.
  const ceiling = anyLowerLeft || oneHigh ? HIGH_PRIORITY_THRESHOLD - 1 : HIGH_PRIORITY_THRESHOLD
  const oneHighId =
    oneHigh && !anyLowerLeft
      ? pickOneHigh(
          snoozable.filter(
            (t) => tierOf(t) === HIGH_PRIORITY_THRESHOLD && !includeTaskIds?.has(t.id),
          ),
        )?.id
      : undefined

  const eligible: Task[] = []
  let urgentSkipped = 0
  let highSkipped = 0
  let deadlineSkipped = 0
  for (const task of snoozable) {
    if (tierOf(task) <= ceiling || includeTaskIds?.has(task.id) || task.id === oneHighId) {
      eligible.push(task)
      continue
    }
    if (priorityOf(task) < HIGH_PRIORITY_THRESHOLD) {
      deadlineSkipped++
      continue
    }
    urgentSkipped++
    if (priorityOf(task) === HIGH_PRIORITY_THRESHOLD) highSkipped++
  }

  return { eligible, urgentSkipped, highSkipped, deadlineSkipped, reminderSkipped, oneHighId }
}

/**
 * Which High-tier task one press moves (resolution 8): the oldest target
 * first, then the nearest deadline (none sorts last), then the lowest id.
 */
function pickOneHigh(candidates: Task[]): Task | undefined {
  const time = (iso: string | null) => (iso ? Date.parse(iso) : Number.POSITIVE_INFINITY)
  return [...candidates].sort(
    (a, b) =>
      time(a.due_at) - time(b.due_at) || time(a.deadline_at) - time(b.deadline_at) || a.id - b.id,
  )[0]
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
  /**
   * PICK OR DEFER (task queue, 2026-10-19; spec "Picks and defers"). Absent =
   * a pick ("this, at this time"), today's behaviour. `'sweep'` = Snooze-all
   * in any form (the web clock and FAB, `/bulk/snooze-overdue`); `'try_tomorrow'`
   * = Try Tomorrow on one task. With `OPENTASK_TASK_QUEUE` on, a defer landing
   * at or after the next rollover moves the target to that rollover and marks
   * the task for the queue (`planLanding`). Switch off: ignored, except that
   * Try Tomorrow still lands on the next rollover (with no mark).
   */
  source?: BulkSnoozeSource
}

export type BulkSnoozeSource = 'sweep' | 'try_tomorrow'

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
   * Held back by a passed deadline (Trent's ruling, 2026-10-12): below High by
   * priority, but a passed deadline puts a task in the High tier, swept only
   * once nothing lower is left (`bulkSnoozeTier`). Not in `urgentSkipped`.
   */
  deadlineSkipped: number
  /** Snoozed only as far as their deadline (§8.2). Counted in `tasksAffected` too. */
  deadlineCapped: number
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
  /** Task queue: moved to the next rollover and marked for the queue. In `tasksAffected`. */
  queued: number
  /** The marked task's title when exactly one was marked; else null. */
  queuedName: string | null
  /** Task queue (B2): repeating tasks a defer stopped at their next occurrence. */
  cappedOccurrence: number
  /** Task queue (B8): the one High this press moved, by title; else null. */
  snoozedHighName: string | null
  /**
   * Task queue: the rollover moment (ISO) the queued tasks were targeted at;
   * null when nothing was queued. A client words marked tasks from this,
   * never from the request's `until`.
   */
  queuedUntil: string | null
  /**
   * The standard one-line summary (spec rule 4) — the web toast, the
   * snooze-overdue `message` the Shortcuts show and (later) the native apps
   * read it. `bulkSnoozeMessage`. It names tasks; the lock-screen push uses
   * the count-only twin (`bulkSnoozeCountSummary`).
   */
  summary: string
}

/** Whether the deadline cap (§8.2) stopped this task's date at its deadline. */
function wasCapped(data: { cappedAtDeadline?: boolean; fieldsChanged: string[] }): boolean {
  return data.cappedAtDeadline === true && data.fieldsChanged.includes('due_at')
}

/**
 * Exactly one of `until` / `deltaMinutes`, and a parseable `until`. Try
 * Tomorrow needs neither: it always lands on the next rollover.
 */
function validateSnoozeMode(
  until: string | undefined,
  deltaMinutes: number | undefined,
  source: BulkSnoozeSource | undefined,
): void {
  if (until === undefined && deltaMinutes === undefined && source !== 'try_tomorrow') {
    throw new ValidationError('Either until or deltaMinutes must be provided')
  }
  if (until !== undefined && deltaMinutes !== undefined) {
    throw new ValidationError('Cannot provide both until and deltaMinutes')
  }
  // A past `until` is allowed: the tasks just show as over target at once.
  if (until !== undefined && isNaN(new Date(until).getTime())) {
    throw new ValidationError('Invalid defer target datetime')
  }
}

/**
 * What one call knows about picks and defers (task queue): whether this call
 * defers under the switch, and the next rollover moment. Null rollover when
 * nothing in the call reads it.
 */
interface DeferContext {
  /** Switch on AND a defer (`source` set). */
  defer: boolean
  source: BulkSnoozeSource | undefined
  timezone: string
  now: Date
  /**
   * The user's day boundary (`dayBoundaryForUser`): the occurrence cap asks
   * where a skip would land, and a from_completion rule counts from now's
   * OpenTask date.
   */
  dayStart: string
  /** The next rollover moment (`nextRollover`), when a defer or Try Tomorrow needs it. */
  rollover: Date | null
}

function deferContext(
  userId: number,
  timezone: string,
  source: BulkSnoozeSource | undefined,
  now: Date,
): DeferContext {
  const defer = taskQueueEnabled() && source !== undefined
  const dayStart = dayBoundaryForUser(userId)
  if (!defer && source !== 'try_tomorrow') {
    return { defer, source, timezone, now, dayStart, rollover: null }
  }
  // The rollover is the user's "Day starts at" (unset: 3:00 AM). Read here
  // rather than passed in,
  // so every caller gets the same answer.
  const rollover = nextRollover(now, timezone, rolloverTimeForUser(userId))
  return { defer, source, timezone, now, dayStart, rollover }
}

/** Where one task lands, and what the landing says about it. */
interface Landing {
  dueAt: string
  /** Marked for the queue (and Try Tomorrow's flag with it). */
  mark: boolean
  tryTomorrow: boolean
  /** Stopped at its next occurrence (B2). */
  cappedOccurrence: boolean
}

/**
 * PICKS AND DEFERS (task queue, 2026-10-19; spec "Picks and defers", B1, B2).
 *
 * `landing` is where the request sends the task (L: the absolute `until`, or
 * its own target plus the delta; Try Tomorrow: the next rollover). A pick, or
 * any call with the switch off, lands there. A DEFER (switch on):
 * - BELOW HIGH, NO DEADLINE, L AT OR AFTER THE NEXT ROLLOVER: the target goes
 *   to the rollover moment itself — not L (Trent's "tomorrow" is morning_time
 *   8:30, his rollover 6:30) — and the task is marked for the queue.
 *   Repeating tasks included (rule 5 / B3: the rollover handles them). A
 *   6:00 "+1h" lands at 6:30 and is marked (resolution 12).
 * - L BEFORE THE NEXT ROLLOVER: moves as always. (A marked task's target IS
 *   the rollover, so it is never over target and never swept before then.)
 * - DEADLINE TASKS: move as always, capped at the deadline. Never marked.
 * - REPEATING BELOW HIGH, NOT MARKED: a defer never carries it past its next
 *   occurrence (B2) — it lands on the occurrence instead, and is counted.
 *   Picks (multi-select included) are never capped: a manual move may pass it.
 * - TRY TOMORROW: the same as a sweep landing on the next rollover, plus the
 *   `try_tomorrow` flag. On a High/Urgent (never stripped) or deadline task,
 *   a plain move to the next rollover, with no mark and no flag.
 *
 * The tier is `bulkSnoozeTier` (a passed deadline counts as High).
 */
function planLanding(task: Task, landing: string, ctx: DeferContext): Landing {
  const plain = { dueAt: landing, mark: false, tryTomorrow: false, cappedOccurrence: false }
  if (!ctx.defer || !ctx.rollover) return plain
  const belowHigh = bulkSnoozeTier(task, ctx.now) < HIGH_PRIORITY_THRESHOLD
  if (belowHigh && !task.deadline_at && Date.parse(landing) >= ctx.rollover.getTime()) {
    return {
      dueAt: ctx.rollover.toISOString(),
      mark: true,
      tryTomorrow: ctx.source === 'try_tomorrow',
      cappedOccurrence: false,
    }
  }
  if (belowHigh && isRecurring(task.rrule)) {
    const next = nextOccurrenceOf(task, ctx.timezone, ctx.now, ctx.dayStart)
    if (next && Date.parse(landing) > Date.parse(next)) {
      return { ...plain, dueAt: next, cappedOccurrence: true }
    }
  }
  return plain
}

/**
 * The TARGET of a repeating task's next scheduled occurrence after now — the
 * one a skip would land on (`nextOccurrenceAfterSkip`): from its scheduled
 * occurrence, never its moved target (§6), and that occurrence's own target
 * (`occurrenceDates`; a deadline-anchored repeat's lies before its deadline —
 * whose cap, with the lead shorter than the gap, always binds first). Null
 * when the current occurrence is the series' last (repeat ends).
 */
function nextOccurrenceOf(
  task: Task,
  timezone: string,
  now: Date,
  dayStart: string,
): string | null {
  if (!task.rrule) return null
  // Repeat ends (2026-10-22): on the last occurrence there is no next one,
  // so there is no cap (`nextOccurrenceAfterSkip` → null).
  const next = nextOccurrenceAfterSkip(task, timezone, now, dayStart)
  return next ? occurrenceDates(task, next, timezone).targetAt : null
}

/**
 * The queue fields a defer's landing writes with its target (task queue). A
 * plain sweep's mark also clears a Try Tomorrow flag left from before. "The
 * original target is remembered" (spec rule 2): the defer that NEWLY marks
 * the task records its pre-sweep target in `queued_from_due_at`; a second
 * defer of a marked task keeps what the first one wrote, and so does Try
 * Tomorrow on a queued task with no target (the stripped one stays).
 */
function deferQueueFields(
  task: Task,
  landing: Landing,
): { queue_mark?: boolean; try_tomorrow?: boolean; queued_from_due_at?: string } {
  if (!landing.mark) return {}
  const fields = { queue_mark: true, try_tomorrow: landing.tryTomorrow }
  if (task.queue_mark || task.due_at === null) return fields
  return { ...fields, queued_from_due_at: task.due_at }
}

/** The request's landing time for one task (before `planLanding`). */
function requestedLanding(
  task: Task,
  until: string | undefined,
  deltaMinutes: number | undefined,
  ctx: DeferContext,
): string {
  if (ctx.source === 'try_tomorrow' && ctx.rollover) return ctx.rollover.toISOString()
  // Absolute mode: every task gets the same target. Relative mode: the delta
  // is added to each task's own due_at (dateless tasks were filtered out).
  return until !== undefined
    ? until
    : new Date(new Date(task.due_at!).getTime() + deltaMinutes! * 60_000).toISOString()
}

/** The empty result, with the counts a call made before it moved anything. */
function emptySnoozeResult(counts: Partial<BulkSnoozeResult> = {}): BulkSnoozeResult {
  const result: BulkSnoozeResult = {
    tasksAffected: 0,
    tasksSkipped: 0,
    urgentSkipped: 0,
    highSkipped: 0,
    highSnoozed: 0,
    reminderSkipped: 0,
    noDueDateSkipped: 0,
    deadlineSkipped: 0,
    deadlineCapped: 0,
    snoozedIds: [],
    queued: 0,
    queuedName: null,
    cappedOccurrence: 0,
    snoozedHighName: null,
    queuedUntil: null,
    summary: '',
    ...counts,
  }
  return { ...result, summary: snoozeSummary(result, '') }
}

/**
 * The standard summary line for a result (`bulkSnoozeMessage`). With the
 * switch off the queue fields are all zero / null and nothing is named, so
 * the line is the one the web toast and `message` always showed.
 */
function snoozeSummary(
  result: Omit<BulkSnoozeResult, 'summary'>,
  timezone: string,
  named: { single?: string | null; highByDeadline?: boolean } = {},
): string {
  const rollover = result.queuedUntil
  return bulkSnoozeMessage({
    affected: result.tasksAffected,
    highAffected: result.highSnoozed,
    high: result.highSkipped,
    urgent: result.urgentSkipped - result.highSkipped,
    deadline: result.deadlineSkipped,
    capped: result.deadlineCapped,
    queued: result.queued,
    queuedName: result.queuedName,
    queueAt: rollover ? formatTimeInTimezone(rollover, timezone) : undefined,
    singleName: named.single ?? null,
    highName: result.snoozedHighName,
    highByDeadline: named.highByDeadline,
    cappedOccurrence: result.cappedOccurrence,
  })
}

/**
 * The summary line with COUNTS ONLY — no task named (no `queued_name`, no
 * single task, no High) — for the sweep-feedback push: titles never go on the
 * lock screen (Trent; `sweep-feedback.ts`). Same builder as `summary`.
 */
export function bulkSnoozeCountSummary(result: BulkSnoozeResult, timezone: string): string {
  return snoozeSummary({ ...result, queuedName: null, snoozedHighName: null }, timezone)
}

/**
 * Which tasks a call will consider moving: the priority filter, then (in
 * relative mode) the dateless ones dropped. Try Tomorrow is one task the user
 * pointed at, so it passes the priority filter like an explicit pick
 * (`includeTaskIds`) — reminders and quotas are still refused.
 */
function selectSnoozeable(
  tasks: Task[],
  options: Pick<BulkSnoozeOptions, 'includeTaskIds' | 'deltaMinutes' | 'source'>,
): BulkSnoozeFilterResult & { snoozeable: Task[]; noDueDateSkipped: number } {
  const { includeTaskIds, deltaMinutes, source } = options
  const include = new Set(includeTaskIds ?? [])
  if (source === 'try_tomorrow') tasks.forEach((t) => include.add(t.id))
  // P0-P2 always; P3 (and a passed deadline) once nothing lower is left — all
  // of it, or for a defer with the task queue on, one per press; P4 never — unless
  // explicitly included. See `filterForBulkSnooze`.
  const filtered = filterForBulkSnooze(tasks, include.size ? include : undefined, new Date(), {
    // A defer only (the task queue's one High per press): a pick keeps the
    // whole-tier rule, as bulk/edit does.
    oneHigh: taskQueueEnabled() && source !== undefined,
  })
  // In relative mode, skip tasks without a due_at (can't add delta to nothing)
  let noDueDateSkipped = 0
  const snoozeable =
    deltaMinutes !== undefined && source !== 'try_tomorrow'
      ? filtered.eligible.filter((t) => {
          if (!t.due_at) {
            noDueDateSkipped++
            return false
          }
          return true
        })
      : filtered.eligible
  return { ...filtered, snoozeable, noDueDateSkipped }
}

/**
 * Bulk snooze
 *
 * Snoozes all specified tasks. Supports two modes:
 * - Absolute (until): Sets all tasks to the same target time
 * - Relative (deltaMinutes): Adds minutes to each task's current due_at
 *
 * Which tasks it will actually touch is `filterForBulkSnooze`'s decision —
 * P0-P2 always, P3 once nothing lower is left in the batch (one per press
 * with the task queue on), P4 never (unless named in `includeTaskIds`);
 * reminders and quotas are always skipped.
 *
 * What it writes to each of those is the single snooze's and bulk/edit's own
 * rule, through the same `collectFieldChanges` + `applyFieldChanges` pair: a
 * dated task's target moves (its first-target date kept, the snooze stat); a
 * dateless task (absolute mode only) gets its first date, which is not a
 * snooze; a task already due at the target is left alone and not counted.
 * Every move stops at a deadline still ahead (§8.2): `deadlineCapped` counts
 * those. A task whose deadline has passed is held to the High tier
 * (`filterForBulkSnooze`), counted in `deadlineSkipped` when held back.
 *
 * With the task queue on, a DEFER (`source`) is classed per task by where it
 * lands (`planLanding`): at or after the next rollover, below High and with
 * no deadline, it is marked for the queue.
 */
export function bulkSnooze(options: BulkSnoozeOptions): BulkSnoozeResult {
  const { userId, userTimezone, taskIds, until, deltaMinutes, dueBeforeIds, source } = options

  if (taskIds.length === 0) return emptySnoozeResult()

  validateSnoozeMode(until, deltaMinutes, source)
  if (source === 'try_tomorrow' && new Set(taskIds).size !== 1) {
    throw new ValidationError('Try Tomorrow takes exactly one task')
  }

  const nowStr = nowUtc()

  const tasks = validateBulkTasks(taskIds, userId, { excludeDone: true })
  const selected = selectSnoozeable(tasks, options)
  const { snoozeable, noDueDateSkipped, urgentSkipped, highSkipped, deadlineSkipped } = selected
  const counts = {
    tasksSkipped: tasks.length - snoozeable.length,
    urgentSkipped,
    highSkipped,
    reminderSkipped: selected.reminderSkipped,
    noDueDateSkipped,
    deadlineSkipped,
  }
  if (snoozeable.length === 0) return emptySnoozeResult(counts)

  const nowDate = new Date()
  const targetCtx = ownerContexts()
  const ctx = deferContext(userId, userTimezone, source, nowDate)
  let deadlineCapped = 0
  let cappedOccurrence = 0
  const queuedTasks: Task[] = []
  const snapshots: UndoSnapshot[] = []
  const activityEntries: ActivityEntry[] = []
  const batchId = crypto.randomUUID()
  const allFieldsChanged = new Set<string>()
  // The tasks that actually got a snapshot, in order. A no-op target (the task
  // is already due at `until`) drops out of every count below.
  const moved: Task[] = []
  // Each moved task's new target, for the badge arithmetic.
  const newTargets: string[] = []
  let snoozeScenarioCount = 0

  const result = withTransaction((tx) => {
    for (const task of snoozeable) {
      const landing = planLanding(task, requestedLanding(task, until, deltaMinutes, ctx), ctx)

      // THE SAME CHANGE COLLECTION AS bulk/edit AND THE SINGLE PATCH (D1,
      // 2026-09-29). This loop used to write due_at / original_due_at /
      // snooze_count by hand, and it drifted from `collectDueAtChanges`: it
      // bumped snooze_count and the snooze stat for a task that had NO date
      // (giving a task its first date is not a snooze) and for a task already
      // due at the target (nothing moved). Now each task is exactly a bulk edit
      // of `{ due_at }`. The reminder and quota filters above still run first,
      // so a sweep skips those rows instead of failing; the refusals inside
      // `collectFieldChanges` are only a safety net here. It also stops the
      // move at the deadline (§8.2). A defer's queue mark rides in the same
      // write, so its undo clears the mark with the target.
      const data = collectFieldChanges({
        task,
        input: {
          due_at: landing.dueAt,
          ...deferQueueFields(task, landing),
        },
        userId,
        userTimezone,
        now: nowDate,
        skipProjectValidation: true,
        targetCtx: targetCtx(task.user_id),
      })
      if (data.fieldsChanged.length === 0) continue
      if (wasCapped(data)) deadlineCapped++
      if (landing.cappedOccurrence) cappedOccurrence++
      if (landing.mark) queuedTasks.push(task)

      const { snapshot, activity } = applyFieldChanges(tx, task, data, nowStr)
      snapshots.push(snapshot)
      activityEntries.push({ userId, ...activity, source: 'bulk', batchId })
      data.fieldsChanged.forEach((f) => allFieldsChanged.add(f))
      moved.push(task)
      newTargets.push((data.afterState.due_at ?? task.due_at)!)
      if (data.isSnoozeScenario) snoozeScenarioCount++
    }

    if (snapshots.length > 0) {
      logAction(
        userId,
        'bulk_snooze',
        bulkSnoozeDescription(
          { count: snapshots.length, queued: queuedTasks.length },
          until,
          deltaMinutes,
          ctx,
          userTimezone,
          dayBoundaryForUser(userId),
        ),
        Array.from(allFieldsChanged),
        snapshots,
      )
    }
    logActivityBatch(activityEntries)

    // Only a real deferral counts as a snooze: not a first date, not a no-op.
    if (snoozeScenarioCount > 0) {
      incrementDailyStat(userId, 'snoozes', userTimezone, snoozeScenarioCount)
    }

    const oneHigh = moved.find((t) => t.id === selected.oneHighId)
    const done: Omit<BulkSnoozeResult, 'summary'> = {
      ...counts,
      // A no-op target is neither affected nor skipped, as in bulk/edit.
      tasksAffected: moved.length,
      highSnoozed: moved.filter((t) => t.priority === HIGH_PRIORITY_THRESHOLD).length,
      deadlineCapped,
      snoozedIds: moved.map((t) => t.id),
      queued: queuedTasks.length,
      queuedName: queuedTasks.length === 1 ? queuedTasks[0].title : null,
      cappedOccurrence,
      snoozedHighName: oneHigh?.title ?? null,
      queuedUntil: queuedTasks.length > 0 && ctx.rollover ? ctx.rollover.toISOString() : null,
    }
    // Spec rule 4: a press that moved exactly one task names it (switch on
    // only — off, the line stays exactly what it was).
    const single = taskQueueEnabled() && moved.length === 1 ? moved[0].title : null
    // The one High may be below High by priority, in the tier by a passed deadline.
    const highByDeadline = oneHigh !== undefined && oneHigh.priority < HIGH_PRIORITY_THRESHOLD
    const summary = snoozeSummary(done, userTimezone, { single, highByDeadline })
    return { ...done, summary }
  })

  if (moved.length === 0) return result

  cancelPendingEnrichment(moved)

  emitSyncEvent(userId)
  dismissNotificationsForTasks(
    userId,
    result.snoozedIds,
    stillDueAfterSnooze(dueBeforeIds, result.snoozedIds, newTargets),
  )

  for (const task of moved) {
    const fresh = getTaskById(task.id)
    if (fresh) {
      dispatchWebhookEvent(userId, 'task.snoozed', {
        task: formatTaskResponse(fresh, userTimezone),
        previous_due_at: task.due_at,
      })
    }
  }

  return result
}

/**
 * The task queue's additive response fields, the same on `/bulk/snooze` and
 * `/bulk/snooze-overdue` (docs/openapi.yaml). Present with the switch off too,
 * as zero / null, with `summary` the line the toast always showed.
 */
export function taskQueueFields(result: BulkSnoozeResult) {
  return {
    queued: result.queued,
    queued_name: result.queuedName,
    capped_occurrence: result.cappedOccurrence,
    snoozed_high_name: result.snoozedHighName,
    queued_until: result.queuedUntil,
    summary: result.summary,
  }
}

/**
 * The undo entry's (and History's) description, worded for what happened:
 * "Deferred 3 tasks to tomorrow 9:00 AM", "Deferred 3 tasks (+1h)"; with the
 * task queue, "Sent 3 tasks to the queue at 6:30 AM" when every task was
 * marked, "Deferred 5 tasks (3 to the queue at 6:30 AM)" when some were.
 */
function bulkSnoozeDescription(
  { count, queued }: { count: number; queued: number },
  until: string | undefined,
  deltaMinutes: number | undefined,
  ctx: DeferContext,
  userTimezone: string,
  /** The user's day boundary: "tomorrow 9:00 AM" by OpenTask day. */
  dayStart: string,
): string {
  if (queued > 0 && ctx.rollover) {
    const at = formatTimeInTimezone(ctx.rollover.toISOString(), userTimezone)
    return queued === count
      ? `Sent ${count} ${taskWord(count)} to the queue at ${at}`
      : `Deferred ${count} tasks (${queued} to the queue at ${at})`
  }
  if (ctx.source === 'try_tomorrow' && ctx.rollover) {
    const at = formatSnoozeTarget(ctx.rollover.toISOString(), userTimezone, dayStart)
    return `Deferred ${count} tasks to ${at}`
  }
  if (until !== undefined) {
    return `Deferred ${count} tasks to ${formatSnoozeTarget(until, userTimezone, dayStart)}`
  }
  return `Deferred ${count} tasks (${formatDurationDelta(0, deltaMinutes! * 60 * 1000)})`
}

/**
 * Cancel pending AI enrichment on tasks the user just snoozed: their manual
 * change takes precedence, exactly as the single snooze does through
 * `updateTask`. After the commit and outside the undo snapshot for the same
 * reason as there — it is machine state, not a user-visible edit — so an undo
 * of the snooze leaves enrichment cancelled.
 *
 * `tasks` are the pre-snooze rows; the snooze wrote no `labels`, and
 * `bulkSnooze` is synchronous from its read to here (nothing interleaves), so
 * their label lists are still current.
 */
export function cancelPendingEnrichment(tasks: Task[]): void {
  const pending = tasks.filter((t) => t.labels.includes('ai-to-process'))
  if (pending.length === 0) return
  const stmt = getDb().prepare('UPDATE tasks SET labels = ? WHERE id = ?')
  for (const task of pending) {
    stmt.run(JSON.stringify(task.labels.filter((l) => l !== 'ai-to-process')), task.id)
  }
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
 * follows from arithmetic: everything snoozed went to a time in the future,
 * so what stays due is precisely what was due and did not move.
 *
 * PER-TASK TARGETS (task queue, 2026-10-19): one press can now land its tasks
 * on different targets (the queued ones on the rollover, a repeating one on
 * its next occurrence, a capped one on its deadline), so each moved task's
 * ACTUAL new target is checked (`newTargets`, in `snoozedIds` order).
 *
 * That only holds while every new target is genuinely in the future.
 * bulkSnooze deliberately permits a past target ("tasks will just appear
 * overdue immediately"), so if any landed at or before now this returns
 * undefined and the badge is measured — rather than report one too low.
 */
function stillDueAfterSnooze(
  dueBeforeIds: number[] | undefined,
  snoozedIds: number[],
  newTargets: string[],
): number | undefined {
  if (!dueBeforeIds) return undefined
  const now = Date.now()
  if (newTargets.some((t) => Date.parse(t) <= now)) return undefined
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
  /**
   * The undo entry's action and description, when the edit is a gesture of
   * its own (On deck, 2026-10-20: `deck`). Default: `bulk_edit`, described
   * by the fields changed.
   */
  undo?: { action: UndoAction; description: (affected: number) => string }
}

export interface BulkEditResult {
  tasksAffected: number
  tasksSkipped: number
  /** Tasks a relative (`deltaMinutes`) move could not shift — they have no date. */
  noDueDateSkipped: number
  /**
   * Tasks whose date was withheld because a passed deadline holds them to the
   * High tier while something lower is in the batch (Trent's ruling,
   * 2026-10-12). Their other fields still applied.
   */
  deadlineSkipped: number
  /** Tasks whose date stopped at their deadline (§8.2). */
  deadlineCapped: number
}

interface BulkEditDatePlan {
  /** Tasks the date part must NOT be applied to (every other field still is). */
  withheld: Set<number>
  /** Withheld by a rule (quota, sweep filter, no date to shift) — reported as skipped. */
  skipped: number
  noDueDateSkipped: number
  /** Of `skipped`: held to the High tier by a passed deadline. */
  deadlineSkipped: number
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
 *
 * The deadline is not planned here: `collectFieldChanges` stops every move at
 * the task's deadline (§8.2), and the loop counts what it did.
 */
function planBulkEditDates(
  tasks: Task[],
  changes: BulkEditChanges,
  opts: Pick<BulkEditOptions, 'includeTaskIds' | 'deltaMinutes' | 'dateTaskIds'>,
): BulkEditDatePlan {
  const { includeTaskIds, deltaMinutes, dateTaskIds } = opts
  const plan: BulkEditDatePlan = {
    withheld: new Set(),
    skipped: 0,
    noDueDateSkipped: 0,
    deadlineSkipped: 0,
  }
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
    const filtered = filterForBulkSnooze(candidates, includeSet)
    const eligible = new Set(filtered.eligible.map((t) => t.id))
    withhold((t) => eligible.has(t.id))
    plan.deadlineSkipped = filtered.deadlineSkipped
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
 * After a bulk edit commits: only a task whose date actually moved has a
 * stale notification — or a reminder whose named push the edit ended
 * (priority below Medium, converted, moved to Anytime or off today:
 * `namedPushStands`). Any other priority or label edit leaves the banner as
 * true as it was. A quota's named prompt pushes the edit ended go by prompt
 * key (`promptPushEndCheckForEdit`), never by the quota's id.
 */
function dismissAfterBulkEdit(
  userId: number,
  perTaskFields: Map<number, string[]>,
  endedNamedPush: Map<number, () => boolean>,
  endedPromptPushes: (() => string[])[],
): void {
  const pushEnded = (id: number) => endedNamedPush.get(id)?.() === true
  dismissNotificationsForTasks(
    userId,
    [...perTaskFields]
      .filter(([id, fields]) => fields.includes('due_at') || pushEnded(id))
      .map(([id]) => id),
  )
  dismissEndedPromptPushes(userId, () => endedPromptPushes.flatMap((check) => check()))
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
    return {
      tasksAffected: 0,
      tasksSkipped: 0,
      noDueDateSkipped: 0,
      deadlineSkipped: 0,
      deadlineCapped: 0,
    }
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
    return {
      tasksAffected: 0,
      tasksSkipped,
      noDueDateSkipped: dates.noDueDateSkipped,
      deadlineSkipped: dates.deadlineSkipped,
      deadlineCapped: 0,
    }
  }

  const nowStr = nowUtc()
  const nowDate = new Date()
  // Each task's OWNER's clock (zone, morning) and periods — a shared project
  // mixes owners — read once per owner, not once per task (relative targets,
  // 2026-10-24: a sent `target_slot_id` is checked against the owner's).
  const targetCtx = ownerContexts()
  const slotCache = new Map<number, ReturnType<SlotsFor>>()
  const slotsFor: SlotsFor = (ownerId) => {
    if (!slotCache.has(ownerId)) slotCache.set(ownerId, ownerSlots(ownerId))
    return slotCache.get(ownerId)!
  }
  let deadlineCapped = 0
  const snapshots: UndoSnapshot[] = []
  const activityEntries: ActivityEntry[] = []
  const batchId = crypto.randomUUID()
  const allFieldsChanged = new Set<string>()
  const perTaskFields = new Map<number, string[]>()
  /** Per edited task: did the edit end its reminder's named push (`namedPushEndCheck`)? */
  const endedNamedPush = new Map<number, () => boolean>()
  /** Per edited quota: the prompt keys whose named push the edit ended (`promptPushEndCheckForEdit`). */
  const endedPromptPushes: (() => string[])[] = []
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

    for (const listed of tasks) {
      // A rule sent to a quota may re-anchor it: close an expired period
      // first (`settleQuotaPeriod`), inside this transaction.
      const task = settleQuotaPeriod(listed, inputFor(listed))
      // Collect field changes using shared helper
      const data = collectFieldChanges({
        task,
        input: inputFor(listed),
        userId,
        userTimezone,
        now: nowDate,
        skipProjectValidation: true, // Already validated above
        targetCtx: targetCtx(task.user_id),
        slotsFor,
      })
      // §8.2: a date stopped at a deadline still ahead.
      if (wasCapped(data)) deadlineCapped++

      if (data.fieldsChanged.length > 0) {
        // Read before this task's own change is applied.
        endedNamedPush.set(task.id, namedPushEndCheck(task, data.fieldsChanged))
        endedPromptPushes.push(promptPushEndCheckForEdit(task, data.fieldsChanged))
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
        options.undo?.action ?? 'bulk_edit',
        options.undo
          ? options.undo.description(snapshots.length)
          : formatBulkEditDescription(snapshots.length, Array.from(allFieldsChanged)),
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
      deadlineSkipped: dates.deadlineSkipped,
      deadlineCapped,
    }
  })

  emitSyncEvent(userId)
  dismissAfterBulkEdit(userId, perTaskFields, endedNamedPush, endedPromptPushes)

  for (const snapshot of snapshots) {
    const fresh = getTaskById(snapshot.task_id)
    if (fresh) {
      dispatchWebhookEvent(userId, 'task.updated', {
        task: formatTaskResponse(fresh, userTimezone),
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
