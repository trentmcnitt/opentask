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
 * - ON DECK (designer ruling, 2026-10-21): "skip until Sunday" means
 *   nothing BEFORE Sunday, and a deck already planned for Monday is part of
 *   the after. A decked repeating task has no target (`due_at` NULL, its
 *   occurrence kept), so every rule here reads the occurrence
 *   (`occurrence_at`), never the null target.
 * - A DEADLINE-ANCHORED repeat (2026-10-21): its occurrence is its deadline
 *   and its target lies before it (`occurrenceDates`), so "nothing nags
 *   before the date" is judged on the occurrence's DERIVED TARGET: the task
 *   lands on the first occurrence whose target is on or after the date (an
 *   occurrence whose deadline is on the date but whose target is the day
 *   before is skipped too), and a retarget puts the derived target back. A
 *   from_completion one lands its DEADLINE `target_days_before` days after
 *   the date, so its target is on it.
 *   - A deck day BEFORE the date is cleared in the same write and undo
 *     snapshot, and the task gets a target at its landing occurrence (or,
 *     with its occurrence already on or after the date, back on that
 *     occurrence: a retarget). Never a repeating task with neither.
 *   - A deck day ON or AFTER the date is kept: the occurrence still moves to
 *     the landing one with the same skip count, the target stays NULL and
 *     `on_deck_day` is unchanged — the deck now refers to the landing
 *     occurrence. With nothing to skip, the task is `already_clear`. A1
 *     (decks never nag) needs no new check: the deadline only moves forward
 *     with the occurrence (`occurrenceDates`), and the deck day already sat
 *     before the old deadline's day (`deckRefusal`, checked when decked).
 *   - "Skip this occurrence" (no date) always clears the deck, like
 *     `skipOccurrence`.
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
  ruleTimeOfDay,
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
import { seriesEndSkipWords, writeRecurringSkip, writeSeriesEndSkip } from './skip'
import { stampTargetSet, type CollectedWrite } from './target-set'
import { collectDeckClear } from './deck-clear'
import {
  isDeadlineAnchored,
  nextLanding,
  nextOrEnd,
  occurrenceDates,
  occurrenceTarget,
  repeatEndOf,
  repeatStep,
} from '@/lib/task-segments'

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
  /**
   * `keepDeck`: the task's deck day is on or after the date, so the deck
   * stays. `ended` (repeat ends, 2026-10-22): the skip passes the series'
   * end — `skipped` is then only the occurrences that were left to close
   * (`repeatStep`'s `consumed`), and there is no landing.
   */
  | { kind: 'skip'; landing: string; skipped: number; keepDeck: boolean; ended: false }
  | { kind: 'skip'; landing: null; skipped: number; keepDeck: false; ended: true }
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
  | 'deadline_at'
  | 'repeat_anchor'
  | 'target_days_before'
  | 'target_time'
  | 'repeat_count'
  | 'repeat_count_used'
  | 'repeat_until'
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
  const first = new Date(nextLanding(task, timezone, now))
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
 * on the date itself at the rule's time (`ruleTimeOfDay`, the fallback the next
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
  // The floor: exactly where "skip this occurrence" lands (end-blind; the end
  // is judged on the landing in `planSkipUntil`).
  const plain = new Date(nextLanding(task, timezone, now))
  const skipped = completionSkipsBefore(task, timezone, untilDay.toJSDate(), now)
  const { hour, minute } = ruleTimeOfDay(task.rrule!, task.anchor_time)
  // A deadline-anchored repeat's occurrence is its deadline: it lands
  // `target_days_before` days on, so its derived target is on the date.
  const lead = isDeadlineAnchored(task) ? (task.target_days_before ?? 0) : 0
  const onTheDay = untilDay
    .plus({ days: lead })
    .set({ hour, minute, second: 0, millisecond: 0 })
    .toJSDate()
  const landing = onTheDay > plain ? onTheDay : plain
  return { landing: landing.toISOString(), skipped }
}

/**
 * A from_completion rule's skips before `before`: interval steps from the
 * current occurrence (from now, when it has passed), as if each had been
 * done on time — the current occurrence is the first.
 */
function completionSkipsBefore(task: PlanTask, timezone: string, before: Date, now: Date): number {
  const step = (from: Date) =>
    computeNextOccurrence({
      rrule: task.rrule!,
      recurrenceMode: 'from_completion',
      anchorTime: task.anchor_time,
      timezone,
      completedAt: from,
    })
  const current = task.occurrence_at ?? task.due_at
  let at = step(current && Date.parse(current) > now.getTime() ? new Date(current) : now)
  let skipped = 1
  while (at.getTime() < before.getTime()) {
    if (++skipped > MAX_SKIPPED) throw tooManySkips()
    at = step(at)
  }
  return skipped
}

/** The occurrences a skip closes before `before`, the current one included (either mode). */
function skipsBefore(task: PlanTask, timezone: string, before: Date, now: Date): number {
  if (task.recurrence_mode === 'from_completion') {
    return completionSkipsBefore(task, timezone, before, now)
  }
  return walkFromDue(task, timezone, before, now).skipped
}

/**
 * REPEAT ENDS (2026-10-22): the walk's landing judged by `repeatStep`, with
 * the `skipped` occurrences it closes. Past the end, the skip closes only
 * what the series had left: a count's `consumed` (`count − used`), or — a
 * date end — the occurrences before the day after `repeat_until`, re-counted.
 * The skip then ends the series (`writeSeriesEndSkip`).
 */
function judgeSkip(
  task: PlanTask,
  timezone: string,
  walked: { landing: string; skipped: number },
  keepDeck: boolean,
  now: Date,
): SkipUntilPlan {
  const end = repeatEndOf(task)
  const step = repeatStep(end, walked.landing, walked.skipped, timezone)
  if (!step.ended) {
    return {
      kind: 'skip',
      landing: walked.landing,
      skipped: walked.skipped,
      keepDeck,
      ended: false,
    }
  }
  let consumed = step.consumed
  if (end.repeat_count === null && end.repeat_until !== null) {
    const dayAfter = DateTime.fromISO(end.repeat_until, { zone: timezone })
      .startOf('day')
      .plus({ days: 1 })
      .toJSDate()
    consumed = Math.min(walked.skipped, skipsBefore(task, timezone, dayAfter, now))
  }
  return { kind: 'skip', landing: null, skipped: consumed, keepDeck: false, ended: true }
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
    // Exactly `skipOccurrence`: one occurrence, judged by `nextOrEnd`.
    const step = nextOrEnd(task, timezone, { completedAt: now })
    return step.ended
      ? { kind: 'skip', landing: null, skipped: step.consumed, keepDeck: false, ended: true }
      : { kind: 'skip', landing: step.occurrenceAt, skipped: 1, keepDeck: false, ended: false }
  }
  const untilDay = DateTime.fromISO(until, { zone: timezone }).startOf('day')
  const untilStart = untilDay.toJSDate()
  // A deck on or after the date is part of the after: it stays. Both days are
  // `yyyy-MM-dd` in the user's timezone, so the string compare is the day compare.
  const keepDeck = !!task.on_deck_day && task.due_at === null && task.on_deck_day >= until
  // A decked repeating task has `due_at` NULL: its occurrence is the truth —
  // judged by the target it derives (a deadline-anchored one's lies before it).
  const occurrence = task.occurrence_at ?? task.due_at
  const derived = occurrence ? occurrenceDates(task, occurrence, timezone).targetAt : null
  if (occurrence && derived && Date.parse(derived) >= untilStart.getTime()) {
    const targetEarly = task.due_at !== null && Date.parse(task.due_at) < untilStart.getTime()
    const deckEarly = !!task.on_deck_day && !keepDeck
    // The target the retarget would write: the occurrence's derived one. A re-run
    // with no deck to clear would rewrite the same target — nothing to do.
    const sameTarget = task.due_at !== null && Date.parse(task.due_at) === Date.parse(derived)
    // A deck before the date goes, and the target comes back on the occurrence.
    if (deckEarly || (targetEarly && !sameTarget)) {
      return { kind: 'retarget', landing: occurrence }
    }
    return { kind: 'leave', reason: 'already_clear' }
  }
  const walked =
    task.recurrence_mode === 'from_completion'
      ? walkFromCompletion(task, timezone, untilDay, now)
      : walkFromDue(task, timezone, untilStart, now)
  return judgeSkip(
    task,
    timezone,
    targetOnOrAfter(task, timezone, untilStart, walked),
    keepDeck,
    now,
  )
}

/**
 * A DEADLINE-ANCHORED landing (2026-10-21): the walk found the first
 * occurrence (its deadline) on or after the date, but its derived target may
 * still lie before it — step on, one skip each, until the target is on or
 * after the date. The lead is shorter than the gap between deadlines
 * (`relativeTargetProblem`), so this is at most one more step. A target-anchored
 * landing is its own target: unchanged.
 */
function targetOnOrAfter(
  task: PlanTask,
  timezone: string,
  untilStart: Date,
  walked: { landing: string; skipped: number },
): { landing: string; skipped: number } {
  let { landing, skipped } = walked
  // An occurrence with no target (L1) is judged by its deadline.
  const nagsAt = (at: string) => occurrenceDates(task, at, timezone).targetAt ?? at
  while (Date.parse(nagsAt(landing)) < untilStart.getTime()) {
    if (++skipped > MAX_SKIPPED) throw tooManySkips()
    landing = nextLanding({ ...task, occurrence_at: landing }, timezone, new Date(landing))
  }
  return { landing, skipped }
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
  /**
   * Repeat ends (2026-10-22): skipped tasks whose series ended — the skip
   * passed the last occurrence (in `tasksAffected`; archived, see
   * `writeSeriesEndSkip`).
   */
  seriesEnded: number
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
  if (r.tasksAffected === 1 && r.seriesEnded === 1) {
    return [seriesEndSkipWords(r.tasks[0])]
  }
  if (r.tasksAffected === 1) {
    const t = r.tasks[0]
    // The landing occurrence's TARGET day (a deadline-anchored repeat's lies
    // before its deadline, 2026-10-21) — when it next nags.
    const next = dayLabel(occurrenceTarget(t, timezone)!, timezone)
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
  if (r.seriesEnded > 0 && r.tasksAffected > 1) parts.push(`${r.seriesEnded} ended`)
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
  /** Null when the skip ends the series (`ended`). */
  landing: string | null
  skipped: number
  /** A skip that keeps the task's deck (its day on or after the date). */
  keepDeck: boolean
  /** Repeat ends: the skip passes the series' end (`writeSeriesEndSkip`). */
  ended: boolean
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
    if (plan.kind === 'skip') {
      planned.push({
        task,
        landing: plan.landing,
        skipped: plan.skipped,
        keepDeck: plan.keepDeck,
        ended: plan.ended,
      })
    } else if (plan.kind === 'retarget') {
      planned.push({ task, landing: plan.landing, skipped: 0, keepDeck: false, ended: false })
    } else counts[LEAVE_COUNTER[plan.reason]] += 1
  }

  const occurrencesSkipped = planned.reduce((sum, p) => sum + p.skipped, 0)
  const targetsMoved = planned.filter((p) => !p.ended && p.skipped === 0).length
  const seriesEnded = planned.filter((p) => p.ended).length
  const tasks = planned.length > 0 ? writeSkips(userId, userTimezone, until, planned) : []
  const result = {
    tasks,
    tasksAffected: tasks.length,
    occurrencesSkipped,
    targetsMoved,
    seriesEnded,
    ...counts,
  }
  const summary = skipUntilSummary(result, until, userTimezone)
  if (tasks.length === 0) return { ...result, summary }

  emitSyncEvent(userId)
  // The occurrences (or the early targets) are gone, so their notifications should be too.
  dismissNotificationsForTasks(
    userId,
    tasks.map((t) => t.id),
  )
  planned.forEach(({ skipped, ended }, i) => {
    const task = formatTaskResponse(tasks[i], userTimezone)
    // §7.5: a skip is NOT a completion; a retarget is a plain update.
    if (ended) dispatchWebhookEvent(userId, 'task.skipped', { task, series_ended: true })
    else if (skipped > 0) dispatchWebhookEvent(userId, 'task.skipped', { task })
    else dispatchWebhookEvent(userId, 'task.updated', { task })
  })
  return { ...result, summary }
}

/**
 * A task with nothing before the date to skip whose target was pulled before
 * it: the target goes back to the occurrence's own (`occurrenceDates` — on a
 * deadline-anchored repeat, its derived target) and any deck cleared. A plain move of the target — stamped, the queue state
 * cleared and the attempts checkpointed by `stampTargetSet` — not a new
 * occurrence, so attempts and `skip_count` stand.
 */
function writeRetarget(
  tx: Database.Database,
  task: Task,
  occurrence: string,
  nowStr: string,
  timezone: string,
): { after: Task; fieldsChanged: string[] } {
  const dueAt = occurrenceDates(task, occurrence, timezone).targetAt
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
    for (const { task, landing, skipped, keepDeck, ended } of planned) {
      const { after, fieldsChanged } = ended
        ? writeSeriesEndSkip(tx, { task, skipsAdded: skipped, nowStr })
        : skipped > 0
          ? writeRecurringSkip(tx, {
              task,
              nextOccurrenceAt: landing,
              skipsAdded: skipped,
              nowStr,
              timezone,
              keepDeck,
            })
          : writeRetarget(tx, task, landing!, nowStr, timezone)
      snapshots.push(createTaskSnapshot(task, after, fieldsChanged))
      fields = [...new Set([...fields, ...fieldsChanged])]
      activity.push({
        userId,
        taskId: task.id,
        action: ended || skipped > 0 ? 'skip' : 'edit',
        source: planned.length > 1 ? 'bulk' : 'single',
        batchId,
        fields: fieldsChanged,
        before: { id: task.id, due_at: task.due_at, skip_count: task.skip_count },
        after: { id: task.id, due_at: after.due_at, skip_count: after.skip_count },
        metadata: {
          recurring: true,
          skip_until: until,
          occurrences_skipped: skipped,
          ...(ended ? { series_ended: true } : {}),
        },
      })
      afters.push(after)
    }
    const to = until ? ` until ${untilLabel(until)}` : ''
    // The undo / History words match the toast: a batch that only moved
    // targets back onto their occurrences says so.
    const onlyMoved = planned.every((p) => !p.ended && p.skipped === 0)
    const description = onlyMoved
      ? planned.length === 1
        ? `Moved "${planned[0].task.title}" to its occurrence`
        : `Moved ${planned.length} tasks to their occurrence`
      : planned.length === 1
        ? planned[0].ended
          ? seriesEndSkipWords(planned[0].task)
          : `Skipped "${planned[0].task.title}"${to}`
        : `Skipped ${planned.length} tasks${to}`
    logAction(userId, 'bulk_skip', description, fields, snapshots)
    logActivityBatch(activity)
    return afters
  })
}
