/**
 * DATA STEP for deadline-anchored repeats (2026-10-21; docs/TASK-MODEL.md
 * § Recurrence Model). Before it, a repeating task with a deadline walked its
 * TARGET, and the deadline was carried "the same distance after" each new
 * occurrence (`advanceDeadline`, now gone). Every such row becomes
 * deadline-anchored: its rule walks the DEADLINE, and the target is derived
 * from it at the same local offset (`occurrenceDates`).
 *
 * WHICH ROWS: a rule and a deadline, still anchored on the target, ordinary
 * (never a reminder or a quota) — open or not, so a later restore is
 * consistent. Idempotent: a converted row's anchor is 'deadline', so the WHERE
 * no longer matches; a row that drifts back into this shape (an undo from
 * before the fence, a restore) is caught on the next start.
 *
 * PER ROW, in the owner's timezone:
 *  1. its occurrence: `occurrence_at`, else `original_due_at`, else `due_at`;
 *  2. the offset: local days from the occurrence's date to the deadline's,
 *     and the occurrence's local time (`relativeTargetOf`);
 *  3. the rule's DAYS moved by the offset (`shiftRuleDays`: BYDAY weekdays,
 *     BYMONTHDAY) and its BYHOUR/BYMINUTE := the deadline's local time
 *     (`setRuleTime`), its anchors re-derived (`deriveAnchorFields`) — then
 *     PROVED by walking both rules (`shiftedRuleHolds`;
 *     both in src/core/recurrence/rule-shift.ts): every new occurrence is
 *     the old one plus the offset's days, at the deadline's time;
 *  4. `repeat_anchor` 'deadline', the offset, `occurrence_at` := `deadline_at`;
 *  5. `due_at` is left as stored: on schedule it IS the new derivation; moved,
 *     it is this occurrence's moved target (`migrateDeadlineTargets`' pull-back
 *     has already capped one after a deadline still ahead);
 *  6. `rolled_over_at` := now — THE UNDO FENCE (`rolledOverSince`, A7): an
 *     entry written before it holds the old meaning of `occurrence_at` (the
 *     target's instant), and undoing it would plant a target into an
 *     occurrence the rule now walks at the deadline's time. Its snapshot of
 *     this task is skipped; the rest of the entry applies;
 *  7. its completion rows: `occurrence_at_was` (else `due_at_was`) and
 *     `occurrence_at_next` (from `due_at_next`) moved to the deadline instant
 *     of their occurrence — the same day shift at the deadline's time — so a
 *     put-back restores a deadline occurrence, never the old target's.
 *
 * SKIPPED, never guessed (logged on every start while one remains): no
 * occurrence to read; a deadline BEFORE its occurrence (a negative offset); a
 * from_completion rule; a rule whose day shift can't be expressed or doesn't
 * walk the same (`rule_day_shift`: a BYSETPOS, a month day past the 28th, an
 * ordinal weekday that crosses into another week); an offset
 * `relativeTargetProblem` refuses. Such a row
 * stays target-anchored WITH a deadline: the writers now trust
 * `occurrenceDates`, which gives a target-anchored occurrence no deadline, so
 * its next done or skip drops the deadline (tm-migration pins it). Prod had
 * none on 2026-10-21.
 *
 * COUNTING: `planRepeatAnchorMigration` returns the ids without writing
 * (`scripts/count-target-migration.ts` prints them).
 */

import type Database from 'better-sqlite3'
import { DateTime } from 'luxon'
import { deriveAnchorFields, setRuleTime } from '@/core/recurrence'
import { shiftRuleDays, shiftedRuleHolds } from '@/core/recurrence/rule-shift'
import { localMoment } from '@/lib/opentask-day'
import { relativeTargetOf, relativeTargetProblem, type RelativeTarget } from '@/lib/task-segments'

/** Repeats with a deadline, still walking their target (columns qualified by `t.`). */
const REPEAT_WITH_DEADLINE = `t.rrule IS NOT NULL AND t.deadline_at IS NOT NULL
  AND t.is_reminder = 0 AND t.is_tracked = 0 AND t.progress_target <= 1`
const CONVERT_WHERE = `${REPEAT_WITH_DEADLINE} AND t.repeat_anchor = 'target'`

export type RepeatAnchorSkip =
  | 'no_occurrence'
  | 'negative_offset'
  | 'from_completion'
  | 'rule_day_shift'
  | 'problem'

interface Row {
  id: number
  rrule: string
  anchor_time: string | null
  recurrence_mode: string | null
  deadline_at: string
  occurrence_at: string | null
  original_due_at: string | null
  due_at: string | null
  timezone: string | null
}

/** What one row becomes, or why it is skipped. */
type Conversion =
  | {
      kind: 'convert'
      rrule: string
      anchors: ReturnType<typeof deriveAnchorFields>
      offset: RelativeTarget
      deadlineTime: string
    }
  | { kind: 'skip'; reason: RepeatAnchorSkip }

function convert(row: Row, tz: string): Conversion {
  if (row.recurrence_mode === 'from_completion') return { kind: 'skip', reason: 'from_completion' }
  const occurrence = row.occurrence_at ?? row.original_due_at ?? row.due_at
  if (!occurrence) return { kind: 'skip', reason: 'no_occurrence' }
  const offset = relativeTargetOf(occurrence, row.deadline_at, tz)
  if (!offset || offset.days_before < 0) return { kind: 'skip', reason: 'negative_offset' }
  const deadlineTime = DateTime.fromISO(row.deadline_at, { zone: 'utc' })
    .setZone(tz)
    .toFormat('HH:mm')
  const shifted = shiftRuleDays(row.rrule, offset.days_before)
  if (!shifted) return { kind: 'skip', reason: 'rule_day_shift' }
  const rrule = setRuleTime(shifted, deadlineTime)
  const anchors = deriveAnchorFields(rrule, row.deadline_at, tz)
  const rule = { rrule, recurrence_mode: 'from_due' as const, anchor_time: anchors.anchor_time }
  const old = {
    rrule: row.rrule,
    recurrence_mode: 'from_due' as const,
    anchor_time: row.anchor_time,
  }
  if (
    !shiftedRuleHolds(old, occurrence, rule, row.deadline_at, offset.days_before, deadlineTime, tz)
  ) {
    return { kind: 'skip', reason: 'rule_day_shift' }
  }
  if (relativeTargetProblem(offset, rule, row.deadline_at, tz)) {
    return { kind: 'skip', reason: 'problem' }
  }
  return { kind: 'convert', rrule, anchors, offset, deadlineTime }
}

function rows(db: Database.Database, where: string): Row[] {
  return db
    .prepare(
      `SELECT t.id, t.rrule, t.anchor_time, t.recurrence_mode, t.deadline_at, t.occurrence_at,
              t.original_due_at, t.due_at, u.timezone
         FROM tasks t JOIN users u ON u.id = t.user_id
        WHERE ${where} ORDER BY t.id`,
    )
    .all() as Row[]
}

export interface RepeatAnchorPlan {
  convert: number[]
  skip: { id: number; reason: RepeatAnchorSkip }[]
}

/**
 * What the step would do, without writing (safe on a read-only copy — one
 * from before this build too: with no `repeat_anchor` column every repeat
 * with a deadline is a candidate).
 */
export function planRepeatAnchorMigration(db: Database.Database): RepeatAnchorPlan {
  const columns = (db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map(
    (c) => c.name,
  )
  const where = columns.includes('repeat_anchor') ? CONVERT_WHERE : REPEAT_WITH_DEADLINE
  const plan: RepeatAnchorPlan = { convert: [], skip: [] }
  for (const row of rows(db, where)) {
    const c = convert(row, row.timezone || 'UTC')
    if (c.kind === 'convert') plan.convert.push(row.id)
    else plan.skip.push({ id: row.id, reason: c.reason })
  }
  return plan
}

export interface RepeatAnchorCounts {
  converted: number
  completionsRewritten: number
  skipped: { id: number; reason: RepeatAnchorSkip }[]
}

/** An instant moved to the deadline of its occurrence: `days` local days on, at `time`. */
function shiftToDeadline(iso: string, days: number, time: string, tz: string): string {
  const day = DateTime.fromISO(iso, { zone: 'utc' }).setZone(tz).plus({ days }).toISODate()!
  return localMoment(day, time, tz).toISOString()
}

/** Run the step (see the header) in one transaction. The caller logs the counts. */
export function migrateRepeatAnchors(
  db: Database.Database,
  now: Date = new Date(),
): RepeatAnchorCounts {
  return db.transaction(() => {
    const counts: RepeatAnchorCounts = { converted: 0, completionsRewritten: 0, skipped: [] }
    const update = db.prepare(
      `UPDATE tasks SET rrule = ?, anchor_time = ?, anchor_dow = ?, anchor_dom = ?,
              repeat_anchor = 'deadline', target_days_before = ?, target_time = ?,
              occurrence_at = deadline_at, rolled_over_at = ?
        WHERE id = ?`,
    )
    const completions = db.prepare(
      `SELECT id, due_at_was, due_at_next, occurrence_at_was FROM completions WHERE task_id = ?`,
    )
    const rewrite = db.prepare(
      'UPDATE completions SET occurrence_at_was = ?, occurrence_at_next = ? WHERE id = ?',
    )
    for (const row of rows(db, CONVERT_WHERE)) {
      const tz = row.timezone || 'UTC'
      const c = convert(row, tz)
      if (c.kind === 'skip') {
        counts.skipped.push({ id: row.id, reason: c.reason })
        continue
      }
      const { anchors, offset, deadlineTime } = c
      update.run(
        c.rrule,
        anchors.anchor_time,
        anchors.anchor_dow,
        anchors.anchor_dom,
        offset.days_before,
        offset.time,
        now.toISOString(),
        row.id,
      )
      counts.converted++
      const shift = (iso: string | null) =>
        iso ? shiftToDeadline(iso, offset.days_before, deadlineTime, tz) : null
      for (const done of completions.all(row.id) as {
        id: number
        due_at_was: string | null
        due_at_next: string | null
        occurrence_at_was: string | null
      }[]) {
        rewrite.run(
          shift(done.occurrence_at_was ?? done.due_at_was),
          shift(done.due_at_next),
          done.id,
        )
        counts.completionsRewritten++
      }
    }
    return counts
  })()
}
