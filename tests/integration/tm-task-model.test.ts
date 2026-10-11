/**
 * The 2026-10-10 task model over HTTP, with the OLD-CLIENT SAFETY checks the
 * native apps, Trent's Shortcuts and the desks depend on:
 * - `due_at` still reads and writes, and always equals `target_at`;
 * - POST /api/tasks/bulk/snooze-overdue keeps every response field it had
 *   (Shortcuts read them) and only adds `skipped_deadline`;
 * - GET /api/reminders keeps `groups` exactly as before and puts task rows in
 *   a separate top-level `task_segments`.
 * Plus the new paths: deadline cap (409 + override), segment endpoints.
 */
import { describe, test, expect, beforeAll } from 'vitest'
import { apiFetch, resetTestData } from './helpers'

const HOUR = 3600 * 1000
const iso = (ms: number) => new Date(Date.now() + ms).toISOString()

async function json(res: Response) {
  return (await res.json()) as { data: Record<string, unknown>; error?: string; code?: string }
}

async function create(body: Record<string, unknown>) {
  const res = await apiFetch('/api/tasks', { method: 'POST', body })
  expect(res.status).toBe(201)
  return (await json(res)).data
}

describe('Task model over HTTP', () => {
  beforeAll(async () => {
    await resetTestData()
  })

  test('due_at and target_at are the same field, written by either name', async () => {
    const a = await create({ title: 'tm alias a', due_at: iso(5 * HOUR) })
    expect(a.target_at).toBe(a.due_at)
    const b = await create({ title: 'tm alias b', target_at: iso(6 * HOUR) })
    expect(b.due_at).toBe(b.target_at)
    const patched = await json(
      await apiFetch(`/api/tasks/${b.id}`, { method: 'PATCH', body: { due_at: iso(7 * HOUR) } }),
    )
    expect(patched.data.target_at).toBe(patched.data.due_at)
    const conflict = await apiFetch(`/api/tasks/${b.id}`, {
      method: 'PATCH',
      body: { due_at: iso(8 * HOUR), target_at: iso(9 * HOUR) },
    })
    expect(conflict.status).toBe(400)
  })

  test('a snooze past a deadline still ahead is 409 PAST_DEADLINE until confirmed', async () => {
    const t = await create({ title: 'tm cap', due_at: iso(HOUR), deadline_at: iso(3 * HOUR) })
    const refused = await apiFetch(`/api/tasks/${t.id}/snooze`, {
      method: 'POST',
      body: { until: iso(24 * HOUR) },
    })
    expect(refused.status).toBe(409)
    expect((await json(refused)).code).toBe('PAST_DEADLINE')
    const ok = await apiFetch(`/api/tasks/${t.id}/snooze`, {
      method: 'POST',
      body: { until: iso(24 * HOUR), allow_past_deadline: true },
    })
    expect(ok.status).toBe(200)
  })

  test('snooze-overdue keeps every field old clients read, and adds skipped_deadline', async () => {
    await create({ title: 'tm overdue', due_at: iso(-2 * HOUR) })
    await create({
      title: 'tm overdue capped',
      due_at: iso(-2 * HOUR),
      deadline_at: iso(30 * 60 * 1000),
    })
    const res = await apiFetch('/api/tasks/bulk/snooze-overdue', {
      method: 'POST',
      body: { delta_minutes: 120, notify: false },
    })
    expect(res.status).toBe(200)
    const data = (await json(res)).data
    for (const key of [
      'tasks_affected',
      'tasks_skipped',
      'skipped_urgent',
      'skipped_high',
      'snoozed_high',
      'skipped_reminders',
      'until',
      'message',
      'feedback_notification',
    ]) {
      expect(data, key).toHaveProperty(key)
    }
    expect(data.skipped_deadline).toBeGreaterThanOrEqual(1)
    expect(String(data.message)).toContain('kept before')
  })

  test('reminders: groups unchanged in shape, task rows only in task_segments', async () => {
    const data = (await json(await apiFetch('/api/reminders'))).data
    expect(Array.isArray(data.groups)).toBe(true)
    expect(Array.isArray(data.task_segments)).toBe(true)
    for (const g of data.groups as Record<string, unknown>[]) {
      expect(Object.keys(g).sort()).toEqual(
        [
          'considered',
          'considered_items',
          'count',
          'prompts',
          'prompts_considered',
          'prompts_waiting',
          'reminders',
          'slot',
        ].sort(),
      )
      for (const r of g.reminders as Record<string, unknown>[]) expect(r.is_reminder).toBe(true)
    }
  })

  test('segment endpoints: consider, defer, target today', async () => {
    const t = await create({ title: 'tm seg', horizon: 'days' })
    const c = await apiFetch('/api/task-segments/consider', {
      method: 'POST',
      body: { ids: [t.id] },
    })
    expect((await json(c)).data.considered).toBe(1)
    const d = await apiFetch('/api/task-segments/defer', { method: 'POST', body: { ids: [t.id] } })
    expect((await json(d)).data.deferred).toBe(1)
    const tt = await apiFetch('/api/task-segments/target-today', {
      method: 'POST',
      body: { ids: [t.id] },
    })
    const body = (await json(tt)).data
    expect(body.affected).toBe(1)
    const after = (await json(await apiFetch(`/api/tasks/${t.id}`))).data
    expect(after.target_at).toBe(body.until)
    expect(after.original_due_at).toBe(body.until)
    expect(after.done).toBe(false)
    const refused = await apiFetch('/api/task-segments/consider', {
      method: 'POST',
      body: { ids: [999999] },
    })
    expect(refused.status).toBe(400)
  })

  test('horizon and deadline are create/update fields; a bad horizon is refused', async () => {
    const t = await create({ title: 'tm fields', horizon: 'months', deadline_at: iso(48 * HOUR) })
    expect(t.horizon).toBe('months')
    expect(t.deadline_at).toBeTruthy()
    const bad = await apiFetch(`/api/tasks/${t.id}`, { method: 'PATCH', body: { horizon: 'soon' } })
    expect(bad.status).toBe(400)
    const cleared = await json(
      await apiFetch(`/api/tasks/${t.id}`, {
        method: 'PATCH',
        body: { horizon: null, deadline_at: null },
      }),
    )
    expect(cleared.data.horizon).toBeNull()
    expect(cleared.data.deadline_at).toBeNull()
  })

  test('a quick snooze stops at the deadline and says so (ruling A3)', async () => {
    const deadline = iso(3 * HOUR)
    const a = await create({ title: 'tm cap single', due_at: iso(-HOUR), deadline_at: deadline })
    const patched = await json(
      await apiFetch(`/api/tasks/${a.id}`, {
        method: 'PATCH',
        body: { due_at: iso(24 * HOUR), cap_at_deadline: true },
      }),
    )
    expect(patched.data.due_at).toBe(new Date(deadline).toISOString())
    expect(patched.data.capped_at_deadline).toBe(true)
    expect(patched.data.deadline_nag_off).toBe(false)

    const b = await create({ title: 'tm cap bulk', due_at: iso(-HOUR), deadline_at: deadline })
    const bulk = await json(
      await apiFetch('/api/tasks/bulk/snooze', {
        method: 'POST',
        body: { ids: [b.id], until: iso(24 * HOUR), cap_at_deadline_ids: [b.id] },
      }),
    )
    expect(bulk.data.tasks_affected).toBe(1)
    expect(bulk.data.capped_deadline).toBe(1)
    expect(bulk.data.skipped_deadline).toBe(0)
  })
})
