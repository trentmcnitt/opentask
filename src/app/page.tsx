'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { TaskList, buildTaskGroups, sortTasks } from '@/components/TaskList'
import type { GroupingMode } from '@/components/TaskList'
import { useGroupSort } from '@/hooks/useGroupSort'
import { useKeyboardNavigation } from '@/hooks/useKeyboardNavigation'
import { useTimezone } from '@/hooks/useTimezone'
import { Header } from '@/components/Header'
import { QuickAdd } from '@/components/QuickAdd'
import { FilterBar } from '@/components/FilterBar'
import { SnoozeSheet } from '@/components/SnoozeSheet'
import { SelectionProvider, useSelection } from '@/components/SelectionProvider'
import { SelectionActionSheet } from '@/components/SelectionActionSheet'
import { SnoozeAllFab } from '@/components/SnoozeAllFab'
import { ProjectPickerSheet } from '@/components/ProjectPickerSheet'
import { QuickActionPopover, useQuickActionShortcut } from '@/components/QuickActionPopover'
import { KeyboardShortcutsDialog } from '@/components/KeyboardShortcutsDialog'
import { DateTime } from 'luxon'
import { showToast } from '@/lib/toast'
import type { Task, Project } from '@/types'
import type { QuickActionPanelChanges } from '@/components/QuickActionPanel'
import { useTaskActions } from '@/hooks/useTaskActions'
import type { ListTaskActionsReturn } from '@/hooks/useTaskActions'
import { useUndoRedoShortcuts } from '@/hooks/useUndoRedoShortcuts'
import { useFilterState } from '@/hooks/useFilterState'

export default function Home() {
  return (
    <SelectionProvider>
      <HomeContent />
    </SelectionProvider>
  )
}

function taskWord(n: number) {
  return n === 1 ? 'task' : 'tasks'
}

function getSnoozeTime(option: '+1h' | '+2h' | 'tomorrow', timezone: string): string {
  const now = new Date()
  if (option === '+1h') {
    const t = new Date(now.getTime() + 60 * 60 * 1000)
    t.setMinutes(0, 0, 0)
    return t.toISOString()
  }
  if (option === '+2h') {
    const t = new Date(now.getTime() + 2 * 60 * 60 * 1000)
    t.setMinutes(0, 0, 0)
    return t.toISOString()
  }
  // Use Luxon with the user's configured timezone so "tomorrow at 9 AM" targets
  // the correct moment even when the browser timezone differs from the account timezone.
  return DateTime.now()
    .setZone(timezone)
    .plus({ days: 1 })
    .set({ hour: 9, minute: 0, second: 0, millisecond: 0 })
    .toUTC()
    .toISO()!
}

function useFetchData(router: ReturnType<typeof useRouter>) {
  const [tasks, setTasks] = useState<Task[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
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

  const fetchProjects = useCallback(async () => {
    try {
      const res = await fetch('/api/projects')
      if (!res.ok) return
      const data = await res.json()
      setProjects(data.data?.projects || [])
    } catch {
      // Non-critical
    }
  }, [])

  return {
    tasks,
    setTasks,
    projects,
    loading,
    setLoading,
    error,
    setError,
    fetchTasks,
    fetchProjects,
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
          action: { label: 'View', onClick: () => onViewTask(task) },
        })
      } catch {
        showToast({ message: 'Failed to add task' })
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
      const skippedMsg = tasksSkipped > 0 ? ` (${tasksSkipped} high/urgent skipped)` : ''
      showToast({
        message: `${tasksAffected} ${taskWord(tasksAffected)} updated${skippedMsg}`,
        action: { label: 'Undo', onClick: handleUndo },
      })
    } catch {
      showToast({ message: 'Action failed' })
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
      const skippedMsg = tasksSkipped > 0 ? ` (${tasksSkipped} high/urgent skipped)` : ''
      showToast({
        message: `${tasksAffected} ${taskWord(tasksAffected)} snoozed${skippedMsg}`,
        action: { label: 'Undo', onClick: handleUndo },
      })
    } catch {
      showToast({ message: 'Snooze failed' })
    }
  }

  const bulkDelete = async () => {
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
        message: 'Tasks deleted',
        action: { label: 'Undo', onClick: handleUndo },
      })
    } catch {
      showToast({ message: 'Delete failed' })
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
        action: { label: 'Undo', onClick: handleUndo },
      })
    } catch {
      showToast({ message: 'Move failed' })
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

function HomeContent() {
  const { status } = useSession()
  const router = useRouter()
  const selection = useSelection()
  const timezone = useTimezone()
  const data = useFetchData(router)
  const {
    tasks,
    setTasks,
    projects,
    loading,
    error,
    setError,
    setLoading,
    fetchTasks,
    fetchProjects,
  } = data
  const handleViewTask = useCallback((task: Task) => {
    setFocusedTask(task)
    setQuickActionOpen(true)
  }, [])
  const actions = useDashboardActions(fetchTasks, tasks, setTasks, handleViewTask)
  useUndoRedoShortcuts(actions.handleUndoRef, actions.handleRedoRef)

  const [snoozeTask, setSnoozeTask] = useState<Task | null>(null)
  const [showProjectPicker, setShowProjectPicker] = useState(false)
  const [focusedTask, setFocusedTask] = useState<Task | null>(null)
  const [quickActionOpen, setQuickActionOpen] = useState(false)
  const [showShortcutsDialog, setShowShortcutsDialog] = useState(false)
  const bulkSheetOpenRef = useRef<(() => void) | null>(null)

  // Keyboard navigation state
  const [keyboardFocusedId, setKeyboardFocusedId] = useState<number | null>(null)

  // Sort state - lifted here so keyboard navigation can use the same order as display
  const { getSortOption, getReversed, setSortOption } = useGroupSort()

  useQuickActionShortcut(focusedTask, setQuickActionOpen, quickActionOpen, {
    isSelectionMode: selection.isSelectionMode,
    selectedCount: selection.selectedIds.size,
    openBulkSheet: () => bulkSheetOpenRef.current?.(),
  })
  const [grouping, setGrouping] = useState<GroupingMode>('project')
  const [searchQuery, setSearchQuery] = useState<string | null>(null)
  const [searchResults, setSearchResults] = useState<Task[]>([])

  const baseTasks = searchQuery ? searchResults : tasks
  const onLabelToggle = useCallback(() => selection.clear(), [selection])
  const {
    selectedLabels,
    selectedPriorities,
    toggleLabel,
    togglePriority,
    clearAllFilters,
    filteredTasks: displayTasks,
  } = useFilterState({ tasks: baseTasks, onLabelToggle })

  // Wrap clearAllFilters to also clear selection (matching original clearLabels behavior)
  const handleClearFilters = useCallback(() => {
    selection.clear()
    clearAllFilters()
  }, [selection, clearAllFilters])

  // Build task groups for keyboard navigation
  const effectiveGrouping = searchQuery ? 'time' : grouping
  const taskGroups = useMemo(
    () => buildTaskGroups(displayTasks, projects, effectiveGrouping, timezone),
    [displayTasks, projects, effectiveGrouping, timezone],
  )
  // Apply per-group sorting to match the visual order in TaskList
  const orderedIds = useMemo(
    () =>
      taskGroups.flatMap((g) => {
        const sortOption = getSortOption(g.label)
        const reversed = getReversed(g.label)
        const sortedTasks = sortTasks(g.tasks, sortOption, reversed)
        return sortedTasks.map((t) => t.id)
      }),
    [taskGroups, getSortOption, getReversed],
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
          fetchTasks()
          showToast({
            message: `${count} ${taskWord(count)} completed`,
            action: { label: 'Undo', onClick: actions.handleUndo },
          })
        } catch {
          showToast({ message: 'Action failed' })
        }
      }
    },
    [actions, fetchTasks],
  )

  // Keyboard navigation hook - disabled when sheets/dialogs are open
  const keyboardNavEnabled =
    !snoozeTask && !showProjectPicker && !quickActionOpen && !showShortcutsDialog
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

  // Global keyboard shortcuts for jumping into task list
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0
      const cmdKey = isMac ? e.metaKey : e.ctrlKey

      // Don't intercept when user is in an input, textarea, or contenteditable
      const activeEl = document.activeElement
      const isInInput =
        activeEl instanceof HTMLInputElement ||
        activeEl instanceof HTMLTextAreaElement ||
        (activeEl as HTMLElement)?.isContentEditable

      // ?: Open keyboard shortcuts help dialog (works globally, even with dialogs open)
      if (e.key === '?' && !isInInput) {
        e.preventDefault()
        setShowShortcutsDialog(true)
        return
      }

      // Undo/redo handled by useUndoRedoShortcuts hook

      // Don't intercept other shortcuts when dialogs/sheets are open
      if (!keyboardNavEnabled) return

      // Cmd+L: Always focus first task (works even in keyboard mode)
      if (cmdKey && e.key === 'l') {
        e.preventDefault()
        if (orderedIds.length > 0) {
          const firstTaskId = orderedIds[0]
          setKeyboardFocusedId(firstTaskId)
          keyboard.enterKeyboardMode()
          document.getElementById(`task-row-${firstTaskId}`)?.focus()
        }
        return
      }

      // ArrowDown: Focus first task (only when not in keyboard mode and not in input)
      if (e.key === 'ArrowDown' && !keyboard.isKeyboardActive && !isInInput) {
        e.preventDefault()
        if (orderedIds.length > 0) {
          const firstTaskId = orderedIds[0]
          setKeyboardFocusedId(firstTaskId)
          keyboard.enterKeyboardMode()
          document.getElementById(`task-row-${firstTaskId}`)?.focus()
        }
        return
      }

      // ArrowUp: Focus last task (only when not in keyboard mode and not in input)
      if (e.key === 'ArrowUp' && !keyboard.isKeyboardActive && !isInInput) {
        e.preventDefault()
        if (orderedIds.length > 0) {
          const lastTaskId = orderedIds[orderedIds.length - 1]
          setKeyboardFocusedId(lastTaskId)
          keyboard.enterKeyboardMode()
          document.getElementById(`task-row-${lastTaskId}`)?.focus()
        }
        return
      }

      // Home/End and Cmd+A/Cmd+Shift+A are handled by the keyboard navigation hook
      // (useKeyboardNavigation) when the list has focus. ArrowDown/ArrowUp above
      // handle entry into keyboard mode from outside the list.
    }

    document.addEventListener('keydown', handleGlobalKeyDown)
    return () => document.removeEventListener('keydown', handleGlobalKeyDown)
  }, [keyboard, keyboardNavEnabled, orderedIds, setKeyboardFocusedId])

  // Exit keyboard mode when clicking outside the task list
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      // Only handle if keyboard mode is active
      if (!keyboard.isKeyboardActive) return

      const target = e.target as HTMLElement
      // Check if click is inside the task list (listbox or any task row)
      const isInsideTaskList =
        target.closest('[role="listbox"]') !== null || target.closest('[id^="task-row-"]') !== null

      if (!isInsideTaskList) {
        keyboard.exitKeyboardMode()
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [keyboard])

  // Fetch saved grouping preference on mount
  useEffect(() => {
    if (status !== 'authenticated') return
    let cancelled = false
    fetch('/api/user/preferences')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data?.data?.default_grouping) return
        setGrouping(data.data.default_grouping)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [status])

  // Snooze all overdue tasks in the current filtered view (respects label/search filters).
  // Sends all overdue task IDs to the server — the server's filterMixedPriorityForSnooze
  // handles skipping high/urgent tasks in mixed-priority groups.
  const handleSnoozeAllOverdue = useCallback(async () => {
    const now = new Date()
    const overdueTasks = displayTasks.filter((t) => t.due_at && new Date(t.due_at) < now)

    if (overdueTasks.length === 0) {
      showToast({ message: 'No overdue tasks' })
      return
    }

    try {
      const res = await fetch('/api/tasks/bulk/snooze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ids: overdueTasks.map((t) => t.id),
          until: getSnoozeTime('+1h', timezone),
        }),
      })
      if (!res.ok) throw new Error('Snooze failed')
      const responseData = await res.json()
      const tasksAffected = responseData.data?.tasks_affected ?? 0
      const tasksSkipped = responseData.data?.tasks_skipped ?? 0
      fetchTasks()
      const skippedMsg = tasksSkipped > 0 ? ` (${tasksSkipped} high/urgent skipped)` : ''
      showToast({
        message: `${tasksAffected} overdue ${taskWord(tasksAffected)} snoozed +1h${skippedMsg}`,
        action: { label: 'Undo', onClick: actions.handleUndo },
      })
    } catch {
      showToast({ message: 'Snooze failed' })
    }
  }, [displayTasks, fetchTasks, actions.handleUndo, timezone])

  const bulk = useBulkActions(
    selection,
    fetchTasks,
    actions.handleUndo,
    setShowProjectPicker,
    setSearchQuery,
    setSearchResults,
  )

  const overdueCount = useMemo(() => {
    const now = new Date()
    return tasks.filter((t) => t.due_at && new Date(t.due_at) < now).length
  }, [tasks])

  // Count of overdue tasks from the filtered view (respects label/search filters).
  // All overdue tasks are counted — the server handles priority-based filtering.
  const snoozableOverdueCount = useMemo(() => {
    const now = new Date()
    return displayTasks.filter((t) => t.due_at && new Date(t.due_at) < now).length
  }, [displayTasks])

  const todayCount = useMemo(() => {
    const now = new Date()
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000)
    return tasks.filter((t) => {
      if (!t.due_at) return false
      const due = new Date(t.due_at)
      return due >= startOfDay && due < endOfDay
    }).length
  }, [tasks])

  // Compute selected tasks for bulk operations
  const selectedTasks = useMemo(() => {
    return tasks.filter((t) => selection.selectedIds.has(t.id))
  }, [tasks, selection.selectedIds])

  useEffect(() => {
    if (status === 'loading') return
    if (status === 'unauthenticated') {
      router.push('/login')
      return
    }
    fetchTasks()
    fetchProjects()
  }, [status, router, fetchTasks, fetchProjects])

  useEffect(() => {
    const handler = () => fetchTasks()
    window.addEventListener('task-created', handler)
    return () => window.removeEventListener('task-created', handler)
  }, [fetchTasks])

  useEffect(() => {
    const handler = () => fetchProjects()
    window.addEventListener('projects-reordered', handler)
    return () => window.removeEventListener('projects-reordered', handler)
  }, [fetchProjects])

  // Global Escape handler removed - keyboard navigation hook handles Escape now

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
              fetchTasks()
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
      tasks={displayTasks}
      allTasks={baseTasks}
      projects={projects}
      grouping={searchQuery ? 'time' : grouping}
      searchQuery={searchQuery}
      searchResultCount={searchResults.length}
      overdueCount={overdueCount}
      todayCount={todayCount}
      snoozableOverdueCount={snoozableOverdueCount}
      selection={selection}
      selectedTasks={selectedTasks}
      snoozeTask={snoozeTask}
      showProjectPicker={showProjectPicker}
      actions={actions}
      selectedLabels={selectedLabels}
      onToggleLabel={toggleLabel}
      onClearFilters={handleClearFilters}
      selectedPriorities={selectedPriorities}
      onTogglePriority={togglePriority}
      onSearch={bulk.handleSearch}
      onSearchClear={() => {
        selection.clear() // Clear selection when search cleared
        setSearchQuery(null)
        setSearchResults([])
      }}
      onSnoozeTask={setSnoozeTask}
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
      getSortOption={getSortOption}
      getReversed={getReversed}
      setSortOption={setSortOption}
      onActivate={handleActivate}
      onDoubleClick={handleDoubleClick}
      showShortcutsDialog={showShortcutsDialog}
      onShortcutsDialogChange={setShowShortcutsDialog}
      onShortcutsDialogCloseAutoFocus={handleShortcutsDialogCloseAutoFocus}
      bulkSheetOpenRef={bulkSheetOpenRef}
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
  snoozableOverdueCount,
  selection,
  selectedTasks,
  snoozeTask,
  showProjectPicker,
  actions,
  selectedLabels,
  onToggleLabel,
  onClearFilters,
  selectedPriorities,
  onTogglePriority,
  onSearch,
  onSearchClear,
  onSnoozeTask,
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
  getSortOption,
  getReversed,
  setSortOption,
  onActivate,
  onDoubleClick,
  showShortcutsDialog,
  onShortcutsDialogChange,
  onShortcutsDialogCloseAutoFocus,
  bulkSheetOpenRef,
}: {
  tasks: Task[]
  allTasks: Task[]
  projects: Project[]
  grouping: GroupingMode
  searchQuery: string | null
  searchResultCount: number
  overdueCount: number
  todayCount: number
  snoozableOverdueCount: number
  selection: ReturnType<typeof useSelection>
  selectedTasks: Task[]
  snoozeTask: Task | null
  showProjectPicker: boolean
  actions: ReturnType<typeof useDashboardActions>
  selectedLabels: string[]
  onToggleLabel: (label: string) => void
  onClearFilters: () => void
  selectedPriorities: number[]
  onTogglePriority: (priority: number) => void
  onSearch: (q: string) => void
  onSearchClear: () => void
  onSnoozeTask: (t: Task | null) => void
  onBulkAction: (endpoint: string, body: Record<string, unknown>) => Promise<void>
  onBulkSnoozeRelative: (deltaMinutes: number) => Promise<void>
  onBulkDelete: () => Promise<void>
  onBulkMoveToProject: (projectId: number) => Promise<void>
  onShowProjectPicker: (show: boolean) => void
  onSnoozeOverdue: () => void
  focusedTask: Task | null
  quickActionOpen: boolean
  onTaskFocus: (task: Task) => void
  onQuickActionClose: () => void
  onQuickActionSaveAll: (taskId: number, changes: QuickActionPanelChanges) => void
  onQuickActionNavigate: (taskId: number) => void
  onNavigateToDetail: (taskId: number) => void
  keyboardFocusedId: number | null
  isKeyboardActive: boolean
  onKeyDown: (e: React.KeyboardEvent) => void
  onListFocus: (e: React.FocusEvent) => void
  onListBlur: (e: React.FocusEvent) => void
  getSortOption: (groupLabel: string) => 'priority' | 'title' | 'age'
  getReversed: (groupLabel: string) => boolean
  setSortOption: (groupLabel: string, option: 'priority' | 'title' | 'age') => void
  onActivate: (taskId: number) => void
  onDoubleClick: (task: Task) => void
  showShortcutsDialog: boolean
  onShortcutsDialogChange: (open: boolean) => void
  onShortcutsDialogCloseAutoFocus: (e: Event) => void
  bulkSheetOpenRef: React.MutableRefObject<(() => void) | null>
}) {
  return (
    <div className="flex flex-1 flex-col">
      <Header
        taskCount={tasks.length}
        overdueCount={overdueCount}
        todayCount={todayCount}
        snoozableOverdueCount={snoozableOverdueCount}
        onUndo={actions.handleUndo}
        onRedo={actions.handleRedo}
        onSearch={onSearch}
        onSearchClear={onSearchClear}
        onSnoozeOverdue={onSnoozeOverdue}
        onShowKeyboardShortcuts={() => onShortcutsDialogChange(true)}
      />

      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-6">
        <QuickAdd
          onAdd={actions.handleQuickAdd}
          onOpenAddForm={(title) => {
            window.dispatchEvent(new CustomEvent('open-add-form', { detail: { title } }))
          }}
        />

        <FilterBar
          tasks={allTasks}
          selectedPriorities={selectedPriorities}
          selectedLabels={selectedLabels}
          onTogglePriority={onTogglePriority}
          onToggleLabel={onToggleLabel}
          onClearAll={onClearFilters}
        />

        {tasks.length > 0 && (
          <div className="mb-4">
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
          </div>
        )}

        {searchQuery && (
          <div className="mb-4 text-sm text-zinc-500">
            {searchResultCount} result{searchResultCount !== 1 ? 's' : ''} for &ldquo;
            {searchQuery}&rdquo;
          </div>
        )}

        {(selectedLabels.length > 0 || selectedPriorities.length > 0) && (
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
          onSnooze={(task) => onSnoozeTask(task)}
          onSwipeSnooze={actions.handleSnooze}
          onLabelClick={onToggleLabel}
          onTaskFocus={onTaskFocus}
          keyboardFocusedId={keyboardFocusedId}
          isKeyboardActive={isKeyboardActive}
          onKeyDown={onKeyDown}
          onListFocus={onListFocus}
          onListBlur={onListBlur}
          getSortOption={getSortOption}
          getReversed={getReversed}
          setSortOption={setSortOption}
          onActivate={onActivate}
          onDoubleClick={onDoubleClick}
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
        overdueCount={snoozableOverdueCount}
        isSelectionMode={selection.isSelectionMode}
        onSnoozeOverdue={onSnoozeOverdue}
      />

      {snoozeTask && (
        <SnoozeSheet
          task={snoozeTask}
          onSnooze={(until) => actions.handleSnooze(snoozeTask.id, until)}
          onClose={() => onSnoozeTask(null)}
        />
      )}

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
        onNavigateToDetail={onQuickActionNavigate}
      />

      <KeyboardShortcutsDialog
        open={showShortcutsDialog}
        onOpenChange={onShortcutsDialogChange}
        onCloseAutoFocus={onShortcutsDialogCloseAutoFocus}
      />
    </div>
  )
}
