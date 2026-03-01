/**
 * Webhook integration tests
 *
 * Tests CRUD via HTTP, auth, user isolation, delivery endpoints,
 * and webhook dispatch from mutations.
 */

import { describe, test, expect, beforeAll, beforeEach } from 'vitest'
import { apiFetch, apiFetchB, apiAnon, resetTestData } from './helpers'

/** Wait for async webhook dispatch to complete */
function waitForDispatch(ms = 200) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('Webhooks integration', () => {
  beforeAll(async () => {
    await resetTestData()
  })

  describe('Auth', () => {
    test('GET /api/webhooks requires auth', async () => {
      const res = await apiAnon('/api/webhooks')
      expect(res.status).toBe(401)
    })

    test('POST /api/webhooks requires auth', async () => {
      const res = await apiAnon('/api/webhooks', {
        method: 'POST',
        body: { url: 'https://example.com/hook', events: ['task.created'] },
      })
      expect(res.status).toBe(401)
    })
  })

  describe('CRUD', () => {
    let webhookId: number

    test('POST creates a webhook and returns secret', async () => {
      const res = await apiFetch('/api/webhooks', {
        method: 'POST',
        body: { url: 'https://example.com/hook', events: ['task.created', 'task.updated'] },
      })
      expect(res.status).toBe(201)

      const data = (await res.json()).data
      expect(data.id).toBeDefined()
      expect(data.url).toBe('https://example.com/hook')
      expect(data.events).toEqual(['task.created', 'task.updated'])
      expect(data.secret).toBeDefined()
      expect(data.secret).toHaveLength(64)
      expect(data.active).toBe(true)

      webhookId = data.id
    })

    test('GET lists webhooks without secrets', async () => {
      const res = await apiFetch('/api/webhooks')
      expect(res.status).toBe(200)

      const data = (await res.json()).data
      expect(data.webhooks.length).toBeGreaterThan(0)

      const webhook = data.webhooks.find((w: { id: number }) => w.id === webhookId)
      expect(webhook).toBeDefined()
      expect(webhook.url).toBe('https://example.com/hook')
      expect(webhook).not.toHaveProperty('secret')
    })

    test('PATCH updates webhook fields', async () => {
      const res = await apiFetch(`/api/webhooks/${webhookId}`, {
        method: 'PATCH',
        body: { url: 'https://example.com/new-hook', active: false },
      })
      expect(res.status).toBe(200)

      const data = (await res.json()).data
      expect(data.url).toBe('https://example.com/new-hook')
      expect(data.active).toBe(false)
      expect(data).not.toHaveProperty('secret')
    })

    test('GET deliveries returns empty initially', async () => {
      const res = await apiFetch(`/api/webhooks/${webhookId}/deliveries`)
      expect(res.status).toBe(200)

      const data = (await res.json()).data
      expect(data.deliveries).toEqual([])
    })

    test('DELETE removes webhook', async () => {
      const res = await apiFetch(`/api/webhooks/${webhookId}`, { method: 'DELETE' })
      expect(res.status).toBe(200)

      const data = (await res.json()).data
      expect(data.deleted).toBe(true)

      // Verify it's gone
      const getRes = await apiFetch(`/api/webhooks/${webhookId}/deliveries`)
      expect(getRes.status).toBe(404)
    })
  })

  describe('Validation', () => {
    test('POST with invalid URL returns 400', async () => {
      const res = await apiFetch('/api/webhooks', {
        method: 'POST',
        body: { url: 'not-a-url', events: ['task.created'] },
      })
      expect(res.status).toBe(400)
    })

    test('POST with empty events returns 400', async () => {
      const res = await apiFetch('/api/webhooks', {
        method: 'POST',
        body: { url: 'https://example.com/hook', events: [] },
      })
      expect(res.status).toBe(400)
    })

    test('POST with invalid event type returns 400', async () => {
      const res = await apiFetch('/api/webhooks', {
        method: 'POST',
        body: { url: 'https://example.com/hook', events: ['invalid.event'] },
      })
      expect(res.status).toBe(400)
    })
  })

  describe('User isolation', () => {
    let userAWebhookId: number

    beforeEach(async () => {
      // Create webhook as user A
      const res = await apiFetch('/api/webhooks', {
        method: 'POST',
        body: { url: 'https://example.com/user-a-hook', events: ['task.created'] },
      })
      userAWebhookId = (await res.json()).data.id
    })

    test('User B cannot see User A webhooks', async () => {
      const res = await apiFetchB('/api/webhooks')
      expect(res.status).toBe(200)

      const data = (await res.json()).data
      const found = data.webhooks.find((w: { id: number }) => w.id === userAWebhookId)
      expect(found).toBeUndefined()
    })

    test('User B cannot update User A webhook', async () => {
      const res = await apiFetchB(`/api/webhooks/${userAWebhookId}`, {
        method: 'PATCH',
        body: { url: 'https://evil.com' },
      })
      expect(res.status).toBe(404)
    })

    test('User B cannot delete User A webhook', async () => {
      const res = await apiFetchB(`/api/webhooks/${userAWebhookId}`, { method: 'DELETE' })
      expect(res.status).toBe(404)
    })

    test('User B cannot view User A webhook deliveries', async () => {
      const res = await apiFetchB(`/api/webhooks/${userAWebhookId}/deliveries`)
      expect(res.status).toBe(404)
    })
  })
})

/**
 * Webhook dispatch verification
 *
 * Creates a webhook pointing to an unreachable URL. When a mutation fires,
 * the dispatch attempt fails and is logged as a delivery. We verify via
 * GET /api/webhooks/:id/deliveries that the correct event was dispatched.
 */
describe('Webhook dispatch from mutations', () => {
  let webhookId: number

  beforeAll(async () => {
    await resetTestData()
  })

  beforeEach(async () => {
    await resetTestData()

    // Create a webhook that listens to all events, pointing to unreachable URL
    const res = await apiFetch('/api/webhooks', {
      method: 'POST',
      body: {
        url: 'https://127.0.0.1:1/hook',
        events: ['task.created', 'task.updated', 'task.completed', 'task.snoozed', 'task.deleted'],
      },
    })
    expect(res.status).toBe(201)
    webhookId = (await res.json()).data.id
  })

  test('create task dispatches task.created', async () => {
    await apiFetch('/api/tasks', {
      method: 'POST',
      body: { title: 'Webhook test task', project_id: 1 },
    })

    await waitForDispatch()

    const delRes = await apiFetch(`/api/webhooks/${webhookId}/deliveries`)
    const deliveries = (await delRes.json()).data.deliveries
    const created = deliveries.find((d: { event: string }) => d.event === 'task.created')
    expect(created).toBeDefined()
    expect(created.error).toBeDefined() // unreachable URL → error logged
  })

  test('update task dispatches task.updated', async () => {
    await apiFetch('/api/tasks/1', {
      method: 'PATCH',
      body: { title: 'Updated for webhook test' },
    })

    await waitForDispatch()

    const delRes = await apiFetch(`/api/webhooks/${webhookId}/deliveries`)
    const deliveries = (await delRes.json()).data.deliveries
    const updated = deliveries.find((d: { event: string }) => d.event === 'task.updated')
    expect(updated).toBeDefined()
  })

  test('mark done dispatches task.completed', async () => {
    await apiFetch('/api/tasks/7/done', { method: 'POST' })

    await waitForDispatch()

    const delRes = await apiFetch(`/api/webhooks/${webhookId}/deliveries`)
    const deliveries = (await delRes.json()).data.deliveries
    const completed = deliveries.find((d: { event: string }) => d.event === 'task.completed')
    expect(completed).toBeDefined()
  })

  test('snooze dispatches task.snoozed', async () => {
    const until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    await apiFetch('/api/tasks/1/snooze', {
      method: 'POST',
      body: { until },
    })

    await waitForDispatch()

    const delRes = await apiFetch(`/api/webhooks/${webhookId}/deliveries`)
    const deliveries = (await delRes.json()).data.deliveries
    const snoozed = deliveries.find((d: { event: string }) => d.event === 'task.snoozed')
    expect(snoozed).toBeDefined()
  })

  test('delete dispatches task.deleted', async () => {
    await apiFetch('/api/tasks/8', { method: 'DELETE' })

    await waitForDispatch()

    const delRes = await apiFetch(`/api/webhooks/${webhookId}/deliveries`)
    const deliveries = (await delRes.json()).data.deliveries
    const deleted = deliveries.find((d: { event: string }) => d.event === 'task.deleted')
    expect(deleted).toBeDefined()
  })
})
