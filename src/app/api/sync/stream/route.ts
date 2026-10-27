/**
 * SSE endpoint for real-time sync
 *
 * Streams "sync" events to connected clients whenever task data changes.
 * Uses the in-memory EventEmitter from sync-events.ts — works because
 * Next.js standalone mode runs a single Node.js process.
 *
 * Clients connect via EventSource, which handles reconnection automatically.
 * A heartbeat every 30s keeps the connection alive through Caddy.
 *
 * Each stream registers its cleanup (`registerSyncStream`), so a SIGTERM can
 * end every open stream and the server can exit; see sync-events.ts § OPEN
 * STREAMS AND SHUTDOWN. A stream asked for while shutting down gets a 503.
 */

import { NextRequest } from 'next/server'
import { getAuthUser, AuthError } from '@/core/auth'
import { serviceUnavailable, unauthorized } from '@/lib/api-response'
import {
  onSyncEvent,
  offSyncEvent,
  onEnrichmentCompleteEvent,
  offEnrichmentCompleteEvent,
  onTaskCreatedEvent,
  offTaskCreatedEvent,
  registerSyncStream,
  isSyncShuttingDown,
  type SyncListener,
  type EnrichmentListener,
  type TaskCreatedListener,
} from '@/lib/sync-events'
import { withLogging } from '@/lib/with-logging'

export const dynamic = 'force-dynamic'

const HEARTBEAT_INTERVAL_MS = 30_000

export const GET = withLogging(async function GET(request: NextRequest) {
  if (isSyncShuttingDown()) return serviceUnavailable('Server is restarting')
  let user
  try {
    user = await getAuthUser(request)
    if (!user) {
      return unauthorized()
    }
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    return unauthorized()
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

      const enrichmentListener: EnrichmentListener = (changedUserId, payload) => {
        if (changedUserId !== userId) return
        try {
          const data = JSON.stringify({
            type: 'enrichment_complete',
            taskId: payload.taskId,
            title: payload.title,
            description: payload.description,
            due_at: payload.due_at,
            priority: payload.priority,
          })
          controller.enqueue(encoder.encode(`data: ${data}\n\n`))
        } catch {
          // Stream closed, cleanup will happen via abort signal
        }
      }

      const taskCreatedListener: TaskCreatedListener = (changedUserId, payload) => {
        if (changedUserId !== userId) return
        try {
          const data = JSON.stringify({
            type: 'task_created',
            taskId: payload.taskId,
            title: payload.title,
          })
          controller.enqueue(encoder.encode(`data: ${data}\n\n`))
        } catch {
          // Stream closed, cleanup will happen via abort signal
        }
      }

      onSyncEvent(listener)
      onEnrichmentCompleteEvent(enrichmentListener)
      onTaskCreatedEvent(taskCreatedListener)

      // Heartbeat to keep connection alive through proxies
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': heartbeat\n\n'))
        } catch {
          clearInterval(heartbeat)
        }
      }, HEARTBEAT_INTERVAL_MS)

      // Cleanup, once: on client disconnect, or when the server shuts down.
      let closed = false
      const cleanup = () => {
        if (closed) return
        closed = true
        unregister()
        offSyncEvent(listener)
        offEnrichmentCompleteEvent(enrichmentListener)
        offTaskCreatedEvent(taskCreatedListener)
        clearInterval(heartbeat)
        try {
          controller.close()
        } catch {
          // Already closed
        }
      }
      const unregister = registerSyncStream(cleanup)
      request.signal.addEventListener('abort', cleanup)

      // Send initial connected event
      controller.enqueue(encoder.encode('data: {"type":"connected"}\n\n'))
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      // Not keep-alive: when the stream ends (a SIGTERM's closeAllSyncStreams),
      // the socket closes with it. Kept alive, the idle connection held the
      // server's close() for Node's keep-alive timeout (~5 s more per restart).
      // A stream lives for minutes, so reusing its connection saves nothing.
      Connection: 'close',
    },
  })
})
