'use client'

import { useState, useEffect, useCallback } from 'react'
import { useSession } from 'next-auth/react'
import { usePathname, useRouter } from 'next/navigation'
import { Sidebar } from './Sidebar'
import { BottomTabs } from './BottomTabs'
// import { DemoBanner } from './DemoBanner'
import { OfflineBanner } from './OfflineBanner'
import { useProjects } from './ProjectsProvider'
import dynamic from 'next/dynamic'

const CreateTaskPanel = dynamic(() =>
  import('./CreateTaskPanel').then((mod) => ({ default: mod.CreateTaskPanel })),
)

export function AppLayout({ children }: { children: React.ReactNode }) {
  const { status } = useSession()
  const { projects } = useProjects()
  const pathname = usePathname()
  const router = useRouter()
  const [showAddForm, setShowAddForm] = useState(false)
  const [addFormTitle, setAddFormTitle] = useState('')

  // Navigate to dashboard first when Add Task is pressed from a non-dashboard page.
  // AppLayout persists across client-side navigations, so showAddForm stays true
  // during the transition. The modal opens with its animation, and by the time it
  // closes after creation, DashboardClient is mounted to receive the task-created event.
  const handleAddClick = useCallback(() => {
    if (pathname !== '/') {
      router.push('/')
    }
    setShowAddForm(true)
  }, [pathname, router])

  useEffect(() => {
    // Handle ?action=create from iOS quick action (check URL directly to avoid
    // cross-component timing issues — child useEffects fire before parent)
    const params = new URLSearchParams(window.location.search)
    if (params.get('action') === 'create') {
      setAddFormTitle('')
      setShowAddForm(true)
      window.history.replaceState({}, '', window.location.pathname)
    }

    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail
      setAddFormTitle(detail?.title || '')
      setShowAddForm(true)
    }
    window.addEventListener('open-add-form', handler)
    return () => window.removeEventListener('open-add-form', handler)
  }, [])

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

  // Prefetch CreateTaskPanel chunk after initial load
  useEffect(() => {
    const timer = setTimeout(() => {
      import('./CreateTaskPanel')
    }, 2000)
    return () => clearTimeout(timer)
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
      <Sidebar onAddClick={handleAddClick} />

      <div className="flex min-w-0 flex-1 flex-col pb-16 md:pb-0">
        {/* <DemoBanner /> */}
        {children}
      </div>

      <BottomTabs onAddClick={handleAddClick} />

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
