/**
 * SHOW IN LIST (Trent, 2026-10-30): the queue row bubble's second button, next
 * to Open. It takes the user from a task segment's row to the same task in the
 * dashboard's task list: the list switches to All (with the modes on), scrolls
 * to the row and flashes it. If a filter or search hides the row, a toast says
 * so and offers to clear it — it never lands silently somewhere else.
 *
 * On the dashboard the bubble asks the list directly (`SHOW_IN_LIST_EVENT`,
 * heard by `useShowInList`); on /reminders, where there is no list, it opens
 * the dashboard with `?task=<id>&show=1`, which the dashboard's `?task=`
 * effect hands to the same hook.
 *
 * EVERY ROW BUBBLE (Trent, 2026-10-31: "there's no 'show in list' like there
 * is for tasks"): Show in list lands where the item lives, with the same
 * scroll and flash.
 * - a task → the dashboard's list, All (above);
 * - a quota (a quota prompt's bubble, on the dashboard's Reminders card and on
 *   /reminders) → its chip on the Quotas tab (`/quotas?quota=<id>`, the
 *   widget's deep link: unfolds its cluster, scrolls, flashes);
 * - a reminder (the dashboard Reminders card's bubble) → its row in its
 *   period on the Reminders tab (`/reminders?reminder=<id>`, the same).
 * A bubble already on the item's own page has none (the Quotas tab's and the
 * dashboard Quotas section's chip bubbles: the chip is right there).
 */

/** The window event the dashboard's list listens for; `detail` is the task id. */
export const SHOW_IN_LIST_EVENT = 'show-in-list'

/** The dashboard link that shows a task in the list (from another page). */
export function showInListHref(taskId: number): string {
  return `/?task=${taskId}&show=1`
}

/** Ask the dashboard's list (already on screen) to show a task. */
export function requestShowInList(taskId: number): void {
  window.dispatchEvent(new CustomEvent<number>(SHOW_IN_LIST_EVENT, { detail: taskId }))
}

/** The toast's words for a row the list's narrowing hides. */
export function hiddenByNarrowingMessage(title: string, search: boolean): string {
  return `“${title}” is hidden by your ${search ? 'search' : 'filters'}`
}

/** A quota's chip on the Quotas tab: unfolded, scrolled to, flashed (`QuotasSummary`). */
export function quotaInListHref(quotaId: number): string {
  return `/quotas?quota=${quotaId}`
}

/** A reminder's row in its period on the Reminders tab, scrolled to and flashed (`RemindersView`). */
export function reminderInListHref(reminderId: number): string {
  return `/reminders?reminder=${reminderId}`
}
