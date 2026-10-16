/**
 * TR-100..: a quota's progress history (`progress_events`, 2026-10-16).
 *
 * - Every event records where it came from (`source`): what the caller said,
 *   or `api` when it said nothing.
 * - An undo of a count writes the opposite row (`undo`) in the same
 *   transaction, and a redo writes it again (`redo`), so the events always sum
 *   to the count's movement — including for the rollover's `loggedSince`.
 * - `getProgressEvents` serves the history; `getQuotaStats.last_logged_at` is
 *   the last tap that still stands.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { DateTime } from 'luxon'
import { createTask } from '@/core/tasks'
import { incrementProgress } from '@/core/tasks/progress'
import { actOnPrompts, restorePrompts } from '@/core/tasks/quota-prompt-actions'
import { getProgressEvents, getQuotaStats } from '@/core/tasks/quotas'
import { loggedSince } from '@/core/tasks/period-rollover'
import { executeUndo, executeRedo } from '@/core/undo'
import { getDb } from '@/core/db'
import { promptKey } from '@/lib/quota-prompts'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

const base = { userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE }
/** Wednesday 2026-01-14, 10:00 Chicago. */
const NOW = new Date('2026-01-14T16:00:00Z')
const TODAY = '2026-01-14'

function weekly(target = 3): number {
  return createTask({
    ...base,
    input: { title: 'Read', rrule: 'FREQ=WEEKLY', progress_target: target },
  }).id
}

function events(taskId: number): { delta: number; source: string }[] {
  return getDb()
    .prepare('SELECT delta, source FROM progress_events WHERE task_id = ? ORDER BY id')
    .all(taskId) as { delta: number; source: string }[]
}

function count(taskId: number): number {
  const row = getDb().prepare('SELECT progress_current FROM tasks WHERE id = ?').get(taskId) as {
    progress_current: number
  }
  return row.progress_current
}

const sum = (rows: { delta: number }[]) => rows.reduce((n, r) => n + r.delta, 0)

describe('Progress events', () => {
  beforeEach(() => {
    setupTestDb()
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
    teardownTestDb()
  })

  test('TR-100: an event records its source, and api when none is given', () => {
    const id = weekly()
    incrementProgress({ userId: TEST_USER_ID, taskId: id, source: 'web' })
    incrementProgress({ userId: TEST_USER_ID, taskId: id, source: 'watch' })
    incrementProgress({ userId: TEST_USER_ID, taskId: id, delta: -1 })
    expect(events(id)).toEqual([
      { delta: 1, source: 'web' },
      { delta: 1, source: 'watch' },
      { delta: -1, source: 'api' },
    ])
  })

  test("TR-101: a prompt's did-it and put-back record their source", () => {
    const id = weekly()
    const key = promptKey(id, 0, TODAY)
    actOnPrompts({ ...base, now: NOW, actions: [{ key, did: true }], source: 'widget' })
    restorePrompts({ ...base, now: NOW, keys: [key], source: 'mac' })
    expect(events(id)).toEqual([
      { delta: 1, source: 'widget' },
      { delta: -1, source: 'mac' },
    ])
  })

  test('TR-102: undo writes the opposite row, redo writes it again; the sum follows the count', () => {
    const id = weekly()
    incrementProgress({ userId: TEST_USER_ID, taskId: id, source: 'web' })
    incrementProgress({ userId: TEST_USER_ID, taskId: id, source: 'web' })
    executeUndo(TEST_USER_ID)
    expect(count(id)).toBe(1)
    expect(events(id).slice(-1)).toEqual([{ delta: -1, source: 'undo' }])
    executeRedo(TEST_USER_ID)
    expect(count(id)).toBe(2)
    expect(events(id).slice(-1)).toEqual([{ delta: 1, source: 'redo' }])
    expect(sum(events(id))).toBe(count(id))
  })

  test('TR-103: undoing a −1 at zero (nothing moved) writes no row', () => {
    const id = weekly()
    incrementProgress({ userId: TEST_USER_ID, taskId: id, delta: -1 })
    expect(events(id)).toEqual([])
    executeUndo(TEST_USER_ID)
    expect(events(id)).toEqual([])
    expect(count(id)).toBe(0)
  })

  test("TR-104: undoing a did-it compensates; a consider's undo does not", () => {
    const did = weekly()
    actOnPrompts({ ...base, now: NOW, actions: [{ key: promptKey(did, 0, TODAY), did: true }] })
    executeUndo(TEST_USER_ID)
    expect(events(did)).toEqual([
      { delta: 1, source: 'api' },
      { delta: -1, source: 'undo' },
    ])

    const considered = weekly()
    actOnPrompts({
      ...base,
      now: NOW,
      actions: [{ key: promptKey(considered, 0, TODAY), did: false }],
    })
    executeUndo(TEST_USER_ID)
    expect(events(considered)).toEqual([])
  })

  test("TR-105: an undone tap is out of the rollover's carry-forward sum", () => {
    const id = weekly()
    const since = DateTime.fromJSDate(NOW).minus({ minutes: 1 })
    incrementProgress({ userId: TEST_USER_ID, taskId: id })
    incrementProgress({ userId: TEST_USER_ID, taskId: id })
    expect(loggedSince(id, since)).toBe(2)
    vi.setSystemTime(new Date(NOW.getTime() + 60_000))
    executeUndo(TEST_USER_ID)
    expect(loggedSince(id, since)).toBe(1)
    expect(loggedSince(id, since)).toBe(count(id))
  })

  test('TR-106: the history is newest first, ranged, limited and paged by id', () => {
    const id = weekly(10)
    for (let i = 0; i < 5; i++) {
      vi.setSystemTime(new Date(NOW.getTime() + i * 60_000))
      incrementProgress({ userId: TEST_USER_ID, taskId: id, source: 'web' })
    }
    const all = getProgressEvents(TEST_USER_ID, id)
    expect(all.events).toHaveLength(5)
    expect(all.has_more).toBe(false)
    expect(all.events[0].logged_at).toBe(new Date(NOW.getTime() + 4 * 60_000).toISOString())
    expect(all.events[0]).toMatchObject({ delta: 1, source: 'web', user_id: TEST_USER_ID })

    const ranged = getProgressEvents(TEST_USER_ID, id, {
      since: new Date(NOW.getTime() + 60_000).toISOString(),
      until: new Date(NOW.getTime() + 3 * 60_000).toISOString(),
    })
    expect(ranged.events.map((e) => e.logged_at)).toEqual([
      new Date(NOW.getTime() + 2 * 60_000).toISOString(),
      new Date(NOW.getTime() + 60_000).toISOString(),
    ])

    const page1 = getProgressEvents(TEST_USER_ID, id, { limit: 2 })
    expect(page1.events).toHaveLength(2)
    expect(page1.has_more).toBe(true)
    const page2 = getProgressEvents(TEST_USER_ID, id, {
      limit: 2,
      beforeId: page1.events[1].id,
    })
    expect(page2.events.map((e) => e.id)).toEqual(all.events.slice(2, 4).map((e) => e.id))
  })

  test("TR-107: someone else's quota is refused", () => {
    const id = weekly()
    getDb()
      .prepare(
        "INSERT INTO users (id, email, name, password_hash, timezone) VALUES (99, 'x@example.com', 'other', 'x', 'UTC')",
      )
      .run()
    expect(() => getProgressEvents(99, id)).toThrow()
  })

  test('TR-108: the last tap is the latest one still standing', () => {
    const id = weekly()
    expect(getQuotaStats(TEST_USER_ID, id).last_logged_at).toBeNull()

    incrementProgress({ userId: TEST_USER_ID, taskId: id })
    const first = new Date(NOW).toISOString()
    vi.setSystemTime(new Date(NOW.getTime() + 60_000))
    incrementProgress({ userId: TEST_USER_ID, taskId: id })
    expect(getQuotaStats(TEST_USER_ID, id).last_logged_at).toBe(
      new Date(NOW.getTime() + 60_000).toISOString(),
    )

    // The second tap undone: the first is the last one standing.
    executeUndo(TEST_USER_ID)
    expect(getQuotaStats(TEST_USER_ID, id).last_logged_at).toBe(first)

    // And a −1 takes that one back too: nothing stands.
    incrementProgress({ userId: TEST_USER_ID, taskId: id, delta: -1 })
    expect(getQuotaStats(TEST_USER_ID, id).last_logged_at).toBeNull()
  })
})
