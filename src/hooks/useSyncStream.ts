'use client'

import { useEffect, useRef } from 'react'

export interface EnrichmentCompleteData {
  taskId: number
  title: string
}

interface SyncStreamCallbacks {
  onSync: () => void
  onEnrichmentComplete?: (data: EnrichmentCompleteData) => void
}

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
 *
 * Optional onEnrichmentComplete callback fires immediately (no debounce) when
 * AI enrichment finishes for a task created via the on-demand path.
 */
export function useSyncStream(callbacks: SyncStreamCallbacks) {
  const callbacksRef = useRef(callbacks)
  useEffect(() => {
    callbacksRef.current = callbacks
  })

  useEffect(() => {
    let es: EventSource | null = null
    let debounceTimer: ReturnType<typeof setTimeout> | null = null

    function debouncedSync() {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => callbacksRef.current.onSync(), 300)
    }

    function connect() {
      if (es) return
      es = new EventSource('/api/sync/stream')
      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)
          if (data.type === 'sync' || data.type === 'connected') {
            debouncedSync()
          } else if (data.type === 'enrichment_complete') {
            // Fire immediately — enrichment events are rare and the user is waiting
            callbacksRef.current.onEnrichmentComplete?.(data)
            debouncedSync()
          }
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
        callbacksRef.current.onSync()
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
