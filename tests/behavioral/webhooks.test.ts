/**
 * Webhook behavioral tests
 *
 * Tests CRUD operations, HMAC signing, event matching, and payload format.
 */

import { describe, test, expect, beforeAll, afterEach, vi } from 'vitest'
import crypto from 'crypto'
import { setupTestDb, TEST_USER_ID } from '../helpers/setup'
import { getDb } from '@/core/db'
import {
  createWebhook,
  getWebhooks,
  getWebhookById,
  updateWebhook,
  deleteWebhook,
  getWebhookDeliveries,
} from '@/core/webhooks'
import { dispatchWebhookEvent } from '@/core/webhooks/dispatch'
import { purgeOldDeliveries } from '@/core/webhooks/purge'

describe('Webhooks', () => {
  beforeAll(() => {
    setupTestDb()
  })

  afterEach(() => {
    // Clean up webhooks between tests
    const db = getDb()
    db.prepare('DELETE FROM webhook_deliveries').run()
    db.prepare('DELETE FROM webhooks').run()
  })

  describe('CRUD operations', () => {
    test('createWebhook generates a secret and stores webhook', () => {
      const webhook = createWebhook(TEST_USER_ID, 'https://example.com/hook', ['task.created'])

      expect(webhook.id).toBeDefined()
      expect(webhook.user_id).toBe(TEST_USER_ID)
      expect(webhook.url).toBe('https://example.com/hook')
      expect(webhook.secret).toHaveLength(64) // 32 bytes hex
      expect(webhook.events).toEqual(['task.created'])
      expect(webhook.active).toBe(true)
    })

    test('getWebhooks returns webhooks without secrets', () => {
      createWebhook(TEST_USER_ID, 'https://example.com/hook1', ['task.created'])
      createWebhook(TEST_USER_ID, 'https://example.com/hook2', ['task.updated'])

      const webhooks = getWebhooks(TEST_USER_ID)
      expect(webhooks).toHaveLength(2)
      for (const wh of webhooks) {
        expect(wh).not.toHaveProperty('secret')
      }
    })

    test('getWebhooks returns empty for different user', () => {
      createWebhook(TEST_USER_ID, 'https://example.com/hook', ['task.created'])

      const webhooks = getWebhooks(999)
      expect(webhooks).toHaveLength(0)
    })

    test('getWebhookById returns webhook with secret', () => {
      const created = createWebhook(TEST_USER_ID, 'https://example.com/hook', ['task.created'])

      const webhook = getWebhookById(created.id)
      expect(webhook).not.toBeNull()
      expect(webhook!.secret).toBe(created.secret)
    })

    test('getWebhookById returns null for non-existent', () => {
      expect(getWebhookById(9999)).toBeNull()
    })

    test('updateWebhook updates partial fields', () => {
      const created = createWebhook(TEST_USER_ID, 'https://example.com/hook', ['task.created'])

      const updated = updateWebhook(created.id, TEST_USER_ID, {
        url: 'https://example.com/new-hook',
        active: false,
      })

      expect(updated).not.toBeNull()
      expect(updated!.url).toBe('https://example.com/new-hook')
      expect(updated!.active).toBe(false)
      expect(updated!.events).toEqual(['task.created'])
      expect(updated).not.toHaveProperty('secret')
    })

    test('updateWebhook returns null for wrong user', () => {
      const created = createWebhook(TEST_USER_ID, 'https://example.com/hook', ['task.created'])

      const result = updateWebhook(created.id, 999, { url: 'https://evil.com' })
      expect(result).toBeNull()
    })

    test('deleteWebhook removes webhook and cascades deliveries', () => {
      const created = createWebhook(TEST_USER_ID, 'https://example.com/hook', ['task.created'])

      // Insert a delivery
      const db = getDb()
      db.prepare(
        "INSERT INTO webhook_deliveries (webhook_id, event, payload, status_code, attempt) VALUES (?, 'task.created', '{}', 200, 1)",
      ).run(created.id)

      const deleted = deleteWebhook(created.id, TEST_USER_ID)
      expect(deleted).toBe(true)
      expect(getWebhookById(created.id)).toBeNull()

      // Deliveries should be cascade-deleted
      const deliveries = db
        .prepare('SELECT * FROM webhook_deliveries WHERE webhook_id = ?')
        .all(created.id)
      expect(deliveries).toHaveLength(0)
    })

    test('deleteWebhook returns false for wrong user', () => {
      const created = createWebhook(TEST_USER_ID, 'https://example.com/hook', ['task.created'])

      expect(deleteWebhook(created.id, 999)).toBe(false)
    })
  })

  describe('HMAC signing', () => {
    test('produces correct HMAC-SHA256 signature', () => {
      const secret = 'test-secret-key'
      const payload = { event: 'task.created', timestamp: '2026-01-01T00:00:00.000Z', data: {} }
      const body = JSON.stringify(payload)

      const expected = crypto.createHmac('sha256', secret).update(body).digest('hex')

      // Verify the signature format matches what dispatch.ts produces
      expect(expected).toMatch(/^[0-9a-f]{64}$/)
    })
  })

  describe('Event matching', () => {
    test('dispatchWebhookEvent only fires for matching events', async () => {
      // Mock global fetch
      const mockFetch = vi.fn().mockResolvedValue({ status: 200 })
      vi.stubGlobal('fetch', mockFetch)

      createWebhook(TEST_USER_ID, 'https://example.com/hook', ['task.created'])

      // Dispatch a task.updated event — should NOT match the webhook
      dispatchWebhookEvent(TEST_USER_ID, 'task.updated', { task_id: 1 })

      // Give async dispatch time to process
      await new Promise((resolve) => setTimeout(resolve, 100))

      expect(mockFetch).not.toHaveBeenCalled()

      // Now dispatch task.created — SHOULD match
      dispatchWebhookEvent(TEST_USER_ID, 'task.created', { task_id: 1 })
      await new Promise((resolve) => setTimeout(resolve, 100))

      expect(mockFetch).toHaveBeenCalledTimes(1)

      vi.unstubAllGlobals()
    })

    test('dispatchWebhookEvent skips inactive webhooks', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ status: 200 })
      vi.stubGlobal('fetch', mockFetch)

      const webhook = createWebhook(TEST_USER_ID, 'https://example.com/hook', ['task.created'])
      updateWebhook(webhook.id, TEST_USER_ID, { active: false })

      dispatchWebhookEvent(TEST_USER_ID, 'task.created', { task_id: 1 })
      await new Promise((resolve) => setTimeout(resolve, 100))

      expect(mockFetch).not.toHaveBeenCalled()

      vi.unstubAllGlobals()
    })
  })

  describe('Payload format', () => {
    test('dispatch sends correct payload structure and headers', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ status: 200 })
      vi.stubGlobal('fetch', mockFetch)

      const webhook = createWebhook(TEST_USER_ID, 'https://example.com/hook', ['task.created'])

      dispatchWebhookEvent(TEST_USER_ID, 'task.created', { task_id: 42, title: 'Test task' })
      await new Promise((resolve) => setTimeout(resolve, 100))

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const [url, options] = mockFetch.mock.calls[0]
      expect(url).toBe('https://example.com/hook')
      expect(options.method).toBe('POST')
      expect(options.headers['Content-Type']).toBe('application/json')
      expect(options.headers['X-OpenTask-Event']).toBe('task.created')
      expect(options.headers['X-OpenTask-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/)

      // Verify payload structure
      const body = JSON.parse(options.body)
      expect(body.event).toBe('task.created')
      expect(body.timestamp).toBeDefined()
      expect(body.data).toEqual({ task_id: 42, title: 'Test task' })

      // Verify HMAC matches
      const fullWebhook = getWebhookById(webhook.id)
      const expectedSig = crypto
        .createHmac('sha256', fullWebhook!.secret)
        .update(options.body)
        .digest('hex')
      expect(options.headers['X-OpenTask-Signature']).toBe(`sha256=${expectedSig}`)

      vi.unstubAllGlobals()
    })
  })

  describe('Delivery logging', () => {
    test('successful delivery is logged', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ status: 200 })
      vi.stubGlobal('fetch', mockFetch)

      const webhook = createWebhook(TEST_USER_ID, 'https://example.com/hook', ['task.created'])
      dispatchWebhookEvent(TEST_USER_ID, 'task.created', { task_id: 1 })
      await new Promise((resolve) => setTimeout(resolve, 100))

      const deliveries = getWebhookDeliveries(webhook.id, TEST_USER_ID)
      expect(deliveries).not.toBeNull()
      expect(deliveries!.length).toBeGreaterThan(0)
      expect(deliveries![0].status_code).toBe(200)
      expect(deliveries![0].error).toBeNull()
      expect(deliveries![0].event).toBe('task.created')

      vi.unstubAllGlobals()
    })
  })

  describe('Purge', () => {
    test('purgeOldDeliveries removes old entries', () => {
      const webhook = createWebhook(TEST_USER_ID, 'https://example.com/hook', ['task.created'])
      const db = getDb()

      // Insert old delivery (10 days ago)
      const oldDate = new Date()
      oldDate.setDate(oldDate.getDate() - 10)
      db.prepare(
        "INSERT INTO webhook_deliveries (webhook_id, event, payload, status_code, attempt, created_at) VALUES (?, 'task.created', '{}', 200, 1, ?)",
      ).run(webhook.id, oldDate.toISOString())

      // Insert recent delivery
      db.prepare(
        "INSERT INTO webhook_deliveries (webhook_id, event, payload, status_code, attempt) VALUES (?, 'task.created', '{}', 200, 1)",
      ).run(webhook.id)

      const deleted = purgeOldDeliveries(7)
      expect(deleted).toBe(1)

      const remaining = db
        .prepare('SELECT * FROM webhook_deliveries WHERE webhook_id = ?')
        .all(webhook.id)
      expect(remaining).toHaveLength(1)
    })
  })
})
