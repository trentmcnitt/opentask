import { useCallback } from 'react'
import { usePathname } from 'next/navigation'
import { retapPage } from '@/lib/scroll-to-top'

/**
 * RULE SEARCH-RETAP-CLEARS: A tap on the current page's own tab (phone
 *   bar or desktop sidebar) while its search holds text clears the
 *   search and does nothing else. With no search text the re-tap walks
 *   to what needs you, else scrolls to the top. Nothing else is reset
 *   by a tab.
 * Why: The tab is the nearest 'back to normal' control under the thumb.
 * Ruling: Trent 2026-11-12: "tapping the tab bar at the bottom (if you're tapping the
 *   exact same bar) should clear the search." The rest: Trent 2026-10-29: "No filters or
 *   anything should be reset by tapping a tab".
 */
/**
 * A nav link's click (phone tab bar, desktop sidebar): on its own page there
 * is nowhere to go, so the navigation is cancelled and:
 *
 * 1. WITH A SEARCH ACTIVE, THE TAP CLEARS IT, and does only that (Trent,
 *    2026-11-12: "tapping the tab bar at the bottom (if you're tapping the
 *    exact same bar) should clear the search. If you search on the dashboard
 *    and you press the Dashboard tab, it should clear the search. Likewise
 *    for Reminders and Quotas"). The page's search bar answers
 *    `TAB_RETAP_SEARCH_EVENT` (`SearchBar`); a page with no search bar, or
 *    an empty one, lets the tap through.
 * 2. Otherwise the page goes to the next place that needs you, else the top
 *    (`retapPage`).
 *
 * Only on the tab's own page — on a page below it the link still navigates up
 * to it. Every tab alike, the Dashboard's too. Nothing else is reset: filters,
 * the view and selection all stay (Trent, 2026-10-29: "No filters or anything
 * should be reset by tapping a tab" — the search is the one exception, his
 * ruling of 11-12).
 */
export function useTabRetap() {
  const pathname = usePathname()
  return useCallback(
    (href: string) => (e: React.MouseEvent<HTMLAnchorElement>) => {
      if (pathname !== href) return
      e.preventDefault()
      if (clearActiveSearch()) return
      retapPage()
    },
    [pathname],
  )
}

/**
 * Asked of the page's search bar on a re-tap of its tab: a bar holding text
 * clears itself and cancels the event (`preventDefault`), which is the answer
 * "that was the tap's whole job".
 */
export const TAB_RETAP_SEARCH_EVENT = 'tab-retap-search'

/**
 * True when a search bar cleared its text for this tap. Also how a search
 * result's tap ends the search before going to its item (`DashboardClient`).
 */
export function clearActiveSearch(): boolean {
  return !window.dispatchEvent(new CustomEvent(TAB_RETAP_SEARCH_EVENT, { cancelable: true }))
}
