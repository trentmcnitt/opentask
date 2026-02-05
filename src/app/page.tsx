'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { X } from 'lucide-react'
import { TaskList, buildTaskGroups, sortTasks } from '@/components/TaskList'
import type { GroupingMode } from '@/components/TaskList'
import { useGroupSort } from '@/hooks/useGroupSort'
import { useKeyboardNavigation } from '@/hooks/useKeyboardNavigation'
import { useTimezone } from '@/hooks/useTimezone'
import { Header } from '@/components/Header'
import { QuickAdd } from '@/components/QuickAdd'
import { LabelFilterBar } from '@/components/LabelFilterBar'
import { PriorityFilterBar } from '@/components/PriorityFilterBar'
import { SnoozeSheet } from '@/components/SnoozeSheet'
import { SelectionProvider, useSelection } from '@/components/SelectionProvider'
import { SelectionActionSheet } from '@/components/SelectionActionSheet'
import { SnoozeAllFab } from '@/components/SnoozeAllFab'
import { ProjectPickerSheet } from '@/components/ProjectPickerSheet'
import { QuickActionPopover, useQuickActionShortcut } from '@/components/QuickActionPopover'
import { KeyboardShortcutsDialog } from '@/components/KeyboardShortcutsDialog'
import { showToast } from '@/lib/toast'
import { formatChangesToast } from '@/lib/format-toast'
import type { Task, Project } from '@/types'
import type { QuickActionPanelChanges } from '@/components/QuickActionPanel'

export default function Home() {
  return (
    <SelectionProvider>
      <HomeContent />
    </SelectionProvider>
  )
}

function getSnoozeTime(option: '+1h' | '+2h' | 'tomorrow'): string {
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
  const t = new Date(now)
  t.setDate(t.getDate() + 1)
  t.setHours(9, 0, 0, 0)
  return t.toISOString()
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

function useTaskActions(
  fetchTasks: () => Promise<void>,
  tasks: Task[],
  setTasks: React.Dispatch<React.SetStateAction<Task[]>>,
) {
  // Use refs to break circular dependency between handleUndo and handleRedo
  const handleUndoRef = useRef<(() => Promise<void>) | null>(null)
  const handleRedoRef = useRef<(() => Promise<void>) | null>(null)

  const handleUndo = useCallback(async () => {
    try {
      const res = await fetch('/api/undo', { method: 'POST' })
      if (!res.ok) {
        showToast({ message: 'Nothing to undo' })
        return
      }
      const data = await res.json()
      fetchTasks()
      showToast({
        message: `Undid: ${data.data.description}`,
        action: { label: 'Redo', onClick: () => handleRedoRef.current?.() },
      })
    } catch {
      showToast({ message: 'Undo failed' })
    }
  }, [fetchTasks])

  const handleRedo = useCallback(async () => {
    try {
      const res = await fetch('/api/redo', { method: 'POST' })
      if (!res.ok) {
        showToast({ message: 'Nothing to redo' })
        return
      }
      const data = await res.json()
      fetchTasks()
      showToast({
        message: `Redid: ${data.data.description}`,
        action: { label: 'Undo', onClick: () => handleUndoRef.current?.() },
      })
    } catch {
      showToast({ message: 'Redo failed' })
    }
  }, [fetchTasks])

  // Keep refs up to date
  handleUndoRef.current = handleUndo
  handleRedoRef.current = handleRedo

  const handleDone = useCallback(
    async (taskId: number) => {
      const task = tasks.find((t) => t.id === taskId)
      if (!task) return

      if (!task.rrule) {
        setTasks((prev) => prev.filter((t) => t.id !== taskId))
      }

      try {
        const res = await fetch(`/api/tasks/${taskId}/done`, { method: 'POST' })
        if (!res.ok) throw new Error('Failed to mark done')
        const data = await res.json()
        if (data.data?.task?.rrule) {
          setTasks((prev) => prev.map((t) => (t.id === taskId ? data.data.task : t)))
        }
        showToast({
          message: task.rrule ? 'Task advanced' : 'Task completed',
          action: { label: 'Undo', onClick: handleUndo },
        })
      } catch {
        fetchTasks()
      }
    },
    [tasks, setTasks, fetchTasks, handleUndo],
  )

  const handleSnooze = useCallback(
    async (taskId: number, until: string) => {
      setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, due_at: until } : t)))

      try {
        const res = await fetch(`/api/tasks/${taskId}/snooze`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ until }),
        })
        if (!res.ok) throw new Error('Failed to snooze')
        fetchTasks()
        showToast({ message: 'Task snoozed', action: { label: 'Undo', onClick: handleUndo } })
      } catch {
        fetchTasks()
      }
    },
    [setTasks, fetchTasks, handleUndo],
  )

  const handleQuickAdd = useCallback(
    async (title: string) => {
      try {
        const res = await fetch('/api/tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title }),
        })
        if (!res.ok) throw new Error('Failed to create task')
        fetchTasks()
        showToast({ message: 'Task added' })
      } catch {
        showToast({ message: 'Failed to add task' })
      }
    },
    [fetchTasks],
  )

  const handlePriorityChange = useCallback(
    async (taskId: number, newPriority: number) => {
      setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, priority: newPriority } : t)))

      try {
        const res = await fetch(`/api/tasks/${taskId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ priority: newPriority }),
        })
        if (!res.ok) throw new Error('Failed to update priority')
        fetchTasks()
        showToast({
          message: 'Priority updated',
          action: { label: 'Undo', onClick: handleUndo },
        })
      } catch {
        fetchTasks()
      }
    },
    [setTasks, fetchTasks, handleUndo],
  )

  const handleRruleChange = useCallback(
    async (
      taskId: number,
      rrule: string | null,
      recurrenceMode?: 'from_due' | 'from_completion',
    ) => {
      const changes: Record<string, unknown> = { rrule }
      if (recurrenceMode) changes.recurrence_mode = recurrenceMode

      try {
        const res = await fetch(`/api/tasks/${taskId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(changes),
        })
        if (!res.ok) throw new Error('Failed to update recurrence')
        fetchTasks()
        showToast({
          message: rrule ? 'Recurrence updated' : 'Recurrence removed',
          action: { label: 'Undo', onClick: handleUndo },
        })
      } catch {
        fetchTasks()
      }
    },
    [fetchTasks, handleUndo],
  )

  // Batched save handler for QuickActionPopover - sends all changes in a single API call
  // This creates one undo entry and shows one toast for all changes made in the panel
  const handleSaveAllChanges = useCallback(
    async (taskId: number, changes: QuickActionPanelChanges) => {
      // Optimistic update for priority (the most visible change)
      if (changes.priority !== undefined) {
        setTasks((prev) =>
          prev.map((t) => (t.id === taskId ? { ...t, priority: changes.priority! } : t)),
        )
      }
      // Optimistic update for due_at if present
      if (changes.due_at !== undefined) {
        setTasks((prev) =>
          prev.map((t) => (t.id === taskId ? { ...t, due_at: changes.due_at! } : t)),
        )
      }

      try {
        const res = await fetch(`/api/tasks/${taskId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(changes),
        })
        if (!res.ok) throw new Error('Failed to update task')
        fetchTasks()
        showToast({
          message: formatChangesToast(changes),
          action: { label: 'Undo', onClick: handleUndo },
        })
      } catch {
        // Revert optimistic updates on failure
        fetchTasks()
      }
    },
    [setTasks, fetchTasks, handleUndo],
  )

  return {
    handleDone,
    handleSnooze,
    handleUndo,
    handleRedo,
    handleQuickAdd,
    handlePriorityChange,
    handleRruleChange,
    handleSaveAllChanges,
  }
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
      selection.clear()
      fetchTasks()
      showToast({
        message: `${count} tasks updated`,
        action: { label: 'Undo', onClick: handleUndo },
      })
    } catch {
      showToast({ message: 'Action failed' })
    }
  }

  const bulkSnoozeRelative = async (deltaMinutes: number) => {
    const count = selection.selectedIds.size
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
      selection.clear()
      fetchTasks()
      showToast({
        message: `${count} tasks snoozed`,
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
        message: `${count} tasks moved`,
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
  const { data: session, status } = useSession()
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
  const actions = useTaskActions(fetchTasks, tasks, setTasks)

  const [snoozeTask, setSnoozeTask] = useState<Task | null>(null)
  const [showProjectPicker, setShowProjectPicker] = useState(false)
  const [focusedTask, setFocusedTask] = useState<Task | null>(null)
  const [quickActionOpen, setQuickActionOpen] = useState(false)
  const [showShortcutsDialog, setShowShortcutsDialog] = useState(false)

  // Keyboard navigation state
  const [keyboardFocusedId, setKeyboardFocusedId] = useState<number | null>(null)

  // Sort state - lifted here so keyboard navigation can use the same order as display
  const { getSortOption, setSortOption } = useGroupSort()

  useQuickActionShortcut(focusedTask, setQuickActionOpen, quickActionOpen)
  const [grouping, setGrouping] = useState<GroupingMode>('project')
  const hasToggledGrouping = useRef(false)
  const [searchQuery, setSearchQuery] = useState<string | null>(null)
  const [searchResults, setSearchResults] = useState<Task[]>([])
  const [selectedLabels, setSelectedLabels] = useState<string[]>([])
  const [selectedPriorities, setSelectedPriorities] = useState<number[]>([])

  const toggleLabel = useCallback(
    (label: string) => {
      selection.clear() // Clear selection when filter changes
      setSelectedLabels((prev) =>
        prev.includes(label) ? prev.filter((l) => l !== label) : [...prev, label],
      )
    },
    [selection],
  )

  const clearLabels = useCallback(() => {
    selection.clear() // Clear selection when filter changes
    setSelectedLabels([])
  }, [selection])

  const togglePriority = useCallback((priority: number) => {
    setSelectedPriorities((prev) =>
      prev.includes(priority) ? prev.filter((p) => p !== priority) : [...prev, priority],
    )
  }, [])

  const clearPriorities = useCallback(() => {
    setSelectedPriorities([])
  }, [])

  const baseTasks = searchQuery ? searchResults : tasks
  const displayTasks = useMemo(() => {
    let filtered = baseTasks
    if (selectedLabels.length > 0) {
      filtered = filtered.filter((t) => t.labels.some((l) => selectedLabels.includes(l)))
    }
    if (selectedPriorities.length > 0) {
      filtered = filtered.filter((t) => selectedPriorities.includes(t.priority ?? 0))
    }
    return filtered
  }, [baseTasks, selectedLabels, selectedPriorities])

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
        const sortedTasks = sortTasks(g.tasks, sortOption)
        return sortedTasks.map((t) => t.id)
      }),
    [taskGroups, getSortOption],
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
            message: `${count} tasks completed`,
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

      // Cmd+Z: Undo (works globally when not in input, even with dialogs open)
      if (cmdKey && e.key.toLowerCase() === 'z' && !e.shiftKey && !isInInput) {
        e.preventDefault()
        actions.handleUndo()
        return
      }

      // Cmd+Shift+Z: Redo (works globally when not in input, even with dialogs open)
      if (cmdKey && e.key.toLowerCase() === 'z' && e.shiftKey && !isInInput) {
        e.preventDefault()
        actions.handleRedo()
        return
      }

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

      // Home: Focus first task (works globally, even when not in keyboard mode)
      if (e.key === 'Home' && !isInInput) {
        e.preventDefault()
        if (orderedIds.length > 0) {
          const firstTaskId = orderedIds[0]
          setKeyboardFocusedId(firstTaskId)
          keyboard.enterKeyboardMode()
          document.getElementById(`task-row-${firstTaskId}`)?.focus()
        }
        return
      }

      // End: Focus last task (works globally, even when not in keyboard mode)
      if (e.key === 'End' && !isInInput) {
        e.preventDefault()
        if (orderedIds.length > 0) {
          const lastTaskId = orderedIds[orderedIds.length - 1]
          setKeyboardFocusedId(lastTaskId)
          keyboard.enterKeyboardMode()
          document.getElementById(`task-row-${lastTaskId}`)?.focus()
        }
        return
      }

      // Cmd+Shift+A: Select all tasks in first group (works globally)
      // This intercepts the browser's tab search shortcut
      if (cmdKey && e.shiftKey && e.key.toLowerCase() === 'a' && !isInInput) {
        e.preventDefault()
        if (taskGroups.length > 0 && orderedIds.length > 0) {
          // Get first group's task IDs (in sorted order)
          const firstGroup = taskGroups[0]
          const firstGroupTaskIds = new Set(firstGroup.tasks.map((t) => t.id))
          const groupIds = orderedIds.filter((id) => firstGroupTaskIds.has(id))

          if (groupIds.length > 0) {
            const allSelected = groupIds.every((id) => selection.selectedIds.has(id))
            if (allSelected) {
              selection.removeAll(groupIds)
            } else {
              selection.addAll(groupIds)
              // Enter keyboard mode if not already
              if (!keyboard.isKeyboardActive) {
                setKeyboardFocusedId(groupIds[0])
                keyboard.enterKeyboardMode()
                document.getElementById(`task-row-${groupIds[0]}`)?.focus()
              }
            }
          }
        }
        return
      }

      // Cmd+A: Select all visible tasks (or deselect if all selected) - works globally
      if (cmdKey && e.key.toLowerCase() === 'a' && !isInInput) {
        e.preventDefault()
        if (orderedIds.length > 0) {
          const allSelected = orderedIds.every((id) => selection.selectedIds.has(id))
          if (allSelected) {
            selection.clear()
          } else {
            selection.selectAll(orderedIds)
            // Enter keyboard mode if not already
            if (!keyboard.isKeyboardActive) {
              setKeyboardFocusedId(orderedIds[0])
              keyboard.enterKeyboardMode()
              document.getElementById(`task-row-${orderedIds[0]}`)?.focus()
            }
          }
        }
        return
      }
    }

    document.addEventListener('keydown', handleGlobalKeyDown)
    return () => document.removeEventListener('keydown', handleGlobalKeyDown)
  }, [keyboard, keyboardNavEnabled, orderedIds, setKeyboardFocusedId, selection, taskGroups])

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
        // Only apply if user hasn't manually toggled yet
        if (!hasToggledGrouping.current) {
          setGrouping(data.data.default_grouping)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [status])

  const handleGroupingChange = useCallback((mode: GroupingMode) => {
    hasToggledGrouping.current = true
    setGrouping(mode)
  }, [])

  // Snooze all overdue tasks in the current filtered view (respects label/search filters)
  const handleSnoozeAllOverdue = useCallback(async () => {
    const now = new Date()
    const overdueTasks = displayTasks.filter((t) => t.due_at && new Date(t.due_at) < now)
    const eligible = overdueTasks.filter((t) => (t.priority || 0) <= 2)
    const skipped = overdueTasks.length - eligible.length

    if (eligible.length === 0) {
      showToast({ message: 'No snoozable overdue tasks' })
      return
    }

    try {
      const res = await fetch('/api/tasks/bulk/snooze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: eligible.map((t) => t.id), until: getSnoozeTime('+1h') }),
      })
      if (!res.ok) throw new Error('Snooze failed')
      fetchTasks()
      const skippedMsg = skipped > 0 ? ` (${skipped} high/urgent skipped)` : ''
      showToast({
        message: `Snoozed ${eligible.length} overdue tasks +1h${skippedMsg}`,
        action: { label: 'Undo', onClick: actions.handleUndo },
      })
    } catch {
      showToast({ message: 'Snooze failed' })
    }
  }, [displayTasks, fetchTasks, actions.handleUndo])

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

  // Count of snoozable overdue tasks from the filtered view (respects label/search filters)
  // Tasks with priority > 2 (high/urgent) are excluded from snooze-all operations
  const snoozableOverdueCount = useMemo(() => {
    const now = new Date()
    return displayTasks.filter(
      (t) => t.due_at && new Date(t.due_at) < now && (t.priority || 0) <= 2,
    ).length
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
      session={session}
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
      onClearLabels={clearLabels}
      selectedPriorities={selectedPriorities}
      onTogglePriority={togglePriority}
      onClearPriorities={clearPriorities}
      onGroupingChange={handleGroupingChange}
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
      onQuickActionDateSave={actions.handleSnooze}
      onQuickActionNavigate={(taskId) => router.push(`/tasks/${taskId}`)}
      onNavigateToDetail={(taskId) => router.push(`/tasks/${taskId}`)}
      keyboardFocusedId={keyboardFocusedId}
      isKeyboardActive={keyboard.isKeyboardActive}
      onKeyDown={keyboard.handleKeyDown}
      onListFocus={keyboard.handleFocus}
      onListBlur={keyboard.handleBlur}
      getSortOption={getSortOption}
      setSortOption={setSortOption}
      onActivate={handleActivate}
      onDoubleClick={handleDoubleClick}
      showShortcutsDialog={showShortcutsDialog}
      onShortcutsDialogChange={setShowShortcutsDialog}
      onShortcutsDialogCloseAutoFocus={handleShortcutsDialogCloseAutoFocus}
    />
  )
}

/**
 * Combined filter bar for priority and label filters.
 * Priority badges (square) appear first, then a gray separator, then label badges (pill).
 * The separator only appears if both filter types have content.
 */
function FilterBar({
  allTasks,
  selectedPriorities,
  selectedLabels,
  onTogglePriority,
  onToggleLabel,
  onClearAll,
}: {
  allTasks: Task[]
  selectedPriorities: number[]
  selectedLabels: string[]
  onTogglePriority: (priority: number) => void
  onToggleLabel: (label: string) => void
  onClearAll: () => void
}) {
  // Check if we have any priorities or labels to show
  const hasPriorities = allTasks.some((t) => t.priority !== undefined)
  const hasLabels = allTasks.some((t) => t.labels.length > 0)

  if (!hasPriorities && !hasLabels) return null

  const hasSelection = selectedPriorities.length > 0 || selectedLabels.length > 0

  return (
    <div className="relative mb-4 flex items-center">
      <div className="scrollbar-hide flex flex-1 items-center gap-2 overflow-x-auto pr-8">
        <PriorityFilterBar
          tasks={allTasks}
          selectedPriorities={selectedPriorities}
          onTogglePriority={onTogglePriority}
        />

        {/* Gray vertical separator between priority and label filters */}
        {hasPriorities && hasLabels && <div className="bg-border mx-1 h-4 w-px flex-shrink-0" />}

        <LabelFilterBar
          tasks={allTasks}
          selectedLabels={selectedLabels}
          onToggleLabel={onToggleLabel}
        />
      </div>

      {/* Clear button - sticky right end */}
      {hasSelection && (
        <div className="from-background pointer-events-none absolute right-0 flex items-center bg-gradient-to-l from-50% to-transparent pl-4">
          <button
            onClick={onClearAll}
            className="text-muted-foreground hover:text-foreground pointer-events-auto flex-shrink-0 rounded-full p-1 transition-colors"
            aria-label="Clear all filters"
          >
            <X className="size-4" />
          </button>
        </div>
      )}
    </div>
  )
}

function DashboardView({
  session,
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
  onClearLabels,
  selectedPriorities,
  onTogglePriority,
  onClearPriorities,
  onGroupingChange,
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
  onQuickActionDateSave,
  onQuickActionNavigate,
  onNavigateToDetail,
  keyboardFocusedId,
  isKeyboardActive,
  onKeyDown,
  onListFocus,
  onListBlur,
  getSortOption,
  setSortOption,
  onActivate,
  onDoubleClick,
  showShortcutsDialog,
  onShortcutsDialogChange,
  onShortcutsDialogCloseAutoFocus,
}: {
  session: ReturnType<typeof useSession>['data']
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
  actions: ReturnType<typeof useTaskActions>
  selectedLabels: string[]
  onToggleLabel: (label: string) => void
  onClearLabels: () => void
  selectedPriorities: number[]
  onTogglePriority: (priority: number) => void
  onClearPriorities: () => void
  onGroupingChange: (g: GroupingMode) => void
  onSearch: (q: string) => void
  onSearchClear: () => void
  onSnoozeTask: (t: Task | null) => void
  onBulkAction: (endpoint: string, body: Record<string, unknown>) => void
  onBulkSnoozeRelative: (deltaMinutes: number) => Promise<void>
  onBulkDelete: () => void
  onBulkMoveToProject: (projectId: number) => void
  onShowProjectPicker: (show: boolean) => void
  onSnoozeOverdue: () => void
  focusedTask: Task | null
  quickActionOpen: boolean
  onTaskFocus: (task: Task) => void
  onQuickActionClose: () => void
  onQuickActionSaveAll: (taskId: number, changes: QuickActionPanelChanges) => void
  onQuickActionDateSave: (taskId: number, until: string) => void
  onQuickActionNavigate: (taskId: number) => void
  onNavigateToDetail: (taskId: number) => void
  keyboardFocusedId: number | null
  isKeyboardActive: boolean
  onKeyDown: (e: React.KeyboardEvent) => void
  onListFocus: (e: React.FocusEvent) => void
  onListBlur: (e: React.FocusEvent) => void
  getSortOption: (groupLabel: string) => 'priority' | 'title' | 'age'
  setSortOption: (groupLabel: string, option: 'priority' | 'title' | 'age') => void
  onActivate: (taskId: number) => void
  onDoubleClick: (task: Task) => void
  showShortcutsDialog: boolean
  onShortcutsDialogChange: (open: boolean) => void
  onShortcutsDialogCloseAutoFocus: (e: Event) => void
}) {
  return (
    <div className="flex flex-1 flex-col">
      <Header
        taskCount={tasks.length}
        overdueCount={overdueCount}
        todayCount={todayCount}
        snoozableOverdueCount={snoozableOverdueCount}
        grouping={grouping}
        onGroupingChange={onGroupingChange}
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
          allTasks={allTasks}
          selectedPriorities={selectedPriorities}
          selectedLabels={selectedLabels}
          onTogglePriority={onTogglePriority}
          onToggleLabel={onToggleLabel}
          onClearAll={() => {
            onClearPriorities()
            onClearLabels()
          }}
        />

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
              onClick={() => {
                onClearPriorities()
                onClearLabels()
              }}
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
          setSortOption={setSortOption}
          onActivate={onActivate}
          onDoubleClick={onDoubleClick}
        />
      </main>

      <SelectionActionSheet
        selectedCount={selection.selectedIds.size}
        selectedTasks={selectedTasks}
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
        onDateSave={onQuickActionDateSave}
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
