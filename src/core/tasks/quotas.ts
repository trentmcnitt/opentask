/**
 * Quotas surface queries (REDESIGN-V03 §5)
 *
 * A quota is "how often", not "when": four workouts a week, one date night a
 * month. It is a task row carrying `progress_target > 1` OR `is_tracked = 1` —
 * the flag exists so a target of one ("date night, once a month") can still be
 * a quota rather than a deadline.
 *
 * This module is the sibling of `reminders.ts`, and exists for the same reason
 * that one does: the surface needs ITS items, not everybody's. Before it, the
 * Quotas page fetched `/api/tasks?done=false&limit=1000` and filtered in the
 * browser — on Trent's account that is 512 tasks pulled over the wire to render
 * eight, on every sync event, and a +1 emits a sync event. The phone paid that
 * for every tap.
 */

import { getDb } from '@/core/db'
import type { Task } from '@/types'
import { getTasks } from './create'
import { loadTaskForMutation } from './access'
import { ValidationError } from '@/core/errors'
import { isTracked } from '@/lib/track'

/**
 * Every open quota for a user.
 *
 * Deliberately NOT ordered here. `trackedItems()` in `@/lib/slot-view` owns
 * quota order — alphabetical, so logging on one never reorders the others under
 * the user's finger (commit 9bcf03d, "frozen order") — and the dashboard's
 * Track panel already sorts through it. Ordering here too would give the two
 * views of the same eight things two different sources of truth, and SQLite's
 * `COLLATE NOCASE` and JS's `localeCompare` do not agree on accented titles.
 *
 * `kind: 'quota'` filters in SQL, before the LIMIT. Filtering the first 1000
 * open tasks in JS instead would silently drop quotas once an account passed
 * 1000 open tasks.
 */
export function getQuotas(userId: number): Task[] {
  return getTasks({ userId, done: false, kind: 'quota', limit: 1000 })
}

/**
 * Whether the user has any quota at all, including done ones.
 *
 * Only the empty state reads this: it picks between "you have none yet, here is
 * what they are for" and "nothing open right now". Mirrors `hasAnyReminders`.
 */
export function hasAnyQuotas(userId: number): boolean {
  const row = getDb()
    .prepare(
      `SELECT 1 FROM tasks
        WHERE user_id = ?
          AND deleted_at IS NULL
          AND (progress_target > 1 OR is_tracked = 1)
        LIMIT 1`,
    )
    .get(userId)
  return row !== undefined
}

/** A quota's record over its closed periods — see `getQuotaStats`. */
export interface QuotaStats {
  /** Closed periods that reached the target. */
  periods_met: number
  /**
   * Closed periods that fell short of it (including a missed one recorded as
   * 0). Not an unmet TRANSITION period (`progress_periods.transition`).
   */
  periods_missed: number
  /** Met periods in a row, counting back from the most recent closed one. */
  current_streak: number
  /** The longest run of met periods in a row, ever. */
  longest_streak: number
  /**
   * When the last tap that still stands was logged (UTC ISO), or null if
   * none does — see `lastStandingTap`. The bubble's and editor's "Last: …".
   */
  last_logged_at: string | null
}

/**
 * A quota's history in four numbers, for the chip's bubble (`TrackChipPopover`)
 * — the "how often has this actually happened" the Quotas page's Details list
 * used to answer with "met 2×", which went with that view (2026-10-16).
 *
 * ONE SOURCE: `progress_periods`, which the period rollover writes for every
 * closed period, met or short (`period-rollover.ts`). Not `completion_count`:
 * a task converted into a quota keeps the count it earned as a plain task, so
 * "met" from there and "missed" from here would not add up to the periods it
 * has been tracked for. Only CLOSED periods count; the one in progress is the
 * chip's own count, and the bubble adds it to the streak itself once it is met.
 *
 * Cheap on purpose: one query on `idx_progress_periods_task`, newest first,
 * and one walk over the `met` flags — a daily quota tracked for years is a few
 * thousand integers.
 */
export function getQuotaStats(userId: number, taskId: number): QuotaStats {
  const task = loadTaskForMutation(userId, taskId, { trashed: 'allow' })
  if (!isTracked(task)) throw new ValidationError('Not a quota')

  const rows = getDb()
    .prepare(
      `SELECT met FROM progress_periods
        WHERE task_id = ?
          -- A TRANSITION period ("Day starts at" PR 2): it ended early because
          -- its anchor was not on a period start (every midnight anchor once
          -- the day starts at 3:00) — hours long, not a week the user missed.
          -- Unmet, it is neither met nor missed and does not break a streak;
          -- met, it counts like any period.
          AND NOT (transition = 1 AND met = 0)
        ORDER BY period_start DESC, id DESC`,
    )
    .all(taskId) as { met: number }[]

  let met = 0
  let current = 0
  let longest = 0
  let run = 0
  let unbroken = true
  for (const row of rows) {
    if (row.met) {
      met++
      run++
      if (run > longest) longest = run
      if (unbroken) current = run
    } else {
      run = 0
      unbroken = false
    }
  }
  return {
    periods_met: met,
    periods_missed: rows.length - met,
    current_streak: current,
    longest_streak: longest,
    last_logged_at: lastStandingTap(taskId),
  }
}

/**
 * The time of the most recent +1 that was not taken back (2026-10-16): the
 * events, newest first, with every negative row (a −1, an undo's
 * compensating row, a put-back) cancelling the latest positive one before it.
 * So a tap followed by its Undo is not "the last tap"; the one before it is.
 * A redo's row is a tap again. Null when nothing stands.
 *
 * Walks at most `LAST_TAP_SCAN` rows: a quota's taps are a few a day, and a
 * run of that many cancelled taps in a row is not a history anybody has.
 */
const LAST_TAP_SCAN = 500

function lastStandingTap(taskId: number): string | null {
  const rows = getDb()
    .prepare(
      `SELECT delta, logged_at FROM progress_events
        WHERE task_id = ?
        ORDER BY julianday(logged_at) DESC, id DESC
        LIMIT ?`,
    )
    .all(taskId, LAST_TAP_SCAN) as { delta: number; logged_at: string }[]
  let owed = 0
  for (const row of rows) {
    if (row.delta < 0) {
      owed += -row.delta
    } else if (row.delta > owed) {
      return normalizeIso(row.logged_at)
    } else {
      owed -= row.delta
    }
  }
  return null
}

/** `logged_at` is written as `…:SSZ` and as `…:SS.sssZ`; serve one form. */
function normalizeIso(at: string): string {
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? at : d.toISOString()
}

/** One row of a quota's progress history — `GET /api/tasks/:id/progress-events`. */
export interface ProgressEvent {
  id: number
  /** Signed: +1 a tap, −1 a correction, an undo's opposite row. */
  delta: number
  /** UTC ISO. */
  logged_at: string
  /** `web` | `widget` | `watch` | `mac` | `api` | `undo` | `redo` (src/lib/progress-source.ts). */
  source: string
  /** Who logged it — a shared quota can be logged by more than its owner. */
  user_id: number
}

/** The most rows one request returns. */
export const PROGRESS_EVENTS_LIMIT = 500

/**
 * A quota's progress history, newest first, between `since` (inclusive) and
 * `until` (exclusive), either optional. Access is the task's own (owner, or a
 * shared project — `loadTaskForMutation`'s rule, trashed allowed, as for its
 * stats). At most `limit` rows (≤ 500); `has_more` says there are older ones,
 * fetched by passing the last row's `id` back as `before_id`. Paged by id,
 * not by time: two taps in one second share a `logged_at`, and a time cursor
 * would drop one of them at a page edge. Ids are written in order, so id
 * order is the order they were logged.
 */
export function getProgressEvents(
  userId: number,
  taskId: number,
  range: { since?: string; until?: string; limit?: number; beforeId?: number } = {},
): { events: ProgressEvent[]; has_more: boolean } {
  const task = loadTaskForMutation(userId, taskId, { trashed: 'allow' })
  if (!isTracked(task)) throw new ValidationError('Not a quota')
  const limit = Math.min(Math.max(1, range.limit ?? PROGRESS_EVENTS_LIMIT), PROGRESS_EVENTS_LIMIT)
  const where = ['task_id = ?']
  const args: (string | number)[] = [taskId]
  if (range.since) {
    where.push('julianday(logged_at) >= julianday(?)')
    args.push(range.since)
  }
  if (range.until) {
    where.push('julianday(logged_at) < julianday(?)')
    args.push(range.until)
  }
  if (range.beforeId) {
    where.push('id < ?')
    args.push(range.beforeId)
  }
  const rows = getDb()
    .prepare(
      `SELECT id, delta, logged_at, source, user_id FROM progress_events
        WHERE ${where.join(' AND ')}
        ORDER BY id DESC
        LIMIT ?`,
    )
    .all(...args, limit + 1) as ProgressEvent[]
  return {
    events: rows.slice(0, limit).map((r) => ({ ...r, logged_at: normalizeIso(r.logged_at) })),
    has_more: rows.length > limit,
  }
}
