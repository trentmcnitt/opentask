/**
 * Bulk snooze follows the same change rules as bulk edit (D1, 2026-09-29)
 *
 * `bulkSnooze` used to write due_at / original_due_at / snooze_count by hand
 * and drifted from `collectDueAtChanges`: a task with no date got a snooze
 * count and a snooze stat for being given its FIRST date, and a task already
 * due at the target was "snoozed" without moving. It now goes through the same
 * `collectFieldChanges` + `applyFieldChanges` pair as bulk/edit.
 *
 * The parity tests run one fixed selection through `bulkSnooze` and, on a
 * fresh database, through `bulkEdit` with the same date, and compare what
 * each leaves behind: the rows, the undo snapshots (not the undo action type,
 * which is `bulk_snooze` vs `bulk_edit` by design), the snooze stat and the
 * activity actions. The selection covers the sweep rules too (P3 held back
 * while something lower is present, P4 skipped, P4 rescued by
 * `includeTaskIds`), which the two endpoints share through
 * `filterForBulkSnooze`.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { getDb } from '@/core/db'
import { createTask, getTaskById } from '@/core/tasks'
import { bulkSnooze, bulkEdit } from '@/core/tasks/bulk'
import { executeUndo } from '@/core/undo'
import { getStatsSummary } from '@/core/stats'
import {
  setupTestDb,
  teardownTestDb,
  localTime,
  TEST_USER_ID,
  TEST_TIMEZONE,
} from '../helpers/setup'

const base = { userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE }

/** The target used by the absolute-mode runs — tomorrow 9 AM local. */
const target = () => localTime(9, 0, 1)

/**
 * The fixed selection, keyed by title so two runs on two fresh databases can
 * be compared without relying on ids.
 */
function seedSelection(): Map<string, number> {
  const make = (title: string, priority: number, due_at: string | null, rrule?: string) =>
    createTask({ ...base, input: { title, priority, due_at, ...(rrule ? { rrule } : {}) } }).id
  const ids = new Map<string, number>()
  ids.set('dated-p0', make('dated-p0', 0, localTime(8, 0)))
  ids.set('dateless-p1', make('dateless-p1', 1, null))
  ids.set('at-target-p2', make('at-target-p2', 2, target()))
  ids.set('recurring-p1', make('recurring-p1', 1, localTime(7, 0), 'FREQ=DAILY'))
  ids.set('high-p3', make('high-p3', 3, localTime(8, 30)))
  ids.set('urgent-p4', make('urgent-p4', 4, localTime(8, 45)))
  ids.set('rescued-p4', make('rescued-p4', 4, localTime(8, 50)))
  return ids
}

interface Outcome {
  counts: { tasksAffected: number; tasksSkipped: number; noDueDateSkipped: number }
  rows: Record<
    string,
    { due_at: string | null; original_due_at: string | null; snooze_count: number }
  >
  snapshots: Record<string, { before: unknown; after: unknown; fields: string[] }>
  undoFields: string[]
  snoozeStat: number
  activity: Record<string, string>
}

function capture(ids: Map<string, number>, counts: Outcome['counts'], statBefore: number): Outcome {
  const titleOf = new Map([...ids].map(([title, id]) => [id, title]))
  const rows: Outcome['rows'] = {}
  for (const [title, id] of ids) {
    const t = getTaskById(id)!
    rows[title] = {
      due_at: t.due_at,
      original_due_at: t.original_due_at,
      snooze_count: t.snooze_count,
    }
  }

  const db = getDb()
  const undo = db
    .prepare('SELECT fields_changed, snapshot FROM undo_log WHERE user_id = ? ORDER BY id DESC')
    .all(TEST_USER_ID) as { fields_changed: string; snapshot: string }[]
  const snapshots: Outcome['snapshots'] = {}
  // Only the bulk entry itself — the creates logged before it are older.
  const bulkEntry = undo[0]
  for (const s of JSON.parse(bulkEntry.snapshot) as {
    task_id: number
    before_state: unknown
    after_state: unknown
    fields_changed?: string[]
  }[]) {
    snapshots[titleOf.get(s.task_id)!] = {
      before: s.before_state,
      after: s.after_state,
      fields: s.fields_changed ?? [],
    }
  }

  const activity: Outcome['activity'] = {}
  for (const r of db
    .prepare("SELECT task_id, action FROM activity_log WHERE source = 'bulk' ORDER BY id")
    .all() as { task_id: number; action: string }[]) {
    activity[titleOf.get(r.task_id)!] = r.action
  }

  return {
    counts,
    rows,
    snapshots,
    undoFields: (JSON.parse(bulkEntry.fields_changed) as string[]).sort(),
    snoozeStat: (getStatsSummary(TEST_USER_ID, TEST_TIMEZONE).today?.snoozes ?? 0) - statBefore,
    activity,
  }
}

/** The counts both endpoints report (bulkSnooze adds sweep-specific ones). */
const pickCounts = (r: Outcome['counts']): Outcome['counts'] => ({
  tasksAffected: r.tasksAffected,
  tasksSkipped: r.tasksSkipped,
  noDueDateSkipped: r.noDueDateSkipped,
})

const snoozeStatNow = () => getStatsSummary(TEST_USER_ID, TEST_TIMEZONE).today?.snoozes ?? 0

type Mode = { until: string } | { deltaMinutes: number }

function runSnooze(mode: Mode): Outcome {
  setupTestDb()
  const ids = seedSelection()
  const stat = snoozeStatNow()
  const r = bulkSnooze({
    ...base,
    taskIds: [...ids.values()],
    includeTaskIds: [ids.get('rescued-p4')!],
    ...mode,
  })
  return capture(ids, pickCounts(r), stat)
}

function runEdit(mode: Mode): Outcome {
  setupTestDb()
  const ids = seedSelection()
  const stat = snoozeStatNow()
  const r = bulkEdit({
    ...base,
    taskIds: [...ids.values()],
    includeTaskIds: [ids.get('rescued-p4')!],
    ...('until' in mode
      ? { changes: { due_at: mode.until } }
      : { changes: {}, deltaMinutes: mode.deltaMinutes }),
  })
  return capture(ids, pickCounts(r), stat)
}

describe('Bulk snooze parity with bulk edit (D1)', () => {
  beforeEach(() => {
    // Jan 15, 2026, 10 AM Chicago — every seeded "today" time is overdue.
    vi.setSystemTime(new Date('2026-01-15T16:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    teardownTestDb()
  })

  test('BSP-001: absolute mode leaves the same rows, undo snapshots, stat and activity', () => {
    const edit = runEdit({ until: target() })
    const snooze = runSnooze({ until: target() })
    expect(snooze).toEqual(edit)

    // And what that shared outcome is, so parity cannot pass by both being wrong.
    expect(snooze.counts.tasksAffected).toBe(4) // dated, dateless, recurring, rescued P4
    expect(snooze.counts.tasksSkipped).toBe(2) // High (something lower present) + Urgent
    expect(snooze.rows['dated-p0'].snooze_count).toBe(1)
    expect(snooze.rows['recurring-p1'].snooze_count).toBe(1)
    expect(snooze.rows['rescued-p4'].snooze_count).toBe(1)
    expect(snooze.rows['high-p3'].due_at).toBe(localTime(8, 30))
    expect(snooze.rows['urgent-p4'].due_at).toBe(localTime(8, 45))
    expect(snooze.snoozeStat).toBe(3)
  })

  test('BSP-002: relative mode leaves the same rows, undo snapshots, stat and activity', () => {
    const edit = runEdit({ deltaMinutes: 60 })
    const snooze = runSnooze({ deltaMinutes: 60 })
    expect(snooze).toEqual(edit)

    // The no-op case cannot arise in relative mode; the dateless task is
    // skipped for having nothing to shift.
    expect(snooze.counts.noDueDateSkipped).toBe(1)
    expect(snooze.counts.tasksAffected).toBe(4) // dated, at-target, recurring, rescued P4
    expect(snooze.snoozeStat).toBe(4)
  })
})

describe('Bulk snooze — dateless and no-op targets (D1)', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-01-15T16:00:00Z'))
    setupTestDb()
  })

  afterEach(() => {
    vi.useRealTimers()
    teardownTestDb()
  })

  test('BSP-003: a dateless task gets its first date — no snooze count, no snooze stat', () => {
    const task = createTask({ ...base, input: { title: 'Someday' } })
    const stat = snoozeStatNow()

    const result = bulkSnooze({ ...base, taskIds: [task.id], until: target() })

    expect(result.tasksAffected).toBe(1)
    const after = getTaskById(task.id)!
    expect(after.due_at).toBe(target())
    expect(after.original_due_at).toBe(target())
    expect(after.snooze_count).toBe(0)
    expect(snoozeStatNow() - stat).toBe(0)
  })

  test('BSP-004: a task already due at the target is not touched or counted', () => {
    const task = createTask({ ...base, input: { title: 'Already there', due_at: target() } })
    const before = getTaskById(task.id)!
    const undoBefore = getDb().prepare('SELECT COUNT(*) AS n FROM undo_log').get() as { n: number }
    const stat = snoozeStatNow()

    const result = bulkSnooze({ ...base, taskIds: [task.id], until: target() })

    expect(result.tasksAffected).toBe(0)
    expect(result.snoozedIds).toEqual([])
    const after = getTaskById(task.id)!
    expect(after.snooze_count).toBe(before.snooze_count)
    expect(after.updated_at).toBe(before.updated_at)
    // No empty undo entry — nothing for a toast's Undo to reverse.
    const undoAfter = getDb().prepare('SELECT COUNT(*) AS n FROM undo_log').get() as { n: number }
    expect(undoAfter.n).toBe(undoBefore.n)
    expect(snoozeStatNow() - stat).toBe(0)
  })

  test('BSP-005: a dated task in the same batch is still a snooze, and undo restores both', () => {
    const dated = createTask({ ...base, input: { title: 'Dated', due_at: localTime(8, 0) } })
    const dateless = createTask({ ...base, input: { title: 'Dateless' } })
    const stat = snoozeStatNow()

    bulkSnooze({ ...base, taskIds: [dated.id, dateless.id], until: target() })

    expect(getTaskById(dated.id)!.snooze_count).toBe(1)
    expect(getTaskById(dated.id)!.original_due_at).toBe(localTime(8, 0))
    expect(getTaskById(dateless.id)!.snooze_count).toBe(0)
    expect(snoozeStatNow() - stat).toBe(1)

    executeUndo(TEST_USER_ID)
    expect(getTaskById(dated.id)!.due_at).toBe(localTime(8, 0))
    expect(getTaskById(dated.id)!.snooze_count).toBe(0)
    expect(getTaskById(dateless.id)!.due_at).toBeNull()
    expect(getTaskById(dateless.id)!.original_due_at).toBeNull()
  })

  test('BSP-006: a snooze cancels pending AI enrichment, as the single snooze does', () => {
    const task = createTask({ ...base, input: { title: 'Fresh', due_at: localTime(8, 0) } })
    getDb()
      .prepare('UPDATE tasks SET labels = ? WHERE id = ?')
      .run(JSON.stringify(['ai-to-process']), task.id)

    bulkSnooze({ ...base, taskIds: [task.id], until: target() })

    expect(getTaskById(task.id)!.labels).not.toContain('ai-to-process')
  })
})
