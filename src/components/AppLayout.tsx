'use client'

import { useState, useEffect, useCallback } from 'react'
import { useSession } from 'next-auth/react'
import { Sidebar } from './Sidebar'
import { BottomTabs } from './BottomTabs'
import { AddTaskForm } from './AddTaskForm'
import { OfflineBanner } from './OfflineBanner'
import { showToast } from '@/lib/toast'
import { log } from '@/lib/logger'

export function AppLayout({ children }: { children: React.ReactNode }) {
  const { status } = useSession()
  const [projects, setProjects] = useState<{ id: number; name: string }[]>([])
  const [showAddForm, setShowAddForm] = useState(false)
  const [addFormTitle, setAddFormTitle] = useState('')

  const loadProjects = useCallback(async () => {
    try {
      const res = await fetch('/api/projects')
      if (!res.ok) return
      const data = await res.json()
      setProjects(
        (data.data?.projects || []).map((p: { id: number; name: string }) => ({
          id: p.id,
          name: p.name,
        })),
      )
    } catch (err) {
      log.warn('ui', 'Failed to fetch projects for sidebar:', err)
    }
  }, [])

  useEffect(() => {
    if (status !== 'authenticated') return
    let cancelled = false

    async function init() {
      await loadProjects()
      if (cancelled) return
    }

    init()
    return () => {
      cancelled = true
    }
  }, [status, loadProjects])

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail
      setAddFormTitle(detail?.title || '')
      setShowAddForm(true)
    }
    window.addEventListener('open-add-form', handler)
    return () => window.removeEventListener('open-add-form', handler)
  }, [])

  const handleReorderProjects = useCallback(
    async (projectIds: number[]) => {
      // Optimistic update
      const prevProjects = projects
      setProjects(
        projectIds
          .map((id) => projects.find((p) => p.id === id))
          .filter((p): p is { id: number; name: string } => p !== undefined),
      )

      try {
        const res = await fetch('/api/projects/reorder', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project_ids: projectIds }),
        })
        if (!res.ok) throw new Error('Reorder failed')
        // Notify other components (e.g., dashboard) to re-fetch projects
        window.dispatchEvent(new CustomEvent('projects-reordered'))
      } catch {
        setProjects(prevProjects)
        showToast({ message: 'Failed to reorder projects' })
      }
    },
    [projects],
  )

  // Don't show nav for unauthenticated users
  if (status !== 'authenticated') {
    return <>{children}</>
  }

  return (
    <div className="flex min-h-screen select-none">
      <OfflineBanner />
      <Sidebar
        projects={projects}
        onAddClick={() => setShowAddForm(true)}
        onReorderProjects={handleReorderProjects}
      />

      <div className="flex min-w-0 flex-1 flex-col pb-16 md:pb-0">{children}</div>

      <BottomTabs onAddClick={() => setShowAddForm(true)} />

      {showAddForm && (
        <AddTaskForm
          projects={projects}
          initialTitle={addFormTitle}
          onClose={() => {
            setShowAddForm(false)
            setAddFormTitle('')
          }}
          onCreated={() => {
            setShowAddForm(false)
            setAddFormTitle('')
            window.dispatchEvent(new CustomEvent('task-created'))
          }}
        />
      )}
    </div>
  )
}
