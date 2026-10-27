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
 *  0. GET  /api/user/preferences                → user-preferences.json (right after
 *        the label_config PATCH above; the apps read `label_config` from it)
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
 *  8. POST /api/tasks (a one-off due three days ago), then
 *     GET  /api/tasks/counts                    → task-counts.json
 *        (what the iOS/Mac apps set the icon badge from when they come forward)
 *  9. POST /api/tasks (a dateless task, an overdue Urgent one), then
 *     POST /api/tasks/bulk/snooze               → bulk-snooze.json
 *        ids: [overdue, dateless, urgent, evening reminder], an absolute `until`
 *        (the widgets' per-row and selected-task snooze)
 * 10. a days task (with a deadline) considered from its segment, the task
 *     queue ON as production runs: no automatic target (the deadlines page)
 *                                               → task-segments-consider.json,
 *     GET  /api/reminders                       → reminders-segments.json
 * 11. Upcoming: a one-off (target + deadline) and a repeating task, both
 *     targeted 10 days ago (backdated in the DB), due tomorrow
 *     GET  /api/reminders                       → reminders-upcoming.json
 *     POST /api/task-segments/target-today [repeating]
 *                                               → task-segments-target-today-repeating.json
 * 12. The two badges (§7): an undated task 40 days old, and two tasks over
 *     target for three local days (one with a deadline ahead), backdated
 *     GET  /api/tasks/{id} ×3                   → task-badges.json
 * 13. Interval quotas (2026-10-16): an every-2-weeks quota (target 1)
 *     GET  /api/tasks/{id}                      → task-interval-quota.json
 *     GET  /api/reminders                       → reminders-interval.json
 *        (its prompt's `period_interval` 2 and `period_label` "by …")
 * 14. With the task queue switched on (the test-only /api/test/task-queue):
 *     POST /api/tasks/bulk/snooze-overdue       → bulk-snooze-overdue.json
 *        (`queued`, `queued_name`, `summary`, `message`; step 12's two
 *        slipping tasks swept, step 9's Urgent one skipped)
 *
 * 15. The task queue's panels (task-queue PR 3), switch on, after two test
 *     rollovers (`POST /api/test/rollover` with `force`): one as of two days
 *     ago, which strips a one-off and sends a weekly task to wait (both
 *     backdated in the DB so the rollover sees them as left over), then one
 *     as of now, which strips a one-off and a Try Tomorrow row
 *     GET  /api/reminders?queue=1               → reminders-queue.json
 *     (and GET /api/reminders, the default form: no queue kinds — asserted,
 *     not captured)
 *        (`queue_previous`: the old strip and the waiting weekly task;
 *        `queue_today`: the new strip and the Try Tomorrow row)
 * 16. On deck (2026-10-20), switch on: a one-off decked for tomorrow
 *     (`POST /api/tasks/deck`), its stamps backdated so today is its heads-up
 *     GET  /api/reminders?queue=1&deck=1        → reminders-deck.json
 *     (and the form without `deck=1`: the decked task in no segment —
 *     asserted, not captured)
 * 17. A deadline-anchored repeat (2026-10-21)
 *     GET  /api/tasks/{id}                      → task-deadline-anchored.json
 * 18. Repeat ends (2026-10-22): a counted repeat (2 times) done once, so on
 *     its last occurrence
 *     GET  /api/tasks/{id}                      → task-repeat-ends.json
 * 19. The deadlines page (2026-10-22), switch on: three deadline tasks with
 *     NO target — a one-off whose lead day is today (`lead_days` 10, clamped
 *     to today; its deadline six days out), a one-off whose deadline passed
 *     yesterday (the safety net), and a deadline-anchored repeat with no
 *     relative target (lead today the same way)
 *     GET  /api/reminders?queue=1&deck=1&deadlines=1 → reminders-deadlines.json
 *     (the `deadlines` segment FIRST, rows with `safety_net` and `seen`)
 *     GET  /api/reminders?queue=1&deck=1        → reminders-deadlines-plain.json
 *     (the form a shipped native build sends: no `deadlines` kind; the three
 *     tasks in their horizon segment instead — the truthful degrade)
 *     POST /api/task-segments/defer-lead [the first, to tomorrow]
 *                                               → task-segments-defer-lead.json
 *
 * 20. Relative targets (2026-10-24): a one-off whose deadline is five days
 *     out at 9 AM, its target the day before at User B's last period's start
 *     (linked)
 *     GET   /api/tasks/{id}                     → task-relative-one-off.json
 *     PATCH /api/tasks/{id} [target_at: a pick] → task-relative-fixed.json
 *     (the offsets and the link cleared: a picked date is a fixed target)
 *
 * 21. Upcoming's two sections (2026-10-25): a one-off due tomorrow (its
 *     Tomorrow) and one due in six days with a lead of 6 (its Later is
 *     today), both targeted 10 days ago (backdated in the DB), and a second
 *     Later one considered today (2026-10-26, the native per-section "n of m")
 *     GET  /api/reminders                       → reminders-upcoming-sections.json
 *     (every Upcoming row carries `upcoming_section`, a considered one too;
 *     Tomorrow's first)
 *
 * 22. The named reminder push's Considered button (2026-10-26): a one-time
 *     High reminder, waiting today
 *     POST /api/notifications/actions {done, day: yesterday}
 *                                               → notification-action-not-waiting.json
 *     (`considered: false`, no `result`: another day's banner changes nothing)
 *     POST /api/notifications/actions {done, day: today}
 *                                               → notification-action-considered.json
 *     (`considered: true` and the done's `result`)
 *
 * 23. The named quota-prompt push's buttons (Push PR 4b, 2026-10-26): a
 *     Medium weekly quota (target 3), its prompt waiting today
 *     POST /api/quota-prompts/consider [its key] → quota-prompts-consider.json
 *     (`considered: 1`, `did: 0`, the quota in `tasks`)
 *     POST /api/quota-prompts/consider and /did with YESTERDAY's key → 400
 *     (asserted, not captured: native reads only the status)
 *
 * 24. Scoped native Undo (2026-10-26): step 23's consider answered its
 *     `undo_id`; undone by that id, as a widget or the watch sends it
 *     POST /api/undo {id}                       → undo-by-id.json
 *     (`undone_id` is that `undo_id`; the same id again is a 409
 *     `already_undone` naming the entry below — asserted, not captured:
 *     native reads only the status and `details`)
 *
 * 25. The native apps' question (native PR E, 2026-10-26): the web's own
 *     `REMINDERS_URL` (`src/lib/reminders-query.ts`), written as
 *                                               → reminders-query.json
 *     (the Swift `ContractDecodeTests` asserts `APIClient.remindersPath`
 *     equals it — the drift guard), then, switch on, step 19's safety-net row
 *     considered (seen, still waiting) and step 15's "Call the plumber" done
 *     from "Today's pulls"
 *     GET  REMINDERS_URL                       → reminders-native.json
 *     (every kind, an empty one with no rows (`fill`); a left done row and
 *     step 19's left deferred row (`handled`); the seen safety-net row; step
 *     16's deck row; step 15's Try Tomorrow row)
 *
 * Every captured mutation carries `undo_id` (2026-10-26), and undo-status
 * `newest_undoable_id` / `next_redoable_id`: undo-entry placeholders, like
 * `latest_id`, numbered 901.. in the order the fixtures are checked.
 *
 * Final state (as of step 6): daily #1 done, daily #2 waiting; weekly done today (and
 * considered); monthly waiting; morning reminder considered, evening waiting.
 *
 * CLOCK: the integration server runs on the real clock (there is no test-mode
 * clock seam, and adding one would touch every `new Date()` in the server).
 * The scenario is chosen to be clock-independent instead — prompt placement
 * doesn't depend on the time of day, a daily reminder is "today" all day, and
 * every due date the payloads carry is a next occurrence (always future) —
 * and every volatile value is normalised before comparing.
 *
 * task-counts.json is the one fixture whose VALUES depend on the local day
 * boundary (`today` is "due inside User B's local day"), so every dated task
 * it counts is chosen to sit clear of that boundary at any hour: User B's seed
 * task is tomorrow 09:00 in User B's own zone (scripts/seed-test.ts — it used
 * to be User A's Chicago tomorrow, which is New York's today from 23:00 to
 * midnight Chicago, and failed for that hour), and step 8's task is three days
 * late. So the counts are always { total: 2, overdue: 1, today: 0 }.
 *
 * Normalisation:
 *
 * - ids → fixed placeholders, still INTEGERS (the Swift DTOs decode Int):
 *   tasks 101.. in creation order (User B's seed task is 100), slots 11.. in
 *   start order, projects 1.., completions 501.., undo entries 901..
 * - `prompt_key` → `q:<mapped task id>:<k>:2026-01-15`
 * - every ISO timestamp → `2026-01-15T16:00:00.000Z`, every bare date →
 *   `2026-01-15`. HH:MM values (`start_time`, `anchor_time`) are kept.
 * - an interval quota's `period_label` ("by Oct 24", a date in words) →
 *   `by Jan 15`, the pinned date's.
 *
 * A run that straddles local midnight (America/New_York) can fail spuriously:
 * the prompt keys are day-scoped. Re-run.
 */

import fs from 'fs'
import path from 'path'
import prettier from 'prettier'
import Database from 'better-sqlite3'
import { DateTime } from 'luxon'
import { describe, test, expect, beforeAll } from 'vitest'
import { apiFetchB, resetTestData, setTaskQueue } from './helpers'
import { REMINDERS_URL } from '@/lib/reminders-query'

const FIXTURE_DIR = path.join(process.cwd(), 'tests', 'fixtures', 'contract')
const WRITE = process.env.CONTRACT_WRITE === '1'
const RERUN_HINT =
  'If this change is intended, re-run with CONTRACT_WRITE=1 and commit the fixture diff:\n' +
  '  CONTRACT_WRITE=1 npx vitest run --config vitest.integration.config.ts tests/integration/contract-fixtures.test.ts'

export const PINNED_TIMESTAMP = '2026-01-15T16:00:00.000Z'
export const PINNED_DATE = '2026-01-15'
/** An interval quota's `period_label` is a date in words; pinned like the dates. */
export const PINNED_PERIOD_LABEL = 'by Jan 15'

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

/**
 * Keys whose value is an undo_log id: the status's `latest_id`, and (scoped
 * native Undo, 2026-10-26) a mutation's own entry, the status's two stack
 * ids, and the entry an undo/redo took.
 */
const UNDO_ID_KEYS = new Set([
  'latest_id',
  'undo_id',
  'newest_undoable_id',
  'next_redoable_id',
  'undone_id',
  'redone_id',
])

function normalise(value: Json, ids: IdMap, key?: string, parent?: Record<string, Json>): Json {
  if (Array.isArray(value)) return value.map((v) => normalise(v, ids, key, parent))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, Json> = {}
    for (const [k, v] of Object.entries(value)) {
      // A prompt key can be an object KEY too (`quota_day_state.did_applied`).
      const pk = PROMPT_KEY.exec(k)
      const name = pk ? `q:${ids.map('task', Number(pk[1]))}:${pk[2]}:${PINNED_DATE}` : k
      out[name] = normalise(v, ids, k, value)
    }
    return out
  }
  if (typeof value === 'number' && Number.isInteger(value) && parent) {
    switch (key) {
      case 'id':
        return ids.map(idKind(parent), value)
      case 'task_id':
      case 'skipped_recurring': // target-today's skipped repeating tasks (2026-10-12)
      case 'moved_ids': // a bulk snooze's moved tasks (2026-10-26)
        return ids.map('task', value)
      case 'slot_id':
      case 'quota_prompt_slot_id':
      case 'target_slot_id': // relative targets (2026-10-24): the period a target follows
        return ids.map('slot', value)
      case 'project_id':
        return ids.map('project', value)
    }
    if (UNDO_ID_KEYS.has(key!)) return ids.map('undo', value)
    return value
  }
  if (typeof value === 'string') return normaliseString(value, ids, key)
  return value
}

/** A string value: prompt keys, ISO timestamps and dates, and a date in words. */
function normaliseString(value: string, ids: IdMap, key?: string): string {
  if (key === 'period_label' && value.startsWith('by ')) return PINNED_PERIOD_LABEL
  const pk = PROMPT_KEY.exec(value)
  if (pk) return `q:${ids.map('task', Number(pk[1]))}:${pk[2]}:${PINNED_DATE}`
  // The deadlines page's Defer summary names its day in words (2026-10-22).
  if (key === 'summary' && /^Deferred \d+ tasks? to /.test(value)) {
    return value.replace(/ to .*$/, ' to <day>')
  }
  // A PATCH's move description names its time relative to now (2026-10-24).
  if (key === 'description' && /^Deferred to .* \u2014 "/.test(value)) {
    return value.replace(/^Deferred to .* \u2014 "/, 'Deferred to <when> \u2014 "')
  }
  if (ISO_DATETIME.test(value)) return PINNED_TIMESTAMP
  if (ISO_DATE.test(value)) return PINNED_DATE
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

/**
 * `GET /api/user/preferences` also reports what AI the SERVER can reach
 * (`ai_available`, `ai_sdk_available`, `ai_api_available`, `ai_feature_info`).
 * That is the machine's environment (API keys, whether Claude Code is
 * installed), not the contract, so it would differ between a laptop and CI.
 * The three booleans are pinned to `false` (still checked as booleans) and
 * `ai_feature_info` is left out. No native client reads any of them — the
 * apps decode only `label_config` (`UserPreferencesLabelConfigPage`).
 */
function pinServerEnvironment(raw: Json): Json {
  const data = { ...((raw as { data: Record<string, Json> }).data ?? {}) }
  for (const key of ['ai_available', 'ai_sdk_available', 'ai_api_available']) {
    if (typeof data[key] !== 'boolean') throw new Error(`preferences: ${key} is not a boolean`)
    data[key] = false
  }
  delete data.ai_feature_info
  // The task-queue switch is the server's (`OPENTASK_TASK_QUEUE`, and the
  // test route's state), not the user's: left out, like the AI fields.
  // `rollover_time` is user data and stays.
  delete data.task_queue
  // The shelved-AI switch (`OPENTASK_AI_UNSHELVE`), the server's too.
  delete data.ai_unshelved
  return { ...(raw as Record<string, Json>), data }
}

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------

/**
 * Day-of-week agnostic (2026-10-17): a weeks task created ON the check-in day
 * shows in that day's segment (task-segments.ts `segmentState`), so on a
 * Saturday in User B's zone (the default check-in day) the scenario's undated
 * one-off appeared in `task_segments` and the fixtures drifted — CI failed
 * every Saturday, main included. The scenario makes the check-in day
 * YESTERDAY's weekday, after the preferences are captured: a task created
 * today then always waits for the next check-in, whatever today is.
 */
async function checkInYesterday() {
  const yesterday = DateTime.now().setZone('America/New_York').minus({ days: 1 })
  await call('/api/user/preferences', { check_in_day: yesterday.weekday }, 'PATCH')
}

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

/**
 * Step 14. Snooze all overdue, as every native "All" button, widget bar and
 * Shortcut sends it — with the task queue ON (OPENTASK_TASK_QUEUE), the way it
 * will run. What is over target by then: the two slipping tasks from step 12
 * (one with a deadline ahead) and the Urgent one from step 9 (never swept).
 * The one with no deadline is a defer landing after the next rollover, so it
 * is marked for the queue (`queued`, `queued_name`, the `summary` line); the
 * deadline one just moves. `notify: false`: no feedback push. Last, so
 * nothing captured before it moves.
 */
/** A moment `days` days from now (negative: ago), as an ISO instant. */
function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 3600 * 1000).toISOString()
}

/** 09:00 in User B's zone (America/New_York), `days` local days from today. */
function nineAm(days: number): string {
  return DateTime.now()
    .setZone('America/New_York')
    .plus({ days })
    .set({ hour: 9, minute: 0, second: 0, millisecond: 0 })
    .toUTC()
    .toISO()!
}

/** User B's id in the integration seed (scripts/seed-test.ts). */
const USER_B_ID = 2

/**
 * Step 15. The task queue's panels (task-queue PR 3), with the switch on.
 * Each rollover runs with `force` (the test route sets the user's last
 * rollover to the day before, in the same step), so a minute cron that
 * stamped the day first can't stop it. A rollover only touches a task whose
 * target was set before its moment (as of M), so every task here has its
 * `target_set_at` backdated; nothing earlier in the scenario is old enough.
 *
 * 1. As of two days ago: a one-off five days late is stripped, and a
 *    repeating task (every 10 days at 09:00 — a rule whose text never
 *    depends on the day the test runs) whose occurrence was four days ago
 *    WAITS for its next one, six days ahead (no occurrence in that OpenTask
 *    day). Both are queued then: "Previously targeted" today.
 * 2. As of now: a one-off two days late is stripped, and a Try Tomorrow row
 *    (`/bulk/snooze` with `source: 'try_tomorrow'`: target at the next
 *    rollover, marked) is stripped as marked, its flag kept: "Stripped today".
 */
async function queuePanels(
  make: (name: string, body: Record<string, unknown>) => Promise<void>,
  created: Record<string, number>,
): Promise<{ withQueue: Json; plain: Json }> {
  await setTaskQueue(true)
  try {
    // Five days ago at 09:00: older than the repeating task's missed
    // occurrence, so it sorts first in its panel at any hour.
    await make('queueOld', { title: 'Return the library books', target_at: nineAm(-5) })
    await make('queueWeekly', {
      title: 'Water the ferns',
      rrule: 'FREQ=DAILY;INTERVAL=10;BYHOUR=9;BYMINUTE=0',
      target_at: nineAm(6),
    })
    const db = new Database(path.join(process.cwd(), 'data', 'test-integration.db'))
    try {
      // Its last occurrence was four days ago: one interval before the one
      // ahead.
      db.prepare('UPDATE tasks SET due_at = ?, occurrence_at = ? WHERE id = ?').run(
        nineAm(-4),
        nineAm(-4),
        created.queueWeekly,
      )
    } finally {
      db.close()
    }
    backdate([created.queueOld, created.queueWeekly], 5)
    await call('/api/test/rollover', { user_id: USER_B_ID, now: daysFromNow(-2), force: true })

    await make('queueNew', { title: 'Call the plumber', target_at: daysFromNow(-2), priority: 2 })
    await make('queueTryTomorrow', { title: 'Sort the receipts', target_at: daysFromNow(-1) })
    await call('/api/tasks/bulk/snooze', {
      ids: [created.queueTryTomorrow],
      source: 'try_tomorrow',
    })
    backdate([created.queueNew, created.queueTryTomorrow], 3)
    await call('/api/test/rollover', { user_id: USER_B_ID, force: true })
    // The opt-in form (the web's, and the native apps' once they draw the
    // queue) and the default form, which a build that predates the queue
    // sends: the switch is on, yet it gets no queue kinds and no queued task.
    return {
      withQueue: await call('/api/reminders?queue=1'),
      plain: await call('/api/reminders'),
    }
  } finally {
    await setTaskQueue(false)
  }
}

/**
 * Step 16. On deck (2026-10-20), switch on: a one-off decked for TOMORROW
 * (User B's calendar day), its deck stamps (`target_set_at`, considered)
 * backdated 10 days, so today is its day-before heads-up (wait 11) and the
 * row waits. `?deck=1` draws it in Upcoming ("On deck …"); the default form
 * leaves it out of every segment (an old native build would draw a dateless
 * row). Every task in every capture carries `on_deck_day`.
 */
async function deckRows(
  make: (name: string, body: Record<string, unknown>) => Promise<void>,
  created: Record<string, number>,
): Promise<{ withDeck: Json; plain: Json }> {
  await setTaskQueue(true)
  try {
    await make('decked', { title: 'Pick up the winter gloves' })
    // A REPEATING task on deck (2026-10-20): no target while decked
    // (`due_at`/`target_at` null), its occurrence kept, `recurring: true`.
    await make('deckedRepeating', {
      title: 'Water the ferns',
      rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0',
    })
    const tomorrow = DateTime.now().setZone('America/New_York').plus({ days: 1 }).toISODate()
    const decks = [created.decked, created.deckedRepeating]
    await call('/api/tasks/deck', { ids: decks, day: tomorrow })
    backdate(decks, 10, ['target_set_at', 'last_considered_at'])
    return {
      withDeck: await call('/api/reminders?queue=1&deck=1'),
      plain: await call('/api/reminders?queue=1'),
    }
  } finally {
    await setTaskQueue(false)
  }
}

/**
 * Step 19. The deadlines page (2026-10-22), switch on. Clock-independent:
 * the in-window rows have `lead_days` 10, which the lead day clamps to TODAY
 * (their deadlines are three and six days out, never inside the safety net),
 * and the safety-net row's deadline passed yesterday. Sorted by the nearest
 * deadline (all priority 0): the passed one, the repeat, the one-off.
 */
async function deadlineRows(
  make: (name: string, body: Record<string, unknown>) => Promise<void>,
  created: Record<string, number>,
): Promise<{ withDeadlines: Json; plain: Json; deferred: Json }> {
  await setTaskQueue(true)
  try {
    const ny = () => DateTime.now().setZone('America/New_York')
    const at = (days: number, hour: number) =>
      ny().plus({ days }).set({ hour, minute: 0, second: 0, millisecond: 0 }).toUTC().toISO()!
    await make('deadlineWindow', {
      title: 'File the quarterly report',
      deadline_at: at(6, 23),
      lead_days: 10,
    })
    await make('deadlinePassed', { title: 'Return the permit form', deadline_at: at(-1, 17) })
    await make('deadlineRepeat', {
      title: 'Submit the expense sheet',
      rrule: 'FREQ=DAILY;INTERVAL=7;BYHOUR=17;BYMINUTE=0',
      deadline_at: at(3, 17),
      // Shorter than the rule's wait (7 days, `leadDaysProblem`); still
      // clamped to today, so the row is on the page.
      lead_days: 6,
    })
    const withDeadlines = await call('/api/reminders?queue=1&deck=1&deadlines=1')
    const plain = await call('/api/reminders?queue=1&deck=1')
    const deferred = await call('/api/task-segments/defer-lead', {
      ids: [created.deadlineWindow],
      day: ny().plus({ days: 1 }).toISODate(),
    })
    return { withDeadlines, plain, deferred }
  } finally {
    await setTaskQueue(false)
  }
}

async function snoozeOverdueWithQueue(): Promise<Json> {
  await setTaskQueue(true)
  // The default day start for this one (3:00 AM, 2026-10-24): its
  // `summary` names the rollover moment ("…queue at 3:00 AM"). It carries no
  // prompt state, so the midnight day start the rest of the scenario keeps
  // (see the CLOCK note after the preferences capture) isn't needed here.
  await call('/api/user/preferences', { day_start_time: null }, 'PATCH')
  try {
    return await call('/api/tasks/bulk/snooze-overdue', {
      until: new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString(),
      notify: false,
    })
  } finally {
    await call('/api/user/preferences', { day_start_time: '00:00' }, 'PATCH')
    await setTaskQueue(false)
  }
}

interface Prompt {
  prompt_key: string
  task_id: number
  number: number | null
}

/**
 * `target_set_at` and `created_at` can't be set over the API (every write
 * stamps now); backdate them in the test DB.
 */
function backdate(
  taskIds: number[],
  days: number,
  columns: ('target_set_at' | 'created_at' | 'last_considered_at')[] = ['target_set_at'],
) {
  const db = new Database(path.join(process.cwd(), 'data', 'test-integration.db'))
  try {
    const when = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString()
    const sets = columns.map((c) => `${c} = ?`).join(', ')
    const stmt = db.prepare(`UPDATE tasks SET ${sets} WHERE id = ?`)
    for (const id of taskIds) stmt.run(...columns.map(() => when), id)
  } finally {
    db.close()
  }
}

function prompts(reminders: Json): Prompt[] {
  const data = (reminders as unknown as { data: { groups: { prompts: Prompt[] }[] } }).data
  return data.groups.flatMap((g) => g.prompts)
}

describe('contract fixtures (native clients)', () => {
  const ids = new IdMap()
  const captured: Record<string, Json> = {}
  const created: Record<string, number> = {}
  let plainWithQueueOn: Json = null
  let plainWithoutDeck: Json = null
  let plainWithoutDeadlines: Json = null

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
    captured['user-preferences'] = pinServerEnvironment(await call('/api/user/preferences'))
    // CLOCK (2026-10-23, "Day starts at"): with the task queue switched on —
    // steps 10, 14–16 and 19 — the Reminders day is the OpenTask day, which
    // from midnight to the day start (3:00 by default) is the day before, so a
    // prompt handled in a switch-off step (keyed by the calendar date) would
    // read as waiting again at those hours. The day starts at midnight here,
    // after the preferences capture (which shows the default), so every
    // capture reads the same at any hour.
    await call('/api/user/preferences', { day_start_time: '00:00' }, 'PATCH')

    await checkInYesterday()

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

    // 8. one overdue task (three days late: never "today"), then the counts
    //    the apps set the badge from on foreground — last, so it changes
    //    nothing captured above
    await make('overdue', {
      title: 'Renew the library card',
      due_at: new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString(),
    })
    captured['task-counts'] = await call('/api/tasks/counts')

    // 9. a per-row/selection snooze as the widgets send it — after the counts,
    //    so it changes nothing captured above. The selection holds one of each
    //    case the response reports: the overdue task (snoozed), a dateless one
    //    (given its first date: affected, but not a snooze — D1), an Urgent one
    //    (skipped on priority) and the evening reminder (skipped, §6).
    await make('dateless', { title: 'Sort the bookshelf' })
    await make('urgent', {
      title: 'File the form',
      priority: 4,
      due_at: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(),
    })
    captured['bulk-snooze'] = await call('/api/tasks/bulk/snooze', {
      ids: [created.overdue, created.dateless, created.urgent, created.evening],
      until: new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString(),
      include_task_ids: [created.dateless],
    })

    // 10. task segments (2026-10-10): a one-off with a horizon and a deadline,
    //     considered from its segment — LAST, so no earlier placeholder moves.
    //     A task created today waits for its segment's next day (creating it
    //     is seeing it), so the clock-independent way to put one in today's
    //     segment is to consider it: it is listed, ticked, all day.
    //     With the task queue ON, as production runs (2026-10-22): the
    //     deadline task gets no automatic target — it is target-less, with
    //     a lead day — and the plain request (no `?deadlines=1`, a shipped
    //     native build) shows it in its horizon segment.
    await setTaskQueue(true)
    try {
      await make('segment', {
        title: 'Fix the squeaky door',
        horizon: 'days',
        deadline_at: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
      })
      captured['task-segments-consider'] = await call('/api/task-segments/consider', {
        ids: [created.segment],
      })
      captured['reminders-segments'] = await call('/api/reminders')
    } finally {
      await setTaskQueue(false)
    }

    // 11. Upcoming (2026-10-12): a one-off with a target tomorrow and a
    //     deadline after it, and a repeating task whose next occurrence is
    //     tomorrow — both targeted 10 days ago, so today is a heads-up day
    //     (wait 11: T−3 has passed, T−1 is today). `target_set_at` can't be set
    //     over the API (every write stamps now), so it is backdated in the DB.
    //     Then Today on the repeating row: its target moves (its occurrence
    //     stays — §6, 2026-10-12); `skipped_recurring` is always [].
    const tomorrow = DateTime.now().setZone('America/New_York').plus({ days: 1 })
    const at9 = tomorrow.set({ hour: 9, minute: 0, second: 0, millisecond: 0 }).toUTC().toISO()
    await make('upcomingOneOff', {
      title: 'Renew the passport',
      target_at: at9,
      deadline_at: tomorrow.plus({ days: 4 }).set({ hour: 23, minute: 59 }).toUTC().toISO(),
    })
    await make('upcomingRepeating', {
      title: 'Water the plants',
      rrule: 'FREQ=DAILY;INTERVAL=3;BYHOUR=9;BYMINUTE=0',
      target_at: at9,
    })
    backdate([created.upcomingOneOff, created.upcomingRepeating], 10)
    captured['reminders-upcoming'] = await call('/api/reminders')
    captured['task-segments-target-today-repeating'] = await call(
      '/api/task-segments/target-today',
      {
        ids: [created.upcomingRepeating],
      },
    )

    // 12. The two badges (spec §7, 2026-10-12), as GET /api/tasks/{id} returns
    //     them (the content extension reads it): an undated task written down
    //     40 days ago (`age_label` ">1 mo"); a task over target since two days
    //     ago (`attempts` 3, `attempts_label` "3×", `attempts_offer`
    //     "remove"); the same with a deadline ahead (`attempts_offer` "auto").
    //     Created and targeted five days ago, backdated in the DB, so every
    //     day of the two counts. Last, so nothing above moves.
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString()
    await make('ageOld', { title: 'Clear out the garage' })
    await make('slipping', { title: 'Oil the hinges', target_at: twoDaysAgo })
    await make('slippingDeadline', {
      title: 'Book the inspection',
      target_at: twoDaysAgo,
      deadline_at: new Date(Date.now() + 20 * 24 * 3600 * 1000).toISOString(),
    })
    backdate([created.ageOld], 40, ['created_at'])
    backdate([created.slipping, created.slippingDeadline], 5, ['created_at', 'target_set_at'])
    captured['task-badges'] = {
      age: await call(`/api/tasks/${created.ageOld}`),
      attempts: await call(`/api/tasks/${created.slipping}`),
      attempts_deadline: await call(`/api/tasks/${created.slippingDeadline}`),
    }

    // 13. Interval quotas (2026-10-16): every 2 weeks, once. Anchored at
    //     create, so its served period (`progress_period_end`,
    //     `period_interval` 2, `period_last_day`, `period_label` "by …") is
    //     on the task and on its prompt at once. Last, so nothing above moves.
    await make('fortnightly', {
      title: 'Deep-clean the oven',
      rrule: 'FREQ=WEEKLY;INTERVAL=2',
      progress_target: 1,
      is_tracked: true,
    })
    captured['task-interval-quota'] = await call(`/api/tasks/${created.fortnightly}`)
    captured['reminders-interval'] = await call('/api/reminders')
  })

  // 14. Snooze all overdue with the task queue on (`snoozeOverdueWithQueue`).
  // Its own hook, run after the one above, so nothing captured there moves.
  beforeAll(async () => {
    captured['bulk-snooze-overdue'] = await snoozeOverdueWithQueue()
  })

  // 15. The task queue's two panels (`queuePanels`). Last of all.
  beforeAll(async () => {
    let placeholder = 101 + Object.keys(created).length
    const make = async (name: string, body: Record<string, unknown>) => {
      const res = (await call('/api/tasks', body)) as { data: { id: number } }
      created[name] = res.data.id
      ids.register('task', res.data.id, placeholder++)
    }
    const forms = await queuePanels(make, created)
    captured['reminders-queue'] = forms.withQueue
    plainWithQueueOn = forms.plain
  })

  // 16. On deck (`deckRows`). After the queue's panels, so nothing there moves.
  beforeAll(async () => {
    let placeholder = 101 + Object.keys(created).length
    const make = async (name: string, body: Record<string, unknown>) => {
      const res = (await call('/api/tasks', body)) as { data: { id: number } }
      created[name] = res.data.id
      ids.register('task', res.data.id, placeholder++)
    }
    const forms = await deckRows(make, created)
    captured['reminders-deck'] = forms.withDeck
    plainWithoutDeck = forms.plain
  })

  // 17. A deadline-anchored repeat (2026-10-21), as GET /api/tasks/{id}
  //     returns it: deadline weekly at 5 PM, three days out, the target the
  //     day before at 6 PM — `repeat_anchor`, `target_days_before`,
  //     `target_time`, and `deadline_at` = `occurrence_at`. Its own hook,
  //     last, so no earlier placeholder moves.
  beforeAll(async () => {
    const placeholder = 101 + Object.keys(created).length
    const deadline = DateTime.now()
      .setZone('America/New_York')
      .plus({ days: 3 })
      .set({ hour: 17, minute: 0, second: 0, millisecond: 0 })
    // Every 7 days (a bare FREQ=WEEKLY is a quota's period rule; a BYDAY
    // would change with the day this runs): it runs on its own grid.
    const res = (await call('/api/tasks', {
      title: 'Lock the timesheet',
      rrule: 'FREQ=DAILY;INTERVAL=7;BYHOUR=17;BYMINUTE=0',
      deadline_at: deadline.toUTC().toISO(),
      target_days_before: 1,
      target_time: '18:00',
    })) as { data: { id: number } }
    created.deadlineRepeat = res.data.id
    ids.register('task', res.data.id, placeholder)
    captured['task-deadline-anchored'] = await call(`/api/tasks/${res.data.id}`)
  })

  // 18. Repeat ends (2026-10-22): a counted repeat ON ITS LAST OCCURRENCE, as
  //     GET /api/tasks/{id} returns it — every 7 days at 9 AM, 2 times, one
  //     done: `repeat_count` 2, `repeat_count_used` 1, `repeat_last` true,
  //     `repeat_remaining` 1, `repeat_until` null, the rule end-free. Its own
  //     hook, last, so no earlier placeholder moves.
  beforeAll(async () => {
    const placeholder = 101 + Object.keys(created).length
    const res = (await call('/api/tasks', {
      title: 'Physio exercises',
      rrule: 'FREQ=DAILY;INTERVAL=7;BYHOUR=9;BYMINUTE=0',
      repeat_count: 2,
    })) as { data: { id: number } }
    created.repeatEnds = res.data.id
    ids.register('task', res.data.id, placeholder)
    await call(`/api/tasks/${res.data.id}/done`, {})
    captured['task-repeat-ends'] = await call(`/api/tasks/${res.data.id}`)
  })

  // 19. The deadlines page (`deadlineRows`). Its own hook, last.
  beforeAll(async () => {
    let placeholder = 101 + Object.keys(created).length
    const make = async (name: string, body: Record<string, unknown>) => {
      const res = (await call('/api/tasks', body)) as { data: { id: number } }
      created[name] = res.data.id
      ids.register('task', res.data.id, placeholder++)
    }
    const forms = await deadlineRows(make, created)
    captured['reminders-deadlines'] = forms.withDeadlines
    captured['task-segments-defer-lead'] = forms.deferred
    captured['reminders-deadlines-plain'] = forms.plain
    plainWithoutDeadlines = forms.plain
  })

  // 20. Relative targets (2026-10-24). Its own hook, last.
  beforeAll(async () => {
    const placeholder = 101 + Object.keys(created).length
    const slots = (await call('/api/time-slots')) as {
      data: { time_slots: { id: number; start_time: string }[] }
    }
    const period = slots.data.time_slots[slots.data.time_slots.length - 1]
    const res = (await call('/api/tasks', {
      title: 'File the quarterly report',
      deadline_at: nineAm(5),
      target_days_before: 1,
      target_slot_id: period.id,
    })) as { data: { id: number } }
    created.relativeOneOff = res.data.id
    ids.register('task', res.data.id, placeholder)
    captured['task-relative-one-off'] = await call(`/api/tasks/${res.data.id}`)
    captured['task-relative-fixed'] = await call(
      `/api/tasks/${res.data.id}`,
      { target_at: nineAm(3) },
      'PATCH',
    )
  })

  // 21. Upcoming's two sections (2026-10-25). Its own hook, last.
  beforeAll(async () => {
    let placeholder = 101 + Object.keys(created).length
    const make = async (name: string, body: Record<string, unknown>) => {
      const res = (await call('/api/tasks', body)) as { data: { id: number } }
      created[name] = res.data.id
      ids.register('task', res.data.id, placeholder++)
    }
    const day = (n: number) =>
      DateTime.now()
        .setZone('America/New_York')
        .plus({ days: n })
        .set({ hour: 9, minute: 0, second: 0, millisecond: 0 })
        .toUTC()
        .toISO()
    // Listed in this order on purpose: the server puts Tomorrow first.
    await make('sectionLater', { title: 'Plan the garden', target_at: day(6), lead_days: 6 })
    await make('sectionTomorrow', { title: 'Return the library books', target_at: day(1) })
    // A Later row considered today: it stays in the payload (considered),
    // still in its section — the native "Later  1 of 2".
    await make('sectionSeen', { title: 'Book the chimney sweep', target_at: day(5), lead_days: 6 })
    backdate([created.sectionLater, created.sectionTomorrow, created.sectionSeen], 10)
    await call('/api/task-segments/consider', { ids: [created.sectionSeen] })
    captured['reminders-upcoming-sections'] = await call('/api/reminders')
  })

  // 22. The named reminder push's Considered (2026-10-26). Its own hook, last.
  beforeAll(async () => {
    const placeholder = 101 + Object.keys(created).length
    // `rrule: null`: a one-time thought, waiting until considered.
    const res = (await call('/api/tasks', {
      title: 'Stretch before lunch',
      is_reminder: true,
      rrule: null,
      priority: 3,
    })) as { data: { id: number } }
    created.namedReminder = res.data.id
    ids.register('task', res.data.id, placeholder)
    // User B's day starts at 00:00 here (see the first hook), so the
    // OpenTask day is the calendar date in New York at any hour.
    const today = DateTime.now().setZone('America/New_York').toISODate()!
    const yesterday = DateTime.now().setZone('America/New_York').minus({ days: 1 }).toISODate()!
    captured['notification-action-not-waiting'] = await call('/api/notifications/actions', {
      action: 'done',
      task_id: res.data.id,
      day: yesterday,
    })
    captured['notification-action-considered'] = await call('/api/notifications/actions', {
      action: 'done',
      task_id: res.data.id,
      day: today,
    })
  })

  // 23. The named quota-prompt push's buttons (Push PR 4b, 2026-10-26). Its
  //     own hook, after 22, so nothing captured before it moves.
  let staleStatus: { consider: number; did: number } | null = null
  beforeAll(async () => {
    const placeholder = 101 + Object.keys(created).length
    const res = (await call('/api/tasks', {
      title: 'Practice guitar',
      rrule: 'FREQ=WEEKLY',
      progress_target: 3,
      is_tracked: true,
      priority: 2,
    })) as { data: { id: number } }
    created.namedQuota = res.data.id
    ids.register('task', res.data.id, placeholder)
    const prompt = prompts(await call('/api/reminders')).find((p) => p.task_id === res.data.id)
    if (!prompt) throw new Error('scenario prompt missing (step 23)')
    // The banner's Considered, as native sends it: the key, no source.
    captured['quota-prompts-consider'] = await call('/api/quota-prompts/consider', {
      keys: [prompt.prompt_key],
    })
    // Another day's key (yesterday's banner): the status native branches on.
    // Not captured — native reads only the status, never this body.
    const yesterday = DateTime.now().setZone('America/New_York').minus({ days: 1 }).toISODate()!
    const staleKey = prompt.prompt_key.replace(/:[^:]+$/, `:${yesterday}`)
    const consider = await apiFetchB('/api/quota-prompts/consider', {
      method: 'POST',
      body: { keys: [staleKey] },
    })
    const did = await apiFetchB('/api/quota-prompts/did', {
      method: 'POST',
      body: { keys: [staleKey], source: 'mac' },
    })
    staleStatus = { consider: consider.status, did: did.status }
  })

  // 24. Scoped native Undo (2026-10-26). Its own hook, last: it undoes.
  let undoAgain: { status: number; body: Json } | null = null
  // The status right after, read here: step 25's mutations clear the redo stack.
  let statusAfterUndo: Json = null
  beforeAll(async () => {
    const consider = captured['quota-prompts-consider'] as { data: { undo_id: number } }
    captured['undo-by-id'] = await call('/api/undo', { id: consider.data.undo_id })
    // The same id again: already undone. Not captured — native reads only the
    // status and `details`.
    const again = await apiFetchB('/api/undo', {
      method: 'POST',
      body: { id: consider.data.undo_id },
    })
    undoAgain = { status: again.status, body: (await again.json()) as Json }
    statusAfterUndo = await call('/api/undo/status')
  })

  // 25. The native apps' question (native PR E). Its own hook, last of all:
  //     it considers and completes.
  beforeAll(async () => {
    captured['reminders-query'] = { data: { path: REMINDERS_URL } }
    await setTaskQueue(true)
    try {
      // Seen in the safety net: it stays waiting, `seen: true`.
      await call('/api/task-segments/consider', { ids: [created.deadlinePassed] })
      // Read once, so the day roster remembers what is listed (it remembers
      // only rows a `handled=1` read listed), then done from "Today's
      // pulls": back as a considered row, `segment_left: done`.
      await call(REMINDERS_URL)
      await call(`/api/tasks/${created.queueNew}/done`, {})
      captured['reminders-native'] = await call(REMINDERS_URL)
    } finally {
      await setTaskQueue(false)
    }
  })

  test('the native question: every kind in order, left rows, the seen safety net, deck and Try Tomorrow', () => {
    type Row = {
      id: number
      segment_state: string
      segment_left?: string
      safety_net?: boolean
      seen?: boolean
      try_tomorrow?: boolean
      on_deck_day: string | null
    }
    type Segs = { data: { task_segments: { horizon: string; tasks: Row[] }[] } }
    const segs = (captured['reminders-native'] as unknown as Segs).data.task_segments
    expect(segs.map((s) => s.horizon)).toEqual([
      'deadlines',
      'queue_today',
      'queue_previous',
      'days',
      'upcoming',
      'weeks',
      'months',
      'eventually',
    ])
    const row = (horizon: string, id: number) =>
      segs.find((s) => s.horizon === horizon)!.tasks.find((t) => t.id === id)
    expect(row('deadlines', created.deadlinePassed)).toMatchObject({
      segment_state: 'waiting',
      safety_net: true,
      seen: true,
    })
    expect(row('deadlines', created.deadlineWindow)).toMatchObject({
      segment_state: 'considered',
      segment_left: 'deferred',
    })
    expect(row('queue_today', created.queueNew)).toMatchObject({
      segment_state: 'considered',
      segment_left: 'done',
    })
    expect(row('queue_today', created.queueTryTomorrow)?.try_tomorrow).toBe(true)
    expect(row('upcoming', created.decked)?.on_deck_day).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    // `fill`: at least one kind came back empty, with no rows.
    expect(segs.some((s) => s.tasks.length === 0)).toBe(true)
    expect((captured['reminders-query'] as { data: { path: string } }).data.path).toBe(
      REMINDERS_URL,
    )
  })

  test("undo by id: the consider's own undo_id is undone; the same id again is a 409", async () => {
    type U = { data: { undone_id: number; undone_action: string } }
    const consider = captured['quota-prompts-consider'] as { data: { undo_id: number } }
    const undone = (captured['undo-by-id'] as unknown as U).data
    expect(undone.undone_id).toBe(consider.data.undo_id)
    expect(undone.undone_action).toBe('quota_prompt')
    const status = statusAfterUndo as unknown as {
      data: { newest_undoable_id: number; next_redoable_id: number }
    }
    expect(status.data.next_redoable_id).toBe(consider.data.undo_id)
    expect(undoAgain).toEqual({
      status: 409,
      body: {
        error: expect.any(String),
        code: 'CONFLICT',
        details: { reason: 'already_undone', newest_undoable_id: status.data.newest_undoable_id },
      },
    })
    expect(status.data.newest_undoable_id).toBeLessThan(consider.data.undo_id)
  })

  test("quota prompt by key: today's consider answers the quotas, another day's key is a 400", () => {
    type A = { data: { considered: number; did: number; tasks: { id: number }[] } }
    const data = (captured['quota-prompts-consider'] as unknown as A).data
    expect(data.considered).toBe(1)
    expect(data.did).toBe(0)
    expect(data.tasks.map((t) => t.id)).toEqual([created.namedQuota])
    // NotificationActionRunner reads exactly this status as "another day's
    // key": quiet for Considered, "That was yesterday's" for Did it.
    expect(staleStatus).toEqual({ consider: 400, did: 400 })
  })

  test('Considered with a day: true when waiting today, false (and no result) for another day', () => {
    type A = { data: Record<string, unknown> }
    const stale = (captured['notification-action-not-waiting'] as unknown as A).data
    // Nothing logged, so no undo entry (2026-10-26).
    expect(stale).toEqual({
      action: 'done',
      task_id: created.namedReminder,
      considered: false,
      undo_id: null,
    })
    const done = (captured['notification-action-considered'] as unknown as A).data
    expect(done).toMatchObject({ action: 'done', task_id: created.namedReminder, considered: true })
    expect(done.result).toBeDefined()
  })

  test('Upcoming sections: every row carries its section, Tomorrow first', () => {
    type Row = { id: number; upcoming_section?: string; segment_state?: string }
    type Segs = { data: { task_segments: { horizon: string; tasks: Row[] }[] } }
    const segs = (captured['reminders-upcoming-sections'] as unknown as Segs).data.task_segments
    const upcoming = segs.find((s) => s.horizon === 'upcoming')!
    for (const t of upcoming.tasks) expect(t.upcoming_section).toMatch(/^(tomorrow|later)$/)
    const mine = upcoming.tasks
      .filter((t) =>
        [created.sectionLater, created.sectionTomorrow, created.sectionSeen].includes(t.id),
      )
      .map((t) => [t.id, t.upcoming_section, t.segment_state])
    expect(mine).toEqual(
      expect.arrayContaining([
        [created.sectionTomorrow, 'tomorrow', 'waiting'],
        [created.sectionLater, 'later', 'waiting'],
        [created.sectionSeen, 'later', 'considered'],
      ]),
    )
    // Tomorrow's rows first.
    expect(mine[0][0]).toBe(created.sectionTomorrow)
    // No other kind carries it.
    for (const seg of segs.filter((x) => x.horizon !== 'upcoming')) {
      for (const t of seg.tasks) expect(t.upcoming_section).toBeUndefined()
    }
  })

  test('a relative one-off: linked and derived; a pick makes it fixed', () => {
    type T = { data: Record<string, unknown> }
    const linked = (captured['task-relative-one-off'] as unknown as T).data
    expect(linked).toMatchObject({ target_days_before: 1, target_auto: false })
    expect(linked.target_slot_id).toEqual(expect.any(Number))
    expect(linked.target_at).toBe(linked.due_at)
    const fixed = (captured['task-relative-fixed'] as unknown as T).data
    expect(fixed).toMatchObject({
      target_days_before: null,
      target_time: null,
      target_slot_id: null,
      target_at: nineAm(3),
    })
  })

  test('the deadlines page: first, opt-in, the safety net flagged, nearest deadline first', () => {
    type Row = { id: number; segment_state: string; safety_net?: boolean; seen?: boolean }
    type Segs = { data: { task_segments: { horizon: string; tasks: Row[] }[] } }
    const segs = (captured['reminders-deadlines'] as unknown as Segs).data.task_segments
    expect(segs[0].horizon).toBe('deadlines')
    expect(segs[0].tasks.map((t) => [t.id, t.safety_net, t.seen])).toEqual([
      [created.deadlinePassed, true, false],
      [created.deadlineRepeat, false, false],
      [created.deadlineWindow, false, false],
    ])
    const plain = (plainWithoutDeadlines as unknown as Segs).data.task_segments
    expect(plain.map((s) => s.horizon)).not.toContain('deadlines')
    // ... and every one of the three is still listed, in a horizon segment.
    const plainIds = plain.flatMap((s) => s.tasks.map((t) => t.id))
    for (const id of [created.deadlinePassed, created.deadlineRepeat, created.deadlineWindow]) {
      expect(plainIds).toContain(id)
    }
    const deferred = captured['task-segments-defer-lead'] as unknown as {
      data: { deferred: number; refused: unknown[] }
    }
    expect(deferred.data).toMatchObject({ deferred: 1, refused: [] })
  })

  test('without ?deck=1 a decked task is in no segment; with it, an Upcoming row', () => {
    type Segs = {
      data: {
        task_segments: { horizon: string; tasks: { id: number; on_deck_day: string | null }[] }[]
      }
    }
    const plain = (plainWithoutDeck as unknown as Segs).data.task_segments
    const withDeck = (captured['reminders-deck'] as unknown as Segs).data.task_segments
    const upcoming = withDeck.find((s) => s.horizon === 'upcoming')!
    for (const decked of [created.decked, created.deckedRepeating]) {
      for (const seg of plain) for (const t of seg.tasks) expect(t.id).not.toBe(decked)
      expect(upcoming.tasks.find((t) => t.id === decked)?.on_deck_day).toMatch(
        /^\d{4}-\d{2}-\d{2}$/,
      )
    }
  })

  test('without ?queue=1 the switch-on payload has no queue kinds and no queued task', () => {
    type Segs = { data: { task_segments: { horizon: string; tasks: { id: number }[] }[] } }
    const queued = new Set(
      ['queueOld', 'queueWeekly', 'queueNew', 'queueTryTomorrow'].map((n) => created[n]),
    )
    const plain = (plainWithQueueOn as unknown as Segs).data.task_segments
    expect(plain.map((s) => s.horizon)).not.toContain('queue_today')
    expect(plain.map((s) => s.horizon)).not.toContain('queue_previous')
    for (const seg of plain) for (const t of seg.tasks) expect(queued.has(t.id)).toBe(false)
    // The opt-in form has them, first.
    const withQueue = (captured['reminders-queue'] as unknown as Segs).data.task_segments
    expect(withQueue.slice(0, 2).map((s) => s.horizon)).toEqual(['queue_today', 'queue_previous'])
    // Everything else is the same list in both forms.
    expect(plain).toEqual(withQueue.slice(2))
  })

  const names = [
    'user-preferences',
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
    'task-segments-consider',
    'reminders-segments',
    'reminders-upcoming',
    'task-segments-target-today-repeating',
    'quota-prompts-restore',
    'task-counts',
    'bulk-snooze',
    'bulk-snooze-overdue',
    'task-badges',
    'task-interval-quota',
    'reminders-interval',
    'reminders-queue',
    'reminders-deck',
    'task-deadline-anchored',
    'task-repeat-ends',
    'reminders-deadlines',
    'task-segments-defer-lead',
    'reminders-deadlines-plain',
    'task-relative-one-off',
    'task-relative-fixed',
    'reminders-upcoming-sections',
    'notification-action-not-waiting',
    'notification-action-considered',
    'quota-prompts-consider',
    'undo-by-id',
    'reminders-query',
    'reminders-native',
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
