'use client'

import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { log } from '@/lib/logger'
import type { Project } from '@/types'

interface ProjectsContextValue {
  projects: Project[]
  refreshProjects: () => Promise<void>
}

const ProjectsContext = createContext<ProjectsContextValue>({
  projects: [],
  refreshProjects: async () => {},
})

/** GET /api/projects; null when it fails (logged), so the caller keeps what it has. */
async function fetchProjects(): Promise<Project[] | null> {
  try {
    const res = await fetch('/api/projects')
    if (!res.ok) return null
    const data = await res.json()
    return data.data?.projects || []
  } catch (err) {
    log.warn('ui', 'Failed to fetch projects:', err)
    return null
  }
}

export function ProjectsProvider({ children }: { children: React.ReactNode }) {
  const { status } = useSession()
  const [projects, setProjects] = useState<Project[]>([])

  const refreshProjects = useCallback(async () => {
    const list = await fetchProjects()
    if (list) setProjects(list)
  }, [])

  // Load once the session is in. The same fetch as refreshProjects(), but the
  // state is set from a callback (with a cancel guard for a session that ends
  // mid-request) rather than by calling refreshProjects() from the effect body,
  // which the React Compiler's set-state-in-effect rule reads as a synchronous
  // setState.
  useEffect(() => {
    if (status !== 'authenticated') return
    let cancelled = false
    fetchProjects().then((list) => {
      if (!cancelled && list) setProjects(list)
    })
    return () => {
      cancelled = true
    }
  }, [status])

  // Refresh project counts when a task is created
  useEffect(() => {
    const handler = () => refreshProjects()
    window.addEventListener('task-created', handler)
    return () => window.removeEventListener('task-created', handler)
  }, [refreshProjects])

  return (
    <ProjectsContext.Provider value={{ projects, refreshProjects }}>
      {children}
    </ProjectsContext.Provider>
  )
}

export function useProjects() {
  return useContext(ProjectsContext)
}
