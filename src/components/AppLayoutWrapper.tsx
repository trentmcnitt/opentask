'use client'

import { usePathname } from 'next/navigation'
import { AppLayout } from './AppLayout'

export function AppLayoutWrapper({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()

  // Don't wrap login page with app navigation
  if (pathname === '/login') {
    return <>{children}</>
  }

  return <AppLayout>{children}</AppLayout>
}
