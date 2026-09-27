/**
 * Quick-panel save routing and ONE SAVE, ONE UNDO (WP3, Trent 2026-09-27).
 *
 * A multi-select save that changes a task's date AND its priority (or any
 * other field) used to fire bulk/snooze and bulk/edit in parallel — two undo
 * entries in a racy order. It is now one request (`planQuickPanelSave`) that
 * the server applies in one transaction with one undo entry (`bulkEdit`,
 * with the date rules bulk/snooze had applied per task).
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { getDb } from '@/core/db'
import { createTask, getTaskById } from '@/core/tasks'
import { bulkEdit } from '@/core/tasks/bulk'
import { updateTask } from '@/core/tasks/update'
import { executeUndo } from '@/core/undo'
import { planQuickPanelSave, saveQuickPanelChanges } from '@/lib/save-quick-panel-changes'
import { isPickedReschedule } from '@/lib/picked-reschedule'
import {
  setupTestDb,
  teardownTestDb,
  localTime,
  TEST_USER_ID,
  TEST_TIMEZONE,
} from '../helpers/setup'

const TARGET = '2026-01-16T15:00:00.000Z'

describe('planQuickPanelSave — request routing', () => {
  test('one id → one PATCH carrying every field', () => {
    const plan = planQuickPanelSave([5], { due_at: TARGET, priority: 3 })
    expect(plan).toEqual({ kind: 'patch', taskId: 5, body: { due_at: TARGET, priority: 3 } })
  })

  test('one id drops bulk-only fields (delta, additive labels)', () => {
    const plan = planQuickPanelSave([5], {
      delta_minutes: 60,
      labels_add: ['a'],
      labels_remove: ['b'],
      priority: 1,
    })
    expect(plan).toEqual({ kind: 'patch', taskId: 5, body: { priority: 1 } })
    expect(planQuickPanelSave([5], { delta_minutes: 60 })).toBeNull()
  })

  test('several ids, date only → bulk/snooze with include_task_ids', () => {
    expect(planQuickPanelSave([1, 2], { due_at: TARGET })).toEqual({
      kind: 'bulk',
      url: '/api/tasks/bulk/snooze',
      body: { ids: [1, 2], until: TARGET, include_task_ids: [1, 2] },
    })
    expect(planQuickPanelSave([1, 2], { delta_minutes: 60 })).toEqual({
      kind: 'bulk',
      url: '/api/tasks/bulk/snooze',
      body: { ids: [1, 2], delta_minutes: 60, include_task_ids: [1, 2] },
    })
  })

  test('several ids, date + priority → ONE bulk/edit carrying both', () => {
    expect(planQuickPanelSave([1, 2], { due_at: TARGET, priority: 4 })).toEqual({
      kind: 'bulk',
      url: '/api/tasks/bulk/edit',
      body: { ids: [1, 2], changes: { priority: 4, due_at: TARGET }, include_task_ids: [1, 2] },
    })
    expect(planQuickPanelSave([1, 2], { delta_minutes: 60, labels_add: ['x'] })).toEqual({
      kind: 'bulk',
      url: '/api/tasks/bulk/edit',
      body: {
        ids: [1, 2],
        changes: { labels_add: ['x'] },
        delta_minutes: 60,
        include_task_ids: [1, 2],
      },
    })
  })

  test('a date scoped to a subset rides the same request as date_task_ids', () => {
    expect(planQuickPanelSave([1, 2, 3], { due_at: TARGET, priority: 2 }, [1, 3])).toEqual({
      kind: 'bulk',
      url: '/api/tasks/bulk/edit',
      body: {
        ids: [1, 2, 3],
        changes: { priority: 2, due_at: TARGET },
        include_task_ids: [1, 3],
        date_task_ids: [1, 3],
      },
    })
  })

  test('date only on a one-task subset → bulk/snooze, not a PATCH that drops the delta', () => {
    expect(planQuickPanelSave([1, 2], { delta_minutes: 60 }, [2])).toEqual({
      kind: 'bulk',
      url: '/api/tasks/bulk/snooze',
      body: { ids: [2], delta_minutes: 60, include_task_ids: [2] },
    })
  })

  test('every task opted out of the date → only the other fields are sent', () => {
    expect(planQuickPanelSave([1, 2], { due_at: TARGET, priority: 2 }, [])).toEqual({
      kind: 'bulk',
      url: '/api/tasks/bulk/edit',
      body: { ids: [1, 2], changes: { priority: 2 } },
    })
    expect(planQuickPanelSave([1, 2], { due_at: TARGET }, [])).toBeNull()
  })

  test('a date clear on several goes to bulk/edit with include_task_ids', () => {
    expect(planQuickPanelSave([1, 2], { due_at: null, rrule: null })).toEqual({
      kind: 'bulk',
      url: '/api/tasks/bulk/edit',
      body: { ids: [1, 2], changes: { rrule: null, due_at: null }, include_task_ids: [1, 2] },
    })
  })

  test('nothing to change → no request; no ids → throws', () => {
    expect(planQuickPanelSave([1, 2], { labels_add: [], labels_remove: [] })).toBeNull()
    expect(() => planQuickPanelSave([], { priority: 1 })).toThrow()
  })
})

describe('isPickedReschedule — picker vs +1h', () => {
  test('a picked date on one task is a reschedule', () => {
    expect(isPickedReschedule(true, false, false, TARGET)).toBe(true)
  })

  test('+1h and presets (not picked), bulk, create and clears are not', () => {
    expect(isPickedReschedule(false, false, false, TARGET)).toBe(false)
    expect(isPickedReschedule(true, true, false, TARGET)).toBe(false)
    expect(isPickedReschedule(true, false, true, TARGET)).toBe(false)
    expect(isPickedReschedule(true, false, false, null)).toBe(false)
    expect(isPickedReschedule(true, false, false, undefined)).toBe(false)
  })

  test('the picker flag reaches the single PATCH body', () => {
    const plan = planQuickPanelSave([5], { due_at: TARGET, reset_original_due_at: true })
    expect(plan).toMatchObject({ kind: 'patch', body: { reset_original_due_at: true } })
  })
})

describe('saveQuickPanelChanges — one fetch per save', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('date + priority on several tasks is exactly one request', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: { tasks_affected: 2, skipped_no_due_date: 1 } }), {
          status: 200,
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const result = await saveQuickPanelChanges([1, 2], { delta_minutes: 60, priority: 3 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/tasks/bulk/edit')
    expect(JSON.parse(init.body as string)).toMatchObject({ delta_minutes: 60 })
    expect(result).toEqual({ tasksAffected: 2, skippedNoDueDate: 1 })
  })

  test('a refused save throws with the server reason and applies nothing else', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ error: 'Invalid task IDs: 2' }), { status: 400 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await expect(saveQuickPanelChanges([1, 2], { due_at: TARGET, priority: 3 })).rejects.toThrow(
      'Invalid task IDs: 2',
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

const base = { userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE }
const make = (title: string, input: Record<string, unknown> = {}) =>
  createTask({ ...base, input: { title, due_at: localTime(8, 0), ...input } }).id

const undoRows = () =>
  getDb()
    .prepare('SELECT action FROM undo_log WHERE user_id = ? AND undone = 0 ORDER BY id')
    .all(TEST_USER_ID) as { action: string }[]

const clearUndoLog = () => getDb().prepare('DELETE FROM undo_log').run()

/** Frozen clock (Jan 15, 2026 at 10am Chicago) and a fresh DB per test. */
function useFreshDb() {
  beforeEach(() => {
    // Jan 15, 2026 at 10am Chicago (16:00 UTC)
    vi.setSystemTime(new Date('2026-01-15T16:00:00Z'))
    setupTestDb()
  })

  afterEach(() => {
    vi.useRealTimers()
    teardownTestDb()
  })
}

describe('bulkEdit — a combined date + priority save is one undo entry', () => {
  useFreshDb()

  test('several tasks: one bulk_edit row, one undo restores date AND priority', () => {
    const a = make('[M] Alpha', { priority: 1 })
    const b = make('[M] Beta', { priority: 2 })
    const before = [getTaskById(a)!, getTaskById(b)!]
    clearUndoLog()

    const result = bulkEdit({
      ...base,
      taskIds: [a, b],
      changes: { due_at: TARGET, priority: 4 },
      includeTaskIds: [a, b],
    })
    expect(result.tasksAffected).toBe(2)
    expect(undoRows()).toEqual([{ action: 'bulk_edit' }])

    for (const id of [a, b]) {
      const t = getTaskById(id)!
      expect(t.due_at).toBe(TARGET)
      expect(t.priority).toBe(4)
      // Snooze bookkeeping, as bulk/snooze did it
      expect(t.snooze_count).toBe(1)
      expect(t.original_due_at).toBe(before.find((x) => x.id === id)!.due_at)
    }

    executeUndo(TEST_USER_ID)
    for (const orig of before) {
      const t = getTaskById(orig.id)!
      expect(t.due_at).toBe(orig.due_at)
      expect(t.priority).toBe(orig.priority)
      expect(t.snooze_count).toBe(orig.snooze_count)
      expect(t.original_due_at).toBe(orig.original_due_at)
    }
  })

  test('one task: the PATCH path is one edit row, one undo restores both', () => {
    const a = make('[M] Solo', { priority: 0 })
    const orig = getTaskById(a)!
    clearUndoLog()

    updateTask({ ...base, taskId: a, input: { due_at: TARGET, priority: 3 } })
    expect(undoRows()).toHaveLength(1)
    expect(getTaskById(a)).toMatchObject({ due_at: TARGET, priority: 3 })

    executeUndo(TEST_USER_ID)
    expect(getTaskById(a)).toMatchObject({ due_at: orig.due_at, priority: 0 })
  })

  test('a date + reset_original_due_at is a reschedule: the new date is the origin', () => {
    const a = make('[M] Snoozed before', { priority: 0 })
    const b = make('[M] Also', { priority: 0 })
    // Give both a snooze history first.
    bulkEdit({ ...base, taskIds: [a, b], changes: { due_at: localTime(9, 0) } })
    expect(getTaskById(a)!.snooze_count).toBe(1)
    clearUndoLog()

    bulkEdit({
      ...base,
      taskIds: [a, b],
      changes: { due_at: TARGET, reset_original_due_at: true, priority: 1 },
      includeTaskIds: [a, b],
    })
    for (const id of [a, b]) {
      expect(getTaskById(id)).toMatchObject({
        due_at: TARGET,
        original_due_at: TARGET,
        snooze_count: 0,
        priority: 1,
      })
    }
    expect(undoRows()).toHaveLength(1)
  })
})

describe('bulkEdit — the date rules bulk/snooze had, applied per task', () => {
  useFreshDb()

  test('include_task_ids keeps an explicitly picked Urgent task in the date change', () => {
    const low = make('[M] Low', { priority: 1 })
    const urgent = make('[M] Urgent', { priority: 4 })
    bulkEdit({ ...base, taskIds: [low, urgent], changes: { due_at: TARGET, labels_add: ['x'] } })
    // Without the rescue the sweep filter holds the Urgent task's date back…
    expect(getTaskById(urgent)!.due_at).not.toBe(TARGET)
    // …but it still takes the rest of the edit.
    expect(getTaskById(urgent)!.labels).toContain('x')

    bulkEdit({
      ...base,
      taskIds: [low, urgent],
      changes: { due_at: TARGET },
      includeTaskIds: [low, urgent],
    })
    expect(getTaskById(urgent)!.due_at).toBe(TARGET)
  })

  test('delta_minutes moves each task from its own date; an undated task keeps the rest', () => {
    const a = make('[M] Eight', { priority: 0 })
    const b = make('[M] Nine', { priority: 0, due_at: localTime(9, 0) })
    const undated = createTask({ ...base, input: { title: '[M] Undated' } }).id
    const dueA = getTaskById(a)!.due_at!
    const dueB = getTaskById(b)!.due_at!
    clearUndoLog()

    const result = bulkEdit({
      ...base,
      taskIds: [a, b, undated],
      changes: { priority: 2 },
      deltaMinutes: 60,
      includeTaskIds: [a, b, undated],
    })
    expect(result).toMatchObject({ tasksAffected: 3, noDueDateSkipped: 1 })
    const plusHour = (iso: string) => new Date(new Date(iso).getTime() + 3_600_000).toISOString()
    expect(getTaskById(a)).toMatchObject({ due_at: plusHour(dueA), priority: 2 })
    expect(getTaskById(b)).toMatchObject({ due_at: plusHour(dueB), priority: 2 })
    expect(getTaskById(undated)).toMatchObject({ due_at: null, priority: 2 })
    expect(undoRows()).toHaveLength(1)

    executeUndo(TEST_USER_ID)
    expect(getTaskById(a)).toMatchObject({ due_at: dueA, priority: 0 })
    expect(getTaskById(undated)).toMatchObject({ priority: 0 })
  })

  test('date_task_ids scopes the date; the other fields still reach every task', () => {
    const a = make('[M] In', { priority: 0 })
    const b = make('[M] Out', { priority: 0 })
    const dueB = getTaskById(b)!.due_at
    clearUndoLog()

    bulkEdit({
      ...base,
      taskIds: [a, b],
      changes: { due_at: TARGET, priority: 3 },
      includeTaskIds: [a],
      dateTaskIds: [a],
    })
    expect(getTaskById(a)).toMatchObject({ due_at: TARGET, priority: 3 })
    expect(getTaskById(b)).toMatchObject({ due_at: dueB, priority: 3, snooze_count: 0 })
    expect(undoRows()).toHaveLength(1)
  })

  test('a quota in a dated batch is left untouched, the rest still lands (TR-023)', () => {
    const task = make('[M] Plain', { priority: 0 })
    const quota = createTask({
      ...base,
      input: { title: '[M] Quota', rrule: 'FREQ=WEEKLY', progress_target: 3, is_tracked: true },
    }).id
    const result = bulkEdit({
      ...base,
      taskIds: [task, quota],
      changes: { due_at: TARGET, priority: 2 },
      includeTaskIds: [task, quota],
    })
    expect(result).toMatchObject({ tasksAffected: 1, tasksSkipped: 1 })
    expect(getTaskById(task)).toMatchObject({ due_at: TARGET, priority: 2 })
    expect(getTaskById(quota)).toMatchObject({ due_at: null, priority: 0 })
  })

  test('a date-only edit still leaves a filtered task untouched (unchanged behavior)', () => {
    const low = make('[M] Low', { priority: 0 })
    const urgent = make('[M] Urgent', { priority: 4 })
    const before = getTaskById(urgent)!
    const result = bulkEdit({ ...base, taskIds: [low, urgent], changes: { due_at: TARGET } })
    expect(result).toMatchObject({ tasksAffected: 1, tasksSkipped: 1 })
    expect(getTaskById(urgent)!.updated_at).toBe(before.updated_at)
  })

  test('due_at and delta_minutes together are refused', () => {
    const a = make('[M] A')
    expect(() =>
      bulkEdit({ ...base, taskIds: [a], changes: { due_at: TARGET }, deltaMinutes: 60 }),
    ).toThrow()
  })
})
