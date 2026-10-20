/**
 * SKIP UNTIL (task queue PR 4; spec rule 10, resolution 7)
 *
 * "Skip until [date], in details and in multi-select, for repeating tasks. A
 * tap with the default skips this occurrence; a date skips every occurrence
 * before it (the vacation case)." Many tasks at once, because it is mostly
 * driven through AI (`POST /api/tasks/bulk/skip-until`). There is deliberately
 * no away mode: this is the whole of it.
 *
 * WHAT IT DOES, per task:
 * - no date: exactly `skipOccurrence` — the next occurrence after the
 *   scheduled one (or after now, when it has passed), one skip.
 * - a date (`yyyy-MM-dd`, the user's local day): the task lands on its first
 *   occurrence on or after that day's start. `occurrence_at` and the target go
 *   there; every occurrence passed over is a skip (`skip_count` += them).
 *   Counted the way one skip at a time would count them: the current
 *   occurrence (however long it has been over target, it is one), then each
 *   later one before the date.
 * - a date and the current occurrence is ALREADY on or after it: nothing is
 *   before the date, so nothing is skipped — the task is left as it is and
 *   counted as `already_clear` ("a date skips every occurrence before it").
 * - a from_completion rule (resolution 7): it has no schedule to walk, so it
 *   lands on the date at the rule's time of day, and the interval restarts
 *   from there (the next one is counted from when that one is done). Its
 *   skips are counted by stepping the interval from the current occurrence,
 *   as if each had been done on time (stepped like the rollover, but each
 *   step counts; the rollover adds one skip whatever it steps over).
 *
 * Only repeating tasks. A one-off, a reminder, a quota, or a trashed /
 * archived task in the batch is left alone and COUNTED, never a refusal of the
 * batch, so an AI can send a mixed list. An id that does not exist or is not
 * the user's refuses the batch (400), as on every bulk route.
 *
 * Each skipped task gets the skip write (`writeRecurringSkip`: the deadline
 * moves with the occurrence and caps the target, attempts afresh, the queue
 * state cleared — it is a target write). One undo entry (`bulk_skip`) for the
 * batch, one activity row (`skip`) per task; after the commit the delivered
 * notifications go, open tabs and widgets refresh, and each task dispatches
 * `task.skipped`. A batch where nothing is skipped writes nothing (no undo
 * entry: the clients offer Undo only when something was skipped).
 */

import { DateTime } from 'luxon'
import { getDb, withTransaction } from '@/core/db'
import { logAction, createTaskSnapshot } from '@/core/undo'
import { logActivityBatch, type ActivityEntry } from '@/core/activity'
import { nowUtc, isRecurring, computeNextOccurrence, parseRRule } from '@/core/recurrence'
import { ValidationError } from '@/core/errors'
import { dispatchWebhookEvent } from '@/core/webhooks/dispatch'
import { dismissNotificationsForTasks } from '@/core/notifications/dismiss'
import { formatTaskResponse } from '@/lib/format-task'
import { emitSyncEvent } from '@/lib/sync-events'
import { isTracked } from '@/lib/track'
import { taskWord } from '@/lib/utils'
import type { Task, UndoSnapshot } from '@/types'
import { canUserAccessTask } from './access'
import { getTaskById } from './read'
import { nextOccurrenceAfterSkip, writeRecurringSkip } from './skip'

/**
 * The walk's guard. A daily rule skipped to the furthest date allowed
 * (`MAX_UNTIL_YEARS`) is ~3,650 steps, so the guard is never the limit for a
 * real rule; it only stops a bug from spinning.
 */
const MAX_SKIP_WALK = 5000

/** How far ahead a date may be. Far is legal (the vacation case, a season off). */
export const MAX_UNTIL_YEARS = 10

export type SkipUntilLeaveReason =
  | 'not_repeating'
  | 'reminder'
  | 'quota'
  | 'inactive'
  | 'already_clear'

export type SkipUntilPlan =
  | { kind: 'skip'; landing: string; skipped: number }
  | { kind: 'leave'; reason: SkipUntilLeaveReason }

type PlanTask = Pick<
  Task,
  | 'rrule'
  | 'recurrence_mode'
  | 'anchor_time'
  | 'occurrence_at'
  | 'due_at'
  | 'is_reminder'
  | 'is_tracked'
  | 'progress_target'
  | 'done'
  | 'deleted_at'
  | 'archived_at'
>

/** Why a task in the batch is not one skip-until moves, or null when it is. */
function leaveReason(task: PlanTask): SkipUntilLeaveReason | null {
  if (task.deleted_at || task.archived_at || task.done) return 'inactive'
  if (task.is_reminder) return 'reminder'
  if (isTracked(task)) return 'quota'
  if (!isRecurring(task.rrule)) return 'not_repeating'
  return null
}

/**
 * The rule's time of day ("HH:MM"): the task's `anchor_time`, else the rule's
 * BYHOUR, else its current occurrence's local time, else the Morning time.
 * Every rule has a time since 2026-10-12, so the later ones cover old rows.
 */
function ruleTime(task: PlanTask, timezone: string, morningTime: string): string {
  if (task.anchor_time) return task.anchor_time
  const { byhour, byminute } = parseRRule(task.rrule!)
  const pad = (n: number) => String(n).padStart(2, '0')
  if (byhour !== undefined) return `${pad(byhour)}:${pad(byminute ?? 0)}`
  const current = task.occurrence_at ?? task.due_at
  if (current) return DateTime.fromISO(current, { zone: 'utc' }).setZone(timezone).toFormat('HH:mm')
  return morningTime
}

/**
 * Count the occurrences a skip to `untilStart` passes over and find where a
 * from_due rule lands: one step at a time, each the next occurrence after the
 * last (the first after now, when the current one has passed — it is one
 * occurrence however long it has waited). A from_completion rule steps its
 * interval the same way, as if each had been done on time.
 */
function walk(
  task: PlanTask,
  timezone: string,
  untilStart: number,
  now: Date,
): { landing: string; skipped: number } {
  const fromCompletion = task.recurrence_mode === 'from_completion'
  const current = task.occurrence_at ?? task.due_at
  let at = current ? new Date(current) : null
  for (let skipped = 1; skipped <= MAX_SKIP_WALK; skipped++) {
    const next = fromCompletion
      ? computeNextOccurrence({
          rrule: task.rrule!,
          recurrenceMode: 'from_completion',
          anchorTime: task.anchor_time,
          timezone,
          completedAt: at && at > now ? at : now,
        })
      : new Date(
          nextOccurrenceAfterSkip(
            { ...task, occurrence_at: at?.toISOString() ?? null },
            timezone,
            now,
          ),
        )
    if (next.getTime() >= untilStart) return { landing: next.toISOString(), skipped }
    at = next
  }
  throw new Error(`Skip until: the rule never reached the date within ${MAX_SKIP_WALK} steps`)
}

/**
 * What skip-until does to one task (pure: no writes). `until` null is "skip
 * this occurrence"; otherwise a `yyyy-MM-dd` day in `timezone`, already
 * checked by `parseUntil`.
 */
export function planSkipUntil(
  task: PlanTask,
  timezone: string,
  until: string | null,
  morningTime: string,
  now: Date = new Date(),
): SkipUntilPlan {
  const reason = leaveReason(task)
  if (reason) return { kind: 'leave', reason }
  if (until === null) {
    return { kind: 'skip', landing: nextOccurrenceAfterSkip(task, timezone, now), skipped: 1 }
  }
  const untilDay = DateTime.fromISO(until, { zone: timezone }).startOf('day')
  const untilStart = untilDay.toMillis()
  const current = task.occurrence_at ?? task.due_at
  if (current && Date.parse(current) >= untilStart)
    return { kind: 'leave', reason: 'already_clear' }

  const { landing, skipped } = walk(task, timezone, untilStart, now)
  if (task.recurrence_mode !== 'from_completion') return { kind: 'skip', landing, skipped }
  // Resolution 7: the date itself, at the rule's time; the interval restarts there.
  const [hour, minute] = ruleTime(task, timezone, morningTime).split(':').map(Number)
  const onTheDay = untilDay.set({ hour, minute, second: 0, millisecond: 0 }).toUTC().toISO()!
  return { kind: 'skip', landing: onTheDay, skipped }
}

/**
 * The `until` day, checked: a real `yyyy-MM-dd` date, not before today in the
 * user's timezone (today is allowed — "skip until today" skips an over-target
 * occurrence onto today's), and at most `MAX_UNTIL_YEARS` ahead.
 */
export function parseUntil(
  until: string | null | undefined,
  timezone: string,
  now: Date,
): string | null {
  if (until === undefined || until === null) return null
  const invalid = new ValidationError('until must be a date (yyyy-MM-dd)')
  let day: DateTime
  try {
    // Luxon may be set to throw on an invalid date (Feb 30) rather than flag it.
    day = DateTime.fromFormat(until, 'yyyy-MM-dd', { zone: timezone })
  } catch {
    throw invalid
  }
  if (!day.isValid) throw invalid
  const today = DateTime.fromJSDate(now).setZone(timezone).startOf('day')
  if (day < today) throw new ValidationError('until is in the past')
  if (day > today.plus({ years: MAX_UNTIL_YEARS })) {
    throw new ValidationError(`until is more than ${MAX_UNTIL_YEARS} years ahead`)
  }
  return until
}

export interface SkipUntilOptions {
  userId: number
  userTimezone: string
  taskIds: number[]
  /** `yyyy-MM-dd` in the user's timezone; omitted/null = skip this occurrence. */
  until?: string | null
}

export interface SkipUntilResult {
  /** The tasks skipped (after the write). */
  tasks: Task[]
  tasksAffected: number
  /** Occurrences passed over, summed across the tasks. */
  occurrencesSkipped: number
  /** Left alone, by why. */
  skippedNotRepeating: number
  skippedReminders: number
  skippedQuotas: number
  /** Trashed, archived or done. */
  skippedInactive: number
  /** Already on or after the date: nothing before it to skip. */
  alreadyClear: number
  /** The toast: what was skipped and what was not. */
  summary: string
}

/** Load the batch: every id must exist and be the user's (else 400, as on every bulk route). */
function loadBatch(userId: number, taskIds: number[]): Task[] {
  const tasks: Task[] = []
  const failed: number[] = []
  for (const id of [...new Set(taskIds)]) {
    const task = getTaskById(id)
    if (!task || !canUserAccessTask(userId, task)) failed.push(id)
    else tasks.push(task)
  }
  if (failed.length > 0) throw new ValidationError(`Invalid task IDs: ${failed.join(', ')}`)
  return tasks
}

function morningTimeOf(userId: number): string {
  const row = getDb().prepare('SELECT morning_time FROM users WHERE id = ?').get(userId) as
    | { morning_time: string | null }
    | undefined
  return row?.morning_time ?? '09:00'
}

/** "Mon, Nov 2" in the user's timezone. */
function dayLabel(iso: string, timezone: string): string {
  return DateTime.fromISO(iso, { zone: 'utc' }).setZone(timezone).toFormat('ccc, LLL d')
}

/** A `yyyy-MM-dd` day as "Mon, Nov 2" (a calendar day: no timezone to apply). */
function untilLabel(until: string): string {
  return DateTime.fromFormat(until, 'yyyy-MM-dd', { zone: 'utc' }).toFormat('ccc, LLL d')
}

/**
 * The toast and the undo entry's words. One task names it and where it lands;
 * several give the count. The tasks left alone follow, by why.
 */
export function skipUntilSummary(
  r: Omit<SkipUntilResult, 'summary'>,
  until: string | null,
  timezone: string,
): string {
  const parts: string[] = []
  const occ = (n: number) => `${n} ${n === 1 ? 'occurrence' : 'occurrences'}`
  if (r.tasksAffected === 1) {
    const t = r.tasks[0]
    const lead = r.occurrencesSkipped > 1 ? `Skipped ${occ(r.occurrencesSkipped)} of` : 'Skipped'
    parts.push(`${lead} "${t.title}" · next ${dayLabel(t.occurrence_at ?? t.due_at!, timezone)}`)
  } else if (r.tasksAffected > 1) {
    const to = until ? ` until ${untilLabel(until)}` : ''
    const n = r.occurrencesSkipped > r.tasksAffected ? ` (${occ(r.occurrencesSkipped)})` : ''
    parts.push(`Skipped ${r.tasksAffected} ${taskWord(r.tasksAffected)}${to}${n}`)
  } else {
    parts.push('Nothing skipped')
  }
  if (r.skippedNotRepeating > 0) parts.push(`${r.skippedNotRepeating} not repeating`)
  if (r.alreadyClear > 0) {
    const on = until ? untilLabel(until) : 'that day'
    parts.push(`${r.alreadyClear} already on or after ${on}`)
  }
  if (r.skippedReminders > 0) {
    parts.push(`${r.skippedReminders} ${r.skippedReminders === 1 ? 'reminder' : 'reminders'}`)
  }
  if (r.skippedQuotas > 0) {
    parts.push(`${r.skippedQuotas} ${r.skippedQuotas === 1 ? 'quota' : 'quotas'}`)
  }
  if (r.skippedInactive > 0) parts.push(`${r.skippedInactive} done or in the trash`)
  return parts.join(' · ')
}

const LEAVE_COUNTER: Record<SkipUntilLeaveReason, keyof LeaveCounts> = {
  not_repeating: 'skippedNotRepeating',
  reminder: 'skippedReminders',
  quota: 'skippedQuotas',
  inactive: 'skippedInactive',
  already_clear: 'alreadyClear',
}

type LeaveCounts = Pick<
  SkipUntilResult,
  'skippedNotRepeating' | 'skippedReminders' | 'skippedQuotas' | 'skippedInactive' | 'alreadyClear'
>

/** Skip every repeating task in the batch to `until` (or past this occurrence). */
export function skipUntil(options: SkipUntilOptions): SkipUntilResult {
  const { userId, userTimezone } = options
  const now = new Date()
  const until = parseUntil(options.until, userTimezone, now)
  const batch = loadBatch(userId, options.taskIds)
  const morningTime = morningTimeOf(userId)

  const counts: LeaveCounts = {
    skippedNotRepeating: 0,
    skippedReminders: 0,
    skippedQuotas: 0,
    skippedInactive: 0,
    alreadyClear: 0,
  }
  const planned: { task: Task; landing: string; skipped: number }[] = []
  for (const task of batch) {
    const plan = planSkipUntil(task, userTimezone, until, morningTime, now)
    if (plan.kind === 'skip') planned.push({ task, landing: plan.landing, skipped: plan.skipped })
    else counts[LEAVE_COUNTER[plan.reason]] += 1
  }

  const occurrencesSkipped = planned.reduce((sum, p) => sum + p.skipped, 0)
  const tasks = planned.length > 0 ? writeSkips(userId, userTimezone, until, planned) : []
  const result = { tasks, tasksAffected: tasks.length, occurrencesSkipped, ...counts }
  const summary = skipUntilSummary(result, until, userTimezone)
  if (tasks.length === 0) return { ...result, summary }

  emitSyncEvent(userId)
  // The occurrences are gone, so their notifications should be too.
  dismissNotificationsForTasks(
    userId,
    tasks.map((t) => t.id),
  )
  // §7.5: a skip is NOT a completion.
  for (const task of tasks) {
    dispatchWebhookEvent(userId, 'task.skipped', { task: formatTaskResponse(task, userTimezone) })
  }
  return { ...result, summary }
}

/** One transaction: each task's skip write, one `bulk_skip` undo entry, an activity row each. */
function writeSkips(
  userId: number,
  timezone: string,
  until: string | null,
  planned: { task: Task; landing: string; skipped: number }[],
): Task[] {
  const nowStr = nowUtc()
  const batchId = crypto.randomUUID()
  return withTransaction((tx) => {
    const snapshots: UndoSnapshot[] = []
    const activity: ActivityEntry[] = []
    const afters: Task[] = []
    let fields: string[] = []
    for (const { task, landing, skipped } of planned) {
      const { after, fieldsChanged } = writeRecurringSkip(tx, {
        task,
        nextOccurrenceAt: landing,
        skipsAdded: skipped,
        nowStr,
        timezone,
      })
      snapshots.push(createTaskSnapshot(task, after, fieldsChanged))
      fields = [...new Set([...fields, ...fieldsChanged])]
      activity.push({
        userId,
        taskId: task.id,
        action: 'skip',
        source: planned.length > 1 ? 'bulk' : 'single',
        batchId,
        fields: fieldsChanged,
        before: { id: task.id, due_at: task.due_at, skip_count: task.skip_count },
        after: { id: task.id, due_at: after.due_at, skip_count: after.skip_count },
        metadata: { recurring: true, until, occurrences_skipped: skipped },
      })
      afters.push(after)
    }
    const to = until ? ` until ${untilLabel(until)}` : ''
    const description =
      planned.length === 1
        ? `Skipped "${planned[0].task.title}"${to}`
        : `Skipped ${planned.length} tasks${to}`
    logAction(userId, 'bulk_skip', description, fields, snapshots)
    logActivityBatch(activity)
    return afters
  })
}
