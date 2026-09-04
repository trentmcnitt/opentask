'use client'

import { useCallback, useEffect, useState } from 'react'
import { useFilterSectionPreference } from '@/components/PreferencesProvider'

/**
 * Expand/collapse state for the dashboard's filter-chip section (REDESIGN-V03 §7.3).
 *
 * The rules, in full — they are not obvious from the two booleans below:
 *
 * 1. **Collapsed by default**, on every view and every viewport. §7.3's target
 *    is "opening the app answers 'what now' without scanning", and on a phone
 *    the chip rows ate roughly half the viewport before the first task.
 * 2. **The user's explicit choice sticks.** Opening the section writes
 *    `filters_expanded` to the server preferences (same mechanism as grouping
 *    and sort), so it survives reloads and follows the user across devices.
 * 3. **An active filter is never invisible.** Whenever a filter is active the
 *    section auto-expands — including on load, which is what makes deep links
 *    like `?filter=overdue` and `?project=3` land on a visible, obviously
 *    filtered view instead of a silently shortened list. The toggle chip also
 *    carries a count badge ("Filters · 2") whenever filters are active, so even
 *    if the user then collapses the section by hand, the fact that a filter is
 *    narrowing the list stays on screen (the "Showing N of M · Clear filter"
 *    banner below the bar is the second layer of that guarantee).
 * 4. **Clearing all filters releases the auto-expand**, dropping the section
 *    back to the user's own preference — so a filter session doesn't silently
 *    convert the default into "expanded forever".
 *
 * The auto-expand is deliberately session state, not a preference: it describes
 * the current view, not what the user wants the dashboard to look like.
 */
export function useFilterSection(activeFilterCount: number) {
  const { filtersExpanded, setFiltersExpanded } = useFilterSectionPreference()
  const hasActiveFilters = activeFilterCount > 0
  // Initialised from the first render's filter state so a filtered deep link
  // paints expanded rather than expanding a frame later.
  const [autoExpanded, setAutoExpanded] = useState(hasActiveFilters)

  useEffect(() => {
    setAutoExpanded(hasActiveFilters)
  }, [hasActiveFilters])

  const expanded = filtersExpanded || autoExpanded

  const toggleExpanded = useCallback(() => {
    if (expanded) {
      // Collapsing has to drop both, or the auto-expand would immediately
      // re-open the section while filters are still active.
      setAutoExpanded(false)
      setFiltersExpanded(false)
    } else {
      setFiltersExpanded(true)
    }
  }, [expanded, setFiltersExpanded])

  return { expanded, toggleExpanded }
}
