'use client'

import { useState, useEffect, useCallback } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { TaskList } from '@/components/TaskList'
import { Header } from '@/components/Header'
import { SnoozeSheet } from '@/components/SnoozeSheet'
import { Toast } from '@/components/Toast'
import type { Task } from '@/types'

export default function Home() {
  const { data: session, status } = useSession()
  const router = useRouter()
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [snoozeTask, setSnoozeTask] = useState<Task | null>(null)
  const [toast, setToast] = useState<{ message: string; action?: () => void } | null>(null)

  const fetchTasks = useCallback(async () => {
    try {
      const res = await fetch('/api/tasks?limit=100')
      if (res.status === 401) {
        router.push('/login')
        return
      }
      if (!res.ok) {
        throw new Error('Failed to fetch tasks')
      }
      const data = await res.json()
      setTasks(data.data?.tasks || [])
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [router])

  useEffect(() => {
    if (status === 'loading') return
    if (status === 'unauthenticated') {
      router.push('/login')
      return
    }
    fetchTasks()
  }, [status, router, fetchTasks])

  const handleDone = async (taskId: number) => {
    const task = tasks.find(t => t.id === taskId)
    if (!task) return

    // Optimistic update - for recurring, keep in list; for one-off, remove
    if (!task.rrule) {
      setTasks(prev => prev.filter(t => t.id !== taskId))
    }

    try {
      const res = await fetch(`/api/tasks/${taskId}/done`, { method: 'POST' })
      if (!res.ok) throw new Error('Failed to mark done')

      const data = await res.json()

      // If recurring, update the task with new due date
      if (data.data?.task?.rrule) {
        setTasks(prev =>
          prev.map(t => (t.id === taskId ? data.data.task : t))
        )
      }

      // Show undo toast
      setToast({
        message: task.rrule ? 'Task advanced' : 'Task completed',
        action: handleUndo,
      })
    } catch {
      // Revert on error
      fetchTasks()
    }
  }

  const handleSnooze = async (taskId: number, until: string) => {
    const task = tasks.find(t => t.id === taskId)
    if (!task) return

    // Optimistic update - update due_at to new time
    setTasks(prev =>
      prev.map(t => (t.id === taskId ? { ...t, due_at: until } : t))
    )
    setSnoozeTask(null)

    try {
      const res = await fetch(`/api/tasks/${taskId}/snooze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ until }),
      })
      if (!res.ok) throw new Error('Failed to snooze')

      // Refresh to get accurate server state
      fetchTasks()

      setToast({
        message: 'Task snoozed',
        action: handleUndo,
      })
    } catch {
      fetchTasks()
    }
  }

  const handleUndo = async () => {
    try {
      const res = await fetch('/api/undo', { method: 'POST' })
      if (!res.ok) throw new Error('Failed to undo')

      setToast(null)
      fetchTasks()
    } catch {
      setToast({ message: 'Undo failed' })
    }
  }

  // Show loading while checking auth
  if (status === 'loading' || (status === 'authenticated' && loading)) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-zinc-500">Loading...</div>
      </div>
    )
  }

  // Don't render if unauthenticated (will redirect)
  if (status === 'unauthenticated') {
    return null
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="text-red-500 mb-4">{error}</div>
          <button
            onClick={() => {
              setError(null)
              setLoading(true)
              fetchTasks()
            }}
            className="px-4 py-2 rounded-lg bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700"
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex flex-col">
      <Header
        taskCount={tasks.length}
        onUndo={handleUndo}
        userName={session?.user?.name || undefined}
      />

      <main className="flex-1 max-w-2xl mx-auto w-full px-4 py-6">
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
