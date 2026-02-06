'use client'

import { useState, useEffect, useCallback } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { useTimezone } from '@/hooks/useTimezone'

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

function EmptyTrashConfirm({
  taskCount,
  showConfirm,
  emptyingTrash,
  onShowConfirm,
  onEmptyTrash,
}: {
  taskCount: number
  showConfirm: boolean
  emptyingTrash: boolean
  onShowConfirm: (show: boolean) => void
  onEmptyTrash: () => void
}) {
  return (
    <div className="mt-6 border-t border-zinc-200 pt-4 dark:border-zinc-800">
      {showConfirm ? (
        <div className="flex items-center gap-3">
          <p className="flex-1 text-sm text-red-600 dark:text-red-400">
            Permanently delete all {taskCount} item{taskCount !== 1 ? 's' : ''}?
          </p>
          <button
            onClick={() => onShowConfirm(false)}
            className="rounded-md border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            onClick={onEmptyTrash}
            disabled={emptyingTrash}
            className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
          >
            {emptyingTrash ? 'Deleting...' : 'Delete All'}
          </button>
        </div>
      ) : (
        <button
          onClick={() => onShowConfirm(true)}
          className="w-full rounded-lg border border-red-200 p-3 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-900/20"
        >
          Empty Trash
        </button>
      )}
    </div>
  )
}

export default function TrashPage() {
  const { status } = useSession()
  const router = useRouter()
  const timezone = useTimezone()
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
      const [trashRes, projRes] = await Promise.all([fetch('/api/trash'), fetch('/api/projects')])
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
      <div className="flex flex-1 items-center justify-center">
        <div className="animate-pulse text-zinc-500">Loading...</div>
      </div>
    )
  }

  return (
    <div className="flex-1">
      <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white/80 backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-950/80">
        <div className="mx-auto max-w-2xl px-4 py-3">
          <h1 className="text-xl font-semibold">Trash</h1>
        </div>
      </header>

      <main className="mx-auto w-full max-w-2xl px-4 py-6">
        {loading ? (
          <div className="animate-pulse py-8 text-center text-zinc-500">Loading...</div>
        ) : error ? (
          <div className="py-8 text-center">
            <p className="mb-4 text-red-500 dark:text-red-400">{error}</p>
            <button
              onClick={fetchData}
              className="rounded-lg bg-zinc-900 px-4 py-2 text-white hover:opacity-90 dark:bg-zinc-100 dark:text-zinc-900"
            >
              Retry
            </button>
          </div>
        ) : tasks.length === 0 ? (
          <p className="py-8 text-center text-zinc-400">Trash is empty</p>
        ) : (
          <>
            <div className="space-y-2">
              {tasks.map((task) => {
                const projectName = projects.get(task.project_id)
                return (
                  <div
                    key={task.id}
                    className="flex items-center gap-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{task.title}</p>
                      <p className="text-xs text-zinc-400">
                        {projectName && <span>{projectName} · </span>}
                        {task.deleted_at
                          ? `Deleted ${new Date(task.deleted_at).toLocaleDateString('en-US', {
                              timeZone: timezone,
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
                      className="rounded-md border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
                    >
                      {restoringId === task.id ? 'Restoring...' : 'Restore'}
                    </button>
                  </div>
                )
              })}
            </div>

            <EmptyTrashConfirm
              taskCount={tasks.length}
              showConfirm={showConfirm}
              emptyingTrash={emptyingTrash}
              onShowConfirm={setShowConfirm}
              onEmptyTrash={handleEmptyTrash}
            />
          </>
        )}
      </main>
    </div>
  )
}
