'use client'

import { useState, useCallback } from 'react'

export type SortOption = 'due_date' | 'priority' | 'title' | 'age' | 'modified'

/**
 * Dashboard-level sort state shared across all group headers.
 * Tracks both the sort field and direction (reversed or not).
 *
 * Default directions:
 *   - due_date: soonest first, no due date last (reversed = latest first)
 *   - priority: highest first (reversed = lowest first)
 *   - title: A-Z (reversed = Z-A)
 *   - age: newest first (reversed = oldest first)
 *   - modified: most recently modified first (reversed = least recently modified first)
 *
 * Selecting the same sort option again toggles the direction.
 * Changing sort on any group header updates all groups.
 * State resets on page refresh.
 */
export function useGroupSort() {
  const [globalSort, setGlobalSort] = useState<{ sort: SortOption; reversed: boolean }>({
    sort: 'due_date',
    reversed: false,
  })

  const getSortOption = useCallback(
    (_groupLabel: string): SortOption => {
      return globalSort.sort
    },
    [globalSort],
  )

  const getReversed = useCallback(
    (_groupLabel: string): boolean => {
      return globalSort.reversed
    },
    [globalSort],
  )

  const setSortOption = useCallback((_groupLabel: string, option: SortOption) => {
    setGlobalSort((prev) => {
      // If selecting the same sort, toggle direction
      if (prev.sort === option) {
        return { sort: option, reversed: !prev.reversed }
      }
      // New sort option — use default direction (not reversed)
      return { sort: option, reversed: false }
    })
  }, [])

  return {
    getSortOption,
    getReversed,
    setSortOption,
  }
}
