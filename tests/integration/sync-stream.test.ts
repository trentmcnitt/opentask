import { describe, test, expect, beforeAll } from 'vitest'
import { apiFetch, apiAnon, baseUrl, TOKEN_A, TOKEN_B, resetTestData } from './helpers'

/**
 * Helper to connect to the SSE stream and collect events.
 * Returns a controller object to read events and close the connection.
 */
function connectSSE(token: string) {
  const events: string[] = []
  let streamDone = false
  const controller = new AbortController()

  const responsePromise = fetch(`${baseUrl()}/api/sync/stream`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: controller.signal,
  })

  const readerPromise = responsePromise.then(async (res) => {
    if (!res.ok || !res.body) {
      streamDone = true
      return res.status
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()

    // Read chunks in background
    ;(async () => {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          const text = decoder.decode(value, { stream: true })
          // Parse SSE lines: "data: {...}\n\n"
          for (const line of text.split('\n')) {
            if (line.startsWith('data: ')) {
              events.push(line.slice(6))
            }
          }
        }
      } catch {
        // AbortError when we close the connection — expected
      } finally {
        streamDone = true
      }
    })()

    return res.status
  })

  return {
    events,
    /** Wait until at least `count` events have arrived, with timeout */
    async waitForEvents(count: number, timeoutMs = 5000): Promise<void> {
      const start = Date.now()
      while (events.length < count && Date.now() - start < timeoutMs) {
        await new Promise((r) => setTimeout(r, 50))
      }
    },
    async getStatus(): Promise<number> {
      return readerPromise
    },
    close() {
      controller.abort()
    },
    get done() {
      return streamDone
    },
  }
}

describe('SSE sync stream', () => {
  beforeAll(async () => {
    await resetTestData()
  })

  test('returns 401 for unauthenticated requests', async () => {
    const res = await apiAnon('/api/sync/stream')
    expect(res.status).toBe(401)
  })

  test('returns 401 for invalid Bearer token', async () => {
    const res = await apiAnon('/api/sync/stream', {
      headers: { Authorization: 'Bearer invalid-token' },
    })
    expect(res.status).toBe(401)
  })

  test('sends connected event on initial connection', async () => {
    const sse = connectSSE(TOKEN_A)
    try {
      await sse.waitForEvents(1)
      expect(sse.events.length).toBeGreaterThanOrEqual(1)
      const connected = JSON.parse(sse.events[0])
      expect(connected.type).toBe('connected')
    } finally {
      sse.close()
    }
  })

  test('sends sync event when a task is mutated', async () => {
    const sse = connectSSE(TOKEN_A)
    try {
      // Wait for connected event
      await sse.waitForEvents(1)
      expect(JSON.parse(sse.events[0]).type).toBe('connected')

      // Snooze task 1 (triggers logAction → emitSyncEvent)
      const futureTime = new Date(Date.now() + 3600_000).toISOString()
      const snoozeRes = await apiFetch('/api/tasks/1/snooze', {
        method: 'POST',
        body: { until: futureTime },
      })
      expect(snoozeRes.status).toBe(200)

      // Wait for sync event
      await sse.waitForEvents(2)
      expect(sse.events.length).toBeGreaterThanOrEqual(2)
      const syncEvent = JSON.parse(sse.events[1])
      expect(syncEvent.type).toBe('sync')
    } finally {
      sse.close()
    }
  })

  test('sends sync event when a task is marked done', async () => {
    const sse = connectSSE(TOKEN_A)
    try {
      await sse.waitForEvents(1)

      const doneRes = await apiFetch('/api/tasks/1/done', { method: 'POST' })
      expect(doneRes.status).toBe(200)

      await sse.waitForEvents(2)
      const syncEvent = JSON.parse(sse.events[1])
      expect(syncEvent.type).toBe('sync')
    } finally {
      sse.close()
    }
  })

  test('sends sync event on undo', async () => {
    // Task 1 was marked done in previous test — undo it
    const sse = connectSSE(TOKEN_A)
    try {
      await sse.waitForEvents(1)

      const undoRes = await apiFetch('/api/undo', { method: 'POST' })
      expect(undoRes.status).toBe(200)

      await sse.waitForEvents(2)
      const syncEvent = JSON.parse(sse.events[1])
      expect(syncEvent.type).toBe('sync')
    } finally {
      sse.close()
    }
  })

  test('User B does not receive sync events for User A mutations', async () => {
    const sseB = connectSSE(TOKEN_B)
    try {
      await sseB.waitForEvents(1)
      expect(JSON.parse(sseB.events[0]).type).toBe('connected')

      // User A snoozes a task
      const futureTime = new Date(Date.now() + 7200_000).toISOString()
      await apiFetch('/api/tasks/1/snooze', {
        method: 'POST',
        body: { until: futureTime },
      })

      // Wait briefly — User B should NOT get a sync event
      await new Promise((r) => setTimeout(r, 500))
      expect(sseB.events.length).toBe(1) // Only the "connected" event
    } finally {
      sseB.close()
    }
  })

  test('sends task_created event when a task is created', async () => {
    const sse = connectSSE(TOKEN_A)
    try {
      await sse.waitForEvents(1)
      expect(JSON.parse(sse.events[0]).type).toBe('connected')

      // Create a task
      const createRes = await apiFetch('/api/tasks', {
        method: 'POST',
        body: { title: 'SSE test task' },
      })
      expect(createRes.status).toBe(201)
      const { data: created } = await createRes.json()

      // Should receive both sync and task_created events
      await sse.waitForEvents(3)
      const eventTypes = sse.events.slice(1).map((e) => JSON.parse(e).type)
      expect(eventTypes).toContain('sync')
      expect(eventTypes).toContain('task_created')

      // Verify task_created payload
      const taskCreatedEvent = sse.events
        .slice(1)
        .map((e) => JSON.parse(e))
        .find((e) => e.type === 'task_created')
      expect(taskCreatedEvent.taskId).toBe(created.id)
      expect(taskCreatedEvent.title).toBe('SSE test task')
    } finally {
      sse.close()
    }
  })

  test('sends sync event for bulk operations', async () => {
    const sse = connectSSE(TOKEN_A)
    try {
      await sse.waitForEvents(1)

      // Bulk snooze
      const futureTime = new Date(Date.now() + 3600_000).toISOString()
      const bulkRes = await apiFetch('/api/tasks/bulk/snooze', {
        method: 'POST',
        body: { ids: [1, 2], until: futureTime },
      })
      expect(bulkRes.status).toBe(200)

      await sse.waitForEvents(2)
      const syncEvent = JSON.parse(sse.events[1])
      expect(syncEvent.type).toBe('sync')
    } finally {
      sse.close()
    }
  })
})
