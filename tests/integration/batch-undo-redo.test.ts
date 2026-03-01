/**
 * Batch Undo/Redo integration tests
 *
 * Tests the batch undo/redo API endpoints via HTTP against a real server.
 *
 * Seeded tasks (User A):
 *   1: "Buy groceries" — one-off, project Inbox, priority 2
 *   4: "Review PRs" — one-off, project Work, priority 3
 *   5: "Prepare slides" — one-off, project Inbox, priority 2
 *   7: "Clean desk" — one-off, project Inbox, priority 0
 *   8: "Call dentist" — one-off, project Inbox, priority 1
 */

import { describe, test, expect, beforeEach } from 'vitest'
import { apiFetch, apiAnon, resetTestData } from './helpers'

async function getTask(id: number) {
  const res = await apiFetch(`/api/tasks/${id}`)
  expect(res.status).toBe(200)
  return (await res.json()).data
}

async function editTask(id: number, body: Record<string, unknown>) {
  const res = await apiFetch(`/api/tasks/${id}`, { method: 'PATCH', body })
  expect(res.status).toBe(200)
  return (await res.json()).data
}

async function batchUndo(body: Record<string, unknown>) {
  return apiFetch('/api/undo/batch', { method: 'POST', body })
}

async function batchRedo(body: Record<string, unknown>) {
  return apiFetch('/api/redo/batch', { method: 'POST', body })
}

describe('Batch Undo integration', () => {
  beforeEach(async () => {
    await resetTestData()
  })

  test('POST /api/undo/batch with count undoes multiple actions', async () => {
    await editTask(1, { title: 'Edit 1' })
    await editTask(5, { title: 'Edit 2' })
    await editTask(7, { title: 'Edit 3' })

    const res = await batchUndo({ count: 2 })
    expect(res.status).toBe(200)

    const data = (await res.json()).data
    expect(data.count).toBe(2)
    expect(typeof data.undoable_count).toBe('number')
    expect(typeof data.redoable_count).toBe('number')

    // Most recent 2 edits undone (task 7 and 5), task 1 still edited
    expect((await getTask(7)).title).toBe('Clean desk')
    expect((await getTask(5)).title).toBe('Prepare slides')
    expect((await getTask(1)).title).toBe('Edit 1')
  })

  test('POST /api/undo/batch with large count undoes all available actions', async () => {
    await editTask(1, { title: 'Edit 1' })
    await editTask(5, { title: 'Edit 2' })
    await editTask(7, { title: 'Edit 3' })

    // Count exceeds available entries — undoes all 3
    const res = await batchUndo({ count: 10 })
    expect(res.status).toBe(200)

    const data = (await res.json()).data
    expect(data.count).toBe(3)
    expect(data.undoable_count).toBe(0)
    expect(data.redoable_count).toBe(3)

    expect((await getTask(1)).title).toBe('Buy groceries')
    expect((await getTask(5)).title).toBe('Prepare slides')
    expect((await getTask(7)).title).toBe('Clean desk')
  })

  test('nothing to undo returns 400', async () => {
    const res = await batchUndo({ count: 1 })
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toMatch(/nothing to undo/i)
  })

  test('empty body returns 400', async () => {
    const res = await batchUndo({})
    expect(res.status).toBe(400)
  })

  test('zero count returns 400 (Zod positive validation)', async () => {
    const res = await batchUndo({ count: 0 })
    expect(res.status).toBe(400)
  })

  test('requires authentication', async () => {
    const res = await apiAnon('/api/undo/batch', { method: 'POST', body: { count: 1 } })
    expect(res.status).toBe(401)
  })
})

describe('Batch Redo integration', () => {
  beforeEach(async () => {
    await resetTestData()
  })

  test('POST /api/redo/batch with count redoes multiple actions', async () => {
    await editTask(1, { title: 'Edit 1' })
    await editTask(5, { title: 'Edit 2' })

    // Undo both
    await batchUndo({ count: 2 })
    expect((await getTask(1)).title).toBe('Buy groceries')
    expect((await getTask(5)).title).toBe('Prepare slides')

    // Redo both
    const res = await batchRedo({ count: 2 })
    expect(res.status).toBe(200)

    const data = (await res.json()).data
    expect(data.count).toBe(2)

    expect((await getTask(1)).title).toBe('Edit 1')
    expect((await getTask(5)).title).toBe('Edit 2')
  })

  test('nothing to redo returns 400', async () => {
    const res = await batchRedo({ count: 1 })
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toMatch(/nothing to redo/i)
  })

  test('requires authentication', async () => {
    const res = await apiAnon('/api/redo/batch', { method: 'POST', body: { count: 1 } })
    expect(res.status).toBe(401)
  })
})
