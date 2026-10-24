/**
 * TR-010..019: a quota is not a task (REDESIGN-V03 §5, Trent 2026-09-08).
 *
 * It appears on the Quotas page and in the Track panel and nowhere else, it has
 * no due date, and it cannot be snoozed. `due_at` on a quota was vestigial —
 * the period is carried by `progress_period_start` — but it was still a real
 * date, so a quota read as overdue debt in every count and offered a snooze
 * grid it could not honour.
 *
 * The sibling to compare against is the reminder carve-out (§6), which these
 * rules are deliberately shaped like.
 */
import { CALENDAR_DAY_START } from '@/lib/opentask-day'
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTask, getTaskById, updateTask, snoozeTask, bulkEdit } from '@/core/tasks'
import { executeUndo, executeRedo } from '@/core/undo'
import { buildFromDb } from '@/core/ai/quick-take'
import { clearQuotaDueDates, getDb } from '@/core/db'
import { ValidationError } from '@/core/errors'
import { QUOTA_DUE_DATE_MESSAGE } from '@/core/validation'
import { effectiveDueAt } from '@/core/recurrence/occurrence'
import { isTracked } from '@/lib/track'
import { countTasks } from '@/lib/task-counts'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

/** Frozen so "tomorrow" and "this week" mean the same thing on every run. */
const NOW = new Date('2026-01-15T16:00:00Z')

function makeQuota(overrides: Record<string, unknown> = {}) {
  return createTask({
    userId: TEST_USER_ID,
    userTimezone: TEST_TIMEZONE,
    input: { title: 'Eat beef', rrule: 'FREQ=WEEKLY', progress_target: 4, ...overrides },
  })
}

describe('A quota has no due date', () => {
  beforeEach(() => {
    vi.setSystemTime(NOW)
    setupTestDb()
  })
  afterEach(() => {
    vi.useRealTimers()
    teardownTestDb()
  })

  test('TR-010: creating a quota never stamps a due date', () => {
    const byTarget = makeQuota()
    expect(getTaskById(byTarget.id)!.due_at).toBeNull()
    expect(getTaskById(byTarget.id)!.original_due_at).toBeNull()

    // The other way of being a quota: an explicit flag with a target of 1.
    const byFlag = makeQuota({
      title: 'Date night',
      rrule: 'FREQ=MONTHLY',
      progress_target: 1,
      is_tracked: true,
    })
    expect(getTaskById(byFlag.id)!.due_at).toBeNull()

    // A quota with no rule at all is refused outright now (QUOTA_PERIOD_MESSAGE,
    // pinned in qp-matrix.test.ts), so there is no ruleless case left to date.
    expect(() => makeQuota({ title: 'Read', rrule: null })).toThrow(ValidationError)
  })

  test('TR-011: an ordinary recurring task still gets its first occurrence', () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Water the plants', rrule: 'FREQ=WEEKLY;BYDAY=MO' },
    })
    // The guard is narrow: only tracked rows lose the computed date.
    expect(getTaskById(task.id)!.due_at).not.toBeNull()
  })

  test('TR-012: a due date cannot be given to a quota, at create or at update', () => {
    expect(() => makeQuota({ due_at: NOW.toISOString() })).toThrow(ValidationError)
    expect(() => makeQuota({ due_at: NOW.toISOString() })).toThrow(QUOTA_DUE_DATE_MESSAGE)

    const quota = makeQuota()
    expect(() =>
      updateTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        taskId: quota.id,
        input: { due_at: NOW.toISOString() },
      }),
    ).toThrow(QUOTA_DUE_DATE_MESSAGE)

    // Converting a task into a quota in the same request that dates it is the
    // same contradiction, and is refused the same way.
    const plain = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Call mom' },
    })
    expect(() =>
      updateTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        taskId: plain.id,
        input: { is_tracked: true, due_at: NOW.toISOString() },
      }),
    ).toThrow(QUOTA_DUE_DATE_MESSAGE)
  })

  test('TR-013: converting a dated task into a quota clears its date', () => {
    const plain = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Go for a walk', due_at: NOW.toISOString() },
    })
    expect(getTaskById(plain.id)!.due_at).not.toBeNull()

    updateTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: plain.id,
      input: { is_tracked: true, progress_target: 3, rrule: 'FREQ=WEEKLY' },
    })

    const after = getTaskById(plain.id)!
    expect(isTracked(after)).toBe(true)
    expect(after.due_at).toBeNull()
    // `original_due_at` goes too, or `is_snoozed` stays true on a row that
    // cannot be snoozed.
    expect(after.original_due_at).toBeNull()
  })

  test('TR-014: a quota cannot be snoozed', () => {
    const quota = makeQuota()
    expect(() =>
      snoozeTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        taskId: quota.id,
        until: new Date(NOW.getTime() + 3_600_000).toISOString(),
      }),
    ).toThrow(ValidationError)
  })

  test('TR-015: retiring a quota takes its period rule with it', () => {
    const quota = makeQuota()
    expect(getTaskById(quota.id)!.rrule).toBe('FREQ=WEEKLY')

    // `is_tracked: false` alone. A bare FREQ left behind on an untracked task
    // with no due_at is evaluated as a schedule, and rrule.js places a bare
    // weekly rule on an arbitrary weekday — the task would surface on a day
    // nobody chose.
    updateTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: quota.id,
      input: { is_tracked: false, progress_target: 1 },
    })

    const retired = getTaskById(quota.id)!
    expect(isTracked(retired)).toBe(false)
    expect(retired.rrule).toBeNull()
    expect(retired.anchor_time).toBeNull()
    expect(retired.anchor_dow).toBeNull()
    expect(effectiveDueAt(retired, TEST_TIMEZONE, CALENDAR_DAY_START, NOW)).toBeNull()
  })

  test('TR-016: retiring a quota and dating it in one request keeps the date', () => {
    const quota = makeQuota()
    const when = new Date(NOW.getTime() + 86_400_000).toISOString()

    // Retiring injects `rrule: null`, which makes this look to the collector
    // like a schedule change — the path that otherwise drops an explicit date.
    updateTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: quota.id,
      input: { is_tracked: false, progress_target: 1, due_at: when },
    })

    const after = getTaskById(quota.id)!
    expect(isTracked(after)).toBe(false)
    expect(after.rrule).toBeNull()
    expect(after.due_at).toBe(when)
  })

  test('TR-017: bulk edit retires a quota the same way', () => {
    const one = makeQuota({ title: 'Quota one' })
    const two = makeQuota({ title: 'Quota two' })

    bulkEdit({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskIds: [one.id, two.id],
      changes: { is_tracked: false, progress_target: 1 },
    })

    for (const id of [one.id, two.id]) {
      const after = getTaskById(id)!
      expect(isTracked(after)).toBe(false)
      expect(after.rrule).toBeNull()
    }
  })

  test('TR-018: the startup migration clears stored quota dates, idempotently', () => {
    const quota = makeQuota()
    // Write a date straight past the core, the way the pre-2026-09-08 corpus
    // holds one: every quota carried a leftover from the life it had before.
    getDb()
      .prepare('UPDATE tasks SET due_at = ?, original_due_at = ? WHERE id = ?')
      .run(NOW.toISOString(), NOW.toISOString(), quota.id)
    const plain = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Untracked', due_at: NOW.toISOString() },
    })

    clearQuotaDueDates(getDb())
    expect(getTaskById(quota.id)!.due_at).toBeNull()
    expect(getTaskById(quota.id)!.original_due_at).toBeNull()
    // It touches quotas only.
    expect(getTaskById(plain.id)!.due_at).toBe(NOW.toISOString())

    // Second run changes nothing.
    clearQuotaDueDates(getDb())
    expect(getTaskById(quota.id)!.due_at).toBeNull()
    expect(getTaskById(plain.id)!.due_at).toBe(NOW.toISOString())
  })

  test('TR-019: with no date, a quota cannot reach the counts at all', () => {
    const quota = makeQuota()
    const stored = getTaskById(quota.id)!
    // Two independent reasons now: no due_at, and the explicit tracked guard.
    expect(countTasks([stored], TEST_TIMEZONE, CALENDAR_DAY_START, NOW)).toEqual({
      total: 1,
      overdue: 0,
      today: 0,
    })
  })
})

/**
 * Review finding 1, 2026-09-08 (HIGH). `is_tracked` was missing from undo's
 * column allowlist. Its own block because undo has its own failure mode: the
 * allowlist THROWS rather than skipping, and the throw takes the whole
 * transaction with it.
 */
describe('Undo and redo of a quota flag', () => {
  beforeEach(() => {
    vi.setSystemTime(NOW)
    setupTestDb()
  })
  afterEach(() => {
    vi.useRealTimers()
    teardownTestDb()
  })

  /**
   * `undoEntry` runs inside the caller's transaction, so the throw rolled back
   * the `undone = 1` write too: the entry stayed unconsumed and every later
   * Undo found it again — one retire wedged the whole stack.
   *
   * Every quota in the tests above was created with `progress_target` alone, so
   * `is_tracked` never entered `fieldsChanged` and none of them reached this.
   */
  test('TR-020: retiring a quota with an explicit flag can be undone and redone', () => {
    const quota = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      // The flag EXPLICITLY, so retiring it puts `is_tracked` in fieldsChanged.
      input: { title: 'Date night', rrule: 'FREQ=MONTHLY', is_tracked: true },
    })

    updateTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: quota.id,
      input: { is_tracked: false },
    })
    expect(getTaskById(quota.id)!.is_tracked).toBe(false)
    expect(getTaskById(quota.id)!.rrule).toBeNull()

    expect(() => executeUndo(TEST_USER_ID)).not.toThrow()
    const undone = getTaskById(quota.id)!
    expect(undone.is_tracked).toBe(true)
    // The rule rides in the same fieldsChanged, so a throw on `is_tracked`
    // took the rrule's restoration down with it.
    expect(undone.rrule).toBe('FREQ=MONTHLY')

    expect(() => executeRedo(TEST_USER_ID)).not.toThrow()
    const redone = getTaskById(quota.id)!
    expect(redone.is_tracked).toBe(false)
    expect(redone.rrule).toBeNull()
  })

  test('TR-021: the editor path (0 → 1) undoes, and the stack is not wedged', () => {
    // What QuotaDetail's quotaChangesFor sends whenever the target or period is
    // touched: `is_tracked: true` on a row whose column is still 0.
    const quota = makeQuota({ title: 'Eggs' })
    expect(getTaskById(quota.id)!.is_tracked).toBe(false)

    updateTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: quota.id,
      input: { is_tracked: true, progress_target: 5 },
    })
    expect(getTaskById(quota.id)!.is_tracked).toBe(true)

    // A second, unrelated action on top, so the failing entry is not the only
    // one on the stack — this is what "wedges" means: the throw leaves the
    // entry at undone = 0 and every later Undo lands on it again.
    updateTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: quota.id,
      input: { title: 'Eggs for the kids' },
    })

    expect(() => executeUndo(TEST_USER_ID)).not.toThrow()
    expect(getTaskById(quota.id)!.title).toBe('Eggs')
    expect(() => executeUndo(TEST_USER_ID)).not.toThrow()
    const after = getTaskById(quota.id)!
    expect(after.is_tracked).toBe(false)
    expect(after.progress_target).toBe(4)
  })
})

/**
 * Review findings 2, 3, 4 and 6, 2026-09-08 — each a path the first cut of "a
 * quota is not a task" missed, found by a fresh-eyes pass over that change.
 */
describe('A quota is not a task — the other paths the first cut missed', () => {
  beforeEach(() => {
    vi.setSystemTime(NOW)
    setupTestDb()
  })
  afterEach(() => {
    vi.useRealTimers()
    teardownTestDb()
  })

  /**
   * Finding 4. Widening the rrule-changed guard to "any explicit date" fixed a
   * dropped date but let `{ rrule: null, due_at: X }` — the quick panel's
   * "clear recurrence and pick a date" — fall into the snooze branch. A
   * re-schedule is not a deferral.
   */
  test('TR-022: clearing recurrence while setting a date is not a snooze', () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      // Must already HAVE a date: the snooze branch only fires when it does.
      input: { title: 'Weekly report', rrule: 'FREQ=WEEKLY;BYDAY=MO' },
    })
    const before = getTaskById(task.id)!
    expect(before.due_at).not.toBeNull()

    const when = new Date(NOW.getTime() + 86_400_000).toISOString()
    const { description } = updateTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
      input: { rrule: null, due_at: when },
    })

    const after = getTaskById(task.id)!
    expect(after.rrule).toBeNull()
    expect(after.due_at).toBe(when)
    // The first-target date went with the old schedule: a re-schedule starts
    // the target-age clock over rather than inheriting the old occurrence.
    expect(after.original_due_at).toBeNull()
    expect(description).not.toMatch(/defer/i)
  })

  /**
   * Finding 6. A date-bearing bulk edit hit `collectFieldChanges`' refusal on a
   * quota, and one throw aborts the whole transaction — the reviewer's probe
   * lost a sibling task's priority edit. Skip the quota, keep the batch.
   */
  test('TR-023: a bulk edit carrying a date skips quotas instead of losing the batch', () => {
    const quota = makeQuota({ title: 'Quota in the selection' })
    const plain = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Plain sibling', due_at: NOW.toISOString() },
    })
    const when = new Date(NOW.getTime() + 86_400_000).toISOString()

    // `{ due_at, rrule }` together — the shape the snooze filter never saw,
    // because it only runs when rrule is absent.
    const result = bulkEdit({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskIds: [quota.id, plain.id],
      changes: { due_at: when, rrule: null, priority: 2 },
    })

    expect(result.tasksAffected).toBe(1)
    expect(result.tasksSkipped).toBe(1)
    // The sibling's edit survived...
    const plainAfter = getTaskById(plain.id)!
    expect(plainAfter.due_at).toBe(when)
    expect(plainAfter.priority).toBe(2)
    // ...and the quota is untouched, still dateless.
    const quotaAfter = getTaskById(quota.id)!
    expect(quotaAfter.due_at).toBeNull()
    expect(quotaAfter.priority).toBe(0)
  })

  test('TR-024: a per-task date does not lose the batch either', () => {
    const quota = makeQuota({ title: 'Quota with a per-task date' })
    const plain = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Plain sibling' },
    })
    const when = new Date(NOW.getTime() + 86_400_000).toISOString()

    // Only reachable from core: `bulkEditSchema.per_task` is `.strict()` on
    // `{ rrule }`, so the route rejects a per-task `due_at` before it gets
    // here. Pinned anyway — the guard is in core, and the schema could widen.
    const result = bulkEdit({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskIds: [quota.id, plain.id],
      changes: { priority: 3 },
      perTask: { [String(quota.id)]: { due_at: when } as { due_at: string } },
    })

    expect(result.tasksAffected).toBe(1)
    expect(result.tasksSkipped).toBe(1)
    expect(getTaskById(plain.id)!.priority).toBe(3)
    expect(getTaskById(quota.id)!.due_at).toBeNull()
  })

  /**
   * Finding 2. Quick Take read the whole open corpus. With quotas now undated
   * every one of them landed in the `undated` stat and was named in the
   * compact list as a task to do.
   */
  test('TR-025: Quick Take is not shown quotas or reminders', () => {
    const plain = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'A real undated task' },
    })
    makeQuota({ title: 'Eat beef' })
    createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'A reminder', is_reminder: true },
    })

    const built = buildFromDb(TEST_USER_ID, TEST_TIMEZONE)

    expect(built.count).toBe(1)
    expect(built.tasks.map((t) => t.title)).toEqual([plain.title])
    expect(built.text).not.toContain('Eat beef')
    expect(built.text).not.toContain('A reminder')
    // The stat the leak inflated: one undated task, not three.
    expect(built.stats.undated).toBe(1)
  })
})

/**
 * Second review, 2026-09-08 — the two findings that are regressions from the
 * FIRST round of fixes, not from the original change. Hoisting "clear the
 * occurrence origin when the rrule changes" out of its branch was too wide.
 */
describe('The occurrence origin survives what it should', () => {
  beforeEach(() => {
    vi.setSystemTime(NOW)
    setupTestDb()
  })
  afterEach(() => {
    vi.useRealTimers()
    teardownTestDb()
  })

  /**
   * Finding 5 — a regression from the previous commit. Hoisting
   * "clear the occurrence origin when the rrule changes" out of the
   * new-schedule branch applied it to EVERY rrule change, including clearing
   * the rule on a genuinely snoozed task.
   */
  test('TR-027: dropping the rule alone leaves a moved task its first-target date', () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Weekly report', rrule: 'FREQ=WEEKLY;BYDAY=MO' },
    })
    // Moved twice. Since 2026-10-12 (§6) a move keeps the first-target date,
    // which for a task created recurring is its first occurrence.
    for (const days of [1, 2]) {
      snoozeTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        taskId: task.id,
        until: new Date(NOW.getTime() + days * 86_400_000).toISOString(),
      })
    }
    const before = getTaskById(task.id)!
    expect(before.original_due_at).toBe(task.due_at)
    expect(before.due_at).not.toBe(task.due_at)

    // The rule alone. Nothing here says anything about the date.
    updateTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
      input: { rrule: null },
    })

    const after = getTaskById(task.id)!
    expect(after.rrule).toBeNull()
    // The moves survive: the target-age clock stays on the first target
    // instead of jumping back to created_at.
    expect(after.original_due_at).toBe(before.original_due_at)
    expect(after.due_at).toBe(before.due_at)
  })

  test('TR-028: a new rule drops the origin of an occurrence on its schedule; a moved one keeps it (PR 4a)', () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Weekly report', rrule: 'FREQ=WEEKLY;BYDAY=MO' },
    })
    snoozeTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
      until: new Date(NOW.getTime() + 86_400_000).toISOString(),
    })
    expect(getTaskById(task.id)!.original_due_at).not.toBeNull()

    const moved = getTaskById(task.id)!

    // PR 4a (2026-10-22): a target moved this occurrence is kept across the
    // new rule, and its origin with it — still the same occurrence.
    updateTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
      input: { rrule: 'FREQ=DAILY' },
    })
    expect(getTaskById(task.id)!.original_due_at).toBe(moved.original_due_at)

    // An occurrence on its schedule takes the NEW schedule's date: the old
    // origin means nothing under it. This is the behaviour that predates the
    // whole PR and must not be lost.
    const onSchedule = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Weekly review', rrule: 'FREQ=WEEKLY;BYDAY=MO' },
    })
    getDb().prepare('UPDATE tasks SET original_due_at = due_at WHERE id = ?').run(onSchedule.id)
    expect(getTaskById(onSchedule.id)!.original_due_at).not.toBeNull()
    updateTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: onSchedule.id,
      input: { rrule: 'FREQ=DAILY' },
    })
    expect(getTaskById(onSchedule.id)!.original_due_at).toBeNull()
  })

  /**
   * Finding 4 — originally "an explicit origin reset beats the rrule change in
   * the same PATCH". Since 2026-10-12 (§6, ruling Q4) `reset_original_due_at`
   * is accepted and IGNORED on an ordinary task (a move is a move), so the
   * rule change alone decides the origin: clearing the rule (no date sent)
   * keeps it, a new rule drops it. (A reminder's reset still wins — SN-121.)
   */
  test('TR-029: reset_original_due_at is ignored on a task; the rrule change rules the origin', () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Weekly report', rrule: 'FREQ=WEEKLY;BYDAY=MO' },
    })
    snoozeTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
      until: new Date(NOW.getTime() + 86_400_000).toISOString(),
    })
    const moved = getTaskById(task.id)!

    updateTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
      input: { reset_original_due_at: true, rrule: null },
    })

    const after = getTaskById(task.id)!
    // Not reset to the current target: the first-target date is kept.
    expect(after.original_due_at).toBe(task.due_at)
    expect(after.original_due_at).not.toBe(moved.due_at)
    expect(after.due_at).toBe(moved.due_at)

    // A NEW rule on a MOVED target keeps the origin (PR 4a) — the reset flag
    // changes nothing either way.
    const other = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Another', rrule: 'FREQ=WEEKLY;BYDAY=MO' },
    })
    snoozeTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: other.id,
      until: new Date(NOW.getTime() + 86_400_000).toISOString(),
    })
    updateTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: other.id,
      input: { reset_original_due_at: true, rrule: 'FREQ=DAILY' },
    })
    expect(getTaskById(other.id)!.original_due_at).toBe(other.due_at)
  })

  /**
   * Round-one finding 3. The iOS Track widget's pace tick read `due_at`; with
   * the date gone it needs the real anchor, which was exposed nowhere.
   */
  test('TR-026: a quota carries its period anchor in the task shape', () => {
    const quota = makeQuota()
    const stored = getTaskById(quota.id)!
    // Stamped as it is made (2026-10-16): the start of the week it is in.
    expect(stored).toHaveProperty('progress_period_start')
    expect(stored.progress_period_start).not.toBeNull()

    getDb()
      .prepare('UPDATE tasks SET progress_period_start = ? WHERE id = ?')
      .run('2026-01-12T06:00:00.000Z', quota.id)
    expect(getTaskById(quota.id)!.progress_period_start).toBe('2026-01-12T06:00:00.000Z')
  })
})
