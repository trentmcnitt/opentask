/**
 * THE DAY SIMULATOR (spec "Testing and evaluation", 2026-10-12): steps a task
 * list forward day by day — or hour by hour — and reports, for every local
 * day, what the user would see: each task's place on the Reminders screen (a
 * horizon segment, Upcoming), over target (nagging), done, or quiet; its
 * attempts badge, its age badge and its 3× offer. Plus the day's counts.
 *
 * IT DRIVES THE REAL CORE, not a model of it: the clock is moved (the caller
 * passes `setClock` — `vi.setSystemTime` in a test, a fake timer in the CLI),
 * the screen is read with `getTaskSegments` and `getCurrentlyDueTaskIds`, the
 * badges with `getTaskById` (`rowToTask`'s attempts read) and the rules
 * module, and a POLICY acts through the same functions the API calls
 * (`considerTasks`, `markDone`). So a golden timeline checks the writers too,
 * and there is no second implementation to drift.
 *
 * Used by the golden suite (`tests/golden/`, `tests/behavioral/golden.test.ts`)
 * and by the dev CLI `scripts/simulate-days.ts`, which runs it on a COPY of a
 * database (never the source file). Server-only: it writes to whatever
 * database `getDb()` opens.
 */

import { DateTime } from 'luxon'
import { getCurrentlyDueTaskIds } from '@/core/tasks/currently-due'
import { considerTasks, getTaskSegments } from '@/core/tasks/task-segments'
import { getTaskById } from '@/core/tasks/read'
import { markDone } from '@/core/tasks/mark-done'
import { onDeckToday } from '@/core/tasks/deck'
import {
  ageLabel,
  attemptsOffer,
  type SegmentKind,
  type UpcomingSection,
} from '@/lib/task-segments'
import { taskQueueEnabled } from '@/core/tasks/task-queue'
import { rolloverTimeForUser, runTaskRollover } from '@/core/tasks/task-rollover'
import { dayStartOnDate } from '@/lib/opentask-day'
import type { Task } from '@/types'

/**
 * What the simulated user does at each tick, AFTER the tick is recorded:
 * - `never`: nothing (rows carry over until their day; targets go unmet);
 * - `tap`: considers every waiting row on the Reminders screen (every
 *   segment, Upcoming included) the day it shows;
 * - `complete-repeating`: marks a repeating task done once it is over target
 *   (done on its day);
 * - `complete`: marks every over-target task done.
 * Policies combine: `['tap', 'complete-repeating']`.
 */
export type SimPolicy = 'never' | 'tap' | 'complete-repeating' | 'complete'

/** A scripted step: at a local time, do something (move a target, mark done…). */
export interface SimEvent {
  /** Local wall-clock time in the simulation's zone, e.g. '2026-10-13T10:00'. */
  at: string
  run: (ctx: SimContext) => void
}

export interface SimContext {
  userId: number
  timezone: string
  /** The scenario's task ids by name (filled by `create` events). */
  ids: Record<string, number>
}

/**
 * `deck`: on deck for today (On deck, 2026-10-20 — `onDeckToday`, the On deck
 * section D2 draws), or an earlier day not yet stripped.
 */
export type Place = 'quiet' | 'over' | 'done' | 'gone' | 'deck' | SegmentKind

export interface SimTaskDay {
  id: number
  /** Where it is at the tick: over target outranks a segment, done outranks both. */
  place: Place
  /** Every place it is in at once (the invariants want ALL of them). */
  places: Place[]
  /** Its segment row's state, when in a segment. */
  segmentState: string | null
  /** On the deadlines page (2026-10-22): its safety net and seen flags. */
  deadlines: { safetyNet: boolean; seen: boolean } | null
  /** In Upcoming (2026-10-25, the Upcoming split): its section. */
  section: UpcomingSection | null
  hasTarget: boolean
  /** In the task queue (`queued_at`, task-queue PR 2): stripped, or a repeating task waiting. */
  queued: boolean
  attempts: number
  age: string | null
  offer: 'remove' | null
}

export interface SimDay {
  /** Local date, yyyy-MM-dd. */
  date: string
  /** Weekday, "Sat". */
  weekday: string
  tasks: SimTaskDay[]
  /** Per-day counts across the reported tasks. */
  counts: Record<string, number>
}

export interface SimOptions {
  userId: number
  timezone: string
  /** First local day, yyyy-MM-dd. */
  from: string
  /** Number of local days to step. */
  days: number
  /** The day's recording tick, local HH:mm. Default 21:00 (a day's targets have arrived). */
  at?: string
  /** Tick every hour (applying the policy each hour); the day records at `at`. */
  hourly?: boolean
  policy?: SimPolicy | SimPolicy[]
  events?: SimEvent[]
  /** Report only these tasks (default: every open task of the user at each tick). */
  taskIds?: () => number[]
  setClock: (d: Date) => void
  /**
   * Run the task queue's rollover (`runTaskRollover`, task-queue PR 2) at
   * each day's rollover moment, as the minute cron does: an extra tick at
   * exactly M (the user's first period, else morning_time; read at the
   * time, so periods an event made count), in daily and hourly mode alike,
   * after the events due by then. `late` moves a date's run to a later local
   * time (HH:mm) — a missed run caught up, which still runs as of M. It
   * strips only with the switch on (`OPENTASK_TASK_QUEUE`).
   */
  rollover?: boolean | { late?: Record<string, string> }
  /** Called after each day is recorded (the CLI prints as it goes). */
  onDay?: (day: SimDay) => void
}

const ORDER: Place[] = ['done', 'over']

/** Read one tick: every task's place and badges. */
export function readTick(userId: number, timezone: string, ids: number[], now: Date): SimTaskDay[] {
  const segment = new Map<
    number,
    {
      kind: SegmentKind
      state: string
      safetyNet?: boolean
      seen?: boolean
      section?: UpcomingSection
    }[]
  >()
  for (const seg of getTaskSegments(userId, timezone, now, {
    queuePanels: true,
    deckRows: true,
    deadlineRows: true,
  })) {
    for (const row of seg.tasks) {
      const list = segment.get(row.task.id) ?? []
      list.push({
        kind: seg.horizon,
        state: row.state,
        safetyNet: row.safetyNet,
        seen: row.seen,
        section: row.section,
      })
      segment.set(row.task.id, list)
    }
  }
  const over = new Set(getCurrentlyDueTaskIds(userId, now))
  const deck = new Set(onDeckToday(userId, timezone, now).map((t) => t.id))
  const out: SimTaskDay[] = []
  for (const id of ids) {
    const task = getTaskById(id)
    if (!task || task.deleted_at) {
      out.push(blank(id, 'gone'))
      continue
    }
    const places: Place[] = []
    if (task.done || task.archived_at) places.push('done')
    if (over.has(id)) places.push('over')
    if (deck.has(id)) places.push('deck')
    for (const s of segment.get(id) ?? []) places.push(s.kind)
    if (places.length === 0) places.push('quiet')
    const place = ORDER.find((p) => places.includes(p)) ?? places[0]
    out.push({
      id,
      place,
      places,
      segmentState: segment.get(id)?.[0]?.state ?? null,
      deadlines: deadlinesRow(segment.get(id)),
      section: upcomingSectionOf(segment.get(id)),
      hasTarget: task.due_at !== null,
      queued: task.queued_at !== null,
      attempts: task.attempts,
      age: ageLabel(task, now, timezone),
      offer: attemptsOffer(task, now, { queue: taskQueueEnabled() }),
    })
  }
  return out
}

/** An Upcoming row's section, when the task is in Upcoming. */
function upcomingSectionOf(
  rows: { kind: SegmentKind; section?: UpcomingSection }[] | undefined,
): UpcomingSection | null {
  return rows?.find((r) => r.kind === 'upcoming')?.section ?? null
}

/** A deadlines-page row's flags, when the task is on the page. */
function deadlinesRow(
  rows: { kind: SegmentKind; safetyNet?: boolean; seen?: boolean }[] | undefined,
): { safetyNet: boolean; seen: boolean } | null {
  const row = rows?.find((r) => r.kind === 'deadlines')
  return row ? { safetyNet: !!row.safetyNet, seen: !!row.seen } : null
}

function blank(id: number, place: Place): SimTaskDay {
  return {
    id,
    place,
    places: [place],
    segmentState: null,
    deadlines: null,
    section: null,
    hasTarget: false,
    queued: false,
    attempts: 0,
    age: null,
    offer: null,
  }
}

/**
 * The one-line form a golden timeline states: the place, then the badges
 * the row would draw — "over 3× →remove", "tomorrow", "weeks >1 mo",
 * "quiet 1×" (a target moved ahead after a miss). A task in the task queue
 * (task-queue PR 2) adds "queued" after the place, and keeps showing its
 * attempts with no target (B7: a strip never resets them): "weeks queued 2×".
 */
export function dayLine(t: SimTaskDay): string {
  // Upcoming (2026-10-25, the Upcoming split): its SECTION is the place a
  // line states — "tomorrow" (the day before the anchor) or "later". The
  // counts still say `upcoming` (both sections).
  const parts: string[] = [t.place === 'upcoming' && t.section ? t.section : t.place]
  // The deadlines page (2026-10-22): "deadlines net" in the safety net, and
  // "seen" once considered this OpenTask day ("deadlines seen" outside the
  // net is the considered state; "deadlines net seen" still nags).
  if (t.place === 'deadlines' && t.deadlines) {
    if (t.deadlines.safetyNet) parts.push('net')
    if (t.deadlines.seen) parts.push('seen')
  }
  if (t.place !== 'done' && t.queued) parts.push('queued')
  if (t.place !== 'done' && (t.hasTarget || t.queued) && t.attempts > 0) {
    parts.push(`${t.attempts}×`)
  }
  if (t.age) parts.push(t.age)
  if (t.place !== 'done' && t.offer) parts.push(`→${t.offer}`)
  return parts.join(' ')
}

function applyPolicy(
  policy: SimPolicy[],
  userId: number,
  timezone: string,
  now: Date,
  ids: number[],
): void {
  if (policy.includes('tap')) {
    const waiting = getTaskSegments(userId, timezone, now, {
      queuePanels: true,
      deckRows: true,
      deadlineRows: true,
    })
      .flatMap((s) => s.tasks)
      .filter((r) => r.state === 'waiting' && ids.includes(r.task.id))
      .map((r) => r.task.id)
    if (waiting.length > 0) considerTasks(userId, [...new Set(waiting)])
  }
  const completeAll = policy.includes('complete')
  if (completeAll || policy.includes('complete-repeating')) {
    const over = getCurrentlyDueTaskIds(userId, now).filter((id) => ids.includes(id))
    for (const id of over) {
      const task = getTaskById(id) as Task
      if (completeAll || task.rrule) markDone({ userId, userTimezone: timezone, taskId: id })
    }
  }
}

/** The user's open, ordinary task ids (no reminders or quotas): the CLI's default report set. */
function defaultIds(userId: number, now: Date, timezone: string): number[] {
  return getTaskSegments(userId, timezone, now, {
    queuePanels: true,
    deckRows: true,
    deadlineRows: true,
  })
    .flatMap((s) => s.tasks.map((r) => r.task.id))
    .concat(getCurrentlyDueTaskIds(userId, now))
    .concat(onDeckToday(userId, timezone, now).map((t) => t.id))
}

/**
 * When a calendar day's rollover runs in the simulation: the day start that
 * falls on that date (`dayStartOnDate` — with a start after 12:00 it starts
 * the NEXT OpenTask day), or the day's `late` time.
 */
function rolloverTick(opts: SimOptions, userId: number, timezone: string, day: DateTime): DateTime {
  const date = day.toISODate()!
  const late = typeof opts.rollover === 'object' ? opts.rollover.late?.[date] : undefined
  if (late) return DateTime.fromISO(`${date}T${late}`, { zone: timezone })
  return DateTime.fromJSDate(dayStartOnDate(date, timezone, rolloverTimeForUser(userId))).setZone(
    timezone,
  )
}

/** One day's record: its tasks and the per-place counts. */
function recordDay(day: DateTime, tasks: SimDay['tasks']): SimDay {
  const counts: Record<string, number> = {}
  for (const t of tasks) {
    for (const p of t.places) counts[p] = (counts[p] ?? 0) + 1
    if (t.offer && t.place !== 'done') counts.offers = (counts.offers ?? 0) + 1
    if (t.queued && t.place !== 'done') counts.queued = (counts.queued ?? 0) + 1
  }
  return { date: day.toISODate()!, weekday: day.toFormat('ccc'), tasks, counts }
}

/** Step the days. Events run at their times; each day records at its tick. */
export function simulateDays(opts: SimOptions): SimDay[] {
  const { userId, timezone } = opts
  const policy = ([] as SimPolicy[]).concat(opts.policy ?? 'never')
  const [hour, minute] = (opts.at ?? '21:00').split(':').map(Number)
  const ctx: SimContext = { userId, timezone, ids: {} }
  const events = [...(opts.events ?? [])]
    .map((e) => ({ ...e, ms: DateTime.fromISO(e.at, { zone: timezone }).toMillis() }))
    .sort((a, b) => a.ms - b.ms)
  let next = 0
  const runEventsUntil = (ms: number) => {
    while (next < events.length && events[next].ms <= ms) {
      opts.setClock(new Date(events[next].ms))
      events[next].run(ctx)
      next++
    }
  }

  const start = DateTime.fromISO(opts.from, { zone: timezone }).startOf('day')
  const out: SimDay[] = []
  for (let d = 0; d < opts.days; d++) {
    const day = start.plus({ days: d })
    const record = day.set({ hour, minute })
    const ticks = opts.hourly
      ? Array.from({ length: 24 }, (_, h) => day.set({ hour: h, minute }))
      : [record]
    let recorded: SimDay | null = null
    // The day's rollover runs once, before the first tick at or after it — or
    // after the last tick when it comes later (a day start after the record
    // time: 23:00 with the 21:00 record), still on its own date.
    let pending = opts.rollover ? rolloverTick(opts, userId, timezone, day) : null
    const rollUntil = (until: DateTime | null) => {
      if (!pending || (until && +pending > +until)) return
      runEventsUntil(pending.toMillis())
      opts.setClock(pending.toJSDate())
      runTaskRollover({ now: pending.toJSDate(), userId })
      pending = null
    }
    for (const tick of ticks) {
      rollUntil(tick)
      runEventsUntil(tick.toMillis())
      const now = tick.toJSDate()
      opts.setClock(now)
      const ids = opts.taskIds?.() ?? [...new Set(defaultIds(userId, now, timezone))]
      if (+tick === +record) recorded = recordDay(day, readTick(userId, timezone, ids, now))
      applyPolicy(policy, userId, timezone, now, ids)
    }
    rollUntil(null)
    out.push(recorded!)
    opts.onDay?.(recorded!)
  }
  runEventsUntil(start.plus({ days: opts.days }).toMillis())
  return out
}
