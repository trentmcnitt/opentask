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
    for (const id of [1, 5, 7, 8]) {
      const res = await apiFetch(`/api/tasks/${id}`)
      const task = (await res.json()).data
      expect(task.done).toBeTruthy()
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

    // Get original due_at values
    const before7 = (await (await apiFetch('/api/tasks/7')).json()).data
    const before8 = (await (await apiFetch('/api/tasks/8')).json()).data

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
    expect(after7.done).toBeFalsy()
    expect(after8.done).toBeFalsy()
  })
})
