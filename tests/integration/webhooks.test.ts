/**
 * Webhook integration tests
 *
 * Tests CRUD via HTTP, auth, user isolation, and delivery endpoints.
 */

import { describe, test, expect, beforeAll, beforeEach } from 'vitest'
import { apiFetch, apiFetchB, apiAnon, resetTestData } from './helpers'

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
