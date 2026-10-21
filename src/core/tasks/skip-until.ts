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
 * - a date (`yyyy-MM-dd`, the user's local day, TOMORROW or later): the
 *   task lands on its first occurrence on or after that day's start.
 *   `occurrence_at` and the target go there; every occurrence passed over is
 *   a skip (`skip_count` += them). Counted the way one skip at a time would
 *   count them: the current occurrence (however long it has been over
 *   target, it is one), then each later one before the date.
 * - THE INTENT IS THAT NOTHING NAGS BEFORE THE DATE. A task whose occurrence
 *   is already on or after the date has nothing to skip — but if its target
 *   was pulled before the date, the target goes back to the occurrence (a
 *   target write, no skip; counted as affected and in `targetsMoved`). Only a
 *   task whose target AND occurrence are both on or after the date is left as
 *   it is (`already_clear`).
 * - ON DECK (2026-10-20, ruling E): skip-until takes a task off deck, in the
 *   same write and undo snapshot. A decked repeating task has no target
 *   (`due_at` NULL, its occurrence kept), so every rule here reads the
 *   occurrence (`occurrence_at`), never the null target, and the write
 *   leaves a target on the landing occurrence — never a repeating task with
 *   neither a target nor a deck. So a decked task whose occurrence is
 *   already on or after the date is not `already_clear`: like an early
 *   target, it is retargeted to its occurrence, the deck cleared. Undo puts
 *   the deck back.
 * - a from_completion rule (resolution 7): it has no schedule to walk, so it
 *   lands on the date at the rule's time of day, and the interval restarts
 *   from there — never earlier than the plain (no-date) skip would land.
 *   See `walkFromCompletion`.
 *
 * Only repeating tasks. A one-off, a reminder, a quota, or a trashed /
 * archived task in the batch is left alone and COUNTED, never a refusal of the
 * batch, so an AI can send a mixed list. An id that does not exist or is not
 * the user's refuses the batch (400), as on every bulk route.
 *
 * Each skipped task gets the skip write (`writeRecurringSkip`: the deadline
 * moves with the occurrence and caps the target, attempts afresh, the queue
 * state cleared — it is a target write). One undo entry (`bulk_skip`) for the
 * batch, one activity row (`skip`, or `edit` for a retarget) per task; after
 * the commit the delivered notifications go, open tabs and widgets refresh,
 * and each task dispatches `task.skipped` (`task.updated` for a retarget). A batch where nothing is skipped writes nothing (no undo
 * entry: the clients offer Undo only when something was skipped).
 */

import { DateTime } from 'luxon'
import type Database from 'better-sqlite3'
import { withTransaction } from '@/core/db'
import { logAction, createTaskSnapshot } from '@/core/undo'
import { logActivityBatch, type ActivityEntry } from '@/core/activity'
import {
  nowUtc,
  isRecurring,
  computeNextOccurrence,
  occurrencesFromDue,
  ruleTimeOf,
} from '@/core/recurrence'
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
import { stampTargetSet, type CollectedWrite } from './target-set'
import { collectDeckClear } from './deck-clear'
import { capAtDeadline } from '@/lib/task-segments'

/**
 * The guard on how many occurrences one task may pass over. A daily rule
 * skipped to the furthest date allowed (`MAX_UNTIL_YEARS`) passes ~3,650, so
 * no real rule reaches it; past it the request is refused (400), never spun.
 */
const MAX_SKIPPED = 5000

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
  /** Nothing to skip, but the target was pulled before the date: it goes back to the occurrence. */
  | { kind: 'retarget'; landing: string }
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
  | 'on_deck_day'
>

/** Why a task in the batch is not one skip-until moves, or null when it is. */
function leaveReason(task: PlanTask): SkipUntilLeaveReason | null {
  if (task.deleted_at || task.archived_at || task.done) return 'inactive'
  if (task.is_reminder) return 'reminder'
  if (isTracked(task)) return 'quota'
  if (!isRecurring(task.rrule)) return 'not_repeating'
  return null
}

function tooManySkips(): ValidationError {
  return new ValidationError(
    `Skip until: a task would pass more than ${MAX_SKIPPED} occurrences before that date — pick a nearer one`,
  )
}

/**
 * A from_due rule: the plain skip's landing first (the next occurrence after
 * the scheduled one, or after now when it has passed — the current one is
 * one skip however long it has waited), then every occurrence from there up
 * to the date counted, and the first on or after it found, in two rrule.js
 * calls (`occurrencesFromDue`), never a step per occurrence.
 */
function walkFromDue(
  task: PlanTask,
  timezone: string,
  untilStart: Date,
  now: Date,
): { landing: string; skipped: number } {
  const first = new Date(nextOccurrenceAfterSkip(task, timezone, now))
  if (first >= untilStart) return { landing: first.toISOString(), skipped: 1 }
  const { count, firstOnOrAfter } = occurrencesFromDue({
    rrule: task.rrule!,
    anchorTime: task.anchor_time,
    timezone,
    from: first,
    before: untilStart,
    anchorAt: first,
  })
  const skipped = 1 + count
  if (skipped > MAX_SKIPPED) throw tooManySkips()
  return { landing: firstOnOrAfter.toISOString(), skipped }
}

/**
 * A from_completion rule (resolution 7) has no schedule to walk, so it lands
 * on the date itself at the rule's time (`ruleTimeOf`, the fallback the next
 * Done uses too) and the interval restarts from there — but NEVER earlier
 * than the plain skip would land: the floor is exactly the no-date skip's
 * landing (`nextOccurrenceAfterSkip`, the path `skipOccurrence` uses — for
 * from_completion, one interval on from now). Every 2 weeks, now Mar 4,
 * until Mar 12: the plain skip lands Mar 18, after Mar 12, so Mar 18. Its
 * skips are counted by stepping the
 * interval from the current occurrence to the date, as if each had been done
 * on time (stepped like the rollover, but each step counts; the rollover adds
 * one skip whatever it steps over).
 */
function walkFromCompletion(
  task: PlanTask,
  timezone: string,
  untilDay: DateTime,
  now: Date,
): { landing: string; skipped: number } {
  const step = (from: Date) =>
    computeNextOccurrence({
      rrule: task.rrule!,
      recurrenceMode: 'from_completion',
      anchorTime: task.anchor_time,
      timezone,
      completedAt: from,
    })
  // The floor: exactly where "skip this occurrence" lands.
  const plain = new Date(nextOccurrenceAfterSkip(task, timezone, now))
  // The count: interval steps from the current occurrence (from now, when it has passed).
  const current = task.occurrence_at ?? task.due_at
  const untilStart = untilDay.toMillis()
  let at = step(current && Date.parse(current) > now.getTime() ? new Date(current) : now)
  let skipped = 1
  while (at.getTime() < untilStart) {
    if (++skipped > MAX_SKIPPED) throw tooManySkips()
    at = step(at)
  }
  const { hour, minute } = ruleTimeOf(task.rrule!, task.anchor_time)
  const onTheDay = untilDay.set({ hour, minute, second: 0, millisecond: 0 }).toJSDate()
  const landing = onTheDay > plain ? onTheDay : plain
  return { landing: landing.toISOString(), skipped }
}

/**
 * What skip-until does to one task (pure: no writes). `until` null is "skip
 * this occurrence"; otherwise a `yyyy-MM-dd` day in `timezone`, already
 * checked by `parseUntil`.
 *
 * THE INTENT: nothing nags before the date. So a task whose occurrence is
 * already on or after it, but whose target was pulled earlier, is not clear:
 * its target goes back to the occurrence (a target write, no skip). Only a
 * task whose target AND occurrence are both on or after the date is left
 * alone (`already_clear`).
 */
export function planSkipUntil(
  task: PlanTask,
  timezone: string,
  until: string | null,
  now: Date = new Date(),
): SkipUntilPlan {
  const reason = leaveReason(task)
  if (reason) return { kind: 'leave', reason }
  if (until === null) {
    return { kind: 'skip', landing: nextOccurrenceAfterSkip(task, timezone, now), skipped: 1 }
  }
  const untilDay = DateTime.fromISO(until, { zone: timezone }).startOf('day')
  const untilStart = untilDay.toJSDate()
  // A decked repeating task has `due_at` NULL: its occurrence is the truth.
  const occurrence = task.occurrence_at ?? task.due_at
  if (occurrence && Date.parse(occurrence) >= untilStart.getTime()) {
    const targetEarly = task.due_at !== null && Date.parse(task.due_at) < untilStart.getTime()
    // Ruling E: skip-until always takes a task off deck, so a decked task is never
    // left alone — its target goes back on the occurrence and the deck is cleared.
    if (targetEarly || task.on_deck_day) {
      return { kind: 'retarget', landing: occurrence }
    }
    return { kind: 'leave', reason: 'already_clear' }
  }
  const walked =
    task.recurrence_mode === 'from_completion'
      ? walkFromCompletion(task, timezone, untilDay, now)
      : walkFromDue(task, timezone, untilStart, now)
  return { kind: 'skip', ...walked }
}

/**
 * The `until` day, checked: a real `yyyy-MM-dd` date, TOMORROW or later in the
 * user's timezone (today would skip nothing worth a date — "skip this
 * occurrence" is the no-date call), and at most `MAX_UNTIL_YEARS` ahead.
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
  if (day <= today) throw new ValidationError('until must be tomorrow or later')
  if (day > today.plus({ years: MAX_UNTIL_YEARS })) {
    throw new ValidationError(`until is more than ${MAX_UNTIL_YEARS} years ahead`)
  }
  return until
}

export interface SkipUntilOptions {
  userId: number
  userTimezone: string
  taskIds: number[]
  /** `yyyy-MM-dd` in the user's timezone, tomorrow or later; omitted/null = skip this occurrence. */
  until?: string | null
}

export interface SkipUntilResult {
  /** The tasks changed — skipped or retargeted (after the write). */
  tasks: Task[]
  /** Skipped plus retargeted. */
  tasksAffected: number
  /** Occurrences passed over, summed across the tasks. */
  occurrencesSkipped: number
  /** Nothing to skip, but the target was before the date: moved to the occurrence. */
  targetsMoved: number
  /** Left alone, by why. */
  skippedNotRepeating: number
  skippedReminders: number
  skippedQuotas: number
  /** Trashed, archived or done. */
  skippedInactive: number
  /** Target and occurrence already on or after the date: nothing before it. */
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

/** "Mon, Nov 2" in the user's timezone. */
function dayLabel(iso: string, timezone: string): string {
  return DateTime.fromISO(iso, { zone: 'utc' }).setZone(timezone).toFormat('ccc, LLL d')
}

/** A `yyyy-MM-dd` day as "Mon, Nov 2" (a calendar day: no timezone to apply). */
function untilLabel(until: string): string {
  return DateTime.fromFormat(until, 'yyyy-MM-dd', { zone: 'utc' }).toFormat('ccc, LLL d')
}

/** The lead of the summary: what was skipped or moved. */
function summaryLead(
  r: Omit<SkipUntilResult, 'summary'>,
  until: string | null,
  timezone: string,
): string[] {
  const occ = (n: number) => `${n} ${n === 1 ? 'occurrence' : 'occurrences'}`
  const skippedTasks = r.tasksAffected - r.targetsMoved
  if (r.tasksAffected === 1) {
    const t = r.tasks[0]
    const next = dayLabel(t.occurrence_at ?? t.due_at!, timezone)
    if (r.targetsMoved === 1) return [`Moved "${t.title}" to its occurrence · ${next}`]
    const lead = r.occurrencesSkipped > 1 ? `Skipped ${occ(r.occurrencesSkipped)} of` : 'Skipped'
    return [`${lead} "${t.title}" · next ${next}`]
  }
  const parts: string[] = []
  if (skippedTasks > 0) {
    const to = until ? ` until ${untilLabel(until)}` : ''
    const n = r.occurrencesSkipped > skippedTasks ? ` (${occ(r.occurrencesSkipped)})` : ''
    parts.push(`Skipped ${skippedTasks} ${taskWord(skippedTasks)}${to}${n}`)
  }
  if (r.targetsMoved > 0) {
    const whose = r.targetsMoved === 1 ? 'its' : 'their'
    parts.push(
      skippedTasks > 0
        ? `${r.targetsMoved} moved to ${whose} occurrence`
        : `Moved ${r.targetsMoved} ${taskWord(r.targetsMoved)} to their occurrence`,
    )
  }
  return parts.length > 0 ? parts : ['Nothing skipped']
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
  const parts = summaryLead(r, until, timezone)
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

/** One task's write: a skip (`skipped` ≥ 1) or a retarget to its occurrence (`skipped` 0). */
interface PlannedWrite {
  task: Task
  landing: string
  skipped: number
}

/** Skip every repeating task in the batch to `until` (or past this occurrence). */
export function skipUntil(options: SkipUntilOptions): SkipUntilResult {
  const { userId, userTimezone } = options
  const now = new Date()
  const until = parseUntil(options.until, userTimezone, now)
  const batch = loadBatch(userId, options.taskIds)

  const counts: LeaveCounts = {
    skippedNotRepeating: 0,
    skippedReminders: 0,
    skippedQuotas: 0,
    skippedInactive: 0,
    alreadyClear: 0,
  }
  const planned: PlannedWrite[] = []
  for (const task of batch) {
    const plan = planSkipUntil(task, userTimezone, until, now)
    if (plan.kind === 'skip') planned.push({ task, landing: plan.landing, skipped: plan.skipped })
    else if (plan.kind === 'retarget') planned.push({ task, landing: plan.landing, skipped: 0 })
    else counts[LEAVE_COUNTER[plan.reason]] += 1
  }

  const occurrencesSkipped = planned.reduce((sum, p) => sum + p.skipped, 0)
  const targetsMoved = planned.filter((p) => p.skipped === 0).length
  const tasks = planned.length > 0 ? writeSkips(userId, userTimezone, until, planned) : []
  const result = { tasks, tasksAffected: tasks.length, occurrencesSkipped, targetsMoved, ...counts }
  const summary = skipUntilSummary(result, until, userTimezone)
  if (tasks.length === 0) return { ...result, summary }

  emitSyncEvent(userId)
  // The occurrences (or the early targets) are gone, so their notifications should be too.
  dismissNotificationsForTasks(
    userId,
    tasks.map((t) => t.id),
  )
  planned.forEach(({ skipped }, i) => {
    const task = formatTaskResponse(tasks[i], userTimezone)
    // §7.5: a skip is NOT a completion; a retarget is a plain update.
    if (skipped > 0) dispatchWebhookEvent(userId, 'task.skipped', { task })
    else dispatchWebhookEvent(userId, 'task.updated', { task })
  })
  return { ...result, summary }
}

/**
 * A task with nothing before the date to skip whose target was pulled before
 * it: the target goes back to the occurrence (capped at a deadline still
 * ahead, as every move) and any deck cleared. A plain move of the target — stamped, the queue state
 * cleared and the attempts checkpointed by `stampTargetSet` — not a new
 * occurrence, so attempts and `skip_count` stand.
 */
function writeRetarget(
  tx: Database.Database,
  task: Task,
  occurrence: string,
  nowStr: string,
): { after: Task; fieldsChanged: string[] } {
  const dueAt = capAtDeadline(occurrence, task.deadline_at)
  const write: CollectedWrite = {
    setClauses: ['due_at = ?'],
    values: [dueAt],
    fieldsChanged: ['due_at'],
    beforeState: { due_at: task.due_at },
    afterState: { due_at: dueAt },
  }
  stampTargetSet(write, task, nowStr)
  // On deck (ruling E): the target this leaves is the occurrence, so a deck goes
  // in the same write (and the snapshot, so undo puts it back).
  collectDeckClear(write, task, {
    dueAt,
    auto: false,
    rrule: task.rrule,
    isReminder: false,
    isTracked: false,
  })
  tx.prepare(`UPDATE tasks SET ${write.setClauses.join(', ')}, updated_at = ? WHERE id = ?`).run(
    ...write.values,
    nowStr,
    task.id,
  )
  return { after: { ...task, ...write.afterState }, fieldsChanged: write.fieldsChanged }
}

/** One transaction: each task's write, one `bulk_skip` undo entry, an activity row each. */
function writeSkips(
  userId: number,
  timezone: string,
  until: string | null,
  planned: PlannedWrite[],
): Task[] {
  const nowStr = nowUtc()
  const batchId = crypto.randomUUID()
  return withTransaction((tx) => {
    const snapshots: UndoSnapshot[] = []
    const activity: ActivityEntry[] = []
    const afters: Task[] = []
    let fields: string[] = []
    for (const { task, landing, skipped } of planned) {
      const { after, fieldsChanged } =
        skipped > 0
          ? writeRecurringSkip(tx, {
              task,
              nextOccurrenceAt: landing,
              skipsAdded: skipped,
              nowStr,
              timezone,
            })
          : writeRetarget(tx, task, landing, nowStr)
      snapshots.push(createTaskSnapshot(task, after, fieldsChanged))
      fields = [...new Set([...fields, ...fieldsChanged])]
      activity.push({
        userId,
        taskId: task.id,
        action: skipped > 0 ? 'skip' : 'edit',
        source: planned.length > 1 ? 'bulk' : 'single',
        batchId,
        fields: fieldsChanged,
        before: { id: task.id, due_at: task.due_at, skip_count: task.skip_count },
        after: { id: task.id, due_at: after.due_at, skip_count: after.skip_count },
        metadata: { recurring: true, skip_until: until, occurrences_skipped: skipped },
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
