/**
 * THE TASK ROLLOVER (task queue PR 2, 2026-10-19; docs/TASK-MODEL.md § The
 * rollover; design `task-queue-design.md` rules 1, 2, 5, B3, B5, B7 and the
 * build-plan resolutions).
 *
 * Once per OpenTask day, at the user's ROLLOVER — the start of their first
 * reminder period (Trent's 6:30), or `morning_time` with no periods
 * (`src/lib/opentask-day.ts`) — every below-High task with no deadline that
 * is still sitting on a previous day's target, or that a Snooze-all marked
 * for the queue (`queue_mark`, PR 1), is handed to the task queue:
 *
 *   1. A ONE-OFF has its target STRIPPED: `due_at` → NULL, the old target
 *      kept in `queued_from_due_at`, `queued_at` = now, the mark cleared.
 *      Attempts are checkpointed and kept (B7: no reset on strip); Try
 *      Tomorrow's flag stays while the row is in "Stripped today".
 *   2. A REPEATING task is never stripped (rule 5):
 *      - the rule has an occurrence inside this OpenTask day [M, next M) →
 *        it ROLLS to that occurrence (target and `occurrence_at`), logged as
 *        a skip of the missed one (`skip_count`, attempts afresh, as
 *        `skipOccurrence` does — but no undo entry). It nags normally.
 *        Resolution 2.
 *      - otherwise it WAITS (B3): the target moves to the next occurrence,
 *        `occurrence_at` stays on the missed one (so done from the queue
 *        advances from max(missed, now), as today), `queued_at` = now. It
 *        shows in the queue each morning until that occurrence arrives.
 *      - from_completion rules are stepped from the existing occurrence by
 *        their interval, never from now: a system move never re-anchors.
 *   3. A WAIT THAT IS OVER — a queued repeating task whose target has
 *      arrived by M — leaves the queue (`queued_at` / `queued_from_due_at`
 *      cleared): an ordinary over-target task again. If it is still
 *      unhandled at the NEXT rollover, it rolls or waits per 2.
 *   4. Try Tomorrow's flag is cleared on any task queued before M (it has
 *      moved to "Previously targeted").
 *
 * EXCLUDED (never touched by 1 and 2): done, deleted, archived, reminders,
 * quotas (`is_tracked`, `progress_target > 1`), High and Urgent, and ANY
 * deadline, passed or ahead (resolution 3).
 *
 * EXACTLY ONCE. `users.last_rollover_date` is the OpenTask day (yyyy-MM-dd)
 * whose rollover last ran. A run happens iff it is before the current
 * OpenTask day D; the stamp is written FIRST in the run's transaction, by a
 * conditional UPDATE, so two callers (the two minute jobs, the test route)
 * can never both run it. Dates are compared, not moments, so a timezone
 * change mid-day can't run it twice. NULL (a user created after the deploy
 * stamp, `stampRolloverDates`) is stamped, never read as "never ran".
 *
 * AS OF M. A run after downtime (catch-up) happens once, as of the latest
 * rollover moment M — never one run per missed day — and ignores any task
 * whose target was set after M (a 6:45 sweep caught up at 7:10 stays put).
 * The attempts checkpoint is taken as of just before M, so a task stripped
 * at M gains no attempt for the new day.
 *
 * THE SWITCH. All of this only with `OPENTASK_TASK_QUEUE=1`. Off, the job
 * still advances `last_rollover_date` every day (stamp only), so turning the
 * switch on later never catches up old days.
 *
 * A SYSTEM ACTION, like the quota period rollover (`period-rollover.ts`): NO
 * UNDO ENTRY (there is nothing the user did to undo). Instead it FENCES undo
 * (B5): every task it changes gets `rolled_over_at`, and undo/redo skip that
 * task's snapshot in any entry written before it (`rollover-fence.ts`) — an
 * old sweep's undo never puts back a stripped target; the Today tap is the
 * way back. It writes one activity row per task (`source: 'rollover'`) and
 * `updated_at` (the task changed visibly), then, after commit, per user:
 * dismisses the changed tasks' notifications (which also resyncs the badge;
 * a run that only released waits or cleared flags resyncs the badge on its
 * own) and emits a sync event.
 *
 * It writes targets with fixed SQL and sets the queue state rather than
 * clearing it — the deliberate exception to TQ-G01 (tq-summary.test.ts).
 */

import { getDb, withTransaction } from '@/core/db'
import { logActivity } from '@/core/activity'
import { computeNextOccurrence } from '@/core/recurrence'
import { dismissNotificationsForTasks, syncBadgeCount } from '@/core/notifications/dismiss'
import { emitSyncEvent } from '@/lib/sync-events'
import { log } from '@/lib/logger'
import { latestRollover, nextRollover, openTaskDayOf, rolloverTimeOf } from '@/lib/opentask-day'
import { effectiveAttempts, QUEUE_KEEP_PRIORITY } from '@/lib/task-segments'
import { rowToTask, taskColumns, type TaskRow } from './read'
import { TARGET_SET_FIELD } from './target-set'
import { taskQueueEnabled } from './task-queue'
import type { Task } from '@/types'

/** What one run did, summed over users. */
export interface TaskRolloverResult {
  /** Users whose stamp moved (a run, or a stamp only). */
  stamped: number
  /** Users the full rollover ran for (switch on). */
  ran: number
  /** One-offs stripped into the queue. */
  stripped: number
  /** Repeating tasks rolled to this day's occurrence (logged as skips). */
  rolled: number
  /** Repeating tasks sent to wait for their next occurrence. */
  waiting: number
  /** Waiting repeating tasks whose occurrence arrived (queue cleared). */
  released: number
  /** Try Tomorrow flags cleared (the row moved to Previously targeted). */
  flagsCleared: number
}

export interface TaskRolloverOptions {
  /** The clock (default: now). The test route and the day simulator pass one. */
  now?: Date
  /** One user only (the test route, the simulator). */
  userId?: number
}

interface UserRow {
  id: number
  timezone: string
  morning_time: string | null
  last_rollover_date: string | null
}

/** The user's rollover time (HH:MM): the earliest period's start, else morning_time. */
export function rolloverTimeForUser(userId: number): string {
  const db = getDb()
  const slots = db.prepare('SELECT start_time FROM time_slots WHERE user_id = ?').all(userId) as {
    start_time: string
  }[]
  const user = db.prepare('SELECT morning_time FROM users WHERE id = ?').get(userId) as
    | { morning_time: string | null }
    | undefined
  return rolloverTimeOf(slots, user?.morning_time ?? '09:00')
}

/** Run the rollover for every user (or one) whose OpenTask day has turned. */
export function runTaskRollover(opts: TaskRolloverOptions = {}): TaskRolloverResult {
  const now = opts.now ?? new Date()
  const result: TaskRolloverResult = {
    stamped: 0,
    ran: 0,
    stripped: 0,
    rolled: 0,
    waiting: 0,
    released: 0,
    flagsCleared: 0,
  }
  const sql = 'SELECT id, timezone, morning_time, last_rollover_date FROM users'
  const users = (
    opts.userId === undefined
      ? getDb().prepare(sql).all()
      : getDb().prepare(`${sql} WHERE id = ?`).all(opts.userId)
  ) as UserRow[]
  for (const user of users) {
    try {
      rolloverUser(user, now, result)
    } catch (err) {
      // One user's bad zone or rule must not stop everyone else's rollover.
      log.error('cron', `Task rollover failed for user ${user.id}:`, err)
    }
  }
  return result
}

/** The per-user changes a run collected, for the events after commit. */
interface UserRun {
  /** Tasks whose target changed (strip, roll, wait): their notifications go. */
  moved: number[]
  /** Anything changed at all (moved, released, flags). */
  changed: boolean
}

function rolloverUser(user: UserRow, now: Date, result: TaskRolloverResult): void {
  const rolloverTime = rolloverTimeForUser(user.id)
  const day = openTaskDayOf(now, user.timezone, rolloverTime)
  if (user.last_rollover_date !== null && user.last_rollover_date >= day) return

  const run = withTransaction((tx): UserRun | null => {
    // The stamp first, conditionally: whoever writes it owns this run.
    const stamp = tx
      .prepare(
        `UPDATE users SET last_rollover_date = ?
          WHERE id = ? AND (last_rollover_date IS NULL OR last_rollover_date < ?)`,
      )
      .run(day, user.id, day)
    if (stamp.changes === 0) return null
    result.stamped++
    // NULL: the first sight of this user (made after the deploy stamp) —
    // stamp only, like the deploy stamp. Switch off: stamp only.
    if (user.last_rollover_date === null || !taskQueueEnabled())
      return { moved: [], changed: false }
    result.ran++
    const m = latestRollover(now, user.timezone, rolloverTime)
    const nextM = nextRollover(m, user.timezone, rolloverTime)
    return applyRollover(user, rolloverTime, m, nextM, now, result)
  })
  if (!run || !run.changed) return

  // After commit: the changed targets' banners go (and the badge with them),
  // open tabs and widgets refresh.
  if (run.moved.length > 0) dismissNotificationsForTasks(user.id, run.moved)
  else syncBadgeCount(user.id)
  emitSyncEvent(user.id)
}

/** The tasks the rollover may strip, roll or send to wait (module doc: EXCLUDED). */
const ELIGIBLE_SQL = `
  user_id = ? AND done = 0 AND deleted_at IS NULL AND archived_at IS NULL
  AND is_reminder = 0 AND is_tracked = 0 AND progress_target <= 1
  AND priority < ${QUEUE_KEEP_PRIORITY} AND deadline_at IS NULL
  AND due_at IS NOT NULL`

function applyRollover(
  user: UserRow,
  rolloverTime: string,
  m: Date,
  nextM: Date,
  now: Date,
  result: TaskRolloverResult,
): UserRun {
  const db = getDb()
  const nowStr = now.toISOString()
  const mMs = m.getTime()
  const run: UserRun = { moved: [], changed: false }

  // 3. Waits that are over: a queued repeating task whose target arrived by M.
  // First, so a task released here is not rolled in the same run.
  const released = new Set<number>()
  const waits = db
    .prepare(
      `SELECT id, title, due_at FROM tasks
        WHERE user_id = ? AND rrule IS NOT NULL AND queued_at IS NOT NULL
          AND due_at IS NOT NULL AND done = 0 AND deleted_at IS NULL`,
    )
    .all(user.id) as { id: number; title: string; due_at: string }[]
  for (const w of waits) {
    if (Date.parse(w.due_at) > mMs) continue
    db.prepare(
      `UPDATE tasks SET queued_at = NULL, queued_from_due_at = NULL, rolled_over_at = ?,
              updated_at = ?
        WHERE id = ?`,
    ).run(nowStr, nowStr, w.id)
    logRollover(user.id, w.id, w.title, 'released', ['queued_at', 'queued_from_due_at'], {})
    released.add(w.id)
    result.released++
    run.changed = true
  }

  // 1 and 2: below High, no deadline, still on a previous day's target or
  // marked — and not moved after M (as of M).
  const rows = db
    .prepare(`SELECT ${taskColumns()} FROM tasks WHERE ${ELIGIBLE_SQL}`)
    .all(user.id) as TaskRow[]
  for (const row of rows) {
    if (released.has(row.id)) continue
    const task = rowToTask(row)
    if (task.target_set_at && Date.parse(task.target_set_at) > mMs) continue
    const due = Date.parse(task.due_at!)
    if (!task.queue_mark && !(due < mMs)) continue
    if (!task.rrule) {
      strip(row, task, user, rolloverTime, m, nowStr)
      result.stripped++
    } else {
      // A waiting task (queued, target ahead) is not marked and not before M.
      const outcome = rollRepeating(row, task, user, rolloverTime, m, nextM, nowStr)
      if (outcome === 'rolled') result.rolled++
      else result.waiting++
    }
    run.moved.push(task.id)
    run.changed = true
  }

  // 4. Try Tomorrow's mark lasts only while the row is in "Stripped today".
  const flagged = db
    .prepare(
      `SELECT id, title, queued_at FROM tasks
        WHERE user_id = ? AND try_tomorrow = 1 AND queued_at IS NOT NULL AND deleted_at IS NULL`,
    )
    .all(user.id) as { id: number; title: string; queued_at: string }[]
  for (const f of flagged) {
    if (Date.parse(f.queued_at) >= mMs) continue
    db.prepare('UPDATE tasks SET try_tomorrow = 0, updated_at = ? WHERE id = ?').run(nowStr, f.id)
    logRollover(user.id, f.id, f.title, 'try_tomorrow_cleared', ['try_tomorrow'], {})
    result.flagsCleared++
    run.changed = true
  }

  if (run.changed) {
    log.info(
      'cron',
      `Task rollover for user ${user.id} (${openTaskDayOf(m, user.timezone, rolloverTime)}): ` +
        `${run.moved.length} moved, ${released.size} released`,
    )
  }
  return run
}

/**
 * The attempts checkpoint a rollover write keeps (B7: no reset on strip), as
 * of just before M — from the STORED columns, not `rowToTask`'s read as of
 * the wall clock, which would count the new day for a target at M.
 */
function checkpoint(
  row: TaskRow,
  task: Task,
  user: UserRow,
  rolloverTime: string,
  m: Date,
): { attempts: number; countedThrough: string | null } {
  const asOf = new Date(m.getTime() - 1)
  return effectiveAttempts(
    {
      ...task,
      attempts: row.attempts ?? 0,
      attempts_counted_through: row.attempts_counted_through,
    },
    user.timezone,
    asOf,
    rolloverTime,
  )
}

/** 1. Strip a one-off's target into the queue. */
function strip(
  row: TaskRow,
  task: Task,
  user: UserRow,
  rolloverTime: string,
  m: Date,
  nowStr: string,
): void {
  const counted = checkpoint(row, task, user, rolloverTime, m)
  getDb()
    .prepare(
      `UPDATE tasks
          SET attempts = ?, attempts_counted_through = ?,
              queued_from_due_at = due_at, due_at = NULL, queued_at = ?, queue_mark = 0,
              ${TARGET_SET_FIELD} = ?, rolled_over_at = ?, updated_at = ?
        WHERE id = ?`,
    )
    .run(counted.attempts, counted.countedThrough, nowStr, nowStr, nowStr, nowStr, task.id)
  logRollover(
    user.id,
    task.id,
    task.title,
    'stripped',
    ['due_at', 'queued_at', 'queued_from_due_at', 'queue_mark', TARGET_SET_FIELD],
    { due_at: task.due_at },
    { due_at: null, queued_at: nowStr, queued_from_due_at: task.due_at },
    { marked: task.queue_mark },
  )
}

/**
 * The rule's first occurrence at or after M, from the task's own scheduled
 * occurrence (never its moved target, §6). `skipped`: an occurrence before M
 * was passed over (the missed one). An occurrence still at or after M (a
 * target moved ahead of an occurrence not yet come) is itself the answer.
 */
function occurrenceFrom(
  task: Task,
  timezone: string,
  m: Date,
): { at: string; skipped: boolean } | null {
  const prev = task.occurrence_at ?? task.due_at
  if (!prev) return null
  if (Date.parse(prev) >= m.getTime()) return { at: new Date(prev).toISOString(), skipped: false }
  const base = {
    rrule: task.rrule!,
    anchorTime: task.anchor_time,
    timezone,
  }
  if (task.recurrence_mode === 'from_completion') {
    // From the existing anchor, never from now: step the interval forward
    // from the missed occurrence as if each had been done on time. Bounded
    // (a daily rule years stale still ends): the guard is generous.
    let at = new Date(prev)
    for (let i = 0; i < 5000 && at.getTime() < m.getTime(); i++) {
      at = computeNextOccurrence({ ...base, recurrenceMode: 'from_completion', completedAt: at })
    }
    return { at: at.toISOString(), skipped: true }
  }
  // from_due: `rule.after` is STRICT, so ask from just before M — an
  // occurrence exactly at M (a daily at 6:30) is this day's.
  const at = computeNextOccurrence({
    ...base,
    recurrenceMode: 'from_due',
    completedAt: new Date(m.getTime() - 1000),
    prevDueAt: new Date(prev),
    anchorAt: new Date(prev),
  })
  return { at: at.toISOString(), skipped: true }
}

/** 2. A repeating task: roll to this day's occurrence, or wait for the next. */
function rollRepeating(
  row: TaskRow,
  task: Task,
  user: UserRow,
  rolloverTime: string,
  m: Date,
  nextM: Date,
  nowStr: string,
): 'rolled' | 'waiting' {
  const db = getDb()
  const next = occurrenceFrom(task, user.timezone, m)
  if (next && Date.parse(next.at) < nextM.getTime()) {
    // Rule 5a: roll to this day's occurrence; the missed one is a skip.
    const skipCount = (task.skip_count ?? 0) + (next.skipped ? 1 : 0)
    db.prepare(
      `UPDATE tasks
          SET due_at = ?, occurrence_at = ?, original_due_at = ?, skip_count = ?,
              ${TARGET_SET_FIELD} = ?, attempts = 0, attempts_counted_through = NULL,
              queue_mark = 0, try_tomorrow = 0, queued_at = NULL, queued_from_due_at = NULL,
              rolled_over_at = ?, updated_at = ?
        WHERE id = ?`,
    ).run(next.at, next.at, next.at, skipCount, nowStr, nowStr, nowStr, task.id)
    logRollover(
      user.id,
      task.id,
      task.title,
      'rolled',
      ['due_at', 'occurrence_at', 'skip_count', TARGET_SET_FIELD],
      { due_at: task.due_at, occurrence_at: task.occurrence_at, skip_count: task.skip_count },
      { due_at: next.at, occurrence_at: next.at, skip_count: skipCount },
      { skipped: next.skipped },
      'skip',
    )
    return 'rolled'
  }
  // B3: wait in the queue for the next occurrence; `occurrence_at` stays.
  const counted = checkpoint(row, task, user, rolloverTime, m)
  const target = next?.at ?? null
  db.prepare(
    `UPDATE tasks
        SET attempts = ?, attempts_counted_through = ?,
            queued_from_due_at = due_at, due_at = ?, queued_at = ?, queue_mark = 0,
            ${TARGET_SET_FIELD} = ?, rolled_over_at = ?, updated_at = ?
      WHERE id = ?`,
  ).run(counted.attempts, counted.countedThrough, target, nowStr, nowStr, nowStr, nowStr, task.id)
  logRollover(
    user.id,
    task.id,
    task.title,
    'waiting',
    ['due_at', 'queued_at', 'queued_from_due_at', 'queue_mark', TARGET_SET_FIELD],
    { due_at: task.due_at },
    { due_at: target, queued_at: nowStr, queued_from_due_at: task.due_at },
    {},
  )
  return 'waiting'
}

/** One activity row per changed task, `source: 'rollover'`. */
function logRollover(
  userId: number,
  taskId: number,
  title: string,
  outcome: 'stripped' | 'rolled' | 'waiting' | 'released' | 'try_tomorrow_cleared',
  fields: string[],
  before: Partial<Task>,
  after: Partial<Task> = {},
  metadata: Record<string, unknown> = {},
  action: 'edit' | 'skip' = 'edit',
): void {
  logActivity({
    userId,
    taskId,
    action,
    source: 'rollover',
    fields,
    before: { id: taskId, title, ...before },
    after: { id: taskId, title, ...after },
    metadata: { rollover: outcome, ...metadata },
  })
}
