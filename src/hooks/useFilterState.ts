'use client'

import { useState, useCallback, useMemo } from 'react'
import type { Task } from '@/types'

interface UseFilterStateOptions {
  tasks: Task[]
  onLabelToggle?: () => void
}

export function useFilterState({ tasks, onLabelToggle }: UseFilterStateOptions) {
  const [selectedLabels, setSelectedLabels] = useState<string[]>([])
  const [selectedPriorities, setSelectedPriorities] = useState<number[]>([])

  const toggleLabel = useCallback(
    (label: string) => {
      onLabelToggle?.()
      setSelectedLabels((prev) =>
        prev.includes(label) ? prev.filter((l) => l !== label) : [...prev, label],
      )
    },
    [onLabelToggle],
  )

  const togglePriority = useCallback((priority: number) => {
    setSelectedPriorities((prev) =>
      prev.includes(priority) ? prev.filter((p) => p !== priority) : [...prev, priority],
    )
  }, [])

  const clearAllFilters = useCallback(() => {
    setSelectedLabels([])
    setSelectedPriorities([])
  }, [])

  const filteredTasks = useMemo(() => {
    let filtered = tasks
    if (selectedLabels.length > 0) {
      filtered = filtered.filter((t) => t.labels.some((l) => selectedLabels.includes(l)))
    }
    if (selectedPriorities.length > 0) {
      filtered = filtered.filter((t) => selectedPriorities.includes(t.priority ?? 0))
    }
    return filtered
  }, [tasks, selectedLabels, selectedPriorities])

  return {
    selectedLabels,
    selectedPriorities,
    toggleLabel,
    togglePriority,
    clearAllFilters,
    filteredTasks,
  }
}
