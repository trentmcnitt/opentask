/**
 * GOLDEN: the golden scenario suite (spec "Testing and evaluation",
 * 2026-10-12). Every reference table of the Upcoming spec and of the v7
 * table, and every case Trent raised on 10-12, as a dated day-by-day
 * timeline (`tests/golden/`), played through the day simulator against the
 * real core and compared on EVERY local day of its window — what shows where
 * (a horizon segment, Upcoming, over target, done, quiet), the attempts, the
 * age badge and the 3× offer, plus some days' counts.
 *
 * One fresh database per scenario. America/Chicago.
 */
import { describe, test, expect, afterAll, afterEach, vi } from 'vitest'
import { DateTime } from 'luxon'
import { createTask } from '@/core/tasks'
import { getDb } from '@/core/db'
import { simulateDays, dayLine, type SimEvent } from '@/core/sim/day-simulator'
import { goldenScenarios } from '../golden'
import type { GoldenScenario } from '../golden/types'
import { TZ } from '../golden/helpers'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

/** Expand a scenario's expectation for one task over the days it exists. */
function expected(
  timeline: Record<string, string>,
  from: string,
  to: string,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (let d = DateTime.fromISO(from); d <= DateTime.fromISO(to); d = d.plus({ days: 1 })) {
    out[d.toISODate()!] = 'quiet'
  }
  for (const [key, line] of Object.entries(timeline)) {
    const [a, b] = key.split('..')
    for (let d = DateTime.fromISO(a); d <= DateTime.fromISO(b ?? a); d = d.plus({ days: 1 })) {
      const date = d.toISODate()!
      if (!(date in out)) throw new Error(`${key} is outside the task's window`)
      out[date] = line
    }
  }
  return out
}

/** A queue scenario's user: the switch, the periods, and the stamp (see `GoldenScenario.queue`). */
function setupQueue(s: GoldenScenario) {
  if (!s.queue) return
  vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
  const db = getDb()
  const insert = db.prepare(
    'INSERT INTO time_slots (user_id, label, start_time, sort_order) VALUES (?, ?, ?, ?)',
  )
  db.prepare('DELETE FROM time_slots WHERE user_id = ?').run(TEST_USER_ID)
  ;(s.queue.periods ?? ['06:30', '12:00', '20:30']).forEach((start, i) =>
    insert.run(TEST_USER_ID, `Period ${i}`, start, i),
  )
  db.prepare(
    'UPDATE users SET morning_time = ?, day_start_time = ?, last_rollover_date = ? WHERE id = ?',
  ).run(
    s.queue.morning ?? '08:30',
    s.queue.dayStart === undefined ? '06:30' : s.queue.dayStart,
    DateTime.fromISO(s.from).minus({ days: 1 }).toISODate(),
    TEST_USER_ID,
  )
}

function run(s: GoldenScenario) {
  setupTestDb()
  setupQueue(s)
  const events: SimEvent[] = [
    ...s.tasks.map((t) => ({
      at: t.created,
      run: (ctx: Parameters<SimEvent['run']>[0]) => {
        const task = createTask({
          userId: ctx.userId,
          userTimezone: ctx.timezone,
          input: t.input as Parameters<typeof createTask>[0]['input'],
        })
        ctx.ids[t.name] = task.id
        t.after?.(task.id, ctx)
      },
    })),
    ...(s.events ?? []),
  ]
  const names: Record<number, string> = {}
  let ids: Record<string, number> = {}
  const days = simulateDays({
    userId: TEST_USER_ID,
    timezone: TEST_TIMEZONE,
    from: s.from,
    days: Math.round(DateTime.fromISO(s.to).diff(DateTime.fromISO(s.from), 'days').days) + 1,
    at: s.at,
    policy: s.policy,
    events: events.map((e) => ({
      ...e,
      run: (ctx) => {
        ids = ctx.ids
        e.run(ctx)
      },
    })),
    taskIds: () => Object.values(ids),
    setClock: (d) => vi.setSystemTime(d),
    rollover: s.queue ? { late: s.queue.late } : undefined,
  })
  for (const [name, id] of Object.entries(ids)) names[id] = name
  const actual: Record<string, Record<string, string>> = {}
  for (const day of days) {
    for (const t of day.tasks) {
      ;(actual[names[t.id]] ??= {})[day.date] = dayLine(t)
    }
  }
  return { days, actual }
}

describe('GOLDEN: day-by-day timelines (America/Chicago)', () => {
  afterAll(() => teardownTestDb())
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  test('the suite is in the test user zone', () => expect(TEST_TIMEZONE).toBe(TZ))

  for (const s of goldenScenarios) {
    test(`${s.id}: ${s.title}`, () => {
      const { days, actual } = run(s)
      for (const t of s.tasks) {
        const created = t.created.slice(0, 10)
        const from = created > s.from ? created : s.from
        expect(actual[t.name], `${s.id} / ${t.name}`).toEqual(
          expected(s.expect[t.name] ?? {}, from, s.to),
        )
      }
      for (const [date, counts] of Object.entries(s.counts ?? {})) {
        const day = days.find((d) => d.date === date)!
        for (const [key, n] of Object.entries(counts)) {
          expect(day.counts[key] ?? 0, `${s.id} ${date} ${key}`).toBe(n)
        }
      }
    })
  }
})
