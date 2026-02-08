'use client'

import { useState, useEffect, useCallback } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import type { Project } from '@/types'
import {
  SortableProjectList,
  DragHandle,
  type DragHandleProps,
} from '@/components/SortableProjectList'
import { showToast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { CountBadge } from '@/components/CountBadge'

export default function ProjectsPage() {
  const { status } = useSession()
  const router = useRouter()
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (status === 'loading') return
    if (status === 'unauthenticated') {
      router.push('/login')
      return
    }

    async function fetchProjects() {
      try {
        setError(null)
        const res = await fetch('/api/projects')
        if (!res.ok) throw new Error('Failed to fetch projects')
        const data = await res.json()
        setProjects(data.data?.projects || [])
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load projects')
      } finally {
        setLoading(false)
      }
    }

    fetchProjects()
  }, [status, router])

  const handleReorder = useCallback(
    async (projectIds: number[]) => {
      const prevProjects = projects
      setProjects(
        projectIds
          .map((id) => projects.find((p) => p.id === id))
          .filter((p): p is Project => p !== undefined),
      )

      try {
        const res = await fetch('/api/projects/reorder', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project_ids: projectIds }),
        })
        if (!res.ok) throw new Error('Reorder failed')
        // Notify other components (e.g., dashboard, sidebar) to re-fetch projects
        window.dispatchEvent(new CustomEvent('projects-reordered'))
      } catch {
        setProjects(prevProjects)
        showToast({ message: 'Failed to reorder projects' })
      }
    },
    [projects],
  )

  if (status === 'loading' || loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="animate-pulse text-zinc-500">Loading...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="text-center">
          <p className="mb-4 text-red-500 dark:text-red-400">{error}</p>
          <button
            onClick={() => window.location.reload()}
            className="rounded-lg bg-zinc-900 px-4 py-2 text-white hover:opacity-90 dark:bg-zinc-100 dark:text-zinc-900"
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1">
      <header className="bg-background/80 sticky top-0 z-10 border-b backdrop-blur-sm">
        <div className="mx-auto max-w-2xl px-4 py-3">
          <h1 className="text-xl font-semibold">Projects</h1>
        </div>
      </header>

      <main className="mx-auto w-full max-w-2xl px-4 py-6">
        <div className="space-y-2">
          <SortableProjectList
            projects={projects}
            onReorder={handleReorder}
            renderItem={(project, dragHandle) => {
              const fullProject = projects.find((p) => p.id === project.id)
              return (
                <ProjectCard
                  project={project}
                  shared={fullProject?.shared}
                  activeCount={fullProject?.active_count ?? 0}
                  overdueCount={fullProject?.overdue_count ?? 0}
                  dragHandle={dragHandle}
                />
              )
            }}
          />
        </div>
      </main>
    </div>
  )
}

function ProjectCard({
  project,
  shared,
  activeCount,
  overdueCount,
  dragHandle,
}: {
  project: { id: number; name: string }
  shared?: boolean
  activeCount: number
  overdueCount: number
  dragHandle: DragHandleProps
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-lg border border-zinc-200 p-4 transition-colors hover:border-zinc-300 dark:border-zinc-800 dark:hover:border-zinc-700',
        dragHandle.isDragging && 'border-zinc-300 shadow-md dark:border-zinc-600',
      )}
    >
      <DragHandle
        attributes={dragHandle.attributes}
        listeners={dragHandle.listeners}
        className="flex-shrink-0"
      />
      <Link href={`/projects/${project.id}`} className="flex flex-1 items-center justify-between">
        <div className="min-w-0 flex-1">
          <span className="truncate font-medium">{project.name}</span>
          {shared && <span className="ml-2 text-xs text-zinc-400">Shared</span>}
        </div>
        <span className="flex flex-shrink-0 items-center gap-1">
          <CountBadge count={activeCount} />
          {overdueCount > 0 && <CountBadge count={overdueCount} variant="overdue" />}
        </span>
      </Link>
    </div>
  )
}
