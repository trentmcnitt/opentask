/**
 * QPR-001..: putting a handled quota prompt back (2026-09-25), and a −1 that
 * takes back a did-it bringing its prompt back as waiting.
 *
 * Trent's rules:
 *   - Put back (POST /api/quota-prompts/restore) → the prompt waits for today
 *     again. Considered only: its key leaves `considered`. Did it: the key
 *     leaves `did` and `considered`, and EXACTLY what that did-it added comes
 *     off the count (a daily #k did-it adds only what was missing up to k —
 *     maybe 0). One transaction, one undo entry.
 *   - A −1 that leaves a did-it unsupported (daily #k: count below k; any
 *     other quota: nothing logged today) takes its key out of `did` AND
 *     `considered` — waiting again, not "handled but not done".
 *
 * The test user has the five default periods (Early morning 07:00, Morning
 * 09:00, Midday 12:00, Afternoon 16:00, Evening 20:30). The clock is frozen on
 * Thursday 2026-01-15, 10:00 Chicago. All titles are synthetic.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { getDb } from '@/core/db'
import { createTask, getTaskById } from '@/core/tasks'
import { incrementProgress } from '@/core/tasks/progress'
import { getQuotaPromptsBySlot, type QuotaPrompt } from '@/core/tasks/quota-prompts'
import { actOnPrompts, restorePrompts } from '@/core/tasks/quota-prompt-actions'
import { listTimeSlots } from '@/core/time-slots'
import { executeRedo, executeUndo } from '@/core/undo'
import { ValidationError } from '@/core/errors'
import { promptKey, withLogged } from '@/lib/quota-prompts'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

const THU = new Date('2026-01-15T16:00:00Z')
const TODAY = '2026-01-15'
const base = { userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE }

function quota(title: string, rrule: string, target: number) {
  return createTask({
    ...base,
    input: { title, rrule, progress_target: target, is_tracked: true },
  })
}

function slotId(label: string): number {
  const slot = listTimeSlots(TEST_USER_ID).find((s) => s.label === label)
  if (!slot) throw new Error(`no slot ${label}`)
  return slot.id
}

function setUserDefault(id: number | null) {
  getDb().prepare('UPDATE users SET quota_prompt_slot_id = ? WHERE id = ?').run(id, TEST_USER_ID)
}

function prompts(): QuotaPrompt[] {
  return [...getQuotaPromptsBySlot(TEST_USER_ID, TEST_TIMEZONE, THU).values()].flat()
}

function prompt(key: string): QuotaPrompt {
  const found = prompts().find((p) => p.prompt_key === key)
  if (!found) throw new Error(`no prompt ${key}`)
  return found
}

function act(key: string, did: boolean) {
  return actOnPrompts({ ...base, actions: [{ key, did }] })
}

function restore(...keys: string[]) {
  return restorePrompts({ ...base, keys })
}

function deltas(taskId: number): number[] {
  return (
    getDb()
      .prepare('SELECT delta FROM progress_events WHERE task_id = ? ORDER BY id')
      .all(taskId) as { delta: number }[]
  ).map((r) => r.delta)
}

function undoCount(): number {
  return (
    getDb()
      .prepare('SELECT COUNT(*) AS n FROM undo_log WHERE user_id = ? AND undone = 0')
      .get(TEST_USER_ID) as { n: number }
  ).n
}

const waiting = { considered: false, done: false }

beforeEach(() => {
  vi.setSystemTime(THU)
  setupTestDb()
  delete process.env.OPENTASK_QUOTA_PROMPTS
})

afterEach(() => {
  vi.useRealTimers()
  teardownTestDb()
})

describe('Put back — consider, weekly and daily did-its', () => {
  test('QPR-001: after consider — waiting again, nothing logged, one undo entry', () => {
    const q = quota('Stretch the hamstrings', 'FREQ=WEEKLY', 3)
    const key = promptKey(q.id, 0, TODAY)
    act(key, false)
    expect(prompt(key)).toMatchObject({ considered: true })

    const before = undoCount()
    const result = restore(key)
    expect(result.restored).toBe(1)
    expect(result.tasks.map((t) => t.id)).toEqual([q.id])
    expect(prompt(key)).toMatchObject({ ...waiting, current: 0 })
    expect(getTaskById(q.id)!.progress_current).toBe(0)
    expect(deltas(q.id)).toEqual([])
    expect(undoCount()).toBe(before + 1)
  })

  test('QPR-002: after a weekly did-it — the +1 comes off, and the prompt waits', () => {
    const q = quota('Stretch the hamstrings', 'FREQ=WEEKLY', 3)
    const key = promptKey(q.id, 0, TODAY)
    act(key, true)
    expect(prompt(key)).toMatchObject({ considered: true, done: true, current: 1 })

    restore(key)
    expect(prompt(key)).toMatchObject({ ...waiting, current: 0 })
    expect(getTaskById(q.id)!.quota_day_state).toMatchObject({
      logged: 0,
      did: [],
      considered: [],
      did_applied: {},
    })
    expect(deltas(q.id)).toEqual([1, -1])
    // And a did-it after it counts afresh, not as a duplicate.
    act(key, true)
    expect(getTaskById(q.id)!.progress_current).toBe(1)
  })

  test('QPR-003: a weekly did-it that met the target — back to unmet and waiting', () => {
    const q = quota('Stretch the hamstrings', 'FREQ=WEEKLY', 2)
    incrementProgress({ userId: TEST_USER_ID, taskId: q.id }) // 1/2
    const key = promptKey(q.id, 0, TODAY)
    act(key, true) // 2/2
    restore(key)
    expect(getTaskById(q.id)!.progress_current).toBe(1)
    // The other +1 is still logged today, so a once-a-day prompt still reads
    // done for today — put back took back only the did-it's own +1.
    expect(prompt(key)).toMatchObject({ considered: false, done: true, current: 1 })
  })

  test('QPR-004: daily #2 did from 0 (raised by 2) — both come off', () => {
    setUserDefault(slotId('Morning'))
    const q = quota('Glasses of water', 'FREQ=DAILY', 2)
    const two = promptKey(q.id, 2, TODAY)
    act(two, true)
    expect(getTaskById(q.id)!.progress_current).toBe(2)
    expect(getTaskById(q.id)!.quota_day_state!.did_applied).toEqual({ [two]: 2 })

    restore(two)
    expect(getTaskById(q.id)!.progress_current).toBe(0)
    expect(prompt(two)).toMatchObject({ ...waiting, current: 0 })
    expect(prompt(promptKey(q.id, 1, TODAY))).toMatchObject({ ...waiting, current: 0 })
    expect(deltas(q.id)).toEqual([2, -2])
  })

  test('QPR-005: daily #2 did when the count was already 1 (raised by 1) — one comes off', () => {
    setUserDefault(slotId('Morning'))
    const q = quota('Glasses of water', 'FREQ=DAILY', 2)
    incrementProgress({ userId: TEST_USER_ID, taskId: q.id }) // 1/2 from the watch
    const two = promptKey(q.id, 2, TODAY)
    act(two, true)
    expect(getTaskById(q.id)!.progress_current).toBe(2)

    restore(two)
    expect(getTaskById(q.id)!.progress_current).toBe(1)
    expect(prompt(two)).toMatchObject({ ...waiting, current: 1 })
    expect(prompt(promptKey(q.id, 1, TODAY))).toMatchObject({ done: true, current: 1 })
    expect(deltas(q.id)).toEqual([1, 1, -1])
  })

  test('QPR-006: daily #1 did when the count was already 2 (raised by 0) — nothing comes off', () => {
    setUserDefault(slotId('Morning'))
    const q = quota('Glasses of water', 'FREQ=DAILY', 3)
    incrementProgress({ userId: TEST_USER_ID, taskId: q.id })
    incrementProgress({ userId: TEST_USER_ID, taskId: q.id }) // 2/3
    const one = promptKey(q.id, 1, TODAY)
    act(one, true)
    expect(getTaskById(q.id)!.quota_day_state!.did_applied).toEqual({ [one]: 0 })

    restore(one)
    expect(getTaskById(q.id)!.progress_current).toBe(2)
    expect(deltas(q.id)).toEqual([1, 1])
    // Un-handled, but the count still reaches #1, so the row stays done.
    expect(prompt(one)).toMatchObject({ considered: false, done: true })
    expect(getTaskById(q.id)!.quota_day_state).toMatchObject({ did: [], considered: [] })
  })
})

describe('Put back — daily numbers and edge cases', () => {
  test('QPR-007: a repeat did-it (which adds 0) keeps the first one’s record', () => {
    setUserDefault(slotId('Morning'))
    const q = quota('Glasses of water', 'FREQ=DAILY', 2)
    const two = promptKey(q.id, 2, TODAY)
    act(two, true)
    act(two, true)
    expect(getTaskById(q.id)!.quota_day_state!.did_applied).toEqual({ [two]: 2 })
    restore(two)
    expect(getTaskById(q.id)!.progress_current).toBe(0)
  })

  test('QPR-008: putting back #1 drops a did-it on #2 the lower count no longer supports', () => {
    setUserDefault(slotId('Morning'))
    const q = quota('Glasses of water', 'FREQ=DAILY', 2)
    const one = promptKey(q.id, 1, TODAY)
    const two = promptKey(q.id, 2, TODAY)
    act(one, true) // 1/2, applied 1
    incrementProgress({ userId: TEST_USER_ID, taskId: q.id }) // 2/2
    act(two, true) // applied 0
    restore(one) // 1/2: #2's did-it no longer holds
    expect(getTaskById(q.id)!.progress_current).toBe(1)
    expect(prompt(two)).toMatchObject({ ...waiting, current: 1 })
    expect(getTaskById(q.id)!.quota_day_state).toMatchObject({ did: [], considered: [] })
  })

  test('QPR-009: a key already waiting is a no-op that still logs an entry', () => {
    const q = quota('Stretch the hamstrings', 'FREQ=WEEKLY', 3)
    const key = promptKey(q.id, 0, TODAY)
    const before = undoCount()
    expect(restore(key).restored).toBe(0)
    expect(undoCount()).toBe(before + 1)
    expect(prompt(key)).toMatchObject(waiting)
  })

  test('QPR-010: a daily did-it from before `did_applied` existed reads as 0; a weekly one as 1', () => {
    setUserDefault(slotId('Morning'))
    const daily = quota('Glasses of water', 'FREQ=DAILY', 2)
    const weekly = quota('Stretch the hamstrings', 'FREQ=WEEKLY', 3)
    const dKey = promptKey(daily.id, 2, TODAY)
    const wKey = promptKey(weekly.id, 0, TODAY)
    const legacy = (key: string, logged: number) =>
      JSON.stringify({ date: TODAY, logged, did: [key], considered: [key] })
    const db = getDb()
    db.prepare('UPDATE tasks SET progress_current = 2, quota_day_state = ? WHERE id = ?').run(
      legacy(dKey, 2),
      daily.id,
    )
    db.prepare('UPDATE tasks SET progress_current = 1, quota_day_state = ? WHERE id = ?').run(
      legacy(wKey, 1),
      weekly.id,
    )
    restore(dKey, wKey)
    expect(getTaskById(daily.id)!.progress_current).toBe(2)
    expect(getTaskById(weekly.id)!.progress_current).toBe(0)
    expect(prompt(wKey)).toMatchObject(waiting)
  })

  test('QPR-011: undo and redo of a put-back', () => {
    setUserDefault(slotId('Morning'))
    const q = quota('Glasses of water', 'FREQ=DAILY', 2)
    const two = promptKey(q.id, 2, TODAY)
    act(two, true)
    restore(two)
    expect(getTaskById(q.id)!.progress_current).toBe(0)

    executeUndo(TEST_USER_ID)
    expect(getTaskById(q.id)!.progress_current).toBe(2)
    expect(prompt(two)).toMatchObject({ considered: true, done: true })
    expect(getTaskById(q.id)!.quota_day_state!.did_applied).toEqual({ [two]: 2 })

    executeRedo(TEST_USER_ID)
    expect(getTaskById(q.id)!.progress_current).toBe(0)
    expect(prompt(two)).toMatchObject({ ...waiting, current: 0 })
  })

  test('QPR-012: several quotas in one put-back are one undo entry', () => {
    const a = quota('Stretch the hamstrings', 'FREQ=WEEKLY', 3)
    const b = quota('Call the utility', 'FREQ=MONTHLY', 2)
    const aKey = promptKey(a.id, 0, TODAY)
    const bKey = promptKey(b.id, 0, TODAY)
    act(aKey, true)
    act(bKey, false)
    const before = undoCount()
    expect(restore(aKey, bKey).restored).toBe(2)
    expect(undoCount()).toBe(before + 1)
    executeUndo(TEST_USER_ID)
    expect(prompt(aKey)).toMatchObject({ considered: true, done: true })
    expect(prompt(bKey)).toMatchObject({ considered: true })
  })

  test('QPR-013: a key from another day, a malformed key, and another user’s quota are refused', () => {
    const q = quota('Stretch the hamstrings', 'FREQ=WEEKLY', 3)
    act(promptKey(q.id, 0, TODAY), true)
    expect(() => restore(promptKey(q.id, 0, '2026-01-14'))).toThrow(ValidationError)
    expect(() => restore('nope')).toThrow(ValidationError)
    expect(() =>
      restorePrompts({ ...base, userId: 999, keys: [promptKey(q.id, 0, TODAY)] }),
    ).toThrow(ValidationError)
    // All or nothing: the refused batch changed nothing.
    expect(() => restore(promptKey(q.id, 0, TODAY), 'nope')).toThrow(ValidationError)
    expect(getTaskById(q.id)!.progress_current).toBe(1)
  })
})

describe('A −1 after a did-it brings the prompt back waiting', () => {
  test('QPR-020: daily — the −1 that drops the count below #2 takes #2 back to waiting', () => {
    setUserDefault(slotId('Morning'))
    const q = quota('Glasses of water', 'FREQ=DAILY', 2)
    const two = promptKey(q.id, 2, TODAY)
    act(two, true) // 2/2
    incrementProgress({ userId: TEST_USER_ID, taskId: q.id, delta: -1 })
    expect(prompt(two)).toMatchObject({ ...waiting, current: 1 })
    expect(getTaskById(q.id)!.quota_day_state).toMatchObject({
      did: [],
      considered: [],
      did_applied: {},
    })
    // A did-it after it tops up by one.
    act(two, true)
    expect(getTaskById(q.id)!.progress_current).toBe(2)
    expect(deltas(q.id)).toEqual([2, -1, 1])
  })

  test('QPR-021: daily — a −1 the did-it still survives changes nothing', () => {
    setUserDefault(slotId('Morning'))
    const q = quota('Glasses of water', 'FREQ=DAILY', 3)
    const one = promptKey(q.id, 1, TODAY)
    act(one, true) // 1/3
    incrementProgress({ userId: TEST_USER_ID, taskId: q.id }) // 2/3
    incrementProgress({ userId: TEST_USER_ID, taskId: q.id, delta: -1 }) // 1/3
    expect(prompt(one)).toMatchObject({ considered: true, done: true })
  })

  test('QPR-022: weekly — a −1 while other progress is still logged today keeps the did-it', () => {
    const q = quota('Stretch the hamstrings', 'FREQ=WEEKLY', 5)
    const key = promptKey(q.id, 0, TODAY)
    incrementProgress({ userId: TEST_USER_ID, taskId: q.id })
    act(key, true) // logged 2
    incrementProgress({ userId: TEST_USER_ID, taskId: q.id, delta: -1 }) // logged 1
    expect(prompt(key)).toMatchObject({ considered: true, done: true })
    incrementProgress({ userId: TEST_USER_ID, taskId: q.id, delta: -1 }) // logged 0
    expect(prompt(key)).toMatchObject(waiting)
  })

  test('QPR-023: a considered-only prompt stays considered through a −1', () => {
    setUserDefault(slotId('Morning'))
    const q = quota('Glasses of water', 'FREQ=DAILY', 2)
    const one = promptKey(q.id, 1, TODAY)
    incrementProgress({ userId: TEST_USER_ID, taskId: q.id })
    act(one, false)
    incrementProgress({ userId: TEST_USER_ID, taskId: q.id, delta: -1 })
    expect(prompt(one)).toMatchObject({ considered: true, done: false })
  })

  test('QPR-024: undoing the −1 puts the did-it back', () => {
    setUserDefault(slotId('Morning'))
    const q = quota('Glasses of water', 'FREQ=DAILY', 2)
    const two = promptKey(q.id, 2, TODAY)
    act(two, true)
    incrementProgress({ userId: TEST_USER_ID, taskId: q.id, delta: -1 })
    executeUndo(TEST_USER_ID)
    expect(prompt(two)).toMatchObject({ considered: true, done: true, current: 2 })
  })

  test('QPR-025: withLogged is pure — the rule on its own', () => {
    const key = 'q:7:3:2026-01-15'
    const state = {
      date: TODAY,
      logged: 3,
      did: [key],
      considered: [key],
      did_applied: { [key]: 3 },
    }
    expect(withLogged(state, TODAY, -1, 2)).toEqual({
      date: TODAY,
      logged: 2,
      did: [],
      considered: [],
      did_applied: {},
    })
    expect(withLogged(state, TODAY, 1, 4)).toEqual({ ...state, logged: 4 })
  })
})
