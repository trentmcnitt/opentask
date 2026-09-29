'use client'

import { useState, useEffect, useCallback } from 'react'
import { useTimezone } from '@/hooks/useTimezone'
import { useRequireSession } from '@/hooks/useRequireSession'
import { PageLoading } from '@/components/PageLoading'
import type { Project } from '@/types'

interface ArchivedTask {
  id: number
  title: string
  project_id: number
  done_at: string | null
}

export default function ArchivePage() {
  const { ready } = useRequireSession()
  const timezone = useTimezone()
  const [tasks, setTasks] = useState<ArchivedTask[]>([])
  const [projects, setProjects] = useState<Map<number, string>>(new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300)
    return () => clearTimeout(timer)
  }, [search])

  const fetchTasks = useCallback(async (query: string) => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ archived: 'true', done: 'true' })
      if (query.trim()) {
        params.set('search', query.trim())
      }
      const res = await fetch(`/api/tasks?${params}`)
      if (!res.ok) throw new Error('Failed to fetch archived tasks')
      const data = await res.json()
      setTasks(data.data?.tasks || [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load archived tasks')
    } finally {
      setLoading(false)
    }
  }, [])

  // Fetch projects once, when the session is in
  useEffect(() => {
    if (!ready) return
    fetch('/api/projects')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.data?.projects) {
          const map = new Map<number, string>()
          for (const p of data.data.projects as Project[]) {
            map.set(p.id, p.name)
          }
          setProjects(map)
        }
      })
      .catch(() => {})
  }, [ready])

  useEffect(() => {
    if (!ready) return
    fetchTasks(debouncedSearch)
  }, [ready, debouncedSearch, fetchTasks])

  if (!ready) return <PageLoading />

  return (
    <div className="flex-1">
      <header className="safe-top bg-background/80 sticky top-0 z-10 border-b backdrop-blur-sm">
        <div className="mx-auto max-w-2xl px-4 py-3">
          <h1 className="text-xl font-semibold">Archive</h1>
        </div>
      </header>

      <main className="mx-auto w-full max-w-2xl px-4 py-6">
        {/* Search */}
        <div className="mb-4">
          <input
            type="search"
            placeholder="Search archived tasks..."
            aria-label="Search archived tasks"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm placeholder:text-zinc-400 dark:border-zinc-700 dark:bg-zinc-800"
          />
        </div>

        {loading ? (
          <div className="animate-pulse py-8 text-center text-zinc-500">Loading...</div>
        ) : error ? (
          <div className="py-8 text-center">
            <p className="mb-4 text-red-500 dark:text-red-400">{error}</p>
            <button
              onClick={() => fetchTasks(debouncedSearch)}
              className="rounded-lg bg-zinc-900 px-4 py-2 text-white hover:opacity-90 dark:bg-zinc-100 dark:text-zinc-900"
            >
              Retry
            </button>
          </div>
        ) : tasks.length === 0 ? (
          <p className="py-8 text-center text-zinc-400">
            {search.trim() ? 'No matching archived tasks' : 'No archived tasks'}
          </p>
        ) : (
          <div className="space-y-2">
            {tasks.map((task) => {
              const projectName = projects.get(task.project_id)
              return (
                <div
                  key={task.id}
                  className="flex items-center gap-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"
                >
                  <span className="text-green-500">&#x2713;</span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{task.title}</p>
                    <p className="text-xs text-zinc-400">
                      {projectName && <span>{projectName} · </span>}
                      {task.done_at
                        ? `Completed ${new Date(task.done_at).toLocaleDateString('en-US', {
                            timeZone: timezone,
                            month: 'short',
                            day: 'numeric',
                          })}`
                        : 'Completed'}
                    </p>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </main>
    </div>
  )
}
