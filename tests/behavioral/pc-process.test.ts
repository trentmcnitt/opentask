/**
 * PC: Process (2026-10-10 task model, spec §5) — the rule-based steps behind
 * `GET /api/process` (`src/lib/process-rules.ts`, `src/core/tasks/process.ts`)
 * and the writes Process relies on: `affirm_horizon` ("keep") and the
 * remove-target bulk edit.
 *
 * Clock: Saturday 2026-10-10, 10:00 Chicago (15:00Z). "Old" tasks have their
 * created_at / horizon_set_at rewritten — the growth clock reads those.
 */
import { CALENDAR_DAY_START } from '@/lib/opentask-day'
import { describe, test, expect, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { getDb } from '@/core/db'
import { createTask, updateTask, bulkEdit } from '@/core/tasks'
import { getTaskById } from '@/core/tasks/read'
import { executeUndo } from '@/core/undo'
import { getProcessData } from '@/core/tasks/process'
import { growthAsk } from '@/lib/process-rules'
import { validateBulkEdit } from '@/core/validation'
import { formatTaskResponse } from '@/lib/format-task'
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
  // The age badge's thresholds (spec §7, ruling Q7: one set): days > 7 days,
  // weeks > 1 month (Sep 10 → Oct 10 is 30 days), months > 1 quarter (Jul 10
  // → Oct 10 is 92 days). Exactly at the threshold is not past it.
  test.each([
    ['days', 7, 'weeks'],
    ['weeks', 30, 'months'],
    ['months', 92, 'eventually'],
  ] as const)('PC-001: %s asks the day after %i days, not at it', (horizon, days, to) => {
    const at = onHorizonFor(days, { horizon })
    const after = onHorizonFor(days + 1, { horizon })
    expect(growthOf(at.id)).toBeNull()
    expect(growthOf(after.id)).toMatchObject({ from: horizon, to, days_on_horizon: days + 1 })
  })

  test('PC-002: unset reads as weeks on the clock but is reported as unset', () => {
    const young = onHorizonFor(30)
    const old = onHorizonFor(31)
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

  test('PC-006: a task with a target of its own is never asked about growth (2026-10-12)', () => {
    const overTarget = onHorizonFor(90, { due_at: daysAgo(1) })
    const futureTarget = onHorizonFor(90, {
      due_at: new Date(NOW.getTime() + 3 * DAY).toISOString(),
    })
    expect(growthOf(overTarget.id)).toBeNull()
    // Over target: step 4 owns it. A future target: quiet until its date,
    // its horizon shown nowhere (spec §1), so nothing to grow.
    expect(growthOf(futureTarget.id)).toBeNull()
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
    expect(growthAsk(base, 'Pacific/Auckland', NOW, CALENDAR_DAY_START)?.to).toBe('weeks')
    expect(
      growthAsk({ ...base, horizon_set_at: daysAgo(7.1) }, 'UTC', NOW, CALENDAR_DAY_START)?.to,
    ).toBe('weeks')
    expect(
      growthAsk({ ...base, horizon_set_at: daysAgo(7) }, 'UTC', NOW, CALENDAR_DAY_START),
    ).toBeNull()
  })
})

describe('Process: affirm_horizon ("keep")', () => {
  useProcessClock()
  test('PC-010: stamps growth_kept_at, leaves the horizon and its clock, and undoes', () => {
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
    expect(a.horizon_set_at).toBeNull()
    expect(a.growth_kept_at).toBe(NOW.toISOString())
    expect(b.horizon).toBe('weeks')
    expect(b.horizon_set_at).toBe(daysAgo(90))
    expect(b.growth_kept_at).toBe(NOW.toISOString())
    expect(growthOf(unset.id)).toBeNull()
    expect(growthOf(weeks.id)).toBeNull()

    executeUndo(TEST_USER_ID)
    expect(getTaskById(unset.id)!.growth_kept_at).toBeNull()
    expect(getTaskById(weeks.id)!.growth_kept_at).toBeNull()
    expect(growthOf(weeks.id)).not.toBeNull()
  })

  test('PC-010b: after a keep, it asks again one threshold later; the age badge still counts from creation', () => {
    const t = onHorizonFor(90, { horizon: 'weeks' })
    updateTask({
      userId: TEST_USER_ID,
      userTimezone: tz,
      taskId: t.id,
      input: { affirm_horizon: true },
    })
    expect(growthOf(t.id)).toBeNull()
    // Oct 10 + 1 month = Nov 10: not past it on Nov 10, past it on Nov 11.
    vi.setSystemTime(new Date('2026-11-10T16:00:00Z'))
    expect(growthOf(t.id)).toBeNull()
    vi.setSystemTime(new Date('2026-11-11T16:00:00Z'))
    expect(growthOf(t.id)).toMatchObject({ from: 'weeks', to: 'months' })
    expect(formatTaskResponse(getTaskById(t.id)!, tz).age_label).toBe('>1 mo')
  })

  test('PC-011b: single PATCH too — what "Raise" sends with the new priority', () => {
    const t = onHorizonFor(90, { horizon: 'weeks', priority: 2 })
    updateTask({
      userId: TEST_USER_ID,
      userTimezone: tz,
      taskId: t.id,
      input: { priority: 3, affirm_horizon: true },
    })
    const after = getTaskById(t.id)!
    expect(after.priority).toBe(3)
    expect(after.horizon).toBe('weeks')
    expect(after.growth_kept_at).toBe(NOW.toISOString())
    expect(growthOf(t.id)).toBeNull()
  })

  test('PC-011: the request schema accepts it on PATCH and bulk edit', () => {
    const parsed = validateBulkEdit({ ids: [1], changes: { affirm_horizon: true } })
    expect(parsed.changes.affirm_horizon).toBe(true)
  })
})

describe('Process: stale targets', () => {
  useProcessClock()
  // Tasks written down (and targeted) a month ago: attempts never count from
  // before a task existed, nor before its target was set (spec §7), so a task
  // created "now" with a past target would read as one attempt, today's.
  const makeOld = (input: Record<string, unknown>) => {
    const t = make(input)
    getDb()
      .prepare('UPDATE tasks SET created_at = ?, target_set_at = ? WHERE id = ?')
      .run(daysAgo(30), daysAgo(30), t.id)
    return getTaskById(t.id)!
  }
  test('PC-012: 3 attempts or more (local days over target); 2 is not', () => {
    // Over target since Thu Oct 8: Oct 8, 9, 10 → 3×. Since Oct 9 → 2×.
    const three = makeOld({ due_at: daysAgo(2) })
    const two = makeOld({ due_at: daysAgo(1) })
    const data = getProcessData(TEST_USER_ID, tz)
    expect(data.stale_targets.map((s) => s.task.id)).toEqual([three.id])
    expect(data.stale_targets[0].attempts).toBe(3)
    expect(data.stale_targets.some((s) => s.task.id === two.id)).toBe(false)
  })

  test('PC-013: a task with a deadline is listed apart, never with the rest', () => {
    const plain = makeOld({ due_at: daysAgo(10) })
    const client = makeOld({
      due_at: daysAgo(10),
      deadline_at: new Date(NOW.getTime() + 2 * DAY).toISOString(),
    })
    // Deadline, no target: it gets the deadline's AUTOMATIC target (§8.1,
    // 2026-10-12). Nobody picked it, so it is never a stale pick to question —
    // Process skips `target_auto` tasks on both lists.
    const auto = makeOld({ deadline_at: daysAgo(5) })
    expect(auto.target_auto).toBe(true)
    const data = getProcessData(TEST_USER_ID, tz)
    expect(data.stale_targets.map((s) => s.task.id)).toEqual([plain.id])
    expect(data.stale_targets_with_deadline.map((s) => s.task.id)).toEqual([client.id])
  })

  test('PC-014: a same-day move keeps the attempts (one per local day)', () => {
    const t = makeOld({ due_at: daysAgo(10) })
    updateTask({
      userId: TEST_USER_ID,
      userTimezone: tz,
      taskId: t.id,
      input: { due_at: daysAgo(1) },
    })
    expect(getProcessData(TEST_USER_ID, tz).stale_targets[0]).toMatchObject({
      task: { id: t.id },
      // Sep 30 … Oct 10: 11 local days over target. The move to yesterday
      // keeps it over target and adds nothing today.
      attempts: 11,
    })
    // Moved ahead it leaves Process (not over target) but keeps its count.
    updateTask({
      userId: TEST_USER_ID,
      userTimezone: tz,
      taskId: t.id,
      input: { due_at: new Date(NOW.getTime() + DAY).toISOString() },
    })
    expect(getProcessData(TEST_USER_ID, tz).stale_targets).toEqual([])
    expect(getTaskById(t.id)!.attempts).toBe(11)
  })

  test('PC-015: remove-target bulk edit clears every pick, P4 included, and undoes', () => {
    const low = make({ due_at: daysAgo(10), priority: 0 })
    const urgent = make({ due_at: daysAgo(10), priority: 4 })
    const ids = [low.id, urgent.id]
    // An old client still sends `deadline_nag_off` with it: accepted, ignored.
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
      expect(t.target_auto).toBe(false)
      expect(t).not.toHaveProperty('deadline_nag_off')
    }
    const data = getProcessData(TEST_USER_ID, tz)
    expect(data.stale_targets).toEqual([])

    executeUndo(TEST_USER_ID)
    expect(getTaskById(urgent.id)!.due_at).toBe(daysAgo(10))
    expect(getTaskById(low.id)!.due_at).toBe(daysAgo(10))
  })
})

describe('Process: inbox', () => {
  useProcessClock()
  test('PC-016: open tasks in the Inbox, oldest first, recurring included; not other projects or reminders', () => {
    getDb()
      .prepare(
        "INSERT INTO projects (id, name, owner_id, shared, sort_order) VALUES (2, 'Home', ?, 0, 1)",
      )
      .run(TEST_USER_ID)
    const first = make({ project_id: 1 })
    const second = make({ project_id: 1 })
    make({ project_id: 2 })
    make({ project_id: 1, is_reminder: true, rrule: 'FREQ=DAILY' })
    // A recurring task counts: the dashboard's Inbox group shows it, and
    // Process must agree with that header (visual QA 2026-10-11).
    const recurring = make({ project_id: 1, rrule: 'FREQ=WEEKLY', due_at: daysAgo(1) })
    const data = getProcessData(TEST_USER_ID, tz)
    expect(data.inbox_project_id).toBe(1)
    expect(data.inbox.map((t) => t.id)).toEqual([first.id, second.id, recurring.id])
  })
})
