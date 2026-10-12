/**
 * Upcoming over HTTP (2026-10-12, docs/TASK-MODEL.md § Upcoming): the
 * `task_segments` entry with `horizon: "upcoming"`, the `recurring` flag on
 * every segment row, `target_set_at` on a task, target-today on a repeating
 * task (its target moves, its occurrence stays — §6), Remove target sending a
 * task back to its horizon segment, and `check_in_day`.
 *
 * The integration server runs on the real clock, and a heads-up day is always
 * after the day the target was set, so `target_set_at` is backdated in the
 * test DB (the API stamps every write with now).
 */
import path from 'path'
import Database from 'better-sqlite3'
import { DateTime } from 'luxon'
import { describe, test, expect, beforeAll } from 'vitest'
import { apiFetch, resetTestData } from './helpers'

// User A's zone (scripts/seed-test.ts).
const TZ = 'America/Chicago'

async function json(res: Response) {
  return (await res.json()) as { data: Record<string, unknown>; error?: string }
}

async function create(body: Record<string, unknown>) {
  const res = await apiFetch('/api/tasks', { method: 'POST', body })
  expect(res.status).toBe(201)
  return (await json(res)).data as { id: number; target_set_at: string | null }
}

function backdateTargetSet(ids: number[], days: number) {
  const db = new Database(path.join(process.cwd(), 'data', 'test-integration.db'))
  try {
    const when = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString()
    const stmt = db.prepare('UPDATE tasks SET target_set_at = ? WHERE id = ?')
    for (const id of ids) stmt.run(when, id)
  } finally {
    db.close()
  }
}

interface Row {
  id: number
  segment_state: string
  recurring: boolean
  target_set_at: string | null
}
interface Segment {
  horizon: string
  tasks: Row[]
}

async function segments(): Promise<Segment[]> {
  const res = await apiFetch('/api/reminders')
  expect(res.status).toBe(200)
  return (await json(res)).data.task_segments as Segment[]
}

async function placeOf(id: number): Promise<string | null> {
  for (const seg of await segments()) if (seg.tasks.some((t) => t.id === id)) return seg.horizon
  return null
}

const tomorrow9 = () =>
  DateTime.now().setZone(TZ).plus({ days: 1 }).set({ hour: 9, minute: 0 }).toUTC().toISO()!

describe('Upcoming over HTTP', () => {
  let oneOff: number
  let repeating: number

  beforeAll(async () => {
    await resetTestData()
    oneOff = (await create({ title: 'up one-off', target_at: tomorrow9(), horizon: 'days' })).id
    repeating = (
      await create({
        title: 'up repeating',
        rrule: 'FREQ=DAILY;INTERVAL=3;BYHOUR=9;BYMINUTE=0',
        target_at: tomorrow9(),
      })
    ).id
    backdateTargetSet([oneOff, repeating], 10)
  })

  test('a task carries target_set_at, stamped when made', async () => {
    const t = await create({ title: 'up stamped', target_at: tomorrow9() })
    expect(typeof t.target_set_at).toBe('string')
    expect(Math.abs(Date.parse(t.target_set_at!) - Date.now())).toBeLessThan(60_000)
  })

  test('GET /api/reminders lists both in an `upcoming` segment, after days, with `recurring`', async () => {
    const segs = await segments()
    const kinds = segs.map((s) => s.horizon)
    expect(kinds).toContain('upcoming')
    const up = segs.find((s) => s.horizon === 'upcoming')!
    const byId = new Map(up.tasks.map((t) => [t.id, t]))
    expect(byId.get(oneOff)?.recurring).toBe(false)
    expect(byId.get(repeating)?.recurring).toBe(true)
    expect(byId.get(oneOff)?.segment_state).toBe('waiting')
    // Every segment row says whether it repeats.
    for (const seg of segs)
      for (const row of seg.tasks) expect(typeof row.recurring).toBe('boolean')
    // Upcoming comes before weeks/months/eventually, after days.
    const order = ['days', 'upcoming', 'weeks', 'months', 'eventually']
    expect([...kinds].sort((a, b) => order.indexOf(a) - order.indexOf(b))).toEqual(kinds)
  })

  test("target-today moves a repeating task's target, never its occurrence (§6); Undo puts it back", async () => {
    const before = (await json(await apiFetch(`/api/tasks/${repeating}`))).data
    expect(before.occurrence_at).toBe(before.target_at)
    const later = DateTime.fromISO(tomorrow9()).plus({ hours: 5 }).toUTC().toISO()!
    const res = await apiFetch('/api/task-segments/target-today', {
      method: 'POST',
      body: { ids: [repeating], at: later },
    })
    expect(res.status).toBe(200)
    // `skipped_recurring` stays in the response, always empty, for old clients.
    expect((await json(res)).data).toMatchObject({ affected: 1, skipped_recurring: [] })
    const after = (await json(await apiFetch(`/api/tasks/${repeating}`))).data
    expect(Date.parse(String(after.target_at))).toBe(Date.parse(later))
    expect(after.occurrence_at).toBe(before.occurrence_at)
    expect((await apiFetch('/api/undo', { method: 'POST' })).status).toBe(200)
    const restored = (await json(await apiFetch(`/api/tasks/${repeating}`))).data
    expect(restored.target_at).toBe(before.target_at)
    backdateTargetSet([repeating], 10)
    expect(await placeOf(repeating)).toBe('upcoming')
  })

  test('Remove target sends the one-off back to its horizon segment; Undo brings it back', async () => {
    const before = (await json(await apiFetch(`/api/tasks/${oneOff}`))).data
    const res = await apiFetch(`/api/tasks/${oneOff}`, {
      method: 'PATCH',
      body: { target_at: null },
    })
    expect(res.status).toBe(200)
    expect(await placeOf(oneOff)).toBe('days')
    const undo = await apiFetch('/api/undo', { method: 'POST' })
    expect(undo.status).toBe(200)
    const after = (await json(await apiFetch(`/api/tasks/${oneOff}`))).data
    expect(after.target_at).toBe(before.target_at)
    expect(after.target_set_at).toBe(before.target_set_at)
    expect(await placeOf(oneOff)).toBe('upcoming')
  })

  test('PATCH check_in_day: 1–7 only; GET returns it', async () => {
    const ok = await apiFetch('/api/user/preferences', {
      method: 'PATCH',
      body: { check_in_day: 2 },
    })
    expect(ok.status).toBe(200)
    expect((await json(ok)).data.check_in_day).toBe(2)
    for (const bad of [0, 8, 2.5, 'tuesday', null]) {
      const res = await apiFetch('/api/user/preferences', {
        method: 'PATCH',
        body: { check_in_day: bad },
      })
      expect(res.status).toBe(400)
    }
    await apiFetch('/api/user/preferences', { method: 'PATCH', body: { check_in_day: 6 } })
  })
})
