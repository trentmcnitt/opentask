'use client'

import { useState, useEffect, useCallback } from 'react'
import { useSession } from 'next-auth/react'
import { Sidebar } from './Sidebar'
import { BottomTabs } from './BottomTabs'
import { CreateTaskPanel } from './CreateTaskPanel'
import { OfflineBanner } from './OfflineBanner'
import { log } from '@/lib/logger'

export function AppLayout({ children }: { children: React.ReactNode }) {
  const { status } = useSession()
  const [projects, setProjects] = useState<
    { id: number; name: string; active_count: number; overdue_count: number }[]
  >([])
  const [showAddForm, setShowAddForm] = useState(false)
  const [addFormTitle, setAddFormTitle] = useState('')

  const loadProjects = useCallback(async () => {
    try {
      const res = await fetch('/api/projects')
      if (!res.ok) return
      const data = await res.json()
      setProjects(
        (data.data?.projects || []).map(
          (p: { id: number; name: string; active_count: number; overdue_count: number }) => ({
            id: p.id,
            name: p.name,
            active_count: p.active_count,
            overdue_count: p.overdue_count,
          }),
        ),
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

  // Refresh project counts when a task is created
  useEffect(() => {
    const handler = () => loadProjects()
    window.addEventListener('task-created', handler)
    return () => window.removeEventListener('task-created', handler)
  }, [loadProjects])

  // When the app becomes visible, dismiss all notifications on other devices.
  // The user can see their task list, so notification noise everywhere else should clear.
  useEffect(() => {
    let lastDismiss = 0
    const handler = () => {
      if (document.visibilityState !== 'visible') return
      // Debounce: don't fire more than once per 30 seconds
      const now = Date.now()
      if (now - lastDismiss < 30_000) return
      lastDismiss = now
      fetch('/api/notifications/dismiss-all', { method: 'POST' }).catch(() => {})
    }
    document.addEventListener('visibilitychange', handler)
    // Also fire on initial mount (page just loaded = user opened the app)
    handler()
    return () => document.removeEventListener('visibilitychange', handler)
  }, [])

  // Notify dashboard when CreateTaskPanel opens/closes so it can disable keyboard shortcuts
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('create-panel-state', { detail: { open: showAddForm } }))
  }, [showAddForm])

  // Don't show nav for unauthenticated users
  if (status !== 'authenticated') {
    return <>{children}</>
  }

  return (
    <div className="flex min-h-screen select-none">
      <OfflineBanner />
      <Sidebar onAddClick={() => setShowAddForm(true)} />

      <div className="flex min-w-0 flex-1 flex-col pb-16 md:pb-0">{children}</div>

      <BottomTabs onAddClick={() => setShowAddForm(true)} />

      <CreateTaskPanel
        open={showAddForm}
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
    </div>
  )
}
