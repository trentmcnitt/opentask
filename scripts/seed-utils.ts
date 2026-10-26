/**
 * Shared utilities for seed scripts (seed-demo, seed-dev, screenshots/seed)
 */

import { DateTime } from 'luxon'
import { getDb } from '../src/core/db'
import { createTask } from '../src/core/tasks/create'
import { validateTaskCreate } from '../src/core/validation'
import { localToUtc } from '../src/core/recurrence/timezone'
import type { TaskCreateInput } from '../src/types'

const DEFAULT_TIMEZONE = 'America/Chicago'

/**
 * Convert a local time offset to a UTC ISO string.
 *
 * @param daysOffset - Days from today (positive = future, negative = past)
 * @param hour - Local hour (0-23)
 * @param minute - Local minute (0-59)
 * @param timezone - IANA timezone (default: America/Chicago)
 */
export function localToUtcIso(
  daysOffset: number,
  hour: number,
  minute: number,
  timezone: string = DEFAULT_TIMEZONE,
): string {
  const local = DateTime.now()
    .setZone(timezone)
    .plus({ days: daysOffset })
    .set({ hour, minute, second: 0, millisecond: 0 })
  return localToUtc(local)
}

/**
 * Returns the number of days from today until the next occurrence of
 * the given ISO weekday(s) (1=Mon..7=Sun). Always returns at least
 * `minDays` (default 1) so tasks are never due today — prevents
 * accidental overdue after the daily 3 AM reset.
 *
 * @param isoWeekdays - Single weekday or array of weekdays (1=Mon..7=Sun)
 * @param minDays - Minimum days to return (default: 1)
 * @param timezone - IANA timezone (default: America/Chicago)
 */
export function daysUntilWeekday(
  isoWeekdays: number | number[],
  minDays: number = 1,
  timezone: string = DEFAULT_TIMEZONE,
): number {
  const weekdays = Array.isArray(isoWeekdays) ? isoWeekdays : [isoWeekdays]
  const today = DateTime.now().setZone(timezone)
  for (let d = minDays; d <= 7 + minDays; d++) {
    if (weekdays.includes(today.plus({ days: d }).weekday)) return d
  }
  return minDays
}

/** One seeded ordinary task: what `createTask` is given, and how old it is. */
export interface SeedTaskRow {
  input: TaskCreateInput
  /** When it was made: `created_at`, and the target-set and horizon-set stamps. */
  createdAt: string
  /** `updated_at`. Default: `createdAt`. */
  updatedAt?: string
  /** A done one-off: `done = 1` and this `done_at`. */
  doneAt?: string | null
  archivedAt?: string | null
  /** In the trash since. */
  deletedAt?: string | null
  /** Completion history (default none, as createTask leaves it). */
  completionCount?: number
  lastCompletedAt?: string | null
}

/**
 * SEED ORDINARY TASKS THROUGH `createTask` (2026-10-26), so seed data is made
 * the way the app makes it and cannot drift from it: every derived column
 * (`occurrence_at`, `original_due_at`, the anchors, `repeat_anchor`, the
 * stamps) comes from the one code path. Before this the seeds wrote raw rows
 * and a repeating one had no `occurrence_at` until the server's next start
 * patched it (`seedOccurrenceAt`, src/core/db/occurrence-seed.ts) — on
 * production, the demo account after every reset.
 *
 * Then each row is AGED, which the API cannot do: `created_at` (and the
 * target-set / horizon-set stamps createTask put on it, so Upcoming counts
 * from the day it was "made", as before — a raw row's NULL stamp read as
 * `created_at`), `updated_at`, the done / archived / trashed state and any
 * completion history the seed gives it.
 *
 * WHAT A SEED DOES NOT LEAVE BEHIND. createTask also writes bookkeeping a
 * real create needs and a seed must not have: an undo entry per row (a demo
 * visitor's first Undo would trash a seeded task), an activity entry per row,
 * and `tasks_created` in today's stats. All three are taken back here, so the
 * account looks as the raw seeds left it. (Its logAction also clears the
 * user's redo stack — empty for every caller: a new user, or the demo reset,
 * which has just deleted the undo log.) Enrichment is never queued
 * (`enrichment: false`): AI on or off, the seed's words are final. The rest
 * is inert in a seed: the sync events have no listener outside the server,
 * and the webhooks and the badge push read the user's rows, which a new or
 * just-reset account does not have.
 *
 * THE TASK-QUEUE SWITCH. A seed is a script, not the server, so it cannot
 * know `OPENTASK_TASK_QUEUE` (AGENTS.md § Database: "Steps that read the
 * task-queue switch run in the server only") — and createTask reads it for a
 * deadline (an automatic target or the deadlines page), a deck, a lead or a
 * relative target, and for the day a date-less rule starts on. A seed row
 * with any of those would be written for the wrong switch (the 2026-10-24
 * automatic-target bug), so `seedTasks` refuses one.
 *
 * Uses the open database (`getDb()`). Returns the new ids, in order.
 */
export function seedTasks(userId: number, timezone: string, rows: SeedTaskRow[]): number[] {
  for (const row of rows) assertSwitchFree(row.input)
  const db = getDb()
  const maxId = (table: 'undo_log' | 'activity_log') =>
    (db.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM ${table}`).get() as { m: number }).m
  const undoMark = maxId('undo_log')
  const activityMark = maxId('activity_log')
  const statsBefore = new Map(
    (
      db
        .prepare('SELECT date, tasks_created FROM user_daily_stats WHERE user_id = ?')
        .all(userId) as {
        date: string
        tasks_created: number
      }[]
    ).map((r) => [r.date, r.tasks_created]),
  )

  const age = db.prepare(`
    UPDATE tasks SET created_at = ?, updated_at = ?, target_set_at = ?,
      horizon_set_at = CASE WHEN horizon_set_at IS NULL THEN NULL ELSE ? END,
      done = ?, done_at = ?, archived_at = ?, deleted_at = ?,
      completion_count = ?, last_completed_at = ?
    WHERE id = ?
  `)
  const ids = rows.map((row) => {
    // Validated as the API validates a POST body, then made as the API makes it.
    const input = validateTaskCreate(row.input)
    const task = createTask({ userId, userTimezone: timezone, input, enrichment: false })
    age.run(
      row.createdAt,
      row.updatedAt ?? row.createdAt,
      row.createdAt,
      row.createdAt,
      row.doneAt ? 1 : 0,
      row.doneAt ?? null,
      row.archivedAt ?? null,
      row.deletedAt ?? null,
      row.completionCount ?? 0,
      row.lastCompletedAt ?? null,
      task.id,
    )
    return task.id
  })

  db.prepare('DELETE FROM undo_log WHERE user_id = ? AND id > ?').run(userId, undoMark)
  db.prepare('DELETE FROM activity_log WHERE user_id = ? AND id > ?').run(userId, activityMark)
  const statsAfter = db
    .prepare('SELECT date FROM user_daily_stats WHERE user_id = ?')
    .all(userId) as { date: string }[]
  for (const { date } of statsAfter) {
    const before = statsBefore.get(date)
    if (before === undefined) {
      db.prepare('DELETE FROM user_daily_stats WHERE user_id = ? AND date = ?').run(userId, date)
    } else {
      db.prepare(
        'UPDATE user_daily_stats SET tasks_created = ? WHERE user_id = ? AND date = ?',
      ).run(before, userId, date)
    }
  }
  return ids
}

/** The fields whose meaning depends on the task-queue switch (see `seedTasks`). */
function assertSwitchFree(input: TaskCreateInput): void {
  const switchField =
    input.deadline_at != null
      ? 'deadline_at'
      : input.on_deck_day != null
        ? 'on_deck_day'
        : input.lead_days != null
          ? 'lead_days'
          : input.target_days_before != null || input.target_time != null
            ? 'a relative target'
            : input.rrule && !input.due_at
              ? 'a repeat with no date'
              : null
  if (switchField) {
    throw new Error(
      `seedTasks: "${input.title}" has ${switchField}, which a script cannot seed — ` +
        'it depends on the task-queue switch, which only the server knows',
    )
  }
}
