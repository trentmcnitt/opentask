'use client'

import Link from 'next/link'
import { useNavigationGuard } from './NavigationGuardProvider'
import type { ComponentProps, MouseEvent } from 'react'

/**
 * Drop-in replacement for Next.js <Link> that checks the navigation guard
 * before allowing client-side navigation. When not dirty, behaves identically
 * to <Link> (preserving prefetching and all native behavior).
 */
export function GuardedLink(props: ComponentProps<typeof Link>) {
  const { isDirty, requestNavigation } = useNavigationGuard()

  const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
    // Call any existing onClick handler
    if (props.onClick) {
      ;(props.onClick as (e: MouseEvent<HTMLAnchorElement>) => void)(e)
      if (e.defaultPrevented) return
    }

    // Don't guard modified clicks (new tab / new window)
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return

    if (!isDirty) return // let Link handle normally

    e.preventDefault()
    requestNavigation(props.href as string)
  }

  return <Link {...props} onClick={handleClick} />
}
