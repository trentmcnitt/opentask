/**
 * Integration tests for external automation features
 *
 * Tests the HTTP-level behavior of:
 * - original_title: preserved on creation, returned in responses, unchanged by PATCH
 * - auto_snooze_minutes: accepted at creation, round-trips through API
 * - notes: set via PATCH, round-trips through API
 * - reprocess endpoint: returns task with original_title intact
 * - New enrichment fields (recurrence_mode, notes, auto_snooze_minutes) via PATCH
 */

import { describe, test, expect, beforeAll } from 'vitest'
import { apiFetch, resetTestData } from './helpers'

beforeAll(async () => {
  await resetTestData()
})

describe('original_title', () => {
  test('POST /api/tasks returns original_title matching input title', async () => {
    const res = await apiFetch('/api/tasks', {
      method: 'POST',
      body: { title: 'call dentist tomorrow morning high priority' },
    })
    expect(res.status).toBe(201)
    const { data } = await res.json()

    expect(data.original_title).toBe('call dentist tomorrow morning high priority')
    expect(data.title).toBe('call dentist tomorrow morning high priority')
  })

  test('GET /api/tasks/:id includes original_title', async () => {
    const createRes = await apiFetch('/api/tasks', {
      method: 'POST',
      body: { title: 'raw dictated input with lots of detail' },
    })
    const { data: created } = await createRes.json()

    const getRes = await apiFetch(`/api/tasks/${created.id}`)
    expect(getRes.status).toBe(200)
    const { data: fetched } = await getRes.json()

    expect(fetched.original_title).toBe('raw dictated input with lots of detail')
  })

  test('GET /api/tasks list includes original_title on each task', async () => {
    const res = await apiFetch('/api/tasks')
    expect(res.status).toBe(200)
    const { data } = await res.json()

    // All tasks should have original_title field (may be null for seed data)
    for (const task of data.tasks) {
      expect(task).toHaveProperty('original_title')
    }
  })

  test('PATCH title does not change original_title', async () => {
    const createRes = await apiFetch('/api/tasks', {
      method: 'POST',
      body: { title: 'um call the dentist tomorrow or whatever' },
    })
    const { data: created } = await createRes.json()
    expect(created.original_title).toBe('um call the dentist tomorrow or whatever')

    // Update the title via PATCH
    const patchRes = await apiFetch(`/api/tasks/${created.id}`, {
      method: 'PATCH',
      body: { title: 'Call the dentist' },
    })
    expect(patchRes.status).toBe(200)
    const { data: patched } = await patchRes.json()

    expect(patched.title).toBe('Call the dentist')
    expect(patched.original_title).toBe('um call the dentist tomorrow or whatever')
  })

  test('original_title preserved after multiple PATCHes', async () => {
    const createRes = await apiFetch('/api/tasks', {
      method: 'POST',
      body: { title: 'original raw text stays forever' },
    })
    const { data: created } = await createRes.json()

    // PATCH title
    await apiFetch(`/api/tasks/${created.id}`, {
      method: 'PATCH',
      body: { title: 'First edit' },
    })

    // PATCH priority
    await apiFetch(`/api/tasks/${created.id}`, {
      method: 'PATCH',
      body: { priority: 3 },
    })

    // PATCH title again
    await apiFetch(`/api/tasks/${created.id}`, {
      method: 'PATCH',
      body: { title: 'Second edit' },
    })

    const getRes = await apiFetch(`/api/tasks/${created.id}`)
    const { data: final } = await getRes.json()

    expect(final.title).toBe('Second edit')
    expect(final.original_title).toBe('original raw text stays forever')
  })
})

describe('auto_snooze_minutes at creation', () => {
  test('POST with auto_snooze_minutes persists the value', async () => {
    const res = await apiFetch('/api/tasks', {
      method: 'POST',
      body: {
        title: 'Task with custom snooze',
        auto_snooze_minutes: 120,
        priority: 2,
      },
    })
    expect(res.status).toBe(201)
    const { data } = await res.json()

    expect(data.auto_snooze_minutes).toBe(120)

    // Verify via GET
    const getRes = await apiFetch(`/api/tasks/${data.id}`)
    const { data: fetched } = await getRes.json()
    expect(fetched.auto_snooze_minutes).toBe(120)
  })

  test('POST with auto_snooze_minutes: 0 (off) is persisted', async () => {
    const res = await apiFetch('/api/tasks', {
      method: 'POST',
      body: {
        title: 'Task with snooze off',
        auto_snooze_minutes: 0,
        priority: 1,
      },
    })
    expect(res.status).toBe(201)
    const { data } = await res.json()
    expect(data.auto_snooze_minutes).toBe(0)
  })

  test('POST without auto_snooze_minutes defaults to null', async () => {
    const res = await apiFetch('/api/tasks', {
      method: 'POST',
      body: {
        title: 'Task without explicit snooze',
        priority: 1,
      },
    })
    expect(res.status).toBe(201)
    const { data } = await res.json()
    expect(data.auto_snooze_minutes).toBeNull()
  })

  test('PATCH auto_snooze_minutes updates the value', async () => {
    const createRes = await apiFetch('/api/tasks', {
      method: 'POST',
      body: { title: 'Snooze update test', priority: 1 },
    })
    const { data: created } = await createRes.json()

    const patchRes = await apiFetch(`/api/tasks/${created.id}`, {
      method: 'PATCH',
      body: { auto_snooze_minutes: 45 },
    })
    expect(patchRes.status).toBe(200)
    const { data: patched } = await patchRes.json()
    expect(patched.auto_snooze_minutes).toBe(45)
  })
})

describe('notes via API', () => {
  test('PATCH notes sets the value', async () => {
    const createRes = await apiFetch('/api/tasks', {
      method: 'POST',
      body: { title: 'Task needing notes', priority: 2 },
    })
    const { data: created } = await createRes.json()

    const patchRes = await apiFetch(`/api/tasks/${created.id}`, {
      method: 'PATCH',
      body: { notes: 'Claim #847293. Call 1-800-555-0123.' },
    })
    expect(patchRes.status).toBe(200)
    const { data: patched } = await patchRes.json()
    expect(patched.notes).toBe('Claim #847293. Call 1-800-555-0123.')
  })

  test('PATCH notes: null clears the value', async () => {
    const createRes = await apiFetch('/api/tasks', {
      method: 'POST',
      body: { title: 'Notes to clear', priority: 1 },
    })
    const { data: created } = await createRes.json()

    // Set notes
    await apiFetch(`/api/tasks/${created.id}`, {
      method: 'PATCH',
      body: { notes: 'Some notes' },
    })

    // Clear notes
    const clearRes = await apiFetch(`/api/tasks/${created.id}`, {
      method: 'PATCH',
      body: { notes: null },
    })
    expect(clearRes.status).toBe(200)
    const { data: cleared } = await clearRes.json()
    expect(cleared.notes).toBeNull()
  })

  test('GET returns notes after PATCH', async () => {
    const createRes = await apiFetch('/api/tasks', {
      method: 'POST',
      body: { title: 'Notes round-trip', priority: 1 },
    })
    const { data: created } = await createRes.json()

    await apiFetch(`/api/tasks/${created.id}`, {
      method: 'PATCH',
      body: { notes: 'Reference: ABC-123' },
    })

    const getRes = await apiFetch(`/api/tasks/${created.id}`)
    const { data: fetched } = await getRes.json()
    expect(fetched.notes).toBe('Reference: ABC-123')
  })
})

describe('recurrence_mode via API', () => {
  test('POST with recurrence_mode: from_completion persists', async () => {
    const res = await apiFetch('/api/tasks', {
      method: 'POST',
      body: {
        title: 'Water plants',
        rrule: 'FREQ=DAILY;INTERVAL=3',
        recurrence_mode: 'from_completion',
        priority: 1,
      },
    })
    expect(res.status).toBe(201)
    const { data } = await res.json()

    expect(data.recurrence_mode).toBe('from_completion')
    expect(data.rrule).toBe('FREQ=DAILY;INTERVAL=3')
  })

  test('PATCH recurrence_mode changes value', async () => {
    const createRes = await apiFetch('/api/tasks', {
      method: 'POST',
      body: {
        title: 'Mode switch test',
        rrule: 'FREQ=WEEKLY;BYDAY=MO',
        priority: 1,
      },
    })
    const { data: created } = await createRes.json()
    expect(created.recurrence_mode).toBe('from_due')

    const patchRes = await apiFetch(`/api/tasks/${created.id}`, {
      method: 'PATCH',
      body: { recurrence_mode: 'from_completion' },
    })
    expect(patchRes.status).toBe(200)
    const { data: patched } = await patchRes.json()
    expect(patched.recurrence_mode).toBe('from_completion')
  })
})

describe('reprocess endpoint', () => {
  test('POST /api/tasks/:id/reprocess returns 400 for task without ai-failed label', async () => {
    const createRes = await apiFetch('/api/tasks', {
      method: 'POST',
      body: { title: 'Normal task', priority: 2 },
    })
    const { data: created } = await createRes.json()

    const reprocessRes = await apiFetch(`/api/tasks/${created.id}/reprocess`, {
      method: 'POST',
    })
    // Should fail because task doesn't have ai-failed label
    expect(reprocessRes.status).toBe(400)
  })

  test('POST /api/tasks/:id/reprocess swaps ai-failed to ai-to-process', async () => {
    // Create task with ai-failed label
    const createRes = await apiFetch('/api/tasks', {
      method: 'POST',
      body: {
        title: 'Failed enrichment task',
        labels: ['ai-failed'],
      },
    })
    const { data: created } = await createRes.json()
    expect(created.labels).toContain('ai-failed')

    const reprocessRes = await apiFetch(`/api/tasks/${created.id}/reprocess`, {
      method: 'POST',
    })
    expect(reprocessRes.status).toBe(200)
    const { data: reprocessed } = await reprocessRes.json()

    expect(reprocessed.labels).toContain('ai-to-process')
    expect(reprocessed.labels).not.toContain('ai-failed')
    // original_title should be present
    expect(reprocessed.original_title).toBe('Failed enrichment task')
  })
})

describe('undo reverts new fields', () => {
  test('undo PATCH notes restores previous value', async () => {
    const createRes = await apiFetch('/api/tasks', {
      method: 'POST',
      body: { title: 'Undo notes test', priority: 1 },
    })
    const { data: created } = await createRes.json()
    expect(created.notes).toBeNull()

    // Set notes
    await apiFetch(`/api/tasks/${created.id}`, {
      method: 'PATCH',
      body: { notes: 'Important context' },
    })

    // Undo
    const undoRes = await apiFetch('/api/undo', { method: 'POST' })
    expect(undoRes.status).toBe(200)

    // Verify restored
    const getRes = await apiFetch(`/api/tasks/${created.id}`)
    const { data: restored } = await getRes.json()
    expect(restored.notes).toBeNull()
  })

  test('undo PATCH auto_snooze_minutes restores previous value', async () => {
    const createRes = await apiFetch('/api/tasks', {
      method: 'POST',
      body: { title: 'Undo auto_snooze test', auto_snooze_minutes: 30, priority: 1 },
    })
    const { data: created } = await createRes.json()
    expect(created.auto_snooze_minutes).toBe(30)

    // Change auto_snooze_minutes
    await apiFetch(`/api/tasks/${created.id}`, {
      method: 'PATCH',
      body: { auto_snooze_minutes: 120 },
    })

    // Undo
    const undoRes = await apiFetch('/api/undo', { method: 'POST' })
    expect(undoRes.status).toBe(200)

    // Verify restored
    const getRes = await apiFetch(`/api/tasks/${created.id}`)
    const { data: restored } = await getRes.json()
    expect(restored.auto_snooze_minutes).toBe(30)
  })
})

describe('structured creation bypasses enrichment', () => {
  test('task with all fields set does not get ai-to-process label', async () => {
    const res = await apiFetch('/api/tasks', {
      method: 'POST',
      body: {
        title: 'Fully structured task',
        due_at: '2026-03-15T14:00:00Z',
        priority: 3,
        labels: ['work'],
        rrule: 'FREQ=WEEKLY;BYDAY=MO',
        auto_snooze_minutes: 60,
      },
    })
    expect(res.status).toBe(201)
    const { data } = await res.json()

    expect(data.labels).not.toContain('ai-to-process')
    expect(data.original_title).toBe('Fully structured task')
    expect(data.auto_snooze_minutes).toBe(60)
    expect(data.priority).toBe(3)
  })
})
