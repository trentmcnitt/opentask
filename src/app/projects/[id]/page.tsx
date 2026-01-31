'use client'

import { useState, useEffect, useCallback } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter, useParams } from 'next/navigation'
import { TaskList } from '@/components/TaskList'
import { SnoozeSheet } from '@/components/SnoozeSheet'
import { Toast } from '@/components/Toast'
import type { Task } from '@/types'

export default function ProjectDetailPage() {
  const { status } = useSession()
  const router = useRouter()
  const params = useParams()
  const projectId = params.id as string

  const [tasks, setTasks] = useState<Task[]>([])
  const [projectName, setProjectName] = useState('')
  const [loading, setLoading] = useState(true)
  const [snoozeTask, setSnoozeTask] = useState<Task | null>(null)
  const [toast, setToast] = useState<{ message: string; action?: () => void } | null>(null)

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
      setToast({ message: task.rrule ? 'Task advanced' : 'Task completed', action: handleUndo })
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
      setToast({ message: 'Task snoozed', action: handleUndo })
    } catch {
      fetchTasks()
    }
  }

  const handleUndo = async () => {
    try {
      await fetch('/api/undo', { method: 'POST' })
      setToast(null)
      fetchTasks()
    } catch {
      setToast({ message: 'Undo failed' })
    }
  }

  if (status === 'loading' || loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="animate-pulse text-zinc-500">Loading...</div>
      </div>
    )
  }

  return (
    <div className="flex-1">
      <header className="sticky top-0 z-10 bg-white/80 dark:bg-zinc-950/80 backdrop-blur-sm border-b border-zinc-200 dark:border-zinc-800">
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center gap-3">
          <button
            onClick={() => router.push('/projects')}
            className="p-2 -ml-2 rounded-lg text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 dark:hover:text-zinc-100 dark:hover:bg-zinc-800 transition-colors"
            aria-label="Back to projects"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 12H5" />
              <path d="M12 19l-7-7 7-7" />
            </svg>
          </button>
          <h1 className="text-xl font-semibold">{projectName || 'Project'}</h1>
          <span className="text-sm text-zinc-500">{tasks.length} tasks</span>
        </div>
      </header>

      <main className="max-w-2xl mx-auto w-full px-4 py-6">
        <TaskList
          tasks={tasks}
          onDone={handleDone}
          onSnooze={(task) => setSnoozeTask(task)}
        />
      </main>

      {snoozeTask && (
        <SnoozeSheet
          task={snoozeTask}
          onSnooze={(until) => handleSnooze(snoozeTask.id, until)}
          onClose={() => setSnoozeTask(null)}
        />
      )}
      {toast && (
        <Toast
          message={toast.message}
          action={toast.action ? { label: 'Undo', onClick: toast.action } : undefined}
          onDismiss={() => setToast(null)}
        />
      )}
    </div>
  )
}
