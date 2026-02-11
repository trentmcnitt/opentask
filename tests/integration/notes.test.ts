/**
 * Integration tests for notes via task PATCH/GET
 *
 * Notes are now a single text field on the task, read and written
 * via the existing PATCH /api/tasks/:id and GET /api/tasks/:id endpoints.
 */

import { describe, test, expect, beforeAll } from 'vitest'
import { apiFetch, resetTestData } from './helpers'

describe('Notes integration', () => {
  beforeAll(async () => {
    await resetTestData()
  })

  test('PATCH notes sets the value, GET returns it', async () => {
    const createRes = await apiFetch('/api/tasks', {
      method: 'POST',
      body: { title: 'Task with notes' },
    })
    const { data: created } = await createRes.json()
    expect(created.notes).toBeNull()

    const patchRes = await apiFetch(`/api/tasks/${created.id}`, {
      method: 'PATCH',
      body: { notes: 'Claim #847293. Call 1-800-555-0123.' },
    })
    expect(patchRes.status).toBe(200)
    const { data: patched } = await patchRes.json()
    expect(patched.notes).toBe('Claim #847293. Call 1-800-555-0123.')

    // Verify round-trip via GET
    const getRes = await apiFetch(`/api/tasks/${created.id}`)
    const { data: fetched } = await getRes.json()
    expect(fetched.notes).toBe('Claim #847293. Call 1-800-555-0123.')
  })

  test('PATCH notes: null clears the value', async () => {
    const createRes = await apiFetch('/api/tasks', {
      method: 'POST',
      body: { title: 'Notes to clear' },
    })
    const { data: created } = await createRes.json()

    // Set notes
    await apiFetch(`/api/tasks/${created.id}`, {
      method: 'PATCH',
      body: { notes: 'Some notes here' },
    })

    // Clear notes
    const clearRes = await apiFetch(`/api/tasks/${created.id}`, {
      method: 'PATCH',
      body: { notes: null },
    })
    expect(clearRes.status).toBe(200)
    const { data: cleared } = await clearRes.json()
    expect(cleared.notes).toBeNull()

    // Verify via GET
    const getRes = await apiFetch(`/api/tasks/${created.id}`)
    const { data: fetched } = await getRes.json()
    expect(fetched.notes).toBeNull()
  })

  test('multi-line notes are preserved', async () => {
    const createRes = await apiFetch('/api/tasks', {
      method: 'POST',
      body: { title: 'Multi-line notes task' },
    })
    const { data: created } = await createRes.json()

    const multiLine = 'Line one\nLine two\nLine three'
    await apiFetch(`/api/tasks/${created.id}`, {
      method: 'PATCH',
      body: { notes: multiLine },
    })

    const getRes = await apiFetch(`/api/tasks/${created.id}`)
    const { data: fetched } = await getRes.json()
    expect(fetched.notes).toBe(multiLine)
  })
})
