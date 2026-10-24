/**
 * THE DAY SIMULATOR, as a dev CLI (spec "Testing and evaluation", 2026-10-12;
 * the engine is `src/core/sim/day-simulator.ts`). Replays a user's task list
 * forward day by day and prints each day's Reminders screen load: how many
 * rows in each task segment (Upcoming included), how many over target, how
 * many at the 3× offer — and which task ids.
 *
 *   npx tsx scripts/simulate-days.ts <database> --user <id> [--days 61]
 *       [--policy never|tap|complete-repeating|complete[,…]] [--from yyyy-MM-dd]
 *       [--at HH:mm] [--hourly] [--rollover] [--titles] [--json]
 *
 * NEVER WRITES TO <database>. It is opened READ-ONLY and copied with SQLite's
 * online backup into a temporary file, which the simulation runs on and which
 * is deleted at the end. On that copy, before anything runs, every delivery
 * channel is emptied (push subscriptions, APNs devices, widget push tokens,
 * webhooks), so a simulated "done" can never reach a real phone or URL.
 * Still: run it on a `.backup` copy of production, never the live file (ruling
 * Q11), and keep that copy out of the repo.
 *
 * `--rollover` turns the task queue on (OPENTASK_TASK_QUEUE=1, in this process
 * only) and runs its rollover at each day's rollover moment
 * (src/core/tasks/task-rollover.ts) — the go-live dry run. Each user's stamp
 * on the copy is set to the day before `--from`, so the first simulated
 * morning rolls.
 *
 * Ids only by default; `--titles` prints titles too — for local use only, never
 * paste the output anywhere public.
 *
 * It PLAYS THE SERVER on the copy (`markServerProcess`, before the database
 * opens): the copy's start runs the task-queue switch's data steps for the
 * switch this run chose (`--rollover` or not), as the server's next start
 * would — a plain script skips them (src/core/db/process-role.ts). Only the
 * copy is written.
 *
 * The clock: the script installs a simulated `Date` (and so Luxon's clock)
 * and moves it tick by tick; nothing else in the process runs.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'
import { markServerProcess } from '../src/core/db/process-role'
import type { SimDay, SimPolicy } from '../src/core/sim/day-simulator'

interface Args {
  db: string
  user: number
  days: number
  policy: SimPolicy[]
  from: string | null
  at: string
  hourly: boolean
  rollover: boolean
  titles: boolean
  json: boolean
}

const POLICIES: SimPolicy[] = ['never', 'tap', 'complete-repeating', 'complete']
const USAGE =
  'Usage: npx tsx scripts/simulate-days.ts <database> --user <id> [--days 61] [--policy tap] ' +
  '[--from yyyy-MM-dd] [--at HH:mm] [--hourly] [--rollover] [--titles] [--json]'

function parseArgs(argv: string[]): Args {
  const args: Args = {
    db: '',
    user: NaN,
    days: 61,
    policy: ['never'],
    from: null,
    at: '21:00',
    hourly: false,
    rollover: false,
    titles: false,
    json: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === '--user') args.user = Number(next())
    else if (a === '--days') args.days = Number(next())
    else if (a === '--policy') args.policy = next().split(',') as SimPolicy[]
    else if (a === '--from') args.from = next()
    else if (a === '--at') args.at = next()
    else if (a === '--hourly') args.hourly = true
    else if (a === '--rollover') args.rollover = true
    else if (a === '--titles') args.titles = true
    else if (a === '--json') args.json = true
    else if (!a.startsWith('--') && !args.db) args.db = a
    else throw new Error(`Unknown argument: ${a}\n${USAGE}`)
  }
  if (!args.db || !Number.isInteger(args.user)) throw new Error(USAGE)
  if (!Number.isInteger(args.days) || args.days < 1) throw new Error('--days must be 1 or more')
  for (const p of args.policy) {
    if (!POLICIES.includes(p)) throw new Error(`Unknown policy ${p}: ${POLICIES.join(', ')}`)
  }
  if (!/^\d{2}:\d{2}$/.test(args.at)) throw new Error('--at must be HH:mm')
  return args
}

/** Copy the source read-only, then empty every channel that could leave the machine. */
async function makeCopy(source: string): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentask-sim-'))
  const copy = path.join(dir, 'sim.db')
  const src = new Database(source, { readonly: true, fileMustExist: true })
  try {
    await src.backup(copy)
  } finally {
    src.close()
  }
  const db = new Database(copy)
  try {
    for (const table of ['push_subscriptions', 'apns_devices', 'widget_push_tokens', 'webhooks']) {
      const exists = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table)
      if (exists) db.exec(`DELETE FROM ${table}`)
    }
  } finally {
    db.close()
  }
  return copy
}

/** A `Date` whose "now" is the simulation's. Luxon reads `Date.now()` at call time. */
function installClock(): (d: Date) => void {
  const RealDate = Date
  let nowMs = RealDate.now()
  class SimDate extends RealDate {
    constructor(...args: ConstructorParameters<typeof Date> | []) {
      if (args.length === 0) super(nowMs)
      else super(...(args as ConstructorParameters<typeof Date>))
    }
    static now(): number {
      return nowMs
    }
  }
  globalThis.Date = SimDate as DateConstructor
  return (d: Date) => {
    nowMs = d.getTime()
  }
}

const SEGMENTS = ['days', 'upcoming', 'weeks', 'months', 'eventually'] as const

function printDay(day: SimDay, titles: Map<number, string> | null): void {
  const c = (k: string) => String(day.counts[k] ?? 0).padStart(3)
  const head =
    `${day.weekday} ${day.date}  ` +
    SEGMENTS.map((s) => `${s} ${c(s)}`).join('  ') +
    `  | over ${c('over')}  3×+ ${c('offers')}  queued ${c('queued')}  deck ${c('deck')}`
  console.log(head)
  for (const kind of ['upcoming', 'over'] as const) {
    const ids = day.tasks.filter((t) => t.places.includes(kind)).map((t) => t.id)
    if (ids.length === 0) continue
    const list = titles
      ? ids.map((id) => `${id} ${titles.get(id) ?? ''}`).join('; ')
      : ids.join(',')
    console.log(`    ${kind}: ${list}`)
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const copy = await makeCopy(args.db)
  // Point the app's database at the copy BEFORE any core module loads.
  process.env.OPENTASK_DB_PATH = copy
  process.env.OPENTASK_AI_ENABLED = 'false'
  if (args.rollover) process.env.OPENTASK_TASK_QUEUE = '1'
  try {
    const setClock = installClock()
    markServerProcess()
    const { getDb } = await import('../src/core/db')
    const { simulateDays } = await import('../src/core/sim/day-simulator')
    const { DateTime } = await import('luxon')
    const user = getDb().prepare('SELECT id, timezone FROM users WHERE id = ?').get(args.user) as
      | { id: number; timezone: string }
      | undefined
    if (!user) throw new Error(`No user ${args.user} in that database`)
    const titles = args.titles
      ? new Map(
          (
            getDb().prepare('SELECT id, title FROM tasks WHERE user_id = ?').all(user.id) as {
              id: number
              title: string
            }[]
          ).map((r) => [r.id, r.title]),
        )
      : null
    const from = args.from ?? DateTime.now().setZone(user.timezone).toISODate()!
    if (args.rollover) {
      // On the copy only: the first simulated morning is the first rollover.
      const before = DateTime.fromISO(from).minus({ days: 1 }).toISODate()
      getDb().prepare('UPDATE users SET last_rollover_date = ? WHERE id = ?').run(before, user.id)
    }
    if (!args.json) {
      console.log(
        `user ${user.id} (${user.timezone}) · ${args.days} days from ${from} at ${args.at}` +
          `${args.hourly ? ' (hourly)' : ''}${args.rollover ? ' · rollover' : ''} · policy ${args.policy.join('+')} · on a copy`,
      )
    }
    const days = simulateDays({
      userId: user.id,
      timezone: user.timezone,
      from,
      days: args.days,
      at: args.at,
      hourly: args.hourly,
      policy: args.policy,
      rollover: args.rollover,
      setClock,
      onDay: args.json ? undefined : (day) => printDay(day, titles),
    })
    if (args.json) {
      console.log(
        JSON.stringify(
          days.map((d) => ({ date: d.date, counts: d.counts })),
          null,
          2,
        ),
      )
    } else {
      const avg = (k: string) =>
        (days.reduce((n, d) => n + (d.counts[k] ?? 0), 0) / days.length).toFixed(1)
      console.log(
        `\nper day: upcoming ${avg('upcoming')} · over ${avg('over')} · ` +
          `segments ${avg('days')}/${avg('weeks')}/${avg('months')}/${avg('eventually')} (days/weeks/months/eventually)`,
      )
    }
  } finally {
    fs.rmSync(path.dirname(copy), { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
