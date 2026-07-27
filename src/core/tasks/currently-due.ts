/**
 * "Which tasks are due right now" — the one place that answers it (§4.6).
 *
 * Three call sites needed this: the notifier, the badge, and the bulk
 * snooze-overdue sweep. Each used to carry its own `due_at < now` SQL. Now that
 * due-ness is derived rather than stored, three hand-rolled copies would drift
 * — and drift here means the badge, the notification, and the sweep disagree
 * about what is overdue, which is precisely the "app I can't trust" problem the
 * redesign exists to fix.
 *
 * The shape is always: fetch CANDIDATES in SQL (cheap, indexed), then decide
 * due-ness per row in JS via `effectiveDueAt`. SQL can't do the second half —
 * it would need an rrule evaluator.
 */

import { getDb } from '@/core/db'
import { isCurrentlyDue } from '@/core/recurrence/occurrence'

interface DueCandidate {
  id: number
  due_at: string | null
  rrule: string | null
  recurrence_mode: 'from_due' | 'from_completion' | null
  anchor_time: string | null
  timezone: string
}

/**
 * Candidate rows for a user: every recurring task (its due_at is untrustworthy,
 * so the schedule must be consulted) plus one-offs already past due.
 *
 * Ordered by due_at so callers that slice — the notifier's per-bucket caps —
 * keep the existing "most overdue first" behavior.
 */
function fetchDueCandidates(userId: number): DueCandidate[] {
  return getDb()
    .prepare(
      `SELECT t.id, t.due_at, t.rrule, t.recurrence_mode, t.anchor_time, u.timezone
         FROM tasks t
         INNER JOIN users u ON t.user_id = u.id
        WHERE t.user_id = ?
          AND t.done = 0
          AND t.deleted_at IS NULL
          AND t.archived_at IS NULL
          AND (
            t.rrule IS NOT NULL
            OR (t.due_at IS NOT NULL AND datetime(t.due_at) < datetime('now'))
          )
        ORDER BY t.due_at ASC`,
    )
    .all(userId) as DueCandidate[]
}

/** IDs of the user's tasks that are due or overdue as of `now`. */
export function getCurrentlyDueTaskIds(userId: number, now: Date = new Date()): number[] {
  return fetchDueCandidates(userId)
    .filter((row) => isCurrentlyDue(row, row.timezone, now))
    .map((row) => row.id)
}

/** How many of the user's tasks are due or overdue as of `now`. */
export function countCurrentlyDue(userId: number, now: Date = new Date()): number {
  return getCurrentlyDueTaskIds(userId, now).length
}
