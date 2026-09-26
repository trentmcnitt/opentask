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
  stripe_color: STR_N,
  has_notes: BOOL,
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
  original_due_at: STR_N,
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
  quota_prompt_config: ['object', 'null'],
  quota_day_state: ['object', 'null'],
  is_reminder: BOOL,
  completion_count: INT,
  snooze_count: INT,
  skip_count: INT,
  first_completed_at: STR_N,
  last_completed_at: STR_N,
  notes: STR_N,
  created_at: STR,
  updated_at: STR,
  is_recurring: BOOL,
  is_snoozed: BOOL,
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

const REMINDER_FIXTURES = ['reminders-initial', 'reminders-after-did', 'reminders']

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
    // Two daily rows, weekly, monthly — in each of the three captures.
    expect(seen).toBe(12)
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

  test('the progress response is a FormattedTask plus met/description', () => {
    const d = data('task-progress')
    expect(typeof d.met).toBe('boolean')
    expect(typeof d.description).toBe('string')
    const task = Object.fromEntries(
      Object.entries(d).filter(([k]) => k !== 'met' && k !== 'description'),
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
})
