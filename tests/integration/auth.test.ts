import { describe, test, expect, beforeAll } from 'vitest'
import { apiFetch, apiFetchB, apiAnon, resetTestData } from './helpers'

describe('Auth integration', () => {
  beforeAll(async () => {
    await resetTestData()
  })

  test('GET /api/tasks with no token returns 401', async () => {
    const res = await apiAnon('/api/tasks')
    expect(res.status).toBe(401)
  })

  test('GET /api/tasks with invalid token returns 401', async () => {
    const res = await apiAnon('/api/tasks', {
      headers: { Authorization: 'Bearer invalid-token-value' },
    })
    expect(res.status).toBe(401)
  })

  test('User A only sees own tasks, not User B tasks', async () => {
    const resA = await apiFetch('/api/tasks')
    expect(resA.status).toBe(200)
    const dataA = await resA.json()
    const titlesA = dataA.data.tasks.map((t: { title: string }) => t.title)
    expect(titlesA).not.toContain('User B task')

    const resB = await apiFetchB('/api/tasks')
    expect(resB.status).toBe(200)
    const dataB = await resB.json()
    const titlesB = dataB.data.tasks.map((t: { title: string }) => t.title)
    expect(titlesB).toContain('User B task')
    expect(titlesB).not.toContain('Buy groceries')
  })
})
