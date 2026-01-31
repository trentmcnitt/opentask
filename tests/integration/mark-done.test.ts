import { describe, test, expect, beforeAll } from 'vitest'
import { apiFetch, resetTestData } from './helpers'

describe('Mark done integration', () => {
  beforeAll(async () => {
    await resetTestData()
  })

  test('POST done on recurring task advances due_at', async () => {
    // Task 2 is a daily recurring task
    const beforeRes = await apiFetch('/api/tasks/2')
    const before = (await beforeRes.json()).data
    expect(before.rrule).toBe('FREQ=DAILY')

    const doneRes = await apiFetch('/api/tasks/2/done', { method: 'POST' })
    expect(doneRes.status).toBe(200)
    const doneData = (await doneRes.json()).data
    expect(doneData.was_recurring).toBe(true)

    // Verify the task still exists (not archived) with a new due_at
    const afterRes = await apiFetch('/api/tasks/2')
    const after = (await afterRes.json()).data
    expect(after.done).toBeFalsy()
    expect(after.due_at).not.toBe(before.due_at)
  })

  test('POST done on one-off task marks done and archives', async () => {
    // Task 1 is a one-off task
    const doneRes = await apiFetch('/api/tasks/1/done', { method: 'POST' })
    expect(doneRes.status).toBe(200)

    // Should not be in default (active) list
    const listRes = await apiFetch('/api/tasks')
    const list = (await listRes.json()).data.tasks
    const found = list.find((t: { id: number }) => t.id === 1)
    expect(found).toBeUndefined()

    // Should be in archived list (archived tasks are done=1, so need done=true)
    const archivedRes = await apiFetch('/api/tasks?archived=true&done=true')
    const archived = (await archivedRes.json()).data.tasks
    const archivedTask = archived.find((t: { id: number }) => t.id === 1)
    expect(archivedTask).toBeDefined()
    expect(archivedTask.done).toBeTruthy()
    expect(archivedTask.archived_at).toBeTruthy()
  })

  test('POST done then POST undo restores original state', async () => {
    await resetTestData()

    // Get original state of task 2 (recurring daily)
    const beforeRes = await apiFetch('/api/tasks/2')
    const before = (await beforeRes.json()).data
    const originalDueAt = before.due_at

    // Mark done (advances due_at)
    await apiFetch('/api/tasks/2/done', { method: 'POST' })

    // Undo
    const undoRes = await apiFetch('/api/undo', { method: 'POST' })
    expect(undoRes.status).toBe(200)

    // Verify restored
    const afterRes = await apiFetch('/api/tasks/2')
    const after = (await afterRes.json()).data
    expect(after.due_at).toBe(originalDueAt)
  })
})
