/**
 * Quotas surface API integration tests (REDESIGN-V03 §5)
 *
 * GET /api/quotas is the sibling of GET /api/reminders. It exists so the Quotas
 * surface can refresh on every sync event without pulling the whole task list:
 * a +1 emits a sync event, so this is the hot path for the gesture the surface
 * exists for. These tests pin the narrowing — if the endpoint ever starts
 * returning ordinary tasks the payload regression is silent in the UI, which
 * renders the same eight rows either way.
 */

import { describe, test, expect, beforeEach } from 'vitest'
import { apiFetch, apiAnon, resetTestData } from './helpers'

describe('Quotas surface API', () => {
  beforeEach(async () => {
    await resetTestData()
  })

  test('GET requires auth', async () => {
    const res = await apiAnon('/api/quotas')
    expect(res.status).toBe(401)
  })

  test('returns quotas only — never ordinary tasks or reminders', async () => {
    const quota = (
      await (
        await apiFetch('/api/tasks', {
          method: 'POST',
          body: { title: 'Workouts', progress_target: 4, rrule: 'FREQ=WEEKLY' },
        })
      ).json()
    ).data
    // A target of 1 is still a quota when the flag says so ("date night").
    const flagged = (
      await (
        await apiFetch('/api/tasks', {
          method: 'POST',
          body: { title: 'Date night', is_tracked: true, rrule: 'FREQ=MONTHLY' },
        })
      ).json()
    ).data
    const plain = (
      await (
        await apiFetch('/api/tasks', {
          method: 'POST',
          body: { title: 'An ordinary task', due_at: new Date().toISOString() },
        })
      ).json()
    ).data
    const reminder = (
      await (
        await apiFetch('/api/tasks', {
          method: 'POST',
          body: { title: 'A reminder', is_reminder: true, rrule: 'FREQ=DAILY' },
        })
      ).json()
    ).data

    const res = await apiFetch('/api/quotas')
    expect(res.status).toBe(200)
    const data = (await res.json()).data

    const ids = data.quotas.map((q: { id: number }) => q.id)
    expect(ids).toContain(quota.id)
    expect(ids).toContain(flagged.id)
    expect(ids).not.toContain(plain.id)
    expect(ids).not.toContain(reminder.id)
    expect(data.total).toBe(ids.length)
    expect(data.has_any).toBe(true)
  })

  test('every returned row really is tracked, and none are done', async () => {
    await apiFetch('/api/tasks', {
      method: 'POST',
      body: { title: 'Reading', progress_target: 3, rrule: 'FREQ=WEEKLY' },
    })

    const res = await apiFetch('/api/quotas')
    expect(res.status).toBe(200)
    const data = (await res.json()).data
    expect(data.quotas.length).toBeGreaterThan(0)

    for (const q of data.quotas) {
      expect(q.is_tracked === true || q.progress_target > 1).toBe(true)
      expect(q.done).toBe(false)
      expect(q.is_reminder).toBe(false)
    }
  })

  test('a trashed quota drops out', async () => {
    const created = (
      await (
        await apiFetch('/api/tasks', {
          method: 'POST',
          body: { title: 'Temporary quota', progress_target: 2, rrule: 'FREQ=WEEKLY' },
        })
      ).json()
    ).data
    const id = created.id

    const before = (await (await apiFetch('/api/quotas')).json()).data
    expect(before.quotas.map((q: { id: number }) => q.id)).toContain(id)

    await apiFetch(`/api/tasks/${id}`, { method: 'DELETE' })

    const after = (await (await apiFetch('/api/quotas')).json()).data
    expect(after.quotas.map((q: { id: number }) => q.id)).not.toContain(id)
  })
})
