/**
 * The 2026-10-10 task model over HTTP, with the OLD-CLIENT SAFETY checks the
 * native apps, Trent's Shortcuts and the desks depend on:
 * - `due_at` still reads and writes, and always equals `target_at`;
 * - POST /api/tasks/bulk/snooze-overdue keeps every response field it had
 *   (Shortcuts read them) and only adds `skipped_deadline` / `capped_deadline`;
 * - GET /api/reminders keeps `groups` exactly as before and puts task rows in
 *   a separate top-level `task_segments`.
 * Plus the new paths: the deadline cap (every move stops at it, §8.2), the
 * stored automatic target (§8.1/§8.3), segment endpoints.
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

  test("a snooze past a deadline stops AT it — never refused; old clients' override changes nothing (§8.2)", async () => {
    const deadline = iso(3 * HOUR)
    const t = await create({ title: 'tm cap', due_at: iso(HOUR), deadline_at: deadline })
    const capped = await apiFetch(`/api/tasks/${t.id}/snooze`, {
      method: 'POST',
      body: { until: iso(24 * HOUR) },
    })
    expect(capped.status).toBe(200)
    const body = (await json(capped)).data as {
      task: { due_at: string }
      capped_at_deadline: boolean
    }
    expect(body.capped_at_deadline).toBe(true)
    expect(Date.parse(body.task.due_at)).toBe(Date.parse(deadline))
    const old = await apiFetch(`/api/tasks/${t.id}/snooze`, {
      method: 'POST',
      body: { until: iso(24 * HOUR), allow_past_deadline: true },
    })
    expect(old.status).toBe(200)
    expect(Date.parse(((await json(old)).data as { task: { due_at: string } }).task.due_at)).toBe(
      Date.parse(deadline),
    )
  })

  test('once the deadline has passed, a single snooze or PATCH goes past it (ruling 2026-10-12)', async () => {
    const deadline = iso(-2 * HOUR)
    const t = await create({ title: 'tm passed', due_at: iso(-3 * HOUR), deadline_at: deadline })
    const until = iso(24 * HOUR)
    const snoozed = await apiFetch(`/api/tasks/${t.id}/snooze`, { method: 'POST', body: { until } })
    expect(snoozed.status).toBe(200)
    const body = (await json(snoozed)).data as {
      task: { due_at: string; deadline_at: string }
      capped_at_deadline: boolean
    }
    expect(body.capped_at_deadline).toBe(false)
    expect(Date.parse(body.task.due_at)).toBe(Date.parse(until))
    expect(Date.parse(body.task.deadline_at)).toBe(Date.parse(deadline))
    const later = iso(48 * HOUR)
    const patched = await json(
      await apiFetch(`/api/tasks/${t.id}`, { method: 'PATCH', body: { target_at: later } }),
    )
    expect(Date.parse(String(patched.data.target_at))).toBe(Date.parse(later))
    expect(patched.data.deadline_nag_off).toBe(true)
  })

  test('a deadline with no target stores the automatic one; clearing a picked target is Back to auto (§8)', async () => {
    const deadline = iso(10 * 24 * HOUR)
    const t = await create({ title: 'tm auto', deadline_at: deadline })
    expect(t.target_auto).toBe(true)
    expect(t.due_at).not.toBeNull()
    expect(Date.parse(String(t.due_at))).toBeLessThan(Date.parse(deadline))
    expect(t.deadline_nag_off).toBe(false)
    const picked = await json(
      await apiFetch(`/api/tasks/${t.id}`, { method: 'PATCH', body: { target_at: iso(5 * HOUR) } }),
    )
    expect(picked.data.target_auto).toBe(false)
    const back = await json(
      await apiFetch(`/api/tasks/${t.id}`, { method: 'PATCH', body: { target_at: null } }),
    )
    expect(back.data.target_auto).toBe(true)
    expect(back.data.due_at).toBe(t.due_at)
  })

  test('snooze-overdue keeps every field old clients read, and reports the deadline cap', async () => {
    await create({ title: 'tm overdue', due_at: iso(-2 * HOUR) })
    // Its deadline has passed: the High tier, so it waits while the ordinary
    // task above is in the batch (ruling 2026-10-12), and is named.
    await create({
      title: 'tm overdue capped',
      due_at: iso(-3 * HOUR),
      deadline_at: iso(-HOUR),
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
    expect(data).toHaveProperty('capped_deadline')
    expect(data.skipped_deadline).toBeGreaterThanOrEqual(1)
    expect(String(data.message)).toMatch(/\d+ past deadline/)
    expect(String(data.message)).toContain('skipped')
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
    const r = await apiFetch('/api/task-segments/restore', {
      method: 'POST',
      body: { ids: [t.id] },
    })
    expect((await json(r)).data.restored).toBe(1)
    const back = (await json(await apiFetch(`/api/tasks/${t.id}`))).data
    expect(back.last_considered_at).toBeNull()
    expect(back.segment_deferred_at).toBeNull()
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

  test('target-today stamps segment_targeted_at; `at` picks the moment; a bad `at` is a 400', async () => {
    const t = await create({ title: 'tm seg at', horizon: 'days' })
    expect(t.segment_targeted_at).toBeNull()
    // Plain Today stamps it, and every task read carries it.
    await apiFetch('/api/task-segments/target-today', { method: 'POST', body: { ids: [t.id] } })
    const first = (await json(await apiFetch(`/api/tasks/${t.id}`))).data
    expect(typeof first.segment_targeted_at).toBe('string')
    const listed = (await json(await apiFetch('/api/tasks?done=false&limit=1000'))).data
      .tasks as Array<Record<string, unknown>>
    expect(listed.find((x) => x.id === t.id)?.segment_targeted_at).toBe(first.segment_targeted_at)

    // `at`: the picked moment, normalised to UTC — two days out here.
    const at = iso(48 * HOUR)
    const res = await apiFetch('/api/task-segments/target-today', {
      method: 'POST',
      body: { ids: [t.id], at },
    })
    expect(res.status).toBe(200)
    const body = (await json(res)).data
    expect(body.until).toBe(new Date(at).toISOString())
    const after = (await json(await apiFetch(`/api/tasks/${t.id}`))).data
    expect(after.target_at).toBe(body.until)
    // A move keeps the first target (§6, 2026-10-12: no re-target split).
    expect(after.original_due_at).toBe(first.target_at)

    // Undo takes back the second targeting: the first target and stamp return.
    await apiFetch('/api/undo', { method: 'POST' })
    const undone = (await json(await apiFetch(`/api/tasks/${t.id}`))).data
    expect(undone.target_at).toBe(first.target_at)
    expect(undone.segment_targeted_at).toBe(first.segment_targeted_at)

    // A past day, or a string that isn't a date: refused, nothing written.
    for (const bad of [iso(-72 * HOUR), 'not a date']) {
      const r = await apiFetch('/api/task-segments/target-today', {
        method: 'POST',
        body: { ids: [t.id], at: bad },
      })
      expect(r.status).toBe(400)
    }
    expect((await json(await apiFetch(`/api/tasks/${t.id}`))).data.target_at).toBe(first.target_at)

    // Not a general "target changed" stamp: a PATCH of the target leaves it,
    // and it is server-only — a client can't write it in a body.
    const patched = await json(
      await apiFetch(`/api/tasks/${t.id}`, {
        method: 'PATCH',
        body: { due_at: iso(5 * HOUR), segment_targeted_at: '2020-01-01T00:00:00.000Z' },
      }),
    )
    expect(patched.data.segment_targeted_at).toBe(first.segment_targeted_at)
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

    // Under a far deadline it is an ordinary snooze, and says so.
    const far = await create({
      title: 'tm cap far',
      due_at: iso(-HOUR),
      deadline_at: iso(240 * HOUR),
    })
    const uncapped = await json(
      await apiFetch(`/api/tasks/${far.id}`, {
        method: 'PATCH',
        body: { due_at: iso(24 * HOUR), cap_at_deadline: true },
      }),
    )
    expect(uncapped.data.capped_at_deadline).toBe(false)

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
