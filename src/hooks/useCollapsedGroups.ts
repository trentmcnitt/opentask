'use client'

import { useState, useCallback } from 'react'

/**
 * Session-only collapsed state per group header.
 * Tracks which groups are collapsed as a Set of group labels.
 * State resets on page refresh.
 *
 * `defaultCollapsed` names groups that start folded (the Today view's
 * "Undated" pile); a tap on the header opens them like any other, and
 * `expand` opens one from code — used when something new lands in a folded
 * group so it doesn't vanish under the user's finger.
 */
export function useCollapsedGroups(defaultCollapsed: readonly string[] = []) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(defaultCollapsed))

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

  const expand = useCallback((label: string) => {
    setCollapsed((prev) => {
      if (!prev.has(label)) return prev
      const next = new Set(prev)
      next.delete(label)
      return next
    })
  }, [])

  return { isCollapsed, toggleCollapse, expand }
}
