'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter, useParams } from 'next/navigation'
import { ChevronLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { TaskList } from '@/components/TaskList'
import { FilterBar } from '@/components/FilterBar'
import { SnoozeSheet } from '@/components/SnoozeSheet'
import { QuickActionPopover, useQuickActionShortcut } from '@/components/QuickActionPopover'
import type { Task } from '@/types'
import { useTaskActions } from '@/hooks/useTaskActions'
import type { ListTaskActionsReturn } from '@/hooks/useTaskActions'
import { useUndoRedoShortcuts } from '@/hooks/useUndoRedoShortcuts'

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

  const actions = useTaskActions({
    mode: 'list',
    onRefresh: fetchTasks,
    tasks,
    setTasks,
  }) as ListTaskActionsReturn

  useUndoRedoShortcuts(actions.handleUndoRef, actions.handleRedoRef)

  // Wrap snooze to also close the snooze sheet
  const handleSnooze = useCallback(
    (taskId: number, until: string) => {
      setSnoozeTask(null)
      actions.handleSnooze(taskId, until)
    },
    [actions.handleSnooze],
  )

  if (status === 'loading' || loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="animate-pulse text-zinc-500">Loading...</div>
      </div>
    )
  }

  return (
    <div className="flex-1">
      <header className="bg-background/80 sticky top-0 z-10 border-b backdrop-blur-sm">
        <div className="mx-auto flex max-w-2xl items-center gap-3 px-4 py-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => router.push('/projects')}
            aria-label="Back to projects"
            className="-ml-2"
          >
            <ChevronLeft className="size-5" />
          </Button>
          <h1 className="text-xl font-semibold">{projectName || 'Project'}</h1>
          <span className="text-muted-foreground text-sm">{tasks.length} tasks</span>
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
          onDone={actions.handleDone}
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
        onSaveAll={actions.handleSaveAllChanges}
      />
    </div>
  )
}
