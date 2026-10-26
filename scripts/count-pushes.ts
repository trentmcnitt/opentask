/**
 * COUNT PUSHES — a measurement, nothing more (plan "named pushes and marks",
 * 2026-10-26). Projects every push the minute tick would send one user over
 * one OpenTask day (day start to day start), minute by minute, with the
 * server's own planners (`MINUTE_TICK_SOURCES` through `planTick`, the clock
 * marks and the one-alert-per-tick rule included), and prints COUNTS ONLY:
 * per hour, alerting vs passive, by kind. No titles, no ids, no task data.
 *
 *   npx tsx scripts/count-pushes.ts <database> --user <id> [--day yyyy-MM-dd]
 *       [--queue on|off] [--channels apns,web] [--json]
 *
 *  --day       the OpenTask day (default: the user's current one)
 *  --queue     the task-queue switch (default on): on runs the task rollover
 *              before every tick, as the server's cron does, and the day
 *              turns at the user's day start; off, at midnight
 *  --channels  which channels the user receives (default: what the user has
 *              registered — an APNs device, a Web Push subscription). Period
 *              pushes and nags are APNs only.
 *
 * NEVER WRITES TO <database>. It is opened read-only and copied with SQLite's
 * online backup into a temporary file, which is deleted at the end. On the
 * copy, before anything runs: every delivery channel is emptied (push
 * subscriptions, APNs devices, widget tokens, webhooks), every other user's
 * notifications are switched off (so only this user is planned), and this
 * user's `nag_sends` stamps from the projected day or later are dropped (a
 * mid-morning backup would otherwise hold the nags back until that time).
 * Run it on a `.backup` copy of production, never the live file.
 *
 * WHAT IT ASSUMES. Nothing is considered, done or deferred during the day:
 * every banner is projected against the copy's state as it stands. For a day
 * already under way, what the user did before the backup counts (a reminder
 * already considered does not push); for the cleanest projection, run it on
 * a day that has not started. It never delivers anything: `deliver` and the
 * overdue checker's after-step are never called, so badge-only pushes are not
 * counted, and neither are pushes outside the minute tick (AI-finished,
 * action feedback).
 *
 * It PLAYS THE SERVER on the copy (`markServerProcess`, before the database
 * opens), so the copy's start runs the task-queue switch's data steps for the
 * switch this run chose. The clock: a simulated `Date` (and so Luxon's),
 * moved minute by minute; nothing else in the process runs.
 *
 * No "old rules" mode: the old repeat timing would need a toggle in the
 * production code. The total (alerting + passive) is what every banner would
 * have done without the one-alert rule; the "before" is the journal count.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'
import { markServerProcess } from '../src/core/db/process-role'
import type { PushKind } from '../src/core/notifications/tick'

interface Args {
  db: string
  user: number
  day: string | null
  queue: boolean
  channels: { apns: boolean; webPush: boolean } | null
  json: boolean
}

const USAGE =
  'Usage: npx tsx scripts/count-pushes.ts <database> --user <id> [--day yyyy-MM-dd] ' +
  '[--queue on|off] [--channels apns,web] [--json]'

function parseChannels(value: string): { apns: boolean; webPush: boolean } {
  const list = value.split(',').map((c) => c.trim())
  for (const c of list) {
    if (c !== 'apns' && c !== 'web') throw new Error(`Unknown channel ${c}: apns, web`)
  }
  return { apns: list.includes('apns'), webPush: list.includes('web') }
}

function parseArgs(argv: string[]): Args {
  const args: Args = { db: '', user: NaN, day: null, queue: true, channels: null, json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i] ?? ''
    if (a === '--user') args.user = Number(next())
    else if (a === '--day') args.day = next()
    else if (a === '--queue') {
      const v = next()
      if (v !== 'on' && v !== 'off') throw new Error('--queue must be on or off')
      args.queue = v === 'on'
    } else if (a === '--channels') args.channels = parseChannels(next())
    else if (a === '--json') args.json = true
    else if (!a.startsWith('--') && !args.db) args.db = a
    else throw new Error(`Unknown argument: ${a}\n${USAGE}`)
  }
  if (!args.db || !Number.isInteger(args.user)) throw new Error(USAGE)
  if (args.day !== null && !/^\d{4}-\d{2}-\d{2}$/.test(args.day)) {
    throw new Error('--day must be yyyy-MM-dd')
  }
  return args
}

/**
 * Copy the source read-only, note which channels the user has, then empty
 * every channel that could leave the machine.
 */
async function makeCopy(
  source: string,
  userId: number,
): Promise<{ copy: string; registered: { apns: boolean; webPush: boolean } }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentask-pushes-'))
  const copy = path.join(dir, 'pushes.db')
  const src = new Database(source, { readonly: true, fileMustExist: true })
  try {
    await src.backup(copy)
  } finally {
    src.close()
  }
  const db = new Database(copy)
  try {
    const has = (table: string) =>
      Boolean(
        db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
      )
    const userHas = (table: string) =>
      has(table) && Boolean(db.prepare(`SELECT 1 FROM ${table} WHERE user_id = ?`).get(userId))
    const registered = { apns: userHas('apns_devices'), webPush: userHas('push_subscriptions') }
    for (const table of ['push_subscriptions', 'apns_devices', 'widget_push_tokens', 'webhooks']) {
      if (has(table)) db.exec(`DELETE FROM ${table}`)
    }
    return { copy, registered }
  } finally {
    db.close()
  }
}

/** A `Date` whose "now" is the projection's. Luxon reads `Date.now()` at call time. */
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

interface Tally {
  alert: number
  passive: number
}
interface HourRow {
  /** Local "HH:mm" of the hour's start (with the offset on a DST day's repeated hour). */
  label: string
  alert: number
  passive: number
  /** Minutes in this hour with at least one alerting push: how often the phone sounds. */
  alertMinutes: number
  byKind: Map<PushKind, Tally>
}

function tallyFor(row: HourRow, kind: PushKind): Tally {
  let t = row.byKind.get(kind)
  if (!t) {
    t = { alert: 0, passive: 0 }
    row.byKind.set(kind, t)
  }
  return t
}

/** Count one minute's planned sends into its hour's row. */
function recordMinute(
  rows: Map<number, HourRow>,
  hourStart: number,
  label: string,
  sends: { kind: PushKind; delivery: { passive: boolean } }[],
): void {
  let row = rows.get(hourStart)
  if (!row) {
    row = { label, alert: 0, passive: 0, alertMinutes: 0, byKind: new Map() }
    rows.set(hourStart, row)
  }
  let alerted = false
  for (const s of sends) {
    const tally = tallyFor(row, s.kind)
    if (s.delivery.passive) {
      row.passive++
      tally.passive++
    } else {
      row.alert++
      tally.alert++
      alerted = true
    }
  }
  if (alerted) row.alertMinutes++
}

function printTable(rows: HourRow[], kinds: readonly PushKind[]): void {
  const used = kinds.filter((k) => rows.some((r) => r.byKind.has(k)))
  const pad = (s: string | number, n: number) => String(s).padStart(n)
  const cell = (t: Tally | undefined) => (t ? `${t.alert}/${t.passive}` : '-')
  console.log(
    ['hour  ', pad('alert', 6), pad('passive', 8), pad('alert-min', 10)]
      .concat(used.map((k) => pad(k, Math.max(k.length, 7))))
      .join(' '),
  )
  for (const r of rows) {
    console.log(
      [r.label.padEnd(6), pad(r.alert, 6), pad(r.passive, 8), pad(r.alertMinutes, 10)]
        .concat(used.map((k) => pad(cell(r.byKind.get(k)), Math.max(k.length, 7))))
        .join(' '),
    )
  }
  const sum = (f: (r: HourRow) => number) => rows.reduce((n, r) => n + f(r), 0)
  const totals = used.map((k) => {
    const t = {
      alert: sum((r) => r.byKind.get(k)?.alert ?? 0),
      passive: sum((r) => r.byKind.get(k)?.passive ?? 0),
    }
    return pad(cell(t), Math.max(k.length, 7))
  })
  console.log(
    [
      'total ',
      pad(
        sum((r) => r.alert),
        6,
      ),
      pad(
        sum((r) => r.passive),
        8,
      ),
    ]
      .concat(
        pad(
          sum((r) => r.alertMinutes),
          10,
        ),
        totals,
      )
      .join(' '),
  )
  console.log('\nkind cells are alert/passive banners.')
}

/** Prepare the copy for one user's day: only this user notified, stale stamps out. */
function prepareCopy(
  db: import('better-sqlite3').Database,
  userId: number,
  dayStartIso: string,
  queue: boolean,
  day: string,
  addDays: (date: string, n: number) => string,
): { otherUsersOff: number; stampsDropped: number } {
  const otherUsersOff = db
    .prepare(
      'UPDATE users SET notifications_enabled = 0 WHERE id != ? AND notifications_enabled = 1',
    )
    .run(userId).changes
  const stampsDropped = db
    .prepare('DELETE FROM nag_sends WHERE user_id = ? AND datetime(last_sent_at) >= datetime(?)')
    .run(userId, dayStartIso).changes
  // The day's own rollover runs at its day start, as the server's would.
  if (queue) {
    db.prepare('UPDATE users SET last_rollover_date = ? WHERE id = ?').run(addDays(day, -1), userId)
  }
  return { otherUsersOff, stampsDropped }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const { copy, registered } = await makeCopy(args.db, args.user)
  // Point the app's database at the copy BEFORE any core module loads.
  process.env.OPENTASK_DB_PATH = copy
  process.env.OPENTASK_AI_ENABLED = 'false'
  process.env.OPENTASK_TASK_QUEUE = args.queue ? '1' : ''
  // Counts only: no log lines from the planners.
  process.env.LOG_LEVEL = 'error'
  try {
    const setClock = installClock()
    markServerProcess()
    const { getDb } = await import('../src/core/db')
    const { DateTime } = await import('luxon')
    const { planTick, LEAD_ORDER } = await import('../src/core/notifications/tick')
    const { MINUTE_TICK_SOURCES } = await import('../src/core/notifications/minute-tick')
    const { runTaskRollover } = await import('../src/core/tasks/task-rollover')
    const { rolloverTrackedPeriods } = await import('../src/core/tasks/period-rollover')
    const { dayBoundaryForUser } = await import('../src/core/tasks/rollover-time')
    const { openTaskDayOf, openTaskDateSpan, addDays } = await import('../src/lib/opentask-day')

    const db = getDb()
    const user = db
      .prepare('SELECT id, timezone, notifications_enabled, is_demo FROM users WHERE id = ?')
      .get(args.user) as
      | { id: number; timezone: string; notifications_enabled: number; is_demo: number }
      | undefined
    if (!user) throw new Error(`No user ${args.user} in that database`)
    const dayStart = dayBoundaryForUser(user.id)
    const day = args.day ?? openTaskDayOf(new Date(), user.timezone, dayStart)
    const span = openTaskDateSpan(day, user.timezone, dayStart)
    const channels = args.channels ?? registered
    const prep = prepareCopy(db, user.id, span.start.toISOString(), args.queue, day, addDays)

    const rows = new Map<number, HourRow>()
    for (let t = span.start.getTime(); t < span.end.getTime(); t += 60_000) {
      const now = new Date(t)
      setClock(now)
      if (args.queue) runTaskRollover({ now, userId: user.id })
      if (now.getUTCMinutes() % 5 === 0) rolloverTrackedPeriods(now, user.id)
      const sends = planTick([...MINUTE_TICK_SOURCES], now, channels).sends.filter(
        (s) => s.userId === user.id,
      )
      if (sends.length === 0) continue
      const local = DateTime.fromMillis(t, { zone: user.timezone })
      recordMinute(rows, local.startOf('hour').toMillis(), local.toFormat('HH:00'), sends)
    }
    const hours = [...rows.entries()].sort(([a], [b]) => a - b).map(([, r]) => r)

    if (args.json) {
      console.log(
        JSON.stringify(
          {
            user: user.id,
            day,
            start: span.start.toISOString(),
            end: span.end.toISOString(),
            queue: args.queue,
            channels,
            hours: hours.map((r) => ({
              hour: r.label,
              alert: r.alert,
              passive: r.passive,
              alert_minutes: r.alertMinutes,
              by_kind: Object.fromEntries(r.byKind),
            })),
          },
          null,
          2,
        ),
      )
      return
    }
    const fmt = (d: Date) => DateTime.fromJSDate(d).setZone(user.timezone).toFormat('MM-dd HH:mm')
    const on = [channels.apns && 'apns', channels.webPush && 'web'].filter(Boolean).join('+')
    console.log(
      `user ${user.id} (${user.timezone}) · OpenTask day ${day}, ${fmt(span.start)} → ${fmt(span.end)}` +
        ` · task queue ${args.queue ? 'on' : 'off'} · channels ${on || 'none'} · on a copy`,
    )
    console.log(
      `copy: ${prep.otherUsersOff} other user(s) switched off, ${prep.stampsDropped} nag stamp(s) ` +
        'from this day dropped · badge-only and non-tick pushes not counted\n',
    )
    if (!user.notifications_enabled || user.is_demo) {
      console.log('this user is not notified (notifications off or demo): nothing would send\n')
    }
    if (!channels.apns && !channels.webPush) {
      console.log('no channel: pass --channels apns,web to project anyway\n')
    }
    printTable(hours, LEAD_ORDER)
  } finally {
    fs.rmSync(path.dirname(copy), { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
