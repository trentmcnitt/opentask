'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { TaskList } from '@/components/TaskList'
import type { GroupingMode } from '@/components/TaskList'
import { Header } from '@/components/Header'
import { QuickAdd } from '@/components/QuickAdd'
import { LabelFilterBar } from '@/components/LabelFilterBar'
import { SnoozeSheet } from '@/components/SnoozeSheet'
import { SelectionProvider, useSelection } from '@/components/SelectionProvider'
import { SelectionActionSheet } from '@/components/SelectionActionSheet'
import { SnoozeAllFab } from '@/components/SnoozeAllFab'
import { ProjectPickerSheet } from '@/components/ProjectPickerSheet'
import { QuickActionPopover, useQuickActionShortcut } from '@/components/QuickActionPopover'
import { showToast } from '@/lib/toast'
import type { Task, Project } from '@/types'

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
  const handleUndo = useCallback(async () => {
    try {
      const res = await fetch('/api/undo', { method: 'POST' })
      if (!res.ok) throw new Error('Failed to undo')
      fetchTasks()
    } catch {
      showToast({ message: 'Undo failed' })
    }
  }, [fetchTasks])

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

  return { handleDone, handleSnooze, handleUndo, handleQuickAdd }
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

  useQuickActionShortcut(focusedTask, setQuickActionOpen, quickActionOpen)
  const [grouping, setGrouping] = useState<GroupingMode>('project')
  const hasToggledGrouping = useRef(false)
  const [searchQuery, setSearchQuery] = useState<string | null>(null)
  const [searchResults, setSearchResults] = useState<Task[]>([])
  const [selectedLabels, setSelectedLabels] = useState<string[]>([])

  const toggleLabel = useCallback((label: string) => {
    setSelectedLabels((prev) =>
      prev.includes(label) ? prev.filter((l) => l !== label) : [...prev, label],
    )
  }, [])

  const clearLabels = useCallback(() => {
    setSelectedLabels([])
  }, [])

  const baseTasks = searchQuery ? searchResults : tasks
  const displayTasks = useMemo(() => {
    if (selectedLabels.length === 0) return baseTasks
    return baseTasks.filter((t) => t.labels.some((l) => selectedLabels.includes(l)))
  }, [baseTasks, selectedLabels])

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

  const handleSnoozeAllOverdue = useCallback(async () => {
    const now = new Date()
    const overdueTasks = tasks.filter((t) => t.due_at && new Date(t.due_at) < now)
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
  }, [tasks, fetchTasks, actions.handleUndo])

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

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && selection.isSelectionMode) selection.clear()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [selection])

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
      selection={selection}
      selectedTasks={selectedTasks}
      snoozeTask={snoozeTask}
      showProjectPicker={showProjectPicker}
      actions={actions}
      selectedLabels={selectedLabels}
      onToggleLabel={toggleLabel}
      onClearLabels={clearLabels}
      onGroupingChange={handleGroupingChange}
      onSearch={bulk.handleSearch}
      onSearchClear={() => {
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
      onQuickActionDateSave={actions.handleSnooze}
    />
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
  selection,
  selectedTasks,
  snoozeTask,
  showProjectPicker,
  actions,
  selectedLabels,
  onToggleLabel,
  onClearLabels,
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
  onQuickActionDateSave,
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
  selection: ReturnType<typeof useSelection>
  selectedTasks: Task[]
  snoozeTask: Task | null
  showProjectPicker: boolean
  actions: ReturnType<typeof useTaskActions>
  selectedLabels: string[]
  onToggleLabel: (label: string) => void
  onClearLabels: () => void
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
  onQuickActionDateSave: (taskId: number, until: string) => void
}) {
  return (
    <div className="flex flex-1 flex-col">
      <Header
        taskCount={tasks.length}
        overdueCount={overdueCount}
        todayCount={todayCount}
        grouping={grouping}
        onGroupingChange={onGroupingChange}
        onUndo={actions.handleUndo}
        onSearch={onSearch}
        onSearchClear={onSearchClear}
        userName={session?.user?.name || undefined}
        onSnoozeOverdue={onSnoozeOverdue}
      />

      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-6">
        <QuickAdd
          onAdd={actions.handleQuickAdd}
          onOpenAddForm={(title) => {
            window.dispatchEvent(new CustomEvent('open-add-form', { detail: { title } }))
          }}
        />

        <LabelFilterBar
          tasks={allTasks}
          selectedLabels={selectedLabels}
          onToggleLabel={onToggleLabel}
          onClearAll={onClearLabels}
        />

        {searchQuery && (
          <div className="mb-4 text-sm text-zinc-500">
            {searchResultCount} result{searchResultCount !== 1 ? 's' : ''} for &ldquo;
            {searchQuery}&rdquo;
          </div>
        )}

        {selectedLabels.length > 0 && (
          <div className="text-muted-foreground mb-4 rounded-md bg-blue-50 px-3 py-2 text-sm dark:bg-blue-950/30">
            Showing {tasks.length} of {allTasks.length} tasks <span className="mx-1">&middot;</span>
            <button onClick={onClearLabels} className="text-foreground font-medium hover:underline">
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
        onPriorityChange={(delta) => {
          // Priority up: set to high (3), down: set to low (1)
          const priority = delta > 0 ? 3 : 1
          onBulkAction('/api/tasks/bulk/edit', {
            ids: [...selection.selectedIds],
            changes: { priority },
          })
        }}
        onMoveToProject={() => onShowProjectPicker(true)}
        onClear={selection.clear}
      />

      <SnoozeAllFab
        overdueCount={overdueCount}
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
        onDateSave={onQuickActionDateSave}
      />
    </div>
  )
}
