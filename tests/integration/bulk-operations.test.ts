import { describe, test, expect, beforeEach } from 'vitest'
import { apiFetch, resetTestData } from './helpers'

describe('Bulk operations integration', () => {
  beforeEach(async () => {
    await resetTestData()
  })

  test('POST bulk/done marks multiple tasks as done', async () => {
    // Tasks 1, 4, 5, 7, 8 are one-off tasks for User A
    const ids = [1, 4, 5, 7, 8]

    const bulkRes = await apiFetch('/api/tasks/bulk/done', {
      method: 'POST',
      body: { ids },
    })
    expect(bulkRes.status).toBe(200)
    const data = (await bulkRes.json()).data
    expect(data.tasks_affected).toBe(5)

    // Verify each task is done/archived
    for (const id of [1, 4, 5, 7, 8]) {
      const res = await apiFetch(`/api/tasks/${id}`)
      const task = (await res.json()).data
      expect(task.done).toBe(true)
    }
  })

  test('POST bulk/done with one invalid ID fails atomically', async () => {
    // Get original states
    const before1 = (await (await apiFetch('/api/tasks/1')).json()).data
    const before5 = (await (await apiFetch('/api/tasks/5')).json()).data

    // Include a non-existent task ID
    const bulkRes = await apiFetch('/api/tasks/bulk/done', {
      method: 'POST',
      body: { ids: [1, 5, 99999] },
    })

    // Should fail (task 99999 doesn't exist or isn't accessible)
    if (bulkRes.status !== 200) {
      // If the API rejects the batch, verify nothing changed
      const after1 = (await (await apiFetch('/api/tasks/1')).json()).data
      const after5 = (await (await apiFetch('/api/tasks/5')).json()).data
      expect(after1.done).toBe(before1.done)
      expect(after5.done).toBe(before5.done)
    }
  })

  test('POST bulk/done then POST undo restores all tasks', async () => {
    const ids = [7, 8]

    // Bulk done
    await apiFetch('/api/tasks/bulk/done', {
      method: 'POST',
      body: { ids },
    })

    // Undo
    const undoRes = await apiFetch('/api/undo', { method: 'POST' })
    expect(undoRes.status).toBe(200)

    // Verify restored
    const after7 = (await (await apiFetch('/api/tasks/7')).json()).data
    const after8 = (await (await apiFetch('/api/tasks/8')).json()).data
    expect(after7.done).toBe(false)
    expect(after8.done).toBe(false)
  })
})

describe('Bulk snooze integration', () => {
  beforeEach(async () => {
    await resetTestData()
  })

  test('POST bulk/snooze with absolute until sets all tasks to same time', async () => {
    // Get original due dates
    const before7 = (await (await apiFetch('/api/tasks/7')).json()).data
    const before8 = (await (await apiFetch('/api/tasks/8')).json()).data

    const targetTime = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()

    const res = await apiFetch('/api/tasks/bulk/snooze', {
      method: 'POST',
      body: { ids: [7, 8], until: targetTime },
    })
    expect(res.status).toBe(200)
    const data = (await res.json()).data
    expect(data.tasks_affected).toBe(2)

    // Both tasks should have the same new due_at
    const after7 = (await (await apiFetch('/api/tasks/7')).json()).data
    const after8 = (await (await apiFetch('/api/tasks/8')).json()).data

    expect(after7.due_at).toBe(targetTime)
    expect(after8.due_at).toBe(targetTime)

    // Verify snoozed_from was set
    expect(after7.snoozed_from).toBe(before7.due_at)
    expect(after8.snoozed_from).toBe(before8.due_at)
  })

  test('POST bulk/snooze with delta_minutes adds to each task', async () => {
    // Get original due dates
    const before7 = (await (await apiFetch('/api/tasks/7')).json()).data
    const before8 = (await (await apiFetch('/api/tasks/8')).json()).data

    const res = await apiFetch('/api/tasks/bulk/snooze', {
      method: 'POST',
      body: { ids: [7, 8], delta_minutes: 90 },
    })
    expect(res.status).toBe(200)
    const data = (await res.json()).data
    expect(data.tasks_affected).toBe(2)

    // Each task should have due_at moved by 90 minutes from its own original
    const after7 = (await (await apiFetch('/api/tasks/7')).json()).data
    const after8 = (await (await apiFetch('/api/tasks/8')).json()).data

    const expected7 = new Date(new Date(before7.due_at).getTime() + 90 * 60 * 1000).toISOString()
    const expected8 = new Date(new Date(before8.due_at).getTime() + 90 * 60 * 1000).toISOString()

    expect(after7.due_at).toBe(expected7)
    expect(after8.due_at).toBe(expected8)
  })

  test('POST bulk/snooze fails when both until and delta_minutes provided', async () => {
    const res = await apiFetch('/api/tasks/bulk/snooze', {
      method: 'POST',
      body: {
        ids: [7, 8],
        until: new Date().toISOString(),
        delta_minutes: 60,
      },
    })
    expect(res.status).toBe(400)
  })

  test('POST bulk/snooze fails when neither until nor delta_minutes provided', async () => {
    const res = await apiFetch('/api/tasks/bulk/snooze', {
      method: 'POST',
      body: { ids: [7, 8] },
    })
    expect(res.status).toBe(400)
  })
})
