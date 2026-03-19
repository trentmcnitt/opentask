'use client'

import { useState, useCallback } from 'react'

export type SortOption =
  | 'due_date'
  | 'priority'
  | 'title'
  | 'age'
  | 'modified'
  | 'original_due'
  | 'ai_insights'

/**
 * Local sort state for contexts without persisted preferences (e.g., project pages).
 * The dashboard uses PreferencesProvider for persisted sort instead.
 *
 * Default directions:
 *   - due_date: soonest first, no due date last (reversed = latest first)
 *   - priority: highest first (reversed = lowest first)
 *   - title: A-Z (reversed = Z-A)
 *   - age: newest first (reversed = oldest first)
 *   - modified: most recently modified first (reversed = least recently modified first)
 *
 * Selecting the same sort option again toggles the direction.
 */
export function useGroupSort() {
  const [globalSort, setGlobalSort] = useState<{ sort: SortOption; reversed: boolean }>({
    sort: 'due_date',
    reversed: false,
  })

  const setSortOption = useCallback((option: SortOption) => {
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
    sortOption: globalSort.sort,
    reversed: globalSort.reversed,
    setSortOption,
  }
}
