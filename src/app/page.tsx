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

function HomeContent() {
  const { data: session, status } = useSession()
  const router = useRouter()
  const selection = useSelection()
  const [tasks, setTasks] = useState<Task[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [snoozeTask, setSnoozeTask] = useState<Task | null>(null)
  const [bulkSnoozeCustom, setBulkSnoozeCustom] = useState(false)
  const [showProjectPicker, setShowProjectPicker] = useState(false)
  const [grouping, setGrouping] = useState<GroupingMode>('time')
  const [searchQuery, setSearchQuery] = useState<string | null>(null)
  const [searchResults, setSearchResults] = useState<Task[]>([])

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

  const fetchTasks = useCallback(async () => {
    try {
      const res = await fetch('/api/tasks?limit=500')
      if (res.status === 401) {
        router.push('/login')
        return
      }
      if (!res.ok) {
        throw new Error('Failed to fetch tasks')
      }
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

  useEffect(() => {
    if (status === 'loading') return
    if (status === 'unauthenticated') {
      router.push('/login')
      return
    }
    fetchTasks()
    fetchProjects()
  }, [status, router, fetchTasks, fetchProjects])

  // Listen for task-created events from AddTaskForm in AppLayout
  useEffect(() => {
    const handler = () => fetchTasks()
    window.addEventListener('task-created', handler)
    return () => window.removeEventListener('task-created', handler)
  }, [fetchTasks])

  // Escape exits selection mode
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && selection.isSelectionMode) {
        selection.clear()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [selection])

  const handleDone = async (taskId: number) => {
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
  }

  const handleSnooze = async (taskId: number, until: string) => {
    const task = tasks.find((t) => t.id === taskId)
    if (!task) return

    setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, due_at: until } : t)))
    setSnoozeTask(null)

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
  }

  const handleUndo = async () => {
    try {
      const res = await fetch('/api/undo', { method: 'POST' })
      if (!res.ok) throw new Error('Failed to undo')
      fetchTasks()
    } catch {
      showToast({ message: 'Undo failed' })
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

  const handleSearchClear = () => {
    setSearchQuery(null)
    setSearchResults([])
  }

  const handleQuickAdd = async (title: string) => {
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
  }

  // Bulk action helpers
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
      showToast({ message: 'Tasks deleted', action: { label: 'Undo', onClick: handleUndo } })
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
      showToast({ message: `${count} tasks moved`, action: { label: 'Undo', onClick: handleUndo } })
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

  const getSnoozeTime = (option: '+1h' | '+2h' | 'tomorrow'): string => {
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
    // tomorrow 9am
    const t = new Date(now)
    t.setDate(t.getDate() + 1)
    t.setHours(9, 0, 0, 0)
    return t.toISOString()
  }

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
    <div className="flex flex-1 flex-col">
      <Header
        taskCount={tasks.length}
        overdueCount={overdueCount}
        todayCount={todayCount}
        grouping={grouping}
        onGroupingChange={setGrouping}
        onUndo={handleUndo}
        onSearch={handleSearch}
        onSearchClear={handleSearchClear}
        userName={session?.user?.name || undefined}
      />

      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-6">
        <QuickAdd onAdd={handleQuickAdd} />

        {searchQuery && (
          <div className="mb-4 text-sm text-zinc-500">
            {searchResults.length} result{searchResults.length !== 1 ? 's' : ''} for &ldquo;
            {searchQuery}&rdquo;
          </div>
        )}

        <TaskList
          tasks={searchQuery ? searchResults : tasks}
          projects={projects}
          grouping={searchQuery ? 'time' : grouping}
          onDone={handleDone}
          onSnooze={(task) => setSnoozeTask(task)}
          onSwipeSnooze={handleSnooze}
        />
      </main>

      {/* Floating Action Bar for bulk selection */}
      <FloatingActionBar
        selectedCount={selection.selectedIds.size}
        onDone={() => bulkAction('/api/tasks/bulk/done', { ids: [...selection.selectedIds] })}
        onSnooze1h={() =>
          bulkAction('/api/tasks/bulk/snooze', {
            ids: [...selection.selectedIds],
            until: getSnoozeTime('+1h'),
          })
        }
        onSnooze2h={() =>
          bulkAction('/api/tasks/bulk/snooze', {
            ids: [...selection.selectedIds],
            until: getSnoozeTime('+2h'),
          })
        }
        onSnoozeTomorrow={() =>
          bulkAction('/api/tasks/bulk/snooze', {
            ids: [...selection.selectedIds],
            until: getSnoozeTime('tomorrow'),
          })
        }
        onDelete={bulkDelete}
        onPriorityHigh={() =>
          bulkAction('/api/tasks/bulk/edit', {
            ids: [...selection.selectedIds],
            changes: { priority: 3 },
          })
        }
        onPriorityLow={() =>
          bulkAction('/api/tasks/bulk/edit', {
            ids: [...selection.selectedIds],
            changes: { priority: 1 },
          })
        }
        onClear={selection.clear}
        onMoveToProject={() => setShowProjectPicker(true)}
        onCustomSnooze={() => setBulkSnoozeCustom(true)}
      />

      {snoozeTask && (
        <SnoozeSheet
          task={snoozeTask}
          onSnooze={(until) => handleSnooze(snoozeTask.id, until)}
          onClose={() => setSnoozeTask(null)}
        />
      )}

      {showProjectPicker && (
        <ProjectPickerSheet
          projects={projects}
          onSelect={handleBulkMoveToProject}
          onClose={() => setShowProjectPicker(false)}
        />
      )}

      {bulkSnoozeCustom && (
        <SnoozeSheet
          task={{ id: 0, title: `${selection.selectedIds.size} selected tasks` } as Task}
          onSnooze={handleBulkCustomSnooze}
          onClose={() => setBulkSnoozeCustom(false)}
          customOnly
        />
      )}
    </div>
  )
}
