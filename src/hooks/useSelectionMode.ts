'use client'

import { useState, useCallback } from 'react'

export interface SelectionState {
  selectedIds: Set<number>
  anchor: number | null
  isSelectionMode: boolean
}

export function useSelectionMode() {
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [anchor, setAnchor] = useState<number | null>(null)
  const [isSelectionMode, setIsSelectionMode] = useState(false)

  const toggle = useCallback((id: number) => {
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
    (id: number, orderedIds: number[]) => {
      if (anchor === null) {
        toggle(id)
        return
      }

      const anchorIdx = orderedIds.indexOf(anchor)
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
    },
    [anchor, toggle],
  )

  const selectAll = useCallback((ids: number[]) => {
    setSelectedIds(new Set(ids))
    setIsSelectionMode(ids.length > 0)
  }, [])

  const addAll = useCallback((ids: number[]) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      for (const id of ids) next.add(id)
      return next
    })
    if (ids.length > 0) setIsSelectionMode(true)
  }, [])

  const removeAll = useCallback((ids: number[]) => {
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

  return {
    selectedIds,
    anchor,
    isSelectionMode,
    toggle,
    rangeSelect,
    selectAll,
    addAll,
    removeAll,
    clear,
  }
}
