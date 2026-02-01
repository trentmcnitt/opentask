'use client'

import { useState, useEffect, useCallback } from 'react'
import { useSession } from 'next-auth/react'
import { Sidebar } from './Sidebar'
import { BottomTabs } from './BottomTabs'
import { AddTaskForm } from './AddTaskForm'
import { OfflineBanner } from './OfflineBanner'

export function AppLayout({ children }: { children: React.ReactNode }) {
  const { status } = useSession()
  const [projects, setProjects] = useState<{ id: number; name: string }[]>([])
  const [showAddForm, setShowAddForm] = useState(false)

  const fetchProjects = useCallback(async () => {
    try {
      const res = await fetch('/api/projects')
      if (!res.ok) {
        console.warn('Failed to fetch projects for sidebar:', res.status)
        return
      }
      const data = await res.json()
      setProjects(
        (data.data?.projects || []).map((p: { id: number; name: string }) => ({
          id: p.id,
          name: p.name,
        }))
      )
    } catch (err) {
      // Non-critical - sidebar just won't show projects
      console.warn('Failed to fetch projects for sidebar:', err)
    }
  }, [])

  useEffect(() => {
    if (status === 'authenticated') {
      fetchProjects()
    }
  }, [status, fetchProjects])

  // Don't show nav for unauthenticated users
  if (status !== 'authenticated') {
    return <>{children}</>
  }

  return (
    <div className="flex min-h-screen">
      <OfflineBanner />
      <Sidebar projects={projects} />

      <div className="flex-1 flex flex-col pb-16 md:pb-0">
        {children}
      </div>

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
