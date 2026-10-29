/**
 * THE DASHBOARD MODES THROUGH THE DAYS (evals, 2026-10-28): the mode
 * sections (`src/lib/modes/`), the lean row's tint (`leanRowState`) and the
 * clock's tap (`clockTap`) read off the REAL core as the day simulator steps
 * the clock — the rollover, a defer, a deck, Today — so a change to a date
 * rule that moves a row between sections fails here.
 *
 * Chicago, the task queue on, the default 3:00 AM day start; Tue 2026-11-03
 * to Fri 11-06 (no clock change). Each snapshot reads the open tasks the way
 * the dashboard does (`getTasks`) and selects Today's and Scan's sections at
 * that moment.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { DateTime } from 'luxon'
import { createTask, getTasks } from '@/core/tasks'
import { deckTasks } from '@/core/tasks/deck'
import { dayBoundaryForUser } from '@/core/tasks/rollover-time'
import { snoozeTask } from '@/core/tasks/snooze'
import { considerTasks, targetTasksToday } from '@/core/tasks/task-segments'
import { getDb } from '@/core/db'
import { simulateDays, type SimEvent } from '@/core/sim/day-simulator'
import { clockTap, type ClockTap } from '@/lib/lean-clock'
import { leanRowState, type LeanRowState } from '@/lib/lean-row-state'
import { MODES } from '@/lib/modes/registry'
import { selectSections } from '@/lib/modes/select'
import type { SectionView } from '@/lib/modes/types'
import { isOverdue } from '@/lib/task-counts'
import type { Task } from '@/types'
import { setupTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

const TZ = TEST_TIMEZONE
const local = (s: string) => DateTime.fromISO(s, { zone: TZ })
const iso = (s: string) => local(s).toUTC().toISO()!

interface Snap {
  today: SectionView[]
  scan: SectionView[]
  tasks: Map<number, Task>
  now: Date
  dayStart: string
}
const snaps: Record<string, Snap> = {}
const taps: Record<string, ClockTap> = {}
const ids: Record<string, number> = {}

function snap(label: string) {
  const now = new Date()
  const tasks = getTasks({ userId: TEST_USER_ID, done: false })
  const dayStart = dayBoundaryForUser(TEST_USER_ID)
  const ctx = { now, timezone: TZ, dayStart }
  snaps[label] = {
    today: selectSections(tasks, MODES.today.sections!, ctx),
    scan: selectSections(tasks, MODES['pick-mode'].sections!, ctx),
    tasks: new Map(tasks.map((t) => [t.id, t])),
    now,
    dayStart,
  }
}

/** The sections of a mode that hold the task, at a snapshot. */
function where(label: string, mode: 'today' | 'scan', name: string): string[] {
  const id = ids[name]
  return snaps[label][mode].filter((v) => v.tasks.some((t) => t.id === id)).map((v) => v.id)
}
/** The task ids of one section, in order, as names. */
function rows(label: string, mode: 'today' | 'scan', section: string): string[] {
  const byId = new Map(Object.entries(ids).map(([n, id]) => [id, n]))
  const view = snaps[label][mode].find((v) => v.id === section)
  return (view?.tasks ?? []).map((t) => byId.get(t.id) ?? `#${t.id}`)
}
function tint(label: string, name: string): LeanRowState | null {
  const s = snaps[label]
  const task = s.tasks.get(ids[name])!
  return leanRowState(task, isOverdue(task, s.now), TZ, s.dayStart, s.now)
}
function tap(label: string, name: string) {
  const task = getTasks({ userId: TEST_USER_ID, done: false }).find((t) => t.id === ids[name])!
  taps[label] = clockTap(task, isOverdue(task, new Date()))
}

const u = { userId: TEST_USER_ID, userTimezone: TZ }
const make = (name: string, input: Record<string, unknown>) => {
  ids[name] = createTask({ ...u, input: { title: name, ...input } }).id
}

const events: SimEvent[] = [
  {
    at: '2026-11-03T08:00',
    run: () => {
      make('later', { due_at: iso('2026-11-03T15:00') })
      make('idle', { due_at: iso('2026-11-03T10:00') })
      make('net', { deadline_at: iso('2026-11-05T17:00') })
      make('deck', { horizon: 'weeks' })
      make('weeks', { horizon: 'weeks' })
      make('unset', {})
      make('coming', { deadline_at: iso('2026-11-07T12:00') })
      make('clock', { horizon: 'days' })
      deckTasks({ userId: TEST_USER_ID, timezone: TZ, ids: [ids.deck], day: '2026-11-03' })
    },
  },
  { at: '2026-11-03T10:30', run: () => snap('tue 10:30') },
  {
    // The clock through its three taps: Today, then (due) defer, then (not due) the menu.
    at: '2026-11-03T11:00',
    run: () => {
      tap('untargeted', 'clock')
      targetTasksToday(TEST_USER_ID, TZ, [ids.clock], iso('2026-11-03T10:59'))
      tap('targeted, due', 'clock')
      snoozeTask({ ...u, taskId: ids.clock, until: iso('2026-11-03T23:00') })
      tap('deferred, not due', 'clock')
    },
  },
  { at: '2026-11-03T16:00', run: () => snap('tue 16:00') },
  {
    at: '2026-11-03T16:05',
    run: () => snoozeTask({ ...u, taskId: ids.later, until: iso('2026-11-04T09:00') }),
  },
  { at: '2026-11-03T17:00', run: () => snap('tue 17:00') },
  { at: '2026-11-04T02:59', run: () => snap('wed 02:59') },
  // The rollover runs at Wed 03:00 (the day start).
  { at: '2026-11-04T03:01', run: () => snap('wed 03:01') },
  { at: '2026-11-04T10:00', run: () => snap('wed 10:00') },
  // Considering a pulled one-off: out of the queue, so out of Pulled.
  { at: '2026-11-04T10:30', run: () => considerTasks(TEST_USER_ID, [ids.idle]) },
  { at: '2026-11-04T10:31', run: () => snap('wed 10:31') },
  { at: '2026-11-05T10:00', run: () => snap('thu 10:00') },
  { at: '2026-11-05T18:00', run: () => snap('thu 18:00') },
]

describe('the dashboard modes through the days', () => {
  beforeAll(() => {
    vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
    setupTestDb()
    getDb()
      .prepare("UPDATE users SET last_rollover_date = '2026-11-02' WHERE id = ?")
      .run(TEST_USER_ID)
    simulateDays({
      userId: TEST_USER_ID,
      timezone: TZ,
      from: '2026-11-03',
      days: 3,
      at: '23:59',
      policy: 'never',
      rollover: true,
      events,
      taskIds: () => Object.values(ids),
      setClock: (d) => vi.setSystemTime(d),
    })
  })
  afterAll(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  test('a target through its day: later today, over target, deferred out, back in after 3 AM', () => {
    expect(where('tue 10:30', 'today', 'later')).toEqual(['today'])
    expect(tint('tue 10:30', 'later')).toBe('soon')
    // Its time passes: the same section, now over target (no jump).
    expect(where('tue 16:00', 'today', 'later')).toEqual(['today'])
    expect(tint('tue 16:00', 'later')).toBe('over')
    // Deferred to Wed 09:00: out of Today…
    expect(where('tue 17:00', 'today', 'later')).toEqual([])
    // …still out at 02:59 (Tuesday's OpenTask day), back at 03:01.
    expect(where('wed 02:59', 'today', 'later')).toEqual([])
    expect(where('wed 03:01', 'today', 'later')).toEqual(['today'])
    expect(tint('wed 03:01', 'later')).toBe('soon')
    expect(where('wed 10:00', 'today', 'later')).toEqual(['today'])
    expect(tint('wed 10:00', 'later')).toBe('over')
  })

  test("Today's order: by time, past times first", () => {
    expect(rows('tue 10:30', 'today', 'today')).toEqual(['idle', 'later'])
    expect(rows('tue 17:00', 'today', 'today')).toEqual(['idle', 'clock'])
  })

  test('the deadline safety net: in Today from the day before the deadline, not before', () => {
    expect(where('tue 17:00', 'today', 'net')).toEqual([])
    // 02:59 Wed is still Tuesday's OpenTask day.
    expect(where('wed 02:59', 'today', 'net')).toEqual([])
    expect(where('wed 03:01', 'today', 'net')).toEqual(['today'])
    expect(where('thu 10:00', 'today', 'net')).toEqual(['today'])
  })

  test("a deck: On deck on its day; the rollover moves an undone deck to Scan's Pulled", () => {
    expect(where('tue 10:30', 'today', 'deck')).toEqual(['on-deck'])
    expect(where('wed 03:01', 'today', 'deck')).toEqual([])
    expect(where('wed 03:01', 'scan', 'deck')).toContain('pulled')
  })

  test('Pulled fills at the rollover: missed targets and decks, the latest day missed first', () => {
    expect(snaps['wed 02:59'].scan.find((v) => v.id === 'pulled')).toBeUndefined()
    // Same pull; then the day missed, latest first: the clock's Tue 23:00,
    // idle's Tue 10:00, then the deck's day (Tue, from its start).
    expect(rows('wed 03:01', 'scan', 'pulled')).toEqual(['clock', 'idle', 'deck'])
    // Out of Today once stripped: no target, nothing due.
    expect(where('wed 03:01', 'today', 'idle')).toEqual([])
  })

  test('considering a pulled task takes it out of Pulled, and counts as a touch', () => {
    expect(rows('wed 10:31', 'scan', 'pulled')).toEqual(['clock', 'deck'])
    const s = snaps['wed 10:31']
    const byTouch = selectSections(
      [...s.tasks.values()],
      MODES['pick-mode'].sections!,
      { now: s.now, timezone: TZ, dayStart: s.dayStart },
      { id: 'touched', everywhere: true },
    )
    expect(byTouch.find((v) => v.id === 'newest')!.tasks[0].id).toBe(ids.idle)
  })

  test('Coming up: a deadline within three OpenTask days', () => {
    // Sat noon from Wed is three days out; from Thu, two.
    expect(where('wed 10:00', 'scan', 'coming')).not.toContain('coming-up')
    expect(where('thu 10:00', 'scan', 'coming')).toContain('coming-up')
  })

  test('the horizon sections hold their one-offs every day; Newest holds every task', () => {
    for (const label of ['tue 10:30', 'wed 03:01', 'thu 10:00']) {
      expect(where(label, 'scan', 'weeks')).toEqual(['newest', 'horizon-weeks'])
      expect(where(label, 'scan', 'unset')).toEqual(['newest', 'horizon-unset'])
    }
    // A dated task is in no horizon section.
    expect(where('tue 10:30', 'scan', 'net')).not.toContain('horizon-unset')
  })

  test("the clock's three taps: Today when untargeted, defer when due, the menu when not", () => {
    expect(taps).toEqual({
      untargeted: 'target-today',
      'targeted, due': 'defer',
      'deferred, not due': 'menu',
    })
  })

  test('a passed deadline with no target: red, and still in Today', () => {
    // Thu 18:00: the deadline (Thu 17:00) has passed.
    expect(tint('thu 18:00', 'net')).toBe('passed')
    expect(where('thu 18:00', 'today', 'net')).toEqual(['today'])
  })
})
