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
 */
import { getDb } from '@/core/db'
import { addDays, openTaskDateSpan, openTaskDayOf } from '@/lib/opentask-day'

export interface TodaySummary {
  done: number
  moved: number
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
      `SELECT COUNT(*) AS n FROM completions c JOIN tasks t ON t.id = c.task_id
       WHERE c.user_id = ? AND julianday(c.completed_at) >= julianday(?)
         AND julianday(c.completed_at) < julianday(?)
         AND c.due_at_was IS NOT NULL AND julianday(c.due_at_was) < julianday(?)
         AND t.is_reminder = 0 AND t.is_tracked = 0 AND t.deleted_at IS NULL`,
    )
    .get(userId, start, end, end) as { n: number }
  const moved = db
    .prepare(
      `SELECT COUNT(DISTINCT a.task_id) AS n FROM activity_log a JOIN tasks t ON t.id = a.task_id
       WHERE a.user_id = ? AND julianday(a.created_at) >= julianday(?)
         AND julianday(a.created_at) < julianday(?)
         AND json_extract(a.before, '$.due_at') IS NOT NULL
         AND julianday(json_extract(a.before, '$.due_at')) < julianday(?)
         AND json_extract(a.after, '$.due_at') IS NOT NULL
         AND julianday(json_extract(a.after, '$.due_at')) >= julianday(?)
         AND t.done = 0 AND t.deleted_at IS NULL AND t.is_reminder = 0 AND t.is_tracked = 0
         AND t.due_at IS NOT NULL
         AND julianday(t.due_at) >= julianday(?) AND julianday(t.due_at) < julianday(?)`,
    )
    .get(
      userId,
      start,
      end,
      end,
      end,
      tomorrow.start.toISOString(),
      tomorrow.end.toISOString(),
    ) as {
    n: number
  }
  return { done: done.n, moved: moved.n }
}
