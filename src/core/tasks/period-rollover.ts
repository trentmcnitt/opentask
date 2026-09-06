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
 * period began, by the user's local calendar — Monday 00:00 for a week (ISO,
 * as everywhere else in the app), the 1st for a month, midnight for a day,
 * Jan 1 for a year. A quota the job has never seen is anchored to the start
 * of the period it is in, and nothing is recorded for it. INTERVAL is
 * honoured by advancing the anchor `interval` units at a time.
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

type Unit = 'days' | 'weeks' | 'months' | 'years'

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
function unitStart(now: DateTime, unit: Unit): DateTime {
  switch (unit) {
    case 'days':
      return now.startOf('day')
    case 'weeks':
      return now.startOf('week')
    case 'months':
      return now.startOf('month')
    case 'years':
      return now.startOf('year')
  }
}

function fetchQuotas(): QuotaRow[] {
  return getDb()
    .prepare(
      `SELECT t.id, t.user_id, t.title, t.rrule, t.progress_current, t.progress_target,
              t.progress_period_start, t.completion_count, t.first_completed_at, u.timezone
         FROM tasks t
         INNER JOIN users u ON t.user_id = u.id
        WHERE (t.is_tracked = 1 OR t.progress_target > 1)
          AND t.rrule IS NOT NULL
          AND t.done = 0
          AND t.deleted_at IS NULL
          AND t.archived_at IS NULL`,
    )
    .all() as QuotaRow[]
}

/**
 * Close every period that has ended, for every quota. Idempotent: a second
 * run in the same period does nothing.
 */
export function rolloverTrackedPeriods(now: Date = new Date()): RolloverResult {
  const result: RolloverResult = { anchored: 0, rolled: 0 }
  const touchedUsers = new Set<number>()
  const nowStr = now.toISOString()

  for (const q of fetchQuotas()) {
    const period = periodOf(q.rrule)
    if (!period) continue
    const local = DateTime.fromJSDate(now).setZone(q.timezone)
    if (!local.isValid) continue

    if (!q.progress_period_start) {
      const start = unitStart(local, period.unit).toUTC().toISO()
      getDb().prepare('UPDATE tasks SET progress_period_start = ? WHERE id = ?').run(start, q.id)
      result.anchored++
      continue
    }

    let start = DateTime.fromISO(q.progress_period_start, { zone: 'utc' }).setZone(q.timezone)
    if (!start.isValid) continue
    let logged = q.progress_current
    let completionCount = q.completion_count
    let firstCompletedAt = q.first_completed_at
    let closed = 0

    while (local >= start.plus({ [period.unit]: period.interval })) {
      const end = start.plus({ [period.unit]: period.interval })
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
              SET progress_current = 0, progress_period_start = ?,
                  completion_count = ?, first_completed_at = ?,
                  last_completed_at = CASE WHEN ? THEN ? ELSE last_completed_at END,
                  updated_at = ?
            WHERE id = ?`,
        ).run(periodEnd, nextCount, nextFirst, met ? 1 : 0, periodEnd, nowStr, q.id)
        logActivity({
          userId: q.user_id,
          taskId: q.id,
          action: 'period_rollover',
          fields: ['progress_current', 'progress_period_start'],
          before: { id: q.id, title: q.title, progress_current: snapshotLogged },
          after: { id: q.id, title: q.title, progress_current: 0 },
          metadata: {
            period_start: periodStart,
            period_end: periodEnd,
            logged: snapshotLogged,
            target: q.progress_target,
            met,
            unit: period.unit,
          },
        })
      })
      closed++
      logged = 0
      start = end
    }

    if (closed > 0) {
      result.rolled += closed
      touchedUsers.add(q.user_id)
      log.info('cron', `Track: closed ${closed} period(s) for "${q.title}" (#${q.id})`)
    }
  }

  for (const userId of touchedUsers) emitSyncEvent(userId)
  return result
}
