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

/**
 * A quota is not a task (§5, Trent 2026-09-08): it has no due date and cannot
 * be snoozed, and retiring one takes its period rule with it. Pinned over HTTP
 * because each of these is a route contract an external caller depends on —
 * the automation API and the iOS app both PATCH tasks.
 */
describe('A quota over HTTP has no date and no snooze', () => {
  beforeEach(async () => {
    await resetTestData()
  })

  async function makeQuota(body: Record<string, unknown> = {}) {
    const res = await apiFetch('/api/tasks', {
      method: 'POST',
      body: { title: 'Workouts', progress_target: 4, rrule: 'FREQ=WEEKLY', ...body },
    })
    return { status: res.status, body: (await res.json()).data }
  }

  test('POST /api/tasks never stamps a due date on a quota', async () => {
    const { status, body } = await makeQuota()
    expect(status).toBe(201)
    expect(body.due_at).toBeNull()
    expect(body.original_due_at).toBeNull()
    expect(body.is_snoozed).toBe(false)
  })

  test('POST /api/tasks refuses a quota that is given a due date', async () => {
    const { status } = await makeQuota({ due_at: new Date().toISOString() })
    expect(status).toBe(400)
  })

  test('POST /api/tasks/:id/snooze on a quota is a 400', async () => {
    const { body: quota } = await makeQuota()
    const res = await apiFetch(`/api/tasks/${quota.id}/snooze`, {
      method: 'POST',
      body: { until: new Date(Date.now() + 3_600_000).toISOString() },
    })
    expect(res.status).toBe(400)
  })

  test('PATCH converting a dated task into a quota clears the date', async () => {
    const created = (
      await (
        await apiFetch('/api/tasks', {
          method: 'POST',
          body: { title: 'Becomes a quota', due_at: new Date().toISOString() },
        })
      ).json()
    ).data
    expect(created.due_at).not.toBeNull()

    const res = await apiFetch(`/api/tasks/${created.id}`, {
      method: 'PATCH',
      body: { is_tracked: true, progress_target: 3, rrule: 'FREQ=WEEKLY' },
    })
    expect(res.status).toBe(200)
    const patched = (await res.json()).data
    expect(patched.due_at).toBeNull()
    expect(patched.original_due_at).toBeNull()
  })

  test('POST /api/tasks/bulk/edit retiring a quota clears its period rule', async () => {
    const { body: one } = await makeQuota({ title: 'Quota one' })
    const { body: two } = await makeQuota({ title: 'Quota two' })

    const res = await apiFetch('/api/tasks/bulk/edit', {
      method: 'POST',
      body: { ids: [one.id, two.id], changes: { is_tracked: false, progress_target: 1 } },
    })
    expect(res.status).toBe(200)

    for (const id of [one.id, two.id]) {
      const after = (await (await apiFetch(`/api/tasks/${id}`)).json()).data
      expect(after.is_tracked).toBe(false)
      expect(after.rrule).toBeNull()
      expect(after.due_at).toBeNull()
    }
  })

  test('GET /api/tasks/counts does not count quotas at all', async () => {
    const before = (await (await apiFetch('/api/tasks/counts')).json()).data
    await makeQuota({ title: 'Uncounted quota' })
    const after = (await (await apiFetch('/api/tasks/counts')).json()).data
    expect(after).toEqual(before)
  })
})
