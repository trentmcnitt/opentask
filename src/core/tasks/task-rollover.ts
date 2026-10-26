/**
 * THE TASK ROLLOVER (task queue PR 2, 2026-10-19; docs/TASK-MODEL.md § The
 * rollover; design `task-queue-design.md` rules 1, 2, 5, B3, B5, B7 and the
 * build-plan resolutions).
 *
 * Once per OpenTask day, at the user's ROLLOVER — their "Day starts at"
 * (unset, 3:00 AM; `src/lib/opentask-day.ts`) — every below-High task with no deadline that
 * is still sitting on a previous day's target, or that a Snooze-all marked
 * for the queue (`queue_mark`, PR 1), is handed to the task queue:
 *
 *   1. A ONE-OFF has its target STRIPPED: `due_at` → NULL, the remembered
 *      target in `queued_from_due_at` (a marked task's pre-sweep target, as
 *      its sweep recorded it; else the target it had), `queued_at` = now,
 *      the mark cleared.
 *      Attempts are checkpointed and kept (B7: no reset on strip); Try
 *      Tomorrow's flag stays while the row is in "Today's pulls".
 *   2. A REPEATING task is never stripped (rule 5):
 *      - the rule has an occurrence inside this OpenTask day [M, next M) →
 *        it ROLLS to that occurrence (target and `occurrence_at`), logged as
 *        a skip of the missed one (`skip_count`, attempts afresh, as
 *        `skipOccurrence` does — but no undo entry). It nags normally.
 *        Resolution 2.
 *      - otherwise it WAITS (B3): the target moves to the next occurrence,
 *        `occurrence_at` stays on the missed one (so done from the queue
 *        advances from max(missed, now), as today), `queued_at` = now, the
 *        remembered target kept (`keptTarget`). It shows in the queue each
 *        morning until that occurrence's day.
 *      - from_completion rules are stepped from the existing occurrence by
 *        their interval, never from now: a system move never re-anchors.
 *   3. A WAIT IS OVER at the rollover of the day its occurrence arrives (its
 *      target falls in [M, next M)): it AUTO-SKIPS to it (spec rule 5b) —
 *      `occurrence_at` = the occurrence, a skip of the missed one logged —
 *      and leaves the queue. It nags that day like any task; if still
 *      unhandled at the NEXT rollover, it rolls or waits per 2.
 *   4. Try Tomorrow's flag is cleared on any task queued before M (it has
 *      moved to "Previous pulls").
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
 * ROLL OVER NOW (`rollover-now.ts`) runs `applyRollover` by hand with M =
 * now — the same rules, a few boundary-only steps skipped (`ApplyCtx`) — and,
 * being a user action, writes one undo entry.
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
import { dispatchWebhookEvent } from '@/core/webhooks/dispatch'
import { formatTaskResponse } from '@/lib/format-task'
import {
  calendarDateOf,
  isEarlyMorningPick,
  latestRollover,
  nextRollover,
  openTaskDayOf,
} from '@/lib/opentask-day'
import {
  effectiveAttempts,
  occurrenceDates,
  QUEUE_KEEP_PRIORITY,
  repeatEndOf,
  repeatStep,
} from '@/lib/task-segments'
import { getTaskById, rowToTask, taskColumns, type TaskRow } from './read'
import { TARGET_SET_FIELD } from './target-set'
import { taskQueueEnabled } from './task-queue'
import { rolloverTimeForUser } from './rollover-time'
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
  /** Try Tomorrow flags cleared (the row moved to Previously queued). */
  flagsCleared: number
  /** On deck (2026-10-20): undone decks whose day ended, sent to the queue (or just cleared). */
  deckStripped: number
}

export interface TaskRolloverOptions {
  /** The clock (default: now). The test route and the day simulator pass one. */
  now?: Date
  /** One user only (the test route, the simulator). */
  userId?: number
}

export interface UserRow {
  id: number
  timezone: string
  last_rollover_date: string | null
}

// The user's rollover time lives with the switch (`task-queue.ts`); re-exported
// for the day simulator.
export { rolloverTimeForUser }

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
    deckStripped: 0,
  }
  const sql = 'SELECT id, timezone, last_rollover_date FROM users'
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
export interface UserRun {
  /** Tasks whose target changed (strip, roll, wait): their notifications go. */
  moved: number[]
  /** Anything changed at all (moved, released, flags). */
  changed: boolean
  /** The webhooks to send after commit, one per strip / roll / wait / release. */
  hooks: RolloverHook[]
}

/** One task the rollover changed, for its webhooks after commit. */
interface RolloverHook {
  id: number
  previousDueAt: string | null
  /** A real skip was logged (a missed occurrence passed over): also `task.skipped`. */
  skipped: boolean
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
      return { moved: [], changed: false, hooks: [] }
    result.ran++
    const m = latestRollover(now, user.timezone, rolloverTime)
    const nextM = nextRollover(m, user.timezone, rolloverTime)
    return applyRollover(user, rolloverTime, m, nextM, now, result, CRON_CTX)
  })
  if (!run) return
  if (!run.changed) {
    // THE DAY TURNED (2026-10-23, "Day starts at"; coordinator ruling): with
    // the switch on, the Reminders screen's roster, its quota prompts' keys
    // and the queue's panels belong to a new day now even when no task moved.
    // One sync event — exactly one per user per day, the stamp's winner only
    // — so open tabs and the Reminders widget (`widgets` on) refetch the new
    // day instead of acting on yesterday's keys and taking a 400. A run that
    // changed something emits it in `afterRolloverCommit`; the first sight of
    // a user (a NULL stamp) is no day turning, and with the switch off the
    // Reminders day is midnight, not this moment.
    if (taskQueueEnabled() && user.last_rollover_date !== null) emitSyncEvent(user.id)
    return
  }
  afterRolloverCommit(user, run)
}

/**
 * After commit: the changed targets' banners go (and the badge with them),
 * open tabs and widgets refresh, webhooks go out. Shared by the cron and the
 * manual run (`runRolloverNow`).
 */
export function afterRolloverCommit(user: UserRow, run: UserRun, manual = false): void {
  if (run.moved.length > 0) dismissNotificationsForTasks(user.id, run.moved)
  else syncBadgeCount(user.id)
  emitSyncEvent(user.id)
  dispatchRolloverWebhooks(user, run.hooks, manual)
}

/**
 * Webhooks, after commit, as every core mutation sends them (AGENTS.md):
 * `task.updated` with `previous_due_at` for each strip, roll, wait and
 * release, and `task.skipped` too where a missed occurrence was passed over
 * (`skipOccurrence`'s event). A Try Tomorrow flag cleared alone sends none.
 * A manual run (`runRolloverNow`) adds `manual: true` to each payload.
 */
function dispatchRolloverWebhooks(user: UserRow, hooks: RolloverHook[], manual: boolean): void {
  const marker = manual ? { manual: true } : {}
  for (const hook of hooks) {
    const fresh = getTaskById(hook.id)
    if (!fresh) continue
    const task = formatTaskResponse(fresh, user.timezone)
    dispatchWebhookEvent(user.id, 'task.updated', {
      task,
      previous_due_at: hook.previousDueAt,
      source: 'rollover',
      ...marker,
    })
    if (hook.skipped)
      dispatchWebhookEvent(user.id, 'task.skipped', { task, source: 'rollover', ...marker })
  }
}

/**
 * THE ROLLOVER'S TARGET-ANCHORED INVARIANT (2026-10-21): every roll, wait and
 * release sets `occurrence_at` from a TARGET (`occurrence_at = due_at`, the
 * next occurrence's target). That is only true of a target-anchored repeat —
 * a deadline-anchored one's occurrence is its deadline (`occurrenceDates`) —
 * so every query that leads to such a write is held to target-anchored rows,
 * in so many words, not only through `deadline_at IS NULL` (I1 makes them the
 * same; this keeps a row that broke I1 out of it).
 */
const TARGET_ANCHORED_SQL = `repeat_anchor = 'target'`

/** The tasks the rollover may strip, roll or send to wait (module doc: EXCLUDED). */
const ELIGIBLE_SQL = `
  user_id = ? AND done = 0 AND deleted_at IS NULL AND archived_at IS NULL
  AND is_reminder = 0 AND is_tracked = 0 AND progress_target <= 1
  AND priority < ${QUEUE_KEEP_PRIORITY} AND deadline_at IS NULL
  AND ${TARGET_ANCHORED_SQL} AND due_at IS NOT NULL`

/** What a run changed, by outcome (the manual run's answer). */
export interface RolloverIds {
  stripped: number[]
  rolled: number[]
  waiting: number[]
  released: number[]
  /** On deck (2026-10-20): decks whose day ended (`stripDecks`). */
  deck_stripped: number[]
}

/**
 * How `applyRollover` is being run. The cron passes `CRON_CTX`; the manual
 * run (`runRolloverNow`) passes `manual: true` and a collector for its undo
 * entry and its answer. The RULES are the same either way — only these
 * differ (each is commented where it applies).
 */
export interface ApplyCtx {
  manual: boolean
  /** Each changed task as it was before the write, and the ids by outcome. */
  collect?: { before: Map<number, Task>; ids: RolloverIds }
  /**
   * The `queued_at` a strip or a wait stamps (default: now). A manual run
   * passes the NEXT real rollover moment — see `runRolloverNow`.
   */
  queuedAt?: string
}

const CRON_CTX: ApplyCtx = { manual: false }

/** The activity metadata a manual run adds to every row it writes. */
function ctxMeta(ctx: ApplyCtx): Record<string, unknown> {
  return ctx.manual ? { manual: true } : {}
}

export function applyRollover(
  user: UserRow,
  rolloverTime: string,
  m: Date,
  nextM: Date,
  now: Date,
  result: TaskRolloverResult,
  ctx: ApplyCtx,
): UserRun {
  const db = getDb()
  const nowStr = now.toISOString()
  const mMs = m.getTime()
  const run: UserRun = { moved: [], changed: false, hooks: [] }

  // 3. Waits that are over: a queued repeating task whose target (its next
  // occurrence) falls in this OpenTask day — or arrived earlier, on a run
  // caught up after downtime. First, so it is not rolled in the same run.
  const released = new Set<number>()
  const waits = db
    .prepare(
      `SELECT id, title, due_at, occurrence_at, skip_count,
              repeat_count, repeat_count_used, repeat_until FROM tasks
        WHERE user_id = ? AND rrule IS NOT NULL AND queued_at IS NOT NULL
          AND ${TARGET_ANCHORED_SQL}
          AND due_at IS NOT NULL AND done = 0 AND deleted_at IS NULL AND archived_at IS NULL`,
    )
    .all(user.id) as WaitRow[]
  for (const w of waits) {
    if (Date.parse(w.due_at) >= nextM.getTime()) continue
    if (ctx.collect) {
      const pre = getTaskById(w.id)
      if (pre) ctx.collect.before.set(w.id, pre)
      ctx.collect.ids.released.push(w.id)
    }
    const skipped = release(w, user, nowStr, ctx)
    run.hooks.push({ id: w.id, previousDueAt: w.due_at, skipped })
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
    const outcome = handleRow(row, task, user, rolloverTime, m, nextM, nowStr, ctx)
    if (!outcome) continue
    if (outcome === 'stripped') result.stripped++
    else if (outcome === 'waiting') result.waiting++
    else result.rolled++
    ctx.collect?.ids[outcome === 'rolled-skip' ? 'rolled' : outcome].push(task.id)
    ctx.collect?.before.set(task.id, task)
    run.moved.push(task.id)
    run.hooks.push({ id: task.id, previousDueAt: task.due_at, skipped: outcome === 'rolled-skip' })
    run.changed = true
  }

  // 5. On deck (2026-10-20): decks whose day has ended go to the queue.
  if (stripDecks(user, rolloverTime, m, nextM, nowStr, ctx, run, result)) run.changed = true

  // 4. Try Tomorrow's mark lasts only while the row is in "Today's pulls".
  // Not on a manual run: its M is now, not a rollover, so every queued row
  // would count as "before M" — but the panels' today/previous split stays on
  // the real latest rollover, so rows stripped this morning are still in
  // "Today's pulls" and keep the mark. The real rollover cleared the rest.
  if (ctx.manual) return run
  const flagged = db
    .prepare(
      `SELECT id, title, queued_at FROM tasks
        WHERE user_id = ? AND try_tomorrow = 1 AND queued_at IS NOT NULL
          AND deleted_at IS NULL AND archived_at IS NULL`,
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
 * 1 and 2 for one eligible row: strip a one-off, roll or wait a repeating
 * task — or null, when the row is not the rollover's (set after M, not yet
 * over target and unmarked, a spared early-morning pick, a rule that never
 * reaches M).
 */
function handleRow(
  row: TaskRow,
  task: Task,
  user: UserRow,
  rolloverTime: string,
  m: Date,
  nextM: Date,
  nowStr: string,
  ctx: ApplyCtx,
): 'stripped' | 'rolled' | 'rolled-skip' | 'waiting' | null {
  const mMs = m.getTime()
  if (task.target_set_at && Date.parse(task.target_set_at) > mMs) return null
  if (!task.queue_mark && !(Date.parse(task.due_at!) < mMs)) return null
  if (task.rrule) {
    // A waiting task (queued, target ahead) is not marked and not before M.
    const outcome = rollRepeating(row, task, user, rolloverTime, m, nextM, nowStr, ctx)
    return outcome === 'untouched' ? null : outcome
  }
  // The early-morning pick's spare is a rule about the rollover BOUNDARY (a
  // pick made last night for before 6:30 belongs to the coming day). A
  // manual run is not at a boundary: "end my day now" strips every target
  // already passed, the pick included.
  if (!ctx.manual && !task.queue_mark && earlyMorningPick(task, user.timezone, rolloverTime, m))
    return null
  strip(row, task, user, rolloverTime, m, nowStr, ctx)
  return 'stripped'
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

/**
 * The target the queue remembers (spec rule 2, "the original target is
 * remembered"): a task a defer MARKED keeps the pre-sweep target its sweep
 * recorded (`bulkSnooze`) — not the rollover moment the sweep moved it to;
 * a task on a previous day's target unmarked keeps its current target. A
 * marked row with nothing recorded (marked before the sweep recorded it)
 * falls back to its current target.
 */
function keptTarget(task: Task): string | null {
  return task.queue_mark && task.queued_from_due_at ? task.queued_from_due_at : task.due_at
}

/**
 * AN EARLY-MORNING PICK IS SPARED AT ITS FIRST ROLLOVER (designer ruling,
 * 2026-10-19). An unmarked one-off whose target falls between local midnight
 * and M on M's calendar day, and was SET on an earlier calendar day than its
 * target's — at 22:00, "tomorrow 6:00" — is a pick for the coming day, not
 * yesterday's leftover: the 6:30 rollover keeps it (it stays over target and
 * nags), and if it is still there at the NEXT rollover the ordinary rule
 * strips it. A pick made after midnight for before the rollover (the night
 * owl's 1 AM pick of 2 AM) stays with the evening's day and is stripped, and
 * a marked task (a defer) is always stripped. The rule is shared with the
 * attempts read (`isEarlyMorningPick`): the pick's attempts count its day.
 */
function earlyMorningPick(task: Task, timezone: string, rolloverTime: string, m: Date): boolean {
  // Its calendar day is the day M starts (with a start after 12:00 there is
  // no early-morning pick at all — `isEarlyMorningPick`).
  return (
    calendarDateOf(new Date(task.due_at!), timezone) === openTaskDayOf(m, timezone, rolloverTime) &&
    isEarlyMorningPick(task.due_at!, task.target_set_at ?? task.created_at, timezone, rolloverTime)
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
  ctx: ApplyCtx,
): void {
  const counted = checkpoint(row, task, user, rolloverTime, m)
  const kept = keptTarget(task)
  getDb()
    .prepare(
      `UPDATE tasks
          SET attempts = ?, attempts_counted_through = ?,
              queued_from_due_at = ?, due_at = NULL, queued_at = ?, queue_mark = 0,
              ${TARGET_SET_FIELD} = ?, rolled_over_at = ?, updated_at = ?
        WHERE id = ?`,
    )
    .run(
      counted.attempts,
      counted.countedThrough,
      kept,
      ctx.queuedAt ?? nowStr,
      nowStr,
      nowStr,
      nowStr,
      task.id,
    )
  logRollover(
    user.id,
    task.id,
    task.title,
    'stripped',
    ['due_at', 'queued_at', 'queued_from_due_at', 'queue_mark', TARGET_SET_FIELD],
    { due_at: task.due_at },
    { due_at: null, queued_at: ctx.queuedAt ?? nowStr, queued_from_due_at: kept },
    { marked: task.queue_mark, ...ctxMeta(ctx) },
  )
}

/**
 * The rule's first occurrence at or after M, from the task's own scheduled
 * occurrence (never its moved target, §6). `skipped`: an occurrence before M
 * was passed over (the missed one). An occurrence still at or after M (a
 * target moved ahead of an occurrence not yet come) is itself the answer.
 *
 * REPEAT ENDS (2026-10-22, ruling A4): a roll closes one occurrence, judged
 * by `repeatStep`. When that would END the series — the missed occurrence
 * was the last — this returns null and the task is left untouched: the last
 * occurrence stays over target as debt and nags at its priority. The
 * rollover never ends a series (no undo entry would say so).
 */
function occurrenceFrom(
  task: Task,
  timezone: string,
  m: Date,
  /** The user's rollover time: a from_completion step counts OpenTask days. */
  dayStart: string,
): { at: string; skipped: boolean } | null {
  const next = landingFrom(task, timezone, m, dayStart)
  if (!next || !next.skipped) return next
  return repeatStep(repeatEndOf(task), next.at, 1, timezone).ended ? null : next
}

/** `occurrenceFrom`'s landing, end-blind. */
function landingFrom(
  task: Task,
  timezone: string,
  m: Date,
  dayStart: string,
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
      at = computeNextOccurrence({
        ...base,
        recurrenceMode: 'from_completion',
        completedAt: at,
        dayStart,
      })
    }
    if (at.getTime() < m.getTime()) {
      // The guard ran out before reaching M: leave the task alone, loudly,
      // rather than hand back a past target as this day's.
      log.warn(
        'cron',
        `Task rollover: task ${task.id}'s rule never reached the rollover; left as is`,
      )
      return null
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

interface WaitRow {
  id: number
  title: string
  due_at: string
  occurrence_at: string | null
  skip_count: number | null
  repeat_count: number | null
  repeat_count_used: number | null
  repeat_until: string | null
}

/**
 * 3. A WAIT IS OVER (spec rule 5b: "waits ... until the next occurrence
 * arrives, then auto-skips to it and nags normally"). On the day its
 * occurrence arrives — its target, the next occurrence the wait set, falls
 * inside [M, next M) — the task AUTO-SKIPS to it: `occurrence_at` = that
 * occurrence, logged as a skip of the missed one (`skip_count`, attempts
 * afresh — the 5a roll's write, no undo entry), and it leaves the queue. It
 * nags normally that day, and done lands on the occurrence after it. The
 * target is already that occurrence (a from_completion rule's was stepped
 * from the missed one, so nothing re-anchors here either).
 */
function release(w: WaitRow, user: UserRow, nowStr: string, ctx: ApplyCtx): boolean {
  const userId = user.id
  // Only a stored occurrence BEFORE the one it is released onto was passed
  // over. One still at or after it (a target the user pulled earlier and
  // missed, the occurrence itself not yet come) was never skipped: the wait
  // just ends — no skip_count, attempts kept, no 'skip'.
  const skipped = w.occurrence_at !== null && Date.parse(w.occurrence_at) < Date.parse(w.due_at)
  const db = getDb()
  // REPEAT ENDS (2026-10-22): an end set during the wait can leave the
  // occurrence it waits for outside the series. Then the wait's skip would
  // END it, which the rollover never does (A4): the DEBT RETURNS instead —
  // the target goes back to the missed occurrence (a target-anchored wait:
  // the occurrence is its target), the queue state is cleared, no skip. The
  // target is SET now (`target_set_at`): attempts count from today, so the
  // days it waited in the queue — never shown over target — are not attempts
  // (the wait's checkpoint keeps the ones before it).
  if (skipped && repeatStep(repeatEndOf(w), w.due_at, 1, user.timezone).ended) {
    db.prepare(
      `UPDATE tasks
          SET due_at = occurrence_at, original_due_at = occurrence_at, ${TARGET_SET_FIELD} = ?,
              queued_at = NULL, queued_from_due_at = NULL, try_tomorrow = 0,
              rolled_over_at = ?, updated_at = ?
        WHERE id = ?`,
    ).run(nowStr, nowStr, nowStr, w.id)
    logRollover(
      userId,
      w.id,
      w.title,
      'released',
      ['due_at', 'original_due_at', TARGET_SET_FIELD, 'queued_at', 'queued_from_due_at'],
      { due_at: w.due_at },
      { due_at: w.occurrence_at, queued_at: null },
      { skipped: false, series_end_debt: true, ...ctxMeta(ctx) },
    )
    return false
  }
  if (skipped) {
    const skipCount = (w.skip_count ?? 0) + 1
    // Repeat ends: the missed occurrence is closed (one, like `skip_count`).
    const used = (w.repeat_count_used ?? 0) + 1
    db.prepare(
      `UPDATE tasks
          SET occurrence_at = due_at, original_due_at = due_at, skip_count = ?,
              repeat_count_used = ?, attempts = 0, attempts_counted_through = NULL,
              queued_at = NULL, queued_from_due_at = NULL, try_tomorrow = 0,
              rolled_over_at = ?, updated_at = ?
        WHERE id = ?`,
    ).run(skipCount, used, nowStr, nowStr, w.id)
    logRollover(
      userId,
      w.id,
      w.title,
      'released',
      ['occurrence_at', 'skip_count', 'repeat_count_used', 'queued_at', 'queued_from_due_at'],
      {
        occurrence_at: w.occurrence_at,
        skip_count: w.skip_count ?? 0,
        repeat_count_used: w.repeat_count_used ?? 0,
      },
      { occurrence_at: w.due_at, skip_count: skipCount, repeat_count_used: used, queued_at: null },
      { skipped: true, ...ctxMeta(ctx) },
      'skip',
    )
    return true
  }
  db.prepare(
    `UPDATE tasks
        SET queued_at = NULL, queued_from_due_at = NULL, try_tomorrow = 0,
            rolled_over_at = ?, updated_at = ?
      WHERE id = ?`,
  ).run(nowStr, nowStr, w.id)
  logRollover(
    userId,
    w.id,
    w.title,
    'released',
    ['queued_at', 'queued_from_due_at'],
    {},
    { queued_at: null },
    { skipped: false, ...ctxMeta(ctx) },
  )
  return false
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
  ctx: ApplyCtx,
  /**
   * The deck day, when an ended repeating deck is being handed on
   * (`endRepeatingDeck`): a wait then remembers that day
   * (`queued_from_deck_day`) and no target (`queued_from_due_at` NULL), like
   * a one-off deck's strip — in the same write and activity row.
   */
  deckDay: string | null = null,
): 'rolled' | 'rolled-skip' | 'waiting' | 'untouched' {
  const db = getDb()
  const next = occurrenceFrom(task, user.timezone, m, rolloverTime)
  if (!next) return 'untouched'
  if (Date.parse(next.at) < nextM.getTime()) {
    // Rule 5a: roll to this day's occurrence. The missed one is a skip — a
    // new occurrence, attempts afresh — only when one was passed over; an
    // occurrence not yet come (a target pulled ahead of it and missed) keeps
    // its attempts, checkpointed as of M.
    const skipCount = (task.skip_count ?? 0) + (next.skipped ? 1 : 0)
    // Repeat ends: the missed occurrence is closed — one, like `skip_count`.
    const used = (task.repeat_count_used ?? 0) + (next.skipped ? 1 : 0)
    const counted = next.skipped
      ? { attempts: 0, countedThrough: null }
      : checkpoint(row, task, user, rolloverTime, m)
    db.prepare(
      `UPDATE tasks
          SET due_at = ?, occurrence_at = ?, original_due_at = ?, skip_count = ?,
              repeat_count_used = ?,
              ${TARGET_SET_FIELD} = ?, attempts = ?, attempts_counted_through = ?,
              queue_mark = 0, try_tomorrow = 0, queued_at = NULL, queued_from_due_at = NULL,
              rolled_over_at = ?, updated_at = ?
        WHERE id = ?`,
    ).run(
      next.at,
      next.at,
      next.at,
      skipCount,
      used,
      nowStr,
      counted.attempts,
      counted.countedThrough,
      nowStr,
      nowStr,
      task.id,
    )
    logRollover(
      user.id,
      task.id,
      task.title,
      'rolled',
      ['due_at', 'occurrence_at', 'skip_count', 'repeat_count_used', TARGET_SET_FIELD],
      {
        due_at: task.due_at,
        occurrence_at: task.occurrence_at,
        skip_count: task.skip_count,
        repeat_count_used: task.repeat_count_used,
      },
      { due_at: next.at, occurrence_at: next.at, skip_count: skipCount, repeat_count_used: used },
      { skipped: next.skipped, ...ctxMeta(ctx) },
      next.skipped ? 'skip' : 'edit',
    )
    return next.skipped ? 'rolled-skip' : 'rolled'
  }
  // B3: wait in the queue for the next occurrence; `occurrence_at` stays.
  const counted = checkpoint(row, task, user, rolloverTime, m)
  const target = next.at
  const kept = deckDay ? null : keptTarget(task)
  db.prepare(
    `UPDATE tasks
        SET attempts = ?, attempts_counted_through = ?,
            queued_from_due_at = ?, due_at = ?, queued_at = ?, queue_mark = 0,
            queued_from_deck_day = COALESCE(?, queued_from_deck_day),
            ${TARGET_SET_FIELD} = ?, rolled_over_at = ?, updated_at = ?
      WHERE id = ?`,
  ).run(
    counted.attempts,
    counted.countedThrough,
    kept,
    target,
    ctx.queuedAt ?? nowStr,
    deckDay,
    nowStr,
    nowStr,
    nowStr,
    task.id,
  )
  logRollover(
    user.id,
    task.id,
    task.title,
    'waiting',
    [
      'due_at',
      'queued_at',
      'queued_from_due_at',
      'queue_mark',
      TARGET_SET_FIELD,
      ...(deckDay ? ['queued_from_deck_day'] : []),
    ],
    { due_at: task.due_at },
    {
      due_at: target,
      queued_at: ctx.queuedAt ?? nowStr,
      queued_from_due_at: kept,
      ...(deckDay ? { queued_from_deck_day: deckDay } : {}),
    },
    ctxMeta(ctx),
  )
  return 'waiting'
}

/**
 * 5. ON DECK (2026-10-20; docs/TASK-MODEL.md § On deck; red-team B5, A3). An
 * undone deck whose day has ENDED goes to the queue at EVERY priority — a deck
 * never nagged, so High and Urgent decks are queued too (A8) — remembering its
 * day: `queued_from_deck_day` = the day, `on_deck_day` → NULL, `queued_at` as
 * a strip's (the next real rollover on a manual run), `rolled_over_at` (the
 * undo fence). `queued_from_due_at` is cleared: the row's remembered plan is
 * the deck day, so the queue sorts it by that day (`compareQueueRows`) and the
 * stripped-target restore never resurrects an older target for it. `due_at`
 * and `target_set_at` are untouched. A DEADLINE task's deck (the deadlines
 * page, 2026-10-22) is never queued: it is just cleared, and the task goes
 * back to the deadlines page (its lead day has come by then, or the safety
 * net holds it).
 *
 * Which days: the cron strips days BEFORE the rollover's OpenTask day (a deck
 * for today made at 1 AM, a calendar date, A2, survives the 6:30 rollover);
 * Roll over now strips days up to AND including the current OpenTask day and
 * leaves the coming day's (A3).
 *
 * Its own pass: the strip pass above needs a target and no deadline
 * (`ELIGIBLE_SQL`), and a deck has no picked target, so no row meets both.
 * A REPEATING deck (2026-10-20) is never queued as a deck: it gets its target
 * back and the repeating rules decide (`endRepeatingDeck`).
 */
function stripDecks(
  user: UserRow,
  rolloverTime: string,
  m: Date,
  nextM: Date,
  nowStr: string,
  ctx: ApplyCtx,
  run: UserRun,
  result: TaskRolloverResult,
): boolean {
  const db = getDb()
  const day = openTaskDayOf(m, user.timezone, rolloverTime)
  const rows = db
    .prepare(
      `SELECT ${taskColumns()} FROM tasks
        WHERE user_id = ? AND on_deck_day IS NOT NULL AND on_deck_day ${ctx.manual ? '<=' : '<'} ?
          AND done = 0 AND deleted_at IS NULL AND archived_at IS NULL`,
    )
    .all(user.id, day) as TaskRow[]
  const queuedAt = ctx.queuedAt ?? nowStr
  for (const row of rows) {
    const task = rowToTask(row)
    if (task.rrule) {
      endRepeatingDeck(row, task, user, rolloverTime, { m, nextM }, nowStr, ctx, run, result)
      continue
    }
    // A DEADLINE task's expired deck is only cleared, never queued (the
    // deadlines page, 2026-10-22, plan §5): it goes back to the page, whose
    // safety net holds it from the day before its deadline. (Before the page,
    // a deck whose automatic target had arrived was cleared the same way.)
    const nagging = task.deadline_at !== null
    if (nagging) {
      db.prepare(
        'UPDATE tasks SET on_deck_day = NULL, rolled_over_at = ?, updated_at = ? WHERE id = ?',
      ).run(nowStr, nowStr, task.id)
    } else {
      db.prepare(
        `UPDATE tasks
            SET on_deck_day = NULL, queued_from_deck_day = ?, queued_from_due_at = NULL,
                queued_at = ?, queue_mark = 0, try_tomorrow = 0,
                rolled_over_at = ?, updated_at = ?
          WHERE id = ?`,
      ).run(task.on_deck_day, queuedAt, nowStr, nowStr, task.id)
    }
    logRollover(
      user.id,
      task.id,
      task.title,
      nagging ? 'deck_cleared' : 'deck_stripped',
      nagging ? ['on_deck_day'] : ['on_deck_day', 'queued_at', 'queued_from_deck_day'],
      { on_deck_day: task.on_deck_day },
      nagging
        ? { on_deck_day: null }
        : { on_deck_day: null, queued_at: queuedAt, queued_from_deck_day: task.on_deck_day },
      ctxMeta(ctx),
    )
    ctx.collect?.before.set(task.id, task)
    ctx.collect?.ids.deck_stripped.push(task.id)
    run.hooks.push({ id: task.id, previousDueAt: task.due_at, skipped: false })
    result.deckStripped++
  }
  return rows.length > 0
}

/**
 * 5, REPEATING (2026-10-20; docs/TASK-MODEL.md § On deck). A repeating deck
 * whose day has ended gives the task its target back — its occurrence's own
 * (`due_at` and `original_due_at` := `occurrenceDates(occurrence_at).targetAt`,
 * the deck cleared — one write), then the repeating rules (2) apply in the same run as if it had
 * never been decked:
 *  - a below-High task with no deadline whose occurrence is before M ROLLS
 *    to this day's occurrence (a skip of the missed one) or WAITS in the
 *    queue for its next (`rollRepeating`; a wait also remembers the deck day,
 *    `queued_from_deck_day`, and — like a one-off deck strip — no remembered
 *    target, so the queue sorts it by that day);
 *  - otherwise only the target comes back: High and Urgent never roll (they
 *    nag), a deadline task is never rolled (`ELIGIBLE_SQL`; `rollRepeating`
 *    doesn't move deadlines — so a DEADLINE-ANCHORED repeat, 2026-10-21, only
 *    ever gets its derived target back, already arrived, before its deadline
 *    day: decks never nag, and the deadline still does), and an occurrence still ahead (a deck made
 *    before it came) is simply its target again.
 * A from_completion rule is stepped from its occurrence, never from now
 * (`occurrenceFrom`): no re-anchor. A future deck that passed later
 * occurrences absorbs them: the roll logs ONE skip, of the decked occurrence.
 */
function endRepeatingDeck(
  row: TaskRow,
  task: Task,
  user: UserRow,
  rolloverTime: string,
  { m, nextM }: { m: Date; nextM: Date },
  nowStr: string,
  ctx: ApplyCtx,
  run: UserRun,
  result: TaskRolloverResult,
): void {
  const db = getDb()
  // The occurrence's own target (`occurrenceDates`; a deadline-anchored
  // repeat's lies before its deadline) — `collectRepeatingUndeck`'s rule.
  const occurrence = task.occurrence_at ?? task.due_at
  const restored = occurrence ? occurrenceDates(task, occurrence, user.timezone).targetAt : null
  // The target is SET now (`target_set_at`), so the attempts checkpoint a
  // wait takes never counts the deck's days: a missed deck is never an
  // attempt (there was no target to be over).
  db.prepare(
    `UPDATE tasks
        SET on_deck_day = NULL, due_at = ?, original_due_at = COALESCE(?, original_due_at),
            ${TARGET_SET_FIELD} = ?, rolled_over_at = ?, updated_at = ?
      WHERE id = ?`,
  ).run(restored, restored, nowStr, nowStr, nowStr, task.id)
  logRollover(
    user.id,
    task.id,
    task.title,
    'deck_cleared',
    ['on_deck_day', 'due_at', 'original_due_at', TARGET_SET_FIELD],
    { on_deck_day: task.on_deck_day, due_at: task.due_at, original_due_at: task.original_due_at },
    { on_deck_day: null, due_at: restored, original_due_at: restored ?? task.original_due_at },
    ctxMeta(ctx),
  )
  ctx.collect?.before.set(task.id, task)
  ctx.collect?.ids.deck_stripped.push(task.id)
  result.deckStripped++
  run.moved.push(task.id)

  const rolls =
    restored !== null &&
    Date.parse(restored) < m.getTime() &&
    task.priority < QUEUE_KEEP_PRIORITY &&
    task.deadline_at === null &&
    task.repeat_anchor === 'target' // `TARGET_ANCHORED_SQL`'s invariant
  if (!rolls) {
    run.hooks.push({ id: task.id, previousDueAt: task.due_at, skipped: false })
    return
  }
  const after = { on_deck_day: null, due_at: restored, original_due_at: restored }
  const restoredRow: TaskRow = { ...row, ...after, [TARGET_SET_FIELD]: nowStr }
  const restoredTask: Task = { ...task, ...after, target_set_at: nowStr }
  const outcome = rollRepeating(
    restoredRow,
    restoredTask,
    user,
    rolloverTime,
    m,
    nextM,
    nowStr,
    ctx,
    task.on_deck_day,
  )
  // Counted as a roll or a wait too, so Roll over now's ids and summary and
  // the cron's log say what happened to it (it is also a deck strip).
  if (outcome === 'waiting') {
    result.waiting++
    ctx.collect?.ids.waiting.push(task.id)
  } else if (outcome !== 'untouched') {
    result.rolled++
    ctx.collect?.ids.rolled.push(task.id)
  }
  run.hooks.push({ id: task.id, previousDueAt: task.due_at, skipped: outcome === 'rolled-skip' })
}

/** One activity row per changed task, `source: 'rollover'`. */
function logRollover(
  userId: number,
  taskId: number,
  title: string,
  outcome:
    | 'stripped'
    | 'rolled'
    | 'waiting'
    | 'released'
    | 'try_tomorrow_cleared'
    | 'deck_stripped'
    | 'deck_cleared',
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
