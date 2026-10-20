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
 *  - a repeating task, a reminder, a quota, a done or trashed task is SKIPPED
 *    and counted (`skipped_*`);
 *  - a deadline task whose automatic target has arrived, or a day after that
 *    target's day, is REFUSED per task (`refused[]`, A1);
 *  - the rest are decked.
 * An id that is not one of the caller's own tasks is a 400, as on the
 * segment endpoints.
 *
 * Decking also stamps "considered" (A7, as Today does) and
 * `segment_targeted_at` (the dashboard's Just now card), in the same edit.
 *
 * Needs the task queue switch (A14): 409 when it is off, since a deck relies
 * on the rollover to send it to the queue when its day ends.
 */

import { getDb } from '@/core/db'
import { AppError, ValidationError } from '@/core/errors'
import type { Task } from '@/types'
import {
  calendarToday,
  deckDayProblem,
  deckRefusal,
  deckSkip,
  deckSummary,
  type DeckRefusal,
  type DeckResultCounts,
} from '@/lib/task-segments'
import { bulkEdit } from './bulk'
import { getTaskById, rowToTask, taskColumns, type TaskRow } from './read'
import { getTargetContext } from './target-context'
import { taskQueueEnabled } from './task-queue'

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
  const day = opts.day === undefined ? calendarToday(opts.timezone, now) : opts.day
  if (day !== null) {
    const problem = deckDayProblem(day, opts.timezone, now)
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
    const refusal = day === null ? null : deckRefusal(task, day, ctx, now)
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
      changes:
        day === null
          ? { on_deck_day: null }
          : { on_deck_day: day, last_considered_at: stamp, segment_targeted_at: stamp },
      undo: {
        action: 'deck',
        description: (n) =>
          deckSummary({ ...result, [day === null ? 'undecked' : 'decked']: n }, opts.timezone, now),
      },
    })
    if (day === null) result.undecked = edit.tasksAffected
    else result.decked = edit.tasksAffected
  }
  result.summary = deckSummary(result, opts.timezone, now)
  return result
}

/**
 * TODAY'S DECKS (A13; the On deck section D2 draws, and the slot push's
 * count): the user's own open tasks on deck for the calendar today or an
 * earlier day not yet stripped (A2: the leftovers between midnight and the
 * rollover). Priority, highest first, then id.
 */
export function onDeckToday(userId: number, timezone: string, now: Date = new Date()): Task[] {
  const rows = getDb()
    .prepare(
      `SELECT ${taskColumns()} FROM tasks
        WHERE user_id = ? AND on_deck_day IS NOT NULL AND on_deck_day <= ?
          AND done = 0 AND deleted_at IS NULL AND archived_at IS NULL
        ORDER BY priority DESC, id ASC`,
    )
    .all(userId, calendarToday(timezone, now)) as TaskRow[]
  return rows.map(rowToTask)
}
