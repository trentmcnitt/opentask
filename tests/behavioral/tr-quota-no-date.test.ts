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

    // With no rule at all there is nothing to compute from either.
    const ruleless = makeQuota({ title: 'Read', rrule: null })
    expect(getTaskById(ruleless.id)!.due_at).toBeNull()
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
    expect(effectiveDueAt(retired, TEST_TIMEZONE, NOW)).toBeNull()
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
    expect(countTasks([stored], TEST_TIMEZONE, NOW)).toEqual({ total: 1, overdue: 0, today: 0 })
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
    // What QuotaDetail.buildChanges sends whenever the target or period is
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
    expect(before.snooze_count).toBe(0)

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
    expect(after.snooze_count).toBe(0)
    expect(after.original_due_at).toBe(before.original_due_at)
    expect(description).not.toMatch(/snooz/i)
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

  /**
   * Finding 3. The iOS Track widget's pace tick read `due_at`; with the date
   * gone it needs the real anchor, which was exposed nowhere.
   */
  test('TR-026: a quota carries its period anchor in the task shape', () => {
    const quota = makeQuota()
    const stored = getTaskById(quota.id)!
    // Null until the rollover job first anchors it — but present, and typed.
    expect(stored).toHaveProperty('progress_period_start')
    expect(stored.progress_period_start).toBeNull()

    getDb()
      .prepare('UPDATE tasks SET progress_period_start = ? WHERE id = ?')
      .run('2026-01-12T06:00:00.000Z', quota.id)
    expect(getTaskById(quota.id)!.progress_period_start).toBe('2026-01-12T06:00:00.000Z')
  })
})
