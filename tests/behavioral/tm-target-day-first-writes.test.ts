/**
 * The target's first time on its OpenTask day, through the WRITE PATHS
 * (`target_day_first_at`, 2026-10-29): a defer, a bulk defer, a repeating
 * done, Remove target and undo, read back as the dashboard reads a task.
 * The pure rules are `tm-target-day-first.test.ts`.
 *
 * Chicago, the task queue on (the 3:00 AM day start); the clock frozen on
 * Mon 2026-11-02 at 10:00 so every target below is ahead.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { DateTime } from 'luxon'
import { createTask, getTaskById, markDone, updateTask } from '@/core/tasks'
import { snoozeTask } from '@/core/tasks/snooze'
import { bulkSnooze } from '@/core/tasks/bulk'
import { executeUndo } from '@/core/undo/execute-undo'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

const u = { userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE }
const iso = (local: string) => DateTime.fromISO(local, { zone: TEST_TIMEZONE }).toUTC().toISO()!
const first = (id: number) => getTaskById(id)!.target_day_first_at
const make = (due: string, extra: Record<string, unknown> = {}) =>
  createTask({ ...u, input: { title: 'TDF', due_at: iso(due), ...extra } }).id
const defer = (taskId: number, until: string) => snoozeTask({ ...u, taskId, until: iso(until) })

describe('target_day_first_at through the writes', () => {
  beforeAll(() => {
    vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
    setupTestDb()
  })
  afterAll(() => {
    vi.unstubAllEnvs()
    teardownTestDb()
  })
  beforeEach(() => {
    vi.setSystemTime(new Date(iso('2026-11-02T10:00')))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  test('a new target starts as itself', () => {
    expect(first(make('2026-11-03T09:00'))).toBe(iso('2026-11-03T09:00'))
  })

  test("Trent's case by defer: Tue 9 → Wed 9 → Wed 1 PM reads Wed 9", () => {
    const id = make('2026-11-03T09:00')
    defer(id, '2026-11-04T09:00')
    expect(first(id)).toBe(iso('2026-11-04T09:00'))
    defer(id, '2026-11-04T13:00')
    expect(getTaskById(id)!.due_at).toBe(iso('2026-11-04T13:00'))
    expect(first(id)).toBe(iso('2026-11-04T09:00'))
  })

  test('a bulk defer within the day keeps the first', () => {
    const id = make('2026-11-03T09:00')
    bulkSnooze({ ...u, taskIds: [id], until: iso('2026-11-03T14:00') })
    expect(first(id)).toBe(iso('2026-11-03T09:00'))
  })

  test('a defer to 2:30 AM stays on the evening before (3:00 AM day start)', () => {
    const id = make('2026-11-03T21:00')
    defer(id, '2026-11-04T02:30')
    expect(first(id)).toBe(iso('2026-11-03T21:00'))
  })

  test('Remove target clears it', () => {
    const id = make('2026-11-03T09:00')
    updateTask({ ...u, taskId: id, input: { due_at: null } })
    expect(first(id)).toBeNull()
  })

  test("a repeating task's done sets it to the next occurrence", () => {
    const id = make('2026-11-03T09:00', { rrule: 'FREQ=DAILY' })
    defer(id, '2026-11-03T14:00')
    expect(first(id)).toBe(iso('2026-11-03T09:00'))
    markDone({ ...u, taskId: id })
    const after = getTaskById(id)!
    expect(after.due_at).not.toBe(iso('2026-11-03T14:00'))
    expect(after.target_day_first_at).toBe(after.due_at)
  })

  test('undo puts it back with the target', () => {
    const id = make('2026-11-03T09:00')
    defer(id, '2026-11-03T14:00')
    defer(id, '2026-11-04T09:00')
    expect(first(id)).toBe(iso('2026-11-04T09:00'))
    executeUndo(TEST_USER_ID)
    expect(getTaskById(id)!.due_at).toBe(iso('2026-11-03T14:00'))
    expect(first(id)).toBe(iso('2026-11-03T09:00'))
  })
})
