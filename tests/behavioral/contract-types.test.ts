/**
 * Contract fixtures vs the TS types (testing pass WP5, 2026-09-25)
 *
 * The fixtures in `tests/fixtures/contract/` are the live responses of a
 * fixed scenario, captured by `tests/integration/contract-fixtures.test.ts`
 * (see its header for the scenario and how to rewrite them). The Swift
 * decode tests read the same files. This file checks them against the
 * server's own types, in both directions:
 *
 * - STATIC: each field table below is typed `Record<keyof T, Kind>`, so
 *   adding, removing or renaming a field on `QuotaPrompt` / `FormattedTask` /
 *   `TimeSlot` / `QuotaDayState` fails `tsc` until the table follows.
 * - RUNTIME: every object of that kind in the fixtures carries exactly the
 *   table's keys, with values of the table's JSON kinds.
 *
 * A direct `const p: QuotaPrompt = fixture...` can't do this: a JSON import
 * widens `"DAILY"` to `string`, so it would never type-check. The enum
 * domains (`period`, `stripe_color`, `recurrence_mode`) are checked at
 * runtime instead.
 */

import fs from 'fs'
import path from 'path'
import { describe, test, expect } from 'vitest'
import {
  groupConsidered,
  groupWaiting,
  parsePromptKey,
  promptWaiting,
  type PromptPeriod,
  type QuotaPrompt,
} from '@/lib/quota-prompts'
import type { FormattedTask } from '@/lib/format-task'
import type { TimeSlot } from '@/lib/time-slot-assign'
import type { TaskCounts } from '@/lib/task-counts'
import type { LabelColor, QuotaDayState } from '@/types'

const DIR = path.join(process.cwd(), 'tests', 'fixtures', 'contract')

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type Obj = Record<string, Json>

function fixture(name: string): Obj {
  return JSON.parse(fs.readFileSync(path.join(DIR, `${name}.json`), 'utf-8')) as Obj
}

function data(name: string): Obj {
  return fixture(name).data as Obj
}

// ---------------------------------------------------------------------------
// Field tables
// ---------------------------------------------------------------------------

type Kind = 'number' | 'string' | 'boolean' | 'array' | 'object'
/** A field's allowed JSON kinds; `null` in the list = nullable. */
type Field = readonly (Kind | 'null')[]

const INT: Field = ['number']
const STR: Field = ['string']
const BOOL: Field = ['boolean']
const INT_N: Field = ['number', 'null']
const STR_N: Field = ['string', 'null']

const PERIODS: readonly PromptPeriod[] = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']
const LABEL_COLORS: readonly LabelColor[] = [
  'red',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink',
  'gray',
]

const QUOTA_PROMPT: Record<keyof QuotaPrompt, Field> = {
  prompt_key: STR,
  task_id: INT,
  number: INT_N,
  numbers: ['array', 'null'],
  slot_id: INT_N,
  title: STR,
  current: INT,
  target: INT,
  period: STR_N,
  period_interval: INT_N,
  period_end: STR_N,
  period_last_day: STR_N,
  period_label: STR_N,
  stripe_color: STR_N,
  has_notes: BOOL,
  priority: INT,
  considered: BOOL,
  done: BOOL,
}

const TASK: Record<keyof FormattedTask, Field> = {
  id: INT,
  user_id: INT,
  project_id: INT,
  title: STR,
  original_title: STR_N,
  short_title: STR_N,
  done: BOOL,
  done_at: STR_N,
  priority: INT,
  due_at: STR_N,
  rrule: STR_N,
  recurrence_mode: STR,
  anchor_time: STR_N,
  anchor_dow: INT_N,
  anchor_dom: INT_N,
  repeat_anchor: STR_N,
  target_days_before: INT_N,
  target_time: STR_N,
  target_slot_id: INT_N,
  repeat_count: INT_N,
  repeat_count_used: INT,
  repeat_until: STR_N,
  repeat_last: BOOL,
  repeat_remaining: INT_N,
  original_due_at: STR_N,
  deadline_at: STR_N,
  horizon: STR_N,
  horizon_set_at: STR_N,
  last_considered_at: STR_N,
  segment_deferred_at: STR_N,
  segment_targeted_at: STR_N,
  target_set_at: STR_N,
  occurrence_at: STR_N,
  target_auto: BOOL,
  deadline_nag_off: BOOL,
  attempts: INT,
  attempts_counted_through: STR_N,
  growth_kept_at: STR_N,
  queue_mark: BOOL,
  try_tomorrow: BOOL,
  queued_at: STR_N,
  queued_from_due_at: STR_N,
  on_deck_day: STR_N,
  queued_from_deck_day: STR_N,
  lead_days: INT_N,
  lead_from: STR_N,
  rolled_over_at: STR_N,
  attempts_label: STR_N,
  attempts_offer: STR_N,
  age_label: STR_N,
  target_at: STR_N,
  last_notified_at: STR_N,
  last_critical_alert_at: STR_N,
  auto_snooze_minutes: INT_N,
  deleted_at: STR_N,
  archived_at: STR_N,
  labels: ['array'],
  progress_target: INT,
  progress_current: INT,
  is_tracked: BOOL,
  progress_period_start: STR_N,
  progress_period_end: STR_N,
  period_interval: INT_N,
  period_last_day: STR_N,
  period_label: STR_N,
  quota_prompt_config: ['object', 'null'],
  quota_day_state: ['object', 'null'],
  is_reminder: BOOL,
  completion_count: INT,
  skip_count: INT,
  first_completed_at: STR_N,
  last_completed_at: STR_N,
  notes: STR_N,
  created_at: STR,
  updated_at: STR,
  is_recurring: BOOL,
}

/**
 * The keys a task segment row adds to a FormattedTask: its state, `recurring`
 * and — Upcoming rows only (2026-10-25) — `upcoming_section`.
 */
const SEGMENT_ROW_EXTRAS = new Set(['segment_state', 'recurring', 'upcoming_section'])

const TASK_COUNTS: Record<keyof TaskCounts, Field> = {
  total: INT,
  overdue: INT,
  today: INT,
}

const TIME_SLOT: Record<keyof TimeSlot, Field> = {
  id: INT,
  user_id: INT,
  label: STR,
  start_time: STR,
  sort_order: INT,
  created_at: STR,
}

const QUOTA_DAY_STATE: Record<keyof QuotaDayState, Field> = {
  date: STR,
  logged: INT,
  did: ['array'],
  considered: ['array'],
  did_applied: ['object'],
}

function kindOf(v: Json): Kind | 'null' {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v as Kind
}

/** Exactly the table's keys, each value of an allowed kind. */
function expectShape(obj: Json, table: Record<string, Field>, what: string) {
  expect(kindOf(obj), what).toBe('object')
  const o = obj as Obj
  expect(Object.keys(o).sort(), `${what}: keys`).toEqual(Object.keys(table).sort())
  for (const [key, allowed] of Object.entries(table)) {
    expect(allowed, `${what}.${key} is ${kindOf(o[key])}`).toContain(kindOf(o[key]))
  }
}

// ---------------------------------------------------------------------------
// Collectors
// ---------------------------------------------------------------------------

interface Group extends Obj {
  slot: Obj | null
  reminders: Obj[]
  considered_items: Obj[]
  prompts: Obj[]
}

const REMINDER_FIXTURES = [
  'reminders-initial',
  'reminders-after-did',
  'reminders',
  'reminders-segments',
  'reminders-upcoming',
  'reminders-interval',
]

function groups(name: string): Group[] {
  return data(name).groups as Group[]
}

/** Every task-shaped object in every fixture that carries tasks. */
function allTasks(): { where: string; task: Obj }[] {
  const out: { where: string; task: Obj }[] = []
  for (const name of REMINDER_FIXTURES) {
    groups(name).forEach((g, i) => {
      for (const t of [...g.reminders, ...g.considered_items])
        out.push({ where: `${name}[${i}]`, task: t })
    })
    for (const t of data(name).not_today as Obj[]) out.push({ where: `${name}.not_today`, task: t })
  }
  for (const t of data('tasks').tasks as Obj[]) out.push({ where: 'tasks', task: t })
  for (const t of data('quota-prompts-did').tasks as Obj[]) {
    out.push({ where: 'quota-prompts-did', task: t })
  }
  return out
}

// ---------------------------------------------------------------------------

describe('contract fixtures match the TS types', () => {
  test('every prompt is exactly a QuotaPrompt', () => {
    let seen = 0
    for (const name of REMINDER_FIXTURES) {
      for (const g of groups(name)) {
        for (const p of g.prompts) {
          seen++
          expectShape(p, QUOTA_PROMPT, `${name} prompt ${p.prompt_key}`)
          const prompt = p as unknown as QuotaPrompt
          if (prompt.period !== null) expect(PERIODS).toContain(prompt.period)
          if (prompt.stripe_color !== null) {
            expect(LABEL_COLORS).toContain(prompt.stripe_color)
            // Green is "met" on quota chips; a stripe never spends it.
            expect(prompt.stripe_color).not.toBe('green')
          }
          const key = parsePromptKey(prompt.prompt_key)
          expect(key, prompt.prompt_key).not.toBeNull()
          expect(key!.taskId).toBe(prompt.task_id)
          // Daily rows are keyed by their number; everything else by 0.
          expect(key!.number).toBe(prompt.number ?? 0)
          if (prompt.numbers) expect(prompt.numbers[prompt.numbers.length - 1]).toBe(prompt.number)
          // A prompt sits in the group of its own slot.
          expect(prompt.slot_id).toBe((g.slot?.id as number | undefined) ?? null)
        }
      }
    }
    // Two daily rows, weekly, monthly — in each of the six captures — plus
    // the every-2-weeks quota in the last (reminders-interval).
    expect(seen).toBe(25)
  })

  test('group counts agree with the shared counting helpers', () => {
    for (const name of REMINDER_FIXTURES) {
      const d = data(name)
      let waiting = 0
      let considered = 0
      for (const g of groups(name)) {
        const prompts = g.prompts as unknown as QuotaPrompt[]
        const promptsWaiting = prompts.filter(promptWaiting).length
        expect(g.count).toBe(g.reminders.length)
        expect(g.considered).toBe(g.considered_items.length)
        expect(g.prompts_waiting).toBe(promptsWaiting)
        expect(g.prompts_considered).toBe(prompts.length - promptsWaiting)
        const countable = {
          reminders: g.reminders,
          considered: g.considered as number,
          prompts,
        }
        waiting += groupWaiting(countable)
        considered += groupConsidered(countable)
      }
      expect(waiting).toBe((d.total as number) + (d.prompts_total as number))
      expect(considered).toBe(
        (d.considered_total as number) + (d.prompts_considered_total as number),
      )
    }
  })

  test('every task is exactly a FormattedTask', () => {
    const tasks = allTasks()
    expect(tasks.length).toBeGreaterThan(10)
    for (const { where, task } of tasks) {
      expectShape(task, TASK, `${where} task ${task.id}`)
      expect(['from_due', 'from_completion']).toContain(task.recurrence_mode)
      if (task.quota_day_state !== null) {
        expectShape(task.quota_day_state, QUOTA_DAY_STATE, `${where} task ${task.id} day state`)
      }
    }
  })

  test('task segments: each row is a FormattedTask plus segment_state and recurring', () => {
    // 2026-10-10. A top-level array beside `groups`, never inside it.
    // 2026-10-12: Upcoming is one more entry, `horizon: "upcoming"`, and every
    // row says whether it is a repeating task's occurrence (`recurring`).
    const segs = data('reminders-segments').task_segments as Obj[]
    expect(segs.length).toBe(1)
    const upcoming = data('reminders-upcoming').task_segments as Obj[]
    for (const seg of [...segs, ...upcoming]) {
      expect(['days', 'upcoming', 'weeks', 'months', 'eventually']).toContain(seg.horizon)
      for (const k of ['waiting', 'considered', 'deferred']) expect(typeof seg[k]).toBe('number')
      expect(typeof seg.nudge).toBe('boolean')
      for (const row of seg.tasks as Obj[]) {
        expect(['waiting', 'considered', 'deferred']).toContain(row.segment_state)
        expect(typeof row.recurring).toBe('boolean')
        const task = Object.fromEntries(
          Object.entries(row).filter(([k]) => !SEGMENT_ROW_EXTRAS.has(k)),
        )
        expectShape(task, TASK, `segment task ${row.id}`)
      }
    }
    expect(data('task-segments-consider').considered).toBe(1)
  })

  test('Upcoming: a one-off with a deadline and a repeating row, in target order', () => {
    const seg = (data('reminders-upcoming').task_segments as Obj[]).find(
      (s) => s.horizon === 'upcoming',
    )!
    const rows = seg.tasks as Obj[]
    expect(rows.map((r) => r.recurring)).toEqual([false, true])
    expect(rows[0].deadline_at).not.toBeNull()
    expect(rows[1].rrule).not.toBeNull()
    for (const r of rows) expect(r.segment_state).toBe('waiting')
    expect(seg.waiting).toBe(2)
  })

  test('target-today moves a repeating task too; skipped_recurring stays, always empty (§6)', () => {
    const d = data('task-segments-target-today-repeating')
    expect(d.affected).toBe(1)
    expect(d.skipped_recurring).toEqual([])
    expect(typeof d.until).toBe('string')
  })

  test('user preferences carry check_in_day, 1 (Monday) … 7 (Sunday)', () => {
    expect(data('user-preferences').check_in_day).toBe(6)
  })

  test('the progress response is a FormattedTask plus met/description', () => {
    const d = data('task-progress')
    expect(typeof d.undo_id).toBe('number')
    expect(typeof d.met).toBe('boolean')
    expect(typeof d.description).toBe('string')
    const task = Object.fromEntries(
      Object.entries(d).filter(([k]) => !['met', 'description', 'undo_id'].includes(k)),
    )
    expectShape(task, TASK, 'task-progress')
  })

  test('every slot is exactly a TimeSlot', () => {
    const slots = data('time-slots').time_slots as Obj[]
    expect(slots.length).toBeGreaterThan(1)
    for (const s of slots) expectShape(s, TIME_SLOT, `time-slot ${s.id}`)
    for (const name of REMINDER_FIXTURES) {
      for (const g of groups(name)) if (g.slot) expectShape(g.slot, TIME_SLOT, `${name} slot`)
    }
  })

  test('scenario pins: the values every native surface reads', () => {
    const prompts = groups('reminders').flatMap((g) => g.prompts as unknown as QuotaPrompt[])
    const byTitle = (t: string) => prompts.filter((p) => p.title === t)
    const daily = byTitle('Drink water')
    expect(daily.map((p) => [p.number, p.done, p.considered, p.current])).toEqual([
      [1, true, true, 1],
      [2, false, false, 1],
    ])
    expect(daily[0].slot_id).not.toBe(daily[1].slot_id)
    expect(daily.every((p) => p.stripe_color === 'purple' && p.has_notes)).toBe(true)
    expect(byTitle('Go for a run')[0]).toMatchObject({ done: true, considered: true, current: 1 })
    expect(byTitle('Call a friend')[0]).toMatchObject({ done: false, considered: false })
  })

  test('preferences carry the label_config the Quotas widget colours from', () => {
    // The apps decode only `label_config` from this payload
    // (`UserPreferencesLabelConfigPage`): an array of { name, color }.
    const labels = data('user-preferences').label_config as Obj[]
    for (const l of labels) {
      expect(Object.keys(l).sort()).toEqual(['color', 'name'])
      expect(LABEL_COLORS).toContain(l.color)
    }
    expect(labels).toEqual([{ name: 'personal', color: 'purple' }])
  })

  test('the task counts are exactly a TaskCounts (the apps’ foreground badge)', () => {
    const counts = data('task-counts')
    expectShape(counts, TASK_COUNTS, 'task-counts')
    // User B's seeded task (due tomorrow) and the one three days late; the
    // quotas and reminders are not counted.
    expect(counts).toEqual({ total: 2, overdue: 1, today: 0 })
  })
})

describe('contract fixtures: Upcoming sections (2026-10-25)', () => {
  test('Upcoming sections (2026-10-25): every Upcoming row carries upcoming_section, Tomorrow first', () => {
    // One `upcoming` kind (a shipped native build would list a new kind as a
    // page of its own); each row says its section. No other kind carries it.
    const captures = [
      'reminders-upcoming',
      'reminders-upcoming-sections',
      'reminders-deck',
      'reminders-queue',
      'reminders-interval',
      'reminders-deadlines',
      'reminders-deadlines-plain',
    ]
    for (const name of captures) {
      for (const seg of data(name).task_segments as Obj[]) {
        const rows = seg.tasks as Obj[]
        if (seg.horizon !== 'upcoming') {
          for (const r of rows) expect(r.upcoming_section, `${name} ${seg.horizon}`).toBeUndefined()
          continue
        }
        const sections = rows.map((r) => r.upcoming_section)
        for (const v of sections) expect(['tomorrow', 'later'], name).toContain(v)
        // Tomorrow's rows first.
        expect(sections, name).toEqual(
          [...sections].sort((a, b) => (a === b ? 0 : a === 'tomorrow' ? -1 : 1)),
        )
      }
    }
    const seg = (data('reminders-upcoming-sections').task_segments as Obj[]).find(
      (s) => s.horizon === 'upcoming',
    )!
    const sections = (seg.tasks as Obj[]).map((r) => r.upcoming_section)
    expect(sections).toContain('tomorrow')
    expect(sections).toContain('later')
  })
})

describe('contract fixtures: the task queue (PR 3)', () => {
  test('user preferences carry the rollover time; the switch is not captured (PR 3)', () => {
    const prefs = data('user-preferences')
    // `task_queue` is the server's switch: not captured (pinServerEnvironment).
    expect(prefs).not.toHaveProperty('task_queue')
    expect(prefs.rollover_time).toMatch(/^\d{2}:\d{2}$/)
  })

  test('the task queue panels: first, sorted by priority, every row a segment row', () => {
    // Task queue PR 3: `queue_today` and `queue_previous` come before every
    // other segment. A native build that predates them drops the unknown
    // kinds (Swift `SegmentKind(raw:)` returns nil) — the rows are otherwise
    // ordinary segment rows, with `queued_from_due_at` and `try_tomorrow`.
    const segs = data('reminders-queue').task_segments as Obj[]
    expect(segs.slice(0, 2).map((s) => s.horizon)).toEqual(['queue_today', 'queue_previous'])
    const [today, previous] = segs as { tasks: Obj[] }[]
    expect(today.tasks.map((r) => r.priority)).toEqual([2, 0])
    expect(today.tasks.map((r) => r.try_tomorrow)).toEqual([false, true])
    expect(previous.tasks.map((r) => r.recurring)).toEqual([false, true])
    for (const seg of segs) {
      for (const row of seg.tasks as Obj[]) {
        expect(['waiting', 'considered', 'deferred']).toContain(row.segment_state)
        const task = Object.fromEntries(
          Object.entries(row).filter(([k]) => !SEGMENT_ROW_EXTRAS.has(k)),
        )
        expectShape(task, TASK, `queue task ${row.id}`)
      }
    }
    for (const seg of segs.slice(0, 2)) {
      for (const row of seg.tasks as Obj[]) {
        expect(row.queued_at).not.toBeNull()
        expect(row.queued_from_due_at).not.toBeNull()
      }
    }
    // A waiting repeating task keeps its next occurrence as its target; a
    // stripped one-off has none.
    expect(previous.tasks[0].due_at).toBeNull()
    expect(previous.tasks[1].due_at).not.toBeNull()
  })
})

describe('contract fixtures: interval quotas', () => {
  test('an interval quota serves its period on the task and on its prompt (2026-10-16)', () => {
    const task = data('task-interval-quota')
    expectShape(task, TASK, 'task-interval-quota')
    expect(task).toMatchObject({
      rrule: 'FREQ=WEEKLY;INTERVAL=2',
      period_interval: 2,
      period_label: 'by Jan 15', // pinned by the fixture writer
    })
    expect(task.progress_period_start).not.toBeNull()
    expect(task.progress_period_end).not.toBeNull()
    const prompt = groups('reminders-interval')
      .flatMap((g) => g.prompts as unknown as QuotaPrompt[])
      .find((p) => p.title === 'Deep-clean the oven')!
    expect(prompt).toMatchObject({
      period: 'WEEKLY',
      period_interval: 2,
      period_label: 'by Jan 15',
    })
    // Interval 1 serves no label: clients keep their own words.
    const run = groups('reminders-interval')
      .flatMap((g) => g.prompts as unknown as QuotaPrompt[])
      .find((p) => p.title === 'Go for a run')!
    expect(run).toMatchObject({ period_interval: 1, period_label: null })
  })
})

describe('contract fixtures: on deck (2026-10-20)', () => {
  test('a future deck is an Upcoming row (with ?deck=1), every row a segment row with on_deck_day', () => {
    // `GET /api/reminders?queue=1&deck=1`: a one-off on deck for tomorrow, on
    // its heads-up day. A plain segment row with `on_deck_day` set and no
    // target — the native PR draws "On deck …" from it.
    const segs = data('reminders-deck').task_segments as Obj[]
    const upcoming = segs.find((s) => s.horizon === 'upcoming') as { tasks: Obj[] }
    // A repeating task on deck too (2026-10-20): `recurring: true`, no target
    // while decked, its `occurrence_at` kept.
    const decked = upcoming.tasks.filter((r) => r.on_deck_day !== null)
    expect(decked).toHaveLength(2)
    expect(decked.map((r) => r.recurring).sort()).toEqual([false, true])
    for (const row of decked) {
      expect(row).toMatchObject({ due_at: null, target_at: null })
      expect(row.on_deck_day).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
    const repeating = decked.find((r) => r.recurring)!
    expect(repeating.rrule).toEqual(expect.any(String))
    expect(repeating.occurrence_at).toEqual(expect.any(String))
    for (const seg of segs) {
      for (const row of seg.tasks as Obj[]) {
        const task = Object.fromEntries(
          Object.entries(row).filter(([k]) => !SEGMENT_ROW_EXTRAS.has(k)),
        )
        expectShape(task, TASK, `deck fixture task ${row.id}`)
      }
    }
  })
})

describe('contract fixtures: the deadlines page (2026-10-22)', () => {
  test('`deadlines` comes first; its rows are segment rows plus safety_net and seen, with no target', () => {
    // `GET /api/reminders?queue=1&deck=1&deadlines=1`: three target-less
    // deadline tasks — the passed one in the safety net, the repeat, the one-off.
    const segs = data('reminders-deadlines').task_segments as Obj[]
    expect(segs[0].horizon).toBe('deadlines')
    const rows = (segs[0] as { tasks: Obj[] }).tasks
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => [r.safety_net, r.seen, r.recurring])).toEqual([
      [true, false, false],
      [false, false, true],
      [false, false, false],
    ])
    for (const row of rows) {
      expect(row).toMatchObject({ due_at: null, target_at: null, target_auto: false })
      expect(row.deadline_at).toEqual(expect.any(String))
      expect(row.lead_from).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      // Old builds' implied target is turned off (`nativeNagOff`, L5) — the one-offs.
      if (!row.recurring) expect(row.deadline_nag_off).toBe(true)
    }
    for (const seg of segs) {
      for (const row of seg.tasks as Obj[]) {
        const extras = new Set([...SEGMENT_ROW_EXTRAS, 'safety_net', 'seen'])
        if (seg.horizon !== 'deadlines') {
          expect(row.safety_net, 'only deadlines rows carry safety_net').toBeUndefined()
        }
        const task = Object.fromEntries(Object.entries(row).filter(([k]) => !extras.has(k)))
        expectShape(task, TASK, `deadlines fixture task ${row.id}`)
      }
    }
  })

  test('defer-lead answers day, deferred, refused and summary', () => {
    const d = data('task-segments-defer-lead')
    expect(Object.keys(d).sort()).toEqual(['day', 'deferred', 'refused', 'summary', 'undo_id'])
    expect(d).toMatchObject({ deferred: 1, refused: [] })
    expect(d.day).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(d.summary).toEqual(expect.any(String))
  })
})

describe('contract fixtures: "Day starts at" (2026-10-23)', () => {
  test('user preferences carry the day start, unset by default: 3:00 AM, = rollover_time', () => {
    const prefs = data('user-preferences')
    expect(prefs.day_start_default).toBe(true)
    expect(prefs).not.toHaveProperty('day_start_first_period')
    expect(prefs.day_start_slot_id).toBeNull()
    expect(prefs.day_start_time).toBe('03:00')
    expect(prefs.day_start_time).toBe(prefs.rollover_time)
  })
})

describe('contract fixtures: anchor times (2026-10-21)', () => {
  test('user preferences carry the resolved anchor times, their links and the pad (2026-10-21)', () => {
    // Every time is resolved (a linked period's start); the slot id says which
    // period it follows. The scenario links nothing, so the defaults show.
    const prefs = data('user-preferences')
    expect([prefs.morning_time, prefs.wake_time, prefs.sleep_time]).toEqual([
      '09:00',
      '07:00',
      '22:00',
    ])
    expect([prefs.morning_slot_id, prefs.wake_slot_id, prefs.sleep_slot_id]).toEqual([
      null,
      null,
      null,
    ])
    const pad = prefs.pad_presets as Obj[]
    for (const p of pad) expect(Object.keys(p).sort()).toEqual(['slot_id', 'time'])
    expect(pad.map((p) => p.time)).toEqual(['09:00', '12:00', '16:00', '20:30'])
  })
})

describe('contract fixtures: a bulk snooze names what it moved (2026-10-26)', () => {
  test('moved_ids: one integer id per moved task, on both bulk snooze routes', () => {
    for (const name of ['bulk-snooze', 'bulk-snooze-overdue']) {
      const d = data(name)
      expect(Array.isArray(d.moved_ids), name).toBe(true)
      const ids = d.moved_ids as Json[]
      for (const id of ids) expect(Number.isInteger(id), name).toBe(true)
      expect(ids).toHaveLength(d.tasks_affected as number)
      expect(new Set(ids).size).toBe(ids.length)
    }
  })

  test('undo_id (2026-10-26): every captured mutation answers its own undo entry', () => {
    // An integer when the request logged an entry, null when it logged
    // nothing (another day's Considered changes nothing).
    const mutations = [
      'quota-prompts-did',
      'quota-prompts-consider',
      'quota-prompts-restore',
      'task-progress',
      'bulk-complete',
      'bulk-snooze',
      'bulk-snooze-overdue',
      'task-segments-consider',
      'task-segments-target-today-repeating',
      'task-segments-defer-lead',
      'task-relative-fixed',
      'notification-action-considered',
    ]
    for (const name of mutations) {
      expect(Number.isInteger(data(name).undo_id), `${name}.undo_id`).toBe(true)
    }
    expect(data('notification-action-not-waiting').undo_id).toBeNull()
  })

  test('undo status: the stack ids beside latest_id; undo by id names what it undid', () => {
    const status = data('undo-status')
    expect(Object.keys(status).sort()).toEqual(
      [
        'latest_id',
        'newest_undoable_id',
        'next_redoable_id',
        'redoable_count',
        'undoable_count',
      ].sort(),
    )
    // Nothing undone at that point: the newest entry is the newest undoable one.
    expect(status.newest_undoable_id).toBe(status.latest_id)
    expect(status.next_redoable_id).toBeNull()
    const undone = data('undo-by-id')
    expect(undone.undone_id).toBe(data('quota-prompts-consider').undo_id)
    for (const k of ['undoable_count', 'redoable_count', 'tasks_affected']) {
      expect(typeof undone[k]).toBe('number')
    }
  })
})
