/**
 * PC: Process (2026-10-10 task model, spec §5) — the rule-based steps behind
 * `GET /api/process` (`src/lib/process-rules.ts`, `src/core/tasks/process.ts`)
 * and the writes Process relies on: `affirm_horizon` ("keep") and the
 * remove-target bulk edit.
 *
 * Clock: Saturday 2026-10-10, 10:00 Chicago (15:00Z). "Old" tasks have their
 * created_at / horizon_set_at rewritten — the growth clock reads those.
 */
import { describe, test, expect, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { getDb } from '@/core/db'
import { createTask, updateTask, bulkEdit } from '@/core/tasks'
import { getTaskById } from '@/core/tasks/read'
import { executeUndo } from '@/core/undo'
import { getProcessData } from '@/core/tasks/process'
import { GROWTH_ASK_DAYS, growthAsk } from '@/lib/process-rules'
import { validateBulkEdit } from '@/core/validation'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

const tz = TEST_TIMEZONE
const NOW = new Date('2026-10-10T15:00:00Z')
const DAY = 24 * 60 * 60 * 1000

function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * DAY).toISOString()
}

function make(input: Record<string, unknown> = {}) {
  return createTask({ userId: TEST_USER_ID, userTimezone: tz, input: { title: 'Task', ...input } })
}

/** Make a task whose horizon clock started `days` ago. */
function onHorizonFor(days: number, input: Record<string, unknown> = {}) {
  const task = make(input)
  getDb()
    .prepare('UPDATE tasks SET created_at = ?, horizon_set_at = ? WHERE id = ?')
    .run(daysAgo(days), input.horizon ? daysAgo(days) : null, task.id)
  return getTaskById(task.id)!
}

function growthOf(id: number) {
  return getProcessData(TEST_USER_ID, tz).growth.find((g) => g.task.id === id) ?? null
}

function useProcessClock() {
  afterAll(() => teardownTestDb())
  beforeEach(() => {
    vi.setSystemTime(NOW)
    setupTestDb()
  })
  afterEach(() => vi.useRealTimers())
}

describe('Process: horizon growth asks', () => {
  useProcessClock()
  test.each([
    ['days', GROWTH_ASK_DAYS.days, 'weeks'],
    ['weeks', GROWTH_ASK_DAYS.weeks, 'months'],
    ['months', GROWTH_ASK_DAYS.months, 'eventually'],
  ] as const)('PC-001: %s asks at %i days, not the day before', (horizon, days, to) => {
    const before = onHorizonFor(days - 1, { horizon })
    const at = onHorizonFor(days, { horizon })
    expect(growthOf(before.id)).toBeNull()
    expect(growthOf(at.id)).toMatchObject({ from: horizon, to, days_on_horizon: days })
  })

  test('PC-002: unset reads as weeks on the clock but is reported as unset', () => {
    const young = onHorizonFor(59)
    const old = onHorizonFor(60)
    expect(growthOf(young.id)).toBeNull()
    expect(growthOf(old.id)).toMatchObject({ from: null, to: 'months' })
  })

  test('PC-003: eventually never grows', () => {
    const t = onHorizonFor(1000, { horizon: 'eventually' })
    expect(growthOf(t.id)).toBeNull()
  })

  test('PC-004: P2 and up can act ("do it" / "raise priority"); P0–P1 only grow', () => {
    const low = onHorizonFor(60, { priority: 1 })
    const medium = onHorizonFor(60, { priority: 2 })
    const urgent = onHorizonFor(60, { priority: 4 })
    expect(growthOf(low.id)?.can_act).toBe(false)
    expect(growthOf(medium.id)?.can_act).toBe(true)
    expect(growthOf(urgent.id)?.can_act).toBe(true)
  })

  test('PC-005: the clock is horizon_set_at, so setting a horizon restarts it', () => {
    const t = onHorizonFor(90, { horizon: 'weeks' })
    expect(growthOf(t.id)).not.toBeNull()
    updateTask({
      userId: TEST_USER_ID,
      userTimezone: tz,
      taskId: t.id,
      input: { horizon: 'days' },
    })
    expect(growthOf(t.id)).toBeNull()
  })

  test('PC-006: a task over target is not asked about growth (step 4 owns it)', () => {
    const overTarget = onHorizonFor(90, { due_at: daysAgo(1) })
    const futureTarget = onHorizonFor(90, {
      due_at: new Date(NOW.getTime() + 3 * DAY).toISOString(),
    })
    expect(growthOf(overTarget.id)).toBeNull()
    expect(growthOf(futureTarget.id)).not.toBeNull()
  })

  test('PC-007: a deadline steering the horizon blocks the ask; a far one does not', () => {
    const near = onHorizonFor(90, {
      deadline_at: new Date(NOW.getTime() + 30 * DAY).toISOString(),
    })
    const far = onHorizonFor(90, {
      deadline_at: new Date(NOW.getTime() + 200 * DAY).toISOString(),
    })
    expect(growthOf(near.id)).toBeNull()
    expect(growthOf(far.id)).toMatchObject({ to: 'months' })
  })

  test('PC-008: reminders, quotas, recurring and done tasks are never asked', () => {
    const ids = [
      make({ is_reminder: true, rrule: 'FREQ=DAILY' }).id,
      make({ rrule: 'FREQ=WEEKLY', due_at: daysAgo(-1) }).id,
      make({ is_tracked: true, progress_target: 3, rrule: 'FREQ=WEEKLY' }).id,
    ]
    getDb()
      .prepare(`UPDATE tasks SET created_at = ? WHERE id IN (${ids.join(',')})`)
      .run(daysAgo(400))
    const done = onHorizonFor(400)
    getDb().prepare('UPDATE tasks SET done = 1 WHERE id = ?').run(done.id)
    expect(getProcessData(TEST_USER_ID, tz).growth).toEqual([])
  })

  test('PC-009: pure rule agrees at the boundary in any timezone', () => {
    const base = {
      id: 1,
      priority: 0,
      horizon: 'days',
      horizon_set_at: daysAgo(14),
      created_at: daysAgo(400),
      due_at: null,
      original_due_at: null,
      deadline_at: null,
    }
    expect(growthAsk(base, 'Pacific/Auckland', NOW)?.to).toBe('weeks')
    expect(growthAsk({ ...base, horizon_set_at: daysAgo(13.9) }, 'UTC', NOW)).toBeNull()
  })
})

describe('Process: affirm_horizon ("keep")', () => {
  useProcessClock()
  test('PC-010: restarts the clock, leaves the horizon (unset stays unset), and undoes', () => {
    const unset = onHorizonFor(90)
    const weeks = onHorizonFor(90, { horizon: 'weeks' })
    bulkEdit({
      userId: TEST_USER_ID,
      userTimezone: tz,
      taskIds: [unset.id, weeks.id],
      changes: { affirm_horizon: true },
    })
    const a = getTaskById(unset.id)!
    const b = getTaskById(weeks.id)!
    expect(a.horizon).toBeNull()
    expect(a.horizon_set_at).toBe(NOW.toISOString())
    expect(b.horizon).toBe('weeks')
    expect(b.horizon_set_at).toBe(NOW.toISOString())
    expect(growthOf(unset.id)).toBeNull()
    expect(growthOf(weeks.id)).toBeNull()

    executeUndo(TEST_USER_ID)
    expect(getTaskById(unset.id)!.horizon_set_at).toBeNull()
    expect(getTaskById(weeks.id)!.horizon_set_at).toBe(daysAgo(90))
  })

  test('PC-011: the request schema accepts it on PATCH and bulk edit', () => {
    const parsed = validateBulkEdit({ ids: [1], changes: { affirm_horizon: true } })
    expect(parsed.changes.affirm_horizon).toBe(true)
  })
})

describe('Process: stale targets', () => {
  useProcessClock()
  test('PC-012: 7 days or more past the first target; 6 days is not', () => {
    const seven = make({ due_at: daysAgo(7) })
    const six = make({ due_at: daysAgo(6) })
    const data = getProcessData(TEST_USER_ID, tz)
    expect(data.stale_targets.map((s) => s.task.id)).toEqual([seven.id])
    expect(data.stale_targets[0].age_days).toBe(7)
    expect(data.stale_targets.some((s) => s.task.id === six.id)).toBe(false)
  })

  test('PC-013: a task with a deadline is listed apart, never with the rest', () => {
    const plain = make({ due_at: daysAgo(10) })
    const client = make({
      due_at: daysAgo(10),
      deadline_at: new Date(NOW.getTime() + 2 * DAY).toISOString(),
    })
    // Deadline, no target: the implied nag started deadline − 4 days ago.
    const implied = make({ deadline_at: daysAgo(5) })
    const data = getProcessData(TEST_USER_ID, tz)
    expect(data.stale_targets.map((s) => s.task.id)).toEqual([plain.id])
    expect(data.stale_targets_with_deadline.map((s) => s.task.id).sort()).toEqual(
      [client.id, implied.id].sort(),
    )
  })

  test('PC-014: a snooze keeps the age (measured from the first target)', () => {
    const t = make({ due_at: daysAgo(10) })
    updateTask({
      userId: TEST_USER_ID,
      userTimezone: tz,
      taskId: t.id,
      input: { due_at: daysAgo(1) },
    })
    expect(getProcessData(TEST_USER_ID, tz).stale_targets[0]).toMatchObject({
      task: { id: t.id },
      age_days: 10,
    })
  })

  test('PC-015: remove-target bulk edit clears every pick, P4 included, and undoes', () => {
    const low = make({ due_at: daysAgo(10), priority: 0 })
    const urgent = make({ due_at: daysAgo(10), priority: 4 })
    const ids = [low.id, urgent.id]
    const input = validateBulkEdit({
      ids,
      changes: { target_at: null, deadline_nag_off: true },
      include_task_ids: ids,
    })
    const result = bulkEdit({
      userId: TEST_USER_ID,
      userTimezone: tz,
      taskIds: input.ids,
      changes: input.changes,
      includeTaskIds: input.include_task_ids,
    })
    expect(result.tasksAffected).toBe(2)
    for (const id of ids) {
      const t = getTaskById(id)!
      expect(t.due_at).toBeNull()
      expect(t.deadline_nag_off).toBe(true)
    }
    const data = getProcessData(TEST_USER_ID, tz)
    expect(data.stale_targets).toEqual([])

    executeUndo(TEST_USER_ID)
    // deadline_nag_off is a boolean in the snapshot: its undo used to throw.
    expect(getTaskById(urgent.id)!.due_at).toBe(daysAgo(10))
    expect(getTaskById(urgent.id)!.deadline_nag_off).toBe(false)
  })
})

describe('Process: inbox', () => {
  useProcessClock()
  test('PC-016: open one-off tasks in the Inbox, oldest first; not other projects or reminders', () => {
    getDb()
      .prepare(
        "INSERT INTO projects (id, name, owner_id, shared, sort_order) VALUES (2, 'Home', ?, 0, 1)",
      )
      .run(TEST_USER_ID)
    const first = make({ project_id: 1 })
    const second = make({ project_id: 1 })
    make({ project_id: 2 })
    make({ project_id: 1, is_reminder: true, rrule: 'FREQ=DAILY' })
    const data = getProcessData(TEST_USER_ID, tz)
    expect(data.inbox_project_id).toBe(1)
    expect(data.inbox.map((t) => t.id)).toEqual([first.id, second.id])
  })
})
