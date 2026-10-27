/**
 * The sidebar's Dashboard count badges (2026-10-27, Trent): the overdue
 * (purple) and for-today (grey) numbers beside "Dashboard" are links to the
 * dashboard filtered to exactly those tasks — the top bar's count pills'
 * filter (`onPillFilter` in DashboardClient), so the number and the list are
 * the same set by construction.
 *
 * Off the dashboard a badge is a link to `/?filter=overdue|today`, which seeds
 * the filter on mount. ON the dashboard that param is read once per mount, so
 * a badge asks the mounted page instead, through this window event (the
 * pattern `OPEN_ADD_EVENT` uses). Unlike a pill, a badge never toggles the
 * filter off: it says "show me these", so a second click just jumps to them.
 */
export const NAV_FILTER_EVENT = 'opentask:nav-filter'

export type NavFilter = 'overdue' | 'today'

export function requestNavFilter(filter: NavFilter): void {
  window.dispatchEvent(new CustomEvent<NavFilter>(NAV_FILTER_EVENT, { detail: filter }))
}
