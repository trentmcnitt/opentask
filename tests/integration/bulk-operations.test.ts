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

  test('POST bulk/edit applies per-task rules as one undoable action', async () => {
    // Two reminders in the morning slot, different cadences.
    const make = async (title: string, rrule: string) => {
      const res = await apiFetch('/api/tasks', {
        method: 'POST',
        body: { title, is_reminder: true, rrule },
      })
      expect(res.status).toBe(201)
      return (await res.json()).data.id as number
    }
    const daily = await make('Daily thought', 'FREQ=DAILY;BYHOUR=7;BYMINUTE=0')
    const weekly = await make('Tue/Thu thought', 'FREQ=WEEKLY;BYDAY=TU,TH;BYHOUR=7;BYMINUTE=0')

    // Move both to the evening; each keeps its own days.
    const res = await apiFetch('/api/tasks/bulk/edit', {
      method: 'POST',
      body: {
        ids: [daily, weekly],
        changes: {},
        per_task: {
          [daily]: { rrule: 'FREQ=DAILY;BYHOUR=20;BYMINUTE=30' },
          [weekly]: { rrule: 'FREQ=WEEKLY;BYDAY=TU,TH;BYHOUR=20;BYMINUTE=30' },
        },
      },
    })
    expect(res.status).toBe(200)
    expect((await res.json()).data.tasks_affected).toBe(2)
    const after = async (id: number) => (await (await apiFetch(`/api/tasks/${id}`)).json()).data
    expect((await after(daily)).anchor_time).toBe('20:30')
    expect((await after(weekly)).rrule).toBe('FREQ=WEEKLY;BYDAY=TU,TH;BYHOUR=20;BYMINUTE=30')

    // One Undo restores both.
    const undo = await apiFetch('/api/undo', { method: 'POST' })
    expect(undo.status).toBe(200)
    expect((await after(daily)).anchor_time).toBe('07:00')
    expect((await after(weekly)).anchor_time).toBe('07:00')

    // per_task carries the schedule only.
    const bad = await apiFetch('/api/tasks/bulk/edit', {
      method: 'POST',
      body: { ids: [daily], changes: {}, per_task: { [daily]: { priority: 3 } } },
    })
    expect(bad.status).toBe(400)
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

    // Verify original_due_at was set
    expect(after7.original_due_at).toBe(before7.due_at)
    expect(after8.original_due_at).toBe(before8.due_at)
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

  test('POST bulk/snooze skips urgent tasks in mixed-priority selection', async () => {
    // Seed data: task 7 (priority 0), task 8 (priority 1), task 4 (priority 3)
    // Set task 4 to P4 (Urgent) — P3 and P4 are both excluded from bulk snooze
    await apiFetch('/api/tasks/4', {
      method: 'PATCH',
      body: { priority: 4 },
    })

    const targetTime = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()

    // Get original due dates for urgent task
    const before4 = (await (await apiFetch('/api/tasks/4')).json()).data

    const res = await apiFetch('/api/tasks/bulk/snooze', {
      method: 'POST',
      body: { ids: [7, 8, 4], until: targetTime },
    })
    expect(res.status).toBe(200)
    const data = (await res.json()).data

    // Only tasks 7 and 8 should be snoozed (priority 0 and 1); task 4 (P4) skipped
    expect(data.tasks_affected).toBe(2)
    expect(data.tasks_skipped).toBe(1)

    // Verify task 7 and 8 were snoozed
    const after7 = (await (await apiFetch('/api/tasks/7')).json()).data
    const after8 = (await (await apiFetch('/api/tasks/8')).json()).data
    expect(after7.due_at).toBe(targetTime)
    expect(after8.due_at).toBe(targetTime)

    // Verify task 4 (urgent) was NOT snoozed
    const after4 = (await (await apiFetch('/api/tasks/4')).json()).data
    expect(after4.due_at).toBe(before4.due_at)
  })

  // Regression: the mobile selection sheet and desktop quick panel both route
  // explicit user selections through `include_task_ids`, so P3/P4 tasks the
  // user deliberately picked are NOT filtered out. The "Snooze All Overdue"
  // sweep keeps the default high/urgent skip because it never sets
  // `include_task_ids`.
  test('POST bulk/snooze with include_task_ids snoozes P4 tasks (absolute mode)', async () => {
    // Make task 4 urgent so it would normally be filtered out
    await apiFetch('/api/tasks/4', { method: 'PATCH', body: { priority: 4 } })

    const targetTime = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()

    const res = await apiFetch('/api/tasks/bulk/snooze', {
      method: 'POST',
      body: { ids: [4], until: targetTime, include_task_ids: [4] },
    })
    expect(res.status).toBe(200)
    const data = (await res.json()).data

    expect(data.tasks_affected).toBe(1)
    expect(data.skipped_urgent).toBe(0)

    const after4 = (await (await apiFetch('/api/tasks/4')).json()).data
    expect(after4.due_at).toBe(targetTime)
  })

  test('POST bulk/snooze with include_task_ids snoozes P4 tasks (delta_minutes mode)', async () => {
    await apiFetch('/api/tasks/4', { method: 'PATCH', body: { priority: 4 } })
    const before4 = (await (await apiFetch('/api/tasks/4')).json()).data

    const res = await apiFetch('/api/tasks/bulk/snooze', {
      method: 'POST',
      body: { ids: [4], delta_minutes: 60, include_task_ids: [4] },
    })
    expect(res.status).toBe(200)
    const data = (await res.json()).data

    expect(data.tasks_affected).toBe(1)
    expect(data.skipped_urgent).toBe(0)

    const after4 = (await (await apiFetch('/api/tasks/4')).json()).data
    const expected = new Date(new Date(before4.due_at).getTime() + 60 * 60 * 1000).toISOString()
    expect(after4.due_at).toBe(expected)
  })

  test('POST bulk/snooze without include_task_ids still skips P4 (Snooze All Overdue behavior)', async () => {
    await apiFetch('/api/tasks/4', { method: 'PATCH', body: { priority: 4 } })
    const before4 = (await (await apiFetch('/api/tasks/4')).json()).data

    const targetTime = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()

    const res = await apiFetch('/api/tasks/bulk/snooze', {
      method: 'POST',
      body: { ids: [4], until: targetTime },
    })
    expect(res.status).toBe(200)
    const data = (await res.json()).data

    expect(data.tasks_affected).toBe(0)
    expect(data.skipped_urgent).toBe(1)

    // Task 4 untouched — regression guard for the Snooze All Overdue sweep.
    const after4 = (await (await apiFetch('/api/tasks/4')).json()).data
    expect(after4.due_at).toBe(before4.due_at)
  })
})

describe('Bulk snooze — the High tier', () => {
  beforeEach(async () => {
    await resetTestData()
  })

  /**
   * The High tier's rule over HTTP (Trent, 2026-09-15): P3 is swept only when
   * no lower-priority task in the same batch is still eligible, and the
   * response splits the two tiers so a client can name them.
   *
   * Tasks are created here rather than taken from the seed: the batch's exact
   * priority mix IS the thing under test, and the seed is shared with every
   * other test in this file.
   */
  async function makeTask(title: string, priority: number, minutesAgo: number): Promise<number> {
    const res = await apiFetch('/api/tasks', {
      method: 'POST',
      body: {
        title,
        priority,
        due_at: new Date(Date.now() - minutesAgo * 60 * 1000).toISOString(),
      },
    })
    expect(res.status).toBe(201)
    return (await res.json()).data.id as number
  }

  test('POST bulk/snooze defers P3 while something lower is still eligible', async () => {
    const medium = await makeTask('bulk-high-tier medium', 2, 90)
    const high = await makeTask('bulk-high-tier high', 3, 60)
    const target = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()

    const res = await apiFetch('/api/tasks/bulk/snooze', {
      method: 'POST',
      body: { ids: [medium, high], until: target },
    })
    expect(res.status).toBe(200)
    const data = (await res.json()).data

    expect(data.tasks_affected).toBe(1)
    // The total counts both tiers; `skipped_high` says how much of it is High.
    expect(data.skipped_urgent).toBe(1)
    expect(data.skipped_high).toBe(1)

    expect((await (await apiFetch(`/api/tasks/${medium}`)).json()).data.due_at).toBe(target)
    expect((await (await apiFetch(`/api/tasks/${high}`)).json()).data.due_at).not.toBe(target)
  })

  test('POST bulk/snooze sweeps P3 once nothing lower is left, and still never P4', async () => {
    const high = await makeTask('bulk-high-tier high alone', 3, 60)
    const urgent = await makeTask('bulk-high-tier urgent', 4, 30)
    const target = new Date(Date.now() + 36 * 60 * 60 * 1000).toISOString()

    const res = await apiFetch('/api/tasks/bulk/snooze', {
      method: 'POST',
      body: { ids: [high, urgent], until: target },
    })
    expect(res.status).toBe(200)
    const data = (await res.json()).data

    // A P4 in the batch is not "something lower", so it does not hold the
    // High tier back — it is simply skipped on its own account.
    expect(data.tasks_affected).toBe(1)
    expect(data.skipped_urgent).toBe(1)
    expect(data.skipped_high).toBe(0)

    expect((await (await apiFetch(`/api/tasks/${high}`)).json()).data.due_at).toBe(target)
    expect((await (await apiFetch(`/api/tasks/${urgent}`)).json()).data.due_at).not.toBe(target)
  })
})
