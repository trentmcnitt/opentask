/**
 * New projects go at the END of the user's order (2026-09-23). They used to
 * default to sort_order 0 and tie with the rest at the top, so the dashboard's
 * project groups swapped places as tasks were completed.
 */
import { describe, test, expect, beforeEach } from 'vitest'
import { apiFetch, resetTestData } from './helpers'

async function create(body: Record<string, unknown>) {
  const res = await apiFetch('/api/projects', { method: 'POST', body })
  expect(res.status).toBe(201)
  return (await res.json()).data as { id: number; sort_order: number }
}

describe('Project order on create', () => {
  beforeEach(async () => {
    await resetTestData()
  })

  test('a project created without sort_order goes after every existing one', async () => {
    const before = (await (await apiFetch('/api/projects')).json()).data.projects as {
      sort_order: number
    }[]
    const max = Math.max(...before.map((p) => p.sort_order))
    const first = await create({ name: `Order probe A ${Date.now()}` })
    expect(first.sort_order).toBe(max + 1)
    const second = await create({ name: `Order probe B ${Date.now()}` })
    expect(second.sort_order).toBe(max + 2)
  })

  test('an explicit sort_order is kept', async () => {
    const p = await create({ name: `Order probe C ${Date.now()}`, sort_order: 0 })
    expect(p.sort_order).toBe(0)
  })
})
