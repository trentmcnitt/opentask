/**
 * The test-only server clock (2026-10-26; src/core/test-clock.ts,
 * POST /api/test/clock).
 *
 * The gate is tested here, on the handler itself, because the integration
 * server always runs with OPENTASK_TEST_MODE=1: with test mode off the route
 * must answer 404 — as if it did not exist — and change nothing.
 *
 * The offset is tested against a frozen real clock (`vi.setSystemTime`), so
 * "real now" doesn't move between the pin and the read: the shifted clock
 * reads exactly the pinned instant.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { DateTime } from 'luxon'
import { NextRequest } from 'next/server'
import { POST } from '@/app/api/test/clock/route'
import { setTestClock, testClockOffsetMs } from '@/core/test-clock'

const REAL = '2026-10-26T15:00:00.000Z'
const PINNED = '2026-10-26T06:30:00.000Z' // 01:30 in America/Chicago (CDT)

function post(body: unknown) {
  return POST(
    new NextRequest('http://localhost/api/test/clock', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    }),
  )
}

describe('the test-only server clock', () => {
  const savedMode = process.env.OPENTASK_TEST_MODE

  beforeEach(() => {
    vi.setSystemTime(new Date(REAL))
  })

  afterEach(() => {
    setTestClock(null)
    if (savedMode === undefined) delete process.env.OPENTASK_TEST_MODE
    else process.env.OPENTASK_TEST_MODE = savedMode
    vi.useRealTimers()
  })

  test('TC-01: with test mode off the route is a 404 and the clock is untouched', async () => {
    delete process.env.OPENTASK_TEST_MODE
    const res = await post({ now: PINNED })
    expect(res.status).toBe(404)
    expect(new Date().toISOString()).toBe(REAL)
    expect(testClockOffsetMs()).toBe(0)
    process.env.OPENTASK_TEST_MODE = '0'
    expect((await post({ now: PINNED })).status).toBe(404)
    expect(new Date().toISOString()).toBe(REAL)
  })

  test('TC-02: in test mode it pins Date, Date.now and Luxon; null puts the real clock back', async () => {
    process.env.OPENTASK_TEST_MODE = '1'
    const before = new Date()
    const res = await post({ now: PINNED })
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({
      now: PINNED,
      offset_ms: Date.parse(PINNED) - Date.parse(REAL),
    })
    expect(Date.now()).toBe(Date.parse(PINNED))
    expect(new Date().toISOString()).toBe(PINNED)
    expect(DateTime.now().setZone('America/Chicago').toFormat('yyyy-MM-dd HH:mm')).toBe(
      '2026-10-26 01:30',
    )
    // Dates with an argument, and dates made before the pin, are plain dates.
    expect(new Date(REAL).toISOString()).toBe(REAL)
    expect(before instanceof Date).toBe(true)
    expect(Date.parse(REAL)).toBe(new Date(REAL).getTime())

    const reset = await post({ now: null })
    expect((await reset.json()).data).toEqual({ now: REAL, offset_ms: 0 })
    expect(new Date().toISOString()).toBe(REAL)
  })

  test('TC-03: a bad body is a 400 and leaves the clock as it was', async () => {
    process.env.OPENTASK_TEST_MODE = '1'
    expect((await post({})).status).toBe(400)
    expect((await post({ now: 'tomorrow-ish' })).status).toBe(400)
    expect((await post({ now: 42 })).status).toBe(400)
    expect(new Date().toISOString()).toBe(REAL)
  })
})
