/**
 * Bulk Snooze Overdue Integration Tests
 *
 * Tests the POST /api/tasks/bulk/snooze-overdue endpoint.
 * This endpoint queries overdue tasks server-side (no task IDs needed from client).
 */

import { describe, test, expect, beforeEach } from 'vitest'
import { DateTime } from 'luxon'
import {
  apiFetch,
  apiAnon,
  resetTestData,
  baseUrl,
  sessionCookieFromToken,
  TOKEN_A,
} from './helpers'

/** Make task 1 overdue, so the bulk snooze has something to move. */
async function makeOverdue() {
  await apiFetch('/api/tasks/1', {
    method: 'PATCH',
    body: { due_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(), priority: 0 },
  })
}

/** Task 1's due time as Chicago wall-clock "HH:mm" (the test user's zone). */
async function dueLocal(): Promise<{ hhmm: string; ms: number }> {
  const task = (await (await apiFetch('/api/tasks/1')).json()).data
  const due = DateTime.fromISO(task.due_at).setZone('America/Chicago')
  return { hhmm: due.toFormat('HH:mm'), ms: due.toMillis() }
}

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
    // Same shape as the non-empty path, and a displayable message for
    // branchless clients (Apple Shortcuts).
    expect(data.skipped_reminders).toBe(0)
    expect(data.message).toBe('No snoozable tasks')
    expect(typeof data.until).toBe('string')
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
    expect(data.message).toMatch(/^Snoozed \d+ /)
    expect(new Date(data.until).getTime()).toBeGreaterThan(Date.now())

    // Verify the task got snoozed (due_at should now be in the future)
    const taskRes = await apiFetch('/api/tasks/1')
    const task = (await taskRes.json()).data
    expect(new Date(task.due_at).getTime()).toBeGreaterThan(Date.now() - 5000)

    // Verify undo works
    const undoRes = await apiFetch('/api/undo', { method: 'POST' })
    expect(undoRes.status).toBe(200)
  })

  test('POST with a slot snoozes to that slot’s next start, in the user’s timezone', async () => {
    await makeOverdue()
    const res = await apiFetch('/api/tasks/bulk/snooze-overdue', {
      method: 'POST',
      body: { slot: '07:00' },
    })
    expect(res.status).toBe(200)
    expect((await res.json()).data.tasks_affected).toBeGreaterThanOrEqual(1)
    // Time-agnostic: whenever this runs, the next 7:00 in Chicago is ahead of
    // now and less than a day away.
    const due = await dueLocal()
    expect(due.hhmm).toBe('07:00')
    expect(due.ms).toBeGreaterThan(Date.now())
    expect(due.ms - Date.now()).toBeLessThanOrEqual(24 * 60 * 60 * 1000)
  })

  test('POST with slot "next" snoozes to the soonest upcoming slot start', async () => {
    const slots = (await (await apiFetch('/api/time-slots')).json()).data.time_slots as {
      start_time: string
    }[]
    expect(slots.length).toBeGreaterThan(0)
    await makeOverdue()
    const res = await apiFetch('/api/tasks/bulk/snooze-overdue', {
      method: 'POST',
      body: { slot: 'next' },
    })
    expect(res.status).toBe(200)
    const due = await dueLocal()
    expect(slots.map((s) => s.start_time)).toContain(due.hhmm)
    // No slot starts between now and the chosen one.
    const now = DateTime.now().setZone('America/Chicago')
    const upcoming = slots.map((s) => {
      const [h, m] = s.start_time.split(':').map(Number)
      const today = now.set({ hour: h, minute: m, second: 0, millisecond: 0 })
      return (today > now ? today : today.plus({ days: 1 })).toMillis()
    })
    expect(due.ms).toBe(Math.min(...upcoming))
  })

  test('POST with tomorrow: true snoozes to tomorrow at the user’s morning time', async () => {
    const prefs = (await (await apiFetch('/api/user/preferences')).json()).data
    await makeOverdue()
    const res = await apiFetch('/api/tasks/bulk/snooze-overdue', {
      method: 'POST',
      body: { tomorrow: true },
    })
    expect(res.status).toBe(200)
    expect((await res.json()).data.tasks_affected).toBeGreaterThanOrEqual(1)
    const due = await dueLocal()
    expect(due.hhmm).toBe(prefs.morning_time)
    const tomorrow = DateTime.now().setZone('America/Chicago').plus({ days: 1 }).toISODate()
    expect(DateTime.fromMillis(due.ms).setZone('America/Chicago').toISODate()).toBe(tomorrow)
  })

  test('POST rejects tomorrow combined with another target', async () => {
    const res = await apiFetch('/api/tasks/bulk/snooze-overdue', {
      method: 'POST',
      body: { tomorrow: true, delta_minutes: 60 },
    })
    expect(res.status).toBe(400)
  })

  test('POST rejects a malformed slot, and a slot combined with until', async () => {
    const bad = await apiFetch('/api/tasks/bulk/snooze-overdue', {
      method: 'POST',
      body: { slot: 'noon' },
    })
    expect(bad.status).toBe(400)
    const both = await apiFetch('/api/tasks/bulk/snooze-overdue', {
      method: 'POST',
      body: { slot: '07:00', until: new Date(Date.now() + 3600_000).toISOString() },
    })
    expect(both.status).toBe(400)
  })
})

/**
 * The feedback push after a sweep that left High or Urgent overdue
 * (src/core/notifications/sweep-feedback.ts). Delivery can't be observed here
 * (no APNs or VAPID in the test server), so these read the response's
 * `feedback_notification` — whether this call decided to send one.
 */
describe('Bulk snooze-overdue feedback notification', () => {
  const PATH = '/api/tasks/bulk/snooze-overdue'
  const hourAgo = () => new Date(Date.now() - 60 * 60 * 1000).toISOString()

  /**
   * Push every dated task a day out, then make the first two open,
   * non-reminder tasks overdue at the given priorities — so what the sweep
   * sees is exactly those two.
   */
  async function overdueAt(priorities: number[]): Promise<void> {
    const tasks = (await (await apiFetch('/api/tasks')).json()).data.tasks as {
      id: number
      due_at: string | null
      is_reminder: boolean
      progress_target: number
      is_tracked: boolean
    }[]
    for (const task of tasks) {
      if (task.due_at) {
        await apiFetch(`/api/tasks/${task.id}`, {
          method: 'PATCH',
          body: { due_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() },
        })
      }
    }
    const plain = tasks.filter((t) => !t.is_reminder && !t.is_tracked && t.progress_target <= 1)
    expect(plain.length).toBeGreaterThanOrEqual(priorities.length)
    for (const [i, priority] of priorities.entries()) {
      await apiFetch(`/api/tasks/${plain[i].id}`, {
        method: 'PATCH',
        body: { due_at: hourAgo(), priority },
      })
    }
  }

  async function sweep(body: Record<string, unknown> = { delta_minutes: 60 }) {
    const res = await apiFetch(PATH, { method: 'POST', body })
    expect(res.status).toBe(200)
    return (await res.json()).data
  }

  beforeEach(async () => {
    await resetTestData()
  })

  test('Bearer token, Urgent left behind: sent', async () => {
    await overdueAt([0, 4])
    const data = await sweep()
    expect(data.tasks_affected).toBe(1)
    expect(data.skipped_urgent - data.skipped_high).toBe(1)
    expect(data.feedback_notification).toBe(true)
  })

  test('Bearer token, High left after the first press: sent', async () => {
    await overdueAt([0, 3])
    const data = await sweep()
    expect(data.skipped_high).toBe(1)
    expect(data.feedback_notification).toBe(true)
  })

  test('nothing left behind: not sent', async () => {
    await overdueAt([0, 2])
    const data = await sweep()
    expect(data.tasks_affected).toBe(2)
    expect(data.feedback_notification).toBe(false)
  })

  test('notify: false: not sent', async () => {
    await overdueAt([0, 4])
    const data = await sweep({ delta_minutes: 60, notify: false })
    expect(data.tasks_affected).toBe(1)
    expect(data.feedback_notification).toBe(false)
  })

  test('notify must be a boolean', async () => {
    const res = await apiFetch(PATH, { method: 'POST', body: { notify: 'no' } })
    expect(res.status).toBe(400)
  })

  test('the setting off: not sent', async () => {
    await overdueAt([4])
    const off = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { sweep_feedback_notifications_enabled: false },
    })
    expect(off.status).toBe(200)
    try {
      expect((await sweep()).feedback_notification).toBe(false)
    } finally {
      await apiFetch('/api/user/preferences', {
        method: 'PATCH',
        body: { sweep_feedback_notifications_enabled: true },
      })
    }
  })

  test('session cookie (the web UI, which shows a toast): not sent', async () => {
    await overdueAt([0, 4])
    const cookie = await sessionCookieFromToken(TOKEN_A)
    const res = await fetch(`${baseUrl()}${PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ delta_minutes: 60 }),
    })
    expect(res.status).toBe(200)
    const data = (await res.json()).data
    expect(data.tasks_affected).toBe(1)
    expect(data.feedback_notification).toBe(false)
  })
})
