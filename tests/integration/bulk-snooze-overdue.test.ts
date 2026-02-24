/**
 * Bulk Snooze Overdue Integration Tests
 *
 * Tests the POST /api/tasks/bulk/snooze-overdue endpoint.
 * This endpoint queries overdue tasks server-side (no task IDs needed from client).
 */

import { describe, test, expect, beforeEach } from 'vitest'
import { apiFetch, apiAnon, resetTestData } from './helpers'

describe('Bulk snooze-overdue integration', () => {
  beforeEach(async () => {
    await resetTestData()
  })

  test('POST requires auth', async () => {
    const res = await apiAnon('/api/tasks/bulk/snooze-overdue', {
      method: 'POST',
      body: { delta_minutes: 60 },
    })
    expect(res.status).toBe(401)
  })

  test('POST with empty body uses user defaults', async () => {
    const res = await apiFetch('/api/tasks/bulk/snooze-overdue', {
      method: 'POST',
      body: {},
    })
    expect(res.status).toBe(200)
  })

  test('POST requires positive delta_minutes', async () => {
    const res = await apiFetch('/api/tasks/bulk/snooze-overdue', {
      method: 'POST',
      body: { delta_minutes: -30 },
    })
    expect(res.status).toBe(400)
  })

  test('POST with no overdue tasks returns zero affected', async () => {
    // First snooze all tasks to the future so none are overdue
    const tasksRes = await apiFetch('/api/tasks')
    const tasks = (await tasksRes.json()).data.tasks
    for (const task of tasks) {
      if (task.due_at) {
        await apiFetch(`/api/tasks/${task.id}`, {
          method: 'PATCH',
          body: { due_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() },
        })
      }
    }

    const res = await apiFetch('/api/tasks/bulk/snooze-overdue', {
      method: 'POST',
      body: { delta_minutes: 60 },
    })
    expect(res.status).toBe(200)
    const data = (await res.json()).data
    expect(data.tasks_affected).toBe(0)
  })

  test('POST returns correct response shape', async () => {
    const res = await apiFetch('/api/tasks/bulk/snooze-overdue', {
      method: 'POST',
      body: { delta_minutes: 60 },
    })
    expect(res.status).toBe(200)
    const data = (await res.json()).data

    // Should have the standard bulk snooze response fields
    expect(typeof data.tasks_affected).toBe('number')
    expect(typeof data.tasks_skipped).toBe('number')
    expect(typeof data.skipped_urgent).toBe('number')
  })

  test('POST snoozes overdue tasks and creates undo entry', async () => {
    // Make a task overdue by setting due_at to the past
    const pastTime = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    await apiFetch('/api/tasks/1', {
      method: 'PATCH',
      body: { due_at: pastTime, priority: 0 },
    })

    // Snooze overdue
    const res = await apiFetch('/api/tasks/bulk/snooze-overdue', {
      method: 'POST',
      body: { delta_minutes: 60 },
    })
    expect(res.status).toBe(200)
    const data = (await res.json()).data
    expect(data.tasks_affected).toBeGreaterThanOrEqual(1)

    // Verify the task got snoozed (due_at should now be in the future)
    const taskRes = await apiFetch('/api/tasks/1')
    const task = (await taskRes.json()).data
    expect(new Date(task.due_at).getTime()).toBeGreaterThan(Date.now() - 5000)

    // Verify undo works
    const undoRes = await apiFetch('/api/undo', { method: 'POST' })
    expect(undoRes.status).toBe(200)
  })
})
