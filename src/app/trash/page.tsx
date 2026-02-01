'use client'

import { useState, useEffect, useCallback } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'

interface TrashedTask {
  id: number
  title: string
  project_id: number
  deleted_at: string | null
}

interface Project {
  id: number
  name: string
}

export default function TrashPage() {
  const { status } = useSession()
  const router = useRouter()
  const [tasks, setTasks] = useState<TrashedTask[]>([])
  const [projects, setProjects] = useState<Map<number, string>>(new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [restoringId, setRestoringId] = useState<number | null>(null)
  const [emptyingTrash, setEmptyingTrash] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [trashRes, projRes] = await Promise.all([
        fetch('/api/trash'),
        fetch('/api/projects'),
      ])
      if (!trashRes.ok) throw new Error('Failed to fetch trash')
      const trashData = await trashRes.json()
      setTasks(trashData.data?.tasks || [])

      if (projRes.ok) {
        const data = await projRes.json()
        const map = new Map<number, string>()
        for (const p of (data.data?.projects || []) as Project[]) {
          map.set(p.id, p.name)
        }
        setProjects(map)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load trash')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (status === 'loading') return
    if (status === 'unauthenticated') {
      router.push('/login')
      return
    }
    fetchData()
  }, [status, router, fetchData])

  async function handleRestore(taskId: number) {
    setRestoringId(taskId)
    try {
      const res = await fetch(`/api/tasks/${taskId}/restore`, { method: 'POST' })
      if (res.ok) {
        setTasks((prev) => prev.filter((t) => t.id !== taskId))
      }
    } catch {
      // Handled silently
    } finally {
      setRestoringId(null)
    }
  }

  async function handleEmptyTrash() {
    setEmptyingTrash(true)
    try {
      const res = await fetch('/api/trash', { method: 'DELETE' })
      if (res.ok) {
        setTasks([])
      }
    } catch {
      // Handled silently
    } finally {
      setEmptyingTrash(false)
      setShowConfirm(false)
    }
  }

  if (status === 'loading') {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="animate-pulse text-zinc-500">Loading...</div>
      </div>
    )
  }

  return (
    <div className="flex-1">
      <header className="sticky top-0 z-10 bg-white/80 dark:bg-zinc-950/80 backdrop-blur-sm border-b border-zinc-200 dark:border-zinc-800">
        <div className="max-w-2xl mx-auto px-4 py-3">
          <h1 className="text-xl font-semibold">Trash</h1>
        </div>
      </header>

      <main className="max-w-2xl mx-auto w-full px-4 py-6">
        {loading ? (
          <div className="animate-pulse text-zinc-500 text-center py-8">Loading...</div>
        ) : error ? (
          <div className="text-center py-8">
            <p className="text-red-500 dark:text-red-400 mb-4">{error}</p>
            <button
              onClick={fetchData}
              className="px-4 py-2 bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 rounded-lg hover:opacity-90"
            >
              Retry
            </button>
          </div>
        ) : tasks.length === 0 ? (
          <p className="text-center text-zinc-400 py-8">Trash is empty</p>
        ) : (
          <>
            <div className="space-y-2">
              {tasks.map((task) => {
                const projectName = projects.get(task.project_id)
                return (
                  <div
                    key={task.id}
                    className="p-3 rounded-lg border border-zinc-200 dark:border-zinc-800 flex items-center gap-3"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{task.title}</p>
                      <p className="text-xs text-zinc-400">
                        {projectName && <span>{projectName} · </span>}
                        {task.deleted_at
                          ? `Deleted ${new Date(task.deleted_at).toLocaleDateString('en-US', {
                              month: 'short',
                              day: 'numeric',
                            })}`
                          : 'Deleted'}
                      </p>
                    </div>
                    <button
                      onClick={() => handleRestore(task.id)}
                      disabled={restoringId === task.id}
                      aria-label={`Restore ${task.title}`}
                      className="px-3 py-1.5 text-xs font-medium rounded-md border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors disabled:opacity-50"
                    >
                      {restoringId === task.id ? 'Restoring...' : 'Restore'}
                    </button>
                  </div>
                )
              })}
            </div>

            <div className="mt-6 pt-4 border-t border-zinc-200 dark:border-zinc-800">
              {showConfirm ? (
                <div className="flex items-center gap-3">
                  <p className="text-sm text-red-600 dark:text-red-400 flex-1">
                    Permanently delete all {tasks.length} item{tasks.length !== 1 ? 's' : ''}?
                  </p>
                  <button
                    onClick={() => setShowConfirm(false)}
                    className="px-3 py-1.5 text-xs font-medium rounded-md border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleEmptyTrash}
                    disabled={emptyingTrash}
                    className="px-3 py-1.5 text-xs font-medium rounded-md bg-red-600 text-white hover:bg-red-700 transition-colors disabled:opacity-50"
                  >
                    {emptyingTrash ? 'Deleting...' : 'Delete All'}
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setShowConfirm(true)}
                  className="w-full p-3 rounded-lg border border-red-200 dark:border-red-900 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors text-sm font-medium"
                >
                  Empty Trash
                </button>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  )
}
