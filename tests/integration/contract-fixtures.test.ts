/**
 * Cross-surface contract fixtures (testing pass WP5, 2026-09-25)
 *
 * The native apps (phone/Mac widgets, watch, notification checklist) decode
 * these endpoints with Swift DTOs that default nearly every field
 * (`ios/Shared/OpenTaskModels.swift`). A renamed server field (`done` →
 * `is_done`) would decode silently as `false` and every prompt would wait
 * forever on every native surface. So this file captures the real responses
 * of a fixed scenario into `tests/fixtures/contract/*.json`, and two readers
 * check them against the clients' types:
 *
 * - TS: `tests/behavioral/contract-types.test.ts`
 * - Swift: `ios/Tests/Logic/ContractDecodeTests.swift` (the `OpenTaskLogicTests`
 *   target in `macos/project.yml`), which asserts decoded VALUES
 *
 * Two modes:
 * - default: fails if the live, normalised response drifts from the committed
 *   fixture — shape (keys and JSON types) first, then values.
 * - `CONTRACT_WRITE=1`: rewrites the fixtures. Any change to an endpoint the
 *   iOS app uses (AGENTS.md "iOS App") re-runs this and commits the diff, so
 *   the contract change shows up in review.
 *
 *   CONTRACT_WRITE=1 npx vitest run --config vitest.integration.config.ts tests/integration/contract-fixtures.test.ts
 *
 * THE SCENARIO (User B — the seed gives B one ordinary task and nothing else,
 * so the payloads stay small; synthetic data only, this repo is public):
 *
 * - a daily quota, 2/day, spread over the first two slots (the default
 *   placement), with notes and a `personal` label coloured purple (the stripe)
 * - a weekly quota (target 3) and a monthly quota (target 2)
 * - two daily reminders (08:00 and 19:00) and a one-off task
 *
 * then, in this order (each POST's response is itself a fixture, and the
 * undo counts depend on exactly this many mutations):
 *
 *  1. GET  /api/reminders                       → reminders-initial.json (all waiting)
 *  2. POST /api/quota-prompts/did  [daily #1]    → quota-prompts-did.json
 *  3. GET  /api/reminders                       → reminders-after-did.json
 *  4. POST /api/tasks/{weekly}/progress +1       → task-progress.json (weekly "done today")
 *  5. POST /api/tasks/bulk/complete              → bulk-complete.json
 *        ids: [morning reminder, one-off task], prompts: [weekly key (consider)]
 *  6. GET  /api/reminders                       → reminders.json (final)
 *     GET  /api/tasks?done=false&limit=300      → tasks.json
 *     GET  /api/time-slots                      → time-slots.json
 *     GET  /api/completions?since=&until=       → completions.json
 *     GET  /api/undo/status                     → undo-status.json
 *  7. POST /api/quota-prompts/restore [daily #1] → quota-prompts-restore.json
 *        (after every other capture, so none of them changes)
 *
 * Final state (as of step 6): daily #1 done, daily #2 waiting; weekly done today (and
 * considered); monthly waiting; morning reminder considered, evening waiting.
 *
 * CLOCK: the integration server runs on the real clock (there is no test-mode
 * clock seam, and adding one would touch every `new Date()` in the server).
 * The scenario is chosen to be clock-independent instead — prompt placement
 * doesn't depend on the time of day, a daily reminder is "today" all day, and
 * every due date the payloads carry is a next occurrence (always future) —
 * and every volatile value is normalised before comparing:
 *
 * - ids → fixed placeholders, still INTEGERS (the Swift DTOs decode Int):
 *   tasks 101.. in creation order (User B's seed task is 100), slots 11.. in
 *   start order, projects 1.., completions 501.., undo entries 901..
 * - `prompt_key` → `q:<mapped task id>:<k>:2026-01-15`
 * - every ISO timestamp → `2026-01-15T16:00:00.000Z`, every bare date →
 *   `2026-01-15`. HH:MM values (`start_time`, `anchor_time`) are kept.
 *
 * A run that straddles local midnight (America/New_York) can fail spuriously:
 * the prompt keys are day-scoped. Re-run.
 */

import fs from 'fs'
import path from 'path'
import prettier from 'prettier'
import { describe, test, expect, beforeAll } from 'vitest'
import { apiFetchB, resetTestData } from './helpers'

const FIXTURE_DIR = path.join(process.cwd(), 'tests', 'fixtures', 'contract')
const WRITE = process.env.CONTRACT_WRITE === '1'
const RERUN_HINT =
  'If this change is intended, re-run with CONTRACT_WRITE=1 and commit the fixture diff:\n' +
  '  CONTRACT_WRITE=1 npx vitest run --config vitest.integration.config.ts tests/integration/contract-fixtures.test.ts'

export const PINNED_TIMESTAMP = '2026-01-15T16:00:00.000Z'
export const PINNED_DATE = '2026-01-15'

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const PROMPT_KEY = /^q:(\d+):(\d+):(\d{4}-\d{2}-\d{2})$/

/**
 * Real id → placeholder, one namespace per kind of id. `tasks`, `slots` and
 * `projects` are registered up front from the scenario itself (so a
 * placeholder means the same thing in every fixture); completions and undo
 * entries are numbered in first-seen order. An unknown task/slot/project id
 * throws: it means the payload grew an id this normaliser doesn't know, and
 * silently passing it through would pin a volatile value.
 */
class IdMap {
  private maps = {
    task: new Map<number, number>(),
    slot: new Map<number, number>(),
    project: new Map<number, number>(),
    completion: new Map<number, number>(),
    undo: new Map<number, number>(),
  }
  private next = { completion: 501, undo: 901 }

  register(kind: 'task' | 'slot' | 'project', real: number, placeholder: number) {
    this.maps[kind].set(real, placeholder)
  }

  map(kind: keyof IdMap['maps'], real: number): number {
    const known = this.maps[kind].get(real)
    if (known !== undefined) return known
    if (kind === 'completion' || kind === 'undo') {
      const placeholder = this.next[kind]++
      this.maps[kind].set(real, placeholder)
      return placeholder
    }
    throw new Error(`contract normaliser: unregistered ${kind} id ${real}`)
  }
}

/** What an object with an `id` is, from the keys only that kind carries. */
function idKind(obj: Record<string, Json>): 'task' | 'slot' | 'project' | 'completion' {
  if ('completed_at' in obj && 'task_id' in obj) return 'completion'
  if ('start_time' in obj) return 'slot'
  if ('title' in obj) return 'task'
  if ('name' in obj && 'owner_id' in obj) return 'project'
  throw new Error(`contract normaliser: can't tell what this id belongs to: ${Object.keys(obj)}`)
}

function normalise(value: Json, ids: IdMap, key?: string, parent?: Record<string, Json>): Json {
  if (Array.isArray(value)) return value.map((v) => normalise(v, ids, key, parent))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, Json> = {}
    for (const [k, v] of Object.entries(value)) out[k] = normalise(v, ids, k, value)
    return out
  }
  if (typeof value === 'number' && Number.isInteger(value) && parent) {
    switch (key) {
      case 'id':
        return ids.map(idKind(parent), value)
      case 'task_id':
        return ids.map('task', value)
      case 'slot_id':
      case 'quota_prompt_slot_id':
        return ids.map('slot', value)
      case 'project_id':
        return ids.map('project', value)
      case 'latest_id':
        return ids.map('undo', value)
    }
    return value
  }
  if (typeof value === 'string') {
    const pk = PROMPT_KEY.exec(value)
    if (pk) return `q:${ids.map('task', Number(pk[1]))}:${pk[2]}:${PINNED_DATE}`
    if (ISO_DATETIME.test(value)) return PINNED_TIMESTAMP
    if (ISO_DATE.test(value)) return PINNED_DATE
  }
  return value
}

// ---------------------------------------------------------------------------
// Drift check
// ---------------------------------------------------------------------------

function jsonType(v: Json): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}

/**
 * Shape differences between the committed fixture and the live payload:
 * missing/extra keys and changed JSON types, by path. A shape drift is what
 * silently breaks a defaulting Swift decoder, so it is reported on its own,
 * before any value difference.
 */
function shapeDrift(expected: Json, actual: Json, at = '$'): string[] {
  const te = jsonType(expected)
  const ta = jsonType(actual)
  if (te !== ta) return [`${at}: type ${te} → ${ta}`]
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      return [`${at}: length ${expected.length} → ${actual.length}`]
    }
    return expected.flatMap((e, i) => shapeDrift(e, actual[i], `${at}[${i}]`))
  }
  if (te === 'object') {
    const e = expected as Record<string, Json>
    const a = actual as Record<string, Json>
    const out: string[] = []
    for (const k of Object.keys(e))
      if (!(k in a)) out.push(`${at}.${k}: missing (was ${jsonType(e[k])})`)
    for (const k of Object.keys(a))
      if (!(k in e)) out.push(`${at}.${k}: new key (${jsonType(a[k])})`)
    for (const k of Object.keys(e)) if (k in a) out.push(...shapeDrift(e[k], a[k], `${at}.${k}`))
    return out
  }
  return []
}

/**
 * Lists whose server order depends on the wall clock are put in id order
 * (real ids, before normalising — which is also creation order, so the
 * placeholders come out ascending). `/api/tasks` sorts by `due_at`, and the
 * 19:00 reminder's next occurrence is today before 19:00 and tomorrow after
 * it; `/api/completions` sorts by `completed_at`, and the two completions of
 * one bulk commit share it. No native client relies on either order — every
 * surface sorts for itself — so the order is not part of the contract.
 */
function canonicalise(raw: Json): Json {
  const data = (raw as { data?: Record<string, Json> }).data
  if (!data) return raw
  const byId = (list: Json) =>
    [...(list as { id: number }[])].sort((a, b) => a.id - b.id) as unknown as Json
  const out = { ...data }
  if (Array.isArray(out.tasks) && 'count' in out) out.tasks = byId(out.tasks)
  if (Array.isArray(out.completions)) out.completions = byId(out.completions)
  return { ...(raw as Record<string, Json>), data: out }
}

async function checkFixture(name: string, raw: Json, ids: IdMap): Promise<Json> {
  const live = normalise(canonicalise(raw), ids)
  const file = path.join(FIXTURE_DIR, `${name}.json`)
  if (WRITE) {
    fs.mkdirSync(FIXTURE_DIR, { recursive: true })
    // Written as the repo's Prettier would, so the pre-commit hook never
    // rewrites a fixture and a CONTRACT_WRITE diff shows only real changes.
    const options = (await prettier.resolveConfig(file)) ?? {}
    fs.writeFileSync(
      file,
      await prettier.format(JSON.stringify(live), { ...options, filepath: file }),
    )
    return live
  }
  if (!fs.existsSync(file)) {
    throw new Error(`Missing contract fixture ${name}.json.\n${RERUN_HINT}`)
  }
  const committed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Json
  const drift = shapeDrift(committed, live)
  if (drift.length > 0) {
    throw new Error(`Contract SHAPE drift in ${name}.json:\n  ${drift.join('\n  ')}\n${RERUN_HINT}`)
  }
  // Values: the fixture pins them too (counts, flags, titles, keys).
  expect(live, `Contract VALUE drift in ${name}.json. ${RERUN_HINT}`).toEqual(committed)
  return live
}

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------

async function call(
  pathname: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
) {
  const res = await apiFetchB(pathname, { method, body })
  const json = (await res.json()) as Json
  if (!res.ok) throw new Error(`${method} ${pathname} → ${res.status}: ${JSON.stringify(json)}`)
  return json
}

interface Prompt {
  prompt_key: string
  task_id: number
  number: number | null
}

function prompts(reminders: Json): Prompt[] {
  const data = (reminders as unknown as { data: { groups: { prompts: Prompt[] }[] } }).data
  return data.groups.flatMap((g) => g.prompts)
}

describe('contract fixtures (native clients)', () => {
  const ids = new IdMap()
  const captured: Record<string, Json> = {}
  const created: Record<string, number> = {}

  beforeAll(async () => {
    await resetTestData()

    // Slots and projects: placeholders from their own order.
    const slots = (await call('/api/time-slots')) as { data: { time_slots: { id: number }[] } }
    slots.data.time_slots.forEach((s, i) => ids.register('slot', s.id, 11 + i))
    const projects = (await call('/api/projects')) as { data: { projects: { id: number }[] } }
    projects.data.projects.forEach((p, i) => ids.register('project', p.id, 1 + i))
    const seeded = (await call('/api/tasks?done=false&limit=300')) as {
      data: { tasks: { id: number }[] }
    }
    // User B's one seeded task.
    expect(seeded.data.tasks).toHaveLength(1)
    ids.register('task', seeded.data.tasks[0].id, 100)

    // The stripe: `personal` is purple in label_config.
    await call(
      '/api/user/preferences',
      { label_config: [{ name: 'personal', color: 'purple' }] },
      'PATCH',
    )

    let placeholder = 101
    const make = async (name: string, body: Record<string, unknown>) => {
      const res = (await call('/api/tasks', body)) as { data: { id: number } }
      created[name] = res.data.id
      ids.register('task', res.data.id, placeholder++)
    }
    await make('daily', {
      title: 'Drink water',
      rrule: 'FREQ=DAILY',
      progress_target: 2,
      is_tracked: true,
      labels: ['personal'],
      notes: 'A glass with breakfast, one with dinner.',
    })
    await make('weekly', {
      title: 'Go for a run',
      rrule: 'FREQ=WEEKLY',
      progress_target: 3,
      is_tracked: true,
    })
    await make('monthly', {
      title: 'Call a friend',
      rrule: 'FREQ=MONTHLY',
      progress_target: 2,
      is_tracked: true,
    })
    await make('morning', {
      title: 'Stretch',
      is_reminder: true,
      rrule: 'FREQ=DAILY;BYHOUR=8;BYMINUTE=0',
    })
    await make('evening', {
      title: 'Plan tomorrow',
      is_reminder: true,
      rrule: 'FREQ=DAILY;BYHOUR=19;BYMINUTE=0',
    })
    await make('oneoff', { title: 'Water the plants', priority: 1 })

    // 1. before anything is handled
    captured['reminders-initial'] = await call('/api/reminders')
    const initial = prompts(captured['reminders-initial'])
    const dailyOne = initial.find((p) => p.task_id === created.daily && p.number === 1)
    const weeklyPrompt = initial.find((p) => p.task_id === created.weekly)
    if (!dailyOne || !weeklyPrompt) throw new Error('scenario prompts missing')

    // 2–3. did-it on the daily quota's first row
    captured['quota-prompts-did'] = await call('/api/quota-prompts/did', {
      keys: [dailyOne.prompt_key],
    })
    captured['reminders-after-did'] = await call('/api/reminders')

    // 4. the weekly quota is logged from elsewhere → "done today"
    captured['task-progress'] = await call(`/api/tasks/${created.weekly}/progress`, { delta: 1 })

    // 5. one mixed commit: a reminder, a task, and a consider
    captured['bulk-complete'] = await call('/api/tasks/bulk/complete', {
      ids: [created.morning, created.oneoff],
      prompts: [weeklyPrompt.prompt_key],
    })

    // 6. final state, as each native client asks for it
    captured['reminders'] = await call('/api/reminders')
    captured['tasks'] = await call('/api/tasks?done=false&limit=300')
    captured['time-slots'] = await call('/api/time-slots')
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
    const until = new Date(Date.now() + 24 * 3600 * 1000).toISOString()
    captured['completions'] = await call(
      `/api/completions?since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`,
    )
    captured['undo-status'] = await call('/api/undo/status')

    // 7. put the daily quota's did-it #1 back — after every capture above, so
    //    none of them moves
    captured['quota-prompts-restore'] = await call('/api/quota-prompts/restore', {
      keys: [dailyOne.prompt_key],
    })
  })

  const names = [
    'reminders-initial',
    'quota-prompts-did',
    'reminders-after-did',
    'task-progress',
    'bulk-complete',
    'reminders',
    'tasks',
    'time-slots',
    'completions',
    'undo-status',
    'quota-prompts-restore',
  ]

  for (const name of names) {
    test(`${name}.json matches the live response`, async () => {
      await checkFixture(name, captured[name], ids)
    })
  }

  test('no stray fixture files', () => {
    const onDisk = fs
      .readdirSync(FIXTURE_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''))
      .sort()
    expect(onDisk).toEqual([...names].sort())
  })
})
