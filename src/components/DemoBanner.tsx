'use client'

import { useSession } from 'next-auth/react'
import { Info } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'

// Only shown when the logged-in user is the demo user AND the instance
// has demo mode enabled (NEXT_PUBLIC_DEMO_MODE=1 at build time).
export function DemoBanner() {
  const { data: session } = useSession()

  if (process.env.NEXT_PUBLIC_DEMO_MODE !== '1') return null
  if (session?.user?.name !== 'demo') return null

  return (
    <Alert className="rounded-none border-x-0 border-t-0 bg-blue-50 py-2 text-blue-800 dark:bg-blue-950 dark:text-blue-200 [&>svg]:text-blue-600 dark:[&>svg]:text-blue-400">
      <Info className="size-4" />
      <AlertDescription>Live demo &mdash; tasks reset daily</AlertDescription>
    </Alert>
  )
}
