/**
 * The dashboard's grouping modes — the values `users.default_grouping` holds and
 * `/api/user/preferences` accepts — and the one coercion every reader applies.
 *
 * - `'project'` — **Now** (the front door, and every new user's view): open
 *   tasks grouped by project, each project showing only what is relevant now
 *   (over target, targeted today, in today's Upcoming heads-up, or undated
 *   High/Urgent) and folding the rest behind "+ N more in <Project>". "Show
 *   all" beside the switch lifts the folds for the visit — the old All. The
 *   rule and the fold: `src/lib/now-view.ts`.
 * - `'new'` — **Newest**: every open task in one flat list, newest-added first,
 *   each row naming its project. The order is fixed (the `age` sort); see
 *   `effectiveSort` in `src/lib/task-grouping.ts`.
 * - `'unified'` — the flat list the AI-sort toggle and the list header's
 *   "Unified" button switch to. Not a chip in the view switch.
 *
 * History: until 2026-09-29 the switch had Today (`'slot'`) · Projects
 * (`'project'`) · All (`'time'`, everything grouped by due date). On 2026-09-29
 * the Projects view was retired by mistake and `'project'` rewritten to
 * `'time'`; on 2026-09-30 it came back as All and the due-date grouping went
 * away. On 2026-10-14 All became Now and the separate Today view — today's
 * tasks by time slot (§7.3) — was dropped (Trent: "drop the separate Today
 * view"): Now answers "what now" itself, grouped by project. So `'time'` and
 * `'slot'` are both retired values: still ACCEPTED on input so an old
 * client's PATCH doesn't 400, but stored, returned and rendered as
 * `'project'`. `runMigrations()` rewrites any stored one
 * (`restoreProjectGrouping` in `src/core/db/index.ts`).
 */
export const GROUPINGS = ['project', 'new', 'unified'] as const

export type GroupingMode = (typeof GROUPINGS)[number]

/** Retired groupings: accepted on input, stored and returned as `'project'`. */
export const RETIRED_GROUPINGS: readonly string[] = ['slot', 'time']

/** What a PATCH may send: every live grouping plus the retired ones. */
export const ACCEPTED_GROUPING_INPUTS: readonly string[] = [...GROUPINGS, ...RETIRED_GROUPINGS]

/**
 * Coerce a stored or submitted `default_grouping` to a grouping the dashboard can
 * render. Anything that is not a live grouping lands on `'project'` (Now), the
 * front door: the retired `'slot'` (Today) and `'time'` (due-date All), and
 * anything older — `'reminders'` (the §6 surface once persisted through this
 * preference; it is now its own route) and `'recent'` (the short-lived
 * "Recent" view, replaced by the Just now card, `src/lib/just-added.ts`).
 */
export function coerceGrouping(stored: unknown): GroupingMode {
  return GROUPINGS.includes(stored as GroupingMode) ? (stored as GroupingMode) : 'project'
}

/**
 * Show all's per-project cap: with Now's folds lifted, each project group
 * shows `project_preview_count` tasks (a user preference, default 6) before
 * "Show all N". Bounds for the
 * preferences route's validation and the Settings control.
 */
export const PROJECT_PREVIEW_DEFAULT = 6
export const PROJECT_PREVIEW_MIN = 1
export const PROJECT_PREVIEW_MAX = 50
