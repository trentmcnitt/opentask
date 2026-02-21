'use client'

import { useEffect, useRef } from 'react'

/**
 * SSE-based real-time sync hook
 *
 * Connects to /api/sync/stream and calls onSync when task data changes
 * on the server (from any client — browser, iOS app, Watch, API).
 *
 * - Debounces rapid events (300ms) to coalesce quick successive mutations
 * - Refetches on reconnect (catches up after server restart, deploy, or network blip)
 * - Disconnects when the tab is hidden (saves resources on mobile)
 * - Immediately syncs + reconnects when the tab becomes visible again
 * - EventSource handles reconnection automatically on network errors
 */
export function useSyncStream(onSync: () => void) {
  const onSyncRef = useRef(onSync)
  useEffect(() => {
    onSyncRef.current = onSync
  })

  useEffect(() => {
    let es: EventSource | null = null
    let debounceTimer: ReturnType<typeof setTimeout> | null = null

    function debouncedSync() {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => onSyncRef.current(), 300)
    }

    function connect() {
      if (es) return
      es = new EventSource('/api/sync/stream')
      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)
          if (data.type === 'sync' || data.type === 'connected') debouncedSync()
        } catch {
          // Ignore malformed messages
        }
      }
      es.onerror = () => {
        // EventSource reconnects automatically on transient errors.
        // CLOSED means the server rejected the connection (e.g., 401).
        if (es?.readyState === EventSource.CLOSED) {
          disconnect()
        }
      }
    }

    function disconnect() {
      if (es) {
        es.close()
        es = null
      }
      if (debounceTimer) {
        clearTimeout(debounceTimer)
        debounceTimer = null
      }
    }

    if (document.visibilityState === 'visible') {
      connect()
    }

    function handleVisibility() {
      if (document.visibilityState === 'visible') {
        onSyncRef.current()
        connect()
      } else {
        disconnect()
      }
    }

    document.addEventListener('visibilitychange', handleVisibility)

    return () => {
      document.removeEventListener('visibilitychange', handleVisibility)
      disconnect()
    }
  }, [])
}
