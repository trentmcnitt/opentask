import { useCallback } from 'react'
import { usePathname } from 'next/navigation'
import { retapPage } from '@/lib/scroll-to-top'

/**
 * A nav link's click (phone tab bar, desktop sidebar): on its own page there
 * is nowhere to go, so the navigation is cancelled and the page goes to the
 * next place that needs you, else the top (`retapPage`). Only on the tab's own page — on a page below
 * it the link still navigates up to it. Every tab alike, the Dashboard's
 * too: a tap resets nothing — filters, search, the view, selection all stay
 * (Trent, 2026-10-29: "No filters or anything should be reset by tapping a
 * tab").
 */
export function useTabRetap() {
  const pathname = usePathname()
  return useCallback(
    (href: string) => (e: React.MouseEvent<HTMLAnchorElement>) => {
      if (pathname !== href) return
      e.preventDefault()
      retapPage()
    },
    [pathname],
  )
}
