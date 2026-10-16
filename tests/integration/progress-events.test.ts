/**
 * A quota's progress history over HTTP (2026-10-16): `source` on the progress
 * and quota-prompt routes, the compensating rows undo and redo write, and
 * `GET /api/tasks/:id/progress-events`.
 */
import { describe, test, expect, beforeEach } from 'vitest'
import { apiFetch, apiFetchB, apiAnon, resetTestData } from './helpers'

async function createQuota(): Promise<number> {
  const res = await apiFetch('/api/tasks', {
    method: 'POST',
    body: { title: 'Workouts', progress_target: 4, rrule: 'FREQ=WEEKLY' },
  })
  return (await res.json()).data.id
}

async function history(id: number, query = '') {
  const res = await apiFetch(`/api/tasks/${id}/progress-events${query}`)
  expect(res.status).toBe(200)
  return (await res.json()).data as {
    events: { id: number; delta: number; source: string; logged_at: string; user_id: number }[]
    has_more: boolean
  }
}

describe('progress events', () => {
  beforeEach(async () => {
    await resetTestData()
  })

  test('the progress route records its source, api by default, and refuses an unknown one', async () => {
    const id = await createQuota()
    const progress = (body: Record<string, unknown>) =>
      apiFetch(`/api/tasks/${id}/progress`, { method: 'POST', body })
    expect((await progress({ source: 'widget' })).status).toBe(200)
    expect((await progress({})).status).toBe(200)
    expect((await progress({ source: 'telepathy' })).status).toBe(400)
    // The server's own sources are not a client's to send.
    expect((await progress({ source: 'undo' })).status).toBe(400)
    const { events } = await history(id)
    expect(events.map((e) => e.source)).toEqual(['api', 'widget'])
  })

  test('undo and redo write the opposite row, and the events sum to the count', async () => {
    const id = await createQuota()
    await apiFetch(`/api/tasks/${id}/progress`, { method: 'POST', body: { source: 'web' } })
    expect((await apiFetch('/api/undo', { method: 'POST' })).status).toBe(200)
    expect((await apiFetch('/api/redo', { method: 'POST' })).status).toBe(200)
    const { events } = await history(id)
    expect(events.map((e) => [e.delta, e.source])).toEqual([
      [1, 'redo'],
      [-1, 'undo'],
      [1, 'web'],
    ])
    const task = (await (await apiFetch(`/api/tasks/${id}`)).json()).data
    expect(events.reduce((n, e) => n + e.delta, 0)).toBe(task.progress_current)
  })

  test('the quota-prompt did route records its source', async () => {
    const id = await createQuota()
    const reminders = (await (await apiFetch('/api/reminders')).json()).data
    const prompt = reminders.groups
      .flatMap((g: { prompts?: { task_id: number; prompt_key: string }[] }) => g.prompts ?? [])
      .find((p: { task_id: number }) => p.task_id === id)
    expect(prompt).toBeTruthy()
    const did = await apiFetch('/api/quota-prompts/did', {
      method: 'POST',
      body: { keys: [prompt.prompt_key], source: 'watch' },
    })
    expect(did.status).toBe(200)
    const restore = await apiFetch('/api/quota-prompts/restore', {
      method: 'POST',
      body: { keys: [prompt.prompt_key], source: 'mac' },
    })
    expect(restore.status).toBe(200)
    const { events } = await history(id)
    expect(events.map((e) => [e.delta, e.source])).toEqual([
      [-1, 'mac'],
      [1, 'watch'],
    ])
  })

  test('limit and before_id page the history; bad params are 400', async () => {
    const id = await createQuota()
    for (let i = 0; i < 3; i++) {
      await apiFetch(`/api/tasks/${id}/progress`, { method: 'POST', body: {} })
    }
    const first = await history(id, '?limit=2')
    expect(first.events).toHaveLength(2)
    expect(first.has_more).toBe(true)
    const rest = await history(id, `?limit=2&before_id=${first.events[1].id}`)
    expect(rest.events).toHaveLength(1)
    expect(rest.has_more).toBe(false)
    expect((await apiFetch(`/api/tasks/${id}/progress-events?limit=501`)).status).toBe(400)
    expect((await apiFetch(`/api/tasks/${id}/progress-events?since=yesterday`)).status).toBe(400)
  })

  test('refuses anonymous callers, a plain task, another user, and a missing task', async () => {
    const id = await createQuota()
    const plain = (
      await (await apiFetch('/api/tasks', { method: 'POST', body: { title: 'x' } })).json()
    ).data.id
    expect((await apiAnon(`/api/tasks/${id}/progress-events`)).status).toBe(401)
    expect((await apiFetch(`/api/tasks/${plain}/progress-events`)).status).toBe(400)
    expect((await apiFetchB(`/api/tasks/${id}/progress-events`)).status).toBe(403)
    expect((await apiFetch('/api/tasks/999999/progress-events')).status).toBe(404)
  })
})
