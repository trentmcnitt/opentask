/**
 * Scoped native Undo over HTTP (2026-10-26)
 *
 * - Every mutation route the native apps call answers `undo_id`: the undo
 *   entry that request wrote (null when it logged nothing). Each route's
 *   `undo_id` must be exactly the one new entry in `GET /api/undo/history` —
 *   which also proves no listed route logs two entries per request.
 * - `POST /api/undo { id }` / `POST /api/redo { id }` act only on the entry a
 *   bare undo/redo would take, else 409 `CONFLICT` with `details`.
 * - `GET /api/undo/status` adds `newest_undoable_id` and `next_redoable_id`.
 */

import { describe, test, expect, beforeEach, beforeAll } from 'vitest'
import { DateTime } from 'luxon'
import { apiFetch, apiFetchB, resetTestData, setTaskQueue } from './helpers'

type Body = { data: Record<string, unknown> } & Record<string, unknown>

async function send(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  const res = await apiFetch(path, { method, body })
  return { status: res.status, json: (await res.json()) as Body }
}

async function ok(path: string, body?: unknown, method?: string) {
  const res = await send(path, body, method)
  if (res.status >= 300) throw new Error(`${path} → ${res.status}: ${JSON.stringify(res.json)}`)
  return res.json.data
}

async function historyIds(fetcher = apiFetch): Promise<number[]> {
  const res = await fetcher('/api/undo/history?limit=20')
  const { history } = (await res.json()).data as { history: { id: number }[] }
  return history.map((h) => h.id)
}

async function status() {
  return (await ok('/api/undo/status')) as {
    latest_id: number | null
    undoable_count: number
    redoable_count: number
    newest_undoable_id: number | null
    next_redoable_id: number | null
  }
}

/**
 * Run one route call and check its `undo_id` is the one entry it wrote:
 * exactly one new history entry, and it is the `undo_id`.
 */
async function expectOwnEntry(call: () => Promise<Record<string, unknown>>) {
  const before = (await historyIds())[0] ?? 0
  const data = await call()
  const added = (await historyIds()).filter((id) => id > before)
  expect(added).toHaveLength(1)
  expect(data.undo_id).toBe(added[0])
  return data
}

async function makeTask(body: Record<string, unknown>) {
  return (await ok('/api/tasks', body)) as { id: number; undo_id: number | null }
}

const ago = (days: number) => new Date(Date.now() - days * 24 * 3600 * 1000).toISOString()
const ahead = (days: number) => new Date(Date.now() + days * 24 * 3600 * 1000).toISOString()

describe('undo_id on every native-called mutation route', () => {
  beforeAll(async () => {
    await resetTestData()
  })

  test('POST /api/tasks, PATCH /api/tasks/{id}', async () => {
    const created = await expectOwnEntry(() => ok('/api/tasks', { title: 'Wash the car' }))
    await expectOwnEntry(() => ok(`/api/tasks/${created.id}`, { title: 'Wash the van' }, 'PATCH'))
  })

  test('POST /api/tasks/{id}/progress, /undone', async () => {
    const quota = await makeTask({
      title: 'Stretch',
      rrule: 'FREQ=WEEKLY',
      progress_target: 3,
      is_tracked: true,
    })
    await expectOwnEntry(() => ok(`/api/tasks/${quota.id}/progress`, { delta: 1 }))
    const oneOff = await makeTask({ title: 'Post the letter' })
    await ok(`/api/tasks/${oneOff.id}/done`, {})
    await expectOwnEntry(() => ok(`/api/tasks/${oneOff.id}/undone`, {}))
  })

  test('POST /api/tasks/bulk/complete, /snooze, /snooze-overdue', async () => {
    const a = await makeTask({ title: 'Water the plants' })
    await expectOwnEntry(() => ok('/api/tasks/bulk/complete', { ids: [a.id] }))
    const b = await makeTask({ title: 'Book the hotel', due_at: ago(1) })
    await expectOwnEntry(() => ok('/api/tasks/bulk/snooze', { ids: [b.id], until: ahead(2) }))
    await makeTask({ title: 'Return the tools', due_at: ago(2) })
    await expectOwnEntry(() => ok('/api/tasks/bulk/snooze-overdue', { delta_minutes: 60 }))
  })

  test('POST /api/task-segments/consider, /defer, /restore, /target-today', async () => {
    const t = await makeTask({ title: 'Sort the receipts', horizon: 'days' })
    await expectOwnEntry(() => ok('/api/task-segments/consider', { ids: [t.id] }))
    await expectOwnEntry(() => ok('/api/task-segments/defer', { ids: [t.id] }))
    await expectOwnEntry(() => ok('/api/task-segments/restore', { ids: [t.id] }))
    await expectOwnEntry(() => ok('/api/task-segments/target-today', { ids: [t.id] }))
  })

  test('POST /api/task-segments/defer-lead (task queue on)', async () => {
    await setTaskQueue(true)
    try {
      const t = await makeTask({
        title: 'File the claim',
        deadline_at: ahead(6),
        lead_days: 10,
      })
      // Two calendar days out: always a later OpenTask day, even between
      // midnight and the 3:00 AM day start (when today is still yesterday).
      const later = DateTime.now().setZone('America/Chicago').plus({ days: 2 }).toISODate()
      const data = await expectOwnEntry(() =>
        ok('/api/task-segments/defer-lead', { ids: [t.id], day: later }),
      )
      expect(data.deferred).toBe(1)
    } finally {
      await setTaskQueue(false)
    }
  })

  test('POST /api/quota-prompts/consider, /restore, /did', async () => {
    const quota = await makeTask({
      title: 'Read a chapter',
      rrule: 'FREQ=WEEKLY',
      progress_target: 3,
      is_tracked: true,
    })
    const reminders = (await ok('/api/reminders')) as {
      groups: { prompts: { task_id: number; prompt_key: string }[] }[]
    }
    const prompt = reminders.groups.flatMap((g) => g.prompts).find((p) => p.task_id === quota.id)
    expect(prompt).toBeDefined()
    const keys = [prompt!.prompt_key]
    await expectOwnEntry(() => ok('/api/quota-prompts/consider', { keys }))
    await expectOwnEntry(() => ok('/api/quota-prompts/restore', { keys }))
    await expectOwnEntry(() => ok('/api/quota-prompts/did', { keys }))
  })

  test('POST /api/notifications/actions: done, snooze, delete; a stale Considered is null', async () => {
    const a = await makeTask({ title: 'Call the plumber', due_at: ago(1) })
    await expectOwnEntry(() =>
      ok('/api/notifications/actions', { action: 'snooze', task_id: a.id }),
    )
    await expectOwnEntry(() => ok('/api/notifications/actions', { action: 'done', task_id: a.id }))
    const b = await makeTask({ title: 'Cancel the trial' })
    await expectOwnEntry(() =>
      ok('/api/notifications/actions', { action: 'delete', task_id: b.id }),
    )

    // Another day's Considered changes nothing and logs nothing: null.
    const c = await makeTask({ title: 'Check the mail' })
    const before = await historyIds()
    const yesterday = DateTime.now().setZone('America/Chicago').minus({ days: 1 }).toISODate()
    const stale = await ok('/api/notifications/actions', {
      action: 'done',
      task_id: c.id,
      day: yesterday,
    })
    expect(stale).toMatchObject({ considered: false, undo_id: null })
    expect(await historyIds()).toEqual(before)
  })
})

describe('POST /api/undo and /api/redo with an id', () => {
  beforeEach(async () => {
    await resetTestData()
  })

  async function twoEdits() {
    const t = await makeTask({ title: 'Plan the trip' })
    const first = (await ok(`/api/tasks/${t.id}`, { title: 'Plan the road trip' }, 'PATCH'))
      .undo_id as number
    const second = (await ok(`/api/tasks/${t.id}`, { title: 'Plan the long trip' }, 'PATCH'))
      .undo_id as number
    return { taskId: t.id, first, second }
  }

  test('the newest id is undone; the success body names it', async () => {
    const { taskId, second } = await twoEdits()
    const res = await send('/api/undo', { id: second })
    expect(res.status).toBe(200)
    expect(res.json.data).toMatchObject({ undone_action: 'edit', undone_id: second })
    expect(((await ok(`/api/tasks/${taskId}`)) as { title: string }).title).toBe(
      'Plan the road trip',
    )
  })

  test('409 shapes: not_latest, already_undone, gone (purged or not yours)', async () => {
    const { taskId, first, second } = await twoEdits()

    const notLatest = await send('/api/undo', { id: first })
    expect(notLatest.status).toBe(409)
    expect(notLatest.json).toEqual({
      error: expect.any(String),
      code: 'CONFLICT',
      details: { reason: 'not_latest', newest_undoable_id: second },
    })
    // Nothing moved.
    expect(((await ok(`/api/tasks/${taskId}`)) as { title: string }).title).toBe(
      'Plan the long trip',
    )

    await ok('/api/undo', { id: second })
    const again = await send('/api/undo', { id: second })
    expect(again.status).toBe(409)
    expect(again.json.details).toEqual({ reason: 'already_undone', newest_undoable_id: first })

    // User B's entry is "gone" to User A (never whose it is).
    const bTask = (await (
      await apiFetchB('/api/tasks', { method: 'POST', body: { title: 'B task' } })
    ).json()) as { data: { undo_id: number } }
    const theirs = await send('/api/undo', { id: bTask.data.undo_id })
    expect(theirs.status).toBe(409)
    expect(theirs.json.details).toEqual({ reason: 'gone', newest_undoable_id: first })
    expect(await historyIds(apiFetchB)).toContain(bTask.data.undo_id)

    const never = await send('/api/undo', { id: 99999999 })
    expect(never.json.details).toEqual({ reason: 'gone', newest_undoable_id: first })
  })

  test('a malformed id is a 400, never a bare undo', async () => {
    const { second } = await twoEdits()
    for (const id of ['5', 0, -1, 1.5]) {
      const res = await send('/api/undo', { id })
      expect(res.status).toBe(400)
      expect((await send('/api/redo', { id })).status).toBe(400)
    }
    expect((await status()).newest_undoable_id).toBe(second)
  })

  test('without an id both are the bare undo/redo, as before', async () => {
    const { first, second } = await twoEdits()
    const undo = await send('/api/undo', {})
    expect(undo.status).toBe(200)
    expect(undo.json.data.undone_id).toBe(second)
    const noBody = await apiFetch('/api/undo', { method: 'POST' })
    expect(((await noBody.json()) as Body).data.undone_id).toBe(first)
    const redo = await send('/api/redo', { id: null })
    expect(redo.json.data).toMatchObject({ redone_action: 'edit', redone_id: first })
    const bare = await apiFetch('/api/redo', { method: 'POST' })
    expect(((await bare.json()) as Body).data.redone_id).toBe(second)
    expect((await apiFetch('/api/redo', { method: 'POST' })).status).toBe(400)
  })

  test('redo by id: only the next one; 409 not_next / not_undone', async () => {
    const { first, second } = await twoEdits()
    await ok('/api/undo', { id: second })
    await ok('/api/undo', { id: first })

    const notNext = await send('/api/redo', { id: second })
    expect(notNext.status).toBe(409)
    expect(notNext.json).toEqual({
      error: expect.any(String),
      code: 'CONFLICT',
      details: { reason: 'not_next', next_redoable_id: first },
    })
    const redone = await send('/api/redo', { id: first })
    expect(redone.json.data).toMatchObject({ redone_id: first })
    const live = await send('/api/redo', { id: first })
    expect(live.json.details).toEqual({ reason: 'not_undone', next_redoable_id: second })
  })

  test('GET /api/undo/status: newest_undoable_id and next_redoable_id follow the stack', async () => {
    const { first, second } = await twoEdits()
    expect(await status()).toMatchObject({
      latest_id: second,
      newest_undoable_id: second,
      next_redoable_id: null,
    })
    await ok('/api/undo', { id: second })
    expect(await status()).toMatchObject({
      latest_id: second,
      newest_undoable_id: first,
      next_redoable_id: second,
    })
  })
})
