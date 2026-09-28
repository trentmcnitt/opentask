'use client'

import { useEffect, useRef } from 'react'
import { shouldResumeRefresh } from '@/lib/refresh-guards'

/**
 * Fired on `window` by the native apps when they come to the foreground
 * (`MacAppDelegate.applicationDidBecomeActive`, `OpenTaskApp`'s scenePhase
 * `.active`). See the resume notes on `useSyncStream`.
 */
export const APP_ACTIVE_EVENT = 'opentask-app-active'

export interface EnrichmentCompleteData {
  taskId: number
  title: string
  description?: string
  due_at?: string | null
  priority?: number
}

export interface TaskCreatedData {
  taskId: number
  title: string
}

interface SyncStreamCallbacks {
  onSync: () => void
  onEnrichmentComplete?: (data: EnrichmentCompleteData) => void
  onTaskCreated?: (data: TaskCreatedData) => void
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
 * Resume triggers — the page being looked at again — also run a full refresh
 * and re-open the stream if it has closed:
 * - `visibilitychange` to visible (tab switch, app foregrounded on iOS)
 * - window `focus` — the Mac app's WKWebView usually stays `visible` while
 *   its window is covered by other windows, so clicking back into it fires no
 *   visibilitychange at all; without this, a change made on another device
 *   while the stream was quietly dead stayed on screen until a reload
 * - window `online` — the network came back; the stream may have given up
 * - `opentask-app-active` (`APP_ACTIVE_EVENT`), dispatched by the native apps
 *   on activation, because `focus` is not reliably delivered to a WKWebView
 *
 * Several of these usually fire together, so a resume refresh is skipped when
 * a full refresh started within `RESUME_REFRESH_DEDUPE_MS`
 * (`src/lib/refresh-guards.ts` explains why that is deduplication, not a
 * timing workaround). Refreshes driven by the stream itself are never skipped.
 *
 * Optional onEnrichmentComplete callback fires immediately (no debounce) when
 * AI enrichment finishes for a task created via the on-demand path.
 *
 * Optional onTaskCreated callback fires immediately when a task is created
 * from any client, enabling cross-device "Task added" toasts.
 */
export function useSyncStream(callbacks: SyncStreamCallbacks) {
  const callbacksRef = useRef(callbacks)
  useEffect(() => {
    callbacksRef.current = callbacks
  })

  useEffect(() => {
    let es: EventSource | null = null
    let debounceTimer: ReturnType<typeof setTimeout> | null = null
    // When the last full refresh started (any trigger) — read by the resume
    // dedupe. `onSync` is fire-and-forget, so start time is all there is.
    let lastFullRefreshAt: number | null = null

    function fullRefresh() {
      lastFullRefreshAt = Date.now()
      callbacksRef.current.onSync()
    }

    function debouncedSync() {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(fullRefresh, 300)
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
          } else if (data.type === 'task_created') {
            // Fire immediately — the companion sync event handles data refetch
            callbacksRef.current.onTaskCreated?.(data)
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

    function handleResume() {
      if (document.visibilityState !== 'visible') return
      if (shouldResumeRefresh(lastFullRefreshAt, Date.now())) fullRefresh()
      // Re-open a stream that has given up (the server refused it, or it was
      // never opened). A CONNECTING one is left alone — EventSource is
      // already retrying it.
      if (es?.readyState === EventSource.CLOSED) disconnect()
      connect()
    }

    function handleVisibility() {
      if (document.visibilityState === 'visible') {
        handleResume()
      } else {
        disconnect()
      }
    }

    document.addEventListener('visibilitychange', handleVisibility)
    window.addEventListener('focus', handleResume)
    window.addEventListener('online', handleResume)
    window.addEventListener(APP_ACTIVE_EVENT, handleResume)

    return () => {
      document.removeEventListener('visibilitychange', handleVisibility)
      window.removeEventListener('focus', handleResume)
      window.removeEventListener('online', handleResume)
      window.removeEventListener(APP_ACTIVE_EVENT, handleResume)
      disconnect()
    }
  }, [])
}
