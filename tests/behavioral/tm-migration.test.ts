/**
 * TM8-M: the 2026-10-12 data steps (`src/core/db/migrate-deadline-targets.ts`):
 * occurrence seed, nag-off without a target → auto, nag-off with a target →
 * kept as picked, deadline-without-target → auto, and target-after-a-deadline-
 * still-ahead → pulled back. Planned without writing (task ids per step —
 * `planDeadlineTargetMigration`, what `scripts/count-target-migration.ts`
 * prints), applied, and idempotent.
 */
import { describe, test, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { DateTime } from 'luxon'
import { getDb } from '@/core/db'
import {
  countsOf,
  migrateDeadlineTargets,
  planDeadlineTargetMigration,
} from '@/core/db/migrate-deadline-targets'
import { bulkSnooze } from '@/core/tasks'
import { snoozeTask } from '@/core/tasks/snooze'
import { getCurrentlyDueTaskIds } from '@/core/tasks/currently-due'
import { getTaskById } from '@/core/tasks/read'
import { segmentState, upcomingState } from '@/lib/task-segments'
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
    expect(upcomingState(t, tz, MON_EVENING)).toBeNull()
    expect(segmentState(t, tz, MON_EVENING)).toBeNull()

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
