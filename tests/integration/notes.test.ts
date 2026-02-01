import { describe, test, expect, beforeAll } from 'vitest'
import { apiFetch, resetTestData } from './helpers'

describe('Notes integration', () => {
  beforeAll(async () => {
    await resetTestData()
  })

  test('POST note then GET notes — content matches', async () => {
    const createRes = await apiFetch('/api/tasks/1/notes', {
      method: 'POST',
      body: { content: 'Remember to buy organic milk' },
    })
    expect(createRes.status).toBe(201)
    const created = (await createRes.json()).data
    expect(created.content).toBe('Remember to buy organic milk')

    const listRes = await apiFetch('/api/tasks/1/notes')
    expect(listRes.status).toBe(200)
    const notes = (await listRes.json()).data.notes
    expect(notes.length).toBeGreaterThan(0)
    expect(notes.find((n: { id: number }) => n.id === created.id)?.content).toBe(
      'Remember to buy organic milk',
    )
  })

  test('PATCH note updates, DELETE note removes it', async () => {
    // Create a note
    const createRes = await apiFetch('/api/tasks/4/notes', {
      method: 'POST',
      body: { content: 'Original content' },
    })
    const note = (await createRes.json()).data

    // Patch
    const patchRes = await apiFetch(`/api/tasks/4/notes/${note.id}`, {
      method: 'PATCH',
      body: { content: 'Updated content' },
    })
    expect(patchRes.status).toBe(200)

    const afterPatch = await apiFetch('/api/tasks/4/notes')
    const patchedNotes = (await afterPatch.json()).data.notes
    expect(patchedNotes.find((n: { id: number }) => n.id === note.id)?.content).toBe(
      'Updated content',
    )

    // Delete
    const delRes = await apiFetch(`/api/tasks/4/notes/${note.id}`, { method: 'DELETE' })
    expect(delRes.status).toBe(200)

    const afterDel = await apiFetch('/api/tasks/4/notes')
    const remainingNotes = (await afterDel.json()).data.notes
    expect(remainingNotes.find((n: { id: number }) => n.id === note.id)).toBeUndefined()
  })
})
