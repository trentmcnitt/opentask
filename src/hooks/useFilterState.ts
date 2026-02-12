'use client'

import { useState, useCallback, useMemo } from 'react'
import { getTimezoneDayBoundaries } from '@/lib/format-date'
import { classifyTaskDueDate, type DueDateFilter } from '@/components/DueDateFilterBar'
import type { Task } from '@/types'

interface UseFilterStateOptions {
  tasks: Task[]
  onLabelToggle?: () => void
  timezone?: string
}

export function useFilterState({ tasks, onLabelToggle, timezone }: UseFilterStateOptions) {
  const [selectedLabels, setSelectedLabels] = useState<string[]>([])
  const [selectedPriorities, setSelectedPriorities] = useState<number[]>([])
  const [selectedDateFilters, setSelectedDateFilters] = useState<DueDateFilter[]>([])

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

  const toggleDateFilter = useCallback((filter: DueDateFilter) => {
    setSelectedDateFilters((prev) =>
      prev.includes(filter) ? prev.filter((f) => f !== filter) : [...prev, filter],
    )
  }, [])

  const exclusivePriority = useCallback((priority: number) => {
    setSelectedPriorities((prev) => (prev.length === 1 && prev[0] === priority ? [] : [priority]))
  }, [])

  const exclusiveLabel = useCallback(
    (label: string) => {
      onLabelToggle?.()
      setSelectedLabels((prev) => (prev.length === 1 && prev[0] === label ? [] : [label]))
    },
    [onLabelToggle],
  )

  const exclusiveDateFilter = useCallback((filter: DueDateFilter) => {
    setSelectedDateFilters((prev) => (prev.length === 1 && prev[0] === filter ? [] : [filter]))
  }, [])

  const clearAllFilters = useCallback(() => {
    setSelectedLabels([])
    setSelectedPriorities([])
    setSelectedDateFilters([])
  }, [])

  const filteredTasks = useMemo(() => {
    let filtered = tasks
    if (selectedLabels.length > 0) {
      filtered = filtered.filter((t) => t.labels.some((l) => selectedLabels.includes(l)))
    }
    if (selectedPriorities.length > 0) {
      filtered = filtered.filter((t) => selectedPriorities.includes(t.priority ?? 0))
    }
    if (selectedDateFilters.length > 0 && timezone) {
      const now = new Date()
      const boundaries = getTimezoneDayBoundaries(timezone)
      filtered = filtered.filter((t) => {
        const buckets = classifyTaskDueDate(t, now, boundaries)
        return buckets.some((b) => selectedDateFilters.includes(b))
      })
    }
    return filtered
  }, [tasks, selectedLabels, selectedPriorities, selectedDateFilters, timezone])

  return {
    selectedLabels,
    selectedPriorities,
    selectedDateFilters,
    toggleLabel,
    togglePriority,
    toggleDateFilter,
    exclusivePriority,
    exclusiveLabel,
    exclusiveDateFilter,
    clearAllFilters,
    filteredTasks,
  }
}
