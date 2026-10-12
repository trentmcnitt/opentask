/**
 * TM8-M: the 2026-10-12 data steps (`src/core/db/migrate-deadline-targets.ts`):
 * occurrence seed, nag-off → auto, deadline-without-target → auto, and
 * target-after-deadline → pulled back. Counted without writing
 * (`planDeadlineTargetMigration`, what `scripts/count-target-migration.ts`
 * prints), applied, and idempotent.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { DateTime } from 'luxon'
import { getDb } from '@/core/db'
import {
  migrateDeadlineTargets,
  planDeadlineTargetMigration,
} from '@/core/db/migrate-deadline-targets'
import { getTaskById } from '@/core/tasks/read'
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
    // 2. nag off: removed target (due null), and a snooze past the deadline.
    const nagOff = row({ deadline_at: at('2026-10-23T23:59'), deadline_nag_off: 1 })
    const nagOffPast = row({
      deadline_at: at('2026-10-16T17:00'),
      due_at: at('2026-10-20T09:00'),
      deadline_nag_off: 1,
    })
    // 3. a deadline and no target.
    const bare = row({ deadline_at: at('2026-10-31T23:59') })
    // 4. a target after its deadline (27694's shape: deadline 00:00, target 9 AM).
    const after = row({ deadline_at: at('2026-10-23T00:00'), due_at: at('2026-10-23T09:00') })
    // Left alone: done, trashed, a reminder, a target before its deadline.
    const doneRow = row({ deadline_at: at('2026-10-23T23:59'), done: 1 })
    const trashed = row({ deadline_at: at('2026-10-23T23:59'), deleted_at: at('2026-10-01T09:00') })
    const reminder = row({ deadline_at: at('2026-10-23T23:59'), is_reminder: 1 })
    const fine = row({ deadline_at: at('2026-10-23T23:59'), due_at: at('2026-10-20T09:00') })

    expect(planDeadlineTargetMigration(db)).toEqual({
      occurrenceSeed: 2,
      nagOffToAuto: 2,
      deadlineNoTargetToAuto: 1,
      pullBackToDeadline: 1,
    })
    expect(migrateDeadlineTargets(db, NOW)).toEqual({
      occurrenceSeed: 2,
      nagOffToAuto: 2,
      deadlineNoTargetToAuto: 1,
      pullBackToDeadline: 1,
    })

    expect(getTaskById(weekly)!.occurrence_at).toBe(at('2026-10-18T12:00'))
    expect(getTaskById(daily)!.occurrence_at).toBe(at('2026-10-13T09:00'))
    expect(getTaskById(nagOff)).toMatchObject({ due_at: at('2026-10-20T09:00'), target_auto: true })
    expect(getTaskById(nagOffPast)!.target_auto).toBe(true)
    expect(Date.parse(getTaskById(nagOffPast)!.due_at!) <= Date.parse(at('2026-10-16T17:00'))).toBe(
      true,
    )
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
      deadlineNoTargetToAuto: 0,
      pullBackToDeadline: 0,
    }
    expect(planDeadlineTargetMigration(db)).toEqual(zero)
    expect(migrateDeadlineTargets(db, NOW)).toEqual(zero)
  })
})
