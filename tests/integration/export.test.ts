import { describe, test, expect, beforeAll } from 'vitest'
import { apiFetch, apiFetchB, apiAnon, resetTestData } from './helpers'

describe('Export API integration', () => {
  beforeAll(async () => {
    await resetTestData()
  })

  describe('authentication', () => {
    test('returns 401 without token', async () => {
      const res = await apiAnon('/api/export?format=json')
      expect(res.status).toBe(401)
    })

    test('returns 401 with invalid token', async () => {
      const res = await apiAnon('/api/export?format=json', {
        headers: { Authorization: 'Bearer invalid-token' },
      })
      expect(res.status).toBe(401)
    })
  })

  describe('JSON export', () => {
    test('returns all data with correct structure', async () => {
      const res = await apiFetch('/api/export?format=json')
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.data).toHaveProperty('tasks')
      expect(body.data).toHaveProperty('projects')
      expect(body.data).toHaveProperty('completions')
      expect(body.data).toHaveProperty('exported_at')
      expect(Array.isArray(body.data.tasks)).toBe(true)
      expect(Array.isArray(body.data.projects)).toBe(true)
      expect(Array.isArray(body.data.completions)).toBe(true)
    })

    test('defaults to JSON when format is omitted', async () => {
      const res = await apiFetch('/api/export')
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.data).toHaveProperty('tasks')
      expect(body.data).toHaveProperty('exported_at')
    })

    test('user isolation — User B does not see User A data', async () => {
      const resA = await apiFetch('/api/export?format=json')
      const dataA = await resA.json()
      const taskTitlesA = dataA.data.tasks.map((t: { title: string }) => t.title)

      const resB = await apiFetchB('/api/export?format=json')
      const dataB = await resB.json()
      const taskTitlesB = dataB.data.tasks.map((t: { title: string }) => t.title)

      // User A's seeded tasks should not appear in User B's export
      expect(taskTitlesB).not.toContain('Buy groceries')
      // User B's seeded task should not appear in User A's export
      expect(taskTitlesA).not.toContain('User B task')
    })
  })

  describe('CSV export', () => {
    test('returns correct content-type and content-disposition for tasks', async () => {
      const res = await apiFetch('/api/export?format=csv&type=tasks')
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('text/csv')
      expect(res.headers.get('content-disposition')).toMatch(
        /^attachment; filename="opentask-tasks-\d{4}-\d{2}-\d{2}\.csv"$/,
      )
    })

    test('returns correct content-type and content-disposition for projects', async () => {
      const res = await apiFetch('/api/export?format=csv&type=projects')
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('text/csv')
      expect(res.headers.get('content-disposition')).toMatch(
        /^attachment; filename="opentask-projects-\d{4}-\d{2}-\d{2}\.csv"$/,
      )
    })

    test('CSV without type returns 400', async () => {
      const res = await apiFetch('/api/export?format=csv')
      expect(res.status).toBe(400)
    })

    test('CSV with invalid type returns 400', async () => {
      const res = await apiFetch('/api/export?format=csv&type=invalid')
      expect(res.status).toBe(400)
    })

    test('tasks CSV contains header and data rows', async () => {
      const res = await apiFetch('/api/export?format=csv&type=tasks')
      const text = await res.text()
      const lines = text.split('\n')

      // At least header + one data row (seeded tasks exist)
      expect(lines.length).toBeGreaterThanOrEqual(2)
      expect(lines[0]).toContain('"id"')
      expect(lines[0]).toContain('"title"')
    })
  })

  describe('validation', () => {
    test('invalid format returns 400', async () => {
      const res = await apiFetch('/api/export?format=xml')
      expect(res.status).toBe(400)
    })
  })
})
