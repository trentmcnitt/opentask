'use client'

import { useState, useCallback } from 'react'

/**
 * Session-only collapsed state per group header.
 * Tracks which groups are collapsed as a Set of group labels.
 * State resets on page refresh.
 */
export function useCollapsedGroups() {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const isCollapsed = useCallback((label: string): boolean => collapsed.has(label), [collapsed])

  const toggleCollapse = useCallback((label: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(label)) {
        next.delete(label)
      } else {
        next.add(label)
      }
      return next
    })
  }, [])

  return { isCollapsed, toggleCollapse }
}
