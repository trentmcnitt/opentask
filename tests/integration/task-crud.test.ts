import { describe, test, expect, beforeAll, beforeEach } from 'vitest'
import { apiFetch, resetTestData } from './helpers'

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
    expect(fetched.due_at).toBe('2025-06-15T14:00:00.000Z')
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

describe('Task clear due date', () => {
  beforeEach(async () => {
    await resetTestData()
  })

  test('PATCH with due_at: null clears the due date', async () => {
    // Create task with due date
    const createRes = await apiFetch('/api/tasks', {
      method: 'POST',
      body: {
        title: 'Task with due date',
        due_at: '2026-02-10T15:00:00Z',
        project_id: 1,
      },
    })
    expect(createRes.status).toBe(201)
    const created = (await createRes.json()).data

    // Clear due date
    const patchRes = await apiFetch(`/api/tasks/${created.id}`, {
      method: 'PATCH',
      body: { due_at: null },
    })
    expect(patchRes.status).toBe(200)
    const patched = (await patchRes.json()).data
    expect(patched.due_at).toBeNull()
  })

  test('PATCH with due_at: null and rrule: null clears both', async () => {
    // Create recurring task
    const createRes = await apiFetch('/api/tasks', {
      method: 'POST',
      body: {
        title: 'Recurring task',
        due_at: '2026-02-10T15:00:00Z',
        rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
        project_id: 1,
      },
    })
    expect(createRes.status).toBe(201)
    const created = (await createRes.json()).data
    expect(created.rrule).toBeTruthy()

    // Clear both due_at and rrule
    const patchRes = await apiFetch(`/api/tasks/${created.id}`, {
      method: 'PATCH',
      body: { due_at: null, rrule: null },
    })
    expect(patchRes.status).toBe(200)
    const patched = (await patchRes.json()).data
    expect(patched.due_at).toBeNull()
    expect(patched.rrule).toBeNull()
  })

  test('undo clear due_at restores original date', async () => {
    // Create task with due date
    const createRes = await apiFetch('/api/tasks', {
      method: 'POST',
      body: {
        title: 'Task to clear',
        due_at: '2026-02-10T15:00:00Z',
        project_id: 1,
      },
    })
    const created = (await createRes.json()).data
    const originalDueAt = created.due_at

    // Clear due date
    await apiFetch(`/api/tasks/${created.id}`, {
      method: 'PATCH',
      body: { due_at: null },
    })
    const cleared = (await apiFetch(`/api/tasks/${created.id}`).then((r) => r.json())).data
    expect(cleared.due_at).toBeNull()

    // Undo
    const undoRes = await apiFetch('/api/undo', { method: 'POST' })
    expect(undoRes.status).toBe(200)

    // Verify restored
    const restored = (await apiFetch(`/api/tasks/${created.id}`).then((r) => r.json())).data
    expect(restored.due_at).toBe(originalDueAt)
  })

  test('undo clear due_at and rrule restores both', async () => {
    // Create recurring task
    const createRes = await apiFetch('/api/tasks', {
      method: 'POST',
      body: {
        title: 'Recurring to clear',
        due_at: '2026-02-10T15:00:00Z',
        rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
        project_id: 1,
      },
    })
    const created = (await createRes.json()).data
    const originalDueAt = created.due_at
    const originalRrule = created.rrule

    // Clear both
    await apiFetch(`/api/tasks/${created.id}`, {
      method: 'PATCH',
      body: { due_at: null, rrule: null },
    })

    // Undo
    const undoRes = await apiFetch('/api/undo', { method: 'POST' })
    expect(undoRes.status).toBe(200)

    // Verify both restored
    const restored = (await apiFetch(`/api/tasks/${created.id}`).then((r) => r.json())).data
    expect(restored.due_at).toBe(originalDueAt)
    expect(restored.rrule).toBe(originalRrule)
  })
})
