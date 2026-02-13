import { describe, test, expect, beforeAll } from 'vitest'
import { apiFetch, apiFetchB, apiAnon, resetTestData } from './helpers'

describe('AI endpoints integration', () => {
  beforeAll(async () => {
    await resetTestData()
  })

  describe('authentication', () => {
    test('GET /api/ai/status returns 401 without auth', async () => {
      const res = await apiAnon('/api/ai/status')
      expect(res.status).toBe(401)
    })

    test('GET /api/ai/whats-next returns 401 without auth', async () => {
      const res = await apiAnon('/api/ai/whats-next')
      expect(res.status).toBe(401)
    })
  })

  describe('AI disabled (503)', () => {
    test('GET /api/ai/status returns 503 with SERVICE_UNAVAILABLE code', async () => {
      const res = await apiFetch('/api/ai/status')
      expect(res.status).toBe(503)
      const body = await res.json()
      expect(body.error).toBe('AI features are not enabled')
      expect(body.code).toBe('SERVICE_UNAVAILABLE')
    })

    test('GET /api/ai/whats-next returns 503', async () => {
      const res = await apiFetch('/api/ai/whats-next')
      expect(res.status).toBe(503)
      const body = await res.json()
      expect(body.error).toBe('AI features are not enabled')
      expect(body.code).toBe('SERVICE_UNAVAILABLE')
    })

    test('GET /api/ai/whats-next?refresh=true returns 503', async () => {
      const res = await apiFetch('/api/ai/whats-next?refresh=true')
      expect(res.status).toBe(503)
      const body = await res.json()
      expect(body.code).toBe('SERVICE_UNAVAILABLE')
    })

    test('GET /api/ai/status with query params does not crash', async () => {
      const res = await apiFetch('/api/ai/status?limit=5&offset=0&action=enrich')
      expect(res.status).toBe(503)
      const body = await res.json()
      expect(body.code).toBe('SERVICE_UNAVAILABLE')
    })
  })

  describe('task creation without AI', () => {
    test('title-only task does not get ai-to-process label', async () => {
      const createRes = await apiFetch('/api/tasks', {
        method: 'POST',
        body: { title: 'Test task without AI' },
      })
      expect(createRes.status).toBe(201)
      const created = await createRes.json()
      const taskId = created.data.id

      // Fetch the task to check labels
      const getRes = await apiFetch(`/api/tasks/${taskId}`)
      expect(getRes.status).toBe(200)
      const task = await getRes.json()
      const labels = task.data.labels || []
      expect(labels).not.toContain('ai-to-process')
    })
  })

  describe('user isolation', () => {
    test('User B gets own 503 for AI status', async () => {
      const res = await apiFetchB('/api/ai/status')
      expect(res.status).toBe(503)
      const body = await res.json()
      expect(body.code).toBe('SERVICE_UNAVAILABLE')
    })
  })
})
