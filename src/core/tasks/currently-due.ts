/**
 * "Which tasks are due right now" — the one place that answers it (§4.6).
 *
 * Four call sites need this: the notifier, the badge, the bulk
 * snooze-overdue sweep, and each project's overdue_count (`getProjects`). Each used to carry its own `due_at < now` SQL. Now that
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
import { dayBoundaryForUser } from './rollover-time'

/*
 * A deadline's target is STORED since 2026-10-12 (§8: `target_auto`), so
 * `due_at` is the whole truth here again — the read-time implied target, its
 * candidate shortlist and the JS swap (`withEffectiveTarget`) are gone.
 */

interface DueCandidate {
  id: number
  project_id: number
  due_at: string | null
  rrule: string | null
  recurrence_mode: 'from_due' | 'from_completion' | null
  anchor_time: string | null
  occurrence_at: string | null
  on_deck_day: string | null
  repeat_anchor: 'target' | 'deadline'
  timezone: string
}

/**
 * Candidate rows for a user: every recurring task (its due_at is untrustworthy,
 * so the schedule must be consulted) plus one-offs already past due.
 *
 * Ordered by due_at so callers that slice — the notifier's per-bucket caps —
 * keep the existing "most overdue first" behavior.
 */
function fetchDueCandidates(userId: number, now: Date): DueCandidate[] {
  const rows = getDb()
    .prepare(
      `SELECT t.id, t.project_id, t.due_at, t.rrule, t.recurrence_mode, t.anchor_time,
              t.occurrence_at, t.on_deck_day, t.repeat_anchor, u.timezone
         FROM tasks t
         INNER JOIN users u ON t.user_id = u.id
        WHERE t.user_id = ?
          AND t.done = 0
          AND t.deleted_at IS NULL
          AND t.archived_at IS NULL
          -- §5: tracked items are EXEMPT from the §4.1 cadence loop. Their
          -- only notification is the pace nudge; without this exclusion a
          -- tracked task with a due date would get the standard nag PLUS the
          -- nudge, which is the pile-up this redesign exists to remove.
          AND t.progress_target <= 1
          AND t.is_tracked = 0
          -- §6: reminders have NO DEBT. They are never counted in overdue,
          -- never reach the badge, and never fire individually — the time slot
          -- notifies, not the item. Missing one costs nothing; the next
          -- occurrence simply arrives.
          AND t.is_reminder = 0
          -- On deck (2026-10-20): a deck never nags — a decked repeating
          -- task (no target) must not have its schedule asked; a deck with a
          -- target is a deadline's automatic one, which protects regardless
          -- (effectiveDueAt says the same).
          AND (t.on_deck_day IS NULL OR t.due_at IS NOT NULL)
          AND (
            t.rrule IS NOT NULL
            -- At or before now: an automatic target set to "now" (ruling Q10)
            -- is over target at once, as isCurrentlyDue says.
            OR (t.due_at IS NOT NULL AND datetime(t.due_at) <= datetime(?))
          )
        ORDER BY t.due_at ASC NULLS LAST`,
    )
    .all(userId, now.toISOString()) as DueCandidate[]
  return rows
}

function fetchCurrentlyDue(userId: number, now: Date): DueCandidate[] {
  // The no-target fallback's "today" is the user's OpenTask day.
  const dayStart = dayBoundaryForUser(userId)
  return fetchDueCandidates(userId, now).filter((row) =>
    isCurrentlyDue(row, row.timezone, dayStart, now),
  )
}

/** IDs of the user's tasks that are due or overdue as of `now`. */
export function getCurrentlyDueTaskIds(userId: number, now: Date = new Date()): number[] {
  return fetchCurrentlyDue(userId, now).map((row) => row.id)
}

/**
 * How many of the user's tasks are due or overdue as of `now`, per project id.
 * One candidate pass for every project, so the project list never evaluates
 * the rrules once per project. A project with nothing due is absent.
 */
export function countCurrentlyDueByProject(
  userId: number,
  now: Date = new Date(),
): Map<number, number> {
  const counts = new Map<number, number>()
  for (const row of fetchCurrentlyDue(userId, now)) {
    counts.set(row.project_id, (counts.get(row.project_id) ?? 0) + 1)
  }
  return counts
}

/** How many of the user's tasks are due or overdue as of `now`. */
export function countCurrentlyDue(userId: number, now: Date = new Date()): number {
  return getCurrentlyDueTaskIds(userId, now).length
}
