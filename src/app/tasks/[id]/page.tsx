'use client'

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter, useParams } from 'next/navigation'
import { ChevronLeft, Undo2, Redo2, Menu, Settings } from 'lucide-react'
import { TaskDetail } from '@/components/TaskDetail'
import { ReminderDetail } from '@/components/ReminderDetail'
import { QuotaDetail } from '@/components/QuotaDetail'
import { isTracked } from '@/lib/track'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import type { Task, Project } from '@/types'
import { GuardedLink } from '@/components/GuardedLink'
import { useNavigationGuard } from '@/components/NavigationGuardProvider'
import { showToast } from '@/lib/toast'
import { loginUrlFromLocation } from '@/lib/login-redirect'
import { useTaskActions } from '@/hooks/useTaskActions'
import type { SingleTaskActionsReturn } from '@/hooks/useTaskActions'
import { useAiInsights } from '@/hooks/useAiInsights'
import { useInsightsData } from '@/hooks/useInsightsData'
import { useUndoRedoShortcuts } from '@/hooks/useUndoRedoShortcuts'
import { useSyncStream, type EnrichmentCompleteData } from '@/hooks/useSyncStream'

export default function TaskDetailPage() {
  const { status } = useSession()
  const router = useRouter()
  const params = useParams()
  const taskId = params.id as string

  const [task, setTask] = useState<Task | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const taskArray = useMemo(() => (task ? [task] : []), [task])
  const { annotationMap } = useAiInsights(taskArray)
  const insightsData = useInsightsData(taskArray)

  // Navigation guard: bridge dirty state to the app-level navigation guard context
  // so sidebar/bottom tab links show a confirmation dialog before navigating away.
  const { setDirty, pendingNavigation, requestNavigation, clearPendingNavigation } =
    useNavigationGuard()
  const saveRef = useRef<(() => Promise<void> | void) | null>(null)

  const isDirtyRef = useRef(false)
  const pendingRefreshRef = useRef(false)
  // Rendered state for the reminder card's dirty stripe (the ref above is for
  // the refresh logic and does not re-render).
  const [panelDirty, setPanelDirty] = useState(false)

  // Clean up guard registration on unmount
  useEffect(() => {
    return () => setDirty(false)
  }, [setDirty])

  // Where "back" (and "done", and "deleted") lead: a reminder's home is the
  // Reminders surface, a task's is the Tasks page. Trent (2026-09-05): back
  // from a reminder's details landed on Tasks. Read through a ref so the
  // callbacks handed to useTaskActions see the task after it loads.
  const homeRef = useRef('/')
  homeRef.current = task?.is_reminder ? '/reminders' : task && isTracked(task) ? '/quotas' : '/'

  const handleBackClick = useCallback(() => {
    if (requestNavigation(homeRef.current)) {
      router.push(homeRef.current)
    }
  }, [requestNavigation, router])

  const handleConfirmLeave = useCallback(() => {
    const href = pendingNavigation ?? homeRef.current
    clearPendingNavigation()
    router.push(href)
  }, [pendingNavigation, clearPendingNavigation, router])

  // Use a ref to access the shared undo handler in the save-and-leave callback,
  // since actions is created after this callback in the hook order.
  const handleUndoRef = useRef<(() => Promise<void>) | null>(null)

  const handleSaveAndLeave = useCallback(async () => {
    try {
      await saveRef.current?.()
      showToast({
        message: 'Changes saved',
        type: 'success',
        action: {
          label: 'Undo',
          onClick: async () => {
            await handleUndoRef.current?.()
            window.location.reload()
          },
        },
      })
    } catch {
      showToast({ message: 'Save failed', type: 'error' })
      clearPendingNavigation()
      return
    }
    const href = pendingNavigation ?? homeRef.current
    clearPendingNavigation()
    router.push(href)
  }, [pendingNavigation, clearPendingNavigation, router])

  const numericTaskId = Number(taskId)

  // Full fetch (task + projects) for initial load and explicit user actions
  const fetchTask = useCallback(async () => {
    try {
      const [taskRes, projRes] = await Promise.all([
        fetch(`/api/tasks/${taskId}`),
        fetch('/api/projects'),
      ])

      if (taskRes.status === 401) {
        router.push(loginUrlFromLocation())
        return
      }
      if (taskRes.status === 404) {
        setError('Task not found')
        setLoading(false)
        return
      }
      if (!taskRes.ok) throw new Error('Failed to fetch task')

      const taskData = await taskRes.json()
      setTask(taskData.data as Task)

      if (projRes.ok) {
        const projData = await projRes.json()
        setProjects(projData.data?.projects || [])
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [taskId, router])

  // Task-only refresh for SSE sync events (projects rarely change)
  const refreshTask = useCallback(async () => {
    try {
      const res = await fetch(`/api/tasks/${taskId}`)
      if (!res.ok) return
      const data = await res.json()
      setTask(data.data as Task)
    } catch {
      // Silently ignore sync refresh failures — next sync will retry
    }
  }, [taskId])

  // Refresh or defer based on dirty state. When dirty, queues a refresh
  // that fires when the panel becomes clean (save or cancel).
  const refreshOrDefer = useCallback(() => {
    if (!isDirtyRef.current) {
      refreshTask()
    } else {
      pendingRefreshRef.current = true
    }
  }, [refreshTask])

  const handleDirtyChange = useCallback(
    (dirty: boolean) => {
      isDirtyRef.current = dirty
      setPanelDirty(dirty)
      setDirty(dirty)
      if (!dirty && pendingRefreshRef.current) {
        pendingRefreshRef.current = false
        refreshTask()
      }
    },
    [setDirty, refreshTask],
  )

  useEffect(() => {
    if (status === 'loading') return
    if (status === 'unauthenticated') {
      router.push(loginUrlFromLocation())
      return
    }
    fetchTask()
  }, [status, router, fetchTask])

  const actions = useTaskActions({
    mode: 'single',
    onRefresh: fetchTask,
    task,
    taskId,
    setTask,
    onCompletedNavigation: () => router.push(homeRef.current),
  }) as SingleTaskActionsReturn

  useUndoRedoShortcuts(actions.handleUndoRef, actions.handleRedoRef)

  // Real-time sync: refresh task data when changes arrive from other tabs/enrichment.
  // Defers refresh while the user has unsaved edits to avoid losing their work.
  const handleEnrichmentComplete = useCallback(
    (data: EnrichmentCompleteData) => {
      if (data.taskId !== numericTaskId) return
      refreshOrDefer()
      if (isDirtyRef.current) {
        showToast({ message: `AI enriched: ${data.title}`, type: 'success' })
      }
    },
    [refreshOrDefer, numericTaskId],
  )

  useSyncStream({
    onSync: refreshOrDefer,
    onEnrichmentComplete: handleEnrichmentComplete,
  })

  // Keep handleSaveAndLeave's undo ref in sync with the shared handler
  handleUndoRef.current = actions.handleUndo

  const handleDelete = async () => {
    if (!task) return
    try {
      const res = await fetch(`/api/tasks/${taskId}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Failed to delete')
      showToast({
        message: task.is_reminder
          ? 'Reminder moved to trash'
          : isTracked(task)
            ? 'Quota moved to trash'
            : 'Task moved to trash',
        type: 'success',
        action: { label: 'Undo', onClick: actions.handleUndo },
      })
      router.push(homeRef.current)
    } catch {
      showToast({ message: 'Delete failed', type: 'error' })
    }
  }

  // Considering a reminder from its page is a round trip: the thought is
  // done for today, so the page's job is done too and Reminders is where the
  // next one waits. (A task's Done stays on the page — the task may recur.)
  const handleConsidered = async () => {
    if (!task) return
    try {
      const res = await fetch(`/api/tasks/${taskId}/done`, { method: 'POST' })
      if (!res.ok) throw new Error('Failed to mark considered')
      actions.bumpUndoCount()
      showToast({
        message: `Considered \u201c${task.title}\u201d`,
        type: 'success',
        action: { label: 'Undo', onClick: actions.handleUndo },
      })
      router.push('/reminders')
    } catch {
      showToast({ message: 'Could not mark it considered', type: 'error' })
    }
  }

  if (status === 'loading' || loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="animate-pulse text-zinc-500">Loading...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-center">
          <div className="mb-4 text-red-500">{error}</div>
          <button
            onClick={() => router.push('/')}
            className="rounded-lg bg-zinc-100 px-4 py-2 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700"
          >
            Back to Dashboard
          </button>
        </div>
      </div>
    )
  }

  if (!task) return null

  const project = projects.find((p) => p.id === task.project_id)

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex-1">
        <header className="safe-top bg-background/80 sticky top-0 z-10 border-b backdrop-blur-sm">
          <div className="mx-auto flex max-w-2xl items-center gap-1.5 px-4 py-3">
            {/* Back button */}
            <Button
              variant="ghost"
              size="icon"
              onClick={handleBackClick}
              aria-label={
                task.is_reminder
                  ? 'Back to reminders'
                  : isTracked(task)
                    ? 'Back to quotas'
                    : 'Back to dashboard'
              }
              className="-ml-2"
            >
              <ChevronLeft className="size-5" />
            </Button>

            {/* Title - takes remaining space */}
            <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">
              {task.is_reminder ? 'Reminder' : isTracked(task) ? 'Quota' : 'Task Details'}
            </h1>

            {/* Undo button */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" onClick={actions.handleUndo} aria-label="Undo">
                  <Undo2 className="size-5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Undo (⌘Z)</TooltipContent>
            </Tooltip>

            {/* Redo button */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" onClick={actions.handleRedo} aria-label="Redo">
                  <Redo2 className="size-5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Redo (⌘⇧Z)</TooltipContent>
            </Tooltip>

            {/* Hamburger menu */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Menu">
                  <Menu className="size-5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem asChild>
                  <GuardedLink href="/settings">
                    <Settings className="size-4" />
                    Settings
                  </GuardedLink>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        <main className="mx-auto w-full max-w-2xl px-4 py-6">
          {isTracked(task) ? (
            /* A quota gets its own editor (§5). It used to fall through to the
               task editor, which showed it a due date, a snooze grid and a
               Done button — none of which mean anything for "four times a
               week", and all of which implied a debt the app never chases
               (Trent, 2026-09-06). */
            <div
              className={cn(
                'rounded-lg border p-3',
                panelDirty && '[box-shadow:inset_4px_0_0_rgb(59_130_246)]',
              )}
            >
              <QuotaDetail
                key={task.id}
                tasks={[task]}
                onSave={actions.handleSaveAllChanges}
                onDelete={handleDelete}
                onDirtyChange={handleDirtyChange}
                saveRef={saveRef}
              />
            </div>
          ) : task.is_reminder ? (
            /* A reminder gets its own editor (§6) — the same component the
               Reminders bar opens in a dialog — in the same card the task
               editor sits in, dirty stripe included. "Make this a task" flips
               the flag and this page becomes the task editor in place. */
            <div
              className={cn(
                'rounded-lg border p-3',
                panelDirty && '[box-shadow:inset_4px_0_0_rgb(59_130_246)]',
              )}
            >
              <ReminderDetail
                key={task.id}
                tasks={[task]}
                onSaveAll={actions.handleSaveAllChanges}
                onConsidered={handleConsidered}
                onDelete={handleDelete}
                onDirtyChange={handleDirtyChange}
                saveRef={saveRef}
              />
            </div>
          ) : (
            <TaskDetail
              task={task}
              project={project}
              projects={projects}
              editable
              onDelete={handleDelete}
              onMarkDone={actions.handleDone}
              onDirtyChange={handleDirtyChange}
              saveRef={saveRef}
              onSaveAll={actions.handleSaveAllChanges}
              annotation={annotationMap.get(task.id)}
              insightsCommentary={insightsData.annotationMap.get(task.id)}
            />
          )}
        </main>

        {/* Unsaved changes confirmation dialog — shown when navigation is attempted while dirty */}
        <AlertDialog
          open={pendingNavigation !== null}
          onOpenChange={(open) => {
            if (!open) clearPendingNavigation()
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Unsaved Changes</AlertDialogTitle>
              <AlertDialogDescription>
                You have unsaved changes. What would you like to do?
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction variant="outline" onClick={handleConfirmLeave}>
                Don&apos;t Save
              </AlertDialogAction>
              <AlertDialogAction onClick={handleSaveAndLeave}>Save</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </TooltipProvider>
  )
}
