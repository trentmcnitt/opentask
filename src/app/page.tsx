'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { TaskList } from '@/components/TaskList'
import type { GroupingMode } from '@/components/TaskList'
import { Header } from '@/components/Header'
import { QuickAdd } from '@/components/QuickAdd'
import { SnoozeSheet } from '@/components/SnoozeSheet'
import { SelectionProvider, useSelection } from '@/components/SelectionProvider'
import { FloatingActionBar } from '@/components/FloatingActionBar'
import { ProjectPickerSheet } from '@/components/ProjectPickerSheet'
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
  setBulkSnoozeCustom: (show: boolean) => void,
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

  const handleBulkCustomSnooze = async (until: string) => {
    const count = selection.selectedIds.size
    setBulkSnoozeCustom(false)
    try {
      const res = await fetch('/api/tasks/bulk/snooze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [...selection.selectedIds], until }),
      })
      if (!res.ok) throw new Error('Snooze failed')
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

  return { bulkAction, bulkDelete, handleBulkMoveToProject, handleBulkCustomSnooze, handleSearch }
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
  const [bulkSnoozeCustom, setBulkSnoozeCustom] = useState(false)
  const [showProjectPicker, setShowProjectPicker] = useState(false)
  const [grouping, setGrouping] = useState<GroupingMode>('time')
  const [searchQuery, setSearchQuery] = useState<string | null>(null)
  const [searchResults, setSearchResults] = useState<Task[]>([])

  const bulk = useBulkActions(
    selection,
    fetchTasks,
    actions.handleUndo,
    setShowProjectPicker,
    setBulkSnoozeCustom,
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
      tasks={searchQuery ? searchResults : tasks}
      projects={projects}
      grouping={searchQuery ? 'time' : grouping}
      searchQuery={searchQuery}
      searchResultCount={searchResults.length}
      overdueCount={overdueCount}
      todayCount={todayCount}
      selection={selection}
      snoozeTask={snoozeTask}
      showProjectPicker={showProjectPicker}
      bulkSnoozeCustom={bulkSnoozeCustom}
      actions={actions}
      onGroupingChange={setGrouping}
      onSearch={bulk.handleSearch}
      onSearchClear={() => {
        setSearchQuery(null)
        setSearchResults([])
      }}
      onSnoozeTask={setSnoozeTask}
      onBulkAction={bulk.bulkAction}
      onBulkDelete={bulk.bulkDelete}
      onBulkMoveToProject={bulk.handleBulkMoveToProject}
      onBulkCustomSnooze={bulk.handleBulkCustomSnooze}
      onShowProjectPicker={setShowProjectPicker}
      onBulkSnoozeCustom={setBulkSnoozeCustom}
    />
  )
}

function DashboardView({
  session,
  tasks,
  projects,
  grouping,
  searchQuery,
  searchResultCount,
  overdueCount,
  todayCount,
  selection,
  snoozeTask,
  showProjectPicker,
  bulkSnoozeCustom,
  actions,
  onGroupingChange,
  onSearch,
  onSearchClear,
  onSnoozeTask,
  onBulkAction,
  onBulkDelete,
  onBulkMoveToProject,
  onBulkCustomSnooze,
  onShowProjectPicker,
  onBulkSnoozeCustom,
}: {
  session: ReturnType<typeof useSession>['data']
  tasks: Task[]
  projects: Project[]
  grouping: GroupingMode
  searchQuery: string | null
  searchResultCount: number
  overdueCount: number
  todayCount: number
  selection: ReturnType<typeof useSelection>
  snoozeTask: Task | null
  showProjectPicker: boolean
  bulkSnoozeCustom: boolean
  actions: ReturnType<typeof useTaskActions>
  onGroupingChange: (g: GroupingMode) => void
  onSearch: (q: string) => void
  onSearchClear: () => void
  onSnoozeTask: (t: Task | null) => void
  onBulkAction: (endpoint: string, body: Record<string, unknown>) => void
  onBulkDelete: () => void
  onBulkMoveToProject: (projectId: number) => void
  onBulkCustomSnooze: (until: string) => void
  onShowProjectPicker: (show: boolean) => void
  onBulkSnoozeCustom: (show: boolean) => void
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
      />

      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-6">
        <QuickAdd onAdd={actions.handleQuickAdd} />

        {searchQuery && (
          <div className="mb-4 text-sm text-zinc-500">
            {searchResultCount} result{searchResultCount !== 1 ? 's' : ''} for &ldquo;
            {searchQuery}&rdquo;
          </div>
        )}

        <TaskList
          tasks={tasks}
          projects={projects}
          grouping={grouping}
          onDone={actions.handleDone}
          onSnooze={(task) => onSnoozeTask(task)}
          onSwipeSnooze={actions.handleSnooze}
        />
      </main>

      <FloatingActionBar
        selectedCount={selection.selectedIds.size}
        onDone={() => onBulkAction('/api/tasks/bulk/done', { ids: [...selection.selectedIds] })}
        onSnooze1h={() =>
          onBulkAction('/api/tasks/bulk/snooze', {
            ids: [...selection.selectedIds],
            until: getSnoozeTime('+1h'),
          })
        }
        onSnooze2h={() =>
          onBulkAction('/api/tasks/bulk/snooze', {
            ids: [...selection.selectedIds],
            until: getSnoozeTime('+2h'),
          })
        }
        onSnoozeTomorrow={() =>
          onBulkAction('/api/tasks/bulk/snooze', {
            ids: [...selection.selectedIds],
            until: getSnoozeTime('tomorrow'),
          })
        }
        onDelete={onBulkDelete}
        onPriorityHigh={() =>
          onBulkAction('/api/tasks/bulk/edit', {
            ids: [...selection.selectedIds],
            changes: { priority: 3 },
          })
        }
        onPriorityLow={() =>
          onBulkAction('/api/tasks/bulk/edit', {
            ids: [...selection.selectedIds],
            changes: { priority: 1 },
          })
        }
        onClear={selection.clear}
        onMoveToProject={() => onShowProjectPicker(true)}
        onCustomSnooze={() => onBulkSnoozeCustom(true)}
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

      {bulkSnoozeCustom && (
        <SnoozeSheet
          task={{ id: 0, title: `${selection.selectedIds.size} selected tasks` } as Task}
          onSnooze={onBulkCustomSnooze}
          onClose={() => onBulkSnoozeCustom(false)}
          customOnly
        />
      )}
    </div>
  )
}
