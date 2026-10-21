/**
 * TM-INV: invariants of the target model over random tasks and dates (spec
 * "Testing and evaluation", §6, §8; 2026-10-12). America/Chicago, with both
 * DST changes in range (Sun Nov 1 2026, Sun Mar 14 2027).
 *
 * Seeded, so a failure reproduces: the seed and the case are in the message.
 * Each case writes through the real paths (create, PATCH, the snooze
 * endpoint, bulk snooze, bulk edit, Today, done) and then checks, after every
 * write and on every local day of the following month:
 *
 *  - target ≤ deadline while the deadline is ahead (once it has passed, any
 *    target can be picked — Trent's ruling, 2026-10-12);
 *  - a one-off with a deadline always has a target, and an automatic target
 *    always has a deadline;
 *  - a picked target always means quiet (no horizon segment);
 *  - an automatic target never does (no Upcoming row);
 *  - never in both a horizon segment and Upcoming, nor in Upcoming and over
 *    target.
 *
 * And for repeating tasks: done always lands on a scheduled occurrence after
 * now (no double fire, no catch-up), and a move never changes the occurrence.
 *
 * And for bulk snooze (TM-INV-03): a passed deadline puts a task in the High
 * tier — swept only once no P0–P2 task without a passed deadline is left in
 * the batch; a P4 is never swept, deadline or not.
 */
import { describe, test, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { DateTime } from 'luxon'
import { createTask, updateTask, markDone, bulkSnooze, bulkEdit } from '@/core/tasks'
import { skipOccurrence } from '@/core/tasks/skip'
import { skipUntil } from '@/core/tasks/skip-until'
import { runTaskRollover } from '@/core/tasks/task-rollover'
import { snoozeTask } from '@/core/tasks/snooze'
import { getTaskById } from '@/core/tasks/read'
import { getDb } from '@/core/db'
import { targetTasksToday } from '@/core/tasks/task-segments'
import { deckTasks } from '@/core/tasks/deck'
import { getCurrentlyDueTaskIds } from '@/core/tasks/currently-due'
import { isCurrentlyDue } from '@/core/recurrence/occurrence'
import {
  segmentState,
  upcomingState,
  hasPickedTarget,
  occurrenceDates,
  targetMoved,
} from '@/lib/task-segments'
import { simulateDays, type SimEvent, type SimTaskDay } from '@/core/sim/day-simulator'
import type { Task } from '@/types'
import { ValidationError } from '@/core/errors'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

const tz = TEST_TIMEZONE
const SEED = 20261012
const u = { userId: TEST_USER_ID, userTimezone: tz }

/** mulberry32 — a tiny seeded PRNG. */
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const WINDOWS = ['2026-10-20T00:00', '2027-03-05T00:00'] // across Nov 1 and Mar 14

function checkDay(task: Task, now: Date, label: string): void {
  const placed = segmentState(task, tz, now)
  const heads = upcomingState(task, tz, now)
  if (hasPickedTarget(task)) expect(placed, `${label}: picked target but in a segment`).toBeNull()
  if (task.target_auto) expect(heads, `${label}: auto target in Upcoming`).toBeNull()
  expect(placed !== null && heads !== null, `${label}: segment AND Upcoming`).toBe(false)
  if (heads) {
    expect(isCurrentlyDue(task, tz, now), `${label}: Upcoming AND over target`).toBe(false)
  }
}

function checkStored(task: Task, label: string): void {
  // Only a deadline still ahead caps the target (2026-10-12 ruling).
  if (task.due_at && task.deadline_at && Date.parse(task.deadline_at) > Date.now()) {
    expect(Date.parse(task.due_at), `${label}: target after deadline`).toBeLessThanOrEqual(
      Date.parse(task.deadline_at),
    )
  }
  if (task.target_auto) {
    expect(task.deadline_at, `${label}: auto target with no deadline`).not.toBeNull()
    expect(task.due_at, `${label}: auto target with no date`).not.toBeNull()
  }
  if (!task.rrule && task.deadline_at && !task.done && !task.is_reminder) {
    expect(task.due_at, `${label}: a deadline with no target`).not.toBeNull()
  }
}

describe('TM-INV: target-model invariants (seeded random)', () => {
  beforeAll(() => setupTestDb())
  afterAll(() => teardownTestDb())
  afterEach(() => vi.useRealTimers())

  test('TM-INV-01: one-offs — random targets, deadlines and moves', () => {
    const r = rng(SEED)
    const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)]
    const offset = (maxDays: number) => Math.round((r() * 2 - 1) * maxDays * 24 * 60) // minutes
    for (let c = 0; c < 120; c++) {
      const start = DateTime.fromISO(pick(WINDOWS), { zone: tz }).plus({
        minutes: Math.floor(r() * 20 * 24 * 60),
      })
      let clock = start
      vi.setSystemTime(clock.toJSDate())
      const rel = (maxDays: number) =>
        clock
          .plus({ minutes: offset(maxDays) })
          .toUTC()
          .toISO()!
      const t = createTask({
        ...u,
        input: {
          title: `inv ${c}`,
          due_at: r() < 0.5 ? rel(20) : undefined,
          deadline_at: r() < 0.6 ? rel(30) : undefined,
          horizon: pick(['days', 'weeks', 'months', 'eventually', undefined]),
        },
      })
      const label = (step: string) => `seed ${SEED} case ${c} ${step}`
      checkStored(getTaskById(t.id)!, label('create'))
      for (let s = 0; s < 5; s++) {
        clock = clock.plus({ minutes: Math.floor(r() * 3 * 24 * 60) })
        vi.setSystemTime(clock.toJSDate())
        const op = Math.floor(r() * 7)
        const step = `op ${s}:${op}`
        if (op === 0) updateTask({ ...u, taskId: t.id, input: { due_at: rel(25) } })
        if (op === 1) updateTask({ ...u, taskId: t.id, input: { due_at: null } })
        if (op === 2) {
          updateTask({ ...u, taskId: t.id, input: { deadline_at: r() < 0.25 ? null : rel(30) } })
        }
        if (op === 3) snoozeTask({ ...u, taskId: t.id, until: rel(15) })
        if (op === 4) bulkSnooze({ ...u, taskIds: [t.id], until: rel(15), includeTaskIds: [t.id] })
        if (op === 5) bulkEdit({ ...u, taskIds: [t.id], changes: { due_at: rel(15) } })
        if (op === 6) {
          const later = clock.plus({ minutes: Math.floor(r() * 5 * 24 * 60) })
          targetTasksToday(TEST_USER_ID, tz, [t.id], later.toUTC().toISO()!)
        }
        const task = getTaskById(t.id)!
        checkStored(task, label(step))
        checkDay(task, clock.toJSDate(), label(step))
      }
      const final = getTaskById(t.id)!
      for (let d = 0; d < 35; d++) {
        const day = clock.plus({ days: d }).set({ hour: 12 })
        checkDay(final, day.toJSDate(), label(`day +${d}`))
      }
    }
  })

  test('TM-INV-02: repeating — moves never touch the occurrence; done lands on the schedule after now', () => {
    const r = rng(SEED + 1)
    const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)]
    const DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']
    for (let c = 0; c < 60; c++) {
      let clock = DateTime.fromISO(pick(WINDOWS), { zone: tz }).plus({
        minutes: Math.floor(r() * 10 * 24 * 60),
      })
      vi.setSystemTime(clock.toJSDate())
      const byday = pick(DAYS)
      const hour = 7 + Math.floor(r() * 12)
      const t = createTask({
        ...u,
        input: { title: `rep ${c}`, rrule: `FREQ=WEEKLY;BYDAY=${byday};BYHOUR=${hour};BYMINUTE=0` },
      })
      const label = (step: string) => `seed ${SEED + 1} case ${c} ${step}`
      for (let s = 0; s < 6; s++) {
        clock = clock.plus({ minutes: Math.floor(r() * 4 * 24 * 60) })
        vi.setSystemTime(clock.toJSDate())
        const before = getTaskById(t.id)!
        if (r() < 0.5) {
          // A move: up to 12 days either way of now (it may pass the next occurrence).
          const to = clock.plus({ minutes: Math.round((r() * 2 - 0.5) * 12 * 24 * 60) })
          updateTask({ ...u, taskId: t.id, input: { due_at: to.toUTC().toISO()! } })
          const after = getTaskById(t.id)!
          expect(after.occurrence_at, label(`move ${s}`)).toBe(before.occurrence_at)
        } else {
          markDone({ ...u, taskId: t.id })
          const after = getTaskById(t.id)!
          const next = DateTime.fromISO(after.occurrence_at!, { zone: 'utc' }).setZone(tz)
          expect(next.toMillis(), label(`done ${s}: not after now`)).toBeGreaterThan(
            clock.toMillis(),
          )
          expect(next.toFormat('ccc').toUpperCase().slice(0, 2), label(`done ${s}: weekday`)).toBe(
            byday,
          )
          expect(next.hour, label(`done ${s}: hour (DST)`)).toBe(hour)
          expect(after.due_at, label(`done ${s}: target = occurrence`)).toBe(after.occurrence_at)
          // Not a day early: never more than a week out, never before the
          // occurrence it closed.
          const closed = Date.parse(before.occurrence_at!)
          expect(next.toMillis(), label(`done ${s}: before the closed one`)).toBeGreaterThan(closed)
          expect(isCurrentlyDue(after, tz, clock.toJSDate()), label(`done ${s}: double fire`)).toBe(
            false,
          )
        }
        checkDay(getTaskById(t.id)!, clock.toJSDate(), label(`step ${s}`))
      }
    }
  })
})

describe('TM-INV: the bulk tier (seeded random)', () => {
  beforeAll(() => setupTestDb())
  afterAll(() => teardownTestDb())
  afterEach(() => vi.useRealTimers())

  test('TM-INV-03: bulk snooze — a passed deadline is the High tier; P4 never moves', () => {
    // A seeded random sweep over the bulk tier; on a slow CI runner it has
    // run past vitest's 5 s default, like TM-INV-06/07, so it gets its own.
    const r = rng(SEED + 2)
    const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)]
    for (let c = 0; c < 80; c++) {
      const clock = DateTime.fromISO(pick(WINDOWS), { zone: tz }).plus({
        minutes: Math.floor(r() * 20 * 24 * 60),
      })
      vi.setSystemTime(clock.toJSDate())
      const label = `seed ${SEED + 2} case ${c}`
      const size = 1 + Math.floor(r() * 5)
      const tasks: Task[] = []
      for (let i = 0; i < size; i++) {
        const deadline = pick(['passed', 'ahead', 'none'] as const)
        const deadlineAt =
          deadline === 'none'
            ? undefined
            : clock
                .plus({ hours: deadline === 'passed' ? -(1 + r() * 200) : 1 + r() * 200 })
                .toUTC()
                .toISO()!
        tasks.push(
          createTask({
            ...u,
            input: {
              title: `bulk ${c}.${i}`,
              priority: Math.floor(r() * 5),
              // Already over target, so every eligible task moves.
              due_at: clock
                .minus({ hours: 1 + r() * 5 })
                .toUTC()
                .toISO()!,
              deadline_at: deadlineAt,
            },
          }),
        )
      }
      const passed = (t: Task) => t.deadline_at !== null && Date.parse(t.deadline_at) <= Date.now()
      const tier = (t: Task) => (passed(t) ? Math.max(t.priority ?? 0, 3) : (t.priority ?? 0))
      const anyLower = tasks.some((t) => tier(t) < 3)
      const expected = tasks.filter((t) => tier(t) <= (anyLower ? 2 : 3)).map((t) => t.id)
      const heldByDeadline = tasks.filter(
        (t) => !expected.includes(t.id) && (t.priority ?? 0) < 3,
      ).length

      const until = clock
        .plus({ days: 1 + Math.floor(r() * 10) })
        .toUTC()
        .toISO()!
      const res = bulkSnooze({ ...u, taskIds: tasks.map((t) => t.id), until })
      expect([...res.snoozedIds].sort(), `${label}: moved`).toEqual([...expected].sort())
      expect(res.deadlineSkipped, `${label}: deadlineSkipped`).toBe(heldByDeadline)
      for (const t of tasks) {
        const after = getTaskById(t.id)!
        if (t.priority === 4) expect(after.due_at, `${label}: P4 moved`).toBe(t.due_at)
        checkStored(after, `${label} task ${t.id}`)
      }
    }
  }, 30_000)
})

/**
 * TM-INV-04/05 (spec §7 + "Testing and evaluation", 2026-10-12): a random task
 * list stepped day by day through the DAY SIMULATOR — the real screen reads —
 * and checked on every local day:
 *
 *  - never two Upcoming rows for one task, never two segments at once;
 *  - never in a horizon segment and Upcoming, nor Upcoming and over target;
 *  - a picked target never in a horizon segment; an automatic one never in
 *    Upcoming;
 *  - never told, then silent before the target: untapped (policy never), a
 *    task once in Upcoming is in Upcoming every day until its target's day;
 *  - attempts increase by at most 1 per local day, never on a day the task
 *    was not over target (no moves: once over, it stays over), and are 0 for
 *    a task whose target has never arrived;
 *  - target ≤ deadline while the deadline is ahead.
 * TM-INV-05 adds random moves (any day, any direction): attempts still rise
 * by at most 1 per local day and only once a target has arrived.
 */

/**
 * TM-INV-07's repeating rules (2026-10-20): a decked repeating task holds no
 * target and is never currently due; off deck, a repeating task is never
 * left target-less (no stuck rows).
 */
function expectRepeatingDeckRules(task: Task, dueNow: Set<number>, l: string) {
  if (!task.rrule || task.done) return
  if (!task.on_deck_day) {
    expect(task.due_at, `${l}: a repeating task left target-less off deck`).not.toBeNull()
    return
  }
  expect(task.due_at, `${l}: a repeating deck holds a target`).toBeNull()
  expect(dueNow.has(task.id), `${l}: a repeating deck is currently due`).toBe(false)
}

function randomList(seed: number, start: DateTime) {
  const r = rng(seed)
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)]
  const events: SimEvent[] = []
  for (let c = 0; c < 40; c++) {
    const created = start.plus({ minutes: Math.floor(r() * 10 * 24 * 60) })
    const rel = (maxDays: number) =>
      created
        .plus({ minutes: Math.floor(r() * maxDays * 24 * 60) })
        .toUTC()
        .toISO()!
    const kind = pick(['picked', 'deadline', 'both', 'undated', 'weekly', 'daily'] as const)
    const input: Record<string, unknown> = { title: `sim ${c}` }
    if (kind === 'picked' || kind === 'both') input.due_at = rel(25)
    if (kind === 'deadline' || kind === 'both') input.deadline_at = rel(30)
    if (kind === 'weekly') {
      input.rrule = `FREQ=WEEKLY;BYDAY=${pick(['MO', 'WE', 'FR', 'SU'])};BYHOUR=${7 + Math.floor(r() * 12)};BYMINUTE=0`
    }
    if (kind === 'daily') input.rrule = 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0'
    input.horizon = pick(['days', 'weeks', 'months', 'eventually', undefined])
    events.push({
      at: created.toFormat("yyyy-MM-dd'T'HH:mm"),
      run: (ctx) => {
        ctx.ids[`t${c}`] = createTask({
          userId: ctx.userId,
          userTimezone: ctx.timezone,
          input: input as Parameters<typeof createTask>[0]['input'],
        }).id
      },
    })
  }
  return { events, r }
}

function simulate(seed: number, moves: boolean) {
  setupTestDb()
  const start = DateTime.fromISO('2026-10-20T00:00', { zone: tz }) // across Nov 1
  const { events, r } = randomList(seed, start)
  if (moves) {
    for (let m = 0; m < 60; m++) {
      const at = start.plus({ minutes: Math.floor(r() * 40 * 24 * 60) })
      const which = Math.floor(r() * 40)
      const shift = Math.round((r() * 2 - 0.7) * 6 * 24 * 60)
      events.push({
        at: at.toFormat("yyyy-MM-dd'T'HH:mm"),
        run: (ctx) => {
          const id = ctx.ids[`t${which}`]
          const task = id ? getTaskById(id) : null
          if (!task || task.done) return
          updateTask({
            ...u,
            taskId: id,
            input: { due_at: at.plus({ minutes: shift }).toUTC().toISO()! },
          })
        },
      })
    }
  }
  let ids: Record<string, number> = {}
  const days = simulateDays({
    userId: TEST_USER_ID,
    timezone: tz,
    from: start.toISODate()!,
    days: 45,
    // The day's last minute: each record then covers exactly one local day,
    // so "at most 1 a day" is a per-tick check.
    at: '23:59',
    policy: ['never'],
    events: events.map((e) => ({
      ...e,
      run: (ctx) => {
        ids = ctx.ids
        e.run(ctx)
      },
    })),
    taskIds: () => Object.values(ids),
    setClock: (d) => vi.setSystemTime(d),
  })
  return days
}

/** Where a task is on a simulated day: one segment at most, never two places that exclude each other. */
function checkPlaces(t: SimTaskDay, task: Task, label: string) {
  const segs = t.places.filter((p) => p !== 'over' && p !== 'done' && p !== 'quiet')
  expect(segs.length, `${label}: two segments`).toBeLessThanOrEqual(1)
  expect(t.places.includes('upcoming') && t.places.includes('over'), label).toBe(false)
  if (hasPickedTarget(task) && !task.rrule) {
    expect(
      segs.filter((p) => p !== 'upcoming'),
      `${label}: picked in a segment`,
    ).toEqual([])
  }
  if (task.target_auto) expect(segs, `${label}: auto in Upcoming`).not.toContain('upcoming')
  checkStored(task, label)
}

describe('TM-INV: the day simulator over a random list', () => {
  beforeAll(() => setupTestDb())
  afterAll(() => teardownTestDb())
  afterEach(() => vi.useRealTimers())

  test('TM-INV-04: placement, carry-over and attempts, day by day (no moves)', () => {
    const SEED4 = SEED + 4
    const days = simulate(SEED4, false)
    const seenUpcoming = new Set<number>()
    const prev = new Map<number, number>()
    for (const day of days) {
      vi.setSystemTime(DateTime.fromISO(`${day.date}T23:59`, { zone: tz }).toJSDate())
      for (const t of day.tasks) {
        const label = `seed ${SEED4} ${day.date} task ${t.id}`
        const task = getTaskById(t.id)!
        checkPlaces(t, task, label)
        // Told, then silent before the target: never.
        const targetDay = task.due_at
          ? DateTime.fromISO(task.due_at).setZone(tz).toISODate()!
          : null
        if (seenUpcoming.has(t.id) && targetDay && day.date < targetDay && !task.done) {
          expect(t.place, `${label}: told then silent`).toBe('upcoming')
        }
        if (t.place === 'upcoming') seenUpcoming.add(t.id)
        // Attempts: +1 at most a day, and only on a day it is over target.
        const before = prev.get(t.id) ?? 0
        const delta = t.attempts - before
        if (t.place !== 'done' && !(task.rrule && delta < 0)) {
          expect(delta, `${label}: attempts delta`).toBeGreaterThanOrEqual(0)
          expect(delta, `${label}: attempts delta`).toBeLessThanOrEqual(1)
          if (delta === 1) expect(t.places, `${label}: attempt while not over`).toContain('over')
        }
        if (targetDay && targetDay > day.date && !task.rrule) {
          expect(t.attempts, `${label}: attempts before the target`).toBe(0)
        }
        prev.set(t.id, t.attempts)
      }
    }
    // The list really exercised the rules.
    const places = new Set(days.flatMap((d) => d.tasks.flatMap((t) => t.places)))
    for (const p of ['upcoming', 'over', 'days']) expect(places).toContain(p)
    expect(Math.max(...days.flatMap((d) => d.tasks.map((t) => t.attempts)))).toBeGreaterThan(3)
  })

  test('TM-INV-05: with random moves, attempts rise at most 1 a local day, only after a target arrived', () => {
    const SEED5 = SEED + 5
    const days = simulate(SEED5, true)
    const prev = new Map<number, number>()
    const everArrived = new Set<number>()
    for (const day of days) {
      for (const t of day.tasks) {
        const label = `seed ${SEED5} ${day.date} task ${t.id}`
        if (t.places.includes('over')) everArrived.add(t.id)
        const delta = t.attempts - (prev.get(t.id) ?? 0)
        if (t.place !== 'done' && delta > 0) {
          expect(delta, `${label}: more than 1 in a day`).toBe(1)
        }
        // A count can only exist once some target arrived (at a tick, or
        // between ticks before a move away — then the move's checkpoint kept it).
        if (t.attempts > 0 && !everArrived.has(t.id)) {
          const task = getTaskById(t.id)!
          expect(task.original_due_at, `${label}: attempts with no target ever`).not.toBeNull()
        }
        expect(t.places.includes('upcoming') && t.places.includes('over'), label).toBe(false)
        prev.set(t.id, t.attempts)
      }
    }
  })
})

/**
 * TM-INV-06 (task queue PR 2): the same random list with random moves, the
 * task queue ON and its rollover run at each day's 06:30 (the first period).
 * Right after every rollover, NO below-High one-off without a deadline is
 * still targeted before that rollover moment — it was stripped into the
 * queue — unless its target was set after the moment (as of M). And every
 * day's placement rules still hold.
 */
describe('TM-INV: the rollover over a random list', () => {
  afterAll(() => teardownTestDb())
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  test('TM-INV-06: after a rollover, no strippable one-off is targeted before M', () => {
    const SEED6 = SEED + 6
    // Three weeks from Oct 20 crosses the Nov 1 fall-back. It's a seeded
    // simulation with a rollover every day, so it gets its own timeout
    // (CI runs it ~2.5x slower than a laptop).
    const DAYS = 21
    vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
    setupTestDb()
    const db = getDb()
    db.prepare(
      "INSERT INTO time_slots (user_id, label, start_time, sort_order) VALUES (?, 'Morning', '06:30', 0)",
    ).run(TEST_USER_ID)
    db.prepare("UPDATE users SET last_rollover_date = '2026-10-19' WHERE id = ?").run(TEST_USER_ID)
    const start = DateTime.fromISO('2026-10-20T00:00', { zone: tz }) // across Nov 1
    const { events, r } = randomList(SEED6, start)
    for (let m = 0; m < 60; m++) {
      const at = start.plus({ minutes: Math.floor(r() * DAYS * 24 * 60) })
      const which = Math.floor(r() * 40)
      const shift = Math.round((r() * 2 - 0.7) * 6 * 24 * 60)
      events.push({
        at: at.toFormat("yyyy-MM-dd'T'HH:mm"),
        run: (ctx) => {
          const id = ctx.ids[`t${which}`]
          const task = id ? getTaskById(id) : null
          if (!task || task.done) return
          updateTask({
            ...u,
            taskId: id,
            input: { due_at: at.plus({ minutes: shift }).toUTC().toISO()! },
          })
        },
      })
    }
    let ids: Record<string, number> = {}
    let checked = 0
    let stripped = 0
    // Half a minute after each day's rollover: the state the rollover left.
    for (let d = 0; d < DAYS; d++) {
      const day = start.plus({ days: d })
      events.push({
        at: day.set({ hour: 6, minute: 30, second: 30 }).toISO()!,
        run: () => {
          const m = day.set({ hour: 6, minute: 30 }).toMillis()
          for (const id of Object.values(ids)) {
            const task = getTaskById(id)!
            if (task.queued_at && !task.rrule) stripped++
            if (task.rrule || task.deadline_at || task.done || task.deleted_at) continue
            if (task.is_reminder || task.is_tracked || task.priority >= 3) continue
            if (task.target_set_at && Date.parse(task.target_set_at) > m) continue
            // Spared: an unmarked pick set on an earlier calendar day for
            // between midnight and M (designer ruling, 10-19).
            if (task.due_at) {
              const due = DateTime.fromISO(task.due_at).setZone(tz)
              const setDay = DateTime.fromISO(task.target_set_at ?? task.created_at)
                .setZone(tz)
                .startOf('day')
              if (+due >= +day && +due < m && setDay < due.startOf('day')) continue
            }
            const label = `seed ${SEED6} ${day.toISODate()} task ${id}`
            if (task.due_at) {
              expect(Date.parse(task.due_at), `${label}: targeted before M`).toBeGreaterThanOrEqual(
                m,
              )
            }
            checked++
          }
        },
      })
    }
    const days = simulateDays({
      userId: TEST_USER_ID,
      timezone: tz,
      from: start.toISODate()!,
      days: DAYS,
      at: '23:59',
      policy: ['never'],
      rollover: true,
      events: events.map((e) => ({
        ...e,
        run: (ctx) => {
          ids = ctx.ids
          e.run(ctx)
        },
      })),
      taskIds: () => Object.values(ids),
      setClock: (dt) => vi.setSystemTime(dt),
    })
    // Each day's places (as recorded that day): one segment at most, never
    // Upcoming and over target at once.
    for (const day of days) {
      for (const t of day.tasks) {
        const label = `seed ${SEED6} ${day.date} task ${t.id}`
        const segs = t.places.filter((p) => p !== 'over' && p !== 'done' && p !== 'quiet')
        expect(segs.length, `${label}: two segments`).toBeLessThanOrEqual(1)
        expect(t.places.includes('upcoming') && t.places.includes('over'), label).toBe(false)
      }
    }
    // The list really exercised the rollover.
    expect(checked).toBeGreaterThan(100)
    expect(stripped).toBeGreaterThan(5)
  }, 30_000)
})

/**
 * ON DECK (2026-10-20): a random list with random decks, un-decks, picks,
 * deadline writes, Back to auto and sweeps, and a rollover every morning.
 * After every write and on every day:
 *  - a deck and a PICKED target never coexist (rule 1, the B1 clear);
 *  - a deck is never queued, never in a horizon segment, and never on a
 *    repeating task, a reminder or a quota;
 *  - a deck NEVER nags (A1 strict, review 10-20): no undone deck's target
 *    has arrived — a pick clears it, and a deadline that would remind on or
 *    before its day wins (the rollover strips a deck at 06:30, before the
 *    09:00 morning an automatic target starts at);
 *  - after a rollover no undone deck is older than the OpenTask day.
 */
describe('TM-INV: on deck over a random list', () => {
  afterAll(() => teardownTestDb())
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  // Repeating tasks are in the list and can be decked (2026-10-20): a decked
  // repeating task has NO target (never a held value), is never queued and
  // never currently due; and no repeating task is ever left target-less off
  // deck (no stuck rows) — by a deck, an un-deck, a pick or a rollover.
  test('TM-INV-07: a deck and a picked target never coexist; a deck never nags', () => {
    const SEED7 = SEED + 7
    const DAYS = 21
    vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
    setupTestDb()
    const db = getDb()
    db.prepare(
      "INSERT INTO time_slots (user_id, label, start_time, sort_order) VALUES (?, 'Morning', '06:30', 0)",
    ).run(TEST_USER_ID)
    db.prepare("UPDATE users SET last_rollover_date = '2026-10-19' WHERE id = ?").run(TEST_USER_ID)
    const start = DateTime.fromISO('2026-10-20T00:00', { zone: tz })
    const { events, r } = randomList(SEED7, start)
    let ids: Record<string, number> = {}
    let decked = 0
    let repeatingDecked = 0
    const check = (label: string) => {
      const dueNow = new Set(getCurrentlyDueTaskIds(TEST_USER_ID))
      for (const id of Object.values(ids)) {
        const task = getTaskById(id)!
        const l = `seed ${SEED7} ${label} task ${id}`
        expectRepeatingDeckRules(task, dueNow, l)
        if (!task.on_deck_day) continue
        expect(hasPickedTarget(task), `${l}: deck + picked target`).toBe(false)
        expect(task.queued_at, `${l}: deck + queued`).toBeNull()
        expect(segmentState(task, tz, new Date()), `${l}: deck in a segment`).toBeNull()
        if (!task.done) {
          const arrived = task.due_at !== null && Date.parse(task.due_at) <= Date.now()
          expect(arrived, `${l}: a deck nags`).toBe(false)
        }
      }
    }
    const writes: ((id: number, at: DateTime) => void)[] = [
      (id, at) => {
        const day = at.plus({ days: Math.floor(r() * 6) }).toISODate()!
        try {
          const res = deckTasks({ userId: TEST_USER_ID, timezone: tz, ids: [id], day })
          decked++
          if (res.decked > 0 && getTaskById(id)!.rrule) repeatingDecked++
        } catch {
          // A deck refused whole (a past day can't happen; nothing else throws per task).
        }
      },
      (id) => deckTasks({ userId: TEST_USER_ID, timezone: tz, ids: [id], day: null }),
      (id, at) =>
        updateTask({
          ...u,
          taskId: id,
          input: {
            due_at: at
              .plus({ hours: 1 + Math.floor(r() * 72) })
              .toUTC()
              .toISO()!,
          },
        }),
      // A deadline: a one-off's, or a deadline-anchored repeat's reschedule. A
      // target-anchored repeat never gains one (2026-10-21, a 400).
      (id, at) => {
        const task = getTaskById(id)!
        if (task.rrule && task.repeat_anchor !== 'deadline') return
        updateTask({
          ...u,
          taskId: id,
          input: {
            deadline_at: at
              .plus({ days: 2 + Math.floor(r() * 20) })
              .toUTC()
              .toISO()!,
          },
        })
      },
      // Clearing a target: a one-off's only. On a repeating task it is not a
      // deck path (the editor clears the rule with it), so it is left out.
      (id) => {
        if (!getTaskById(id)!.rrule) updateTask({ ...u, taskId: id, input: { due_at: null } })
      },
      (id, at) =>
        bulkSnooze({
          ...u,
          taskIds: [id],
          until: at.plus({ hours: 3 }).toUTC().toISO()!,
          source: 'sweep',
        }),
      (id) => targetTasksToday(TEST_USER_ID, tz, [id]),
    ]
    for (let m = 0; m < 200; m++) {
      const at = start.plus({ minutes: Math.floor(r() * DAYS * 24 * 60) })
      const which = Math.floor(r() * 40)
      const write = writes[Math.floor(r() * writes.length)]
      events.push({
        at: at.toFormat("yyyy-MM-dd'T'HH:mm"),
        run: (ctx) => {
          const id = ctx.ids[`t${which}`]
          const task = id ? getTaskById(id) : null
          if (!task || task.done) return
          write(id, at)
          check(at.toISO()!)
        },
      })
    }
    // Half a minute after each rollover: no deck older than the new OpenTask day.
    for (let d = 0; d < DAYS; d++) {
      const day = start.plus({ days: d })
      events.push({
        at: day.set({ hour: 6, minute: 30, second: 30 }).toISO()!,
        run: () => {
          for (const id of Object.values(ids)) {
            const task = getTaskById(id)!
            if (task.on_deck_day && !task.done) {
              expect(task.on_deck_day >= day.toISODate()!, `${day.toISODate()} task ${id}`).toBe(
                true,
              )
            }
          }
          check(`${day.toISODate()} after the rollover`)
        },
      })
    }
    const days = simulateDays({
      userId: TEST_USER_ID,
      timezone: tz,
      from: start.toISODate()!,
      days: DAYS,
      at: '21:00',
      policy: ['tap'],
      rollover: true,
      events: events.map((e) => ({
        ...e,
        run: (ctx) => {
          ids = ctx.ids
          e.run(ctx)
        },
      })),
      taskIds: () => Object.values(ids),
      setClock: (dt) => vi.setSystemTime(dt),
    })
    for (const day of days) {
      for (const t of day.tasks) {
        const label = `seed ${SEED7} ${day.date} task ${t.id}`
        // On deck today is a place of its own: never with a segment or Upcoming.
        if (t.places.includes('deck')) {
          const other = t.places.filter((p) => p !== 'deck' && p !== 'over' && p !== 'done')
          expect(other, label).toEqual([])
        }
      }
    }
    expect(decked).toBeGreaterThan(10)
    expect(repeatingDecked).toBeGreaterThan(2)
  }, 30_000)
})

describe('TM-INV: deadline-anchored repeats (seeded random)', () => {
  afterAll(() => teardownTestDb())
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  /**
   * TM-INV-08 (2026-10-21): random repeating tasks of BOTH anchors through
   * random moves, done, skip, skip until, decks and rollovers. After every
   * write:
   *  1. I1/I2 — a deadline-anchored repeat has a deadline, and it IS its
   *     occurrence; a target-anchored one has none;
   *  2. off deck, `due_at` is what `occurrenceDates` derives unless the target
   *     was moved this occurrence;
   *  3. the target is never after a deadline still ahead;
   *  4. after done or skip, never moved;
   *  5. a deadline-anchored repeat is never queued.
   */
  test('TM-INV-08: one derivation, whatever the writes', () => {
    const SEED8 = SEED + 8
    const r = rng(SEED8)
    const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)]
    vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
    setupTestDb()
    const db = getDb()
    db.prepare(
      "INSERT INTO time_slots (user_id, label, start_time, sort_order) VALUES (?, 'Morning', '06:30', 0)",
    ).run(TEST_USER_ID)
    const RULES = [
      'FREQ=DAILY;BYHOUR=17;BYMINUTE=0',
      'FREQ=WEEKLY;BYDAY=SA;BYHOUR=8;BYMINUTE=0',
      'FREQ=WEEKLY;BYDAY=MO,TH;BYHOUR=21;BYMINUTE=0',
      'FREQ=MONTHLY;BYDAY=1SA;BYHOUR=8;BYMINUTE=0',
      'FREQ=WEEKLY;INTERVAL=2;BYDAY=SU;BYHOUR=23;BYMINUTE=0',
    ]
    let wrote = 0
    for (let c = 0; c < 40; c++) {
      let clock = DateTime.fromISO(pick(WINDOWS), { zone: tz }).plus({
        minutes: Math.floor(r() * 10 * 24 * 60),
      })
      vi.setSystemTime(clock.toJSDate())
      db.prepare('UPDATE users SET last_rollover_date = ? WHERE id = ?').run(
        clock.minus({ days: 1 }).toISODate(),
        TEST_USER_ID,
      )
      const rrule = pick(RULES)
      const deadlineAnchored = r() < 0.7
      const first = clock.plus({ days: 1 + Math.floor(r() * 10) }).set({
        hour: Number(/BYHOUR=(\d+)/.exec(rrule)![1]),
        minute: 0,
      })
      const t = createTask({
        ...u,
        input: deadlineAnchored
          ? { title: `ra ${c}`, rrule, deadline_at: first.toUTC().toISO()! }
          : { title: `ra ${c}`, rrule, due_at: first.toUTC().toISO()! },
      })
      let moved = false
      const label = (step: string) => `seed ${SEED8} case ${c} ${step}`
      const hour = (task: Task) => Number(/BYHOUR=(\d+)/.exec(task.rrule!)![1])
      const patchSchedule = (op: number, task: Task) => {
        const deadlineRule = task.repeat_anchor === 'deadline'
        if (op === 6 && deadlineRule) {
          const to = DateTime.fromISO(task.occurrence_at!, { zone: 'utc' })
            .setZone(tz)
            .plus({ days: Math.floor(r() * 4) - 1 })
          updateTask({ ...u, taskId: t.id, input: { deadline_at: to.toUTC().toISO()! } })
        } else if (op === 7 && deadlineRule) {
          const time = `${String(6 + Math.floor(r() * 16)).padStart(2, '0')}:00`
          const input = { target_days_before: Math.floor(r() * 3), target_time: time }
          updateTask({ ...u, taskId: t.id, input })
        } else if (op === 8) {
          const timed = `FREQ=WEEKLY;BYDAY=${pick(['MO', 'WE', 'SA'])};BYHOUR=${hour(task)};BYMINUTE=0`
          const anchor = deadlineRule ? 'target' : 'deadline'
          updateTask({ ...u, taskId: t.id, input: { repeat_anchor: anchor, rrule: timed } })
        }
      }
      const checkTask = (step: string) => {
        const task = getTaskById(t.id)!
        const l = label(step)
        if (task.repeat_anchor === 'deadline') {
          expect(task.deadline_at, `${l}: I1`).not.toBeNull()
          expect(task.deadline_at, `${l}: I2`).toBe(task.occurrence_at)
          expect(task.queued_at, `${l}: queued`).toBeNull()
        } else {
          expect(task.deadline_at, `${l}: I1 (target-anchored)`).toBeNull()
        }
        if (task.on_deck_day) return
        expect(task.due_at, `${l}: no target off deck`).not.toBeNull()
        // A target-anchored repeat waiting in the queue holds its NEXT
        // occurrence's target over the missed one (B3): not a move.
        if (task.queued_at) return
        const derived = occurrenceDates(task, task.occurrence_at!, tz).targetAt
        if (!moved) expect(task.due_at, `${l}: not the derivation`).toBe(derived)
        if (task.deadline_at && Date.parse(task.deadline_at) > Date.now()) {
          expect(Date.parse(task.due_at!), `${l}: after the deadline`).toBeLessThanOrEqual(
            Date.parse(task.deadline_at),
          )
        }
      }
      checkTask('create')
      for (let s = 0; s < 8; s++) {
        clock = clock.plus({ minutes: Math.floor(r() * 3 * 24 * 60) })
        vi.setSystemTime(clock.toJSDate())
        const op = Math.floor(r() * 9)
        const step = `op ${s}:${op}`
        const before = getTaskById(t.id)!
        if (op >= 6) {
          // The PATCH writes (plan §3.2): a deadline reschedule, new offsets,
          // an anchor switch. A refusal (400) is part of the contract.
          try {
            patchSchedule(op, before)
          } catch (err) {
            if (!(err instanceof ValidationError)) throw err
          }
        } else if (op === 0) {
          const to = clock.plus({ minutes: Math.round((r() * 2 - 0.5) * 6 * 24 * 60) })
          updateTask({ ...u, taskId: t.id, input: { due_at: to.toUTC().toISO()! } })
        } else if (op === 1) {
          markDone({ ...u, taskId: t.id })
          expect(targetMoved(getTaskById(t.id)!, tz), label(`${step}: moved after done`)).toBe(
            false,
          )
        } else if (op === 2) {
          skipOccurrence({ ...u, taskId: t.id })
          expect(targetMoved(getTaskById(t.id)!, tz), label(`${step}: moved after skip`)).toBe(
            false,
          )
        } else if (op === 3) {
          const until = clock.plus({ days: 1 + Math.floor(r() * 20) }).toISODate()!
          skipUntil({ ...u, taskIds: [t.id], until })
        } else {
          const day = op === 4 ? clock.plus({ days: Math.floor(r() * 3) }).toISODate()! : null
          deckTasks({ userId: TEST_USER_ID, timezone: tz, ids: [t.id], day })
        }
        // A move leaves the target moved (or not, capped back onto the
        // derivation), and so may a PATCH (a moved target is kept); every
        // other write lands on the derivation.
        moved = op === 0 || op >= 6 ? targetMoved(getTaskById(t.id)!, tz) : moved
        const written = getTaskById(t.id)!
        if (
          op !== 0 &&
          op < 6 &&
          (written.occurrence_at !== before.occurrence_at || written.due_at !== before.due_at)
        ) {
          moved = false
        }
        // The rollover, as the minute cron would run it: a roll or a deck's
        // end lands on the derivation too.
        runTaskRollover({ now: clock.toJSDate(), userId: TEST_USER_ID })
        const rolled = getTaskById(t.id)!
        if (
          rolled.occurrence_at !== written.occurrence_at ||
          rolled.on_deck_day !== written.on_deck_day
        ) {
          moved = false
        }
        checkTask(step)
        wrote++
      }
    }
    expect(wrote).toBe(40 * 8)
  }, 30_000)
})
