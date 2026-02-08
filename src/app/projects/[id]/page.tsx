'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter, useParams } from 'next/navigation'
import { TaskList } from '@/components/TaskList'
import { FilterBar } from '@/components/FilterBar'
import { Header } from '@/components/Header'
import { BatchUndoDialog } from '@/components/BatchUndoDialog'
import { QuickActionPopover, useQuickActionShortcut } from '@/components/QuickActionPopover'
import type { Task } from '@/types'
import { useTaskActions } from '@/hooks/useTaskActions'
import type { ListTaskActionsReturn } from '@/hooks/useTaskActions'
import { useUndoRedoShortcuts } from '@/hooks/useUndoRedoShortcuts'
import { useFilterState } from '@/hooks/useFilterState'
import { useTimezone } from '@/hooks/useTimezone'
import { showToast } from '@/lib/toast'
import { computeSnoozeTime } from '@/lib/snooze'
import { useSnoozePreferences } from '@/components/LabelConfigProvider'
import { HIGH_PRIORITY_THRESHOLD } from '@/lib/priority'
import { taskWord } from '@/lib/utils'

export default function ProjectDetailPage() {
  const { status } = useSession()
  const router = useRouter()
  const params = useParams()
  const projectId = params.id as string

  const [tasks, setTasks] = useState<Task[]>([])
  const [projectName, setProjectName] = useState('')
  const [loading, setLoading] = useState(true)
  const timezone = useTimezone()
  const [focusedTask, setFocusedTask] = useState<Task | null>(null)
  const [quickActionOpen, setQuickActionOpen] = useState(false)
  const [batchDialogOpen, setBatchDialogOpen] = useState(false)
  const [batchDialogMode, setBatchDialogMode] = useState<'undo' | 'redo'>('undo')
  const { defaultSnoozeOption, morningTime } = useSnoozePreferences()

  useQuickActionShortcut(focusedTask, setQuickActionOpen, quickActionOpen)

  const {
    selectedLabels,
    selectedPriorities,
    selectedDateFilters,
    toggleLabel,
    togglePriority,
    toggleDateFilter,
    clearAllFilters,
    filteredTasks: displayTasks,
  } = useFilterState({ tasks, timezone })

  // Clear filters when navigating between projects (App Router reuses this component instance)
  useEffect(() => {
    clearAllFilters()
  }, [projectId, clearAllFilters])

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

  const snoozableOverdueCount = useMemo(() => {
    const now = new Date()
    return displayTasks.filter(
      (t) => t.due_at && new Date(t.due_at) < now && (t.priority ?? 0) < HIGH_PRIORITY_THRESHOLD,
    ).length
  }, [displayTasks])

  const handleSnoozeAllOverdue = useCallback(
    async (until?: string) => {
      const now = new Date()
      const overdueTasks = displayTasks.filter((t) => t.due_at && new Date(t.due_at) < now)

      if (overdueTasks.length === 0) {
        showToast({ message: 'No overdue tasks' })
        return
      }

      const snoozeUntil = until ?? computeSnoozeTime(defaultSnoozeOption, timezone, morningTime)

      try {
        const res = await fetch('/api/tasks/bulk/snooze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ids: overdueTasks.map((t) => t.id),
            until: snoozeUntil,
          }),
        })
        if (!res.ok) throw new Error('Snooze failed')
        const responseData = await res.json()
        const tasksAffected = responseData.data?.tasks_affected ?? 0
        const tasksSkipped = responseData.data?.tasks_skipped ?? 0
        fetchTasks()
        const skippedMsg = tasksSkipped > 0 ? ` (${tasksSkipped} high/urgent skipped)` : ''
        showToast({
          message: `${tasksAffected} overdue ${taskWord(tasksAffected)} snoozed${skippedMsg}`,
          action: { label: 'Undo', onClick: actions.handleUndo },
        })
      } catch {
        showToast({ message: 'Snooze failed' })
      }
    },
    [displayTasks, fetchTasks, actions.handleUndo, timezone, defaultSnoozeOption, morningTime],
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
      <Header
        backHref="/projects"
        title={projectName || 'Project'}
        taskCount={tasks.length}
        overdueCount={overdueCount}
        todayCount={todayCount}
        snoozableOverdueCount={snoozableOverdueCount}
        onUndo={actions.handleUndo}
        onRedo={actions.handleRedo}
        undoCount={actions.undoCount}
        redoCount={actions.redoCount}
        onBatchUndo={() => {
          setBatchDialogMode('undo')
          setBatchDialogOpen(true)
        }}
        onBatchRedo={() => {
          setBatchDialogMode('redo')
          setBatchDialogOpen(true)
        }}
        onSnoozeOverdue={handleSnoozeAllOverdue}
      />

      <main className="mx-auto w-full max-w-2xl px-4 py-6">
        <FilterBar
          tasks={tasks}
          selectedPriorities={selectedPriorities}
          selectedLabels={selectedLabels}
          selectedDateFilters={selectedDateFilters}
          onTogglePriority={togglePriority}
          onToggleLabel={toggleLabel}
          onToggleDateFilter={toggleDateFilter}
          onClearAll={clearAllFilters}
          timezone={timezone}
        />
        <TaskList
          tasks={displayTasks}
          onDone={actions.handleDone}
          onSnooze={actions.handleSnooze}
          onLabelClick={toggleLabel}
          onTaskFocus={setFocusedTask}
        />
      </main>

      <QuickActionPopover
        focusedTask={focusedTask}
        open={quickActionOpen}
        onClose={() => setQuickActionOpen(false)}
        onSaveAll={actions.handleSaveAllChanges}
      />

      <BatchUndoDialog
        open={batchDialogOpen}
        onOpenChange={setBatchDialogOpen}
        mode={batchDialogMode}
        count={batchDialogMode === 'undo' ? actions.undoCount : actions.redoCount}
        onConfirm={() => {
          setBatchDialogOpen(false)
          if (batchDialogMode === 'undo') {
            actions.handleBatchUndo()
          } else {
            actions.handleBatchRedo()
          }
        }}
      />
    </div>
  )
}
