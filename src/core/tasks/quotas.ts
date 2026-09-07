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
import { isTracked } from '@/lib/track'
import type { Task } from '@/types'
import { getTasks } from './create'

/**
 * Every open quota for a user.
 *
 * Deliberately NOT ordered here. `trackedItems()` in `@/lib/slot-view` owns
 * quota order — alphabetical, so logging on one never reorders the others under
 * the user's finger (commit 9bcf03d, "frozen order") — and the dashboard's
 * Track panel already sorts through it. Ordering here too would give the two
 * views of the same eight things two different sources of truth, and SQLite's
 * `COLLATE NOCASE` and JS's `localeCompare` do not agree on accented titles.
 */
export function getQuotas(userId: number): Task[] {
  return getTasks({ userId, done: false, limit: 1000 }).filter(isTracked)
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
