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

/** The five corpus-slicing filter groups FilterBar renders as chip rows. */
export type FilterGroup = 'labels' | 'priorities' | 'dateFilters' | 'attributes' | 'projects'

export const FILTER_GROUPS: readonly FilterGroup[] = [
  'labels',
  'priorities',
  'dateFilters',
  'attributes',
  'projects',
]

/** Every filter group's current include/exclude state — the input to `applyTaskFilters`. */
export interface TaskFilterCriteria {
  selectedLabels: string[]
  excludedLabels: string[]
  selectedPriorities: number[]
  excludedPriorities: number[]
  selectedDateFilters: DueDateFilter[]
  excludedDateFilters: DueDateFilter[]
  attributeFilters: Set<string>
  excludedAttributes: Set<string>
  selectedProjects: number[]
  excludedProjects: number[]
}

interface ApplyTaskFiltersOptions {
  timezone?: string
  /**
   * Skip this one group when applying filters — the faceted-count trick
   * FilterBar's chip rows use for their counts. A row that counted over the
   * FULLY filtered set would fold its own selection into every chip's count
   * (e.g. the Today chip would only ever show tasks that are ALSO in the
   * selected project, priority, etc. — which is right for the LIST, but wrong
   * for a chip row, where the point is comparing what each chip in THIS row
   * would give). Counting over "every other group applied, this one not" is
   * the standard fix: it reflects every active filter except the row's own,
   * so a Work project filter correctly zeroes out (or reduces) the Today
   * chip's count instead of leaving it showing the whole corpus's "today"
   * count (Trent, 2026-09-23 — the "Today 3" chip stayed at 3 under the Work
   * filter even though none of Work's tasks were due today).
   */
  skipGroup?: FilterGroup
}

function filterByLabels(tasks: Task[], c: TaskFilterCriteria): Task[] {
  let filtered = tasks
  if (c.selectedLabels.length > 0) {
    filtered = filtered.filter((t) => t.labels.some((l) => c.selectedLabels.includes(l)))
  }
  if (c.excludedLabels.length > 0) {
    filtered = filtered.filter((t) => !t.labels.some((l) => c.excludedLabels.includes(l)))
  }
  return filtered
}

function filterByPriorities(tasks: Task[], c: TaskFilterCriteria): Task[] {
  let filtered = tasks
  if (c.selectedPriorities.length > 0) {
    filtered = filtered.filter((t) => c.selectedPriorities.includes(t.priority ?? 0))
  }
  if (c.excludedPriorities.length > 0) {
    filtered = filtered.filter((t) => !c.excludedPriorities.includes(t.priority ?? 0))
  }
  return filtered
}

function filterByDateFilters(tasks: Task[], c: TaskFilterCriteria, timezone?: string): Task[] {
  if (!timezone) return tasks
  if (c.selectedDateFilters.length === 0 && c.excludedDateFilters.length === 0) return tasks
  let filtered = tasks
  const now = new Date()
  const boundaries = getTimezoneDayBoundaries(timezone)
  if (c.selectedDateFilters.length > 0) {
    filtered = filtered.filter((t) => {
      const buckets = classifyTaskDueDate(t, now, boundaries)
      return buckets.some((b) => c.selectedDateFilters.includes(b))
    })
  }
  if (c.excludedDateFilters.length > 0) {
    filtered = filtered.filter((t) => {
      const buckets = classifyTaskDueDate(t, now, boundaries)
      return !buckets.some((b) => c.excludedDateFilters.includes(b))
    })
  }
  return filtered
}

function filterByAttributes(tasks: Task[], c: TaskFilterCriteria): Task[] {
  let filtered = tasks
  if (c.attributeFilters.size > 0) {
    filtered = filtered.filter((t) => {
      if (c.attributeFilters.has('recurring') && t.rrule != null) return true
      if (c.attributeFilters.has('custom_auto_snooze') && t.auto_snooze_minutes != null) return true
      return false
    })
  }
  if (c.excludedAttributes.size > 0) {
    filtered = filtered.filter((t) => {
      if (c.excludedAttributes.has('recurring') && t.rrule != null) return false
      if (c.excludedAttributes.has('custom_auto_snooze') && t.auto_snooze_minutes != null)
        return false
      return true
    })
  }
  return filtered
}

function filterByProjects(tasks: Task[], c: TaskFilterCriteria): Task[] {
  let filtered = tasks
  if (c.selectedProjects.length > 0) {
    filtered = filtered.filter((t) => c.selectedProjects.includes(t.project_id))
  }
  if (c.excludedProjects.length > 0) {
    filtered = filtered.filter((t) => !c.excludedProjects.includes(t.project_id))
  }
  return filtered
}

/**
 * The single predicate behind the dashboard's filter chips — includes narrow
 * down to matching tasks, excludes remove matching tasks, and when both are
 * active within one group the includes apply first. `useFilterState`'s own
 * `filteredTasks` calls this with every group applied; FilterBar's chip rows
 * call it once per row with that row's own group skipped (see
 * `ApplyTaskFiltersOptions.skipGroup`) — one function, reused both places, so
 * there is exactly one place that knows what a filter group does.
 */
export function applyTaskFilters(
  tasks: Task[],
  criteria: TaskFilterCriteria,
  options: ApplyTaskFiltersOptions = {},
): Task[] {
  const { timezone, skipGroup } = options
  let filtered = tasks
  if (skipGroup !== 'labels') filtered = filterByLabels(filtered, criteria)
  if (skipGroup !== 'priorities') filtered = filterByPriorities(filtered, criteria)
  if (skipGroup !== 'dateFilters') filtered = filterByDateFilters(filtered, criteria, timezone)
  if (skipGroup !== 'attributes') filtered = filterByAttributes(filtered, criteria)
  if (skipGroup !== 'projects') filtered = filterByProjects(filtered, criteria)
  return filtered
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
  // Delegates to `applyTaskFilters` — the same predicate FilterBar's chip rows
  // use for their faceted counts (with one group skipped there; every group
  // applied here).

  const criteria: TaskFilterCriteria = useMemo(
    () => ({
      selectedLabels,
      excludedLabels,
      selectedPriorities,
      excludedPriorities,
      selectedDateFilters,
      excludedDateFilters,
      attributeFilters,
      excludedAttributes,
      selectedProjects,
      excludedProjects,
    }),
    [
      selectedLabels,
      excludedLabels,
      selectedPriorities,
      excludedPriorities,
      selectedDateFilters,
      excludedDateFilters,
      attributeFilters,
      excludedAttributes,
      selectedProjects,
      excludedProjects,
    ],
  )

  const filteredTasks = useMemo(
    () => applyTaskFilters(tasks, criteria, { timezone }),
    [tasks, criteria, timezone],
  )

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
