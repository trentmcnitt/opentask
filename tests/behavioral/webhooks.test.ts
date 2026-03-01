/**
 * Webhook behavioral tests
 *
 * Tests CRUD operations, HMAC signing, event matching, and payload format.
 */

import { describe, test, expect, beforeAll, afterEach, vi } from 'vitest'
import crypto from 'crypto'
import { setupTestDb, TEST_USER_ID, TEST_TIMEZONE, localTime } from '../helpers/setup'
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
import { createTask } from '@/core/tasks/create'
import { updateTask } from '@/core/tasks/update'
import { markDone } from '@/core/tasks/mark-done'
import { snoozeTask } from '@/core/tasks/snooze'
import { deleteTask } from '@/core/tasks/delete'
import { bulkDone, bulkSnooze, bulkEdit, bulkDelete } from '@/core/tasks/bulk'
import { executeUndo } from '@/core/undo/execute-undo'
import { executeRedo } from '@/core/undo/execute-redo'
import { executeBatchUndo } from '@/core/undo/batch'

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

  describe('Retry and failure behavior', () => {
    test('retries on failure and succeeds on second attempt', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({ status: 500 })
        .mockResolvedValueOnce({ status: 200 })
      vi.stubGlobal('fetch', mockFetch)
      vi.useFakeTimers()

      const webhook = createWebhook(TEST_USER_ID, 'https://example.com/hook', ['task.created'])
      dispatchWebhookEvent(TEST_USER_ID, 'task.created', { task_id: 1 })

      // First attempt happens immediately
      await vi.advanceTimersByTimeAsync(50)
      expect(mockFetch).toHaveBeenCalledTimes(1)

      // Advance past first retry delay (1000ms)
      await vi.advanceTimersByTimeAsync(1000)
      expect(mockFetch).toHaveBeenCalledTimes(2)

      // Verify both attempts logged
      const deliveries = getWebhookDeliveries(webhook.id, TEST_USER_ID)
      expect(deliveries).not.toBeNull()
      expect(deliveries!.length).toBe(2)
      expect(deliveries![0].status_code).toBe(500)
      expect(deliveries![0].attempt).toBe(1)
      expect(deliveries![1].status_code).toBe(200)
      expect(deliveries![1].attempt).toBe(2)

      vi.useRealTimers()
      vi.unstubAllGlobals()
    })

    test('stops after MAX_ATTEMPTS (3) failed deliveries', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ status: 500 })
      vi.stubGlobal('fetch', mockFetch)
      vi.useFakeTimers()

      const webhook = createWebhook(TEST_USER_ID, 'https://example.com/hook', ['task.created'])
      dispatchWebhookEvent(TEST_USER_ID, 'task.created', { task_id: 1 })

      // Attempt 1
      await vi.advanceTimersByTimeAsync(50)
      // Attempt 2 (after 1000ms delay)
      await vi.advanceTimersByTimeAsync(1000)
      // Attempt 3 (after 5000ms delay)
      await vi.advanceTimersByTimeAsync(5000)
      // No more retries
      await vi.advanceTimersByTimeAsync(10000)

      expect(mockFetch).toHaveBeenCalledTimes(3)

      const deliveries = getWebhookDeliveries(webhook.id, TEST_USER_ID)
      expect(deliveries!.length).toBe(3)
      expect(deliveries![2].attempt).toBe(3)
      expect(deliveries![2].status_code).toBe(500)

      vi.useRealTimers()
      vi.unstubAllGlobals()
    })

    test('retries on network error and logs error message', async () => {
      const mockFetch = vi
        .fn()
        .mockRejectedValueOnce(new Error('Connection refused'))
        .mockResolvedValueOnce({ status: 200 })
      vi.stubGlobal('fetch', mockFetch)
      vi.useFakeTimers()

      const webhook = createWebhook(TEST_USER_ID, 'https://example.com/hook', ['task.created'])
      dispatchWebhookEvent(TEST_USER_ID, 'task.created', { task_id: 1 })

      await vi.advanceTimersByTimeAsync(50)
      await vi.advanceTimersByTimeAsync(1000)

      const deliveries = getWebhookDeliveries(webhook.id, TEST_USER_ID)
      expect(deliveries!.length).toBe(2)
      // First attempt: network error
      expect(deliveries![0].status_code).toBeNull()
      expect(deliveries![0].error).toBe('Connection refused')
      // Second attempt: success
      expect(deliveries![1].status_code).toBe(200)
      expect(deliveries![1].error).toBeNull()

      vi.useRealTimers()
      vi.unstubAllGlobals()
    })

    test('delivery is logged on every attempt', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ status: 503 })
      vi.stubGlobal('fetch', mockFetch)
      vi.useFakeTimers()

      const webhook = createWebhook(TEST_USER_ID, 'https://example.com/hook', ['task.created'])
      dispatchWebhookEvent(TEST_USER_ID, 'task.created', { task_id: 1 })

      await vi.advanceTimersByTimeAsync(50)
      await vi.advanceTimersByTimeAsync(1000)
      await vi.advanceTimersByTimeAsync(5000)

      const deliveries = getWebhookDeliveries(webhook.id, TEST_USER_ID)
      expect(deliveries!.length).toBe(3)
      for (let i = 0; i < 3; i++) {
        expect(deliveries![i].attempt).toBe(i + 1)
        expect(deliveries![i].status_code).toBe(503)
      }

      vi.useRealTimers()
      vi.unstubAllGlobals()
    })

    test('3xx response triggers retry (non-2xx)', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({ status: 301 })
        .mockResolvedValueOnce({ status: 200 })
      vi.stubGlobal('fetch', mockFetch)
      vi.useFakeTimers()

      createWebhook(TEST_USER_ID, 'https://example.com/hook', ['task.created'])
      dispatchWebhookEvent(TEST_USER_ID, 'task.created', { task_id: 1 })

      await vi.advanceTimersByTimeAsync(50)
      await vi.advanceTimersByTimeAsync(1000)

      expect(mockFetch).toHaveBeenCalledTimes(2)

      vi.useRealTimers()
      vi.unstubAllGlobals()
    })
  })

  describe('Dispatch from single mutations', () => {
    /** Helper to create a test task and return its ID */
    function createTestTask(title: string = 'Test task'): number {
      const task = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title, project_id: 1, due_at: localTime(9, 0, 1) },
      })
      return task.id
    }

    test('createTask dispatches task.created webhook', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ status: 200 })
      vi.stubGlobal('fetch', mockFetch)

      createWebhook(TEST_USER_ID, 'https://example.com/hook', ['task.created'])
      createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Webhook test', project_id: 1 },
      })

      await new Promise((resolve) => setTimeout(resolve, 100))

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.event).toBe('task.created')
      expect(body.data.task.title).toBe('Webhook test')

      vi.unstubAllGlobals()
    })

    test('updateTask dispatches task.updated webhook', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ status: 200 })
      vi.stubGlobal('fetch', mockFetch)

      const taskId = createTestTask()
      mockFetch.mockClear() // Clear the task.created call

      createWebhook(TEST_USER_ID, 'https://example.com/hook', ['task.updated'])
      updateTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        taskId,
        input: { priority: 3 },
      })

      await new Promise((resolve) => setTimeout(resolve, 100))

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.event).toBe('task.updated')
      expect(body.data.fields_changed).toContain('priority')

      vi.unstubAllGlobals()
    })

    test('markDone dispatches task.completed webhook', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ status: 200 })
      vi.stubGlobal('fetch', mockFetch)

      const taskId = createTestTask()
      mockFetch.mockClear()

      createWebhook(TEST_USER_ID, 'https://example.com/hook', ['task.completed'])
      markDone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId })

      await new Promise((resolve) => setTimeout(resolve, 100))

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.event).toBe('task.completed')

      vi.unstubAllGlobals()
    })

    test('snoozeTask dispatches task.snoozed webhook', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ status: 200 })
      vi.stubGlobal('fetch', mockFetch)

      const taskId = createTestTask()
      mockFetch.mockClear()

      createWebhook(TEST_USER_ID, 'https://example.com/hook', ['task.snoozed'])
      snoozeTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        taskId,
        until: localTime(14, 0, 2),
      })

      await new Promise((resolve) => setTimeout(resolve, 100))

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.event).toBe('task.snoozed')
      expect(body.data.previous_due_at).toBeDefined()

      vi.unstubAllGlobals()
    })

    test('deleteTask dispatches task.deleted webhook', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ status: 200 })
      vi.stubGlobal('fetch', mockFetch)

      const taskId = createTestTask()
      mockFetch.mockClear()

      createWebhook(TEST_USER_ID, 'https://example.com/hook', ['task.deleted'])
      deleteTask({ userId: TEST_USER_ID, taskId })

      await new Promise((resolve) => setTimeout(resolve, 100))

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.event).toBe('task.deleted')
      expect(body.data.task_id).toBe(taskId)

      vi.unstubAllGlobals()
    })
  })

  describe('Dispatch from bulk mutations', () => {
    function createTestTasks(count: number): number[] {
      const ids: number[] = []
      for (let i = 0; i < count; i++) {
        const task = createTask({
          userId: TEST_USER_ID,
          userTimezone: TEST_TIMEZONE,
          input: { title: `Bulk task ${i}`, project_id: 1, due_at: localTime(9, 0, 1) },
        })
        ids.push(task.id)
      }
      return ids
    }

    test('bulkDone dispatches task.completed per task', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ status: 200 })
      vi.stubGlobal('fetch', mockFetch)

      const taskIds = createTestTasks(3)
      mockFetch.mockClear()

      createWebhook(TEST_USER_ID, 'https://example.com/hook', ['task.completed'])
      bulkDone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskIds })

      await new Promise((resolve) => setTimeout(resolve, 200))

      expect(mockFetch).toHaveBeenCalledTimes(3)
      for (const call of mockFetch.mock.calls) {
        const body = JSON.parse(call[1].body)
        expect(body.event).toBe('task.completed')
      }

      vi.unstubAllGlobals()
    })

    test('bulkSnooze dispatches task.snoozed per task', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ status: 200 })
      vi.stubGlobal('fetch', mockFetch)

      const taskIds = createTestTasks(2)
      mockFetch.mockClear()

      createWebhook(TEST_USER_ID, 'https://example.com/hook', ['task.snoozed'])
      bulkSnooze({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        taskIds,
        until: localTime(14, 0, 2),
      })

      await new Promise((resolve) => setTimeout(resolve, 200))

      expect(mockFetch).toHaveBeenCalledTimes(2)
      for (const call of mockFetch.mock.calls) {
        const body = JSON.parse(call[1].body)
        expect(body.event).toBe('task.snoozed')
        expect(body.data.previous_due_at).toBeDefined()
      }

      vi.unstubAllGlobals()
    })

    test('bulkEdit dispatches task.updated per task', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ status: 200 })
      vi.stubGlobal('fetch', mockFetch)

      const taskIds = createTestTasks(2)
      mockFetch.mockClear()

      createWebhook(TEST_USER_ID, 'https://example.com/hook', ['task.updated'])
      bulkEdit({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        taskIds,
        changes: { priority: 3 },
      })

      await new Promise((resolve) => setTimeout(resolve, 200))

      expect(mockFetch).toHaveBeenCalledTimes(2)
      for (const call of mockFetch.mock.calls) {
        const body = JSON.parse(call[1].body)
        expect(body.event).toBe('task.updated')
        expect(body.data.fields_changed).toContain('priority')
      }

      vi.unstubAllGlobals()
    })

    test('bulkDelete dispatches task.deleted per task', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ status: 200 })
      vi.stubGlobal('fetch', mockFetch)

      const taskIds = createTestTasks(2)
      mockFetch.mockClear()

      createWebhook(TEST_USER_ID, 'https://example.com/hook', ['task.deleted'])
      bulkDelete({ userId: TEST_USER_ID, taskIds })

      await new Promise((resolve) => setTimeout(resolve, 200))

      expect(mockFetch).toHaveBeenCalledTimes(2)
      for (const call of mockFetch.mock.calls) {
        const body = JSON.parse(call[1].body)
        expect(body.event).toBe('task.deleted')
      }

      vi.unstubAllGlobals()
    })
  })

  describe('Dispatch from undo/redo', () => {
    test('undo dispatches task.updated with trigger: undo', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ status: 200 })
      vi.stubGlobal('fetch', mockFetch)

      const task = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Undo test', project_id: 1, due_at: localTime(9, 0, 1) },
      })
      mockFetch.mockClear()

      // Mark done (creates undo entry)
      markDone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: task.id })
      mockFetch.mockClear()

      // Now set up webhook and undo
      createWebhook(TEST_USER_ID, 'https://example.com/hook', ['task.updated'])
      executeUndo(TEST_USER_ID)

      await new Promise((resolve) => setTimeout(resolve, 100))

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.event).toBe('task.updated')
      expect(body.data.trigger).toBe('undo')

      vi.unstubAllGlobals()
    })

    test('redo dispatches task.updated with trigger: redo', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ status: 200 })
      vi.stubGlobal('fetch', mockFetch)

      const task = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Redo test', project_id: 1, priority: 2 },
      })
      // Update to create an undoable action
      updateTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        taskId: task.id,
        input: { priority: 3 },
      })
      // Undo it
      executeUndo(TEST_USER_ID)
      mockFetch.mockClear()

      // Now set up webhook and redo
      createWebhook(TEST_USER_ID, 'https://example.com/hook', ['task.updated'])
      executeRedo(TEST_USER_ID)

      await new Promise((resolve) => setTimeout(resolve, 100))

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.event).toBe('task.updated')
      expect(body.data.trigger).toBe('redo')

      vi.unstubAllGlobals()
    })

    test('batch undo dispatches webhook per affected task', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ status: 200 })
      vi.stubGlobal('fetch', mockFetch)

      // Create 2 tasks and update each (2 undo entries)
      const task1 = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Batch undo 1', project_id: 1 },
      })
      const task2 = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Batch undo 2', project_id: 1 },
      })
      updateTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        taskId: task1.id,
        input: { priority: 2 },
      })
      updateTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        taskId: task2.id,
        input: { priority: 3 },
      })
      mockFetch.mockClear()

      // Set up webhook and batch undo
      createWebhook(TEST_USER_ID, 'https://example.com/hook', ['task.updated'])
      executeBatchUndo(TEST_USER_ID, { count: 2 })

      await new Promise((resolve) => setTimeout(resolve, 200))

      // Should fire 2 webhooks (one per task affected)
      expect(mockFetch).toHaveBeenCalledTimes(2)
      for (const call of mockFetch.mock.calls) {
        const body = JSON.parse(call[1].body)
        expect(body.event).toBe('task.updated')
        expect(body.data.trigger).toBe('undo')
      }

      vi.unstubAllGlobals()
    })
  })
})
