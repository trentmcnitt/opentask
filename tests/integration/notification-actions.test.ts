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
 */
import { describe, test, expect, beforeEach } from 'vitest'
import { apiFetch, apiFetchB, apiAnon, resetTestData, TOKEN_A, TOKEN_B } from './helpers'

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
