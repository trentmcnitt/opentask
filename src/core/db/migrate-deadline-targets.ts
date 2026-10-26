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
 *  2. nag-off, no target → auto — a one-off whose deadline nag was turned off
 *     (`deadline_nag_off`, retired) and that has NO target of its own gets the
 *     deadline's automatic target, the flag cleared (Trent can re-pick). §8.7.
 *  3. nag-off with a target → kept as picked — a one-off whose nag was turned
 *     off and that HAS a target (a snooze past its deadline, usually): the
 *     target stays exactly as it is, picked (`target_auto = 0`, `due_at` and
 *     `target_set_at` untouched); only the flag is cleared.
 *  4. deadline, no target → auto — a one-off with a deadline and no target
 *     gets its stored automatic target (`autoTargetAt`, from now). §8.7.
 *  5. pull-back — a target after a deadline that is STILL AHEAD is pulled
 *     back to the deadline (§8.2). A deadline that has passed caps nothing
 *     (Trent's ruling, 2026-10-12), so its target is left alone.
 *
 * Steps 2–5 touch open tasks only (not done, trashed or archived); a task
 * restored later is caught by the next start. Ordinary tasks only: never a
 * reminder or a quota.
 *
 * THE DEADLINES PAGE (2026-10-22, plan L7): with the task-queue switch ON
 * (`leads`) no automatic target is ever written again, so steps 2 and 4 would
 * re-create one at every start. With `leads` step 4 is skipped and step 2
 * only clears the retired flag (the task stays target-less: the deadlines
 * page holds it, `migrateDeadlineLeads`). Switch off: as before.
 *
 * NOT THE SERVER (`switchSteps: false`, 2026-10-24; src/core/db/process-role.ts):
 * a process that is not the server cannot know the switch — it is set in the
 * server's environment only — so it runs neither version of any step that
 * reads `leads`: step 2 (auto, or flag-only), step 4 and the switch-off
 * rollback below are all skipped, and the server applies them at its next
 * start. Steps 1, 3 and 5 do not depend on the switch and run everywhere.
 *
 * COUNTING (Trent runs it on a read-only copy): `planDeadlineTargetMigration`
 * returns each step's task ids without writing anything, and
 * `scripts/count-target-migration.ts` prints them for any database file.
 * `migrateDeadlineTargets` logs the counts when it writes.
 */

import type Database from 'better-sqlite3'
import { OCCURRENCE_SEED_WHERE, REPEATING_DATED, seedOccurrenceAt } from './occurrence-seed'
import {
  autoTargetAt,
  defaultRelativeTarget,
  occurrenceDates,
  type TargetContext,
} from '@/lib/task-segments'

/** An open, ordinary (not reminder, not quota) task, columns qualified by `t.`. */
const OPEN_ORDINARY = `t.done = 0 AND t.deleted_at IS NULL AND t.archived_at IS NULL
  AND t.is_reminder = 0 AND t.is_tracked = 0 AND t.progress_target <= 1`

const NAG_OFF_NO_TARGET_WHERE = `t.deadline_nag_off = 1 AND t.deadline_at IS NOT NULL
  AND t.due_at IS NULL AND t.rrule IS NULL AND ${OPEN_ORDINARY}`
const NAG_OFF_KEEP_TARGET_WHERE = `t.deadline_nag_off = 1 AND t.deadline_at IS NOT NULL
  AND t.due_at IS NOT NULL AND t.rrule IS NULL AND ${OPEN_ORDINARY}`
const NO_TARGET_WHERE = `t.deadline_at IS NOT NULL AND t.due_at IS NULL AND t.rrule IS NULL
  AND t.deadline_nag_off = 0 AND ${OPEN_ORDINARY}`
/** Binds one parameter: now (ISO). Only a deadline still ahead pulls a target back. */
const PULL_BACK_WHERE = `t.deadline_at IS NOT NULL AND t.due_at IS NOT NULL
  AND julianday(t.deadline_at) > julianday(?)
  AND julianday(t.due_at) > julianday(t.deadline_at) AND ${OPEN_ORDINARY}`

/**
 * THE SWITCH-OFF ROLLBACK for target-less deadline repeats (2026-10-22): a
 * deadline-anchored repeat written with the switch on has no relative target
 * (L1); with the switch off (no deadlines page) it would never nag. So with
 * `leads` off it gets the default offsets (`defaultRelativeTarget`, the old
 * A1 default) and its occurrence's derived target — as a one-off gets its
 * automatic target back. Open rows only, not decked.
 */
const TARGETLESS_REPEAT_WHERE = `t.rrule IS NOT NULL AND t.repeat_anchor = 'deadline'
  AND t.deadline_at IS NOT NULL AND (t.target_days_before IS NULL OR t.target_time IS NULL)
  AND t.on_deck_day IS NULL AND ${OPEN_ORDINARY}`

export interface TargetMigrationCounts {
  occurrenceSeed: number
  nagOffToAuto: number
  nagOffKeptTarget: number
  deadlineNoTargetToAuto: number
  pullBackToDeadline: number
  targetlessRepeatToDefault: number
}

/** Each step's task ids (no titles), for checking a copy before it runs. */
export type TargetMigrationPlan = { [K in keyof TargetMigrationCounts]: number[] }

export interface TargetMigrationOptions {
  /** The task-queue switch is on (the deadlines page): no automatic target is written. */
  leads?: boolean
  /**
   * Run the steps that depend on `leads` (step 2, step 4, the switch-off
   * rollback). Only the server knows the switch: `runMigrations` passes
   * `isServerProcess()`, and anything else skips them (see the header).
   * Default true, for a caller that states `leads` itself.
   */
  switchSteps?: boolean
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
        WHERE ${where} ORDER BY t.id`,
    )
    .all() as AutoRow[]
}

function ids(db: Database.Database, where: string, ...params: unknown[]): number[] {
  return (
    db.prepare(`SELECT t.id FROM tasks t WHERE ${where} ORDER BY t.id`).all(...params) as {
      id: number
    }[]
  ).map((r) => r.id)
}

/**
 * What each step would touch, without writing anything (safe on a read-only
 * copy — including one from before this build, which has no `occurrence_at`
 * column yet: then every dated repeating task would be seeded). A task can be
 * in step 3 and step 5 both: its flag is cleared, then its target pulled back
 * to a deadline still ahead.
 */
export function planDeadlineTargetMigration(
  db: Database.Database,
  now: Date = new Date(),
  { leads = false, switchSteps = true }: TargetMigrationOptions = {},
): TargetMigrationPlan {
  const columns = (db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map(
    (c) => c.name,
  )
  return {
    occurrenceSeed: ids(
      db,
      columns.includes('occurrence_at') ? OCCURRENCE_SEED_WHERE : REPEATING_DATED,
    ),
    nagOffToAuto: switchSteps ? ids(db, NAG_OFF_NO_TARGET_WHERE) : [],
    nagOffKeptTarget: ids(db, NAG_OFF_KEEP_TARGET_WHERE),
    deadlineNoTargetToAuto: leads || !switchSteps ? [] : ids(db, NO_TARGET_WHERE),
    pullBackToDeadline: ids(db, PULL_BACK_WHERE, now.toISOString()),
    targetlessRepeatToDefault:
      leads || !switchSteps || !columns.includes('repeat_anchor')
        ? []
        : ids(db, TARGETLESS_REPEAT_WHERE),
  }
}

/** A plan's counts. */
export function countsOf(plan: TargetMigrationPlan): TargetMigrationCounts {
  return {
    occurrenceSeed: plan.occurrenceSeed.length,
    nagOffToAuto: plan.nagOffToAuto.length,
    nagOffKeptTarget: plan.nagOffKeptTarget.length,
    deadlineNoTargetToAuto: plan.deadlineNoTargetToAuto.length,
    pullBackToDeadline: plan.pullBackToDeadline.length,
    targetlessRepeatToDefault: plan.targetlessRepeatToDefault.length,
  }
}

function ctxOf(row: AutoRow): TargetContext {
  // The raw column, not `getAnchorTimes`: this runs inside `getDb()`'s
  // startup migrations, below the layer the resolver's adapter lives in
  // (which itself calls `getDb()`), and it is a one-shot that ran before
  // Morning could link to a period — every row it reads is custom.
  return { timezone: row.timezone || 'UTC', morningTime: row.morning_time || '09:00' }
}

/**
 * Run the five steps (see the header) in one transaction. Returns what each
 * touched; the caller logs it.
 */
export function migrateDeadlineTargets(
  db: Database.Database,
  now: Date = new Date(),
  { leads = false, switchSteps = true }: TargetMigrationOptions = {},
): TargetMigrationCounts {
  return db.transaction(() => {
    // Step 1 is shared with the seeds (`./occurrence-seed`).
    const occurrenceSeed = seedOccurrenceAt(db)

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
    // Steps 2 and 4 and the rollback read the switch: not the server, skipped.
    const nagOffToAuto = !switchSteps
      ? 0
      : leads
        ? db
            .prepare(`UPDATE tasks AS t SET deadline_nag_off = 0 WHERE ${NAG_OFF_NO_TARGET_WHERE}`)
            .run().changes
        : applyAuto(autoRows(db, NAG_OFF_NO_TARGET_WHERE))
    const nagOffKeptTarget = db
      .prepare(
        `UPDATE tasks AS t SET deadline_nag_off = 0, target_auto = 0
          WHERE ${NAG_OFF_KEEP_TARGET_WHERE}`,
      )
      .run().changes
    const deadlineNoTargetToAuto =
      leads || !switchSteps ? 0 : applyAuto(autoRows(db, NO_TARGET_WHERE))

    const pullBackToDeadline = db
      .prepare(`UPDATE tasks AS t SET due_at = t.deadline_at WHERE ${PULL_BACK_WHERE}`)
      .run(now.toISOString()).changes

    return {
      occurrenceSeed,
      nagOffToAuto,
      nagOffKeptTarget,
      deadlineNoTargetToAuto,
      pullBackToDeadline,
      targetlessRepeatToDefault: leads || !switchSteps ? 0 : defaultTargetlessRepeats(db, now),
    }
  })()
}

interface RepeatRow {
  id: number
  rrule: string
  recurrence_mode: 'from_due' | 'from_completion' | null
  anchor_time: string | null
  deadline_at: string
  occurrence_at: string | null
  timezone: string | null
  morning_time: string | null
}

/** The switch-off rollback for target-less deadline repeats (`TARGETLESS_REPEAT_WHERE`). */
function defaultTargetlessRepeats(db: Database.Database, now: Date): number {
  const found = db
    .prepare(
      `SELECT t.id, t.rrule, t.recurrence_mode, t.anchor_time, t.deadline_at, t.occurrence_at,
              u.timezone, u.morning_time
         FROM tasks t JOIN users u ON u.id = t.user_id
        WHERE ${TARGETLESS_REPEAT_WHERE} ORDER BY t.id`,
    )
    .all() as RepeatRow[]
  const write = db.prepare(
    `UPDATE tasks SET target_days_before = ?, target_time = ?, due_at = ?, original_due_at = ?,
            target_set_at = ? WHERE id = ?`,
  )
  let n = 0
  for (const row of found) {
    const ctx = ctxOf({ ...row, deadline_at: row.deadline_at })
    const occurrence = row.occurrence_at ?? row.deadline_at
    try {
      const rule = {
        rrule: row.rrule,
        recurrence_mode: row.recurrence_mode ?? 'from_due',
        anchor_time: row.anchor_time,
      }
      const offset = defaultRelativeTarget(rule, occurrence, ctx.timezone, ctx.morningTime)
      const target = occurrenceDates(
        {
          rrule: row.rrule,
          repeat_anchor: 'deadline',
          target_days_before: offset.days_before,
          target_time: offset.time,
        },
        occurrence,
        ctx.timezone,
      ).targetAt
      write.run(offset.days_before, offset.time, target, target, now.toISOString(), row.id)
      n++
    } catch {
      // A rule the walk can't step (a malformed row): left for the next start.
    }
  }
  return n
}
