'use client'

import { useState, useEffect, useCallback } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter, useParams } from 'next/navigation'
import { MoreHorizontal, X } from 'lucide-react'
import { TaskList } from '@/components/TaskList'
import { FilterBar } from '@/components/FilterBar'
import { Header } from '@/components/Header'
import { BatchUndoDialog } from '@/components/BatchUndoDialog'
import { QuickActionPopover, useQuickActionShortcut } from '@/components/QuickActionPopover'
import { Button } from '@/components/ui/button'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import type { Task, Project, LabelColor } from '@/types'
import { showToast } from '@/lib/toast'
import { useTaskActions } from '@/hooks/useTaskActions'
import type { ListTaskActionsReturn } from '@/hooks/useTaskActions'
import { useUndoRedoShortcuts } from '@/hooks/useUndoRedoShortcuts'
import { useFilterState } from '@/hooks/useFilterState'
import { useTimezone } from '@/hooks/useTimezone'
import { useSnoozePreferences } from '@/components/PreferencesProvider'
import { useTaskCounts } from '@/hooks/useTaskCounts'
import { useSnoozeOverdue } from '@/hooks/useSnoozeOverdue'
import { useAiInsights } from '@/hooks/useAiInsights'
import { LABEL_COLORS, LABEL_COLOR_NAMES } from '@/lib/label-colors'
import { cn } from '@/lib/utils'

export default function ProjectDetailPage() {
  const { status } = useSession()
  const router = useRouter()
  const params = useParams()
  const projectId = params.id as string

  const [tasks, setTasks] = useState<Task[]>([])
  const [project, setProject] = useState<Project | null>(null)
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
    attributeFilters,
    toggleLabel,
    togglePriority,
    toggleDateFilter,
    toggleAttribute,
    exclusiveAttribute,
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

    // Fetch project details
    fetch('/api/projects')
      .then((r) => r.json())
      .then((data) => {
        const projects = data.data?.projects || []
        const found = projects.find((p: Project) => p.id === parseInt(projectId))
        if (found) setProject(found)
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

  const handleReprocess = useCallback(
    async (taskId: number) => {
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
        fetchTasks()
        showToast({ message: 'Failed to retry enrichment', type: 'error' })
      }
    },
    [setTasks, fetchTasks],
  )

  const handleDelete = useCallback(
    async (taskId: number) => {
      try {
        const res = await fetch(`/api/tasks/${taskId}`, { method: 'DELETE' })
        if (!res.ok) throw new Error('Failed to delete')
        fetchTasks()
        showToast({
          message: 'Task moved to trash',
          type: 'success',
          action: { label: 'Undo', onClick: actions.handleUndo },
        })
      } catch {
        showToast({ message: 'Delete failed', type: 'error' })
      }
    },
    [fetchTasks, actions.handleUndo],
  )

  const { overdueCount, todayCount } = useTaskCounts(tasks, timezone)

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
        title={project?.name || 'Project'}
        headerAction={
          project && (
            <ProjectColorPicker
              color={project.color}
              onColorChange={(color) => {
                setProject((prev) => (prev ? { ...prev, color } : prev))
                fetch(`/api/projects/${projectId}`, {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ color }),
                }).catch(() => {
                  showToast({ message: 'Failed to update color', type: 'error' })
                })
              }}
            />
          )
        }
        taskCount={tasks.length}
        overdueCount={overdueCount}
        todayCount={todayCount}
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
          attributeFilters={attributeFilters}
          onToggleAttribute={toggleAttribute}
          onExclusiveAttribute={exclusiveAttribute}
          timezone={timezone}
        />
        <TaskList
          tasks={displayTasks}
          onDone={actions.handleDone}
          onSnooze={actions.handleSnooze}
          onLabelClick={toggleLabel}
          onTaskFocus={setFocusedTask}
          onReprocess={handleReprocess}
        />
      </main>

      <QuickActionPopover
        focusedTask={focusedTask}
        open={quickActionOpen}
        onClose={() => setQuickActionOpen(false)}
        onSaveAll={actions.handleSaveAllChanges}
        onDelete={handleDelete}
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

function ProjectColorPicker({
  color,
  onColorChange,
}: {
  color: LabelColor | null
  onColorChange: (color: LabelColor | null) => void
}) {
  const [open, setOpen] = useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 flex-shrink-0"
          aria-label="Project color"
        >
          {color ? (
            <span className={cn('size-3 rounded-full', LABEL_COLORS[color].dot)} />
          ) : (
            <MoreHorizontal className="size-4" />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-3" sideOffset={6}>
        <div className="grid grid-cols-4 gap-2">
          {LABEL_COLOR_NAMES.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => {
                onColorChange(c)
                setOpen(false)
              }}
              className={cn(
                'flex size-8 items-center justify-center rounded-full transition-transform hover:scale-110',
                color === c && 'ring-ring ring-2 ring-offset-2',
              )}
              title={LABEL_COLORS[c].display}
              aria-label={LABEL_COLORS[c].display}
            >
              <span className={cn('size-5 rounded-full', LABEL_COLORS[c].dot)} />
            </button>
          ))}
        </div>
        {color && (
          <button
            type="button"
            onClick={() => {
              onColorChange(null)
              setOpen(false)
            }}
            className="text-muted-foreground hover:text-foreground mt-2 flex w-full items-center justify-center gap-1 text-xs transition-colors"
          >
            <X className="size-3" />
            None
          </button>
        )}
      </PopoverContent>
    </Popover>
  )
}
