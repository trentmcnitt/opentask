'use client'

import { useState, useEffect, useCallback } from 'react'
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
import { useSnoozePreferences } from '@/components/PreferencesProvider'
import { useTaskCounts } from '@/hooks/useTaskCounts'
import { useSnoozeOverdue } from '@/hooks/useSnoozeOverdue'
import { useAiInsights } from '@/hooks/useAiInsights'

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
  const { annotationMap } = useAiInsights(tasks)

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

  const { overdueCount, todayCount, snoozableOverdueCount } = useTaskCounts(
    tasks,
    displayTasks,
    timezone,
  )

  const handleSnoozeAllOverdue = useSnoozeOverdue({
    displayTasks,
    fetchTasks,
    handleUndo: actions.handleUndo,
    timezone,
    defaultSnoozeOption,
    morningTime,
  })

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
        timezone={timezone}
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
        annotation={focusedTask ? annotationMap.get(focusedTask.id) : undefined}
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
