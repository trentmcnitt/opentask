'use client'

import { useState, useEffect, useCallback, useMemo, useRef, Suspense } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter, useSearchParams } from 'next/navigation'
import { TaskList, buildTaskGroups, sortTasks } from '@/components/TaskList'
import type { GroupingMode } from '@/components/TaskList'
import { useGroupSort, type SortOption } from '@/hooks/useGroupSort'
import { useCollapsedGroups } from '@/hooks/useCollapsedGroups'
import { useKeyboardNavigation } from '@/hooks/useKeyboardNavigation'
import { useTimezone } from '@/hooks/useTimezone'
import { Header } from '@/components/Header'
import { QuickAdd } from '@/components/QuickAdd'
import { FilterBar } from '@/components/FilterBar'
import { AiControlArea } from '@/components/AiControlArea'
import { SelectionProvider, useSelection } from '@/components/SelectionProvider'
import { SelectionActionSheet } from '@/components/SelectionActionSheet'
import { SnoozeAllFab } from '@/components/SnoozeAllFab'
import { useQuickActionShortcut } from '@/hooks/useQuickActionShortcut'
import { showToast } from '@/lib/toast'
import dynamic from 'next/dynamic'

const QuickActionPopover = dynamic(() =>
  import('@/components/QuickActionPopover').then((mod) => ({ default: mod.QuickActionPopover })),
)
const KeyboardShortcutsDialog = dynamic(() =>
  import('@/components/KeyboardShortcutsDialog').then((mod) => ({
    default: mod.KeyboardShortcutsDialog,
  })),
)
const BatchUndoDialog = dynamic(() =>
  import('@/components/BatchUndoDialog').then((mod) => ({ default: mod.BatchUndoDialog })),
)
const ProjectPickerSheet = dynamic(() =>
  import('@/components/ProjectPickerSheet').then((mod) => ({ default: mod.ProjectPickerSheet })),
)

import { useSnoozePreferences, useDefaultGrouping } from '@/components/PreferencesProvider'
import { useProjects } from '@/components/ProjectsProvider'
import type { Task, Project } from '@/types'
import type { QuickActionPanelChanges } from '@/components/QuickActionPanel'
import { useTaskActions } from '@/hooks/useTaskActions'
import type { ListTaskActionsReturn } from '@/hooks/useTaskActions'
import { useUndoRedoShortcuts } from '@/hooks/useUndoRedoShortcuts'
import { useFilterState } from '@/hooks/useFilterState'
import { useTaskCounts } from '@/hooks/useTaskCounts'
import { useSnoozeOverdue } from '@/hooks/useSnoozeOverdue'
import { classifyTaskDueDate, type DueDateFilter } from '@/components/DueDateFilterBar'
import { getTimezoneDayBoundaries } from '@/lib/format-date'
import { taskWord } from '@/lib/utils'
import { useAiInsights, type UseAiInsightsReturn } from '@/hooks/useAiInsights'
import { useAiMode, type AiMode } from '@/hooks/useAiMode'
import { useInsightsData, type UseInsightsDataReturn } from '@/hooks/useInsightsData'
import { useDashboardKeyboard } from '@/hooks/useDashboardKeyboard'
import { useExitModes } from '@/hooks/useExitModes'
import { useSyncStream } from '@/hooks/useSyncStream'
import type { FormattedTask } from '@/lib/format-task'

interface DashboardClientProps {
  initialTasks?: FormattedTask[]
}

export default function DashboardClient({ initialTasks }: DashboardClientProps) {
  return (
    <Suspense>
      <SelectionProvider>
        <HomeContent initialTasks={initialTasks} />
      </SelectionProvider>
    </Suspense>
  )
}

function useFetchData(router: ReturnType<typeof useRouter>, initialTasks?: FormattedTask[]) {
  const [tasks, setTasks] = useState<Task[]>(initialTasks ?? [])
  const [loading, setLoading] = useState(initialTasks === undefined)
  const [error, setError] = useState<string | null>(null)

  const fetchTasks = useCallback(async () => {
    try {
      const res = await fetch('/api/tasks?limit=500')
      if (res.status === 401) {
        router.push('/login')
        return
      }
      if (!res.ok) throw new Error('Failed to fetch tasks')
      const data = await res.json()
      setTasks(data.data?.tasks || [])
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [router])

  return {
    tasks,
    setTasks,
    loading,
    setLoading,
    error,
    setError,
    fetchTasks,
  }
}

/**
 * Dashboard-specific wrapper around the shared useTaskActions hook.
 * Adds handleQuickAdd which is dashboard-only (not needed by project or task detail pages).
 */
function useDashboardActions(
  fetchTasks: () => Promise<void>,
  tasks: Task[],
  setTasks: React.Dispatch<React.SetStateAction<Task[]>>,
  onViewTask: (task: Task) => void,
): ListTaskActionsReturn & { handleQuickAdd: (title: string) => Promise<void> } {
  const actions = useTaskActions({
    mode: 'list',
    onRefresh: fetchTasks,
    tasks,
    setTasks,
  }) as ListTaskActionsReturn

  const handleQuickAdd = useCallback(
    async (title: string) => {
      try {
        const res = await fetch('/api/tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title }),
        })
        if (!res.ok) throw new Error('Failed to create task')
        const { data: task } = await res.json()
        fetchTasks()
        showToast({
          message: 'Task added',
          type: 'success',
          action: { label: 'View', onClick: () => onViewTask(task) },
        })
      } catch {
        showToast({ message: 'Failed to add task', type: 'error' })
      }
    },
    [fetchTasks, onViewTask],
  )

  return { ...actions, handleQuickAdd }
}

function useBulkActions(
  selection: ReturnType<typeof useSelection>,
  fetchTasks: () => Promise<void>,
  handleUndo: () => Promise<void>,
  setShowProjectPicker: (show: boolean) => void,
  setSearchQuery: (q: string | null) => void,
  setSearchResults: (tasks: Task[]) => void,
) {
  const bulkAction = async (endpoint: string, body: Record<string, unknown>) => {
    const count = selection.selectedIds.size
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error('Bulk action failed')
      const responseData = await res.json()
      const tasksSkipped = responseData.data?.tasks_skipped ?? 0
      const tasksAffected = responseData.data?.tasks_affected ?? count
      selection.clear()
      fetchTasks()
      const skippedMsg = tasksSkipped > 0 ? ` (skipped ${tasksSkipped} high/urgent)` : ''
      showToast({
        message: `${tasksAffected} ${taskWord(tasksAffected)} updated${skippedMsg}`,
        type: 'success',
        action: { label: 'Undo', onClick: handleUndo },
      })
    } catch {
      showToast({ message: 'Action failed', type: 'error' })
    }
  }

  const bulkSnoozeRelative = async (deltaMinutes: number) => {
    try {
      const res = await fetch('/api/tasks/bulk/snooze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ids: [...selection.selectedIds],
          delta_minutes: deltaMinutes,
        }),
      })
      if (!res.ok) throw new Error('Bulk snooze failed')
      const responseData = await res.json()
      const tasksAffected = responseData.data?.tasks_affected ?? 0
      const tasksSkipped = responseData.data?.tasks_skipped ?? 0
      selection.clear()
      fetchTasks()
      const skippedMsg = tasksSkipped > 0 ? ` (skipped ${tasksSkipped} high/urgent)` : ''
      showToast({
        message: `${tasksAffected} ${taskWord(tasksAffected)} snoozed${skippedMsg}`,
        type: 'success',
        action: { label: 'Undo', onClick: handleUndo },
      })
    } catch {
      showToast({ message: 'Snooze failed', type: 'error' })
    }
  }

  const bulkDelete = async () => {
    const count = selection.selectedIds.size
    try {
      const res = await fetch('/api/tasks/bulk/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [...selection.selectedIds] }),
      })
      if (!res.ok) throw new Error('Delete failed')
      selection.clear()
      fetchTasks()
      showToast({
        message: `${count} ${taskWord(count)} deleted`,
        type: 'success',
        action: { label: 'Undo', onClick: handleUndo },
      })
    } catch {
      showToast({ message: 'Delete failed', type: 'error' })
    }
  }

  const handleBulkMoveToProject = async (projectId: number) => {
    const count = selection.selectedIds.size
    setShowProjectPicker(false)
    try {
      const res = await fetch('/api/tasks/bulk/edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ids: [...selection.selectedIds],
          changes: { project_id: projectId },
        }),
      })
      if (!res.ok) throw new Error('Move failed')
      selection.clear()
      fetchTasks()
      showToast({
        message: `${count} ${taskWord(count)} moved`,
        type: 'success',
        action: { label: 'Undo', onClick: handleUndo },
      })
    } catch {
      showToast({ message: 'Move failed', type: 'error' })
    }
  }

  const handleSearch = async (query: string) => {
    selection.clear() // Clear selection when search changes
    setSearchQuery(query)
    try {
      const res = await fetch(`/api/tasks?search=${encodeURIComponent(query)}&limit=500`)
      if (!res.ok) return
      const data = await res.json()
      setSearchResults(data.data?.tasks || [])
    } catch {
      // Silent fail
    }
  }

  return { bulkAction, bulkSnoozeRelative, bulkDelete, handleBulkMoveToProject, handleSearch }
}

function HomeContent({ initialTasks }: { initialTasks?: FormattedTask[] }) {
  const { status } = useSession()
  const router = useRouter()
  const searchParams = useSearchParams()
  const selection = useSelection()
  const timezone = useTimezone()
  const data = useFetchData(router, initialTasks)
  const { tasks, setTasks, loading, error, setError, setLoading, fetchTasks } = data
  const { projects, refreshProjects } = useProjects()
  const handleViewTask = useCallback((task: Task) => {
    setFocusedTask(task)
    setQuickActionOpen(true)
  }, [])
  const refreshAll = useCallback(async () => {
    await fetchTasks()
    refreshProjects()
  }, [fetchTasks, refreshProjects])
  useSyncStream(refreshAll)
  const actions = useDashboardActions(refreshAll, tasks, setTasks, handleViewTask)

  const handleQuickActionDelete = useCallback(
    async (taskId: number) => {
      try {
        const res = await fetch(`/api/tasks/${taskId}`, { method: 'DELETE' })
        if (!res.ok) throw new Error('Failed to delete')
        refreshAll()
        showToast({
          message: 'Task moved to trash',
          type: 'success',
          action: { label: 'Undo', onClick: actions.handleUndo },
        })
      } catch {
        showToast({ message: 'Delete failed', type: 'error' })
      }
    },
    [refreshAll, actions.handleUndo],
  )

  const handleReprocess = useCallback(
    async (taskId: number) => {
      // Optimistic update: swap ai-failed → ai-to-process (triggers processing animation)
      setTasks((prev) =>
        prev.map((t) =>
          t.id === taskId
            ? { ...t, labels: t.labels.map((l) => (l === 'ai-failed' ? 'ai-to-process' : l)) }
            : t,
        ),
      )
      try {
        const res = await fetch(`/api/tasks/${taskId}/reprocess`, { method: 'POST' })
        if (!res.ok) throw new Error('Reprocess failed')
        showToast({ message: 'Retrying AI enrichment...' })
      } catch {
        fetchTasks() // Revert on failure
        showToast({ message: 'Failed to retry enrichment', type: 'error' })
      }
    },
    [setTasks, fetchTasks],
  )
  useUndoRedoShortcuts(actions.handleUndoRef, actions.handleRedoRef)
  const { defaultSnoozeOption, morningTime } = useSnoozePreferences()

  const [showProjectPicker, setShowProjectPicker] = useState(false)
  const [focusedTask, setFocusedTask] = useState<Task | null>(null)
  const [quickActionOpen, setQuickActionOpen] = useState(false)
  const [showShortcutsDialog, setShowShortcutsDialog] = useState(false)
  const [createPanelOpen, setCreatePanelOpen] = useState(false)
  const [batchDialogOpen, setBatchDialogOpen] = useState(false)
  const [batchDialogMode, setBatchDialogMode] = useState<'undo' | 'redo'>('undo')
  const bulkSheetOpenRef = useRef<(() => void) | null>(null)
  const searchFocusRef = useRef<(() => void) | null>(null)

  // Track when the CreateTaskPanel modal (in AppLayout) is open so we can disable keyboard shortcuts
  useEffect(() => {
    const handler = (e: Event) => setCreatePanelOpen((e as CustomEvent).detail.open)
    window.addEventListener('create-panel-state', handler)
    return () => window.removeEventListener('create-panel-state', handler)
  }, [])

  // Keyboard navigation state
  const [keyboardFocusedId, setKeyboardFocusedId] = useState<number | null>(null)

  // Sort state - lifted here so keyboard navigation can use the same order as display
  const { sortOption, reversed, setSortOption } = useGroupSort()
  const { isCollapsed, toggleCollapse } = useCollapsedGroups()

  useQuickActionShortcut(focusedTask, setQuickActionOpen, quickActionOpen, {
    isSelectionMode: selection.isSelectionMode,
    selectedCount: selection.selectedIds.size,
    openBulkSheet: () => bulkSheetOpenRef.current?.(),
  })
  const { defaultGrouping: grouping, setDefaultGrouping } = useDefaultGrouping()

  // Track the non-unified grouping so we can restore it when leaving unified view
  // (whether triggered by AI sort auto-switch or manual unified toggle).
  const prevNonUnifiedGrouping = useRef<GroupingMode | null>(null)
  const prevSortOption = useRef(sortOption)

  useEffect(() => {
    const wasAiSort = prevSortOption.current === 'ai_insights'
    const isAiSort = sortOption === 'ai_insights'
    prevSortOption.current = sortOption

    if (!wasAiSort && isAiSort) {
      // Entering AI sort: save current grouping and switch to unified
      prevNonUnifiedGrouping.current = grouping
      if (grouping !== 'unified') setDefaultGrouping('unified')
    } else if (wasAiSort && !isAiSort && prevNonUnifiedGrouping.current) {
      // Leaving AI sort: restore previous grouping
      setDefaultGrouping(prevNonUnifiedGrouping.current)
      prevNonUnifiedGrouping.current = null
    }
  }, [sortOption, grouping, setDefaultGrouping])

  const [searchQuery, setSearchQuery] = useState<string | null>(null)
  const [searchResults, setSearchResults] = useState<Task[]>([])

  const baseTasks = searchQuery ? searchResults : tasks
  const onLabelToggle = useCallback(() => selection.clear(), [selection])

  // Support ?filter=overdue from notification links — read once, then clear from URL
  const filterParamProcessed = useRef(false)
  const initialDateFilters = useMemo(() => {
    if (filterParamProcessed.current) return undefined
    filterParamProcessed.current = true
    const filter = searchParams.get('filter')
    if (filter === 'overdue') return ['overdue'] as DueDateFilter[]
    return undefined
  }, [searchParams])
  useEffect(() => {
    if (searchParams.get('filter')) {
      router.replace('/', { scroll: false })
    }
  }, [searchParams, router])

  // Support ?task=<id> from notification taps — open QuickActionPanel modal for the task
  const taskParamProcessed = useRef(false)
  useEffect(() => {
    if (taskParamProcessed.current || loading) return
    const taskIdParam = searchParams.get('task')
    if (!taskIdParam) return
    taskParamProcessed.current = true
    const taskId = parseInt(taskIdParam, 10)
    if (isNaN(taskId)) return
    const task = tasks.find((t) => t.id === taskId)
    if (task) {
      handleViewTask(task)
    }
    router.replace('/', { scroll: false })
  }, [searchParams, loading, tasks, handleViewTask, router])

  const {
    selectedLabels,
    selectedPriorities,
    selectedDateFilters,
    attributeFilters,
    selectedProjects,
    setSelectedProjects,
    toggleLabel,
    togglePriority,
    toggleDateFilter,
    toggleAttribute,
    toggleProject,
    excludedLabels,
    excludedPriorities,
    excludedDateFilters,
    excludedAttributes,
    excludedProjects,
    excludeLabel,
    excludePriority,
    excludeDateFilter,
    excludeAttribute,
    excludeProject,
    exclusivePriority,
    exclusiveLabel,
    exclusiveDateFilter,
    exclusiveAttribute,
    exclusiveProject,
    clearAllFilters,
    filteredTasks: displayTasks,
  } = useFilterState({
    tasks: baseTasks,
    onLabelToggle,
    timezone,
    initialDateFilters,
  })

  // Support ?project=<id> from sidebar/project list links — set project filter, then clear URL.
  // Uses useEffect (not useMemo+ref) because sidebar links navigate within the already-mounted dashboard.
  useEffect(() => {
    const projectParam = searchParams.get('project')
    if (!projectParam) return
    const projectId = parseInt(projectParam, 10)
    if (!isNaN(projectId)) {
      setSelectedProjects([projectId])
    }
    router.replace('/', { scroll: false })
  }, [searchParams, router, setSelectedProjects])

  // AI mode: Off / On toggle + feature preferences
  const {
    mode: aiMode,
    setMode: setAiMode,
    showInsights,
    setShowInsights,
    wnCommentaryUnfiltered,
    setWnCommentaryUnfiltered,
    wnHighlight,
    setWnHighlight,
    insightsSignalChips,
    setInsightsSignalChips,
    insightsScoreChips,
    setInsightsScoreChips,
  } = useAiMode()

  // AI enrichment: true when any task has the ai-to-process label
  const enrichmentActive = tasks.some((t) => t.labels.includes('ai-to-process'))

  // AI What's Next: fetch recommendations and resolve against current task list
  const aiInsights = useAiInsights(baseTasks)

  // AI Insights: fetch/generate insights results
  const insightsData = useInsightsData(baseTasks)

  // Refresh handlers for each AI system (guards are in AiControlArea)
  const handleRefreshAnnotations = aiInsights.refresh

  const handleRefreshInsights = insightsData.generate

  // Mode change handler: switching to 'on' auto-generates insights if no data
  const handleModeChange = useCallback(
    (mode: AiMode) => {
      setAiMode(mode)
      if (mode === 'on' && !insightsData.hasResults && !insightsData.generating) {
        insightsData.generate()
      }
    },
    [setAiMode, insightsData],
  )

  // Insights chip toggle: when turning ON with no data, auto-generate
  const handleInsightsChipToggle = useCallback(() => {
    const newValue = !showInsights
    setShowInsights(newValue)
    if (newValue && !insightsData.hasResults && !insightsData.generating) {
      insightsData.generate()
    }
  }, [showInsights, setShowInsights, insightsData])

  // What's Next AI filter toggle (filter task list to only AI-highlighted tasks)
  const [aiFilterActive, setAiFilterActive] = useState(false)

  // Signal filter state for Insight mode (multi-select with Cmd+click exclusive)
  const [selectedSignals, setSelectedSignals] = useState<string[]>([])

  const handleSignalClick = useCallback((key: string, e: React.MouseEvent) => {
    // Special key from "All" chip to clear signal filter
    if (key === '__clear_all__') {
      setSelectedSignals([])
      return
    }
    if (e.metaKey || e.ctrlKey) {
      setSelectedSignals((prev) => (prev.length === 1 && prev[0] === key ? [] : [key]))
    } else {
      setSelectedSignals((prev) =>
        prev.includes(key) ? prev.filter((s) => s !== key) : [...prev, key],
      )
    }
  }, [])

  const handleSignalLongPress = useCallback((key: string) => {
    setSelectedSignals((prev) => (prev.length === 1 && prev[0] === key ? [] : [key]))
  }, [])

  // Apply AI filter and signal filter after other filters
  const tasks_ = useMemo(() => {
    let result = displayTasks

    // What's Next: filter to highlighted tasks when chip is active
    if (aiMode !== 'off' && aiFilterActive && aiInsights.aiTaskIds.size > 0) {
      result = result.filter((t) => aiInsights.aiTaskIds.has(t.id))
    }

    // Filter by selected signals (union/OR) — signal chips visible via Insights chip or preference
    if (aiMode !== 'off' && selectedSignals.length > 0) {
      result = result.filter((t) => {
        const sigs = insightsData.insightsSignalMap.get(t.id)
        return sigs?.some((s) => selectedSignals.includes(s))
      })
    }

    return result
  }, [
    displayTasks,
    aiMode,
    aiFilterActive,
    aiInsights.aiTaskIds,
    selectedSignals,
    insightsData.insightsSignalMap,
  ])

  // WN annotations: shown when WN filter active OR wnCommentaryUnfiltered pref is on
  const effectiveAnnotationMap = useMemo(() => {
    if (aiMode === 'off') return new Map<number, string>()
    if (aiFilterActive || wnCommentaryUnfiltered) return aiInsights.annotationMap
    return new Map<number, string>()
  }, [aiMode, aiFilterActive, wnCommentaryUnfiltered, aiInsights.annotationMap])

  // Insights commentary: shown when Insights chip is ON (all overlays together)
  const effectiveCommentaryMap = useMemo(() => {
    if (aiMode === 'off' || !showInsights) return new Map<number, string>()
    return insightsData.annotationMap
  }, [aiMode, showInsights, insightsData.annotationMap])

  // WN highlight: decoupled from annotation visibility — based on preference + WN task set
  const showWnHighlight = aiMode !== 'off' && wnHighlight

  // Show annotations when AI mode is not off
  const showAnnotations = aiMode !== 'off'

  // Sort fallback: if Insights chip off and sorting by AI score, revert to due_date
  useEffect(() => {
    if (!showInsights && sortOption === 'ai_insights') {
      setSortOption('due_date')
    }
  }, [showInsights, sortOption, setSortOption])

  // Clear signal selections when signal chips become invisible to prevent hidden filtering
  useEffect(() => {
    const chipsVisible = aiMode !== 'off' && (showInsights || insightsSignalChips)
    if (!chipsVisible && selectedSignals.length > 0) {
      setSelectedSignals([])
    }
  }, [aiMode, showInsights, insightsSignalChips, selectedSignals.length])

  // Wrap clearAllFilters to also clear selection, AI filter, and signal filters
  const handleClearFilters = useCallback(() => {
    selection.clear()
    setAiFilterActive(false)
    setSelectedSignals([])
    clearAllFilters()
  }, [selection, clearAllFilters])

  // Build task groups for keyboard navigation
  const effectiveGrouping = grouping
  const taskGroups = useMemo(
    () => buildTaskGroups(tasks_, projects, effectiveGrouping, timezone),
    [tasks_, projects, effectiveGrouping, timezone],
  )
  // Apply per-group sorting to match the visual order in TaskList.
  // Exclude tasks in collapsed groups so keyboard navigation skips them.
  const orderedIds = useMemo(
    () =>
      taskGroups.flatMap((g) => {
        if (isCollapsed(g.label)) return []
        return sortTasks(g.tasks, sortOption, reversed).map((t) => t.id)
      }),
    [taskGroups, sortOption, reversed, isCollapsed],
  )

  // Wrap toggleCollapse to deselect tasks in a group when collapsing it
  const handleToggleCollapse = useCallback(
    (label: string) => {
      if (!isCollapsed(label)) {
        // About to collapse — deselect tasks in this group
        const group = taskGroups.find((g) => g.label === label)
        if (group && selection.isSelectionMode) {
          const groupIds = group.tasks.map((t) => t.id)
          selection.removeAll(groupIds)
        }
      }
      toggleCollapse(label)
    },
    [isCollapsed, toggleCollapse, taskGroups, selection],
  )

  // Keyboard completion handler
  const handleKeyboardComplete = useCallback(
    async (taskIds: number[]) => {
      if (taskIds.length === 0) return

      if (taskIds.length === 1) {
        await actions.handleDone(taskIds[0])
      } else {
        // Bulk complete
        const count = taskIds.length
        try {
          const res = await fetch('/api/tasks/bulk/done', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids: taskIds }),
          })
          if (!res.ok) throw new Error('Bulk action failed')
          refreshAll()
          showToast({
            message: `${count} ${taskWord(count)} completed`,
            type: 'success',
            action: { label: 'Undo', onClick: actions.handleUndo },
          })
        } catch {
          showToast({ message: 'Action failed', type: 'error' })
        }
      }
    },
    [actions, refreshAll],
  )

  // Keyboard navigation hook - disabled when sheets/dialogs are open
  const keyboardNavEnabled =
    !showProjectPicker && !quickActionOpen && !showShortcutsDialog && !createPanelOpen
  const keyboard = useKeyboardNavigation({
    orderedIds,
    groups: taskGroups,
    keyboardFocusedId,
    setKeyboardFocusedId,
    selection,
    onComplete: handleKeyboardComplete,
    enabled: keyboardNavEnabled,
  })

  // Handler for desktop click: set keyboard focus (blue glow) without selecting
  const handleActivate = useCallback(
    (taskId: number) => {
      setKeyboardFocusedId(taskId)
      keyboard.enterKeyboardMode()
      // Sync browser focus to match the visual blue glow
      document.getElementById(`task-row-${taskId}`)?.focus()
      // Note: Does NOT call selection.selectOnly() - focus and selection are independent
    },
    [keyboard],
  )

  // Handler for desktop double-click: open QuickActionPopover for the task
  const handleDoubleClick = useCallback(
    (task: Task) => {
      setFocusedTask(task)
      setQuickActionOpen(true)
    },
    [setFocusedTask, setQuickActionOpen],
  )

  // Return focus to task list when keyboard shortcuts dialog closes (if there are selections).
  // Using onCloseAutoFocus ensures this fires AFTER Radix removes aria-hidden from main,
  // avoiding the "blocked aria-hidden on focused element" warning.
  const handleShortcutsDialogCloseAutoFocus = useCallback(
    (e: Event) => {
      if (selection.isSelectionMode) {
        const focusTarget = keyboardFocusedId ?? [...selection.selectedIds][0]
        if (focusTarget) {
          e.preventDefault()
          setKeyboardFocusedId(focusTarget)
          keyboard.enterKeyboardMode()
          document.getElementById(`task-row-${focusTarget}`)?.focus()
        }
      }
    },
    [selection.isSelectionMode, selection.selectedIds, keyboardFocusedId, keyboard],
  )

  // Exit keyboard/selection modes on click/touch outside (extracted to hook)
  useExitModes({ keyboard, selection })

  const handleSnoozeAllOverdue = useSnoozeOverdue({
    displayTasks,
    fetchTasks: refreshAll,
    handleUndo: actions.handleUndo,
    timezone,
    defaultSnoozeOption,
    morningTime,
  })

  const bulk = useBulkActions(
    selection,
    refreshAll,
    actions.handleUndo,
    setShowProjectPicker,
    setSearchQuery,
    setSearchResults,
  )

  // Global keyboard shortcuts (extracted to hook)
  useDashboardKeyboard({
    keyboard,
    keyboardNavEnabled,
    orderedIds,
    keyboardFocusedId,
    setKeyboardFocusedId,
    selection,
    taskGroups,
    sortOption,
    reversed,
    timezone,
    projects,
    annotationMap: effectiveAnnotationMap,
    showAnnotations,
    setShowShortcutsDialog,
    searchFocusRef,
    onDeleteTask: handleQuickActionDelete,
    onBulkDelete: bulk.bulkDelete,
  })

  const { overdueCount, todayCount } = useTaskCounts(tasks_, timezone)

  // Update browser tab title with overdue count
  useEffect(() => {
    document.title = overdueCount > 0 ? `(${overdueCount}) OpenTask` : 'OpenTask'
    return () => {
      document.title = 'OpenTask'
    }
  }, [overdueCount])

  // Compute per-project today task counts for ProjectFilterBar
  const todayCounts = useMemo(() => {
    if (!timezone) return new Map<number, number>()
    const now = new Date()
    const boundaries = getTimezoneDayBoundaries(timezone)
    const counts = new Map<number, number>()
    for (const task of tasks_) {
      const buckets = classifyTaskDueDate(task, now, boundaries)
      if (buckets.includes('today')) {
        counts.set(task.project_id, (counts.get(task.project_id) || 0) + 1)
      }
    }
    return counts
  }, [tasks_, timezone])

  // Compute selected tasks for bulk operations
  const selectedTasks = useMemo(() => {
    return tasks.filter((t) => selection.selectedIds.has(t.id))
  }, [tasks, selection.selectedIds])

  // Fetch tasks on initial mount (skipped when server provides initialTasks)
  const hasInitialData = initialTasks !== undefined
  useEffect(() => {
    if (status === 'loading') return
    if (status === 'unauthenticated') {
      router.push('/login')
      return
    }
    if (!hasInitialData) {
      fetchTasks()
    }
  }, [status, router, fetchTasks, hasInitialData])

  // Refresh tasks when a new task is created (e.g., from the global CreateTaskPanel).
  // Only refreshes tasks here — ProjectsProvider handles its own project count refresh.
  useEffect(() => {
    const handler = () => fetchTasks()
    window.addEventListener('task-created', handler)
    return () => window.removeEventListener('task-created', handler)
  }, [fetchTasks])

  // Prefetch QuickActionPopover chunk after initial load so first interaction is instant
  // (CreateTaskPanel is prefetched by AppLayout which wraps all pages)
  useEffect(() => {
    const timer = setTimeout(() => {
      import('@/components/QuickActionPopover')
    }, 2000)
    return () => clearTimeout(timer)
  }, [])

  if (status === 'loading' || (status === 'authenticated' && loading)) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="animate-pulse text-zinc-500">Loading...</div>
      </div>
    )
  }

  if (status === 'unauthenticated') return null

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-center">
          <div className="mb-4 text-red-500">{error}</div>
          <button
            onClick={() => {
              setError(null)
              setLoading(true)
              refreshAll()
            }}
            className="rounded-lg bg-zinc-100 px-4 py-2 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700"
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  return (
    <DashboardView
      tasks={tasks_}
      allTasks={baseTasks}
      projects={projects}
      grouping={grouping}
      searchQuery={searchQuery}
      searchResultCount={searchResults.length}
      overdueCount={overdueCount}
      todayCount={todayCount}
      selection={selection}
      selectedTasks={selectedTasks}
      showProjectPicker={showProjectPicker}
      actions={actions}
      selectedLabels={selectedLabels}
      onToggleLabel={toggleLabel}
      onClearFilters={handleClearFilters}
      selectedPriorities={selectedPriorities}
      onTogglePriority={togglePriority}
      onExclusivePriority={exclusivePriority}
      selectedDateFilters={selectedDateFilters}
      onToggleDateFilter={toggleDateFilter}
      onExclusiveDateFilter={exclusiveDateFilter}
      onExclusiveLabel={exclusiveLabel}
      attributeFilters={attributeFilters}
      onToggleAttribute={toggleAttribute}
      onExclusiveAttribute={exclusiveAttribute}
      selectedProjects={selectedProjects}
      onToggleProject={toggleProject}
      onExclusiveProject={exclusiveProject}
      excludedLabels={excludedLabels}
      excludedPriorities={excludedPriorities}
      excludedDateFilters={excludedDateFilters}
      excludedAttributes={excludedAttributes}
      excludedProjects={excludedProjects}
      onExcludeLabel={excludeLabel}
      onExcludePriority={excludePriority}
      onExcludeDateFilter={excludeDateFilter}
      onExcludeAttribute={excludeAttribute}
      onExcludeProject={excludeProject}
      todayCounts={todayCounts}
      timezone={timezone}
      onSearch={bulk.handleSearch}
      onSearchClear={() => {
        selection.clear()
        setSearchQuery(null)
        setSearchResults([])
      }}
      onBulkAction={bulk.bulkAction}
      onBulkSnoozeRelative={bulk.bulkSnoozeRelative}
      onBulkDelete={bulk.bulkDelete}
      onBulkMoveToProject={bulk.handleBulkMoveToProject}
      onShowProjectPicker={setShowProjectPicker}
      onSnoozeOverdue={handleSnoozeAllOverdue}
      focusedTask={focusedTask}
      quickActionOpen={quickActionOpen}
      onTaskFocus={setFocusedTask}
      onQuickActionClose={() => setQuickActionOpen(false)}
      onQuickActionSaveAll={actions.handleSaveAllChanges}
      onQuickActionNavigate={(taskId) => router.push(`/tasks/${taskId}`)}
      onNavigateToDetail={(taskId) => router.push(`/tasks/${taskId}`)}
      keyboardFocusedId={keyboardFocusedId}
      isKeyboardActive={keyboard.isKeyboardActive}
      onKeyDown={keyboard.handleKeyDown}
      onListFocus={keyboard.handleFocus}
      onListBlur={keyboard.handleBlur}
      sortOption={sortOption}
      reversed={reversed}
      setSortOption={setSortOption}
      isCollapsed={isCollapsed}
      toggleCollapse={handleToggleCollapse}
      onActivate={handleActivate}
      onDoubleClick={handleDoubleClick}
      showShortcutsDialog={showShortcutsDialog}
      onShortcutsDialogChange={setShowShortcutsDialog}
      onShortcutsDialogCloseAutoFocus={handleShortcutsDialogCloseAutoFocus}
      bulkSheetOpenRef={bulkSheetOpenRef}
      batchDialogOpen={batchDialogOpen}
      batchDialogMode={batchDialogMode}
      onBatchDialogChange={setBatchDialogOpen}
      onOpenBatchUndo={() => {
        setBatchDialogMode('undo')
        setBatchDialogOpen(true)
      }}
      onOpenBatchRedo={() => {
        setBatchDialogMode('redo')
        setBatchDialogOpen(true)
      }}
      onBatchConfirm={() => {
        setBatchDialogOpen(false)
        if (batchDialogMode === 'undo') {
          actions.handleBatchUndo()
        } else {
          actions.handleBatchRedo()
        }
      }}
      aiMode={aiMode}
      onAiModeChange={handleModeChange}
      showInsights={showInsights}
      onToggleInsights={handleInsightsChipToggle}
      wnCommentaryUnfiltered={wnCommentaryUnfiltered}
      onWnCommentaryUnfilteredChange={setWnCommentaryUnfiltered}
      wnHighlight={wnHighlight}
      onWnHighlightChange={setWnHighlight}
      insightsSignalChips={insightsSignalChips}
      onInsightsSignalChipsChange={setInsightsSignalChips}
      insightsScoreChips={insightsScoreChips}
      onInsightsScoreChipsChange={setInsightsScoreChips}
      enrichmentActive={enrichmentActive}
      onRefreshAnnotations={handleRefreshAnnotations}
      onRefreshInsights={handleRefreshInsights}
      aiInsights={aiInsights}
      insightsData={insightsData}
      aiFilterActive={aiFilterActive}
      onToggleAiFilter={() => setAiFilterActive((prev) => !prev)}
      effectiveAnnotationMap={effectiveAnnotationMap}
      effectiveCommentaryMap={effectiveCommentaryMap}
      showAnnotations={showAnnotations}
      showWnHighlight={showWnHighlight}
      selectedSignals={selectedSignals}
      onSignalClick={handleSignalClick}
      onSignalLongPress={handleSignalLongPress}
      onQuickActionDelete={handleQuickActionDelete}
      onReprocess={handleReprocess}
      onUnifiedChange={(unified) => {
        if (unified) {
          // Save current grouping so toggling unified off restores it
          if (grouping !== 'unified') prevNonUnifiedGrouping.current = grouping
          setDefaultGrouping('unified')
        } else {
          // Restore the previous non-unified grouping (default to 'time')
          setDefaultGrouping(prevNonUnifiedGrouping.current || 'time')
          prevNonUnifiedGrouping.current = null
        }
      }}
      searchFocusRef={searchFocusRef}
    />
  )
}

function DashboardView({
  tasks,
  allTasks,
  projects,
  grouping,
  searchQuery,
  searchResultCount,
  overdueCount,
  todayCount,
  selection,
  selectedTasks,
  showProjectPicker,
  actions,
  selectedLabels,
  onToggleLabel,
  onClearFilters,
  selectedPriorities,
  onTogglePriority,
  onExclusivePriority,
  selectedDateFilters,
  onToggleDateFilter,
  onExclusiveDateFilter,
  onExclusiveLabel,
  attributeFilters,
  onToggleAttribute,
  onExclusiveAttribute,
  selectedProjects,
  onToggleProject,
  onExclusiveProject,
  excludedLabels,
  excludedPriorities,
  excludedDateFilters,
  excludedAttributes,
  excludedProjects,
  onExcludeLabel,
  onExcludePriority,
  onExcludeDateFilter,
  onExcludeAttribute,
  onExcludeProject,
  todayCounts,
  timezone,
  onSearch,
  onSearchClear,
  onBulkAction,
  onBulkSnoozeRelative,
  onBulkDelete,
  onBulkMoveToProject,
  onShowProjectPicker,
  onSnoozeOverdue,
  focusedTask,
  quickActionOpen,
  onTaskFocus,
  onQuickActionClose,
  onQuickActionSaveAll,
  onQuickActionNavigate,
  onNavigateToDetail,
  keyboardFocusedId,
  isKeyboardActive,
  onKeyDown,
  onListFocus,
  onListBlur,
  sortOption,
  reversed,
  setSortOption,
  isCollapsed,
  toggleCollapse,
  onActivate,
  onDoubleClick,
  showShortcutsDialog,
  onShortcutsDialogChange,
  onShortcutsDialogCloseAutoFocus,
  bulkSheetOpenRef,
  batchDialogOpen,
  batchDialogMode,
  onBatchDialogChange,
  onOpenBatchUndo,
  onOpenBatchRedo,
  onBatchConfirm,
  aiMode,
  onAiModeChange,
  showInsights,
  onToggleInsights,
  wnCommentaryUnfiltered,
  onWnCommentaryUnfilteredChange,
  wnHighlight,
  onWnHighlightChange,
  insightsSignalChips,
  onInsightsSignalChipsChange,
  insightsScoreChips,
  onInsightsScoreChipsChange,
  enrichmentActive,
  onRefreshAnnotations,
  onRefreshInsights,
  aiInsights,
  insightsData,
  aiFilterActive,
  onToggleAiFilter,
  effectiveAnnotationMap,
  effectiveCommentaryMap,
  showAnnotations,
  showWnHighlight,
  selectedSignals,
  onSignalClick,
  onSignalLongPress,
  onQuickActionDelete,
  onReprocess,
  onUnifiedChange,
  searchFocusRef,
}: {
  tasks: Task[]
  allTasks: Task[]
  projects: Project[]
  grouping: GroupingMode
  searchQuery: string | null
  searchResultCount: number
  overdueCount: number
  todayCount: number
  selection: ReturnType<typeof useSelection>
  selectedTasks: Task[]
  showProjectPicker: boolean
  actions: ReturnType<typeof useDashboardActions>
  selectedLabels: string[]
  onToggleLabel: (label: string) => void
  onClearFilters: () => void
  selectedPriorities: number[]
  onTogglePriority: (priority: number) => void
  onExclusivePriority: (priority: number) => void
  selectedDateFilters: DueDateFilter[]
  onToggleDateFilter: (filter: DueDateFilter) => void
  onExclusiveDateFilter: (filter: DueDateFilter) => void
  onExclusiveLabel: (label: string) => void
  attributeFilters: Set<string>
  onToggleAttribute: (key: string) => void
  onExclusiveAttribute: (key: string) => void
  selectedProjects: number[]
  onToggleProject: (projectId: number) => void
  onExclusiveProject: (projectId: number) => void
  excludedLabels: string[]
  excludedPriorities: number[]
  excludedDateFilters: DueDateFilter[]
  excludedAttributes: Set<string>
  excludedProjects: number[]
  onExcludeLabel: (label: string) => void
  onExcludePriority: (priority: number) => void
  onExcludeDateFilter: (filter: DueDateFilter) => void
  onExcludeAttribute: (key: string) => void
  onExcludeProject: (projectId: number) => void
  todayCounts: Map<number, number>
  timezone: string
  onSearch: (q: string) => void
  onSearchClear: () => void
  onBulkAction: (endpoint: string, body: Record<string, unknown>) => Promise<void>
  onBulkSnoozeRelative: (deltaMinutes: number) => Promise<void>
  onBulkDelete: () => Promise<void>
  onBulkMoveToProject: (projectId: number) => Promise<void>
  onShowProjectPicker: (show: boolean) => void
  onSnoozeOverdue: (until?: string) => void
  focusedTask: Task | null
  quickActionOpen: boolean
  onTaskFocus: (task: Task) => void
  onQuickActionClose: () => void
  onQuickActionSaveAll: (taskId: number, changes: QuickActionPanelChanges) => void
  onQuickActionDelete: (taskId: number) => void
  onQuickActionNavigate: (taskId: number) => void
  onNavigateToDetail: (taskId: number) => void
  keyboardFocusedId: number | null
  isKeyboardActive: boolean
  onKeyDown: (e: React.KeyboardEvent) => void
  onListFocus: (e: React.FocusEvent) => void
  onListBlur: (e: React.FocusEvent) => void
  sortOption: SortOption
  reversed: boolean
  setSortOption: (option: SortOption) => void
  isCollapsed: (groupLabel: string) => boolean
  toggleCollapse: (groupLabel: string) => void
  onActivate: (taskId: number) => void
  onDoubleClick: (task: Task) => void
  showShortcutsDialog: boolean
  onShortcutsDialogChange: (open: boolean) => void
  onShortcutsDialogCloseAutoFocus: (e: Event) => void
  bulkSheetOpenRef: React.MutableRefObject<(() => void) | null>
  batchDialogOpen: boolean
  batchDialogMode: 'undo' | 'redo'
  onBatchDialogChange: (open: boolean) => void
  onOpenBatchUndo: () => void
  onOpenBatchRedo: () => void
  onBatchConfirm: () => void
  aiMode: AiMode
  onAiModeChange: (mode: AiMode) => void
  showInsights: boolean
  onToggleInsights: () => void
  wnCommentaryUnfiltered: boolean
  onWnCommentaryUnfilteredChange: (show: boolean) => void
  wnHighlight: boolean
  onWnHighlightChange: (show: boolean) => void
  insightsSignalChips: boolean
  onInsightsSignalChipsChange: (show: boolean) => void
  insightsScoreChips: boolean
  onInsightsScoreChipsChange: (show: boolean) => void
  enrichmentActive: boolean
  onRefreshAnnotations: () => void
  onRefreshInsights: () => void
  aiInsights: UseAiInsightsReturn
  insightsData: UseInsightsDataReturn
  aiFilterActive: boolean
  onToggleAiFilter: () => void
  effectiveAnnotationMap: Map<number, string>
  effectiveCommentaryMap: Map<number, string>
  showAnnotations: boolean
  showWnHighlight: boolean
  selectedSignals: string[]
  onSignalClick: (key: string, e: React.MouseEvent) => void
  onSignalLongPress: (key: string) => void
  onReprocess: (taskId: number) => Promise<void>
  onUnifiedChange: (unified: boolean) => void
  searchFocusRef?: React.MutableRefObject<(() => void) | null>
}) {
  const anyFilterActive =
    selectedLabels.length > 0 ||
    selectedPriorities.length > 0 ||
    selectedDateFilters.length > 0 ||
    attributeFilters.size > 0 ||
    selectedProjects.length > 0 ||
    excludedLabels.length > 0 ||
    excludedPriorities.length > 0 ||
    excludedDateFilters.length > 0 ||
    excludedAttributes.size > 0 ||
    excludedProjects.length > 0 ||
    (aiMode !== 'off' && aiFilterActive) ||
    (aiMode !== 'off' && selectedSignals.length > 0)

  return (
    <div className="flex flex-1 flex-col">
      <Header
        taskCount={tasks.length}
        overdueCount={overdueCount}
        todayCount={todayCount}
        isSelectionMode={selection.isSelectionMode}
        onUndo={actions.handleUndo}
        onRedo={actions.handleRedo}
        undoCount={actions.undoCount}
        redoCount={actions.redoCount}
        onBatchUndo={onOpenBatchUndo}
        onBatchRedo={onOpenBatchRedo}
        onSearch={onSearch}
        onSearchClear={onSearchClear}
        onSnoozeOverdue={onSnoozeOverdue}
        onShowKeyboardShortcuts={() => onShortcutsDialogChange(true)}
        timezone={timezone}
        searchFocusRef={searchFocusRef}
      />

      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-6">
        {/* Quick add + AI chip row */}
        <div className="mb-4 flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <QuickAdd
              onAdd={actions.handleQuickAdd}
              onOpenAddForm={(title) => {
                window.dispatchEvent(new CustomEvent('open-add-form', { detail: { title } }))
              }}
            />
          </div>
          <AiControlArea
            mode={aiMode}
            onModeChange={onAiModeChange}
            wnCommentaryUnfiltered={wnCommentaryUnfiltered}
            onWnCommentaryUnfilteredChange={onWnCommentaryUnfilteredChange}
            wnHighlight={wnHighlight}
            onWnHighlightChange={onWnHighlightChange}
            insightsSignalChips={insightsSignalChips}
            onInsightsSignalChipsChange={onInsightsSignalChipsChange}
            insightsScoreChips={insightsScoreChips}
            onInsightsScoreChipsChange={onInsightsScoreChipsChange}
            annotationGeneratedAt={aiInsights.generatedAt}
            annotationDurationMs={aiInsights.durationMs}
            annotationFreshnessText={aiInsights.freshnessText}
            annotationRefreshLoading={aiInsights.loading}
            annotationError={aiInsights.error}
            onRefreshAnnotations={onRefreshAnnotations}
            insightsGeneratedAt={insightsData.generatedAt}
            insightsDurationMs={insightsData.durationMs}
            insightsGenerating={insightsData.generating}
            insightsProgress={insightsData.progress}
            insightsCompletedTasks={insightsData.completedTasks}
            insightsTotalTasks={insightsData.totalTasks}
            insightsSingleCall={insightsData.singleCall}
            insightsGenerationStartedAt={insightsData.generationStartedAt}
            insightsError={insightsData.error}
            onRefreshInsights={onRefreshInsights}
            enrichmentActive={enrichmentActive}
          />
        </div>

        <FilterBar
          tasks={allTasks}
          selectedPriorities={selectedPriorities}
          selectedLabels={selectedLabels}
          selectedDateFilters={selectedDateFilters}
          onTogglePriority={onTogglePriority}
          onExclusivePriority={onExclusivePriority}
          onToggleLabel={onToggleLabel}
          onExclusiveLabel={onExclusiveLabel}
          onToggleDateFilter={onToggleDateFilter}
          onExclusiveDateFilter={onExclusiveDateFilter}
          attributeFilters={attributeFilters}
          onToggleAttribute={onToggleAttribute}
          onExclusiveAttribute={onExclusiveAttribute}
          projects={projects}
          selectedProjects={selectedProjects}
          onToggleProject={onToggleProject}
          onExclusiveProject={onExclusiveProject}
          excludedPriorities={excludedPriorities}
          excludedLabels={excludedLabels}
          excludedDateFilters={excludedDateFilters}
          excludedAttributes={excludedAttributes}
          excludedProjects={excludedProjects}
          onExcludePriority={onExcludePriority}
          onExcludeLabel={onExcludeLabel}
          onExcludeDateFilter={onExcludeDateFilter}
          onExcludeAttribute={onExcludeAttribute}
          onExcludeProject={onExcludeProject}
          todayCounts={todayCounts}
          timezone={timezone}
          aiMode={aiMode}
          aiInsightsCount={aiInsights.hasData ? aiInsights.aiTaskIds.size : undefined}
          aiFilterActive={aiFilterActive}
          aiFilterLoading={aiInsights.loading}
          onToggleAiFilter={onToggleAiFilter}
          insightsActive={showInsights}
          onToggleInsights={onToggleInsights}
          hasInsightsData={insightsData.hasResults}
          insightsSignalChipsVisible={insightsSignalChips}
          signalChips={
            aiMode !== 'off' && insightsData.hasResults
              ? insightsData.activeSignals.map((s) => ({
                  key: s.key,
                  label: s.label,
                  count: insightsData.signalCounts[s.key] || 0,
                  description: s.description,
                }))
              : undefined
          }
          selectedSignals={selectedSignals}
          onSignalClick={onSignalClick}
          onSignalLongPress={onSignalLongPress}
        />

        {searchQuery && (
          <div className="mb-4 text-sm text-zinc-500">
            {searchResultCount} result{searchResultCount !== 1 ? 's' : ''} for &ldquo;
            {searchQuery}&rdquo;
          </div>
        )}

        {anyFilterActive && (
          <div className="text-muted-foreground mb-4 rounded-md bg-blue-50 px-3 py-2 text-sm dark:bg-blue-950/30">
            Showing {tasks.length} of {allTasks.length} tasks <span className="mx-1">&middot;</span>
            <button
              onClick={onClearFilters}
              className="text-foreground font-medium hover:underline"
            >
              Clear filter
            </button>
          </div>
        )}

        <TaskList
          tasks={tasks}
          projects={projects}
          grouping={grouping}
          onDone={actions.handleDone}
          onSnooze={actions.handleSnooze}
          onLabelClick={onToggleLabel}
          onTaskFocus={onTaskFocus}
          keyboardFocusedId={keyboardFocusedId}
          isKeyboardActive={isKeyboardActive}
          onKeyDown={onKeyDown}
          onListFocus={onListFocus}
          onListBlur={onListBlur}
          sortOption={sortOption}
          reversed={reversed}
          setSortOption={setSortOption}
          isCollapsed={isCollapsed}
          toggleCollapse={toggleCollapse}
          onActivate={onActivate}
          onDoubleClick={onDoubleClick}
          annotationMap={effectiveAnnotationMap}
          showAnnotations={showAnnotations}
          wnTaskIds={aiInsights.aiTaskIds}
          showWnHighlight={showWnHighlight}
          onReprocess={onReprocess}
          insightsScoreMap={
            showInsights && aiMode !== 'off' ? insightsData.insightsScoreMap : undefined
          }
          insightsSignalMap={
            showInsights && aiMode !== 'off' ? insightsData.insightsSignalMap : undefined
          }
          insightsCommentaryMap={
            effectiveCommentaryMap.size > 0 ? effectiveCommentaryMap : undefined
          }
          showAiInsights={insightsData.hasResults && aiMode !== 'off' && showInsights}
          aiScoreDisabled={!showInsights || aiMode === 'off'}
          headerLeft={
            tasks.length > 0 ? (
              <button
                onClick={() => {
                  const allSelected =
                    tasks.length > 0 && tasks.every((t) => selection.selectedIds.has(t.id))
                  if (allSelected) {
                    selection.clear()
                  } else {
                    selection.selectAll(tasks.map((t) => t.id))
                  }
                }}
                className="text-muted-foreground hover:text-foreground text-xs transition-colors"
              >
                {tasks.length > 0 && tasks.every((t) => selection.selectedIds.has(t.id))
                  ? 'Select None'
                  : 'Select All'}
              </button>
            ) : undefined
          }
          onUnifiedChange={onUnifiedChange}
        />
      </main>

      <SelectionActionSheet
        selectedCount={selection.selectedIds.size}
        selectedTasks={selectedTasks}
        sheetOpenRef={bulkSheetOpenRef}
        onDone={() => onBulkAction('/api/tasks/bulk/done', { ids: [...selection.selectedIds] })}
        onSnooze={(until) =>
          onBulkAction('/api/tasks/bulk/snooze', {
            ids: [...selection.selectedIds],
            until,
          })
        }
        onSnoozeRelative={onBulkSnoozeRelative}
        onDelete={onBulkDelete}
        onPriorityChange={(priority) => {
          onBulkAction('/api/tasks/bulk/edit', {
            ids: [...selection.selectedIds],
            changes: { priority },
          })
        }}
        onMoveToProject={() => onShowProjectPicker(true)}
        onClear={selection.clear}
        onNavigateToDetail={onNavigateToDetail}
        onRecurrenceChange={(rrule, recurrenceMode) => {
          const changes: Record<string, unknown> = { rrule }
          if (recurrenceMode) changes.recurrence_mode = recurrenceMode
          onBulkAction('/api/tasks/bulk/edit', {
            ids: [...selection.selectedIds],
            changes,
          })
        }}
        projects={projects}
        onLabelsAdd={(labels) => {
          onBulkAction('/api/tasks/bulk/edit', {
            ids: [...selection.selectedIds],
            changes: { labels_add: labels },
          })
        }}
        onLabelsRemove={(labels) => {
          onBulkAction('/api/tasks/bulk/edit', {
            ids: [...selection.selectedIds],
            changes: { labels_remove: labels },
          })
        }}
        onProjectChange={(projectId) => {
          onBulkAction('/api/tasks/bulk/edit', {
            ids: [...selection.selectedIds],
            changes: { project_id: projectId },
          })
        }}
      />

      <SnoozeAllFab
        overdueCount={overdueCount}
        isSelectionMode={selection.isSelectionMode}
        onSnoozeOverdue={onSnoozeOverdue}
      />

      {showProjectPicker && (
        <ProjectPickerSheet
          projects={projects}
          onSelect={onBulkMoveToProject}
          onClose={() => onShowProjectPicker(false)}
        />
      )}

      <QuickActionPopover
        focusedTask={focusedTask}
        open={quickActionOpen}
        onClose={onQuickActionClose}
        onSaveAll={onQuickActionSaveAll}
        onDelete={onQuickActionDelete}
        onNavigateToDetail={onQuickActionNavigate}
        projects={projects}
        annotation={focusedTask ? effectiveAnnotationMap.get(focusedTask.id) : undefined}
        insightsCommentary={focusedTask ? effectiveCommentaryMap.get(focusedTask.id) : undefined}
      />

      <KeyboardShortcutsDialog
        open={showShortcutsDialog}
        onOpenChange={onShortcutsDialogChange}
        onCloseAutoFocus={onShortcutsDialogCloseAutoFocus}
      />

      <BatchUndoDialog
        open={batchDialogOpen}
        onOpenChange={onBatchDialogChange}
        mode={batchDialogMode}
        count={batchDialogMode === 'undo' ? actions.undoCount : actions.redoCount}
        onConfirm={onBatchConfirm}
      />
    </div>
  )
}
