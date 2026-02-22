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

export function ProjectsProvider({ children }: { children: React.ReactNode }) {
  const { status } = useSession()
  const [projects, setProjects] = useState<Project[]>([])

  const refreshProjects = useCallback(async () => {
    try {
      const res = await fetch('/api/projects')
      if (!res.ok) return
      const data = await res.json()
      setProjects(data.data?.projects || [])
    } catch (err) {
      log.warn('ui', 'Failed to fetch projects:', err)
    }
  }, [])

  useEffect(() => {
    if (status !== 'authenticated') return
    let cancelled = false
    fetch('/api/projects')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data) setProjects(data.data?.projects || [])
      })
      .catch(() => {})
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
