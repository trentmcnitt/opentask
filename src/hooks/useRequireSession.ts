'use client'

import { useEffect } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { loginUrlFromLocation } from '@/lib/login-redirect'

/**
 * The client-side session guard the signed-in pages share.
 *
 * Sends an unauthenticated visitor to `/login`, carrying the current page as
 * the callbackUrl so they come back here after signing in. `ready` is true
 * only once the session is authenticated: gate data fetches on it, so no page
 * fires a request before the session has resolved or after it has gone. What
 * a page renders meanwhile (the loading shell, nothing, its own extra
 * readiness checks) stays the page's call.
 *
 * The dashboard (`DashboardClient`) keeps its own guard.
 */
export function useRequireSession() {
  const { data: session, status } = useSession()
  const router = useRouter()

  useEffect(() => {
    if (status === 'unauthenticated') router.push(loginUrlFromLocation())
  }, [status, router])

  return { status, session, ready: status === 'authenticated' }
}
