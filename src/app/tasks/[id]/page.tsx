'use client'

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter, useParams } from 'next/navigation'
import { ChevronLeft, Undo2, Redo2, Menu, Settings } from 'lucide-react'
import { TaskDetail } from '@/components/TaskDetail'
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
import { useTaskActions } from '@/hooks/useTaskActions'
import type { SingleTaskActionsReturn } from '@/hooks/useTaskActions'
import { useAiInsights } from '@/hooks/useAiInsights'
import { useInsightsData } from '@/hooks/useInsightsData'
import { useUndoRedoShortcuts } from '@/hooks/useUndoRedoShortcuts'

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

  const handleDirtyChange = useCallback(
    (dirty: boolean) => {
      setDirty(dirty)
    },
    [setDirty],
  )

  // Clean up guard registration on unmount
  useEffect(() => {
    return () => setDirty(false)
  }, [setDirty])

  const handleBackClick = useCallback(() => {
    if (requestNavigation('/')) {
      router.push('/')
    }
  }, [requestNavigation, router])

  const handleConfirmLeave = useCallback(() => {
    const href = pendingNavigation ?? '/'
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
    const href = pendingNavigation ?? '/'
    clearPendingNavigation()
    router.push(href)
  }, [pendingNavigation, clearPendingNavigation, router])

  const fetchTask = useCallback(async () => {
    try {
      const [taskRes, projRes] = await Promise.all([
        fetch(`/api/tasks/${taskId}`),
        fetch('/api/projects'),
      ])

      if (taskRes.status === 401) {
        router.push('/login')
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

  useEffect(() => {
    if (status === 'loading') return
    if (status === 'unauthenticated') {
      router.push('/login')
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
    onCompletedNavigation: () => router.push('/'),
  }) as SingleTaskActionsReturn

  useUndoRedoShortcuts(actions.handleUndoRef, actions.handleRedoRef)

  // Keep handleSaveAndLeave's undo ref in sync with the shared handler
  handleUndoRef.current = actions.handleUndo

  const handleDelete = async () => {
    if (!task) return
    try {
      const res = await fetch(`/api/tasks/${taskId}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Failed to delete')
      showToast({
        message: 'Task moved to trash',
        type: 'success',
        action: { label: 'Undo', onClick: actions.handleUndo },
      })
      router.push('/')
    } catch {
      showToast({ message: 'Delete failed', type: 'error' })
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
              aria-label="Back to dashboard"
              className="-ml-2"
            >
              <ChevronLeft className="size-5" />
            </Button>

            {/* Title - takes remaining space */}
            <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">Task Details</h1>

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
