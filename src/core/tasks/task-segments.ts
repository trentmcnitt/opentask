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
 */

import { getDb, withTransaction } from '@/core/db'
import { logAction, createTaskSnapshot } from '@/core/undo'
import { ValidationError } from '@/core/errors'
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
  type SegmentKind,
  type SegmentState,
} from '@/lib/task-segments'
import { upcomingCandidate, upcomingState } from '@/lib/task-segments'
import { rowToTask, taskColumns, type TaskRow } from './read'
import { bulkEdit } from './bulk'
import { taskQueueEnabled } from './task-queue'
import { rolloverTimeForUser } from './rollover-time'
import { latestRollover, rolloverMoment } from '@/lib/opentask-day'
import { rosterLeftRows, type SegmentLeft } from './segment-roster'

export interface SegmentTask {
  task: Task
  state: SegmentState
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
 * deck instead.
 */
function repeatingTasks(userId: number): Task[] {
  const rows = getDb()
    .prepare(
      `SELECT ${taskColumns()} FROM tasks
       WHERE user_id = ? AND done = 0 AND deleted_at IS NULL AND archived_at IS NULL
         AND rrule IS NOT NULL AND (due_at IS NOT NULL OR on_deck_day IS NOT NULL)
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
 * Today's task segments, in the order the screen walks them (the queue's two
 * panels, days, upcoming, weeks, months, eventually). A segment appears only
 * on a day it has items. Within a horizon segment: priority, then id —
 * horizon decides WHETHER a task shows, never where, so acting on one never
 * reorders the rest under the finger (the 09-05 rule). Within Upcoming: the
 * effective target, then id — the order the dates come in. Within a queue
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
  }: {
    queuePanels?: boolean
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
  const upcoming: (SegmentTask & { target: string })[] = []
  const add = (kind: SegmentKind, entry: SegmentTask) => {
    const list = byKind.get(kind) ?? []
    list.push(entry)
    byKind.set(kind, list)
  }
  const placeInQueue = queuePlacer(userId, timezone, now)
  const deckMoment = deckMomentFor(userId, timezone)
  // Queued, but the caller can't show the queue: left out of every segment.
  const place = (task: Task) => {
    const queued = placeInQueue(task)
    if (queued && !queuePanels) return 'hidden' as const
    return queued
  }
  const addUpcoming = (task: Task) => {
    const heads = upcomingState(task, timezone, now)
    if (heads) upcoming.push({ task, state: heads.state, target: heads.target })
  }
  for (const task of eligibleTasks(userId)) {
    const queued = place(task)
    if (queued === 'hidden') continue
    if (queued) {
      add(queued.kind, queued.entry)
      continue
    }
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
    const placed = segmentState(task, timezone, now, checkInDay)
    if (placed) add(placed.horizon, { task, state: placed.state })
  }
  for (const task of repeatingTasks(userId)) {
    const queued = place(task)
    if (queued === 'hidden') continue
    if (queued) {
      add(queued.kind, queued.entry)
      continue
    }
    // A decked repeating task (2026-10-20), as a one-off's deck above: a
    // future deck's Upcoming row only for a caller that draws deck rows.
    if (task.on_deck_day) {
      if (deckRows) addUpcoming(task)
      continue
    }
    addUpcoming(task)
  }
  if (upcoming.length > 0) {
    upcoming.sort((a, b) => Date.parse(a.target) - Date.parse(b.target) || a.task.id - b.task.id)
    byKind.set(
      'upcoming',
      upcoming.map(({ task, state }) => ({ task, state })),
    )
  }
  if (handledRows) addLeftRows(userId, timezone, now, byKind, queuePanels)
  return SEGMENT_ORDER.filter((k) => byKind.has(k)).map((kind) => {
    const tasks = byKind.get(kind)!
    if (kind === 'queue_today' || kind === 'queue_previous') {
      tasks.sort((a, b) => compareQueueRows(a.task, b.task, deckMoment))
    } else if (kind !== 'upcoming') {
      tasks.sort((a, b) => b.task.priority - a.task.priority || a.task.id - b.task.id)
    }
    return segmentOf(kind, tasks)
  })
}

/**
 * The day roster's rows (`segment-roster.ts`): remember what each segment
 * lists now, and add back, as considered rows marked `left`, the ones that
 * left it today handled. After Upcoming's sort, so they never move its dated
 * rows; the other segments sort them in with the rest (they are listed
 * apart, behind "Show N considered", either way).
 */
function addLeftRows(
  userId: number,
  timezone: string,
  now: Date,
  byKind: Map<SegmentKind, SegmentTask[]>,
  /** The caller draws the queue's panels (`queuePanels`). */
  queuePanels: boolean,
): void {
  // Never add a queue panel of left rows that would not otherwise be drawn.
  const queueShown = queuePanels && taskQueueEnabled()
  const listed = new Map([...byKind].map(([kind, rows]) => [kind, rows.map((r) => r.task)]))
  for (const [kind, rows] of rosterLeftRows(userId, timezone, now, listed)) {
    if (isQueueKind(kind) && !queueShown) continue
    const list = byKind.get(kind) ?? []
    for (const { task, left } of rows) list.push({ task, state: 'considered', left })
    byKind.set(kind, list)
  }
}

/**
 * A deck day's place in the queue order (On deck, B5): the rollover moment
 * that started that day, in the owner's zone. Read once per call.
 */
function deckMomentFor(userId: number, timezone: string): (day: string) => number {
  const rolloverTime = rolloverTimeForUser(userId)
  return (day) => rolloverMoment(day, timezone, rolloverTime).getTime()
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

/** Defer All: off today's segment, back tomorrow. Not a consider. */
export function deferTasks(userId: number, ids: number[]): number {
  const n = ids.length
  return stampTasks(userId, ids, 'segment_deferred_at', `Deferred ${plural(n)} to tomorrow`)
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
    now,
  )
}

/**
 * Whether `at` may be a segment target: today or later in the user's day. An
 * earlier time TODAY is allowed — it is a commitment for today, over target
 * at once, like Today late in the evening. A past day is refused.
 */
function assertTargetDay(at: string, timezone: string, now: Date): void {
  const day = DateTime.fromISO(at, { zone: 'utc' }).setZone(timezone).startOf('day')
  const today = DateTime.fromJSDate(now).setZone(timezone).startOf('day')
  if (!day.isValid || day < today) {
    throw new ValidationError('The target must be today or later')
  }
}

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
  if (at !== undefined) assertTargetDay(at, timezone, now)
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
