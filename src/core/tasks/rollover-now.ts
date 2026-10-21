/**
 * ROLL OVER NOW (task queue, 2026-10-20): the rollover run by hand, for the
 * current user — "end my day now" (Settings → Roll over now,
 * `POST /api/rollover/run-now`).
 *
 * THE SAME RULES AS THE CRON (`applyRollover` in task-rollover.ts — not a
 * copy), with M = now and the day window [now, the next real rollover):
 *   - a below-High one-off with no deadline that is marked, or whose target
 *     is before now, is stripped into the queue;
 *   - a repeating one rolls to an occurrence before the next real rollover,
 *     or waits for the one after (rule 5, B3); waits due before the next real
 *     rollover are released, as the cron would;
 *   - targets later than now, High and Urgent, any deadline, reminders,
 *     quotas and archived tasks are untouched;
 *   - ON DECK (2026-10-20, A3): undone decks for days up to and including the
 *     current OpenTask day go to the queue; the coming day's (a deck for
 *     "today" made after midnight) stay.
 * What differs from the cron (`ApplyCtx.manual`): no early-morning-pick
 * spare (a rule about the rollover boundary — this is not one), no Try
 * Tomorrow flag clearing (see `applyRollover` step 4),
 * `users.last_rollover_date` is not touched, so tomorrow's rollover runs as
 * usual — and `queued_at` (below).
 *
 * HANDED TO THE NEXT DAY. "End my day now" gives the rows to the coming
 * OpenTask day, so a strip or a wait stamps `queued_at` = the NEXT real
 * rollover moment, not now (a FUTURE instant). The panels split on
 * `queued_at >= latestRollover` (`queueKind`), so the rows show in
 * "Today's pulls" at once AND are still there after the next rollover,
 * which neither counts them "before M" nor clears their Try Tomorrow flag;
 * they move to "Previous pulls" the rollover after. With `queued_at` =
 * now, a 21:00 run's rows would land in "Previous pulls" at 6:30 and
 * lose the flag. Every other reader only asks whether `queued_at` is set
 * (`restore-stripped.ts`, the day simulator, `stampTargetSet`); the queue
 * sorts by `queued_from_due_at`, never `queued_at`; nothing displays it.
 * `rolled_over_at` stays now (the fence's ordering, below).
 *
 * A USER ACTION, so — unlike the cron — ONE UNDO ENTRY (`task_rollover`)
 * with each changed task's snapshot. The writes stamp `rolled_over_at` = now
 * as the cron does, which fences every OLDER entry's snapshot of those tasks
 * (`rollover-fence.ts`); this entry's own `created_at` is written after the
 * writes from the wall clock (`logAction`), so it is never before now and the
 * fence (strictly later) never blocks undoing it. `rolled_over_at` is not in
 * the snapshot: after an undo the older entries stay fenced, as after a real
 * rollover.
 *
 * `dryRun`: the same run inside a transaction that is then rolled back —
 * the counts are exactly what a real run would do, and nothing is written.
 *
 * Requires the server switch (`OPENTASK_TASK_QUEUE=1`): off, a 409.
 */

import { getDb, withTransaction } from '@/core/db'
import { AppError, NotFoundError } from '@/core/errors'
import { createTaskSnapshot, logAction } from '@/core/undo'
import { log } from '@/lib/logger'
import { latestRollover, nextRollover } from '@/lib/opentask-day'
import { getTaskById } from './read'
import { TARGET_SET_FIELD } from './target-set'
import { taskQueueEnabled } from './task-queue'
import { rolloverTimeForUser } from './rollover-time'
import {
  afterRolloverCommit,
  applyRollover,
  type RolloverIds,
  type TaskRolloverResult,
  type UserRow,
  type UserRun,
} from './task-rollover'
import type { Task, UndoSnapshot } from '@/types'

export interface RolloverNowResult {
  stripped: number
  rolled: number
  waiting: number
  released: number
  /** On deck (2026-10-20): decks up to the current OpenTask day sent to the queue (A3). */
  deck_stripped: number
  ids: RolloverIds
  dry_run: boolean
  /** The undo entry (null on a dry run or when nothing changed). */
  undo_id: number | null
}

/** The columns a rollover write can change, for the undo snapshots. */
const UNDO_FIELDS = [
  'due_at',
  'occurrence_at',
  'original_due_at',
  'skip_count',
  TARGET_SET_FIELD,
  'attempts',
  'attempts_counted_through',
  'queue_mark',
  'try_tomorrow',
  'queued_at',
  'queued_from_due_at',
  'on_deck_day',
  'queued_from_deck_day',
] as const

/** Thrown inside a dry run's transaction to roll it back. */
class DryRunRollback extends Error {}

export function runRolloverNow(opts: {
  userId: number
  now?: Date
  dryRun?: boolean
}): RolloverNowResult {
  if (!taskQueueEnabled()) {
    throw new AppError('The task queue is off on this server', 409, 'CONFLICT')
  }
  const now = opts.now ?? new Date()
  const user = getDb()
    .prepare('SELECT id, timezone, last_rollover_date FROM users WHERE id = ?')
    .get(opts.userId) as UserRow | undefined
  if (!user) throw new NotFoundError('User not found')

  const rolloverTime = rolloverTimeForUser(user.id)
  const nextM = nextRollover(now, user.timezone, rolloverTime)
  const counts: TaskRolloverResult = {
    stamped: 0,
    ran: 0,
    stripped: 0,
    rolled: 0,
    waiting: 0,
    released: 0,
    flagsCleared: 0,
    deckStripped: 0,
  }
  const ids: RolloverIds = {
    stripped: [],
    rolled: [],
    waiting: [],
    released: [],
    deck_stripped: [],
  }
  const before = new Map<number, Task>()
  // queued_at = the next real rollover (module doc: HANDED TO THE NEXT DAY).
  const ctx = { manual: true, collect: { before, ids }, queuedAt: nextM.toISOString() }

  let run: UserRun | null = null
  let undoId: number | null = null
  try {
    withTransaction(() => {
      run = applyRollover(user, rolloverTime, now, nextM, now, counts, ctx)
      if (opts.dryRun) throw new DryRunRollback()
      undoId = logRunNow(user.id, before, counts)
    })
  } catch (err) {
    if (!(err instanceof DryRunRollback)) throw err
  }

  const result: RolloverNowResult = {
    stripped: counts.stripped,
    rolled: counts.rolled,
    waiting: counts.waiting,
    released: counts.released,
    deck_stripped: counts.deckStripped,
    ids,
    dry_run: !!opts.dryRun,
    undo_id: undoId,
  }
  const done = run as UserRun | null
  if (opts.dryRun || !done || !done.changed) return result

  log.info(
    'api',
    `Roll over now for user ${user.id} (latest rollover ` +
      `${latestRollover(now, user.timezone, rolloverTime).toISOString()}): ` +
      `${counts.stripped} stripped, ${counts.rolled} rolled, ${counts.waiting} waiting, ` +
      `${counts.released} released`,
  )
  afterRolloverCommit(user, done, true)
  return result
}

/**
 * The run's one undo entry, inside its transaction: each changed task's
 * before/after over the fields that actually changed for it (undo writes
 * only the keys a snapshot holds, so the union is safe as `fieldsChanged`).
 */
function logRunNow(
  userId: number,
  before: Map<number, Task>,
  counts: TaskRolloverResult,
): number | null {
  if (before.size === 0) return null
  const snapshots: UndoSnapshot[] = []
  const union = new Set<string>()
  for (const [id, pre] of before) {
    const post = getTaskById(id)
    if (!post) continue
    const fields = UNDO_FIELDS.filter((f) => pre[f] !== post[f])
    fields.forEach((f) => union.add(f))
    snapshots.push(createTaskSnapshot(pre, post, fields))
  }
  // `logAction` stamps `created_at` from the wall clock NOW, after the writes
  // above stamped `rolled_over_at` = the run's now — never earlier, so the
  // fence never blocks this entry's own undo (module doc).
  return logAction(userId, 'task_rollover', describe(counts), [...union], snapshots)
}

function describe(c: TaskRolloverResult): string {
  const parts = [`${c.stripped} to the queue`]
  if (c.rolled) parts.push(`${c.rolled} repeating rolled`)
  if (c.waiting) parts.push(`${c.waiting} repeating waiting`)
  if (c.released) parts.push(`${c.released} released`)
  if (c.deckStripped) parts.push(`${c.deckStripped} from deck`)
  return `Rolled over now: ${parts.join(', ')}`
}
