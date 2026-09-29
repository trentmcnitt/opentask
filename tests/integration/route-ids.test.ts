/**
 * Route plumbing (cleanup A18), over HTTP.
 *
 * - Every `[id]` route parses its id strictly (`parseRouteId`): a malformed id,
 *   including a digits-then-junk one like `1abc`, is a 400 on every route and
 *   never acts on the number's prefix.
 * - A missing login is still a 401 UNAUTHORIZED now that `AuthError` is an
 *   `AppError` mapped by `handleError()` instead of a per-route branch.
 * - POST /api/notifications/actions snooze actions keep their times and shape.
 */
import { describe, test, expect, beforeEach } from 'vitest'
import { DateTime } from 'luxon'
import { apiFetch, apiAnon, resetTestData, TOKEN_A } from './helpers'

async function createTask(body: Record<string, unknown> = {}) {
  const res = await apiFetch('/api/tasks', { method: 'POST', body: { title: 'Plain', ...body } })
  expect(res.status).toBe(201)
  return (await res.json()).data
}

describe('[id] route parsing', () => {
  beforeEach(async () => {
    await resetTestData()
  })

  const badIdRequests: Array<[string, string]> = [
    ['GET', '/api/tasks/abc'],
    ['PATCH', '/api/tasks/abc'],
    ['DELETE', '/api/tasks/abc'],
    ['POST', '/api/tasks/abc/done'],
    ['POST', '/api/tasks/abc/undone'],
    ['POST', '/api/tasks/abc/snooze'],
    ['POST', '/api/tasks/abc/restore'],
    ['POST', '/api/tasks/abc/reprocess'],
    ['POST', '/api/tasks/abc/progress'],
    ['POST', '/api/tasks/abc/confirm'],
    ['POST', '/api/tasks/abc/skip-occurrence'],
    ['GET', '/api/projects/abc'],
    ['PATCH', '/api/projects/abc'],
    ['DELETE', '/api/projects/abc'],
    ['PATCH', '/api/webhooks/abc'],
    ['DELETE', '/api/webhooks/abc'],
    ['GET', '/api/webhooks/abc/deliveries'],
    ['DELETE', '/api/tokens/abc'],
    ['PATCH', '/api/time-slots/abc'],
    ['DELETE', '/api/time-slots/abc'],
  ]

  test.each(badIdRequests)('%s %s is a 400', async (method, path) => {
    const res = await apiFetch(path, { method, body: method === 'GET' ? undefined : {} })
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('VALIDATION_ERROR')
  })

  test('a digits-then-junk id is rejected, not read as its numeric prefix', async () => {
    const task = await createTask()

    const got = await apiFetch(`/api/tasks/${task.id}abc`)
    expect(got.status).toBe(400)

    const del = await apiFetch(`/api/tasks/${task.id}abc`, { method: 'DELETE' })
    expect(del.status).toBe(400)
    const after = (await (await apiFetch(`/api/tasks/${task.id}`)).json()).data
    expect(after.deleted_at).toBeNull()

    const progress = await apiFetch(`/api/tasks/${task.id}x/progress`, { method: 'POST' })
    expect(progress.status).toBe(400)
  })

  test('no credentials on a requireAuth route is still a 401 UNAUTHORIZED', async () => {
    const res = await apiAnon('/api/tasks/1/progress', { method: 'POST' })
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.code).toBe('UNAUTHORIZED')
    expect(body.error).toBe('Authentication required')
  })
})

describe('POST /api/notifications/actions snooze actions', () => {
  beforeEach(async () => {
    await resetTestData()
  })

  async function act(action: string, taskId: number) {
    return apiAnon('/api/notifications/actions', {
      method: 'POST',
      body: { action, task_id: taskId, token: TOKEN_A },
    })
  }

  const pastDue = () => DateTime.now().minus({ hours: 1 }).toUTC().toISO()!
  const minutesFrom = (from: number, iso: string) => (Date.parse(iso) - from) / 60_000

  test('snooze30 snoozes exactly 30 minutes from now', async () => {
    const task = await createTask({ due_at: pastDue() })
    const before = Date.now()
    const res = await act('snooze30', task.id)
    const after = Date.now()
    expect(res.status).toBe(200)
    const data = (await res.json()).data
    expect(data.action).toBe('snooze30')
    expect(data.task_id).toBe(task.id)
    expect(Date.parse(data.until)).toBeGreaterThanOrEqual(before + 30 * 60_000)
    expect(Date.parse(data.until)).toBeLessThanOrEqual(after + 30 * 60_000)
    const saved = (await (await apiFetch(`/api/tasks/${task.id}`)).json()).data
    expect(Date.parse(saved.due_at)).toBe(Date.parse(data.until))
  })

  // `snapToHour` rounds to the nearer hour (:35 and later rounds up), so the
  // target lands on the hour within (N-35, N+25] minutes of now.
  test.each([
    ['snooze', 60],
    ['snooze2h', 120],
  ] as const)('%s snaps %i minutes out to the top of the hour', async (action, minutes) => {
    const task = await createTask({ due_at: pastDue() })
    const now = Date.now()
    const res = await act(action, task.id)
    expect(res.status).toBe(200)
    const data = (await res.json()).data
    expect(data.action).toBe(action)
    expect(data.task_id).toBe(task.id)
    const until = new Date(data.until)
    expect(until.getUTCMinutes()).toBe(0)
    expect(until.getUTCSeconds()).toBe(0)
    const offset = minutesFrom(now, data.until)
    expect(offset).toBeGreaterThan(minutes - 36)
    expect(offset).toBeLessThanOrEqual(minutes + 25)
  })

  test('an unknown action is a 400', async () => {
    const task = await createTask({ due_at: pastDue() })
    const res = await act('snooze3h', task.id)
    expect(res.status).toBe(400)
  })
})
