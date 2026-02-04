'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter, useParams } from 'next/navigation'
import { X } from 'lucide-react'
import { TaskList } from '@/components/TaskList'
import { LabelFilterBar } from '@/components/LabelFilterBar'
import { PriorityFilterBar } from '@/components/PriorityFilterBar'
import { SnoozeSheet } from '@/components/SnoozeSheet'
import { QuickActionPopover, useQuickActionShortcut } from '@/components/QuickActionPopover'
import { showToast } from '@/lib/toast'
import type { Task } from '@/types'

/**
 * Combined filter bar for priority and label filters.
 * Priority badges (square) appear first, then a gray separator, then label badges (pill).
 */
function FilterBar({
  tasks,
  selectedPriorities,
  selectedLabels,
  onTogglePriority,
  onToggleLabel,
  onClearAll,
}: {
  tasks: Task[]
  selectedPriorities: number[]
  selectedLabels: string[]
  onTogglePriority: (priority: number) => void
  onToggleLabel: (label: string) => void
  onClearAll: () => void
}) {
  const hasPriorities = tasks.some((t) => t.priority !== undefined)
  const hasLabels = tasks.some((t) => t.labels.length > 0)

  if (!hasPriorities && !hasLabels) return null

  const hasSelection = selectedPriorities.length > 0 || selectedLabels.length > 0

  return (
    <div className="relative mb-4 flex items-center">
      <div className="scrollbar-hide flex flex-1 items-center gap-2 overflow-x-auto pr-8">
        <PriorityFilterBar
          tasks={tasks}
          selectedPriorities={selectedPriorities}
          onTogglePriority={onTogglePriority}
        />

        {hasPriorities && hasLabels && <div className="bg-border mx-1 h-4 w-px flex-shrink-0" />}

        <LabelFilterBar
          tasks={tasks}
          selectedLabels={selectedLabels}
          onToggleLabel={onToggleLabel}
        />
      </div>

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

export default function ProjectDetailPage() {
  const { status } = useSession()
  const router = useRouter()
  const params = useParams()
  const projectId = params.id as string

  const [tasks, setTasks] = useState<Task[]>([])
  const [projectName, setProjectName] = useState('')
  const [loading, setLoading] = useState(true)
  const [snoozeTask, setSnoozeTask] = useState<Task | null>(null)
  const [selectedLabels, setSelectedLabels] = useState<string[]>([])
  const [selectedPriorities, setSelectedPriorities] = useState<number[]>([])
  const [focusedTask, setFocusedTask] = useState<Task | null>(null)
  const [quickActionOpen, setQuickActionOpen] = useState(false)

  useQuickActionShortcut(focusedTask, setQuickActionOpen, quickActionOpen)

  const toggleLabel = useCallback((label: string) => {
    setSelectedLabels((prev) =>
      prev.includes(label) ? prev.filter((l) => l !== label) : [...prev, label],
    )
  }, [])

  const togglePriority = useCallback((priority: number) => {
    setSelectedPriorities((prev) =>
      prev.includes(priority) ? prev.filter((p) => p !== priority) : [...prev, priority],
    )
  }, [])

  const clearAllFilters = useCallback(() => {
    setSelectedLabels([])
    setSelectedPriorities([])
  }, [])

  const displayTasks = useMemo(() => {
    let filtered = tasks
    if (selectedLabels.length > 0) {
      filtered = filtered.filter((t) => t.labels.some((l) => selectedLabels.includes(l)))
    }
    if (selectedPriorities.length > 0) {
      filtered = filtered.filter((t) => selectedPriorities.includes(t.priority ?? 0))
    }
    return filtered
  }, [tasks, selectedLabels, selectedPriorities])

  const fetchTasks = useCallback(async () => {
    try {
      const res = await fetch(`/api/tasks?project=${projectId}&limit=500`)
      if (!res.ok) throw new Error('Failed to fetch')
      const data = await res.json()
      setTasks(data.data?.tasks || [])
    } catch {
      // Handled silently
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    if (status === 'loading') return
    if (status === 'unauthenticated') {
      router.push('/login')
      return
    }

    fetchTasks()

    // Fetch project name
    fetch('/api/projects')
      .then((r) => r.json())
      .then((data) => {
        const projects = data.data?.projects || []
        const project = projects.find((p: { id: number }) => p.id === parseInt(projectId))
        if (project) setProjectName(project.name)
      })
      .catch(() => {})
  }, [status, router, projectId, fetchTasks])

  const handleUndo = async () => {
    try {
      await fetch('/api/undo', { method: 'POST' })
      fetchTasks()
    } catch {
      showToast({ message: 'Undo failed' })
    }
  }

  const handleDone = async (taskId: number) => {
    const task = tasks.find((t) => t.id === taskId)
    if (!task) return
    if (!task.rrule) {
      setTasks((prev) => prev.filter((t) => t.id !== taskId))
    }
    try {
      const res = await fetch(`/api/tasks/${taskId}/done`, { method: 'POST' })
      if (!res.ok) throw new Error('Failed')
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
    setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, due_at: until } : t)))
    setSnoozeTask(null)
    try {
      const res = await fetch(`/api/tasks/${taskId}/snooze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ until }),
      })
      if (!res.ok) throw new Error('Failed')
      fetchTasks()
      showToast({ message: 'Task snoozed', action: { label: 'Undo', onClick: handleUndo } })
    } catch {
      fetchTasks()
    }
  }

  if (status === 'loading' || loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="animate-pulse text-zinc-500">Loading...</div>
      </div>
    )
  }

  return (
    <div className="flex-1">
      <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white/80 backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-950/80">
        <div className="mx-auto flex max-w-2xl items-center gap-3 px-4 py-3">
          <button
            onClick={() => router.push('/projects')}
            className="-ml-2 rounded-lg p-2 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            aria-label="Back to projects"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M19 12H5" />
              <path d="M12 19l-7-7 7-7" />
            </svg>
          </button>
          <h1 className="text-xl font-semibold">{projectName || 'Project'}</h1>
          <span className="text-sm text-zinc-500">{tasks.length} tasks</span>
        </div>
      </header>

      <main className="mx-auto w-full max-w-2xl px-4 py-6">
        <FilterBar
          tasks={tasks}
          selectedPriorities={selectedPriorities}
          selectedLabels={selectedLabels}
          onTogglePriority={togglePriority}
          onToggleLabel={toggleLabel}
          onClearAll={clearAllFilters}
        />
        <TaskList
          tasks={displayTasks}
          onDone={handleDone}
          onSnooze={(task) => setSnoozeTask(task)}
          onLabelClick={toggleLabel}
          onTaskFocus={setFocusedTask}
        />
      </main>

      {snoozeTask && (
        <SnoozeSheet
          task={snoozeTask}
          onSnooze={(until) => handleSnooze(snoozeTask.id, until)}
          onClose={() => setSnoozeTask(null)}
        />
      )}

      <QuickActionPopover
        focusedTask={focusedTask}
        open={quickActionOpen}
        onClose={() => setQuickActionOpen(false)}
        onDateSave={handleSnooze}
      />
    </div>
  )
}
