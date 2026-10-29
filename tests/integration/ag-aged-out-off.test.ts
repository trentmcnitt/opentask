/**
 * Aged out (2026-10-29, first pass — src/lib/aged-out.ts) is a dev-build
 * segment: without `NEXT_PUBLIC_AGED_OUT=1` (this server, like production)
 * its two endpoints do not exist and `?aged=1` changes nothing. The segment's
 * own behaviour is in tests/behavioral/ag-aged-out.test.ts.
 */

import { describe, test, expect, beforeAll } from 'vitest'
import { apiFetch, resetTestData } from './helpers'

describe('Aged out off (a build without the flag)', () => {
  beforeAll(async () => {
    await resetTestData()
  })

  test('AG-I01: /api/task-segments/grow and /keep answer 404', async () => {
    for (const path of ['/api/task-segments/grow', '/api/task-segments/keep']) {
      const res = await apiFetch(path, { method: 'POST', body: { ids: [1] } })
      expect(res.status).toBe(404)
    }
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
