'use client'

import { useState, useEffect, useCallback } from 'react'
import { useSession } from 'next-auth/react'
import { usePathname, useRouter } from 'next/navigation'
import { Sidebar } from './Sidebar'
import { BottomTabs } from './BottomTabs'
import { OfflineBanner } from './OfflineBanner'
import { useProjects } from './ProjectsProvider'
import { OPEN_QUICK_ADD_EVENT, QUICK_ADD_ACTION } from './QuickAddSheet'
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
    // On the Reminders surface the button adds a reminder, in place: the
    // surface owns the editor (and the optimistic insert), so it is told to
    // open it rather than being left for the task form on the dashboard.
    if (pathname.startsWith('/reminders')) {
      window.dispatchEvent(new CustomEvent('open-add-reminder'))
      return
    }
    // Same on Quotas: the app's primary add affordance must make the thing the
    // surface is about, not drag the user to the dashboard to make a task.
    if (pathname.startsWith('/quotas')) {
      window.dispatchEvent(new CustomEvent('open-add-quota'))
      return
    }
    if (pathname !== '/') {
      router.push('/')
    }
    setShowAddForm(true)
  }, [pathname, router])

  // The phone tab bar's `+` (Trent, 2026-09-29): a one-line quick-add sheet at
  // thumb level (`QuickAddSheet`, owned by the dashboard) instead of the full
  // form, which its "Add manually" link still opens. Reminders and Quotas keep
  // their own in-place add, as above. From any other page it navigates to the
  // dashboard with `?action=quick-add`, which the dashboard reads on mount (an
  // event would fire before the dashboard exists to hear it). The desktop
  // Sidebar's Add button keeps `handleAddClick` and the full form.
  const handleAddTabClick = useCallback(() => {
    if (pathname.startsWith('/reminders') || pathname.startsWith('/quotas')) {
      handleAddClick()
      return
    }
    if (pathname === '/') {
      window.dispatchEvent(new CustomEvent(OPEN_QUICK_ADD_EVENT))
      return
    }
    router.push(`/?action=${QUICK_ADD_ACTION}`)
  }, [pathname, router, handleAddClick])

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
  //
  // Skipped inside the native iOS/macOS shells (both inject `__OPENTASK_IOS`):
  // there the native app decides — the iPhone app only when it had delivered
  // notifications of its own (`AppDelegate.applicationDidBecomeActive`), the
  // Mac app never. Without this skip, every WKWebView visibility change
  // (each app open) wiped every other device's notifications regardless.
  useEffect(() => {
    if ('__OPENTASK_IOS' in window) return
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

      <div className="flex min-w-0 flex-1 flex-col pb-16 md:pb-0">{children}</div>

      <BottomTabs onAddClick={handleAddTabClick} />

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
