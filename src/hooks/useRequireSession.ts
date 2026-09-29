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
 * only once the session is authenticated.
 *
 * The contract: **render nothing of the page's body until `ready`** — show
 * `<PageLoading />` (or nothing) instead — and gate data fetches on it too.
 * The redirect is an effect of the page component, so it only fires once the
 * page commits. A body that renders a `next/dynamic` component (with no
 * `loading`, it has no Suspense boundary of its own) suspends the whole page
 * while that chunk loads, and the redirect waits on it; in CI the signed-out
 * /history visit (its activity tab mounts `BatchUndoDialog`) sat on
 * "Loading..." and never reached /login. Holding the body back until `ready`
 * keeps the signed-out render to the loading shell, so nothing can suspend
 * it. That is also why the hook hands back `ready` and not the raw status: a
 * page cannot tell "unauthenticated" apart from "authenticated" and render
 * its body for it.
 *
 * The dashboard (`DashboardClient`) keeps its own guard.
 */
export function useRequireSession() {
  const { data: session, status } = useSession()
  const router = useRouter()

  useEffect(() => {
    if (status === 'unauthenticated') router.push(loginUrlFromLocation())
  }, [status, router])

  return { session, ready: status === 'authenticated' }
}
