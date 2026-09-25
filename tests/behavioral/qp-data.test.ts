/**
 * QP-001..: quota reminders' two task columns (2026-09-24).
 *
 * `quota_prompt_config` is the quota editor's setting; `quota_day_state` is
 * the server's record of the owner's day. Both ride the ordinary task
 * machinery — rowToTask, updateTask, undo — and the one thing that must never
 * happen is the undo stack wedging on them (see apply-fields.ts).
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTask, getTaskById, updateTask } from '@/core/tasks'
import { incrementProgress } from '@/core/tasks/progress'
import { executeUndo, executeRedo } from '@/core/undo'
import { validateTaskUpdate } from '@/core/validation'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

// Thursday 2026-01-15, 10:00 Chicago.
const THU = new Date('2026-01-15T16:00:00Z')
const base = { userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE }

function weekly() {
  return createTask({
    ...base,
    input: { title: 'Cook vegetables', rrule: 'FREQ=WEEKLY', progress_target: 5 },
  })
}

describe('Quota prompt columns', () => {
  beforeEach(() => {
    vi.setSystemTime(THU)
    setupTestDb()
  })
  afterEach(() => {
    vi.useRealTimers()
    teardownTestDb()
  })

  test('QP-001: a new quota has no config and no day record — the defaults', () => {
    const q = weekly()
    expect(q.quota_prompt_config).toBeNull()
    expect(q.quota_day_state).toBeNull()
  })

  test('QP-002: a +1 from anywhere records the day, and undo takes it back', () => {
    const q = weekly()
    incrementProgress({ userId: TEST_USER_ID, taskId: q.id })
    expect(getTaskById(q.id)!.quota_day_state).toEqual({
      date: '2026-01-15',
      logged: 1,
      did: [],
      considered: [],
    })
    executeUndo(TEST_USER_ID)
    const undone = getTaskById(q.id)!
    expect(undone.progress_current).toBe(0)
    expect(undone.quota_day_state).toBeNull()
    executeRedo(TEST_USER_ID)
    expect(getTaskById(q.id)!.quota_day_state?.logged).toBe(1)
  })

  test('QP-003: the day record is net — a +1 corrected by a −1 is nothing logged', () => {
    const q = weekly()
    incrementProgress({ userId: TEST_USER_ID, taskId: q.id })
    incrementProgress({ userId: TEST_USER_ID, taskId: q.id, delta: -1 })
    expect(getTaskById(q.id)!.quota_day_state?.logged).toBe(0)
  })

  test("QP-004: yesterday's record does not carry into today", () => {
    const q = weekly()
    incrementProgress({ userId: TEST_USER_ID, taskId: q.id })
    vi.setSystemTime(new Date('2026-01-16T16:00:00Z'))
    incrementProgress({ userId: TEST_USER_ID, taskId: q.id })
    expect(getTaskById(q.id)!.quota_day_state).toMatchObject({ date: '2026-01-16', logged: 1 })
  })

  test('QP-005: the config saves, reads back parsed, and undoes', () => {
    const q = weekly()
    const config = { enabled: true, slot_id: 2, numbers: { '1': 3 } }
    updateTask({
      ...base,
      taskId: q.id,
      input: validateTaskUpdate({ quota_prompt_config: config }),
    })
    expect(getTaskById(q.id)!.quota_prompt_config).toEqual(config)

    updateTask({
      ...base,
      taskId: q.id,
      input: validateTaskUpdate({ quota_prompt_config: { enabled: false } }),
    })
    expect(getTaskById(q.id)!.quota_prompt_config).toEqual({ enabled: false })

    executeUndo(TEST_USER_ID)
    expect(getTaskById(q.id)!.quota_prompt_config).toEqual(config)
    executeUndo(TEST_USER_ID)
    expect(getTaskById(q.id)!.quota_prompt_config).toBeNull()
  })

  test('QP-006: an equal config is not a change', () => {
    const q = weekly()
    updateTask({
      ...base,
      taskId: q.id,
      input: validateTaskUpdate({ quota_prompt_config: { enabled: false } }),
    })
    const { fieldsChanged } = updateTask({
      ...base,
      taskId: q.id,
      input: validateTaskUpdate({ quota_prompt_config: { enabled: false } }),
    })
    expect(fieldsChanged).not.toContain('quota_prompt_config')
  })

  test('QP-007: validation refuses a malformed config and a client-written day record', () => {
    expect(() => validateTaskUpdate({ quota_prompt_config: { enabled: 'yes' } })).toThrow()
    expect(() => validateTaskUpdate({ quota_prompt_config: { numbers: { '0': 1 } } })).toThrow()
    expect(() => validateTaskUpdate({ quota_prompt_config: { color: 'red' } })).toThrow()
    // Server-owned: not a field a PATCH can carry (zod strips unknown keys).
    expect(validateTaskUpdate({ quota_day_state: { date: 'x' } })).not.toHaveProperty(
      'quota_day_state',
    )
  })
})
