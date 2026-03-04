'use client'

import { useState, useEffect, useCallback } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { useTimezone } from '@/hooks/useTimezone'
import { showToast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import type { Project } from '@/types'

interface TrashedTask {
  id: number
  title: string
  project_id: number
  deleted_at: string | null
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
    <div className="border-border mt-6 border-t pt-4">
      {showConfirm ? (
        <div className="flex items-center gap-3">
          <p className="flex-1 text-sm text-red-600 dark:text-red-400">
            Permanently delete all {taskCount} item{taskCount !== 1 ? 's' : ''}?
          </p>
          <Button variant="outline" size="sm" onClick={() => onShowConfirm(false)}>
            Cancel
          </Button>
          <Button variant="destructive" size="sm" onClick={onEmptyTrash} disabled={emptyingTrash}>
            {emptyingTrash ? 'Deleting...' : 'Delete All'}
          </Button>
        </div>
      ) : (
        <Button
          variant="outline"
          onClick={() => onShowConfirm(true)}
          className="w-full border-red-200 text-red-600 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-900/20"
        >
          Empty Trash
        </Button>
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
      showToast({ message: 'Failed to restore task', type: 'error' })
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
      showToast({ message: 'Failed to empty trash', type: 'error' })
    } finally {
      setEmptyingTrash(false)
      setShowConfirm(false)
    }
  }

  if (status === 'loading') {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="text-muted-foreground animate-pulse">Loading...</div>
      </div>
    )
  }

  return (
    <div className="flex-1">
      <header className="safe-top bg-background/80 sticky top-0 z-10 border-b backdrop-blur-sm">
        <div className="mx-auto max-w-2xl px-4 py-3">
          <h1 className="text-xl font-semibold">Trash</h1>
        </div>
      </header>

      <main className="mx-auto w-full max-w-2xl px-4 py-6">
        {loading ? (
          <div className="text-muted-foreground animate-pulse py-8 text-center">Loading...</div>
        ) : error ? (
          <div className="py-8 text-center">
            <p className="mb-4 text-red-500 dark:text-red-400">{error}</p>
            <Button onClick={fetchData}>Retry</Button>
          </div>
        ) : tasks.length === 0 ? (
          <p className="text-muted-foreground py-8 text-center">Trash is empty</p>
        ) : (
          <>
            <div className="space-y-2">
              {tasks.map((task) => {
                const projectName = projects.get(task.project_id)
                return (
                  <div
                    key={task.id}
                    className="border-border flex items-center gap-3 rounded-lg border p-3"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{task.title}</p>
                      <p className="text-muted-foreground text-xs">
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
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleRestore(task.id)}
                      disabled={restoringId === task.id}
                      aria-label={`Restore ${task.title}`}
                    >
                      {restoringId === task.id ? 'Restoring...' : 'Restore'}
                    </Button>
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
