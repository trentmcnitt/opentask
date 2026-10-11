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
 */

import { getDb, withTransaction } from '@/core/db'
import { logAction, createTaskSnapshot } from '@/core/undo'
import { ValidationError } from '@/core/errors'
import { emitSyncEvent } from '@/lib/sync-events'
import { listTimeSlots } from '@/core/time-slots'
import { nextPeriodStart } from '@/lib/time-slot-assign'
import { computeSnoozeTime } from '@/lib/snooze'
import { DateTime } from 'luxon'
import type { Task } from '@/types'
import {
  HORIZON_ORDER,
  SEGMENT_NUDGE_THRESHOLD,
  segmentState,
  type HorizonValue,
  type SegmentState,
} from '@/lib/task-segments'
import { rowToTask, taskColumns, type TaskRow } from './read'
import { bulkEdit } from './bulk'

export interface SegmentTask {
  task: Task
  state: SegmentState
}

export interface TaskSegment {
  horizon: HorizonValue
  tasks: SegmentTask[]
  waiting: number
  considered: number
  deferred: number
  /** Over SEGMENT_NUDGE_THRESHOLD items: suggest Process or AI help. */
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
 * Today's task segments, in the order the screen walks them (days, weeks,
 * months, eventually). A segment appears only on a day it has items. Within
 * one: priority, then id — horizon decides WHETHER a task shows, never where,
 * so acting on one never reorders the rest under the finger (the 09-05 rule).
 */
export function getTaskSegments(userId: number, timezone: string, now = new Date()): TaskSegment[] {
  const byHorizon = new Map<HorizonValue, SegmentTask[]>()
  for (const task of eligibleTasks(userId)) {
    const placed = segmentState(task, timezone, now)
    if (!placed) continue
    const list = byHorizon.get(placed.horizon) ?? []
    list.push({ task, state: placed.state })
    byHorizon.set(placed.horizon, list)
  }
  return HORIZON_ORDER.filter((h) => byHorizon.has(h)).map((horizon) => {
    const tasks = byHorizon
      .get(horizon)!
      .sort((a, b) => b.task.priority - a.task.priority || a.task.id - b.task.id)
    const count = (s: SegmentState) => tasks.filter((t) => t.state === s).length
    return {
      horizon,
      tasks,
      waiting: count('waiting'),
      considered: count('considered'),
      deferred: count('deferred'),
      nudge: tasks.length > SEGMENT_NUDGE_THRESHOLD,
    }
  })
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
 */
function stampTasks(
  userId: number,
  ids: number[],
  column: StampColumn,
  description: string,
): number {
  const tasks = ownOpenTasks(userId, ids)
  const now = new Date().toISOString()
  withTransaction((db) => {
    const stmt = db.prepare(`UPDATE tasks SET ${column} = ?, updated_at = ? WHERE id = ?`)
    const snapshots = tasks.map((task) => {
      stmt.run(now, now, task.id)
      return createTaskSnapshot(task, { ...task, [column]: now }, [column])
    })
    logAction(userId, 'task_segment', description, [column], snapshots)
  })
  emitSyncEvent(userId)
  return tasks.length
}

function plural(n: number): string {
  return n === 1 ? '1 task' : `${n} tasks`
}

/** The circle: "I saw it." Never a completion. */
export function considerTasks(userId: number, ids: number[]): number {
  const n = ids.length
  return stampTasks(userId, ids, 'last_considered_at', `Considered ${plural(n)}`)
}

/** Defer All: off today's segment, back tomorrow. Not a consider. */
export function deferTasks(userId: number, ids: number[]): number {
  const n = ids.length
  return stampTasks(userId, ids, 'segment_deferred_at', `Deferred ${plural(n)} to tomorrow`)
}

/**
 * When "Target today" sets the target (spec §4): where the Snooze-all button
 * goes (`bulk_snooze_default` — the next period, or the default snooze
 * option), as long as that is still today; otherwise the top of the next hour.
 */
export function targetTodayTime(userId: number, timezone: string, now = new Date()): string {
  const prefs = getDb()
    .prepare(
      'SELECT bulk_snooze_default, default_snooze_option, morning_time FROM users WHERE id = ?',
    )
    .get(userId) as
    | { bulk_snooze_default: string; default_snooze_option: string; morning_time: string }
    | undefined
  const local = DateTime.fromJSDate(now).setZone(timezone)
  let candidate: string | null = null
  if (prefs?.bulk_snooze_default === 'default_option') {
    const option = prefs.default_snooze_option
    if (option !== 'tomorrow') {
      candidate = computeSnoozeTime(option, timezone, prefs.morning_time, listTimeSlots(userId))
    }
  } else {
    candidate = nextPeriodStart(listTimeSlots(userId), timezone, now)
  }
  if (candidate && DateTime.fromISO(candidate).setZone(timezone).hasSame(local, 'day')) {
    return candidate
  }
  return local.startOf('hour').plus({ hours: 1 }).toUTC().toISO()!
}

/**
 * Target today: a DELIBERATE target, so the age clock starts at it
 * (`reset_original_due_at`). Goes through bulk edit for one undo entry, the
 * notification dismissal and the sync — and lists every id as an explicit
 * pick, so the High/Urgent sweep filter never drops one the user tapped.
 */
export function targetTasksToday(
  userId: number,
  timezone: string,
  ids: number[],
): { until: string; affected: number } {
  ownOpenTasks(userId, ids)
  const until = targetTodayTime(userId, timezone)
  // Also "considered" (amendment 11): the row finishes on the tap. One bulk
  // edit, so one Undo puts back the target and the stamp together.
  const result = bulkEdit({
    userId,
    userTimezone: timezone,
    taskIds: ids,
    changes: {
      due_at: until,
      reset_original_due_at: true,
      last_considered_at: new Date().toISOString(),
    },
    includeTaskIds: ids,
  })
  return { until, affected: result.tasksAffected }
}
