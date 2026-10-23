/**
 * THE TASKS-CARD DEEP LINK (2026-10-22, the deadlines nag): `/?tasks=<kind>`
 * opens the dashboard with the Tasks card's pager on that task segment —
 * `/?tasks=deadlines` is the deadlines page, what tapping the deadlines nag
 * opens (Web Push `data.url`; the iOS and Mac apps load the same path,
 * `DeepLinkRouter.notificationDeadlinesPath`). Any segment kind works
 * (`/?tasks=days`, `/?tasks=queue_today`); one the card isn't showing today
 * is consumed and ignored.
 *
 * Read once by `DashboardTasksPanel` and then stripped from the URL. Pure
 * here, so the contract is tested without a browser.
 */

export const TASKS_PANEL_PARAM = 'tasks'

/** The web path that opens the Tasks card on `kind`. */
export function tasksPanelPath(kind: string): string {
  return `/?${TASKS_PANEL_PARAM}=${encodeURIComponent(kind)}`
}

/**
 * The index of the card page the link asks for, or null when the link names
 * no page shown today (or there is no link). `pageKeys` are the card's page
 * keys (`segmentKey`: `tasks:<kind>`).
 */
export function tasksPanelLinkIndex(search: string, pageKeys: string[]): number | null {
  const kind = new URLSearchParams(search).get(TASKS_PANEL_PARAM)
  if (!kind) return null
  const index = pageKeys.indexOf(`tasks:${kind}`)
  return index >= 0 ? index : null
}

/** `search` without the link's param (the rest of the query kept), for `history.replaceState`. */
export function withoutTasksPanelParam(search: string): string {
  const params = new URLSearchParams(search)
  params.delete(TASKS_PANEL_PARAM)
  const rest = params.toString()
  return rest ? `?${rest}` : ''
}
