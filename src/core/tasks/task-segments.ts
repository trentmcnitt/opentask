/**
 * RULE SEG-NEVER-NOTIFIED: Task segments are not in groups[]. Their rows never count in the badge,
 *   slot notifications or the slot nag, and a segment never sends a push. The deadlines nag has its
 *   own rule (DL-NAG).
 * Why: A task segment never makes the reminders channel nag (spec §3); anything time-critical has a
 *   target.
 * Ruling: Headline counted separately: Trent 2026-10-26 ruling 'B' (docs/TASK-MODEL.md:207).
 */
/**
 * Task segments on the reminders screen (2026-10-10, docs/TASK-MODEL.md
 * § Task segments). The rules for which task shows where are pure and live in
 * `src/lib/task-segments.ts`; this module reads the rows and writes the three
 * segment actions.
 *
 * WHICH TASKS: the user's own open, one-off tasks — not reminders, quotas or
 * recurring tasks. A recurring task's schedule already brings it round, and
 * reminders and quotas have their own rows on the same screen. Only the
 * owner's: a task in someone else's shared project is theirs to consider.
 *
 * SEPARATE FROM THE TIME SLOTS. Segments are not in `groups[]` and never touch
 * the slot notifications or the hourly unfinished-slot nag — a task segment
 * never makes the reminders channel nag (spec §3). Anything time-critical has
 * a target, and a task whose target has arrived is on the dashboard, not here.
 *
 * THE ACTIONS. Consider (the circle) stamps `last_considered_at` and is never a
 * completion. Defer All stamps `segment_deferred_at`: off today's list, back
 * tomorrow, and not a consider, which keeps "considered" honest. Target today
 * is a deliberate target — the age clock starts there. Each is one undo entry;
 * a misfire is undone with the standard Undo.
 *
 * Repeating tasks appear only in Upcoming (their next occurrence's heads-ups)
 * and, waiting for their next occurrence, in the task queue.
 *
 * THE TASK QUEUE (task-queue PR 3, 2026-10-19; docs/TASK-MODEL.md § The task
 * queue). With the server switch on (`OPENTASK_TASK_QUEUE`), two more
 * segments come FIRST: `queue_today` (queued by this OpenTask day's rollover)
 * and `queue_previous` (queued earlier, never handed back) — `queueKind` in
 * src/lib/task-segments.ts. A queued task is in no horizon segment and not in
 * Upcoming (rule 7). Consider on a stripped one-off also takes it OUT of the
 * queue (`queued_at` cleared in the same write): it goes back to its horizon
 * segment, ticked there today through the shared `last_considered_at`. A
 * waiting repeating task stays queued and shows again tomorrow. Switch off:
 * queued tasks fall through to the horizon segments and Upcoming as before.
 *
 * THE DEADLINES PAGE (2026-10-22; docs/TASK-MODEL.md § The deadlines page).
 * With the switch on and a caller that draws it (`?deadlines=1`), a deadline
 * task with NO target — a one-off, or a deadline-anchored repeat with no
 * relative target — is placed by `deadlinePlace`: from its lead day
 * (`lead_from`) on the `deadlines` segment (FIRST — the only queue page that
 * nags), from the day before its deadline in the safety net (seeing it does
 * not silence it); before its lead day, quiet — never in Upcoming, a future
 * deck's row included (rule 3 of the Upcoming split, 2026-10-25). Rows carry
 * `safety_net` and `seen`. Sorted priority, then the nearest
 * deadline, then id (A4). A caller that does not draw it (a shipped native
 * build) gets a target-less one-off in its horizon segment, as before
 * 10-12 (the deadline pulling the horizon in) — a truthful, dated degrade.
 */

import { getDb, withTransaction } from '@/core/db'
import { logAction, createTaskSnapshot } from '@/core/undo'
import { AppError, ValidationError } from '@/core/errors'
import { emitSyncEvent } from '@/lib/sync-events'
import { listTimeSlots } from '@/core/time-slots'
import { getAnchorTimes } from '@/core/users/anchor-times'
import { targetTodayTimeFor } from '@/lib/snooze'
import { DateTime } from 'luxon'
import type { Task } from '@/types'
import {
  SEGMENT_NUDGE_THRESHOLD,
  SEGMENT_ORDER,
  compareQueueRows,
  isQueueKind,
  queueKind,
  queueRowState,
  coerceCheckInDay,
  segmentState,
  type CheckInDay,
  type HorizonValue,
  type SegmentKind,
  type SegmentState,
  type UpcomingSection,
} from '@/lib/task-segments'
import {
  LEAD_DEFER_MESSAGES,
  compareDeadlineRows,
  deadlinePlace,
  isDeadlinePageTask,
  leadDeferRefusal,
  openTaskToday,
  parseDeckDay,
  shiftDay,
  type LeadDeferRefusal,
  upcomingCandidate,
  upcomingState,
} from '@/lib/task-segments'
import { rowToTask, taskColumns, type TaskRow } from './read'
import { bulkEdit } from './bulk'
import { taskQueueEnabled } from './task-queue'
import { dayBoundaryForUser, rolloverTimeForUser } from './rollover-time'
import { dayStartMoment, latestRollover, openTaskDayOf } from '@/lib/opentask-day'
import { markRosterDeferred, rosterLeftRows, type SegmentLeft } from './segment-roster'
import { logActivity } from '@/core/activity'
import { dispatchWebhookEvent } from '@/core/webhooks/dispatch'
import { formatTaskResponse } from '@/lib/format-task'
import { agedOutState, compareAgedOut, growStep } from '@/lib/aged-out'

export interface SegmentTask {
  task: Task
  state: SegmentState
  /** Deadlines page rows only: the safety net holds it (from D−1; seeing does not silence it). */
  safetyNet?: boolean
  /** Deadlines page rows only: considered this OpenTask day. */
  seen?: boolean
  /**
   * Upcoming rows only (2026-10-25, the Upcoming split): the section the row
   * is in — Tomorrow (the day before its anchor) or Later. A left row
   * (`left`) carries the section the day roster remembered.
   */
  section?: UpcomingSection
  /**
   * A row that LEFT the segment today, handled (`segment-roster.ts`): sent
   * as a considered row, saying how it left. Only with `handledRows`.
   */
  left?: SegmentLeft
}

export { SEGMENT_ORDER, type SegmentKind }

export interface TaskSegment {
  horizon: SegmentKind
  tasks: SegmentTask[]
  waiting: number
  considered: number
  deferred: number
  /**
   * Over SEGMENT_NUDGE_THRESHOLD tasks still WAITING: suggest Process or AI
   * help. Considered and deferred rows don't count — they aren't "here" any
   * more (Trent, 2026-10-11: a "2 to consider" card said "Over 50 tasks here").
   */
  nudge: boolean
}

/**
 * RULE SEG-ELIGIBLE: The owner's own open, non-deleted, unarchived one-offs that are not reminders
 *   or quotas.
 * Why: A recurring task's schedule already brings it round, and reminders and quotas have their own
 *   rows (the module comment).
 * Ruling: none recorded.
 */
/** The user's segment-eligible tasks: own, open, one-off, not a reminder or quota. */
export function eligibleTasks(userId: number): Task[] {
  const rows = getDb()
    .prepare(
      `SELECT ${taskColumns()} FROM tasks
       WHERE user_id = ? AND done = 0 AND deleted_at IS NULL AND archived_at IS NULL
         AND rrule IS NULL AND is_reminder = 0 AND is_tracked = 0 AND progress_target <= 1`,
    )
    .all(userId) as TaskRow[]
  return rows.map(rowToTask)
}

/**
 * The user's REPEATING tasks for Upcoming (2026-10-12, ruling Q2): own, open,
 * recurring, with a next occurrence — never a reminder (`is_reminder`) or a
 * quota (`isTracked`), which have their own rows on the same screen. A
 * decked one (2026-10-20) has no target while decked, so it is read by its
 * deck instead; a deadline-anchored one with no target (2026-10-22, L2) by
 * its deadline (the deadlines page).
 */
function repeatingTasks(userId: number): Task[] {
  const rows = getDb()
    .prepare(
      `SELECT ${taskColumns()} FROM tasks
       WHERE user_id = ? AND done = 0 AND deleted_at IS NULL AND archived_at IS NULL
         AND rrule IS NOT NULL
         AND (due_at IS NOT NULL OR on_deck_day IS NOT NULL OR deadline_at IS NOT NULL)
         AND is_reminder = 0 AND is_tracked = 0 AND progress_target <= 1`,
    )
    .all(userId) as TaskRow[]
  return rows.map(rowToTask)
}

/** The user's check-in day (`users.check_in_day`, §3) — Saturday unless set. */
export function getCheckInDay(userId: number): CheckInDay {
  const row = getDb().prepare('SELECT check_in_day FROM users WHERE id = ?').get(userId) as
    | { check_in_day: number }
    | undefined
  return coerceCheckInDay(row?.check_in_day)
}

function segmentOf(horizon: SegmentKind, tasks: SegmentTask[]): TaskSegment {
  const count = (s: SegmentState) => tasks.filter((t) => t.state === s).length
  return {
    horizon,
    tasks,
    waiting: count('waiting'),
    considered: count('considered'),
    deferred: count('deferred'),
    nudge: count('waiting') > SEGMENT_NUDGE_THRESHOLD,
  }
}

/**
 * Today's task segments, in the order the screen walks them (`SEGMENT_ORDER`:
 * the deadlines page, the queue's two panels, days, upcoming, weeks, months,
 * eventually). A segment appears only on a day it has items — unless the
 * caller asks for every one (`fill`, the web since 2026-10-24). Within a horizon segment: priority, then id —
 * horizon decides WHETHER a task shows, never where, so acting on one never
 * reorders the rest under the finger (the 09-05 rule). Within Upcoming: the
 * section (Tomorrow first, `UPCOMING_SECTIONS`), then the anchor, then id —
 * the order the dates come in. Within a queue
 * panel: priority, the older remembered target, then id (`compareQueueRows`).
 *
 * A one-off with a target the user picked is in no horizon segment (spec §1,
 * §8.5): it shows only in Upcoming, on its heads-up days. A deadline task
 * whose target is the automatic one stays in its horizon segment.
 *
 * A QUEUED task (switch on) is placed by `queueKind` before anything else and
 * is then in no other segment (rule 7, precedence over horizon AND Upcoming).
 *
 * `queuePanels` — the caller can show the queue's two panels (the web;
 * `GET /api/reminders?queue=1`). Without it, a queued task (switch on) is in
 * NO segment at all: an older native build would list unknown kinds as
 * pages, so it gets the list with the parked tasks simply left out —
 * untargeted, out of the way, which is what the queue is for. Switch off:
 * nothing is queued as far as the segments go, either way.
 */
export function getTaskSegments(
  userId: number,
  timezone: string,
  now = new Date(),
  {
    queuePanels = false,
    deckRows = false,
    handledRows = false,
    deadlineRows = false,
    fill = false,
    agedOut,
  }: {
    queuePanels?: boolean
    /**
     * AGED OUT (2026-10-29, first pass, `src/lib/aged-out.ts`): the caller
     * draws the `aged_out` segment (`GET /api/reminders?aged=1`, the web on a
     * build with `NEXT_PUBLIC_AGED_OUT=1`). Its tasks are then in no horizon
     * segment that day. Without it nothing changes.
     */
    agedOut?: boolean
    /**
     * EVERY SEGMENT, EVERY DAY (Trent, 2026-10-24: "always show every queue
     * segment, every day, in fixed positions"; `GET /api/reminders?fill=1`,
     * the web only). Every kind this caller can draw comes back, in
     * `SEGMENT_ORDER`, an empty one with no rows: the deadlines page and the
     * queue's two panels only with the switch on and a caller that draws them
     * (`deadlineRows`, `queuePanels`), the horizons and Upcoming always.
     * Display only — which task lands where is the same either way. Without
     * it (a native build, the day simulator, the golden suite) a segment
     * appears only on a day it has rows, as before.
     */
    fill?: boolean
    /**
     * The deadlines page (2026-10-22): the caller draws the `deadlines`
     * segment (`GET /api/reminders?deadlines=1`); a target-less deadline task
     * is then never in Upcoming (rule 3, 2026-10-25). Only with the
     * task-queue switch on.
     */
    deadlineRows?: boolean
    /**
     * On deck (2026-10-20): the caller can draw a future deck's Upcoming row
     * ("On deck Sat Oct 24"; `GET /api/reminders?deck=1`). Without it a
     * decked task is simply absent from Upcoming: a shipped native build
     * would draw a dateless row. A deck is in no horizon segment either way.
     */
    deckRows?: boolean
    /**
     * The day roster (2026-10-22, `segment-roster.ts`; `GET
     * /api/reminders?handled=1`): rows that left a segment today handled —
     * decked, targeted, done — stay in it as considered rows (`left`), so
     * "N of M" keeps M fixed for the day. Without it the segments are as
     * before: a native build, the day simulator and the golden suite.
     */
    handledRows?: boolean
  } = {},
): TaskSegment[] {
  const byKind = new Map<SegmentKind, SegmentTask[]>()
  const checkInDay = getCheckInDay(userId)
  // The user's day boundary ("Day starts at" PR 2): every horizon segment,
  // Upcoming heads-up day and "considered today" is an OpenTask day — the
  // day start with the task queue on, midnight off.
  const dayStart = dayBoundaryForUser(userId)
  const upcoming: (SegmentTask & { target: string; section: UpcomingSection })[] = []
  const add = (kind: SegmentKind, entry: SegmentTask) => {
    const list = byKind.get(kind) ?? []
    list.push(entry)
    byKind.set(kind, list)
  }
  const placeInQueue = queuePlacer(userId, timezone, now)
  const deckMoment = deckMomentFor(userId, timezone)
  /**
   * RULE TQ-OPT-IN: Without ?queue=1, queued tasks are left out of every segment. Without ?deck=1,
   *   a decked task is in no segment. Without ?deadlines=1, target-less deadline tasks fall back to
   *   their horizon segment. The web and native PR E send all of them (REMINDERS_URL).
   * Why: A shipped native build would list an unknown kind as a page of its own, so each new kind
   *   is opt-in (the options below).
   * Ruling: none recorded.
   */
  // Queued, but the caller can't show the queue: left out of every segment.
  const place = (task: Task) => {
    const queued = placeInQueue(task)
    if (queued && !queuePanels) return 'hidden' as const
    return queued
  }
  const addUpcoming = (task: Task) => {
    const heads = upcomingState(task, timezone, now, dayStart)
    if (heads) upcoming.push({ task, ...heads })
  }
  // (restates RULE DL-UPCOMING-RULE3, home: src/lib/task-segments.ts)
  // A target-less deadline task (the page drawn) is on the page or nowhere:
  // never in Upcoming, a future deck's row included (rule 3, 2026-10-25).
  const placeDeadline = deadlinePlacer(userId, timezone, now, deadlineRows, (task, entry) => {
    add('deadlines', { task, state: entry.state, safetyNet: entry.safetyNet, seen: entry.seen })
  })
  /**
   * RULE TQ-PRECEDENCE: For one-offs, getTaskSegments places a task in the first of these that
   *   takes it: the queue (hidden without ?queue=1), the deadlines page, on deck, a picked target
   *   (Upcoming), Aged out (when asked for), then the horizon segment. Repeats go: queue, deadlines
   *   page, on deck, a target-less deadline repeat in a horizon segment (degrade), then Upcoming.
   *   This describes the read order only; whether exclusivity belongs at write time is PARKED
   *   (issue I-02). In short: the read's order today; write-time vs read-time is PARKED (I-02).
   * Why: A task the queue or the deadlines page takes is in no other segment, so it is never in two
   *   places.
   * Ruling: Spec rule 7 (2026-10-19). Deadlines page first: Trent 2026-10-22. Rule 3, 2026-10-25.
   */
  // The queue's panels first (rule 7), then the deadlines page: a task one
  // of them takes is in no other segment. True when it was taken (or hidden).
  const placeFirst = (task: Task): boolean => {
    const queued = place(task)
    if (queued === 'hidden') return true
    if (queued) {
      add(queued.kind, queued.entry)
      return true
    }
    return placeDeadline(task)
  }
  // Aged out before the horizons: never also in its horizon segment that day.
  const placeAged = (task: Task): boolean => {
    const aged = agedOut ? agedOutState(task, timezone, now, dayStart, checkInDay) : null
    if (aged) add('aged_out', { task, state: aged })
    return aged !== null
  }
  for (const task of eligibleTasks(userId)) {
    if (placeFirst(task)) continue
    // ON DECK (B6): quiet like a picked target — in no horizon segment; a
    // future deck in Upcoming on its heads-up days (for a caller that draws
    // deck rows); today's in the On deck section (`onDeckToday`), not here.
    if (task.on_deck_day) {
      if (deckRows) addUpcoming(task)
      continue
    }
    if (upcomingCandidate(task)) {
      addUpcoming(task)
      continue
    }
    if (placeAged(task)) continue
    const placed = segmentState(task, timezone, now, dayStart, checkInDay)
    if (placed) add(placed.horizon, { task, state: placed.state })
  }
  const placeRepeating = (task: Task): void => {
    // A decked repeating task (2026-10-20), as a one-off's deck above: a
    // future deck's Upcoming row only for a caller that draws deck rows.
    if (task.on_deck_day) {
      if (deckRows) addUpcoming(task)
      return
    }
    // A deadline-anchored repeat with NO target (the deadlines page) for a
    // caller that does not draw the page (a shipped native build): its
    // horizon segment, the deadline pulling it in — the same truthful, dated
    // degrade as a target-less one-off. Never nowhere.
    if (task.due_at === null && task.deadline_at !== null) {
      const placed = segmentState(task, timezone, now, dayStart, checkInDay)
      if (placed) add(placed.horizon, { task, state: placed.state })
      return
    }
    addUpcoming(task)
  }
  for (const task of repeatingTasks(userId)) {
    if (!placeFirst(task)) placeRepeating(task)
  }
  if (upcoming.length > 0) {
    // Section first: a Tomorrow row's anchor can be a LATER instant than a
    // Later row's (a deck day's anchor is its local midnight; a target in the
    // small hours before the day start is still the next OpenTask day).
    upcoming.sort(
      (a, b) =>
        sectionRank(a.section) - sectionRank(b.section) ||
        Date.parse(a.target) - Date.parse(b.target) ||
        a.task.id - b.task.id,
    )
    byKind.set(
      'upcoming',
      upcoming.map(({ task, state, section }) => ({ task, state, section })),
    )
  }
  if (handledRows) {
    addLeftRows(userId, timezone, now, byKind, {
      queuePanels,
      deadlines: deadlineRows && taskQueueEnabled(),
    })
  }
  /**
   * RULE SEG-FILL: With fill, the server returns every kind the caller can draw, in SEGMENT_ORDER,
   *   including empty ones. Without it, a segment comes back only on days it has rows. This affects
   *   display only, never placement.
   * Why: Display only: which task lands where is the same either way.
   * Ruling: Trent 2026-10-24 (server side); display reversed 2026-10-30.
   */
  const queueOn = taskQueueEnabled()
  const shown = (kind: SegmentKind): boolean => {
    if (byKind.has(kind)) return true
    if (!fill) return false
    if (kind === 'deadlines') return queueOn && deadlineRows
    if (isQueueKind(kind)) return queueOn && queuePanels
    if (kind === 'aged_out') return agedOut === true
    return true
  }
  return SEGMENT_ORDER.filter(shown).map((kind) => {
    const tasks = byKind.get(kind) ?? []
    if (kind === 'queue_today' || kind === 'queue_previous') {
      tasks.sort((a, b) => compareQueueRows(a.task, b.task, deckMoment))
    } else if (kind === 'deadlines') {
      tasks.sort((a, b) => compareDeadlineRows(a.task, b.task))
    } else if (kind === 'aged_out') {
      tasks.sort((a, b) => compareAgedOut(a.task, b.task))
    } else if (kind !== 'upcoming') {
      /**
       * RULE SEG-ORDER-WITHIN: Rows are ordered by priority (highest first), then id. The horizon
       *   decides whether a task shows, never where it sits.
       * Why: Acting on one row never reorders the rest under the finger.
       * Ruling: The 09-05 rule (src/core/tasks/task-segments.ts:193).
       */
      tasks.sort((a, b) => b.task.priority - a.task.priority || a.task.id - b.task.id)
    }
    return segmentOf(kind, tasks)
  })
}

/**
 * RULE UP-ORDER: Tomorrow rows come first, then rows by anchor instant, then by id. Rows that left
 *   go to the end of their section.
 * Why: The order the dates come in; a Tomorrow row's anchor can be a later instant than a Later
 *   row's, so the section goes first.
 * Ruling: none recorded.
 */
/** Upcoming's section order: Tomorrow, then Later. */
function sectionRank(section: UpcomingSection | undefined): number {
  return section === 'tomorrow' ? 0 : 1
}

/**
 * The day roster's rows (`segment-roster.ts`): remember what each segment
 * lists now (Upcoming's rows with their section), and add back, as
 * considered rows marked `left`, the ones that left it today handled. After
 * Upcoming's sort, so they never move its dated rows — each goes to the end
 * of its own SECTION (Tomorrow's still before Later's); the other segments
 * sort them in with the rest (they are listed apart, behind "Show N
 * considered", either way).
 */
function addLeftRows(
  userId: number,
  timezone: string,
  now: Date,
  byKind: Map<SegmentKind, SegmentTask[]>,
  /**
   * What the caller draws: the queue's panels (`queuePanels`), the deadlines
   * page (`deadlineRows`, switch on) — never a left row of a kind it can't.
   */
  shown: { queuePanels: boolean; deadlines: boolean },
): void {
  // Never add a queue panel of left rows that would not otherwise be drawn.
  const queueShown = shown.queuePanels && taskQueueEnabled()
  const listed = new Map(
    [...byKind].map(([kind, rows]) => [
      kind,
      rows.map((r) => ({ task: r.task, section: r.section ?? null })),
    ]),
  )
  for (const [kind, rows] of rosterLeftRows(userId, timezone, now, listed)) {
    if (isQueueKind(kind) && !queueShown) continue
    if (kind === 'deadlines' && !shown.deadlines) continue
    const list = byKind.get(kind) ?? []
    for (const { task, left, section } of rows) {
      list.push({ task, state: 'considered', left, ...(section ? { section } : {}) })
    }
    // Upcoming: a stable partition keeps every Tomorrow row first.
    if (kind === 'upcoming') list.sort((a, b) => sectionRank(a.section) - sectionRank(b.section))
    byKind.set(kind, list)
  }
}

type DeadlineEntry = Exclude<ReturnType<typeof deadlinePlace>, null>

// (restates RULE DL-PAGE-MEMBERSHIP, home: src/lib/task-segments.ts)
/**
 * The deadlines page's placement for this user and moment (switch on and a
 * caller that draws it), or one that places nothing. Returns whether it took
 * the task (a target-less deadline task — placed, or nowhere today), so the
 * caller's other rules never see it. The rollover time is read once per call.
 * Before its lead day it is placed nowhere (rule 3, 2026-10-25).
 */
function deadlinePlacer(
  userId: number,
  timezone: string,
  now: Date,
  deadlineRows: boolean,
  put: (task: Task, entry: DeadlineEntry) => void,
): (task: Task) => boolean {
  if (!deadlineRows || !taskQueueEnabled()) return () => false
  const rolloverTime = rolloverTimeForUser(userId)
  return (task) => {
    if (!isDeadlinePageTask(task)) return false
    if (task.rrule && task.repeat_anchor !== 'deadline') return false
    const placed = deadlinePlace(task, timezone, now, rolloverTime)
    if (placed) put(task, placed)
    return true
  }
}

/**
 * A deck day's place in the queue order (On deck, B5): the day start that
 * started that OpenTask day (`dayStartMoment`), in the owner's zone. Read
 * once per call.
 */
function deckMomentFor(userId: number, timezone: string): (day: string) => number {
  const rolloverTime = rolloverTimeForUser(userId)
  return (day) => dayStartMoment(day, timezone, rolloverTime).getTime()
}

/**
 * The queue's placement rule for this user and moment, or one that places
 * nothing with the switch off (then a queued task falls through to its horizon
 * segment or Upcoming, exactly as before the queue). The latest rollover
 * moment is read once per call, not per task.
 */
function queuePlacer(
  userId: number,
  timezone: string,
  now: Date,
): (task: Task) => { kind: SegmentKind; entry: SegmentTask } | null {
  if (!taskQueueEnabled()) return () => null
  const rolloverTime = rolloverTimeForUser(userId)
  const m = latestRollover(now, timezone, rolloverTime)
  return (task) => {
    const kind = queueKind(task, now, m)
    if (!kind) return null
    return { kind, entry: { task, state: queueRowState(task, timezone, now, rolloverTime) } }
  }
}

/** Load the caller's own open tasks among `ids`; anything else is refused, not skipped. */
function ownOpenTasks(userId: number, ids: number[]): Task[] {
  if (ids.length === 0) throw new ValidationError('At least one task ID required')
  const placeholders = ids.map(() => '?').join(', ')
  const rows = getDb()
    .prepare(
      `SELECT ${taskColumns()} FROM tasks
       WHERE id IN (${placeholders}) AND user_id = ? AND deleted_at IS NULL AND done = 0`,
    )
    .all(...ids, userId) as TaskRow[]
  if (rows.length !== new Set(ids).size) {
    throw new ValidationError('Every task must be one of your own open tasks')
  }
  return rows.map(rowToTask)
}

type StampColumn = 'last_considered_at' | 'segment_deferred_at'

/**
 * RULE SEG-ACTIONS: Consider stamps last_considered_at and is never a completion. On a queued
 *   one-off it also clears queued_at and try_tomorrow, while a waiting repeat stays queued. Put
 *   back clears both stamps and never re-queues. Every action refuses ids that are not the caller's
 *   own open tasks, and each writes one task_segment undo entry, even when nothing changed.
 * Why: The client offers Undo on every tap; without an entry of its own that Undo would reverse
 *   whatever came before it.
 * Ruling: Spec rule 8; put-back 2026-10-11.
 */
/**
 * Write one stamp on each task, as one undo entry. Logged even when a task is
 * already stamped today: the client offers Undo on every tap, and without an
 * entry of its own that Undo would reverse whatever came before it.
 *
 * `leaveQueue` (consider only): a QUEUED ONE-OFF also leaves the task queue in
 * the same write — `queued_at` and Try Tomorrow's `try_tomorrow` cleared, both
 * in that task's snapshot, so the one Undo puts it back in the queue
 * (`queued_from_due_at`, the remembered target, is kept). The flag goes with
 * it: the rollover only ever clears it on a queued task, so left set on a task
 * outside the queue it would never clear. A waiting REPEATING task stays
 * queued (spec rule 8: it comes back tomorrow, until its next occurrence).
 */
function stampTasks(
  userId: number,
  ids: number[],
  column: StampColumn,
  description: string,
  { leaveQueue = false }: { leaveQueue?: boolean } = {},
): number {
  const tasks = ownOpenTasks(userId, ids)
  const now = new Date().toISOString()
  const fieldsAll = new Set<string>([column])
  withTransaction((db) => {
    const stmt = db.prepare(`UPDATE tasks SET ${column} = ?, updated_at = ? WHERE id = ?`)
    const unqueue = db.prepare(
      `UPDATE tasks SET ${column} = ?, queued_at = NULL, try_tomorrow = 0, updated_at = ? WHERE id = ?`,
    )
    const snapshots = tasks.map((task) => {
      if (leaveQueue && task.queued_at && !task.rrule) {
        unqueue.run(now, now, task.id)
        const fields = [column, 'queued_at', ...(task.try_tomorrow ? ['try_tomorrow'] : [])]
        fields.forEach((f) => fieldsAll.add(f))
        return createTaskSnapshot(
          task,
          { ...task, [column]: now, queued_at: null, try_tomorrow: false },
          fields,
        )
      }
      stmt.run(now, now, task.id)
      return createTaskSnapshot(task, { ...task, [column]: now }, [column])
    })
    logAction(userId, 'task_segment', description, [...fieldsAll], snapshots)
  })
  emitSyncEvent(userId)
  return tasks.length
}

function plural(n: number): string {
  return n === 1 ? '1 task' : `${n} tasks`
}

/**
 * The circle (and a tap on the row): "I saw it." Never a completion. On a
 * queued one-off it is also the way OUT of the queue (`stampTasks`'
 * `leaveQueue`) — always, whatever the switch says: a task the user has seen
 * must not sit in a queue the switch later turns back on.
 */
export function considerTasks(userId: number, ids: number[]): number {
  const n = ids.length
  return stampTasks(userId, ids, 'last_considered_at', `Considered ${plural(n)}`, {
    leaveQueue: true,
  })
}

/** What a Defer of the lead day answers (`POST /api/task-segments/defer-lead`). */
export interface DeferLeadResult {
  /** The day the lead moved to (yyyy-MM-dd, the OpenTask day). */
  day: string
  deferred: number
  refused: { id: number; reason: LeadDeferRefusal; message: string }[]
  summary: string
}

/**
 * DEFER ON THE DEADLINES PAGE (2026-10-22, plan §3; A3: tap + pick): moves
 * each task's lead day (`lead_from`, THIS instance's — the next advance
 * re-derives it) to `day`, the OpenTask day — tomorrow when omitted. Allowed
 * from tomorrow to D−2; refused per task once the safety net holds it (from
 * D−1), for a day after D−2, or for a task that is not a target-less deadline
 * task (`leadDeferRefusal`). The row simply leaves the page until that day.
 *
 * The write also stamps `target_set_at`, as a target write does (a later
 * target's Upcoming days count from it). One undo entry (`task_segment`) for
 * the tasks it moved — none when every one was refused (nothing changed, and
 * the client shows the refusal instead of an Undo). 409 with the task-queue
 * switch off: the page does not exist then.
 */
export function deferLeads(
  userId: number,
  timezone: string,
  ids: number[],
  day?: string,
  now: Date = new Date(),
): DeferLeadResult {
  if (!taskQueueEnabled()) {
    throw new AppError(
      'The deadlines page needs the task queue, which is off on this server',
      409,
      'CONFLICT',
    )
  }
  const rolloverTime = rolloverTimeForUser(userId)
  const target = day ?? shiftDay(openTaskToday(timezone, now, rolloverTime), 1, timezone)
  if (!parseDeckDay(target, timezone)) throw new ValidationError('day must be a date (yyyy-MM-dd)')
  const tasks = ownOpenTasks(userId, ids)
  const refused: DeferLeadResult['refused'] = []
  const moving: Task[] = []
  for (const task of tasks) {
    const reason = leadDeferRefusal(task, target, timezone, now, rolloverTime)
    if (reason) refused.push({ id: task.id, reason, message: LEAD_DEFER_MESSAGES[reason] })
    else moving.push(task)
  }
  const words = DateTime.fromISO(target, { zone: timezone }).toFormat('ccc LLL d')
  const summary =
    moving.length > 0
      ? `Deferred ${plural(moving.length)} to ${words}`
      : (refused[0]?.message ?? 'Nothing to defer')
  if (moving.length > 0) {
    const stamp = now.toISOString()
    const fields = ['lead_from', 'target_set_at']
    withTransaction((db) => {
      const stmt = db.prepare(
        'UPDATE tasks SET lead_from = ?, target_set_at = ?, updated_at = ? WHERE id = ?',
      )
      const snapshots = moving.map((task) => {
        stmt.run(target, stamp, stamp, task.id)
        return createTaskSnapshot(
          task,
          { ...task, lead_from: target, target_set_at: stamp },
          fields,
        )
      })
      logAction(userId, 'task_segment', summary, fields, snapshots)
      for (const snap of snapshots) {
        logActivity({
          userId,
          taskId: snap.task_id,
          action: 'edit',
          fields,
          before: snap.before_state,
          after: snap.after_state,
          metadata: { deadlines_page: 'defer_lead' },
        })
      }
      // The day roster: an actual Defer, so the row reads "· deferred to …".
      markRosterDeferred(
        userId,
        openTaskToday(timezone, now, rolloverTime),
        moving.map((t) => t.id),
      )
    })
    emitSyncEvent(userId)
    for (const task of moving) {
      dispatchWebhookEvent(userId, 'task.updated', {
        task: formatTaskResponse({ ...task, lead_from: target, target_set_at: stamp }, timezone),
      })
    }
  }
  return { day: target, deferred: moving.length, refused, summary }
}

/**
 * RULE SEG-NOT-TODAY: 'Not today' stamps segment_deferred_at: the row is off today's list and back
 *   tomorrow, and it does not count as a consider. 'Not today, all' is offered on every segment
 *   except the queue panels and the deadlines page. Queue select mode offers 'Not today' on picked
 *   rows.
 * Why: Not today is not a consider, which keeps "considered" honest.
 * Ruling: Renamed 'Not today': Trent 2026-10-30 (commit 11d9723a). Select mode: Trent 2026-10-30.
 * Restated at: src/lib/task-segments.ts (offersDeferAll).
 */
/** Defer All: off today's segment, back tomorrow. Not a consider. */
export function deferTasks(userId: number, ids: number[]): number {
  const n = ids.length
  return stampTasks(userId, ids, 'segment_deferred_at', `Not today: ${plural(n)}, back tomorrow`)
}

/**
 * Put back: undo a consider or a Defer All from the "Show considered" list
 * (2026-10-11, the slots' put-back). Clears both stamps, so the row waits in
 * its segment again today and comes back daily until it is considered — the
 * meaning of "not considered". One undo entry, logged even when nothing was
 * stamped (the toast's Undo must never reach an older action).
 */
export function restoreTasks(userId: number, ids: number[]): number {
  const tasks = ownOpenTasks(userId, ids)
  const now = new Date().toISOString()
  const fields = ['last_considered_at', 'segment_deferred_at']
  withTransaction((db) => {
    const stmt = db.prepare(
      'UPDATE tasks SET last_considered_at = NULL, segment_deferred_at = NULL, updated_at = ? WHERE id = ?',
    )
    const snapshots = tasks.map((task) => {
      stmt.run(now, task.id)
      return createTaskSnapshot(
        task,
        { ...task, last_considered_at: null, segment_deferred_at: null },
        fields,
      )
    })
    logAction(userId, 'task_segment', `Put back ${plural(tasks.length)}`, fields, snapshots)
  })
  emitSyncEvent(userId)
  return tasks.length
}

/**
 * When "Target today" sets the target (spec §4): where the Snooze-all button
 * goes (`bulk_snooze_default` — the next period, or the default snooze
 * option), as long as that is still today; otherwise the top of the next hour.
 * The rule itself is `targetTodayTimeFor` (`src/lib/snooze.ts`), which the
 * Today button's time picker also opens on.
 */
export function targetTodayTime(userId: number, timezone: string, now = new Date()): string {
  const prefs = getDb()
    .prepare('SELECT bulk_snooze_default, default_snooze_option FROM users WHERE id = ?')
    .get(userId) as { bulk_snooze_default: string; default_snooze_option: string } | undefined
  const slots = listTimeSlots(userId)
  return targetTodayTimeFor(
    {
      bulkSnoozeDefault: prefs?.bulk_snooze_default ?? 'next_period',
      // No row: no default option to read, so the next period (or next hour).
      defaultSnoozeOption: prefs?.default_snooze_option ?? 'tomorrow',
      morningTime: getAnchorTimes(userId, slots).morning.time,
    },
    slots,
    timezone,
    dayBoundaryForUser(userId),
    now,
  )
}

/**
 * Whether `at` may be a segment target: today or later in the user's day —
 * OpenTask days (`dayStart`, "Day starts at" PR 2). An earlier time TODAY is
 * allowed — it is a commitment for today, over target at once, like Today
 * late in the evening. A past day is refused.
 */
function assertTargetDay(at: string, timezone: string, now: Date, dayStart: string): void {
  const instant = new Date(at)
  if (
    Number.isNaN(instant.getTime()) ||
    openTaskDayOf(instant, timezone, dayStart) < openTaskDayOf(now, timezone, dayStart)
  ) {
    throw new ValidationError('The target must be today or later')
  }
}

/**
 * RULE SEG-TARGET-TODAY: 'Today' targets the next period start if it is still today, otherwise the
 *   top of the next hour, or an explicit 'at' today or later. The move is capped at the deadline.
 *   It also stamps considered and segment_targeted_at in one bulk edit, counting each id as an
 *   explicit pick. On a repeat it moves only the target.
 * Why: Today is a deliberate target; one bulk edit, so one Undo puts back the target and the stamps
 *   together.
 * Ruling: Repeating rows targeted since §6, 2026-10-12, replacing ruling Q1
 *   (src/core/tasks/task-segments.ts:771).
 */
/**
 * Target today: a move of the target (§6 — one gesture; there is no separate
 * re-target any more). Goes through bulk edit for one undo entry, the
 * notification dismissal and the sync — and lists every id as an explicit
 * pick, so the High/Urgent sweep filter never drops one the user tapped.
 *
 * `at` (2026-10-12): the Today button's long-press / right-click picker sends
 * the chosen moment instead of `targetTodayTime`. Same path, same stamps.
 *
 * The deadline caps it like every move (§8.2): a deadline earlier than the
 * chosen time gets the target AT the deadline.
 *
 * REPEATING TASKS ARE TARGETED TOO (since §6, 2026-10-12). Batch 1 skipped
 * them (ruling Q1): Today used to reset a repeating task's occurrence, so done
 * that day brought the next one the very next day (the double fire) and the
 * deadline drifted. The occurrence is now kept apart from the target
 * (`occurrence_at`): Today moves only the target, done advances from the
 * scheduled occurrence (codes-blog: Today on Saturday, done Saturday → next
 * Sunday a week on, deadline measured from Sunday). `skipped_recurring` stays
 * in the response, always empty, for clients that read it.
 *
 * Stamps `segment_targeted_at` (the dashboard's Just now card, see
 * `src/lib/just-added.ts`) in the same bulk edit, so the one Undo puts the
 * target, the considered stamp and the targeted stamp back together.
 */
export function targetTasksToday(
  userId: number,
  timezone: string,
  ids: number[],
  at?: string,
): { until: string; affected: number; skipped_recurring: number[] } {
  ownOpenTasks(userId, ids)
  const now = new Date()
  if (at !== undefined) assertTargetDay(at, timezone, now, dayBoundaryForUser(userId))
  const until = at ?? targetTodayTime(userId, timezone, now)
  const stamp = now.toISOString()
  // Also "considered" (amendment 11): the row finishes on the tap. One bulk
  // edit, so one Undo puts back the target and the stamps together.
  const result = bulkEdit({
    userId,
    userTimezone: timezone,
    taskIds: ids,
    changes: {
      due_at: until,
      last_considered_at: stamp,
      segment_targeted_at: stamp,
    },
    includeTaskIds: ids,
  })
  return { until, affected: result.tasksAffected, skipped_recurring: [] }
}

// ===========================================================================
// AGED OUT (2026-10-29, first pass) — `src/lib/aged-out.ts`
// ===========================================================================

/**
 * GROW (Aged out's row action): each task's horizon one step out
 * (`growStep`: Days → Weeks → Months → Eventually, unset → Months). Through
 * `bulkEdit`, so the horizon's clock restarts (`horizon_set_at`), the keep
 * count goes to 0, and one undo entry takes it all back; the row is also
 * considered today (`last_considered_at`), so it stays in Aged out as a
 * handled row. A task already at Eventually is left alone. With `to` (the
 * Grow button's hold menu, Trent 2026-10-29: "select what horizon I want to
 * change it to") each task goes to that horizon instead — in or out; one
 * already there is left alone.
 */
export function growTasks(
  userId: number,
  timezone: string,
  ids: number[],
  to?: HorizonValue,
): number {
  const tasks = ownOpenTasks(userId, ids)
  const perTask: Record<string, { horizon: HorizonValue }> = {}
  for (const task of tasks) {
    const next = to ?? growStep(task.horizon)
    if (next && next !== task.horizon) perTask[String(task.id)] = { horizon: next }
  }
  const growing = Object.keys(perTask).map(Number)
  if (growing.length === 0) return 0
  const result = bulkEdit({
    userId,
    userTimezone: timezone,
    taskIds: growing,
    changes: { last_considered_at: new Date().toISOString() },
    perTask,
    includeTaskIds: growing,
    undo: { action: 'task_segment', description: (n) => `Grew the horizon of ${plural(n)}` },
  })
  return result.tasksAffected
}

/**
 * KEEP (Aged out's consider): Process's `affirm_horizon` — `growth_kept_at`
 * stamped, so the task comes back only one threshold period later, and
 * `growth_kept_count` + 1 ("kept 2×") — and considered today, so it stays in
 * Aged out as a handled row. One undo entry.
 */
export function keepTasks(userId: number, timezone: string, ids: number[]): number {
  const tasks = ownOpenTasks(userId, ids)
  if (tasks.length === 0) return 0
  const result = bulkEdit({
    userId,
    userTimezone: timezone,
    taskIds: tasks.map((t) => t.id),
    changes: { affirm_horizon: true, last_considered_at: new Date().toISOString() },
    includeTaskIds: tasks.map((t) => t.id),
    undo: { action: 'task_segment', description: (n) => `Kept the horizon of ${plural(n)}` },
  })
  return result.tasksAffected
}
