'use client'

import { useState, useCallback } from 'react'

export interface SelectionState<K extends number | string = number> {
  selectedIds: Set<K>
  anchor: K | null
  isSelectionMode: boolean
}

/**
 * Selection state for a list surface. Keyed by task id by default; a surface
 * whose rows are not all tasks picks its own key type — the Reminders surface
 * selects quota prompts beside its reminders, keyed by `prompt_key` (a string,
 * since one daily quota can have several prompts), so it uses `number | string`.
 */
export function useSelectionMode<K extends number | string = number>() {
  const [selectedIds, setSelectedIds] = useState<Set<K>>(new Set())
  const [anchor, setAnchor] = useState<K | null>(null)
  const [isSelectionMode, setIsSelectionMode] = useState(false)

  const toggle = useCallback((id: K) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      // Exit selection mode if empty
      if (next.size === 0) {
        setIsSelectionMode(false)
        setAnchor(null)
      } else {
        setIsSelectionMode(true)
        setAnchor(id)
      }
      return next
    })
  }, [])

  const rangeSelect = useCallback(
    (id: K, orderedIds: K[], fallbackAnchor?: K | null) => {
      // Use the selection anchor if available, otherwise fall back to
      // the provided fallback (e.g. keyboardFocusedId). This enables
      // shift-click range selection from outside selection mode: click
      // a task to give it keyboard focus, then shift-click another to
      // select the range between them.
      const effectiveAnchor = anchor ?? fallbackAnchor ?? null
      if (effectiveAnchor === null) {
        toggle(id)
        return
      }

      const anchorIdx = orderedIds.indexOf(effectiveAnchor)
      const targetIdx = orderedIds.indexOf(id)
      if (anchorIdx === -1 || targetIdx === -1) {
        toggle(id)
        return
      }

      const start = Math.min(anchorIdx, targetIdx)
      const end = Math.max(anchorIdx, targetIdx)

      setSelectedIds((prev) => {
        const next = new Set(prev)
        for (let i = start; i <= end; i++) {
          next.add(orderedIds[i])
        }
        return next
      })
      setIsSelectionMode(true)
      setAnchor(effectiveAnchor)
    },
    [anchor, toggle],
  )

  const selectAll = useCallback((ids: K[]) => {
    setSelectedIds(new Set(ids))
    setIsSelectionMode(ids.length > 0)
  }, [])

  const addAll = useCallback((ids: K[]) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      for (const id of ids) next.add(id)
      return next
    })
    if (ids.length > 0) setIsSelectionMode(true)
  }, [])

  const removeAll = useCallback((ids: K[]) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      for (const id of ids) next.delete(id)
      if (next.size === 0) {
        setIsSelectionMode(false)
        setAnchor(null)
      }
      return next
    })
  }, [])

  const clear = useCallback(() => {
    setSelectedIds(new Set())
    setAnchor(null)
    setIsSelectionMode(false)
  }, [])

  // Select only this item (replaces selection, standard single-click behavior)
  // If this item is already the only selected item, deselect and exit selection mode
  const selectOnly = useCallback((id: K) => {
    setSelectedIds((prev) => {
      // If clicking the only selected item, deselect it and exit
      if (prev.size === 1 && prev.has(id)) {
        setAnchor(null)
        setIsSelectionMode(false)
        return new Set()
      }
      // Otherwise, select only this item
      setAnchor(id)
      setIsSelectionMode(true)
      return new Set([id])
    })
  }, [])

  return {
    selectedIds,
    anchor,
    isSelectionMode,
    toggle,
    rangeSelect,
    selectAll,
    selectOnly,
    addAll,
    removeAll,
    clear,
  }
}
