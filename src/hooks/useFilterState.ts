'use client'

import { useState, useCallback, useMemo } from 'react'
import { getTimezoneDayBoundaries } from '@/lib/format-date'
import { classifyTaskDueDate, type DueDateFilter } from '@/components/DueDateFilterBar'
import type { Task } from '@/types'

interface UseFilterStateOptions {
  tasks: Task[]
  onLabelToggle?: () => void
  timezone?: string
  initialDateFilters?: DueDateFilter[]
}

/**
 * Filter state for the dashboard filter bar.
 *
 * Supports two modes per filter type:
 * - **Include** (selected*): narrows the view to only matching tasks
 * - **Exclude** (excluded*): removes matching tasks from the view
 *
 * When both are active within the same filter type, includes are applied first
 * (narrowing the set), then excludes remove from the result.
 */
export function useFilterState({
  tasks,
  onLabelToggle,
  timezone,
  initialDateFilters,
}: UseFilterStateOptions) {
  // Include state
  const [selectedLabels, setSelectedLabels] = useState<string[]>([])
  const [selectedPriorities, setSelectedPriorities] = useState<number[]>([])
  const [selectedDateFilters, setSelectedDateFilters] = useState<DueDateFilter[]>(
    initialDateFilters ?? [],
  )
  const [attributeFilters, setAttributeFilters] = useState<Set<string>>(new Set())
  const [selectedProjects, setSelectedProjects] = useState<number[]>([])

  // Exclude state
  const [excludedLabels, setExcludedLabels] = useState<string[]>([])
  const [excludedPriorities, setExcludedPriorities] = useState<number[]>([])
  const [excludedDateFilters, setExcludedDateFilters] = useState<DueDateFilter[]>([])
  const [excludedAttributes, setExcludedAttributes] = useState<Set<string>>(new Set())
  const [excludedProjects, setExcludedProjects] = useState<number[]>([])

  // --- Include toggles ---

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

  const toggleAttribute = useCallback((key: string) => {
    setAttributeFilters((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const toggleProject = useCallback((projectId: number) => {
    setSelectedProjects((prev) =>
      prev.includes(projectId) ? prev.filter((p) => p !== projectId) : [...prev, projectId],
    )
  }, [])

  // --- Exclude toggles ---
  // Each removes the value from include (cleaning up the first click's toggle)
  // and toggles it in/out of the excluded set.

  const excludeLabel = useCallback(
    (label: string) => {
      onLabelToggle?.()
      setSelectedLabels((prev) => prev.filter((l) => l !== label))
      setExcludedLabels((prev) =>
        prev.includes(label) ? prev.filter((l) => l !== label) : [...prev, label],
      )
    },
    [onLabelToggle],
  )

  const excludePriority = useCallback((priority: number) => {
    setSelectedPriorities((prev) => prev.filter((p) => p !== priority))
    setExcludedPriorities((prev) =>
      prev.includes(priority) ? prev.filter((p) => p !== priority) : [...prev, priority],
    )
  }, [])

  const excludeDateFilter = useCallback((filter: DueDateFilter) => {
    setSelectedDateFilters((prev) => prev.filter((f) => f !== filter))
    setExcludedDateFilters((prev) =>
      prev.includes(filter) ? prev.filter((f) => f !== filter) : [...prev, filter],
    )
  }, [])

  const excludeAttribute = useCallback((key: string) => {
    setAttributeFilters((prev) => {
      const next = new Set(prev)
      next.delete(key)
      return next
    })
    setExcludedAttributes((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const excludeProject = useCallback((projectId: number) => {
    setSelectedProjects((prev) => prev.filter((p) => p !== projectId))
    setExcludedProjects((prev) =>
      prev.includes(projectId) ? prev.filter((p) => p !== projectId) : [...prev, projectId],
    )
  }, [])

  // --- Exclusive selects (also clear excludes) ---

  const exclusivePriority = useCallback((priority: number) => {
    setSelectedPriorities((prev) => (prev.length === 1 && prev[0] === priority ? [] : [priority]))
    setExcludedPriorities([])
  }, [])

  const exclusiveLabel = useCallback(
    (label: string) => {
      onLabelToggle?.()
      setSelectedLabels((prev) => (prev.length === 1 && prev[0] === label ? [] : [label]))
      setExcludedLabels([])
    },
    [onLabelToggle],
  )

  const exclusiveDateFilter = useCallback((filter: DueDateFilter) => {
    setSelectedDateFilters((prev) => (prev.length === 1 && prev[0] === filter ? [] : [filter]))
    setExcludedDateFilters([])
  }, [])

  const exclusiveAttribute = useCallback((key: string) => {
    setAttributeFilters((prev) => (prev.size === 1 && prev.has(key) ? new Set() : new Set([key])))
    setExcludedAttributes(new Set())
  }, [])

  const exclusiveProject = useCallback((projectId: number) => {
    setSelectedProjects((prev) => (prev.length === 1 && prev[0] === projectId ? [] : [projectId]))
    setExcludedProjects([])
  }, [])

  // --- Clear all ---

  const clearAllFilters = useCallback(() => {
    setSelectedLabels([])
    setSelectedPriorities([])
    setSelectedDateFilters([])
    setAttributeFilters(new Set())
    setSelectedProjects([])
    setExcludedLabels([])
    setExcludedPriorities([])
    setExcludedDateFilters([])
    setExcludedAttributes(new Set())
    setExcludedProjects([])
  }, [])

  // --- Filter logic ---
  // Includes narrow down to matching tasks. Excludes remove matching tasks.
  // When both are active, includes apply first, then excludes remove from the result.

  const filteredTasks = useMemo(() => {
    let filtered = tasks

    // Labels
    if (selectedLabels.length > 0) {
      filtered = filtered.filter((t) => t.labels.some((l) => selectedLabels.includes(l)))
    }
    if (excludedLabels.length > 0) {
      filtered = filtered.filter((t) => !t.labels.some((l) => excludedLabels.includes(l)))
    }

    // Priorities
    if (selectedPriorities.length > 0) {
      filtered = filtered.filter((t) => selectedPriorities.includes(t.priority ?? 0))
    }
    if (excludedPriorities.length > 0) {
      filtered = filtered.filter((t) => !excludedPriorities.includes(t.priority ?? 0))
    }

    // Date filters
    if ((selectedDateFilters.length > 0 || excludedDateFilters.length > 0) && timezone) {
      const now = new Date()
      const boundaries = getTimezoneDayBoundaries(timezone)
      if (selectedDateFilters.length > 0) {
        filtered = filtered.filter((t) => {
          const buckets = classifyTaskDueDate(t, now, boundaries)
          return buckets.some((b) => selectedDateFilters.includes(b))
        })
      }
      if (excludedDateFilters.length > 0) {
        filtered = filtered.filter((t) => {
          const buckets = classifyTaskDueDate(t, now, boundaries)
          return !buckets.some((b) => excludedDateFilters.includes(b))
        })
      }
    }

    // Attributes
    if (attributeFilters.size > 0) {
      filtered = filtered.filter((t) => {
        if (attributeFilters.has('recurring') && t.rrule != null) return true
        if (attributeFilters.has('custom_auto_snooze') && t.auto_snooze_minutes != null) return true
        return false
      })
    }
    if (excludedAttributes.size > 0) {
      filtered = filtered.filter((t) => {
        if (excludedAttributes.has('recurring') && t.rrule != null) return false
        if (excludedAttributes.has('custom_auto_snooze') && t.auto_snooze_minutes != null)
          return false
        return true
      })
    }

    // Projects
    if (selectedProjects.length > 0) {
      filtered = filtered.filter((t) => selectedProjects.includes(t.project_id))
    }
    if (excludedProjects.length > 0) {
      filtered = filtered.filter((t) => !excludedProjects.includes(t.project_id))
    }

    return filtered
  }, [
    tasks,
    selectedLabels,
    excludedLabels,
    selectedPriorities,
    excludedPriorities,
    selectedDateFilters,
    excludedDateFilters,
    timezone,
    attributeFilters,
    excludedAttributes,
    selectedProjects,
    excludedProjects,
  ])

  return {
    // Include state
    selectedLabels,
    selectedPriorities,
    selectedDateFilters,
    attributeFilters,
    selectedProjects,
    setSelectedProjects,
    // Include toggles
    toggleLabel,
    togglePriority,
    toggleDateFilter,
    toggleAttribute,
    toggleProject,
    // Exclude state
    excludedLabels,
    excludedPriorities,
    excludedDateFilters,
    excludedAttributes,
    excludedProjects,
    // Exclude toggles
    excludeLabel,
    excludePriority,
    excludeDateFilter,
    excludeAttribute,
    excludeProject,
    // Exclusive selects
    exclusivePriority,
    exclusiveLabel,
    exclusiveDateFilter,
    exclusiveAttribute,
    exclusiveProject,
    // Clear + filtered
    clearAllFilters,
    filteredTasks,
  }
}
