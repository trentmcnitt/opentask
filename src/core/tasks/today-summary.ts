/**
 * WHAT HAPPENED TODAY, for Today's all-clear card (Trent, 2026-10-30, E2 of
 * `.tmp/all-done/`: "there's no inbox zero satisfaction… completing all your
 * tasks for today should be rewarding"): "4 done · 2 moved to tomorrow",
 * counted over the tasks that were in Late or Today during this OpenTask day —
 * a target at or before the day's end.
 *
 * - DONE: completions made today of an occurrence whose target was due by the
 *   end of today (`completions.due_at_was`). An undone completion is deleted
 *   (undo, put-back), so it never counts.
 * - MOVED TO TOMORROW: tasks whose target a move today took from by-the-end-
 *   of-today to later (the activity log's before / after), and that are still
 *   open with their target on tomorrow. Moved again later (to next week),
 *   back into today, done or trashed since — not counted.
 *
 * Tasks only: reminders and quotas are not on Today's list. Days are OpenTask
 * days (`dayStart`).
 *
 * THE ITEMS (Trent, 2026-10-30, 11:18 PM: "Is there any way to see what
 * items were completed for that day?"): the card's counts line opens to list
 * them. The counts ARE these lists' lengths, from the same two queries, so
 * the numbers and the list can't disagree. In the order they happened.
 */
import { getDb } from '@/core/db'
import { addDays, openTaskDateSpan, openTaskDayOf } from '@/lib/opentask-day'

export interface TodaySummaryItem {
  kind: 'done' | 'moved'
  task_id: number
  title: string
  /** Done: when it was completed. Moved: when it was moved (the latest move today). */
  happened_at: string
  /** Moved: where its target is now. */
  due_at: string | null
  /** Moved: a defer the rollover will send to the queue (`queue_mark`), not a timed target. */
  queued: boolean
}

export interface TodaySummary {
  done: number
  moved: number
  items: TodaySummaryItem[]
}

export function todaySummary(
  userId: number,
  timezone: string,
  dayStart: string,
  now: Date = new Date(),
): TodaySummary {
  const today = openTaskDayOf(now, timezone, dayStart)
  const day = openTaskDateSpan(today, timezone, dayStart)
  const tomorrow = openTaskDateSpan(addDays(today, 1), timezone, dayStart)
  const start = day.start.toISOString()
  const end = day.end.toISOString()
  const db = getDb()
  const done = db
    .prepare(
      `SELECT c.task_id, t.title, c.completed_at FROM completions c JOIN tasks t ON t.id = c.task_id
       WHERE c.user_id = ? AND julianday(c.completed_at) >= julianday(?)
         AND julianday(c.completed_at) < julianday(?)
         AND c.due_at_was IS NOT NULL AND julianday(c.due_at_was) < julianday(?)
         AND t.is_reminder = 0 AND t.is_tracked = 0 AND t.deleted_at IS NULL`,
    )
    .all(userId, start, end, end) as { task_id: number; title: string; completed_at: string }[]
  const moved = db
    .prepare(
      `SELECT a.task_id, t.title, MAX(a.created_at) AS moved_at, t.due_at, t.queue_mark
       FROM activity_log a JOIN tasks t ON t.id = a.task_id
       WHERE a.user_id = ? AND julianday(a.created_at) >= julianday(?)
         AND julianday(a.created_at) < julianday(?)
         AND json_extract(a.before, '$.due_at') IS NOT NULL
         AND julianday(json_extract(a.before, '$.due_at')) < julianday(?)
         AND json_extract(a.after, '$.due_at') IS NOT NULL
         AND julianday(json_extract(a.after, '$.due_at')) >= julianday(?)
         AND t.done = 0 AND t.deleted_at IS NULL AND t.is_reminder = 0 AND t.is_tracked = 0
         AND t.due_at IS NOT NULL
         AND julianday(t.due_at) >= julianday(?) AND julianday(t.due_at) < julianday(?)
       GROUP BY a.task_id`,
    )
    .all(
      userId,
      start,
      end,
      end,
      end,
      tomorrow.start.toISOString(),
      tomorrow.end.toISOString(),
    ) as { task_id: number; title: string; moved_at: string; due_at: string; queue_mark: number }[]
  const items: TodaySummaryItem[] = [
    ...done.map((r) => ({
      kind: 'done' as const,
      task_id: r.task_id,
      title: r.title,
      happened_at: r.completed_at,
      due_at: null,
      queued: false,
    })),
    ...moved.map((r) => ({
      kind: 'moved' as const,
      task_id: r.task_id,
      title: r.title,
      happened_at: r.moved_at,
      due_at: r.due_at,
      queued: !!r.queue_mark,
    })),
  ].sort((a, b) => Date.parse(a.happened_at) - Date.parse(b.happened_at))
  return { done: done.length, moved: moved.length, items }
}
