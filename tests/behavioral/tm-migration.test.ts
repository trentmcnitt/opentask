/**
 * TM8-M: the 2026-10-12 data steps (`src/core/db/migrate-deadline-targets.ts`):
 * occurrence seed, nag-off without a target → auto, nag-off with a target →
 * kept as picked, deadline-without-target → auto, and target-after-a-deadline-
 * still-ahead → pulled back. Planned without writing (task ids per step —
 * `planDeadlineTargetMigration`, what `scripts/count-target-migration.ts`
 * prints), applied, and idempotent.
 */
import { CALENDAR_DAY_START } from '@/lib/opentask-day'
import { describe, test, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { DateTime } from 'luxon'
import { getDb } from '@/core/db'
import {
  countsOf,
  migrateDeadlineTargets,
  planDeadlineTargetMigration,
} from '@/core/db/migrate-deadline-targets'
import { migrateRepeatAnchors, planRepeatAnchorMigration } from '@/core/db/migrate-repeat-anchor'
import { bulkSnooze, markDone, markUndone } from '@/core/tasks'
import { executeUndo } from '@/core/undo'
import { snoozeTask } from '@/core/tasks/snooze'
import { getCurrentlyDueTaskIds } from '@/core/tasks/currently-due'
import { getTaskById } from '@/core/tasks/read'
import { segmentState, targetMoved, upcomingState } from '@/lib/task-segments'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

const tz = TEST_TIMEZONE
function at(local: string): string {
  return DateTime.fromISO(local, { zone: tz }).toUTC().toISO()!
}
const NOW = new Date(at('2026-10-12T12:00'))

/** A row as the pre-migration code left it (raw SQL, like a database from before). */
function row(fields: Record<string, unknown>): number {
  const cols = { user_id: TEST_USER_ID, project_id: 1, title: 'Old', ...fields }
  const keys = Object.keys(cols)
  const res = getDb()
    .prepare(`INSERT INTO tasks (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
    .run(...Object.values(cols))
  return Number(res.lastInsertRowid)
}

describe('TM8-M: the target-model migration', () => {
  beforeAll(() => setupTestDb())
  afterAll(() => teardownTestDb())
  afterEach(() => vi.useRealTimers())

  test('TM8-M01: counts each step, applies it, and a second run touches nothing', () => {
    const db = getDb()
    db.prepare('DELETE FROM tasks').run()
    // 1. occurrence seed: two repeating tasks, one snoozed off its origin.
    const weekly = row({
      rrule: 'FREQ=WEEKLY;BYDAY=SU',
      due_at: at('2026-10-18T15:00'),
      original_due_at: at('2026-10-18T12:00'),
    })
    const daily = row({ rrule: 'FREQ=DAILY', due_at: at('2026-10-13T09:00') })
    // 2. nag off, no target (removed): the automatic target.
    const nagOff = row({ deadline_at: at('2026-10-23T23:59'), deadline_nag_off: 1 })
    // 3. nag off WITH a target: kept, as picked, flag cleared. This one's
    // deadline is still ahead and its target after it, so step 5 then pulls
    // it back to the deadline.
    const nagOffPast = row({
      deadline_at: at('2026-10-16T17:00'),
      due_at: at('2026-10-20T09:00'),
      target_set_at: at('2026-10-05T09:00'),
      deadline_nag_off: 1,
    })
    // 3. …and one whose deadline has passed: kept exactly as it is.
    const nagOffPassed = row({
      deadline_at: at('2026-10-10T17:00'),
      due_at: at('2026-10-14T09:00'),
      target_set_at: at('2026-10-11T20:00'),
      deadline_nag_off: 1,
    })
    // 4. a deadline and no target.
    const bare = row({ deadline_at: at('2026-10-31T23:59') })
    // 5. a target after its deadline (deadline 00:00, target 9 AM).
    const after = row({ deadline_at: at('2026-10-23T00:00'), due_at: at('2026-10-23T09:00') })
    // …but not when the deadline has already passed (2026-10-12 ruling).
    const afterPassed = row({
      deadline_at: at('2026-10-11T23:59'),
      due_at: at('2026-10-13T13:00'),
    })
    // Left alone: done, trashed, a reminder, a target before its deadline.
    const doneRow = row({ deadline_at: at('2026-10-23T23:59'), done: 1 })
    const trashed = row({ deadline_at: at('2026-10-23T23:59'), deleted_at: at('2026-10-01T09:00') })
    const reminder = row({ deadline_at: at('2026-10-23T23:59'), is_reminder: 1 })
    const fine = row({ deadline_at: at('2026-10-23T23:59'), due_at: at('2026-10-20T09:00') })

    const plan = planDeadlineTargetMigration(db, NOW)
    expect(plan).toEqual({
      occurrenceSeed: [weekly, daily],
      nagOffToAuto: [nagOff],
      nagOffKeptTarget: [nagOffPast, nagOffPassed],
      deadlineNoTargetToAuto: [bare],
      pullBackToDeadline: [nagOffPast, after],
      targetlessRepeatToDefault: [],
    })
    expect(migrateDeadlineTargets(db, NOW)).toEqual(countsOf(plan))

    expect(getTaskById(weekly)!.occurrence_at).toBe(at('2026-10-18T12:00'))
    expect(getTaskById(daily)!.occurrence_at).toBe(at('2026-10-13T09:00'))
    expect(getTaskById(nagOff)).toMatchObject({ due_at: at('2026-10-20T09:00'), target_auto: true })
    expect(getTaskById(nagOffPast)).toMatchObject({
      due_at: at('2026-10-16T17:00'),
      target_auto: false,
      target_set_at: at('2026-10-05T09:00'),
    })
    expect(getTaskById(nagOffPassed)).toMatchObject({
      due_at: at('2026-10-14T09:00'),
      target_auto: false,
      target_set_at: at('2026-10-11T20:00'),
    })
    expect(getTaskById(afterPassed)!.due_at).toBe(at('2026-10-13T13:00'))
    expect(getTaskById(bare)).toMatchObject({ due_at: at('2026-10-27T09:00'), target_auto: true })
    expect(getTaskById(bare)!.original_due_at).toBe(at('2026-10-27T09:00'))
    expect(getTaskById(after)).toMatchObject({ due_at: at('2026-10-23T00:00'), target_auto: false })
    for (const id of [doneRow, trashed, reminder]) expect(getTaskById(id)!.due_at).toBeNull()
    expect(getTaskById(fine)!.due_at).toBe(at('2026-10-20T09:00'))
    const nagFlags = db
      .prepare(
        'SELECT COUNT(*) AS n FROM tasks WHERE deadline_nag_off = 1 AND done = 0 AND deleted_at IS NULL AND is_reminder = 0',
      )
      .get() as { n: number }
    expect(nagFlags.n).toBe(0)

    const zero = {
      occurrenceSeed: 0,
      nagOffToAuto: 0,
      nagOffKeptTarget: 0,
      deadlineNoTargetToAuto: 0,
      pullBackToDeadline: 0,
      targetlessRepeatToDefault: 0,
    }
    expect(countsOf(planDeadlineTargetMigration(db, NOW))).toEqual(zero)
    expect(migrateDeadlineTargets(db, NOW)).toEqual(zero)
  })

  test('TM8-M02: golden — a nag-off task snoozed past its passed deadline keeps its target', () => {
    // The live shape (synthetic title): deadline Sun Oct 11 11:59 PM CDT,
    // passed; nag turned off; target Tue Oct 13 1:00 PM CDT, set Mon evening.
    const db = getDb()
    db.prepare('DELETE FROM tasks').run()
    const MON_EVENING = new Date(at('2026-10-12T20:00'))
    const id = row({
      title: 'Send the signed form',
      priority: 2,
      deadline_at: at('2026-10-11T23:59'),
      deadline_nag_off: 1,
      due_at: at('2026-10-13T13:00'),
      original_due_at: at('2026-10-13T13:00'),
      target_set_at: at('2026-10-12T19:30'),
    })
    expect(at('2026-10-13T13:00')).toBe('2026-10-13T18:00:00.000Z')
    expect(planDeadlineTargetMigration(db, MON_EVENING)).toMatchObject({
      nagOffToAuto: [],
      nagOffKeptTarget: [id],
      pullBackToDeadline: [],
    })
    migrateDeadlineTargets(db, MON_EVENING)
    const t = getTaskById(id)!
    expect(t).toMatchObject({
      due_at: at('2026-10-13T13:00'),
      target_auto: false,
      target_set_at: at('2026-10-12T19:30'),
      deadline_at: at('2026-10-11T23:59'),
    })
    expect(
      (
        db.prepare('SELECT deadline_nag_off FROM tasks WHERE id = ?').get(id) as {
          deadline_nag_off: number
        }
      ).deadline_nag_off,
    ).toBe(0)

    // Mon Oct 12 evening: quiet — not over target, not in Upcoming (a wait of
    // 1 day gives no heads-up), not in a horizon segment.
    vi.setSystemTime(MON_EVENING)
    expect(getCurrentlyDueTaskIds(TEST_USER_ID)).not.toContain(id)
    expect(upcomingState(t, tz, MON_EVENING, CALENDAR_DAY_START)).toBeNull()
    expect(segmentState(t, tz, MON_EVENING, CALENDAR_DAY_START)).toBeNull()

    // Tue Oct 13, 1 PM: over target.
    const TUE_1PM = new Date(at('2026-10-13T13:00'))
    vi.setSystemTime(new Date(TUE_1PM.getTime() - 60_000))
    expect(getCurrentlyDueTaskIds(TEST_USER_ID)).not.toContain(id)
    vi.setSystemTime(TUE_1PM)
    expect(getCurrentlyDueTaskIds(TEST_USER_ID)).toContain(id)

    // In bulk it is High (deadline passed): it waits while a P1 is in the batch.
    const p1 = row({ title: 'Other', priority: 1, due_at: at('2026-10-13T09:00') })
    const swept = bulkSnooze({
      userId: TEST_USER_ID,
      userTimezone: tz,
      taskIds: [id, p1],
      until: at('2026-10-14T09:00'),
    })
    expect(swept.snoozedIds).toEqual([p1])
    expect(swept.deadlineSkipped).toBe(1)
    expect(getTaskById(id)!.due_at).toBe(at('2026-10-13T13:00'))

    // A single snooze works: past the passed deadline, no cap.
    const r = snoozeTask({
      userId: TEST_USER_ID,
      userTimezone: tz,
      taskId: id,
      until: at('2026-10-14T09:00'),
    })
    expect(r.task.due_at).toBe(at('2026-10-14T09:00'))
    expect(r.cappedAtDeadline).toBe(false)
    expect(getCurrentlyDueTaskIds(TEST_USER_ID)).not.toContain(id)
  })
})

/**
 * TM8-R: the deadline-anchor data step (2026-10-21,
 * `src/core/db/migrate-repeat-anchor.ts`). Every repeat with a deadline,
 * still walking its target, becomes deadline-anchored at the same local
 * offset; general, tested on synthetic rows shaped like production's one
 * (a weekly Sunday noon target with a Sunday 11 PM deadline).
 */
describe('TM8-R: the deadline-anchor migration', () => {
  beforeAll(() => setupTestDb())
  afterAll(() => teardownTestDb())
  afterEach(() => vi.useRealTimers())

  /** The production shape: Sundays at noon, deadline that Sunday 11 PM. */
  function sundayRow(fields: Record<string, unknown> = {}): number {
    return row({
      rrule: 'FREQ=WEEKLY;BYDAY=SU;BYHOUR=12;BYMINUTE=0',
      anchor_time: '12:00',
      anchor_dow: 6,
      due_at: at('2026-10-25T12:00'),
      original_due_at: at('2026-10-25T12:00'),
      occurrence_at: at('2026-10-25T12:00'),
      deadline_at: at('2026-10-25T23:00'),
      ...fields,
    })
  }
  function completion(taskId: number, was: string, next: string): number {
    const res = getDb()
      .prepare(
        `INSERT INTO completions (task_id, user_id, completed_at, due_at_was, due_at_next, occurrence_at_was)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(taskId, TEST_USER_ID, was, was, next, was)
    return Number(res.lastInsertRowid)
  }

  test('TM8-R01: the production shape → deadline-anchored, same day at noon; idempotent', () => {
    const db = getDb()
    db.prepare('DELETE FROM completions').run()
    db.prepare('DELETE FROM tasks').run()
    const id = sundayRow()
    const done = completion(id, at('2026-10-18T12:00'), at('2026-10-25T12:00'))
    expect(planRepeatAnchorMigration(db)).toEqual({ convert: [id], skip: [] })

    const counts = migrateRepeatAnchors(db, NOW)
    expect(counts).toEqual({ converted: 1, completionsRewritten: 1, skipped: [] })
    const t = getTaskById(id)!
    expect(t).toMatchObject({
      rrule: 'FREQ=WEEKLY;BYDAY=SU;BYHOUR=23;BYMINUTE=0',
      anchor_time: '23:00',
      anchor_dow: 6,
      repeat_anchor: 'deadline',
      target_days_before: 0,
      target_time: '12:00',
      occurrence_at: at('2026-10-25T23:00'),
      deadline_at: at('2026-10-25T23:00'),
      due_at: at('2026-10-25T12:00'),
      rolled_over_at: NOW.toISOString(),
    })
    // The target is still the derivation: not moved.
    expect(targetMoved(t, tz)).toBe(false)
    // The completion now names the deadline occurrences it closed and opened.
    expect(
      db
        .prepare('SELECT occurrence_at_was, occurrence_at_next FROM completions WHERE id = ?')
        .get(done),
    ).toEqual({
      occurrence_at_was: at('2026-10-18T23:00'),
      occurrence_at_next: at('2026-10-25T23:00'),
    })
    // A second run: nothing.
    expect(planRepeatAnchorMigration(db)).toEqual({ convert: [], skip: [] })
    expect(migrateRepeatAnchors(db, NOW)).toEqual({
      converted: 0,
      completionsRewritten: 0,
      skipped: [],
    })

    // Done after it: the next Sunday — deadline 11 PM, target noon.
    vi.setSystemTime(new Date(at('2026-10-25T15:00')))
    markDone({ userId: TEST_USER_ID, userTimezone: tz, taskId: id })
    expect(getTaskById(id)).toMatchObject({
      occurrence_at: at('2026-11-01T23:00'),
      deadline_at: at('2026-11-01T23:00'),
      due_at: at('2026-11-01T12:00'),
    })
    // And put back: the occurrence it closed, its deadline with it.
    expect(markUndone({ userId: TEST_USER_ID, userTimezone: tz, taskId: id })).toMatchObject({
      occurrence_at: at('2026-10-25T23:00'),
      deadline_at: at('2026-10-25T23:00'),
      due_at: at('2026-10-25T12:00'),
    })
  })

  test('TM8-R02: a moved target is kept as this occurrence’s; a deck stays a deck', () => {
    getDb().prepare('DELETE FROM completions').run()
    getDb().prepare('DELETE FROM tasks').run()
    const moved = sundayRow({ due_at: at('2026-10-25T15:00') })
    const decked = sundayRow({ due_at: null, on_deck_day: '2026-10-24' })
    migrateRepeatAnchors(getDb(), NOW)
    expect(getTaskById(moved)).toMatchObject({
      repeat_anchor: 'deadline',
      due_at: at('2026-10-25T15:00'),
      occurrence_at: at('2026-10-25T23:00'),
    })
    expect(targetMoved(getTaskById(moved)!, tz)).toBe(true)
    expect(getTaskById(decked)).toMatchObject({
      repeat_anchor: 'deadline',
      due_at: null,
      on_deck_day: '2026-10-24',
    })
  })

  test('TM8-R03: skipped and logged, never guessed — and such a row loses its deadline on the next done', () => {
    getDb().prepare('DELETE FROM completions').run()
    getDb().prepare('DELETE FROM tasks').run()
    // A deadline BEFORE its occurrence (Sat 11 PM for a Sunday noon).
    const negative = sundayRow({ deadline_at: at('2026-10-24T23:00') })
    const fromCompletion = sundayRow({ recurrence_mode: 'from_completion' })
    // A daily with a deadline 3 days on: each target would overlap the previous deadline.
    const overlap = row({
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      anchor_time: '09:00',
      due_at: at('2026-10-13T09:00'),
      occurrence_at: at('2026-10-13T09:00'),
      deadline_at: at('2026-10-16T17:00'),
    })
    // Reminders and quotas are never touched.
    const reminder = sundayRow({ is_reminder: 1 })
    const skipped = [
      { id: negative, reason: 'negative_offset' },
      { id: fromCompletion, reason: 'from_completion' },
      { id: overlap, reason: 'problem' },
    ]
    expect(planRepeatAnchorMigration(getDb())).toEqual({ convert: [], skip: skipped })
    expect(migrateRepeatAnchors(getDb(), NOW)).toEqual({
      converted: 0,
      completionsRewritten: 0,
      skipped,
    })
    for (const id of [negative, fromCompletion, overlap, reminder]) {
      expect(getTaskById(id)!.repeat_anchor).toBe('target')
    }
    // The writers trust `occurrenceDates`: a target-anchored occurrence has no
    // deadline, so a skipped row's next done drops it (deliberate, pinned).
    vi.setSystemTime(new Date(at('2026-10-25T15:00')))
    markDone({ userId: TEST_USER_ID, userTimezone: tz, taskId: negative })
    expect(getTaskById(negative)).toMatchObject({
      occurrence_at: at('2026-11-01T12:00'),
      due_at: at('2026-11-01T12:00'),
      deadline_at: null,
    })
  })

  test('TM8-R04: an undo entry from before the migration skips the converted task (the fence)', () => {
    getDb().prepare('DELETE FROM completions').run()
    getDb().prepare('DELETE FROM tasks').run()
    getDb().prepare('DELETE FROM undo_log').run()
    const id = sundayRow()
    vi.setSystemTime(new Date(at('2026-10-20T09:00')))
    // A move before the migration: its snapshot holds the old meaning.
    snoozeTask({
      userId: TEST_USER_ID,
      userTimezone: tz,
      taskId: id,
      until: at('2026-10-25T15:00'),
    })
    vi.setSystemTime(new Date(at('2026-10-20T10:00')))
    migrateRepeatAnchors(getDb(), new Date())
    executeUndo(TEST_USER_ID)
    // Skipped: the move stays, and the deadline occurrence with it.
    expect(getTaskById(id)).toMatchObject({
      due_at: at('2026-10-25T15:00'),
      occurrence_at: at('2026-10-25T23:00'),
    })
  })
})

/** TM8-R, the rule's days (fresh-eyes review, 2026-10-21): a target's weekday is not its deadline's. */
describe("TM8-R: the migration moves the rule's days with the deadline", () => {
  beforeAll(() => setupTestDb())
  afterAll(() => teardownTestDb())
  afterEach(() => vi.useRealTimers())

  test("TM8-R05: the rule's DAYS move with the deadline — a Wednesday target, a Friday deadline", () => {
    getDb().prepare('DELETE FROM completions').run()
    getDb().prepare('DELETE FROM tasks').run()
    const id = row({
      rrule: 'FREQ=WEEKLY;BYDAY=WE;BYHOUR=9;BYMINUTE=0',
      anchor_time: '09:00',
      anchor_dow: 2,
      due_at: at('2026-10-21T09:00'),
      occurrence_at: at('2026-10-21T09:00'),
      deadline_at: at('2026-10-23T17:00'),
    })
    expect(migrateRepeatAnchors(getDb(), NOW).converted).toBe(1)
    expect(getTaskById(id)).toMatchObject({
      rrule: 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=17;BYMINUTE=0',
      anchor_dow: 4,
      target_days_before: 2,
      target_time: '09:00',
      occurrence_at: at('2026-10-23T17:00'),
    })
    // Done: the next Friday's deadline, its Wednesday target — never a Wednesday deadline.
    vi.setSystemTime(new Date(at('2026-10-21T12:00')))
    markDone({ userId: TEST_USER_ID, userTimezone: tz, taskId: id })
    expect(getTaskById(id)).toMatchObject({
      deadline_at: at('2026-10-30T17:00'),
      due_at: at('2026-10-28T09:00'),
    })
  })

  test("TM8-R06: a monthly day moves too — the 1st's target, the 3rd's deadline", () => {
    getDb().prepare('DELETE FROM completions').run()
    getDb().prepare('DELETE FROM tasks').run()
    const id = row({
      rrule: 'FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0',
      anchor_time: '09:00',
      anchor_dom: 1,
      due_at: at('2026-11-01T09:00'),
      occurrence_at: at('2026-11-01T09:00'),
      deadline_at: at('2026-11-03T17:00'),
    })
    expect(migrateRepeatAnchors(getDb(), NOW).converted).toBe(1)
    expect(getTaskById(id)).toMatchObject({
      rrule: 'FREQ=MONTHLY;BYMONTHDAY=3;BYHOUR=17;BYMINUTE=0',
      anchor_dom: 3,
      target_days_before: 2,
    })
  })

  test("TM8-R07: a day shift that can't be said, or doesn't walk the same, is skipped (rule_day_shift)", () => {
    getDb().prepare('DELETE FROM completions').run()
    getDb().prepare('DELETE FROM tasks').run()
    // The 1st Saturday + 1 day is not the 1st Sunday (Nov 7 → Nov 8 is the 2nd).
    const ordinal = row({
      rrule: 'FREQ=MONTHLY;BYDAY=1SA;BYHOUR=9;BYMINUTE=0',
      anchor_time: '09:00',
      due_at: at('2026-11-07T09:00'),
      occurrence_at: at('2026-11-07T09:00'),
      deadline_at: at('2026-11-08T17:00'),
    })
    // The 28th + 3 days runs past short months.
    const late = row({
      rrule: 'FREQ=MONTHLY;BYMONTHDAY=28;BYHOUR=9;BYMINUTE=0',
      anchor_time: '09:00',
      due_at: at('2026-10-28T09:00'),
      occurrence_at: at('2026-10-28T09:00'),
      deadline_at: at('2026-10-31T17:00'),
    })
    expect(migrateRepeatAnchors(getDb(), NOW).skipped).toEqual([
      { id: ordinal, reason: 'rule_day_shift' },
      { id: late, reason: 'rule_day_shift' },
    ])
    expect(getTaskById(ordinal)!.repeat_anchor).toBe('target')
  })
})
