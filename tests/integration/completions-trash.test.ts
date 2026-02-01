import { describe, test, expect, beforeEach } from 'vitest'
import { apiFetch, resetTestData } from './helpers'
import { DateTime } from 'luxon'

describe('Completions and trash integration', () => {
  beforeEach(async () => {
    await resetTestData()
  })

  test('Mark recurring done creates a completion entry', async () => {
    // Task 2 is recurring daily
    await apiFetch('/api/tasks/2/done', { method: 'POST' })

    const today = DateTime.now().toUTC().toFormat('yyyy-MM-dd')
    const compRes = await apiFetch(`/api/completions?date=${today}`)
    expect(compRes.status).toBe(200)
    const data = (await compRes.json()).data
    expect(data.completions.length).toBeGreaterThan(0)

    const entry = data.completions.find((c: { task_id: number }) => c.task_id === 2)
    expect(entry).not.toBeUndefined()
    expect(entry.task_id).toBe(2)
  })

  test('DELETE task then GET /trash; DELETE /trash empties it', async () => {
    // Delete a task
    await apiFetch('/api/tasks/7', { method: 'DELETE' })

    // Verify in trash
    const trashRes = await apiFetch('/api/trash')
    expect(trashRes.status).toBe(200)
    const trashData = (await trashRes.json()).data
    const trashed = trashData.tasks.find((t: { id: number }) => t.id === 7)
    expect(trashed).not.toBeUndefined()
    expect(trashed.id).toBe(7)

    // Empty trash
    const emptyRes = await apiFetch('/api/trash', { method: 'DELETE' })
    expect(emptyRes.status).toBe(200)

    // Verify empty
    const afterRes = await apiFetch('/api/trash')
    const afterData = (await afterRes.json()).data
    expect(afterData.tasks.length).toBe(0)
  })
})
