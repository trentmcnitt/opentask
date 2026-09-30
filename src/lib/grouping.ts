/**
 * The dashboard's grouping modes — the values `users.default_grouping` holds and
 * `/api/user/preferences` accepts — and the one coercion every reader applies.
 *
 * - `'slot'` — **Today**: today's tasks grouped by time slot (the §7.3 front door).
 * - `'project'` — **All**: every open task, grouped by project (Inbox, Personal,
 *   Work…), in the order Settings lists projects. Each group shows the user's
 *   `project_preview_count` rows before "Show all".
 * - `'new'` — **New**: every open task in one flat list, newest-added first, each
 *   row naming its project. The order is fixed (the `age` sort); see
 *   `effectiveSort` in `src/lib/task-grouping.ts`.
 * - `'unified'` — the flat list the AI-sort toggle and the list header's
 *   "Unified" button switch to. Not a chip in the view switch.
 *
 * History: until 2026-09-29 the switch had Today · Projects (`'project'`) · All
 * (`'time'`, everything grouped by due date). On 2026-09-29 the Projects view
 * was retired by mistake — "All" had been meant as the by-project view — and
 * `'project'` was rewritten to `'time'`. On 2026-09-30 it was restored as All,
 * and the due-date grouping went away instead. So `'time'` is now the retired
 * value: still ACCEPTED on input so an old client's PATCH doesn't 400, but
 * stored, returned and rendered as `'project'`. `runMigrations()` rewrites any
 * stored `'time'` (`restoreProjectGrouping` in `src/core/db/index.ts`).
 */
export const GROUPINGS = ['slot', 'project', 'new', 'unified'] as const

export type GroupingMode = (typeof GROUPINGS)[number]

/** What a PATCH may send: every live grouping plus the retired `'time'`. */
export const ACCEPTED_GROUPING_INPUTS: readonly string[] = [...GROUPINGS, 'time']

/**
 * Coerce a stored or submitted `default_grouping` to a grouping the dashboard can
 * render.
 *
 * - `'time'` → `'project'`: the retired due-date grouping lands on All, which
 *   is what the "All" chip showed it as.
 * - Anything else unrecognized → `'slot'`, the front door. That covers
 *   `'reminders'` (the §6 surface once persisted through this preference; it is
 *   now its own route) and `'recent'` (the short-lived "Recent" view, replaced by
 *   just-added previews, `src/lib/just-added.ts`). Those are corrected the next
 *   time the user picks a view.
 */
export function coerceGrouping(stored: unknown): GroupingMode {
  if (stored === 'time') return 'project'
  return GROUPINGS.includes(stored as GroupingMode) ? (stored as GroupingMode) : 'slot'
}

/**
 * All's per-project cap: each project group shows `project_preview_count`
 * tasks (a user preference, default 6) before "Show all". Bounds for the
 * preferences route's validation and the Settings control.
 */
export const PROJECT_PREVIEW_DEFAULT = 6
export const PROJECT_PREVIEW_MIN = 1
export const PROJECT_PREVIEW_MAX = 50
