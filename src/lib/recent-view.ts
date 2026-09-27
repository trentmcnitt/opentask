/**
 * The dashboard's "Recent" view (`default_grouping === 'recent'`).
 *
 * Why it exists: after a quick add (typed, dictated or AI-assisted) the
 * question is "did it land, and did the AI enrich it properly?" — which used
 * to mean switching the sort to "Date added" and then switching it back. The
 * Recent view answers that on its own: one flat list of what was added in the
 * last 7 days, newest first, across every project, each row naming its
 * project and how long ago it was added.
 *
 * The window is a rolling 7 × 24 hours from now, not seven calendar days: a
 * task added at 11pm last Sunday is either in or out regardless of the
 * viewer's timezone, and the boundary does not jump at midnight.
 *
 * The slice is the same population every other view draws from — open tasks,
 * no reminders and no quotas (`visibleTasks` in `DashboardClient`) — with the
 * filter bar applied on top. Quick add never produces a reminder or a quota
 * (AI enrichment does not set `is_reminder` or `is_tracked`), so excluding them
 * does not hide a quick add from this view.
 */
import type { Task } from '@/types'

export const RECENT_WINDOW_DAYS = 7
const RECENT_WINDOW_MS = RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000

/**
 * The Recent view's group label. A real word rather than a `_unified`-style
 * sentinel: it is never shown as a heading (the view is one flat list), but the
 * clipboard copy (Cmd+C) prints each group's label as its header.
 */
export const RECENT_GROUP_LABEL = 'Recently added'

/**
 * Tasks created within the last 7 days, newest first.
 *
 * Ties on `created_at` (two adds in the same millisecond, or a bulk import)
 * break by id, higher first — ids are assigned in insert order, so this is
 * still "newest first". A task added exactly 7 days ago is still in.
 */
export function selectRecentTasks(tasks: Task[], now: Date = new Date()): Task[] {
  const cutoff = now.getTime() - RECENT_WINDOW_MS
  return tasks
    .filter((t) => {
      const created = Date.parse(t.created_at)
      return !Number.isNaN(created) && created >= cutoff
    })
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id)
}
