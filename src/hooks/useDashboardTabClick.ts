import { useCallback } from 'react'
import { usePathname } from 'next/navigation'
import { useDefaultGrouping } from '@/components/PreferencesProvider'
import { retapWalk } from '@/lib/retap-walk'
import { PAGE_RETAP_EVENT } from '@/lib/scroll-to-top'

/**
 * The Dashboard tab's click (desktop sidebar and phone tab bar).
 *
 * Tapping it puts the view switch back on **Now** when it is on Newest
 * (Trent, 2026-09-30, when the front door was All; Now since 2026-10-14) —
 * from any page, and when already on the dashboard. The AI-sort list
 * ('unified') is left alone: it isn't one of the switch's views. Filters are
 * not touched here; a tap while already on the dashboard also fires
 * `dashboard-reset`, which clears them, turns Now's Show all off and scrolls
 * to the top.
 *
 * Returns the tab's `onClick`. On the dashboard itself the navigation is
 * cancelled (there is nowhere to go).
 */
export function useDashboardTabClick() {
  const isActive = usePathname() === '/'
  const { defaultGrouping, setDefaultGrouping, groupingLoaded } = useDefaultGrouping()
  return useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>) => {
      // Before the preferences have loaded, `defaultGrouping` is only the
      // hardcoded default, so the saved view is unknown: set Now anyway. A
      // change made before the load is kept over the loaded value
      // (`mergeLoadedPrefs`), so the load can't put Newest back.
      if (!groupingLoaded || defaultGrouping === 'new') {
        setDefaultGrouping('project')
      }
      if (isActive) {
        e.preventDefault()
        // A re-tap walks to the next place that needs you (the Reminders
        // card, the Task queue card, the task list — src/lib/retap-walk.ts);
        // with none left, the full reset and the top.
        window.dispatchEvent(new CustomEvent(PAGE_RETAP_EVENT))
        if (!retapWalk()) window.dispatchEvent(new CustomEvent('dashboard-reset'))
      }
    },
    [defaultGrouping, setDefaultGrouping, groupingLoaded, isActive],
  )
}
