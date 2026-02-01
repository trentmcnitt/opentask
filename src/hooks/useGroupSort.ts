'use client'

import { useState, useCallback } from 'react'

export type SortOption = 'priority' | 'title' | 'age'

interface GroupSortState {
  [groupLabel: string]: SortOption
}

/**
 * Session-only sort state per group header.
 * Default sort is priority (highest first).
 * State resets on page refresh.
 */
export function useGroupSort() {
  const [sortByGroup, setSortByGroup] = useState<GroupSortState>({})

  const getSortOption = useCallback(
    (groupLabel: string): SortOption => {
      return sortByGroup[groupLabel] || 'priority'
    },
    [sortByGroup]
  )

  const setSortOption = useCallback((groupLabel: string, option: SortOption) => {
    setSortByGroup((prev) => ({
      ...prev,
      [groupLabel]: option,
    }))
  }, [])

  const cycleSortOption = useCallback((groupLabel: string) => {
    const current = sortByGroup[groupLabel] || 'priority'
    const next: SortOption =
      current === 'priority' ? 'title' : current === 'title' ? 'age' : 'priority'
    setSortOption(groupLabel, next)
  }, [sortByGroup, setSortOption])

  return {
    getSortOption,
    setSortOption,
    cycleSortOption,
  }
}
