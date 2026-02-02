'use client'

import { useState, useEffect } from 'react'
import { useSession } from 'next-auth/react'
import { Sidebar } from './Sidebar'
import { BottomTabs } from './BottomTabs'
import { AddTaskForm } from './AddTaskForm'
import { OfflineBanner } from './OfflineBanner'

export function AppLayout({ children }: { children: React.ReactNode }) {
  const { status } = useSession()
  const [projects, setProjects] = useState<{ id: number; name: string }[]>([])
  const [showAddForm, setShowAddForm] = useState(false)

  useEffect(() => {
    if (status !== 'authenticated') return
    let cancelled = false

    async function loadProjects() {
      try {
        const res = await fetch('/api/projects')
        if (!res.ok || cancelled) return
        const data = await res.json()
        if (!cancelled) {
          setProjects(
            (data.data?.projects || []).map((p: { id: number; name: string }) => ({
              id: p.id,
              name: p.name,
            })),
          )
        }
      } catch (err) {
        if (!cancelled) {
          console.warn('Failed to fetch projects for sidebar:', err)
        }
      }
    }

    loadProjects()
    return () => {
      cancelled = true
    }
  }, [status])

  // Don't show nav for unauthenticated users
  if (status !== 'authenticated') {
    return <>{children}</>
  }

  return (
    <div className="flex min-h-screen">
      <OfflineBanner />
      <Sidebar projects={projects} onAddClick={() => setShowAddForm(true)} />

      <div className="flex min-w-0 flex-1 flex-col pb-16 md:pb-0">{children}</div>

      <BottomTabs onAddClick={() => setShowAddForm(true)} />

      {showAddForm && (
        <AddTaskForm
          projects={projects}
          onClose={() => setShowAddForm(false)}
          onCreated={() => {
            setShowAddForm(false)
            // Page will re-fetch tasks via its own mechanism
            window.dispatchEvent(new CustomEvent('task-created'))
          }}
        />
      )}
    </div>
  )
}
