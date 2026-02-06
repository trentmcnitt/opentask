import { useState, useEffect } from 'react'

const MOBILE_BREAKPOINT = 640

/**
 * Detects whether the viewport is below the mobile breakpoint (640px, matching Tailwind's `sm:`).
 * SSR-safe: initializes to `false` on the server, then hydrates on mount.
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false)

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  return isMobile
}
