/**
 * POST /api/notifications/actions — the `delete` action (the "AI finished"
 * notification's Delete button, category TASK_ADDED) and `done` from the same
 * notification. Snooze actions are pinned in route-ids.test.ts.
 *
 * - Auth is the token in the BODY (the notification extension can't set
 *   headers): a bad or missing one is a 401, and nothing is touched.
 * - `delete` is the app's soft delete: `deleted_at` set, one undo entry, and
 *   Undo brings the task back.
 * - Someone else's task is not deletable with your token.
 * - An unknown action is a 400.
 * - Without a body token, the session cookie (2026-10-26, the service
 *   worker's Considered button); `done` with `day`, the day guard.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { addDays } from '@/lib/opentask-day'
import {
  apiFetch,
  apiFetchB,
  apiAnon,
  baseUrl,
  openTaskToday,
  resetTestData,
  sessionCookieFromToken,
  setTaskQueue,
  TOKEN_A,
  TOKEN_B,
} from './helpers'

async function createTask(title = 'Call the dentist') {
  const res = await apiFetch('/api/tasks', { method: 'POST', body: { title } })
  expect(res.status).toBe(201)
  return (await res.json()).data as { id: number }
}

function act(action: string, taskId: number, token: string | null = TOKEN_A) {
  return apiAnon('/api/notifications/actions', {
    method: 'POST',
    body: { action, task_id: taskId, ...(token === null ? {} : { token }) },
  })
}

/** What a same-origin browser fetch (the service worker's) carries. */
const SAME_ORIGIN = { 'Sec-Fetch-Site': 'same-origin' }

async function getTask(id: number) {
  return (await (await apiFetch(`/api/tasks/${id}`)).json()).data
}

async function undoStatus() {
  return (await (await apiFetch('/api/undo/status')).json()).data as {
    latest_id: number | null
    undoable_count: number
  }
}

describe('POST /api/notifications/actions — delete', () => {
  beforeEach(async () => {
    await resetTestData()
  })

  test('soft-deletes the task, logs one undo entry, and Undo restores it', async () => {
    const task = await createTask()
    const before = await undoStatus()

    const res = await act('delete', task.id)
    expect(res.status).toBe(200)
    const data = (await res.json()).data
    expect(data.action).toBe('delete')
    expect(data.task_id).toBe(task.id)
    expect(data.result.task.id).toBe(task.id)
    expect(data.result.task.deleted_at).toBeTruthy()

    // Soft: the row is still there, in the trash.
    const saved = await getTask(task.id)
    expect(saved.deleted_at).toBeTruthy()
    const open = (await (await apiFetch('/api/tasks?done=false')).json()).data.tasks as {
      id: number
    }[]
    expect(open.some((t) => t.id === task.id)).toBe(false)

    const after = await undoStatus()
    expect(after.undoable_count).toBe(before.undoable_count + 1)
    expect(after.latest_id).not.toBe(before.latest_id)

    const undo = await apiFetch('/api/undo', { method: 'POST' })
    expect(undo.status).toBe(200)
    expect((await getTask(task.id)).deleted_at).toBeNull()
  })

  test('a task already in the trash is a 400', async () => {
    const task = await createTask()
    expect((await act('delete', task.id)).status).toBe(200)
    expect((await act('delete', task.id)).status).toBe(400)
  })

  test('is authenticated by the token in the body', async () => {
    const task = await createTask()

    expect((await act('delete', task.id, null)).status).toBe(401)
    expect((await act('delete', task.id, 'z'.repeat(64))).status).toBe(401)
    expect((await getTask(task.id)).deleted_at).toBeNull()
  })

  test("cannot delete another user's task", async () => {
    const task = await createTask()

    const res = await act('delete', task.id, TOKEN_B)
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
    expect((await getTask(task.id)).deleted_at).toBeNull()
    // And B's own view of it is unchanged too.
    expect((await apiFetchB(`/api/tasks/${task.id}`)).status).not.toBe(200)
  })

  test('done from the same notification completes the task', async () => {
    const task = await createTask()
    const res = await act('done', task.id)
    expect(res.status).toBe(200)
    expect((await getTask(task.id)).done).toBe(true)
  })

  test('an unknown action is a 400 and touches nothing', async () => {
    const task = await createTask()
    const res = await act('trash', task.id)
    expect(res.status).toBe(400)
    expect((await getTask(task.id)).deleted_at).toBeNull()
  })
})

/**
 * 2026-10-26 (named reminder pushes): with NO body token the route takes the
 * ordinary auth chain, so the service worker's "Considered" button can call
 * it with the session cookie alone. A body token that is present but bad is
 * still a 401 — never a fall-through to the cookie.
 *
 * CSRF (coordinator ruling, 2026-10-26): a request authenticated by the
 * cookie alone must also be same-origin — `Sec-Fetch-Site: same-origin`, or
 * an `Origin` equal to the app's own — else 403. So must a proxy-header
 * request (review of #377: it rides the proxy's own cookie). Token requests
 * are not checked (the native apps send no Origin).
 */
describe('POST /api/notifications/actions — session auth', () => {
  beforeEach(async () => {
    await resetTestData()
  })

  function actWithCookie(
    cookie: string,
    body: Record<string, unknown>,
    headers: Record<string, string> = SAME_ORIGIN,
  ) {
    return apiAnon('/api/notifications/actions', {
      method: 'POST',
      headers: { Cookie: cookie, ...headers },
      body,
    })
  }

  test('no body token, a session cookie, same-origin (Sec-Fetch-Site): authenticated', async () => {
    const task = await createTask()
    const cookie = await sessionCookieFromToken(TOKEN_A)
    const res = await actWithCookie(cookie, { action: 'done', task_id: task.id })
    expect(res.status).toBe(200)
    expect((await getTask(task.id)).done).toBe(true)
  })

  test('a cookie POST whose Origin is the app’s own: 200', async () => {
    const task = await createTask()
    const cookie = await sessionCookieFromToken(TOKEN_A)
    const res = await actWithCookie(
      cookie,
      { action: 'done', task_id: task.id },
      { Origin: new URL(baseUrl()).origin },
    )
    expect(res.status).toBe(200)
    expect((await getTask(task.id)).done).toBe(true)
  })

  test('a cookie POST with a cross-site Origin: 403, nothing changes', async () => {
    const task = await createTask()
    const cookie = await sessionCookieFromToken(TOKEN_A)
    const res = await actWithCookie(
      cookie,
      { action: 'done', task_id: task.id },
      { Origin: 'https://attacker.example', 'Sec-Fetch-Site': 'cross-site' },
    )
    expect(res.status).toBe(403)
    expect((await getTask(task.id)).done).toBe(false)
  })

  test('a cookie POST with neither Origin nor Sec-Fetch-Site: 403', async () => {
    const task = await createTask()
    const cookie = await sessionCookieFromToken(TOKEN_A)
    const res = await actWithCookie(cookie, { action: 'done', task_id: task.id }, {})
    expect(res.status).toBe(403)
    expect((await getTask(task.id)).done).toBe(false)
  })

  test('a Bearer POST with a foreign Origin: still 200 (only the cookie is checked)', async () => {
    const task = await createTask()
    const res = await apiFetch('/api/notifications/actions', {
      method: 'POST',
      headers: { Origin: 'https://attacker.example', 'Sec-Fetch-Site': 'cross-site' },
      body: { action: 'done', task_id: task.id },
    })
    expect(res.status).toBe(200)
    expect((await getTask(task.id)).done).toBe(true)
  })

  test('a body-token POST with a foreign Origin: still 200', async () => {
    const task = await createTask()
    const res = await apiAnon('/api/notifications/actions', {
      method: 'POST',
      headers: { Origin: 'https://attacker.example' },
      body: { action: 'done', task_id: task.id, token: TOKEN_A },
    })
    expect(res.status).toBe(200)
  })

  test('a bad body token is a 401 even with a valid cookie', async () => {
    const task = await createTask()
    const cookie = await sessionCookieFromToken(TOKEN_A)
    const res = await actWithCookie(cookie, {
      action: 'done',
      task_id: task.id,
      token: 'z'.repeat(64),
    })
    expect(res.status).toBe(401)
    expect((await getTask(task.id)).done).toBe(false)
  })

  test('a proxy-header POST with a cross-site Origin: 403 (review of #377), nothing changes', async () => {
    const task = await createTask()
    const res = await apiAnon('/api/notifications/actions', {
      method: 'POST',
      headers: {
        'X-Test-Proxy-User': 'Test User A',
        Origin: 'https://attacker.example',
        'Sec-Fetch-Site': 'cross-site',
      },
      body: { action: 'done', task_id: task.id },
    })
    expect(res.status).toBe(403)
    expect((await getTask(task.id)).done).toBe(false)
  })

  test('a proxy-header POST that is same-origin: 200', async () => {
    const task = await createTask()
    const res = await apiAnon('/api/notifications/actions', {
      method: 'POST',
      headers: { 'X-Test-Proxy-User': 'Test User A', ...SAME_ORIGIN },
      body: { action: 'done', task_id: task.id },
    })
    expect(res.status).toBe(200)
  })

  test('no body token and no cookie: 401', async () => {
    const task = await createTask()
    expect((await act('done', task.id, null)).status).toBe(401)
    expect((await getTask(task.id)).done).toBe(false)
  })
})

/**
 * The Considered button's `day` (2026-10-26). A named reminder push carries
 * the OpenTask date it was waiting on; `done` with `day` considers the
 * reminder only when that is the user's current day and the reminder is
 * waiting in its roster — otherwise 200 `{ considered: false }` and nothing
 * changes (a stale push never advances an occurrence). Without `day`, `done`
 * is as before. The task-queue switch is on here so the day is User A's
 * OpenTask day (`openTaskToday`), not the calendar date.
 */
describe('POST /api/notifications/actions — done with day', () => {
  const TZ = 'America/Chicago'
  let today: string

  beforeEach(async () => {
    await resetTestData()
    await setTaskQueue(true)
    today = await openTaskToday(TZ)
  })
  afterEach(async () => {
    await setTaskQueue(false)
  })

  async function createReminder() {
    const res = await apiFetch('/api/tasks', {
      method: 'POST',
      // `rrule: null`: a one-time thought, waiting until considered (and then
      // done), so "considered" reads as `done` here. An omitted rule would get
      // the default daily one, which considering advances instead.
      body: { title: 'Stretch before lunch', is_reminder: true, rrule: null, priority: 3 },
    })
    expect(res.status).toBe(201)
    return (await res.json()).data as { id: number }
  }
  function considered(taskId: number, day: unknown) {
    return apiAnon('/api/notifications/actions', {
      method: 'POST',
      body: { action: 'done', task_id: taskId, token: TOKEN_A, day },
    })
  }

  test("today's day, waiting: considered", async () => {
    const reminder = await createReminder()
    const res = await considered(reminder.id, today)
    expect(res.status).toBe(200)
    const data = (await res.json()).data
    expect(data).toMatchObject({ action: 'done', task_id: reminder.id, considered: true })
    expect(data.result.task.id).toBe(reminder.id)
    expect((await getTask(reminder.id)).done).toBe(true)
  })

  test('another day: 200 considered:false, nothing changes, no undo entry', async () => {
    const reminder = await createReminder()
    const before = await undoStatus()
    const res = await considered(reminder.id, addDays(today, -1))
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({
      action: 'done',
      task_id: reminder.id,
      considered: false,
      // Nothing logged, so no undo entry to name (2026-10-26).
      undo_id: null,
    })
    expect((await getTask(reminder.id)).done).toBe(false)
    expect(await undoStatus()).toEqual(before)
  })

  test('no longer waiting (already considered): considered:false, no error', async () => {
    const reminder = await createReminder()
    expect((await considered(reminder.id, today)).status).toBe(200)
    const before = await undoStatus()
    const again = await considered(reminder.id, today)
    expect(again.status).toBe(200)
    expect((await again.json()).data.considered).toBe(false)
    expect(await undoStatus()).toEqual(before)
  })

  test('not a reminder: considered:false, the task untouched', async () => {
    const task = await createTask()
    const res = await considered(task.id, today)
    expect((await res.json()).data.considered).toBe(false)
    expect((await getTask(task.id)).done).toBe(false)
  })

  test('without day: done as before, and no considered field', async () => {
    const reminder = await createReminder()
    const res = await act('done', reminder.id)
    expect(res.status).toBe(200)
    const data = (await res.json()).data
    expect(data).not.toHaveProperty('considered')
    expect((await getTask(reminder.id)).done).toBe(true)
  })

  test('a malformed day is a 400 and touches nothing', async () => {
    const reminder = await createReminder()
    for (const bad of ['tomorrow', 20260115, '2026-1-15']) {
      expect((await considered(reminder.id, bad)).status).toBe(400)
    }
    expect((await getTask(reminder.id)).done).toBe(false)
  })

  test('with the session cookie (the service worker’s call)', async () => {
    const reminder = await createReminder()
    const cookie = await sessionCookieFromToken(TOKEN_A)
    const res = await apiAnon('/api/notifications/actions', {
      method: 'POST',
      headers: { Cookie: cookie, ...SAME_ORIGIN },
      body: { action: 'done', task_id: reminder.id, day: today },
    })
    expect(res.status).toBe(200)
    expect((await res.json()).data.considered).toBe(true)
  })
})
