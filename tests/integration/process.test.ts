/**
 * GET /api/process (2026-10-10 task model, spec §5) and the writes Process
 * makes through existing endpoints: `affirm_horizon` on bulk edit, and the
 * remove-target bulk edit. The rules themselves are pinned in
 * tests/behavioral/pc-process.test.ts; this checks the HTTP shape.
 */
import { describe, test, expect, beforeAll } from 'vitest'
import path from 'path'
import Database from 'better-sqlite3'
import { DateTime } from 'luxon'
import { apiFetch, apiFetchB, apiAnon, resetTestData } from './helpers'

const DAY = 24 * 60 * 60 * 1000
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString()

interface ProcessBody {
  inbox_project_id: number | null
  inbox: { id: number; project_id: number }[]
  growth: {
    task: { id: number }
    from: string | null
    to: string
    days_on_horizon: number
    can_act: boolean
  }[]
  stale_targets: { task: { id: number; target_at: string | null }; attempts: number }[]
  stale_targets_with_deadline: { task: { id: number }; attempts: number }[]
}

async function create(body: Record<string, unknown>): Promise<number> {
  const res = await apiFetch('/api/tasks', { method: 'POST', body })
  expect(res.status).toBe(201)
  return (await res.json()).data.id
}

async function getProcess(): Promise<ProcessBody> {
  const res = await apiFetch('/api/process')
  expect(res.status).toBe(200)
  return (await res.json()).data
}

/**
 * The growth clock can't be set over the API; age the rows in the test DB —
 * and the targets with them (attempts never count before a target was set).
 */
function backdate(ids: number[], days: number) {
  const db = new Database(path.join(process.cwd(), 'data', 'test-integration.db'))
  try {
    const stmt = db.prepare(
      'UPDATE tasks SET created_at = ?, target_set_at = ?, horizon_set_at = NULL WHERE id = ?',
    )
    for (const id of ids) stmt.run(daysAgo(days), daysAgo(days), id)
  } finally {
    db.close()
  }
}

describe('GET /api/process', () => {
  let inboxTask: number
  let stale: number
  let staleUrgent: number
  let staleDeadline: number
  let oldUnset: number

  beforeAll(async () => {
    await resetTestData()
    inboxTask = await create({ title: 'Process inbox item', project_id: 1 })
    // Noon Chicago (user A's zone) ten local days ago, so the attempts (local
    // days over target, spec §7) are 11 at any hour, DST or not.
    const tenDaysAgoNoon = DateTime.now()
      .setZone('America/Chicago')
      .minus({ days: 10 })
      .set({ hour: 12, minute: 0 })
      .toUTC()
      .toISO()
    stale = await create({ title: 'Process stale', target_at: tenDaysAgoNoon, project_id: 2 })
    staleUrgent = await create({
      title: 'Process stale urgent',
      target_at: daysAgo(9),
      priority: 4,
      project_id: 2,
    })
    staleDeadline = await create({
      title: 'Process stale client',
      target_at: daysAgo(8),
      deadline_at: new Date(Date.now() + 2 * DAY).toISOString(),
      project_id: 2,
    })
    oldUnset = await create({ title: 'Process old unset', priority: 2, project_id: 2 })
    backdate([oldUnset], 61)
    // Written down (and targeted) a month ago: attempts never count from
    // before the task existed or its target was set. They have targets of
    // their own, so no growth ask either.
    backdate([stale, staleUrgent, staleDeadline], 30)
  })

  test('401 without auth', async () => {
    expect((await apiAnon('/api/process')).status).toBe(401)
  })

  test('lists the Inbox, the growth asks and the stale targets, deadline ones apart', async () => {
    const data = await getProcess()
    expect(data.inbox_project_id).toBe(1)
    expect(data.inbox.map((t) => t.id)).toContain(inboxTask)
    expect(data.inbox.every((t) => t.project_id === 1)).toBe(true)

    const ask = data.growth.find((g) => g.task.id === oldUnset)
    expect(ask).toMatchObject({ from: null, to: 'months', can_act: true })
    expect(ask!.days_on_horizon).toBeGreaterThanOrEqual(61)

    const staleIds = data.stale_targets.map((s) => s.task.id)
    expect(staleIds).toEqual(expect.arrayContaining([stale, staleUrgent]))
    expect(staleIds).not.toContain(staleDeadline)
    expect(data.stale_targets_with_deadline.map((s) => s.task.id)).toContain(staleDeadline)
    expect(data.stale_targets.find((s) => s.task.id === stale)!.attempts).toBe(11)
  })

  test("another user's tasks are never listed", async () => {
    const res = await apiFetchB('/api/process')
    expect(res.status).toBe(200)
    const data: ProcessBody = (await res.json()).data
    const ids = [
      ...data.inbox.map((t) => t.id),
      ...data.growth.map((g) => g.task.id),
      ...data.stale_targets.map((s) => s.task.id),
    ]
    expect(ids).not.toContain(inboxTask)
    expect(ids).not.toContain(stale)
    expect(ids).not.toContain(oldUnset)
  })

  test('affirm_horizon (keep) takes the task off the growth list', async () => {
    const res = await apiFetch('/api/tasks/bulk/edit', {
      method: 'POST',
      body: { ids: [oldUnset], changes: { affirm_horizon: true } },
    })
    expect(res.status).toBe(200)
    const task = (await (await apiFetch(`/api/tasks/${oldUnset}`)).json()).data
    expect(task.horizon).toBeNull()
    // Ruling Q7: a keep stamps growth_kept_at; the horizon's own clock stays.
    expect(task.growth_kept_at).not.toBeNull()
    expect(task.horizon_set_at).toBeNull()
    expect((await getProcess()).growth.some((g) => g.task.id === oldUnset)).toBe(false)
  })

  test('remove-target bulk edit clears the picks, Urgent included', async () => {
    const ids = [stale, staleUrgent]
    const res = await apiFetch('/api/tasks/bulk/edit', {
      method: 'POST',
      body: {
        ids,
        changes: { target_at: null, deadline_nag_off: true },
        include_task_ids: ids,
      },
    })
    expect(res.status).toBe(200)
    expect((await res.json()).data.tasks_affected).toBe(2)
    const data = await getProcess()
    expect(data.stale_targets.map((s) => s.task.id)).not.toContain(staleUrgent)
    expect(data.stale_targets.map((s) => s.task.id)).not.toContain(stale)
    expect(data.stale_targets_with_deadline.map((s) => s.task.id)).toContain(staleDeadline)
  })
})
