import { describe, test, expect, beforeAll } from 'vitest'
import { apiFetch, apiFetchB, resetTestData } from './helpers'

describe('Task CRUD integration', () => {
  beforeAll(async () => {
    await resetTestData()
  })

  test('POST create then GET back — all fields match', async () => {
    const createRes = await apiFetch('/api/tasks', {
      method: 'POST',
      body: {
        title: 'Integration test task',
        due_at: '2025-06-15T14:00:00Z',
        priority: 2,
        project_id: 1,
        labels: ['test'],
      },
    })
    expect(createRes.status).toBe(201)
    const created = (await createRes.json()).data

    const getRes = await apiFetch(`/api/tasks/${created.id}`)
    expect(getRes.status).toBe(200)
    const fetched = (await getRes.json()).data

    expect(fetched.title).toBe('Integration test task')
    expect(fetched.due_at).toBe('2025-06-15T14:00:00Z')
    expect(fetched.priority).toBe(2)
    expect(fetched.project_id).toBe(1)
    expect(fetched.labels).toEqual(['test'])
  })

  test('GET ?project=N returns only tasks from that project', async () => {
    const res = await apiFetch('/api/tasks?project=3')
    expect(res.status).toBe(200)
    const data = await res.json()
    for (const task of data.data.tasks) {
      expect(task.project_id).toBe(3)
    }
    expect(data.data.tasks.length).toBeGreaterThan(0)
  })

  test('GET ?search=keyword returns only matching tasks', async () => {
    const res = await apiFetch('/api/tasks?search=groceries')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.data.tasks.length).toBeGreaterThan(0)
    for (const task of data.data.tasks) {
      expect(task.title.toLowerCase()).toContain('groceries')
    }
  })

  test('PATCH priority only — title unchanged (DI-001)', async () => {
    const getRes = await apiFetch('/api/tasks/1')
    const original = (await getRes.json()).data
    const originalTitle = original.title

    const patchRes = await apiFetch('/api/tasks/1', {
      method: 'PATCH',
      body: { priority: 3 },
    })
    expect(patchRes.status).toBe(200)

    const afterRes = await apiFetch('/api/tasks/1')
    const after = (await afterRes.json()).data
    expect(after.priority).toBe(3)
    expect(after.title).toBe(originalTitle)
  })

  test('DELETE soft-deletes, trashed=true shows it', async () => {
    // Create a disposable task
    const createRes = await apiFetch('/api/tasks', {
      method: 'POST',
      body: { title: 'Delete me', project_id: 1 },
    })
    const task = (await createRes.json()).data

    const delRes = await apiFetch(`/api/tasks/${task.id}`, { method: 'DELETE' })
    expect(delRes.status).toBe(200)

    // Not in default list
    const listRes = await apiFetch('/api/tasks')
    const list = (await listRes.json()).data.tasks
    expect(list.find((t: { id: number }) => t.id === task.id)).toBeUndefined()

    // In trashed list
    const trashRes = await apiFetch('/api/tasks?trashed=true')
    const trashed = (await trashRes.json()).data.tasks
    const trashedTask = trashed.find((t: { id: number }) => t.id === task.id)
    expect(trashedTask).not.toBeUndefined()
    expect(trashedTask.id).toBe(task.id)
  })

  test('POST restore brings task back to default list', async () => {
    // Create and delete
    const createRes = await apiFetch('/api/tasks', {
      method: 'POST',
      body: { title: 'Restore me', project_id: 1 },
    })
    const task = (await createRes.json()).data

    await apiFetch(`/api/tasks/${task.id}`, { method: 'DELETE' })

    // Restore
    const restoreRes = await apiFetch(`/api/tasks/${task.id}/restore`, { method: 'POST' })
    expect(restoreRes.status).toBe(200)

    // Back in default list
    const listRes = await apiFetch('/api/tasks')
    const list = (await listRes.json()).data.tasks
    const restoredTask = list.find((t: { id: number }) => t.id === task.id)
    expect(restoredTask).not.toBeUndefined()
    expect(restoredTask.id).toBe(task.id)
  })
})
