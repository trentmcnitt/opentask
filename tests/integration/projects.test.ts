/**
 * /api/projects/:id over HTTP: the single-project counts agree with the list,
 * the Inbox can't be renamed, and deleting a shared project sends each
 * member's tasks to their own Inbox.
 *
 * Seed (scripts/seed-test.ts): user A owns Inbox (1), Routine (2), Work (3)
 * and the shared Family (5); user B owns Inbox (4).
 */
import { describe, test, expect, beforeEach } from 'vitest'
import { apiFetch, apiFetchB, resetTestData } from './helpers'

const A_INBOX = 1
const B_INBOX = 4
const FAMILY = 5

async function createTaskIn(fetcher: typeof apiFetch, projectId: number, extra = {}) {
  const res = await fetcher('/api/tasks', {
    method: 'POST',
    body: { title: `Project probe ${Date.now()}`, project_id: projectId, ...extra },
  })
  expect(res.status).toBe(201)
  return (await res.json()).data as { id: number }
}

async function projectOf(fetcher: typeof apiFetch, taskId: number): Promise<number> {
  const res = await fetcher(`/api/tasks/${taskId}`)
  expect(res.status).toBe(200)
  return (await res.json()).data.project_id
}

describe('Projects API', () => {
  beforeEach(async () => {
    await resetTestData()
  })

  test('GET /api/projects/:id counts match the list', async () => {
    // A quota: the list never counted it; GET-by-id used to.
    await createTaskIn(apiFetch, 3, { progress_target: 3, rrule: 'FREQ=WEEKLY' })
    const list = (await (await apiFetch('/api/projects')).json()).data.projects as {
      id: number
    }[]
    const one = (await (await apiFetch('/api/projects/3')).json()).data
    expect(one).toEqual(list.find((p) => p.id === 3))
  })

  test('renaming the Inbox is refused; other fields still change', async () => {
    const rename = await apiFetch(`/api/projects/${A_INBOX}`, {
      method: 'PATCH',
      body: { name: 'Triage' },
    })
    expect(rename.status).toBe(400)
    expect((await rename.json()).error).toBe('Cannot rename Inbox project')

    const recolor = await apiFetch(`/api/projects/${A_INBOX}`, {
      method: 'PATCH',
      body: { color: 'red' },
    })
    expect(recolor.status).toBe(200)
    expect((await recolor.json()).data).toMatchObject({ name: 'Inbox', color: 'red' })
  })

  test("deleting a shared project moves each member's tasks to their own Inbox", async () => {
    const mine = await createTaskIn(apiFetch, FAMILY)
    const theirs = await createTaskIn(apiFetchB, FAMILY)

    const res = await apiFetch(`/api/projects/${FAMILY}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({
      message: 'Project deleted',
      tasks_moved_to_inbox: true,
    })

    expect(await projectOf(apiFetch, mine.id)).toBe(A_INBOX)
    expect(await projectOf(apiFetchB, theirs.id)).toBe(B_INBOX)
    expect((await apiFetch(`/api/projects/${FAMILY}`)).status).toBe(404)
  })

  test('only the owner can delete; a missing project is 404 with its id', async () => {
    const byMember = await apiFetchB(`/api/projects/${FAMILY}`, { method: 'DELETE' })
    expect(byMember.status).toBe(403)
    expect((await byMember.json()).error).toBe('Only the project owner can delete this project')

    const missing = await apiFetch('/api/projects/99999', { method: 'DELETE' })
    expect(missing.status).toBe(404)
    expect((await missing.json()).details).toEqual({ project_id: 99999 })

    const inbox = await apiFetch(`/api/projects/${A_INBOX}`, { method: 'DELETE' })
    expect(inbox.status).toBe(400)
    expect((await inbox.json()).error).toBe('Cannot delete Inbox project')
  })
})
