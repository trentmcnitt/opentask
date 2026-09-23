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
    // Task 2 is seeded with project_id 2 (scripts/seed-test.ts) and is an
    // ordinary task, not a reminder or quota.
    expect(entry.project_id).toBe(2)
    expect(entry.is_reminder).toBe(false)
    expect(entry.is_tracked).toBe(false)
  })

  test('?since/?until filters completions to an instant range and requires both', async () => {
    await apiFetch('/api/tasks/2/done', { method: 'POST' })

    // Missing the paired param is rejected
    const missingUntil = await apiFetch(`/api/completions?since=${new Date().toISOString()}`)
    expect(missingUntil.status).toBe(400)

    // A range that does not include "now" excludes the completion just made
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const evenMorePast = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    const excluding = await apiFetch(`/api/completions?since=${evenMorePast}&until=${past}`)
    expect(excluding.status).toBe(200)
    const excludingData = (await excluding.json()).data
    expect(
      excludingData.completions.find((c: { task_id: number }) => c.task_id === 2),
    ).toBeUndefined()

    // A range spanning "now" includes it
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    const including = await apiFetch(`/api/completions?since=${past}&until=${future}`)
    expect(including.status).toBe(200)
    const includingData = (await including.json()).data
    const entry = includingData.completions.find((c: { task_id: number }) => c.task_id === 2)
    expect(entry).not.toBeUndefined()
    expect(entry.project_id).toBe(2)
  })

  test('a considered reminder shows is_reminder: true so a completion fill can exclude it', async () => {
    const createRes = await apiFetch('/api/tasks', {
      method: 'POST',
      body: { title: 'A daily reminder', is_reminder: true, rrule: 'FREQ=DAILY' },
    })
    expect(createRes.status).toBe(201)
    const reminder = (await createRes.json()).data

    await apiFetch(`/api/tasks/${reminder.id}/done`, { method: 'POST' })

    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    const res = await apiFetch(`/api/completions?since=${past}&until=${future}`)
    const data = (await res.json()).data
    const entry = data.completions.find((c: { task_id: number }) => c.task_id === reminder.id)
    expect(entry).not.toBeUndefined()
    expect(entry.is_reminder).toBe(true)
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
