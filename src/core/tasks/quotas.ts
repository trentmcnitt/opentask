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
  /** Closed periods that fell short of it (including a missed one recorded as 0). */
  periods_missed: number
  /** Met periods in a row, counting back from the most recent closed one. */
  current_streak: number
  /** The longest run of met periods in a row, ever. */
  longest_streak: number
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
  }
}
