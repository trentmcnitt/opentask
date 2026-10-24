/**
 * DATA STEP for the deadlines page (2026-10-22; docs/TASK-MODEL.md § The
 * deadlines page; plan §6). Runs at startup with the task-queue switch ON only
 * (plan A1: the page, its nag and this migration all ride the switch) — off,
 * the automatic deadline target is still written, and this never runs.
 *
 * THE STEPS, in one transaction, per row in the owner's zone and OpenTask day
 * (rollover time = the owner's "Day starts at" through `dayStartTimeOf`, as
 * `stampRolloverDates` reads it — this runs below the `getDb()` layer):
 *  1. AUTO → LEAD — an OPEN one-off whose target is the deadline's automatic
 *     one (`target_auto = 1`): its attempts are checkpointed as of now
 *     (`effectiveAttempts`, as `stampTargetSet` does before a move), then
 *     `due_at`, `original_due_at` → NULL, `target_auto` → 0, and `lead_from`
 *     := the local day the removed target would have started nagging on
 *     (never after the deadline's day minus one, TM-INV-10). `target_set_at`
 *     is kept. The task lands on the deadlines page on its old auto day.
 *  2. LEAD FOR THE REST — an open ordinary one-off with a deadline and no
 *     lead day (a picked target: dormant until the target is removed):
 *     `leadFor`, the wait counted from now.
 *  3. TARGET-LESS REPEATS — an open deadline-anchored repeat with no relative
 *     target and no lead day: `leadFor` for its current occurrence. Repeats
 *     WITH offsets are left exactly as they are (A6: possibly defaulted
 *     offsets are LISTED for Trent — `planDeadlineLeadMigration`'s
 *     `repeatOffsets` — never changed).
 *     Step 1 also takes the row out of the task queue, and any target-less
 *     deadline one-off still queued is unqueued (`QUEUED_WHERE`).
 *  4. THE UNDO FENCE (`rolledOverSince`) — `rolled_over_at` := now on every
 *     row this run wrote; and, only on a run that converted automatic targets
 *     (step 1), also on every task with `target_auto = 1` in any state and
 *     every task an undo entry's snapshot holds with a truthy `target_auto`
 *     (`"target_auto":true` or `1`): undo and redo then skip those snapshots,
 *     so no automatic target comes back. A later start fences only what it
 *     wrote. A done or trashed automatic-target task is converted when it is
 *     reopened or restored (`autoTargetToLead`).
 *
 * IDEMPOTENT: step 1 matches `target_auto = 1` (open) only, steps 2–3
 * `lead_from IS NULL` only; once run, nothing matches and step 4 is skipped.
 *
 * COUNTING: `planDeadlineLeadMigration` returns every step's ids (no titles)
 * without writing, plus the counts Trent asked for — closed `target_auto = 1`
 * rows, undo entries holding `target_auto`, and the A6 list of
 * deadline-anchored repeats with stored offsets (`matchesDefault`: the
 * offsets are exactly what the old default, `defaultRelativeTarget`, gives
 * at the user's raw morning time — likely defaulted, not chosen).
 * `scripts/count-deadline-leads.ts` prints it for any database file.
 */

import type Database from 'better-sqlite3'
import { DateTime } from 'luxon'
import { dayStartTimeOf } from '@/lib/anchor-times'
import {
  defaultRelativeTarget,
  deadlineDay,
  effectiveAttempts,
  leadFor,
  shiftDay,
} from '@/lib/task-segments'

const OPEN_ORDINARY = `t.done = 0 AND t.deleted_at IS NULL AND t.archived_at IS NULL
  AND t.is_reminder = 0 AND t.is_tracked = 0 AND t.progress_target <= 1`
const AUTO_WHERE = `t.target_auto = 1 AND t.rrule IS NULL AND ${OPEN_ORDINARY}`
const ONE_OFF_WHERE = `t.deadline_at IS NOT NULL AND t.rrule IS NULL AND t.lead_from IS NULL
  AND ${OPEN_ORDINARY}`
/**
 * A deadline one-off with no target still in the task queue (only the old
 * `stripDecks` could queue one; prod had none on 10-22): unqueued, as
 * clear-decks does, so the deadlines page — not the queue — holds it.
 */
const QUEUED_WHERE = `t.deadline_at IS NOT NULL AND t.rrule IS NULL AND t.due_at IS NULL
  AND (t.queued_at IS NOT NULL OR t.try_tomorrow = 1 OR t.queue_mark = 1) AND ${OPEN_ORDINARY}`
const REPEAT_WHERE = `t.deadline_at IS NOT NULL AND t.rrule IS NOT NULL
  AND t.repeat_anchor = 'deadline' AND (t.target_days_before IS NULL OR t.target_time IS NULL)
  AND t.lead_from IS NULL AND ${OPEN_ORDINARY}`
const OFFSETS_WHERE = `t.rrule IS NOT NULL AND t.repeat_anchor = 'deadline'
  AND t.target_days_before IS NOT NULL AND t.target_time IS NOT NULL AND ${OPEN_ORDINARY}`

interface Row {
  id: number
  user_id: number
  due_at: string | null
  deadline_at: string
  rrule: string | null
  recurrence_mode: 'from_due' | 'from_completion' | null
  anchor_time: string | null
  repeat_anchor: 'target' | 'deadline' | null
  target_days_before: number | null
  target_time: string | null
  lead_days: number | null
  occurrence_at: string | null
  created_at: string
  target_set_at: string | null
  last_completed_at: string | null
  attempts: number
  attempts_counted_through: string | null
  timezone: string | null
  morning_time: string | null
  day_start_time: string | null
  day_start_slot_id: number | null
}

const COLUMNS = `t.id, t.user_id, t.due_at, t.deadline_at, t.rrule, t.recurrence_mode,
  t.anchor_time, t.repeat_anchor, t.target_days_before, t.target_time, t.lead_days,
  t.occurrence_at, t.created_at, t.target_set_at, t.last_completed_at, t.attempts,
  t.attempts_counted_through, u.timezone, u.morning_time, u.day_start_time, u.day_start_slot_id`

function rows(db: Database.Database, where: string): Row[] {
  return db
    .prepare(
      `SELECT ${COLUMNS} FROM tasks t JOIN users u ON u.id = t.user_id
        WHERE ${where} ORDER BY t.id`,
    )
    .all() as Row[]
}

/** A user's clock as the migration reads it (no resolver: below `getDb()`). */
function clockFor(db: Database.Database): (row: Row) => { tz: string; rollover: string } {
  const slots = db.prepare('SELECT id, start_time FROM time_slots WHERE user_id = ?')
  const cache = new Map<number, { tz: string; rollover: string }>()
  return (row) => {
    let clock = cache.get(row.user_id)
    if (!clock) {
      clock = {
        tz: row.timezone || 'UTC',
        rollover: dayStartTimeOf(
          row,
          slots.all(row.user_id) as { id: number; start_time: string }[],
        ),
      }
      cache.set(row.user_id, clock)
    }
    return clock
  }
}

/** Task ids an undo entry's snapshot holds with a truthy `target_auto`. */
function undoAutoIds(db: Database.Database): { entries: number; ids: number[] } {
  const found = db
    .prepare(
      `SELECT snapshot FROM undo_log
        WHERE snapshot LIKE '%"target_auto":true%' OR snapshot LIKE '%"target_auto":1%'`,
    )
    .all() as { snapshot: string }[]
  const ids = new Set<number>()
  for (const { snapshot } of found) {
    let parsed: unknown
    try {
      parsed = JSON.parse(snapshot)
    } catch {
      continue
    }
    for (const s of Array.isArray(parsed) ? parsed : [parsed]) {
      const snap = s as {
        task_id?: number
        before_state?: { target_auto?: unknown }
        after_state?: { target_auto?: unknown }
      }
      const auto = !!snap?.before_state?.target_auto || !!snap?.after_state?.target_auto
      if (auto && typeof snap.task_id === 'number') ids.add(snap.task_id)
    }
  }
  return { entries: found.length, ids: [...ids].sort((a, b) => a - b) }
}

/** The lead day an automatic target's removal leaves: its local day, ≤ D−1. */
function autoLeadDay(row: Row, tz: string, rollover: string): string {
  const day = DateTime.fromISO(row.due_at!, { zone: 'utc' }).setZone(tz).toISODate()!
  const lastDay = shiftDay(deadlineDay(row.deadline_at, tz, rollover), -1, tz)
  return day > lastDay ? lastDay : day
}

/** A repeat with stored offsets, for Trent (A6). Ids and rule fields only — never titles. */
export interface RepeatOffsetRow {
  id: number
  user_id: number
  rrule: string
  target_days_before: number
  target_time: string
  /** What the old default (`defaultRelativeTarget`) gives at the user's raw morning time. */
  default: { days_before: number; time: string } | null
  matchesDefault: boolean
}

export interface DeadlineLeadPlan {
  autoToLead: number[]
  oneOffLead: number[]
  repeatLead: number[]
  /**
   * Deadline one-offs taken out of the task queue: the auto-target rows that
   * are queued, and any target-less one already queued (`QUEUED_WHERE`).
   */
  unqueued: number[]
  /** Counts only, for the report (plan §6 "still to count"). */
  closedAuto: number[]
  undoEntriesWithAuto: number
  undoTaskIdsWithAuto: number[]
  repeatOffsets: RepeatOffsetRow[]
}

function repeatOffsets(db: Database.Database): RepeatOffsetRow[] {
  // Only columns a copy from before this build has (no `lead_*` yet).
  const found = db
    .prepare(
      `SELECT t.id, t.user_id, t.rrule, t.recurrence_mode, t.anchor_time, t.deadline_at,
              t.occurrence_at, t.target_days_before, t.target_time, u.timezone, u.morning_time
         FROM tasks t JOIN users u ON u.id = t.user_id
        WHERE ${OFFSETS_WHERE} ORDER BY t.id`,
    )
    .all() as Row[]
  return found.map((row) => {
    const tz = row.timezone || 'UTC'
    let def: { days_before: number; time: string } | null = null
    try {
      def = defaultRelativeTarget(
        {
          rrule: row.rrule!,
          recurrence_mode: row.recurrence_mode ?? 'from_due',
          anchor_time: row.anchor_time,
        },
        row.occurrence_at ?? row.deadline_at,
        tz,
        row.morning_time || '09:00',
      )
    } catch {
      def = null
    }
    return {
      id: row.id,
      user_id: row.user_id,
      rrule: row.rrule!,
      target_days_before: row.target_days_before!,
      target_time: row.target_time!,
      default: def,
      matchesDefault:
        def !== null && def.days_before === row.target_days_before && def.time === row.target_time,
    }
  })
}

/**
 * What the migration would touch, WITHOUT writing (safe on a read-only copy).
 * On a database from before this build (no `lead_from` column), every open
 * deadline task counts for steps 2–3.
 */
export function planDeadlineLeadMigration(db: Database.Database): DeadlineLeadPlan {
  const columns = (db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map(
    (c) => c.name,
  )
  const hasLead = columns.includes('lead_from')
  const noLead = (where: string) => (hasLead ? where : where.replace('AND t.lead_from IS NULL', ''))
  const ids = (where: string) =>
    (
      db.prepare(`SELECT t.id FROM tasks t WHERE ${where} ORDER BY t.id`).all() as { id: number }[]
    ).map((r) => r.id)
  const undo = undoAutoIds(db)
  const auto = ids(AUTO_WHERE)
  const queued = `(t.queued_at IS NOT NULL OR t.try_tomorrow = 1 OR t.queue_mark = 1)`
  return {
    autoToLead: auto,
    unqueued: [...new Set([...ids(`${AUTO_WHERE} AND ${queued}`), ...ids(QUEUED_WHERE)])].sort(
      (a, b) => a - b,
    ),
    oneOffLead: ids(noLead(ONE_OFF_WHERE)).filter((id) => !auto.includes(id)),
    repeatLead: columns.includes('repeat_anchor') ? ids(noLead(REPEAT_WHERE)) : [],
    closedAuto: ids(
      `t.target_auto = 1 AND NOT (t.done = 0 AND t.deleted_at IS NULL AND t.archived_at IS NULL)`,
    ),
    undoEntriesWithAuto: undo.entries,
    undoTaskIdsWithAuto: undo.ids,
    repeatOffsets: columns.includes('repeat_anchor') ? repeatOffsets(db) : [],
  }
}

export interface DeadlineLeadCounts {
  autoToLead: number
  oneOffLead: number
  repeatLead: number
  unqueued: number
  fenced: number
}

/** Run the four steps (see the header) in one transaction. */
export function migrateDeadlineLeads(
  db: Database.Database,
  now: Date = new Date(),
): DeadlineLeadCounts {
  return db.transaction(() => {
    const clock = clockFor(db)
    const nowStr = now.toISOString()
    const touched: number[] = []

    const toLead = db.prepare(
      `UPDATE tasks SET due_at = NULL, original_due_at = NULL, target_auto = 0, lead_from = ?,
              attempts = ?, attempts_counted_through = ?,
              queued_at = NULL, try_tomorrow = 0, queue_mark = 0 WHERE id = ?`,
    )
    const autoRows = rows(db, AUTO_WHERE)
    const queuedAuto = new Set(
      (
        db
          .prepare(
            `SELECT t.id FROM tasks t WHERE ${AUTO_WHERE}
               AND (t.queued_at IS NOT NULL OR t.try_tomorrow = 1 OR t.queue_mark = 1)`,
          )
          .all() as { id: number }[]
      ).map((r) => r.id),
    )
    for (const row of autoRows) {
      const { tz, rollover } = clock(row)
      if (!row.due_at) {
        // An automatic flag with no target (a hand-written row): just a lead.
        const lead = leadFor({ ...row }, tz, { rolloverTime: rollover, now })
        toLead.run(lead, row.attempts, row.attempts_counted_through, row.id)
      } else {
        // The checkpoint first (`stampTargetSet`'s rule): the days the auto
        // target was over are attempts; removing the target freezes them.
        const checked = effectiveAttempts(
          { ...row, done: false, deleted_at: null },
          tz,
          now,
          rollover,
        )
        toLead.run(autoLeadDay(row, tz, rollover), checked.attempts, checked.countedThrough, row.id)
      }
      touched.push(row.id)
    }

    const setLead = db.prepare('UPDATE tasks SET lead_from = ? WHERE id = ?')
    const lead = (where: string) => {
      let n = 0
      for (const row of rows(db, where)) {
        const { tz, rollover } = clock(row)
        setLead.run(leadFor({ ...row }, tz, { rolloverTime: rollover, now }), row.id)
        touched.push(row.id)
        n++
      }
      return n
    }
    // Deadline one-offs out of the queue (`QUEUED_WHERE`).
    const queuedIds = (
      db.prepare(`SELECT t.id FROM tasks t WHERE ${QUEUED_WHERE}`).all() as { id: number }[]
    ).map((r) => r.id)
    const unqueue = db.prepare(
      'UPDATE tasks SET queued_at = NULL, try_tomorrow = 0, queue_mark = 0 WHERE id = ?',
    )
    for (const id of queuedIds) {
      unqueue.run(id)
      touched.push(id)
    }
    const oneOffLead = lead(ONE_OFF_WHERE)
    const repeatLead = lead(REPEAT_WHERE)

    // THE FENCE. Every row this run wrote. Only a run that converted
    // automatic targets (the first start with the switch on, or one after the
    // switch was off and they came back) also fences every `target_auto` row
    // and every task an undo entry holds with one — a later start never
    // re-stamps those, so it never fences a fresh undo entry of theirs.
    const fence = new Set<number>(touched)
    if (autoRows.length > 0) {
      for (const r of db.prepare('SELECT id FROM tasks WHERE target_auto = 1').all() as {
        id: number
      }[]) {
        fence.add(r.id)
      }
      for (const id of undoAutoIds(db).ids) fence.add(id)
    }
    const stamp = db.prepare('UPDATE tasks SET rolled_over_at = ? WHERE id = ?')
    let fenced = 0
    for (const id of fence) fenced += stamp.run(nowStr, id).changes
    const unqueued = new Set([...queuedAuto, ...queuedIds]).size
    return { autoToLead: autoRows.length, oneOffLead, repeatLead, unqueued, fenced }
  })()
}
