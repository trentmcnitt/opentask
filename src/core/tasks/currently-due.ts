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
import { effectiveTargetAt } from '@/lib/task-segments'

/**
 * Which rows MIGHT have a deadline-implied target (2026-10-10): a one-off with a
 * deadline — even one whose nag is off, since it re-arms on the deadline day
 * (ruling A4). SQL can only shortlist them — the
 * implied target is the morning of the lead day in the USER'S timezone
 * (`impliedTargetAt`), which SQLite cannot compute — so they are fetched as
 * candidates and `withEffectiveTarget` decides in JS, with the same function
 * the client uses. Callers put the effective target in `due_at`, so the rest
 * of the due-ness machinery (`isCurrentlyDue`, the notifier's cadence math)
 * reads an implied target exactly like a set one.
 */
export function deadlineCandidateSql(alias = 't'): string {
  return `(${alias}.deadline_at IS NOT NULL AND ${alias}.rrule IS NULL)`
}

/** A candidate row with its `due_at` replaced by its effective target. */
export function withEffectiveTarget<
  T extends {
    due_at: string | null
    deadline_at?: string | null
    deadline_nag_off?: number | boolean
    rrule: string | null
    timezone: string
    morning_time?: string | null
  },
>(row: T): T {
  if (!row.deadline_at) return row
  const due_at = effectiveTargetAt(
    {
      due_at: row.due_at,
      rrule: row.rrule,
      deadline_at: row.deadline_at,
      deadline_nag_off: row.deadline_nag_off === 1 || row.deadline_nag_off === true,
    },
    { timezone: row.timezone, morningTime: row.morning_time || '09:00' },
  )
  return { ...row, due_at }
}

interface DueCandidate {
  id: number
  project_id: number
  due_at: string | null
  rrule: string | null
  recurrence_mode: 'from_due' | 'from_completion' | null
  anchor_time: string | null
  timezone: string
  deadline_at: string | null
  deadline_nag_off: number
  morning_time: string | null
}

/**
 * Candidate rows for a user: every recurring task (its due_at is untrustworthy,
 * so the schedule must be consulted) plus one-offs already past due.
 *
 * Ordered by due_at so callers that slice — the notifier's per-bucket caps —
 * keep the existing "most overdue first" behavior.
 */
function fetchDueCandidates(userId: number): DueCandidate[] {
  const rows = getDb()
    .prepare(
      `SELECT t.id, t.project_id, t.due_at, t.rrule, t.recurrence_mode, t.anchor_time,
              t.deadline_at, t.deadline_nag_off, u.timezone, u.morning_time
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
          AND (
            t.rrule IS NOT NULL
            OR (t.due_at IS NOT NULL AND datetime(t.due_at) < datetime('now'))
            OR ${deadlineCandidateSql()}
          )`,
    )
    .all(userId) as DueCandidate[]
  // Effective targets first (2026-10-10), then "most overdue first" as before.
  return rows
    .map(withEffectiveTarget)
    .sort((a, b) => (a.due_at ?? '\uffff').localeCompare(b.due_at ?? '\uffff'))
}

function fetchCurrentlyDue(userId: number, now: Date): DueCandidate[] {
  return fetchDueCandidates(userId).filter((row) => isCurrentlyDue(row, row.timezone, now))
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
