/**
 * ON DECK — the deck endpoint's core and today's decks (2026-10-20;
 * docs/TASK-MODEL.md § On deck; the rules are in src/lib/task-segments.ts).
 *
 * `deckTasks` is `POST /api/tasks/deck`: put tasks on deck for a day (default
 * the calendar today; A2: between midnight and the rollover that is the coming
 * calendar day), or take them off (`day: null`). It is a bulk edit of
 * `on_deck_day` — the deck write itself, its checks and "never both" live in
 * `collectFieldChanges` (`prepareDeck`), shared with PATCH and bulk edit — so
 * it gets one undo entry (action `deck`), the activity rows, the sync event,
 * the notification dismissal when a picked target was dropped, and webhooks.
 *
 * Unlike PATCH it never refuses the whole batch for one task (A11): before
 * the edit it sorts the ids —
 *  - a reminder, a quota, a done or trashed task is SKIPPED and counted
 *    (`skipped_*`; `skipped_recurring` stays in the answer, always 0 since
 *    repeating tasks can be decked, 2026-10-20);
 *  - a deadline task whose automatic target has arrived, or a day after that
 *    target's day, is REFUSED per task (`refused[]`, A1) — a repeating one
 *    against its deadline's own day;
 *  - the rest are decked. A repeating task's deck is for its current
 *    occurrence: its target goes while decked and comes back on the
 *    occurrence when it is taken off (`collectRepeatingUndeck`).
 * An id that is not one of the caller's own tasks is a 400, as on the
 * segment endpoints.
 *
 * Decking also stamps "considered" (A7, as Today does) and
 * `segment_targeted_at` (the dashboard's Just now card), in the same edit —
 * EXCEPT on a row the DEADLINES PAGE will hold after the deck (2026-10-22,
 * Trent's ruling: a decked page row STAYS on the page, waiting, showing its
 * deck day; `deckKeepsPageRow` in deck-clear.ts). Seeing it is still its own tap. It does not
 * nag for it outside the safety net (the deadlines nag counts decked rows only
 * there).
 *
 * Needs the task queue switch (A14): 409 when it is off, since a deck relies
 * on the rollover to send it to the queue when its day ends.
 */

import { getDb } from '@/core/db'
import { AppError, ValidationError } from '@/core/errors'
import type { Task } from '@/types'
import {
  deckDayProblem,
  deckRefusal,
  deckSkip,
  deckSummary,
  type DeckRefusal,
  type DeckResultCounts,
  inSafetyNet,
  isDeadlinePageTask,
} from '@/lib/task-segments'
import { bulkEdit, cancelPendingEnrichment } from './bulk'
import { getTaskById, rowToTask, taskColumns, type TaskRow } from './read'
import { getTargetContext } from './target-context'
import { taskQueueEnabled } from './task-queue'
import { deckRolloverTime } from './deck-clear'
import { dayBoundaryForUser, rolloverTimeForUser } from './rollover-time'
import { openTaskDayOf } from '@/lib/opentask-day'

export interface DeckTasksOptions {
  userId: number
  timezone: string
  ids: number[]
  /** yyyy-MM-dd; undefined = the calendar today; null = take off deck. */
  day?: string | null
  now?: Date
}

export interface DeckTasksResult extends DeckResultCounts {
  /** The day decked for (null for an un-deck). */
  day: string | null
  refused: { id: number; reason: DeckRefusal }[]
  /** One line for a toast (`deckSummary`). */
  summary: string
}

/** The caller's own tasks among `ids`, open or not; any other id is refused, not skipped. */
function ownTasks(userId: number, ids: number[]): Task[] {
  const unique = [...new Set(ids)]
  const tasks = unique.map((id) => getTaskById(id))
  const missing = unique.filter((_, i) => !tasks[i] || tasks[i]!.user_id !== userId)
  if (missing.length > 0) {
    throw new ValidationError(`Every task must be one of your own: ${missing.join(', ')}`)
  }
  return tasks as Task[]
}

export function deckTasks(opts: DeckTasksOptions): DeckTasksResult {
  if (!taskQueueEnabled()) {
    throw new AppError('On deck needs the task queue, which is off on this server', 409, 'CONFLICT')
  }
  const now = opts.now ?? new Date()
  if (opts.ids.length === 0) throw new ValidationError('At least one task ID required')
  // "Today" is the user's OpenTask day ("Day starts at" PR 2): at 01:30 with
  // a 3:00 AM start, the day that is ending — the late night's deck is Tomorrow.
  const dayStart = dayBoundaryForUser(opts.userId)
  const day = opts.day === undefined ? openTaskDayOf(now, opts.timezone, dayStart) : opts.day
  if (day !== null) {
    const problem = deckDayProblem(day, opts.timezone, now, dayStart)
    if (problem) throw new ValidationError(problem)
  }
  const tasks = ownTasks(opts.userId, opts.ids)
  const ctx = getTargetContext(opts.userId)

  const result: DeckTasksResult = {
    day,
    decked: 0,
    undecked: 0,
    skipped_recurring: 0,
    skipped_reminder: 0,
    skipped_quota: 0,
    skipped_done: 0,
    skipped_trashed: 0,
    refused: [],
    summary: '',
  }
  const eligible: Task[] = []
  for (const task of tasks) {
    const skip = deckSkip(task)
    if (skip) {
      result[`skipped_${skip}`]++
      continue
    }
    const refusal = day === null ? null : deckRefusal(task, day, ctx, now, deckRolloverTime(task))
    if (refusal) {
      result.refused.push({ id: task.id, reason: refusal })
      continue
    }
    // Taking off deck touches only what is on deck.
    if (day === null && !task.on_deck_day) continue
    eligible.push(task)
  }

  if (eligible.length > 0) {
    const stamp = now.toISOString()
    const edit = bulkEdit({
      userId: opts.userId,
      userTimezone: opts.timezone,
      taskIds: eligible.map((t) => t.id),
      // The consider stamp is the deck write's own (`collect-field-changes`,
      // A7) — not on a row the deadlines page keeps (`deckKeepsPageRow`).
      changes:
        day === null ? { on_deck_day: null } : { on_deck_day: day, segment_targeted_at: stamp },
      undo: {
        action: 'deck',
        description: (n) =>
          deckSummary(
            { ...result, [day === null ? 'undecked' : 'decked']: n },
            opts.timezone,
            now,
            dayStart,
          ),
      },
    })
    if (day === null) result.undecked = edit.tasksAffected
    else {
      result.decked = edit.tasksAffected
      // A deck is the user's own plan for the task: like a manual target
      // change, it cancels a pending AI enrichment (which could otherwise land
      // a target and take the deck straight off). PATCH does the same in
      // `updateTask`, for every manual edit.
      cancelPendingEnrichment(eligible)
    }
  }
  result.summary = deckSummary(result, opts.timezone, now, dayStart)
  return result
}

/**
 * TODAY'S DECKS (A13; the On deck section D2 draws, and the slot push's
 * count): the user's own open tasks on deck for today's OpenTask date or an
 * earlier day not yet stripped (a rollover that has not run yet). Priority, highest first, then id. Belt and braces (A1, strict):
 * a row whose target has ARRIVED is left out — it is nagging, so it is over
 * target on the dashboard, not on deck (the A1 checks keep this from
 * happening; a deck can only meet its deadline's automatic target in the
 * minutes between a morning_time earlier than the rollover and the rollover).
 */
export function onDeckToday(userId: number, timezone: string, now: Date = new Date()): Task[] {
  const rows = getDb()
    .prepare(
      `SELECT ${taskColumns()} FROM tasks
        WHERE user_id = ? AND on_deck_day IS NOT NULL AND on_deck_day <= ?
          AND done = 0 AND deleted_at IS NULL AND archived_at IS NULL
          AND (due_at IS NULL OR due_at > ?)
        ORDER BY priority DESC, id ASC`,
    )
    .all(
      userId,
      openTaskDayOf(now, timezone, dayBoundaryForUser(userId)),
      now.toISOString(),
    ) as TaskRow[]
  const tasks = rows.map(rowToTask)
  // The deadlines page (2026-10-22, plan §4): in its SAFETY NET a target-less
  // deadline task is on the page, deck or not — never in both places.
  if (!taskQueueEnabled()) return tasks
  const rolloverTime = rolloverTimeForUser(userId)
  return tasks.filter(
    (t) => !isDeadlinePageTask(t) || !inSafetyNet(t.deadline_at!, timezone, now, rolloverTime),
  )
}
