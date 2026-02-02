'use client'

import { useSession } from 'next-auth/react'

const browserTimezone =
  typeof window !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC'

export function useTimezone(): string {
  const { data: session } = useSession()
  return session?.user?.timezone || browserTimezone
}
