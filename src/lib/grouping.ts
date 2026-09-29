/**
 * The dashboard's grouping modes — the values `users.default_grouping` holds and
 * `/api/user/preferences` accepts — and the one coercion every reader applies.
 *
 * - `'slot'` — **Today**: today's tasks grouped by time slot (the §7.3 front door).
 * - `'time'` — **All**: everything, grouped by due date.
 * - `'new'` — **New**: every open task in one flat list, newest-added first, each
 *   row naming its project. The order is fixed (the `age` sort); see
 *   `effectiveSort` in `TaskList.tsx`.
 * - `'unified'` — the flat list the AI-sort toggle and the list header's
 *   "Unified" button switch to. Not a chip in the view switch.
 *
 * `'project'` (the Projects view) was retired on 2026-09-29 (Trent: he never used
 * it; New replaced it in the switch). It is still ACCEPTED on input so an old
 * client's PATCH doesn't 400, but it is stored, returned and rendered as
 * `'time'` (All). `runMigrations()` rewrites any stored `'project'` once
 * (`retireProjectGrouping` in `src/core/db/index.ts`).
 */
export const GROUPINGS = ['slot', 'time', 'new', 'unified'] as const

export type GroupingMode = (typeof GROUPINGS)[number]

/** What a PATCH may send: every live grouping plus the retired `'project'`. */
export const ACCEPTED_GROUPING_INPUTS: readonly string[] = [...GROUPINGS, 'project']

/**
 * Coerce a stored or submitted `default_grouping` to a grouping the dashboard can
 * render.
 *
 * - `'project'` → `'time'`: the retired Projects view lands on All, the view
 *   nearest to it (everything, nothing hidden).
 * - Anything else unrecognized → `'slot'`, the front door. That covers
 *   `'reminders'` (the §6 surface once persisted through this preference; it is
 *   now its own route) and `'recent'` (the short-lived "Recent" view, replaced by
 *   just-added previews, `src/lib/just-added.ts`). Those are corrected the next
 *   time the user picks a view.
 */
export function coerceGrouping(stored: unknown): GroupingMode {
  if (stored === 'project') return 'time'
  return GROUPINGS.includes(stored as GroupingMode) ? (stored as GroupingMode) : 'slot'
}
