/**
 * SSE endpoint for real-time sync
 *
 * Streams "sync" events to connected clients whenever task data changes.
 * Uses the in-memory EventEmitter from sync-events.ts — works because
 * Next.js standalone mode runs a single Node.js process.
 *
 * Clients connect via EventSource, which handles reconnection automatically.
 * A heartbeat every 30s keeps the connection alive through Caddy.
 */

import { NextRequest } from 'next/server'
import { getAuthUser } from '@/core/auth'
import { onSyncEvent, offSyncEvent, type SyncListener } from '@/lib/sync-events'

export const dynamic = 'force-dynamic'

const HEARTBEAT_INTERVAL_MS = 30_000

export async function GET(request: NextRequest) {
  const user = await getAuthUser(request)
  if (!user) {
    return new Response('Unauthorized', { status: 401 })
  }

  const userId = user.id
  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    start(controller) {
      const listener: SyncListener = (changedUserId) => {
        if (changedUserId !== userId) return
        try {
          controller.enqueue(encoder.encode('data: {"type":"sync"}\n\n'))
        } catch {
          // Stream closed, cleanup will happen via abort signal
        }
      }

      onSyncEvent(listener)

      // Heartbeat to keep connection alive through proxies
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': heartbeat\n\n'))
        } catch {
          clearInterval(heartbeat)
        }
      }, HEARTBEAT_INTERVAL_MS)

      // Cleanup on client disconnect
      request.signal.addEventListener('abort', () => {
        offSyncEvent(listener)
        clearInterval(heartbeat)
        try {
          controller.close()
        } catch {
          // Already closed
        }
      })

      // Send initial connected event
      controller.enqueue(encoder.encode('data: {"type":"connected"}\n\n'))
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  })
}
