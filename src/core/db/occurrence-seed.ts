/**
 * THE OCCURRENCE SEED (step 1 of `migrateDeadlineTargets`, 2026-10-12): a
 * repeating ordinary task with a date gets `occurrence_at`, its scheduled
 * occurrence, kept apart from the target (docs/TASK-MODEL.md § Deadline,
 * target, horizon). Seeded from `original_due_at`, else `due_at` — for a
 * repeating task `original_due_at` IS the current occurrence (every advance
 * and skip writes it, a snooze keeps it).
 *
 * Its own module so the seeds share it (2026-10-26): `createTask` always
 * writes `occurrence_at`, but a seed that has to write a task row with raw
 * SQL (fixed ids, or test data the suites pin) does not, and such a row
 * schedules from `due_at` alone until the server's next start patches it.
 * Those seeds call `seedOccurrenceAt` after their inserts — the same UPDATE
 * the migration runs, so the two can never disagree. No imports beyond the
 * driver's type: the E2E global setup, which opens the database itself,
 * uses it too. Guarded by tests/behavioral/seed-occurrence-guard.test.ts.
 */

import type Database from 'better-sqlite3'

/** Repeating ordinary tasks with a date (columns qualified by `t.`). */
export const REPEATING_DATED = `t.rrule IS NOT NULL AND t.due_at IS NOT NULL
  AND t.is_reminder = 0 AND t.is_tracked = 0 AND t.progress_target <= 1`

/** The rows the occurrence seed fills: repeating, dated, ordinary, no `occurrence_at`. */
export const OCCURRENCE_SEED_WHERE = `${REPEATING_DATED} AND t.occurrence_at IS NULL`

/** Fill `occurrence_at` on every row that lacks it; returns how many rows changed. */
export function seedOccurrenceAt(db: Database.Database): number {
  // UPDATE … AS t (SQLite 3.33+), so the WHERE is shared with the plan.
  return db
    .prepare(
      `UPDATE tasks AS t SET occurrence_at = COALESCE(t.original_due_at, t.due_at)
        WHERE ${OCCURRENCE_SEED_WHERE}`,
    )
    .run().changes
}
