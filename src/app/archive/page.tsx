'use client'

import { useState, useEffect, useCallback } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'

interface ArchivedTask {
  id: number
  title: string
  project_id: number
  done_at: string | null
}

interface Project {
  id: number
  name: string
}

export default function ArchivePage() {
  const { status } = useSession()
  const router = useRouter()
  const [tasks, setTasks] = useState<ArchivedTask[]>([])
  const [projects, setProjects] = useState<Map<number, string>>(new Map())
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300)
    return () => clearTimeout(timer)
  }, [search])

  const fetchTasks = useCallback(async (query: string) => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ archived: 'true', done: 'true' })
      if (query.trim()) {
        params.set('search', query.trim())
      }
      const res = await fetch(`/api/tasks?${params}`)
      if (res.ok) {
        const data = await res.json()
        setTasks(data.data?.tasks || [])
      }
    } catch {
      // Handled silently
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

    // Fetch projects once
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

    fetchTasks(debouncedSearch)
  }, [status, router, debouncedSearch, fetchTasks])

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
          <h1 className="text-xl font-semibold">Archive</h1>
        </div>
      </header>

      <main className="max-w-2xl mx-auto w-full px-4 py-6">
        {/* Search */}
        <div className="mb-4">
          <input
            type="search"
            placeholder="Search archived tasks..."
            aria-label="Search archived tasks"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm placeholder:text-zinc-400"
          />
        </div>

        {loading ? (
          <div className="animate-pulse text-zinc-500 text-center py-8">Loading...</div>
        ) : tasks.length === 0 ? (
          <p className="text-center text-zinc-400 py-8">
            {search.trim() ? 'No matching archived tasks' : 'No archived tasks'}
          </p>
        ) : (
          <div className="space-y-2">
            {tasks.map((task) => {
              const projectName = projects.get(task.project_id)
              return (
                <div
                  key={task.id}
                  className="p-3 rounded-lg border border-zinc-200 dark:border-zinc-800 flex items-center gap-3"
                >
                  <span className="text-green-500">&#x2713;</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{task.title}</p>
                    <p className="text-xs text-zinc-400">
                      {projectName && <span>{projectName} · </span>}
                      {task.done_at
                        ? `Completed ${new Date(task.done_at).toLocaleDateString('en-US', {
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
