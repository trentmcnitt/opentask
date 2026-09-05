import { describe, test, expect, beforeAll } from 'vitest'
import { apiFetch, resetTestData } from './helpers'

describe('Task counts', () => {
  beforeAll(async () => {
    await resetTestData()
  })

  test('GET /api/tasks/counts agrees with the task list', async () => {
    // The Tasks page counts everything but reminders (§6), and so do the counts.
    const all = (await (await apiFetch('/api/tasks?limit=500')).json()).data.tasks
    const list = all.filter((t: { is_reminder: boolean }) => !t.is_reminder)
    const res = await apiFetch('/api/tasks/counts')
    expect(res.status).toBe(200)
    const counts = (await res.json()).data
    expect(counts.total).toBe(list.length)
    const now = Date.now()
    const overdue = list.filter(
      (t: { due_at: string | null }) => t.due_at && Date.parse(t.due_at) < now,
    )
    expect(counts.overdue).toBe(overdue.length)
    expect(counts.today).toBeLessThanOrEqual(counts.total)
  })
})
