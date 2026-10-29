/**
 * AGED OUT (2026-10-29, first pass — src/lib/aged-out.ts, docs/TASK-MODEL.md
 * § Aged out): the tasks Process's growth ask would ask about, reviewed in
 * the task queue. Weekly on the check-in day (Saturday here, the default),
 * carried over daily until handled; never also in the task's horizon
 * segment; Grow (one step out) and Keep (Process's keep, counted) both go
 * through undo and leave the row considered for the day.
 */

import { describe, test, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { DateTime } from 'luxon'

vi.mock('@/core/notifications/dismiss', () => ({
  dismissNotificationsForTasks: vi.fn(),
  syncBadgeCount: vi.fn(),
}))
vi.mock('@/core/webhooks/dispatch', () => ({ dispatchWebhookEvent: vi.fn() }))
vi.mock('@/lib/sync-events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/sync-events')>()
  return { ...actual, emitSyncEvent: vi.fn() }
})

import { createTask, updateTask } from '@/core/tasks'
import { getTaskById } from '@/core/tasks/read'
import { getTaskSegments, growTasks, keepTasks } from '@/core/tasks/task-segments'
import { undoLatest } from '@/core/undo/execute-undo'
import { agedClockRestart, ageWords, growStep } from '@/lib/aged-out'
import type { HorizonValue } from '@/lib/task-segments'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

const tz = TEST_TIMEZONE
const at = (iso: string) => DateTime.fromISO(iso, { zone: tz }).toJSDate()
// Saturday Oct 24 2026 is a check-in day (the default, 6); Wednesday Oct 28 is not.
const SAT = at('2026-10-24T10:00')
const WED = at('2026-10-28T10:00')
const NEXT_SAT = at('2026-10-31T10:00')

function make(title: string, horizon: HorizonValue | null, createdAt: Date, extra = {}): number {
  vi.setSystemTime(createdAt)
  return createTask({
    userId: TEST_USER_ID,
    userTimezone: tz,
    input: { title, ...(horizon ? { horizon } : {}), ...extra },
  }).id
}

/** Where each task is on `now`: segment kind and row state. */
function placeOf(now: Date, agedOut = true): Map<number, string> {
  vi.setSystemTime(now)
  const out = new Map<number, string>()
  for (const seg of getTaskSegments(TEST_USER_ID, tz, now, { agedOut })) {
    for (const row of seg.tasks) out.set(row.task.id, `${seg.horizon}:${row.state}`)
  }
  return out
}

describe('AG: growStep', () => {
  test('AG-001: one step out; unset counts as Weeks; Eventually has nowhere to go', () => {
    expect(growStep('days')).toBe('weeks')
    expect(growStep('weeks')).toBe('months')
    expect(growStep(null)).toBe('months')
    expect(growStep('months')).toBe('eventually')
    expect(growStep('eventually')).toBeNull()
  })
})

describe('AG: what restarted the age clock (the row says why it is here)', () => {
  const made = '2026-08-01T15:00:00.000Z'
  type Clock = Parameters<typeof agedClockRestart>[0]
  const base: Clock = {
    created_at: made,
    horizon: 'weeks',
    horizon_set_at: made,
    growth_kept_at: null,
  }
  const restart = (t: Partial<Clock>) => agedClockRestart({ ...base, ...t }, tz, '03:00')

  test('AG-030: from creation (a horizon set the day it was made included) → nothing', () => {
    expect(restart({})).toBeNull()
    expect(restart({ horizon_set_at: '2026-08-01T20:00:00.000Z' })).toBeNull()
    expect(restart({ horizon: null, horizon_set_at: null })).toBeNull()
  })

  test('AG-031: a horizon set later → "set", a later keep → "kept"', () => {
    expect(restart({ horizon_set_at: '2026-09-03T15:00:00.000Z' })).toEqual({
      kind: 'set',
      at: '2026-09-03T15:00:00.000Z',
    })
    expect(
      restart({
        horizon_set_at: '2026-09-03T15:00:00.000Z',
        growth_kept_at: '2026-09-20T15:00:00.000Z',
      }),
    ).toEqual({ kind: 'kept', at: '2026-09-20T15:00:00.000Z' })
    // A horizon set after the keep wins (it restarted the clock again).
    expect(
      restart({
        horizon_set_at: '2026-09-25T15:00:00.000Z',
        growth_kept_at: '2026-09-20T15:00:00.000Z',
      }),
    ).toEqual({ kind: 'set', at: '2026-09-25T15:00:00.000Z' })
    // Unset (no horizon of its own): only a keep can restart it.
    expect(
      restart({
        horizon: null,
        horizon_set_at: null,
        growth_kept_at: '2026-09-12T15:00:00.000Z',
      }),
    ).toEqual({ kind: 'kept', at: '2026-09-12T15:00:00.000Z' })
  })
})

describe('AG: the created date says its age', () => {
  const NOW_ = at('2026-10-29T12:00')
  const age = (iso: string) => ageWords(at(iso).toISOString(), tz, '03:00', NOW_)

  test('AG-040: none today or yesterday; days, weeks, months, years', () => {
    expect(age('2026-10-29T09:00')).toBeNull()
    expect(age('2026-10-28T09:00')).toBeNull()
    expect(age('2026-10-27T09:00')).toBe('2 days')
    expect(age('2026-10-16T09:00')).toBe('13 days')
    expect(age('2026-10-15T09:00')).toBe('2 wks')
    expect(age('2026-09-20T09:00')).toBe('5 wks')
    expect(age('2026-09-03T09:00')).toBe('1 mo')
    expect(age('2026-07-15T09:00')).toBe('3 mo')
    expect(age('2025-11-01T09:00')).toBe('11 mo')
    expect(age('2025-10-20T09:00')).toBe('1 yr')
    expect(age('2023-03-01T09:00')).toBe('3 yr')
  })
})

describe('AG: membership and cadence', () => {
  beforeEach(() => setupTestDb())
  afterEach(() => vi.useRealTimers())
  afterAll(() => teardownTestDb())

  test('AG-010: aged on the check-in day → Aged out, and not in its horizon segment', () => {
    const id = make('Old daily', 'days', at('2026-10-10T09:00'))
    expect(placeOf(SAT).get(id)).toBe('aged_out:waiting')
    // Without the caller's flag nothing changes: its horizon segment, as before.
    expect(placeOf(SAT, false).get(id)).toBe('days:waiting')
  })

  test('AG-011: weekly — a task that ages mid-week waits for the next check-in day', () => {
    // 9 days old at Saturday's start, 13 by Wednesday, 16 the next Saturday.
    const id = make('Ages mid-week', 'days', at('2026-10-15T09:00'))
    expect(placeOf(SAT).get(id)).toBe('days:waiting')
    expect(placeOf(WED).get(id)).toBe('days:waiting')
    expect(placeOf(NEXT_SAT).get(id)).toBe('aged_out:waiting')
  })

  test('AG-012: carries over daily until handled', () => {
    const id = make('Unhandled', 'days', at('2026-10-10T09:00'))
    expect(placeOf(WED).get(id)).toBe('aged_out:waiting')
  })

  test('AG-013: each horizon past its own threshold; unset reads as Weeks', () => {
    const weeks = make('Weeks, 2 months', 'weeks', at('2026-08-20T09:00'))
    const unset = make('Unset, 2 months', null, at('2026-08-20T09:00'))
    const months = make('Months, 5 months', 'months', at('2026-05-20T09:00'))
    const youngWeeks = make('Weeks, 2 weeks', 'weeks', at('2026-10-10T09:00'))
    const p = placeOf(SAT)
    expect(p.get(weeks)).toBe('aged_out:waiting')
    expect(p.get(unset)).toBe('aged_out:waiting')
    expect(p.get(months)).toBe('aged_out:waiting')
    expect(p.get(youngWeeks) ?? 'nowhere').not.toMatch(/^aged_out/)
  })

  test('AG-014: never Eventually, never a close deadline, never a picked target', () => {
    const eventually = make('Eventually, a year', 'eventually', at('2025-10-01T09:00'))
    const deadline = make('Deadline soon', 'days', at('2026-10-01T09:00'), {
      deadline_at: at('2026-11-10T17:00').toISOString(),
    })
    const targeted = make('Targeted later', 'days', at('2026-10-01T09:00'), {
      due_at: at('2026-11-20T09:00').toISOString(),
    })
    const p = placeOf(SAT)
    for (const id of [eventually, deadline, targeted]) {
      expect(p.get(id) ?? 'nowhere').not.toMatch(/^aged_out/)
    }
  })
})

describe('AG: keep and grow', () => {
  beforeEach(() => setupTestDb())
  afterEach(() => vi.useRealTimers())
  afterAll(() => teardownTestDb())

  test('AG-020: keep — counted, considered today, back one threshold later; undo puts it all back', () => {
    const id = make('Keep me', 'days', at('2026-10-10T09:00'))
    vi.setSystemTime(WED)
    expect(keepTasks(TEST_USER_ID, tz, [id])).toBe(1)
    let task = getTaskById(id)!
    expect(task.growth_kept_count).toBe(1)
    expect(task.growth_kept_at).toBe(WED.toISOString())
    expect(task.last_considered_at).toBe(WED.toISOString())
    expect(task.horizon).toBe('days')
    expect(placeOf(WED).get(id)).toBe('aged_out:considered')
    // Next check-in: 3 days after the keep — not aged again; its own segment.
    expect(placeOf(NEXT_SAT).get(id)).toBe('days:waiting')

    vi.setSystemTime(WED)
    undoLatest(TEST_USER_ID)
    task = getTaskById(id)!
    expect(task.growth_kept_count).toBe(0)
    expect(task.growth_kept_at).toBeNull()
    expect(placeOf(WED).get(id)).toBe('aged_out:waiting')
  })

  test('AG-021: keeps count up; the second keep reads 2', () => {
    const id = make('Kept twice', 'days', at('2026-09-01T09:00'))
    vi.setSystemTime(at('2026-10-10T10:00'))
    keepTasks(TEST_USER_ID, tz, [id])
    vi.setSystemTime(WED)
    keepTasks(TEST_USER_ID, tz, [id])
    expect(getTaskById(id)!.growth_kept_count).toBe(2)
  })

  test('AG-022: grow — one step out, the clock restarts, the count resets; undo restores', () => {
    const id = make('Grow me', null, at('2026-08-20T09:00'))
    vi.setSystemTime(at('2026-10-10T10:00'))
    keepTasks(TEST_USER_ID, tz, [id])
    keepTasks(TEST_USER_ID, tz, [id])
    expect(getTaskById(id)!.growth_kept_count).toBe(2)

    vi.setSystemTime(WED)
    expect(growTasks(TEST_USER_ID, tz, [id])).toBe(1)
    let task = getTaskById(id)!
    expect(task.horizon).toBe('months')
    expect(task.horizon_set_at).toBe(WED.toISOString())
    expect(task.growth_kept_count).toBe(0)
    expect(placeOf(WED).get(id)).toBe('aged_out:considered')

    vi.setSystemTime(WED)
    undoLatest(TEST_USER_ID)
    task = getTaskById(id)!
    expect(task.horizon).toBeNull()
    expect(task.growth_kept_count).toBe(2)
  })

  test('AG-025: grow to a picked horizon (the hold menu) — in or out; the same one is left alone', () => {
    const id = make('Picked', 'weeks', at('2026-08-01T09:00'))
    vi.setSystemTime(WED)
    expect(growTasks(TEST_USER_ID, tz, [id], 'eventually')).toBe(1)
    expect(getTaskById(id)!.horizon).toBe('eventually')
    expect(placeOf(WED).get(id)).toBe('aged_out:considered')
    expect(growTasks(TEST_USER_ID, tz, [id], 'eventually')).toBe(0)
    expect(growTasks(TEST_USER_ID, tz, [id], 'days')).toBe(1)
    expect(getTaskById(id)!.horizon).toBe('days')
  })

  test('AG-023: grow leaves an Eventually task alone', () => {
    const id = make('Already eventually', 'eventually', at('2025-10-01T09:00'))
    vi.setSystemTime(WED)
    expect(growTasks(TEST_USER_ID, tz, [id])).toBe(0)
    expect(getTaskById(id)!.horizon).toBe('eventually')
  })

  test('AG-024: any change of the horizon resets the count; a same-value edit does not', () => {
    const id = make('Edited', 'days', at('2026-09-01T09:00'))
    vi.setSystemTime(WED)
    keepTasks(TEST_USER_ID, tz, [id])
    updateTask({ userId: TEST_USER_ID, userTimezone: tz, taskId: id, input: { horizon: 'days' } })
    expect(getTaskById(id)!.growth_kept_count).toBe(1)
    updateTask({ userId: TEST_USER_ID, userTimezone: tz, taskId: id, input: { horizon: 'weeks' } })
    expect(getTaskById(id)!.growth_kept_count).toBe(0)
  })
})
