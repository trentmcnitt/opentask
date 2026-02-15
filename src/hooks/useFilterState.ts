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
  const [attributeFilters, setAttributeFilters] = useState<Set<string>>(new Set())

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

  const toggleAttribute = useCallback((key: string) => {
    setAttributeFilters((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const exclusiveAttribute = useCallback((key: string) => {
    setAttributeFilters((prev) => (prev.size === 1 && prev.has(key) ? new Set() : new Set([key])))
  }, [])

  const clearAllFilters = useCallback(() => {
    setSelectedLabels([])
    setSelectedPriorities([])
    setSelectedDateFilters([])
    setAttributeFilters(new Set())
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
    if (attributeFilters.size > 0) {
      filtered = filtered.filter((t) => {
        if (attributeFilters.has('recurring') && t.rrule != null) return true
        if (attributeFilters.has('custom_auto_snooze') && t.auto_snooze_minutes != null) return true
        return false
      })
    }
    return filtered
  }, [tasks, selectedLabels, selectedPriorities, selectedDateFilters, timezone, attributeFilters])

  return {
    selectedLabels,
    selectedPriorities,
    selectedDateFilters,
    attributeFilters,
    toggleLabel,
    togglePriority,
    toggleDateFilter,
    toggleAttribute,
    exclusivePriority,
    exclusiveLabel,
    exclusiveDateFilter,
    exclusiveAttribute,
    clearAllFilters,
    filteredTasks,
  }
}
