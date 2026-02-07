'use client'

import { useState, useCallback } from 'react'

export type SortOption = 'priority' | 'title' | 'age' | 'modified'

interface GroupSortState {
  [groupLabel: string]: { sort: SortOption; reversed: boolean }
}

/**
 * Session-only sort state per group header.
 * Tracks both the sort field and direction (reversed or not).
 *
 * Default directions:
 *   - priority: highest first (reversed = lowest first)
 *   - title: A-Z (reversed = Z-A)
 *   - age: newest first (reversed = oldest first)
 *   - modified: most recently modified first (reversed = least recently modified first)
 *
 * Selecting the same sort option again toggles the direction.
 * State resets on page refresh.
 */
export function useGroupSort() {
  const [sortByGroup, setSortByGroup] = useState<GroupSortState>({})

  const getSortOption = useCallback(
    (groupLabel: string): SortOption => {
      return sortByGroup[groupLabel]?.sort || 'priority'
    },
    [sortByGroup],
  )

  const getReversed = useCallback(
    (groupLabel: string): boolean => {
      return sortByGroup[groupLabel]?.reversed ?? false
    },
    [sortByGroup],
  )

  const setSortOption = useCallback((groupLabel: string, option: SortOption) => {
    setSortByGroup((prev) => {
      const current = prev[groupLabel]
      // If selecting the same sort, toggle direction
      if (current?.sort === option) {
        return { ...prev, [groupLabel]: { sort: option, reversed: !current.reversed } }
      }
      // New sort option — use default direction (not reversed)
      return { ...prev, [groupLabel]: { sort: option, reversed: false } }
    })
  }, [])

  return {
    getSortOption,
    getReversed,
    setSortOption,
  }
}
