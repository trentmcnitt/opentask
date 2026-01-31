'use client'

import { useState, useEffect, useCallback } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter, useParams } from 'next/navigation'
import { TaskDetail } from '@/components/TaskDetail'
import type { Task, Note, Project } from '@/types'

export default function TaskDetailPage() {
  const { status } = useSession()
  const router = useRouter()
  const params = useParams()
  const taskId = params.id as string

  const [task, setTask] = useState<Task | null>(null)
  const [notes, setNotes] = useState<Note[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

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
  }, [taskId, router])

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
      // Revert by re-fetching
      fetchTask()
    }
  }

  const handleAddNote = async (content: string) => {
    try {
      const res = await fetch(`/api/tasks/${taskId}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      })
      if (!res.ok) throw new Error('Failed to add note')

      // Re-fetch notes
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

  if (status === 'loading' || loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-zinc-500">Loading...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="text-red-500 mb-4">{error}</div>
          <button
            onClick={() => router.push('/')}
            className="px-4 py-2 rounded-lg bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700"
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
      <header className="sticky top-0 z-10 bg-white/80 dark:bg-zinc-950/80 backdrop-blur-sm border-b border-zinc-200 dark:border-zinc-800">
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center gap-3">
          <button
            onClick={() => router.push('/')}
            className="p-2 -ml-2 rounded-lg text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 dark:hover:text-zinc-100 dark:hover:bg-zinc-800 transition-colors"
            aria-label="Back to dashboard"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 12H5" />
              <path d="M12 19l-7-7 7-7" />
            </svg>
          </button>
          <h1 className="text-lg font-semibold truncate">Task Details</h1>
        </div>
      </header>

      <main className="max-w-2xl mx-auto w-full px-4 py-6">
        <TaskDetail
          task={task}
          notes={notes}
          project={project}
          projects={projects}
          editable
          onFieldChange={handleFieldChange}
          onAddNote={handleAddNote}
          onDeleteNote={handleDeleteNote}
        />
      </main>
    </div>
  )
}
