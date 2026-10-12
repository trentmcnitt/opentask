/**
 * Data steps for the 2026-10-12 target model (spec §6 and §8; docs/TASK-MODEL.md
 * § Deadline, target, horizon). Idempotent: each step's WHERE matches nothing
 * once it has run, so `runMigrations` calls it on every start, like the other
 * backfills — and a row that drifts out of shape (an undo of a pre-migration
 * entry, a restore from trash) is put right on the next start.
 *
 * THE STEPS, in order:
 *  1. occurrence seed — a repeating task gets `occurrence_at` (its scheduled
 *     occurrence, now kept apart from the target). Seeded from
 *     `original_due_at`, else `due_at`: every completion advance and skip has
 *     always written `original_due_at = the next occurrence`, and a snooze kept
 *     it, so for a repeating task it IS the current occurrence. (A repeating
 *     task re-targeted through the editor's picker before today had its
 *     origin moved with it; that one occurrence is read as moved — the next
 *     done puts it back on schedule.)
 *  2. nag-off → auto — a one-off whose deadline nag was turned off
 *     (`deadline_nag_off`, retired) gets the deadline's automatic target, the
 *     flag cleared (Trent can re-pick). §8.7.
 *  3. deadline, no target → auto — a one-off with a deadline and no target
 *     gets its stored automatic target (`autoTargetAt`, from now). §8.7.
 *  4. pull-back — a target after its deadline is pulled back to the deadline
 *     (target ≤ deadline, always; §8.2). Live examples: 27694, 26815.
 *
 * Steps 2–4 touch open tasks only (not done, trashed or archived); a task
 * restored later is caught by the next start. Ordinary tasks only: never a
 * reminder or a quota.
 *
 * COUNTING (Trent runs it on a read-only copy): `planDeadlineTargetMigration`
 * returns each step's row count without writing anything, and
 * `scripts/count-target-migration.ts` prints it for any database file.
 * `migrateDeadlineTargets` logs the same counts when it writes.
 */

import type Database from 'better-sqlite3'
import { autoTargetAt, type TargetContext } from '@/lib/task-segments'

/** An open, ordinary (not reminder, not quota) task, columns qualified by `t.`. */
const OPEN_ORDINARY = `t.done = 0 AND t.deleted_at IS NULL AND t.archived_at IS NULL
  AND t.is_reminder = 0 AND t.is_tracked = 0 AND t.progress_target <= 1`

/** Repeating ordinary tasks with a date — every one, before the column exists. */
const REPEATING_DATED = `t.rrule IS NOT NULL AND t.due_at IS NOT NULL
  AND t.is_reminder = 0 AND t.is_tracked = 0 AND t.progress_target <= 1`
const OCCURRENCE_SEED_WHERE = `${REPEATING_DATED} AND t.occurrence_at IS NULL`
const NAG_OFF_WHERE = `t.deadline_nag_off = 1 AND t.deadline_at IS NOT NULL AND t.rrule IS NULL
  AND ${OPEN_ORDINARY}`
const NO_TARGET_WHERE = `t.deadline_at IS NOT NULL AND t.due_at IS NULL AND t.rrule IS NULL
  AND t.deadline_nag_off = 0 AND ${OPEN_ORDINARY}`
// `deadline_nag_off = 0`: a nag-off row is step 2's (and is under its deadline
// after it), so the counts never name one row twice.
const PULL_BACK_WHERE = `t.deadline_at IS NOT NULL AND t.due_at IS NOT NULL
  AND julianday(t.due_at) > julianday(t.deadline_at) AND t.deadline_nag_off = 0
  AND ${OPEN_ORDINARY}`

export interface TargetMigrationCounts {
  occurrenceSeed: number
  nagOffToAuto: number
  deadlineNoTargetToAuto: number
  pullBackToDeadline: number
}

interface AutoRow {
  id: number
  deadline_at: string
  timezone: string | null
  morning_time: string | null
}

function autoRows(db: Database.Database, where: string): AutoRow[] {
  return db
    .prepare(
      `SELECT t.id, t.deadline_at, u.timezone, u.morning_time
         FROM tasks t JOIN users u ON u.id = t.user_id
        WHERE ${where}`,
    )
    .all() as AutoRow[]
}

function count(db: Database.Database, where: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM tasks t WHERE ${where}`).get() as { n: number }).n
}

/**
 * What each step would touch, without writing anything (safe on a read-only
 * copy — including one from before this build, which has no `occurrence_at`
 * column yet: then every dated repeating task would be seeded).
 */
export function planDeadlineTargetMigration(db: Database.Database): TargetMigrationCounts {
  const hasOccurrence = (db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).some(
    (c) => c.name === 'occurrence_at',
  )
  return {
    occurrenceSeed: count(db, hasOccurrence ? OCCURRENCE_SEED_WHERE : REPEATING_DATED),
    nagOffToAuto: autoRows(db, NAG_OFF_WHERE).length,
    deadlineNoTargetToAuto: autoRows(db, NO_TARGET_WHERE).length,
    pullBackToDeadline: count(db, PULL_BACK_WHERE),
  }
}

function ctxOf(row: AutoRow): TargetContext {
  return { timezone: row.timezone || 'UTC', morningTime: row.morning_time || '09:00' }
}

/**
 * Run the four steps (see the header) in one transaction. Returns what each
 * touched; the caller logs it.
 */
export function migrateDeadlineTargets(
  db: Database.Database,
  now: Date = new Date(),
): TargetMigrationCounts {
  return db.transaction(() => {
    // UPDATE … AS t (SQLite 3.33+), so the WHEREs are shared with the counts.
    const occurrenceSeed = db
      .prepare(
        `UPDATE tasks AS t SET occurrence_at = COALESCE(t.original_due_at, t.due_at)
          WHERE ${OCCURRENCE_SEED_WHERE}`,
      )
      .run().changes

    // The automatic target is stored as the target AND its first-target date
    // (`original_due_at`, the age clock old native builds read).
    const setAuto = db.prepare(
      `UPDATE tasks SET due_at = ?, original_due_at = ?, target_auto = 1, deadline_nag_off = 0
        WHERE id = ?`,
    )
    const applyAuto = (rows: AutoRow[]) => {
      for (const row of rows) {
        const at = autoTargetAt(row.deadline_at, ctxOf(row), now)
        setAuto.run(at, at, row.id)
      }
      return rows.length
    }
    const nagOffToAuto = applyAuto(autoRows(db, NAG_OFF_WHERE))
    const deadlineNoTargetToAuto = applyAuto(autoRows(db, NO_TARGET_WHERE))

    const pullBackToDeadline = db
      .prepare(`UPDATE tasks AS t SET due_at = t.deadline_at WHERE ${PULL_BACK_WHERE}`)
      .run().changes

    return { occurrenceSeed, nagOffToAuto, deadlineNoTargetToAuto, pullBackToDeadline }
  })()
}
