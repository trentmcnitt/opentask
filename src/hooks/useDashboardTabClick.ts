import { useCallback } from 'react'
import { usePathname } from 'next/navigation'
import { useDefaultGrouping } from '@/components/PreferencesProvider'

/**
 * The Dashboard tab's click (desktop sidebar and phone tab bar).
 *
 * Tapping it puts the view switch back on **All** when it is on Today or
 * Newest (Trent, 2026-09-30) — from any page, and when already on the
 * dashboard. The AI-sort list ('unified') is left alone: it isn't one of the
 * switch's three views. Filters are not touched here; a tap while already on
 * the dashboard also fires `dashboard-reset`, which clears them and scrolls
 * to the top, as it always has.
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
      // hardcoded default, so the saved view is unknown: set All anyway. A
      // change made before the load is kept over the loaded value
      // (`mergeLoadedPrefs`), so the load can't put Today back.
      if (!groupingLoaded || defaultGrouping === 'slot' || defaultGrouping === 'new') {
        setDefaultGrouping('project')
      }
      if (isActive) {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('dashboard-reset'))
      }
    },
    [defaultGrouping, setDefaultGrouping, groupingLoaded, isActive],
  )
}
