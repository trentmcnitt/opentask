'use client'

import { useCallback, useEffect, useState } from 'react'
import { useFilterSectionPreference } from '@/components/PreferencesProvider'
import { useIsMobile } from '@/hooks/useIsMobile'

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
 *
 * 5. **The pin does not cross the breakpoint** (Trent, 2026-09-15: "I just need
 *    a way on mobile to be able to immediately see my tasks"). Rule 2 was
 *    written when the section was small. With Trent's filter set the chip stack
 *    wraps to roughly a dozen rows on a phone, so a `filters_expanded` he pinned
 *    at a desk put the first task of the day most of a screen down on the phone
 *    in his pocket. Below `sm` the stored pin is therefore ignored and the
 *    section starts shut.
 *
 *    A phone still gets to open it — but through a SESSION override rather than
 *    the preference, and this is the part that is easy to get wrong. Simply
 *    masking the preference (`filtersExpanded && !isMobile`) turns the toggle
 *    into a dead button on a phone: it writes `true`, the mask eats it, nothing
 *    moves. Writing through to the preference instead would be worse — opening
 *    the filters once on a phone would silently unpin them on the desktop. So
 *    the small-screen fold is session-only, and the server preference is only
 *    ever written from a wide viewport.
 *
 *    Rule 3 is untouched. A filter that is active still expands the section at
 *    every width, on a phone included: that is a guarantee about not hiding
 *    state the user cannot otherwise see, not a default.
 */
export function useFilterSection(activeFilterCount: number) {
  const { filtersExpanded, setFiltersExpanded } = useFilterSectionPreference()
  const isMobile = useIsMobile()
  // The phone's own answer to "is this pinned open", null until it is asked.
  // Never persisted — see rule 5.
  const [mobilePinned, setMobilePinned] = useState<boolean | null>(null)
  const hasActiveFilters = activeFilterCount > 0
  // Initialised from the first render's filter state so a filtered deep link
  // paints expanded rather than expanding a frame later.
  const [autoExpanded, setAutoExpanded] = useState(hasActiveFilters)

  useEffect(() => {
    setAutoExpanded(hasActiveFilters)
  }, [hasActiveFilters])

  const pinned = isMobile ? (mobilePinned ?? false) : filtersExpanded
  const expanded = pinned || autoExpanded

  const toggleExpanded = useCallback(() => {
    const next = !expanded
    if (!next) {
      // Collapsing has to drop both, or the auto-expand would immediately
      // re-open the section while filters are still active.
      setAutoExpanded(false)
    }
    if (isMobile) {
      setMobilePinned(next)
    } else {
      setFiltersExpanded(next)
    }
  }, [expanded, isMobile, setFiltersExpanded])

  return { expanded, toggleExpanded }
}
