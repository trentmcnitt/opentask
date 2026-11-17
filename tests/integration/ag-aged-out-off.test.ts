/**
 * Aged out (2026-10-29, first pass — src/lib/aged-out.ts) is a dev-build
 * segment: without `NEXT_PUBLIC_AGED_OUT=1` (this server, like production)
 * its Keep endpoint does not exist and `?aged=1` changes nothing (Grow is
 * every build's since 2026-11-17: New rows have it). The segment's
 * own behaviour is in tests/behavioral/ag-aged-out.test.ts.
 */

import { describe, test, expect, beforeAll } from 'vitest'
import { apiFetch, resetTestData } from './helpers'

describe('Aged out off (a build without the flag)', () => {
  beforeAll(async () => {
    await resetTestData()
  })

  test('AG-I01: /api/task-segments/keep answers 404; Grow exists on every build (New rows, 2026-11-17)', async () => {
    const keep = await apiFetch('/api/task-segments/keep', { method: 'POST', body: { ids: [1] } })
    expect(keep.status).toBe(404)
    // Grow: a task of the caller's own, unset (read as Days), goes to Weeks,
    // considered once, New ended; ?new=1 is accepted and brings no `new` segment.
    const made = await (
      await apiFetch('/api/tasks', { method: 'POST', body: { title: 'Synthetic grow probe' } })
    ).json()
    const id = made.data.id as number
    const grow = await apiFetch('/api/task-segments/grow', { method: 'POST', body: { ids: [id] } })
    expect(grow.status).toBe(200)
    const task = (await (await apiFetch(`/api/tasks/${id}`)).json()).data
    expect([task.horizon, task.consider_count, task.new_ended_at !== null]).toEqual([
      'weeks',
      1,
      true,
    ])
    const asked = await (await apiFetch('/api/reminders?fill=1&new=1')).json()
    const kinds = asked.data.task_segments.map((s: { horizon: string }) => s.horizon)
    expect(kinds).not.toContain('new')
  })

  test('AG-I02: ?aged=1 brings no aged_out segment and changes nothing else', async () => {
    const base = '/api/reminders?queue=1&deck=1&handled=1&deadlines=1&fill=1'
    const plain = await (await apiFetch(base)).json()
    const aged = await (await apiFetch(`${base}&aged=1`)).json()
    const kinds = (body: { data: { task_segments: { horizon: string }[] } }) =>
      body.data.task_segments.map((s) => s.horizon)
    expect(kinds(aged)).not.toContain('aged_out')
    expect(kinds(aged)).toEqual(kinds(plain))
  })
})
