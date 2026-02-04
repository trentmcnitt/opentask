'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter, useParams } from 'next/navigation'
import { TaskDetail } from '@/components/TaskDetail'
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
import type { Task, Note, Project } from '@/types'
import type { QuickActionPanelChanges } from '@/components/QuickActionPanel'
import { showToast } from '@/lib/toast'

function useNoteActions(taskId: string) {
  const [notes, setNotes] = useState<Note[]>([])

  const handleAddNote = async (content: string) => {
    try {
      const res = await fetch(`/api/tasks/${taskId}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      })
      if (!res.ok) throw new Error('Failed to add note')

      const notesRes = await fetch(`/api/tasks/${taskId}/notes`)
      if (notesRes.ok) {
        const notesData = await notesRes.json()
        setNotes(notesData.data?.notes || [])
      }
    } catch {
      // Silent fail
    }
  }

  const handleDeleteNote = async (noteId: number) => {
    try {
      const res = await fetch(`/api/tasks/${taskId}/notes/${noteId}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Failed to delete note')
      setNotes((prev) => prev.filter((n) => n.id !== noteId))
    } catch {
      // Silent fail
    }
  }

  return { notes, setNotes, handleAddNote, handleDeleteNote }
}

export default function TaskDetailPage() {
  const { status } = useSession()
  const router = useRouter()
  const params = useParams()
  const taskId = params.id as string

  const [task, setTask] = useState<Task | null>(null)
  const { notes, setNotes, handleAddNote, handleDeleteNote } = useNoteActions(taskId)
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Track dirty state from QuickActionPanel for navigation protection
  const [isDirty, setIsDirty] = useState(false)
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false)
  const saveRef = useRef<(() => void) | null>(null)

  const handleDirtyChange = useCallback((dirty: boolean) => {
    setIsDirty(dirty)
  }, [])

  const handleBackClick = useCallback(() => {
    if (isDirty) {
      setShowLeaveConfirm(true)
    } else {
      router.push('/')
    }
  }, [isDirty, router])

  const handleConfirmLeave = useCallback(() => {
    setShowLeaveConfirm(false)
    router.push('/')
  }, [router])

  const handleSaveAndLeave = useCallback(() => {
    saveRef.current?.()
    setShowLeaveConfirm(false)
    showToast({
      message: 'Changes saved',
      action: {
        label: 'Undo',
        onClick: async () => {
          try {
            const res = await fetch('/api/undo', { method: 'POST' })
            if (!res.ok) {
              showToast({ message: 'Undo failed' })
              return
            }
            const data = await res.json()
            showToast({ message: `Undid: ${data.data.description}` })
            // Trigger a page refresh to show the undone state
            window.location.reload()
          } catch {
            showToast({ message: 'Undo failed' })
          }
        },
      },
    })
    router.push('/')
  }, [router])

  const fetchTask = useCallback(async () => {
    try {
      const [taskRes, notesRes, projRes] = await Promise.all([
        fetch(`/api/tasks/${taskId}`),
        fetch(`/api/tasks/${taskId}/notes`),
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

      if (notesRes.ok) {
        const notesData = await notesRes.json()
        setNotes(notesData.data?.notes || [])
      }

      if (projRes.ok) {
        const projData = await projRes.json()
        setProjects(projData.data?.projects || [])
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [taskId, router, setNotes])

  useEffect(() => {
    if (status === 'loading') return
    if (status === 'unauthenticated') {
      router.push('/login')
      return
    }
    fetchTask()
  }, [status, router, fetchTask])

  const handleFieldChange = async (field: string, value: unknown) => {
    if (!task) return

    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: value }),
      })
      if (!res.ok) throw new Error('Failed to update')

      const data = await res.json()
      setTask(data.data as Task)
    } catch {
      fetchTask()
    }
  }

  const handleSnooze = async (until: string) => {
    if (!task) return

    try {
      const res = await fetch(`/api/tasks/${taskId}/snooze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ until }),
      })
      if (!res.ok) throw new Error('Failed to snooze')

      const data = await res.json()
      setTask(data.data.task as Task)
    } catch {
      fetchTask()
    }
  }

  const handleMarkDone = async () => {
    if (!task) return

    try {
      const res = await fetch(`/api/tasks/${taskId}/done`, { method: 'POST' })
      if (!res.ok) throw new Error('Failed to mark done')

      const data = await res.json()
      if (data.data.was_recurring) {
        // Recurring task: stay on page, show updated due date
        setTask(data.data.task as Task)
      } else {
        // One-off task: go back to dashboard (task is archived)
        router.push('/')
      }
    } catch {
      fetchTask()
    }
  }

  const handleMetaNotesSave = async (value: string | null) => {
    if (!task) return

    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ meta_notes: value }),
      })
      if (!res.ok) throw new Error('Failed to update meta notes')

      const data = await res.json()
      setTask(data.data as Task)
    } catch {
      fetchTask()
    }
  }

  /**
   * Batched save handler: sends all changed fields in a SINGLE PATCH request.
   * This creates ONE undo entry instead of separate entries for each field change.
   *
   * All changes (including due_at) now go through PATCH. The server's updateTask
   * automatically applies snooze logic when due_at changes without rrule change.
   */
  const handleSaveAll = async (changes: QuickActionPanelChanges) => {
    if (!task) return

    // Build the patch payload, only including fields that actually changed
    const patch: Record<string, unknown> = {}

    if (changes.title !== undefined && changes.title !== task.title) {
      patch.title = changes.title
    }
    if (changes.priority !== undefined && changes.priority !== task.priority) {
      patch.priority = changes.priority
    }
    if (changes.labels !== undefined) {
      // Compare arrays - only include if different
      const currentLabels = task.labels || []
      const newLabels = changes.labels
      if (
        newLabels.length !== currentLabels.length ||
        newLabels.some((l, i) => l !== currentLabels[i])
      ) {
        patch.labels = newLabels
      }
    }
    if (changes.rrule !== undefined && changes.rrule !== task.rrule) {
      patch.rrule = changes.rrule
    }
    if (changes.project_id !== undefined && changes.project_id !== task.project_id) {
      patch.project_id = changes.project_id
    }
    // due_at is now handled by PATCH directly - snooze logic is applied server-side
    if (changes.due_at !== undefined && changes.due_at !== task.due_at) {
      patch.due_at = changes.due_at
    }

    if (Object.keys(patch).length === 0) return

    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (!res.ok) throw new Error('Failed to update')
      const data = await res.json()
      setTask(data.data as Task)
    } catch {
      fetchTask()
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
    <div className="flex-1">
      <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white/80 backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-950/80">
        <div className="mx-auto flex max-w-2xl items-center gap-3 px-4 py-3">
          <button
            onClick={handleBackClick}
            className="-ml-2 rounded-lg p-2 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            aria-label="Back to dashboard"
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
          <h1 className="truncate text-lg font-semibold">Task Details</h1>
        </div>
      </header>

      <main className="mx-auto w-full max-w-2xl px-4 py-6">
        <TaskDetail
          task={task}
          notes={notes}
          project={project}
          projects={projects}
          editable
          onFieldChange={handleFieldChange}
          onSnooze={handleSnooze}
          onAddNote={handleAddNote}
          onDeleteNote={handleDeleteNote}
          onMarkDone={handleMarkDone}
          onDirtyChange={handleDirtyChange}
          onMetaNotesSave={handleMetaNotesSave}
          saveRef={saveRef}
          onSaveAll={handleSaveAll}
        />
      </main>

      {/* Unsaved changes confirmation dialog */}
      <AlertDialog open={showLeaveConfirm} onOpenChange={setShowLeaveConfirm}>
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
  )
}
