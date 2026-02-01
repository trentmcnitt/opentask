'use client'

import { useState, useEffect } from 'react'
import { WifiOff } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'

export function OfflineBanner() {
  const [offline, setOffline] = useState(false)

  useEffect(() => {
    const handleOnline = () => setOffline(false)
    const handleOffline = () => setOffline(true)

    // Check initial state
    setOffline(!navigator.onLine)

    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [])

  // Register service worker
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        // SW registration failed - non-critical
      })
    }
  }, [])

  if (!offline) return null

  return (
    <Alert className="fixed top-0 left-0 right-0 z-50 rounded-none border-x-0 border-t-0 bg-amber-500 text-amber-950 [&>svg]:text-amber-950">
      <WifiOff className="size-4" />
      <AlertDescription className="text-amber-950">
        You are offline. Changes will not be saved.
      </AlertDescription>
    </Alert>
  )
}
