/**
 * Track (REDESIGN-V03 §5) — the period boundary.
 *
 * A quota counts within a period named by its rrule's FREQ (and INTERVAL):
 * "2x/week" is FREQ=WEEKLY. Nothing else ends that period — the completion
 * path only runs on a done tap — so without this job a week's eggs would
 * still be counting next Monday. Found 2026-09-05; Trent's go the same day.
 *
 * What happens at the boundary, per quota:
 *   1. The period is RECORDED: a progress_periods row with what was logged
 *      against the target. A period that reached the target is also a
 *      COMPLETION — a completions row, completion_count +1 — because that is
 *      what "did it twice this week" means. A short period is recorded but is
 *      not a completion (L1: it says what was logged, not what it meant).
 *   2. The count RESETS to 0 and the anchor advances by one period.
 *   3. The activity log gets a `period_rollover` entry (the audit trail). The
 *      History page's Completions tab shows a met period through its
 *      completions row; a short period is stored in progress_periods only,
 *      for a Track history view later.
 *
 * The anchor is `tasks.progress_period_start`: the UTC instant the current
 * period began, by the user's local calendar — 00:00 on the first day of the
 * user's week for a week (`users.week_start`: Sunday by default, or Monday;
 * see `@/lib/week-start`), the 1st for a month, midnight for a day, Jan 1 for
 * a year. A quota the job has never seen is anchored to the start of the
 * period it is in, and nothing is recorded for it. INTERVAL is honoured by
 * advancing the anchor `interval` units at a time. A weekly anchor that is
 * not on the user's week-start boundary (anchored under the old Monday-only
 * rule, or the preference changed) closes at the NEXT boundary instead — a
 * short period — and is aligned from then on (`quotaPeriodEnd`).
 *
 * Progress logged AFTER a period's end but before that period was closed
 * stays in the new period: the count carried forward is the sum of the
 * `progress_events` logged at or after the end (clamped to the count). In
 * normal running this is always 0 — every write closes an expired period
 * first (`rolloverQuotaNow`) — but when a boundary moves backwards in time
 * (the Monday→Sunday switch shipping on a Sunday, or a user flipping the
 * preference mid-week) taps made after the new boundary must not be swept
 * into the week that just closed. Caveat: undo restores `progress_current`
 * without deleting the event row, so an undone +1 is still in the sum; the
 * clamp keeps that from ever carrying more than was logged.
 *
 * Runs every few minutes (see instrumentation.ts). If the server was down
 * across a boundary it catches up: the first missed period gets the count,
 * each further missed period is recorded as 0. This is a system action, not
 * a user mutation, so it is NOT written to the undo log (there is nothing a
 * user did to undo); it is written to the activity log.
 */
import { DateTime } from 'luxon'
import { getDb, withTransaction } from '@/core/db'
import { parseRRule } from '@/core/recurrence/rrule-builder'
import { logActivity } from '@/core/activity'
import { emitSyncEvent } from '@/lib/sync-events'
import { log } from '@/lib/logger'
import {
  coerceWeekStart,
  quotaPeriodEnd,
  startOfWeek,
  type PeriodUnit,
  type WeekStart,
} from '@/lib/week-start'

type Unit = PeriodUnit

interface QuotaRow {
  id: number
  user_id: number
  title: string
  rrule: string
  progress_current: number
  progress_target: number
  progress_period_start: string | null
  completion_count: number
  first_completed_at: string | null
  timezone: string
  week_start: string | null
}

export interface RolloverResult {
  /** Quotas anchored for the first time (no period recorded). */
  anchored: number
  /** Periods closed. */
  rolled: number
}

function periodOf(rrule: string): { unit: Unit; interval: number } | null {
  try {
    const c = parseRRule(rrule)
    const unit: Unit | null =
      c.freq === 'DAILY'
        ? 'days'
        : c.freq === 'WEEKLY'
          ? 'weeks'
          : c.freq === 'MONTHLY'
            ? 'months'
            : c.freq === 'YEARLY'
              ? 'years'
              : null
    if (!unit) return null
    return { unit, interval: Math.max(1, c.interval ?? 1) }
  } catch {
    return null
  }
}

/** The start of the calendar unit `now` falls in, by the user's clock. */
function unitStart(now: DateTime, unit: Unit, weekStart: WeekStart): DateTime {
  switch (unit) {
    case 'days':
      return now.startOf('day')
    case 'weeks':
      return startOfWeek(now, weekStart)
    case 'months':
      return now.startOf('month')
    case 'years':
      return now.startOf('year')
  }
}

const QUOTA_ROW_SQL = `SELECT t.id, t.user_id, t.title, t.rrule, t.progress_current, t.progress_target,
              t.progress_period_start, t.completion_count, t.first_completed_at, u.timezone,
              u.week_start
         FROM tasks t
         INNER JOIN users u ON t.user_id = u.id
        WHERE (t.is_tracked = 1 OR t.progress_target > 1)
          AND t.rrule IS NOT NULL
          AND t.done = 0
          AND t.deleted_at IS NULL
          AND t.archived_at IS NULL`

function fetchQuotas(userId?: number): QuotaRow[] {
  if (userId === undefined) return getDb().prepare(QUOTA_ROW_SQL).all() as QuotaRow[]
  return getDb().prepare(`${QUOTA_ROW_SQL} AND t.user_id = ?`).all(userId) as QuotaRow[]
}

/**
 * Close every period that has ended, for every quota (or one user's, when
 * `userId` is given — the preferences route runs it the moment a user changes
 * their first day of the week, so the new boundary shows at once rather than
 * at the next cron tick). Idempotent: a second run in the same period does
 * nothing.
 */
export function rolloverTrackedPeriods(now: Date = new Date(), userId?: number): RolloverResult {
  const result: RolloverResult = { anchored: 0, rolled: 0 }
  const touchedUsers = new Set<number>()

  for (const q of fetchQuotas(userId)) {
    const outcome = rolloverQuota(q, now)
    if (outcome.anchored) result.anchored++
    if (outcome.closed > 0) {
      result.rolled += outcome.closed
      touchedUsers.add(q.user_id)
    }
  }

  for (const userId of touchedUsers) emitSyncEvent(userId)
  return result
}

/**
 * Run the rollover for ONE quota, now — before a write that depends on which
 * period it is in.
 *
 * The cron only runs every five minutes. A +1 logged at 00:02 on a daily quota
 * used to land in YESTERDAY's period (the anchor had not moved yet), and the
 * cron three minutes later recorded it as yesterday's and zeroed the count —
 * the tap was lost from today (found by the quota-reminders red team,
 * 2026-09-24). Closing the expired period first, inside the caller's
 * transaction, puts the +1 where the user meant it. Idempotent and cheap: a
 * quota whose period has not ended does nothing.
 *
 * Returns how many periods it closed; the caller emits the sync event it was
 * going to emit anyway.
 */
export function rolloverQuotaNow(taskId: number, now: Date = new Date()): number {
  const row = getDb().prepare(`${QUOTA_ROW_SQL} AND t.id = ?`).get(taskId) as QuotaRow | undefined
  if (!row) return 0
  return rolloverQuota(row, now).closed
}

/** What one quota's pass did: anchored for the first time, and/or closed N periods. */
interface QuotaRolloverOutcome {
  anchored: boolean
  closed: number
}

/**
 * Anchor or close ONE quota's periods, up to `now` — the body of the cron job,
 * factored out so a progress write can run it for its own task first.
 */
function rolloverQuota(q: QuotaRow, now: Date): QuotaRolloverOutcome {
  const none = { anchored: false, closed: 0 }
  const nowStr = now.toISOString()
  const period = periodOf(q.rrule)
  if (!period) return none
  const local = DateTime.fromJSDate(now).setZone(q.timezone)
  if (!local.isValid) return none
  const weekStart = coerceWeekStart(q.week_start)

  if (!q.progress_period_start) {
    const start = unitStart(local, period.unit, weekStart).toUTC().toISO()
    getDb().prepare('UPDATE tasks SET progress_period_start = ? WHERE id = ?').run(start, q.id)
    return { anchored: true, closed: 0 }
  }

  let start = DateTime.fromISO(q.progress_period_start, { zone: 'utc' }).setZone(q.timezone)
  if (!start.isValid) return none
  let logged = q.progress_current
  let completionCount = q.completion_count
  let firstCompletedAt = q.first_completed_at
  let closed = 0

  const endOf = (from: DateTime) => quotaPeriodEnd(from, period.unit, period.interval, weekStart)

  while (local >= endOf(start)) {
    const end = endOf(start)
    // Taps logged at/after this period's end belong to the next one (module doc).
    const carried = Math.min(logged, loggedSince(q.id, end))
    logged -= carried
    const met = logged >= q.progress_target
    const periodStart = start.toUTC().toISO() as string
    const periodEnd = end.toUTC().toISO() as string
    if (met) {
      completionCount += 1
      firstCompletedAt = firstCompletedAt ?? periodEnd
    }
    const snapshotLogged = logged
    const nextCount = completionCount
    const nextFirst = firstCompletedAt
    withTransaction((tx) => {
      tx.prepare(
        `INSERT INTO progress_periods (task_id, user_id, period_start, period_end, logged, target, met, closed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        q.id,
        q.user_id,
        periodStart,
        periodEnd,
        snapshotLogged,
        q.progress_target,
        met ? 1 : 0,
        nowStr,
      )
      if (met) {
        tx.prepare(
          `INSERT INTO completions (task_id, user_id, completed_at, due_at_was, due_at_next)
             VALUES (?, ?, ?, ?, ?)`,
        ).run(q.id, q.user_id, periodEnd, periodStart, periodEnd)
      }
      tx.prepare(
        `UPDATE tasks
              SET progress_current = ?, progress_period_start = ?,
                  completion_count = ?, first_completed_at = ?,
                  last_completed_at = CASE WHEN ? THEN ? ELSE last_completed_at END,
                  updated_at = ?
            WHERE id = ?`,
      ).run(carried, periodEnd, nextCount, nextFirst, met ? 1 : 0, periodEnd, nowStr, q.id)
      logActivity({
        userId: q.user_id,
        taskId: q.id,
        action: 'period_rollover',
        fields: ['progress_current', 'progress_period_start'],
        before: { id: q.id, title: q.title, progress_current: snapshotLogged },
        after: { id: q.id, title: q.title, progress_current: carried },
        metadata: {
          period_start: periodStart,
          period_end: periodEnd,
          logged: snapshotLogged,
          target: q.progress_target,
          met,
          unit: period.unit,
          carried_forward: carried,
        },
      })
    })
    closed++
    logged = carried
    start = end
  }

  if (closed > 0) log.info('cron', `Track: closed ${closed} period(s) for "${q.title}" (#${q.id})`)
  return { anchored: false, closed }
}

/**
 * Net progress logged for a quota at or after `since` — what a closing period
 * hands forward. `julianday()` on both sides: `logged_at` is written both as
 * `…:SSZ` (column default) and `…:SS.sssZ` (`toISOString`), and a plain string
 * compare between the two formats is wrong at the exact boundary second.
 */
function loggedSince(taskId: number, since: DateTime): number {
  const row = getDb()
    .prepare(
      `SELECT COALESCE(SUM(delta), 0) AS n FROM progress_events
        WHERE task_id = ? AND julianday(logged_at) >= julianday(?)`,
    )
    .get(taskId, since.toUTC().toISO()) as { n: number }
  return Math.max(0, row.n)
}
