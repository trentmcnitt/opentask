'use client'

import { createContext, useContext, useState, useCallback, useRef } from 'react'

interface NavigationGuardContextValue {
  /** Whether the current page has unsaved changes */
  isDirty: boolean
  /** Pages call this to report dirty state changes */
  setDirty: (dirty: boolean) => void
  /** The href the user is trying to navigate to, or null if no pending navigation */
  pendingNavigation: string | null
  /**
   * Request navigation to href. If not dirty, returns true (caller should proceed).
   * If dirty, sets pendingNavigation and returns false (caller should block navigation).
   */
  requestNavigation: (href: string) => boolean
  /** Clear pending navigation without navigating (dialog cancel) */
  clearPendingNavigation: () => void
}

const NavigationGuardContext = createContext<NavigationGuardContextValue>({
  isDirty: false,
  setDirty: () => {},
  pendingNavigation: null,
  requestNavigation: () => true,
  clearPendingNavigation: () => {},
})

export function useNavigationGuard() {
  return useContext(NavigationGuardContext)
}

export function NavigationGuardProvider({ children }: { children: React.ReactNode }) {
  const [isDirty, setIsDirty] = useState(false)
  const [pendingNavigation, setPendingNavigation] = useState<string | null>(null)
  const isDirtyRef = useRef(false)

  const setDirty = useCallback((dirty: boolean) => {
    setIsDirty(dirty)
    isDirtyRef.current = dirty
  }, [])

  const requestNavigation = useCallback((href: string): boolean => {
    if (!isDirtyRef.current) return true
    setPendingNavigation(href)
    return false
  }, [])

  const clearPendingNavigation = useCallback(() => {
    setPendingNavigation(null)
  }, [])

  return (
    <NavigationGuardContext.Provider
      value={{ isDirty, setDirty, pendingNavigation, requestNavigation, clearPendingNavigation }}
    >
      {children}
    </NavigationGuardContext.Provider>
  )
}
