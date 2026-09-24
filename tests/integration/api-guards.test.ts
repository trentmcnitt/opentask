/**
 * API guard fixes (2026-09-24), over HTTP.
 *
 * - `done` on a quota needs `close_period` (single, bulk/done, bulk/complete)
 * - GET /api/tasks `kind` filter; `overdue=true` excludes reminders/quotas
 * - PATCH `{ rrule, due_at }` honors the date
 * - PATCH `{ due_at }` stays a snooze; `+ reset_original_due_at` reschedules
 * - PATCH `{ due_at }` on a dated reminder is refused
 */
import { describe, test, expect, beforeEach } from 'vitest'
import { DateTime } from 'luxon'
import { apiFetch, resetTestData } from './helpers'

async function create(body: Record<string, unknown>) {
  const res = await apiFetch('/api/tasks', { method: 'POST', body })
  expect(res.status).toBe(201)
  return (await res.json()).data
}

const hoursFromNow = (h: number) => DateTime.now().plus({ hours: h }).toUTC().toISO()!

describe('API guards', () => {
  beforeEach(async () => {
    await resetTestData()
  })

  test('POST /done on a quota is refused without close_period, and a bodyless done still works', async () => {
    const quota = await create({ title: 'Eggs', progress_target: 3, rrule: 'FREQ=WEEKLY' })
    await apiFetch(`/api/tasks/${quota.id}/progress`, { method: 'POST' })

    const refused = await apiFetch(`/api/tasks/${quota.id}/done`, { method: 'POST' })
    expect(refused.status).toBe(400)
    expect((await refused.json()).error).toMatch(/progress/)
    const kept = (await (await apiFetch(`/api/tasks/${quota.id}`)).json()).data
    expect(kept.progress_current).toBe(1)

    const closed = await apiFetch(`/api/tasks/${quota.id}/done`, {
      method: 'POST',
      body: { close_period: true },
    })
    expect(closed.status).toBe(200)

    // The existing no-body POST (web, iOS) keeps working on ordinary tasks.
    const plain = await create({ title: 'Plain' })
    const done = await apiFetch(`/api/tasks/${plain.id}/done`, { method: 'POST' })
    expect(done.status).toBe(200)
  })

  test('bulk/done and bulk/complete skip quotas, and refuse a quota-only batch', async () => {
    const quota = await create({ title: 'Eggs', progress_target: 3, rrule: 'FREQ=WEEKLY' })
    const plain = await create({ title: 'Plain' })

    const mixed = await apiFetch('/api/tasks/bulk/done', {
      method: 'POST',
      body: { ids: [quota.id, plain.id] },
    })
    expect(mixed.status).toBe(200)
    const body = (await mixed.json()).data
    expect(body.tasks_affected).toBe(1)
    expect(body.quota_skipped).toBe(1)

    const only = await apiFetch('/api/tasks/bulk/complete', {
      method: 'POST',
      body: { ids: [quota.id] },
    })
    expect(only.status).toBe(400)

    const optIn = await apiFetch('/api/tasks/bulk/complete', {
      method: 'POST',
      body: { ids: [quota.id], close_period: true },
    })
    expect(optIn.status).toBe(200)
    expect((await optIn.json()).data.tasks_affected).toBe(1)
  })

  test('GET /api/tasks?kind= narrows; invalid kind is a 400', async () => {
    const quota = await create({ title: 'Eggs', progress_target: 3, rrule: 'FREQ=WEEKLY' })
    const reminder = await create({ title: 'Stretch', is_reminder: true, rrule: 'FREQ=DAILY' })

    const quotas = (await (await apiFetch('/api/tasks?kind=quota')).json()).data.tasks
    expect(quotas.map((t: { id: number }) => t.id)).toEqual([quota.id])

    const reminders = (await (await apiFetch('/api/tasks?kind=reminder')).json()).data.tasks
    expect(reminders.map((t: { id: number }) => t.id)).toEqual([reminder.id])

    const tasks = (await (await apiFetch('/api/tasks?kind=task&limit=1000')).json()).data.tasks
    const taskIds = tasks.map((t: { id: number }) => t.id)
    expect(taskIds).not.toContain(quota.id)
    expect(taskIds).not.toContain(reminder.id)

    expect((await apiFetch('/api/tasks?kind=nope')).status).toBe(400)
  })

  test('GET /api/tasks?overdue=true excludes a past-due reminder', async () => {
    const past = hoursFromNow(-2)
    const task = await create({ title: 'Late task', due_at: past })
    const reminder = await create({
      title: 'Late reminder',
      is_reminder: true,
      rrule: 'FREQ=DAILY',
      due_at: past,
    })
    const overdue = (await (await apiFetch('/api/tasks?overdue=true&limit=1000')).json()).data.tasks
    const ids = overdue.map((t: { id: number }) => t.id)
    expect(ids).toContain(task.id)
    expect(ids).not.toContain(reminder.id)
  })

  test('PATCH { rrule, due_at } honors the date', async () => {
    const task = await create({ title: 'Water plants', due_at: hoursFromNow(5) })
    const when = DateTime.now()
      .setZone('America/Chicago')
      .plus({ days: 3 })
      .set({ hour: 18, minute: 30, second: 0, millisecond: 0 })
      .toUTC()
      .toISO()!
    const res = await apiFetch(`/api/tasks/${task.id}`, {
      method: 'PATCH',
      body: { rrule: 'FREQ=WEEKLY;BYDAY=MO', due_at: when },
    })
    expect(res.status).toBe(200)
    const after = (await res.json()).data
    expect(after.rrule).toBe('FREQ=WEEKLY;BYDAY=MO')
    expect(after.due_at).toBe(when)
    expect(after.fields_changed).toContain('due_at')
  })

  test('PATCH { due_at } snoozes; with reset_original_due_at it reschedules', async () => {
    const first = hoursFromNow(2)
    const task = await create({ title: 'Call the plumber', due_at: first })
    expect(task.is_snoozed).toBe(false)

    const snoozed = (
      await (
        await apiFetch(`/api/tasks/${task.id}`, {
          method: 'PATCH',
          body: { due_at: hoursFromNow(4) },
        })
      ).json()
    ).data
    expect(snoozed.is_snoozed).toBe(true)
    expect(snoozed.original_due_at).toBe(first)

    const picked = hoursFromNow(48)
    const rescheduled = (
      await (
        await apiFetch(`/api/tasks/${task.id}`, {
          method: 'PATCH',
          body: { due_at: picked, reset_original_due_at: true },
        })
      ).json()
    ).data
    expect(rescheduled.due_at).toBe(picked)
    expect(rescheduled.original_due_at).toBe(picked)
    expect(rescheduled.snooze_count).toBe(0)
    expect(rescheduled.is_snoozed).toBe(false)
  })

  test('PATCH { due_at } on a dated reminder is refused; an explicit reschedule is not', async () => {
    const reminder = await create({
      title: 'Stretch',
      is_reminder: true,
      rrule: 'FREQ=DAILY',
      due_at: hoursFromNow(1),
    })
    const refused = await apiFetch(`/api/tasks/${reminder.id}`, {
      method: 'PATCH',
      body: { due_at: hoursFromNow(3) },
    })
    expect(refused.status).toBe(400)
    expect((await refused.json()).error).toMatch(/Reminders cannot be snoozed/)

    const moved = await apiFetch(`/api/tasks/${reminder.id}`, {
      method: 'PATCH',
      body: { due_at: hoursFromNow(3), reset_original_due_at: true },
    })
    expect(moved.status).toBe(200)

    const skip = await apiFetch(`/api/tasks/${reminder.id}/skip-occurrence`, { method: 'POST' })
    expect(skip.status).toBe(400)
  })
})
