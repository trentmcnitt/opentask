/**
 * UR-Q01..: undo/redo of a quota count across a period boundary is a no-op.
 *
 * A count only means something inside its period. Undoing Thursday's +1 on
 * Monday used to write Thursday's "before" count into the new week. The
 * decision (2026-09-24): NO-OP, not refuse. The entry is marked undone and the
 * stack moves on; the old period is already closed and recorded, so there is
 * nothing in the task to restore. Refusing would throw inside `undoEntry`,
 * roll back the `undone = 1` write, and wedge the top of the stack forever.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { getDb } from '@/core/db'
import { createTask, getTaskById, rolloverTrackedPeriods, updateTask } from '@/core/tasks'
import { incrementProgress } from '@/core/tasks/progress'
import { executeUndo, executeRedo } from '@/core/undo'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

const THU = new Date('2026-01-15T16:00:00Z')
const NEXT_MON = new Date('2026-01-19T16:00:00Z')

function weekly() {
  const q = createTask({
    userId: TEST_USER_ID,
    userTimezone: TEST_TIMEZONE,
    input: { title: 'Eggs', rrule: 'FREQ=WEEKLY', progress_target: 3, is_tracked: true },
  })
  rolloverTrackedPeriods(THU)
  return q
}

function undoneFlags(): number[] {
  return (
    getDb()
      .prepare('SELECT undone FROM undo_log WHERE user_id = ? ORDER BY id')
      .all(TEST_USER_ID) as {
      undone: number
    }[]
  ).map((r) => r.undone)
}

describe('Quota undo across a period boundary', () => {
  beforeEach(() => {
    vi.setSystemTime(THU)
    setupTestDb()
  })
  afterEach(() => {
    vi.useRealTimers()
    teardownTestDb()
  })

  test('UR-Q01: within the period, undo and redo work as always', () => {
    const q = weekly()
    incrementProgress({ userId: TEST_USER_ID, taskId: q.id })
    expect(executeUndo(TEST_USER_ID)).not.toBeNull()
    expect(getTaskById(q.id)!.progress_current).toBe(0)
    executeRedo(TEST_USER_ID)
    expect(getTaskById(q.id)!.progress_current).toBe(1)
  })

  test('UR-Q02: after the rollover, undo leaves the new period alone and moves the stack on', () => {
    const q = weekly()
    updateTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: q.id,
      input: { notes: 'first' },
    })
    incrementProgress({ userId: TEST_USER_ID, taskId: q.id })
    incrementProgress({ userId: TEST_USER_ID, taskId: q.id })

    vi.setSystemTime(NEXT_MON)
    rolloverTrackedPeriods(NEXT_MON)
    incrementProgress({ userId: TEST_USER_ID, taskId: q.id }) // Monday's own +1
    expect(getTaskById(q.id)!.progress_current).toBe(1)

    executeUndo(TEST_USER_ID) // Monday's +1 — same period, restored
    expect(getTaskById(q.id)!.progress_current).toBe(0)
    executeUndo(TEST_USER_ID) // Thursday's second +1 — last week: a no-op
    expect(getTaskById(q.id)!.progress_current).toBe(0)
    executeUndo(TEST_USER_ID) // Thursday's first +1 — a no-op
    expect(getTaskById(q.id)!.progress_current).toBe(0)

    // Not wedged: the stack reached the notes edit beneath.
    executeUndo(TEST_USER_ID)
    expect(getTaskById(q.id)!.notes).toBeNull()
    // create (still live), then the edit and three +1s, all marked undone.
    expect(undoneFlags()).toEqual([0, 1, 1, 1, 1])
  })

  test('UR-Q03: redo across the boundary is a no-op too', () => {
    const q = weekly()
    incrementProgress({ userId: TEST_USER_ID, taskId: q.id })
    incrementProgress({ userId: TEST_USER_ID, taskId: q.id })
    executeUndo(TEST_USER_ID)
    expect(getTaskById(q.id)!.progress_current).toBe(1)

    vi.setSystemTime(NEXT_MON)
    rolloverTrackedPeriods(NEXT_MON)
    expect(getTaskById(q.id)!.progress_current).toBe(0)
    expect(executeRedo(TEST_USER_ID)).not.toBeNull()
    expect(getTaskById(q.id)!.progress_current).toBe(0)
  })
})
