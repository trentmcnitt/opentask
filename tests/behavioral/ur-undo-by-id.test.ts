/**
 * Undo and redo by id, and the request's undo entry (2026-10-26, scoped
 * native Undo)
 *
 * A widget or the watch keeps the `undo_id` its own last action answered and
 * sends it back with Undo: `undoLatest(userId, id)` undoes only if that entry
 * is the one a bare undo would take, and otherwise refuses with the reason
 * and what IS newest, changing nothing. `redoNext` is its twin. Without an id
 * both are the bare undo/redo (`executeUndo`/`executeRedo`), unchanged.
 *
 * The id itself comes from the request context: `logAction` records each
 * entry it writes there (`recordUndoId`), the route answers the newest
 * (`requestUndoId`), and a system write — outside a request, or under
 * `runAsSystem` — records nothing.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { getDb, resetDb } from '@/core/db'
import {
  logAction,
  undoLatest,
  redoNext,
  executeUndo,
  executeRedo,
  getLatestUndoId,
  getNewestUndoableId,
  getNextRedoableId,
} from '@/core/undo'
import { createTask, updateTask } from '@/core/tasks'
import { requestUndoId, runAsSystem, runWithRequestContext } from '@/core/request-context'
import { purgeOldUndoLogs } from '@/core/undo/purge'
import { setupTestDb, seedTestUser, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

const USER = TEST_USER_ID
const OTHER = 2

function title(taskId: number): string {
  const row = getDb().prepare('SELECT title FROM tasks WHERE id = ?').get(taskId) as {
    title: string
  }
  return row.title
}

function undoneFlags(): Record<number, number> {
  const rows = getDb().prepare('SELECT id, undone FROM undo_log ORDER BY id').all() as {
    id: number
    undone: number
  }[]
  return Object.fromEntries(rows.map((r) => [r.id, r.undone]))
}

/** A task and two renames: three entries (create, edit, edit), newest last. */
function threeEntries() {
  const task = createTask({ userId: USER, userTimezone: TEST_TIMEZONE, input: { title: 'One' } })
  const create = getLatestUndoId(USER)!
  updateTask({
    userId: USER,
    userTimezone: TEST_TIMEZONE,
    taskId: task.id,
    input: { title: 'Two' },
  })
  const first = getLatestUndoId(USER)!
  updateTask({
    userId: USER,
    userTimezone: TEST_TIMEZONE,
    taskId: task.id,
    input: { title: 'Three' },
  })
  const second = getLatestUndoId(USER)!
  return { taskId: task.id, create, first, second }
}

/** An entry of User 2's (no task: the stack is all that is read). */
function otherUsersEntry(): number {
  return logAction(OTHER, 'edit', 'Someone else', ['title'], [])
}

beforeEach(() => {
  setupTestDb()
  seedTestUser(OTHER, 'other@example.com')
})

afterEach(() => {
  resetDb()
})

describe('UR-ID-01: undo by id', () => {
  test('the newest entry is undone, and its id answered', () => {
    const { taskId, second } = threeEntries()
    const outcome = undoLatest(USER, second)
    expect(outcome).toMatchObject({
      status: 'undone',
      id: second,
      result: { undone_action: 'edit', tasks_affected: 1 },
    })
    expect(title(taskId)).toBe('Two')
    expect(undoneFlags()[second]).toBe(1)
  })

  test('an older entry is refused as not_latest, naming the newest, and nothing changes', () => {
    const { taskId, first, second } = threeEntries()
    const before = undoneFlags()
    expect(undoLatest(USER, first)).toEqual({
      status: 'conflict',
      reason: 'not_latest',
      newest_undoable_id: second,
    })
    expect(title(taskId)).toBe('Three')
    expect(undoneFlags()).toEqual(before)
  })

  test('an entry already undone is refused as already_undone; the newest is the one below', () => {
    const { taskId, first, second } = threeEntries()
    expect(undoLatest(USER, second).status).toBe('undone')
    expect(undoLatest(USER, second)).toEqual({
      status: 'conflict',
      reason: 'already_undone',
      newest_undoable_id: first,
    })
    expect(title(taskId)).toBe('Two')
  })

  test("another user's id is gone (never whose it is), and neither stack moves", () => {
    const { taskId, second } = threeEntries()
    const theirs = otherUsersEntry()
    const before = undoneFlags()
    expect(undoLatest(USER, theirs)).toEqual({
      status: 'conflict',
      reason: 'gone',
      newest_undoable_id: second,
    })
    // ... and User 2's newest can't be undone through User 1's own id either.
    expect(undoLatest(OTHER, second)).toEqual({
      status: 'conflict',
      reason: 'gone',
      newest_undoable_id: theirs,
    })
    expect(undoneFlags()).toEqual(before)
    expect(title(taskId)).toBe('Three')
  })

  test('a purged id is gone', () => {
    const { first, second } = threeEntries()
    // Older than the 30-day retention: the purge cron takes it.
    getDb()
      .prepare('UPDATE undo_log SET created_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString(), first)
    expect(purgeOldUndoLogs()).toBe(1)
    expect(undoLatest(USER, first)).toEqual({
      status: 'conflict',
      reason: 'gone',
      newest_undoable_id: second,
    })
  })

  test('an id on an empty stack is a conflict (newest null), never the bare "empty"', () => {
    expect(undoLatest(USER, 12345)).toEqual({
      status: 'conflict',
      reason: 'gone',
      newest_undoable_id: null,
    })
    expect(undoLatest(USER)).toEqual({ status: 'empty' })
  })

  test('without an id it is the bare undo: whoever made the newest entry', () => {
    const { taskId, first, second } = threeEntries()
    expect(undoLatest(USER)).toMatchObject({ status: 'undone', id: second })
    expect(executeUndo(USER)).toMatchObject({ undone_action: 'edit' })
    expect(undoneFlags()[first]).toBe(1)
    expect(title(taskId)).toBe('One')
  })
})

describe('UR-ID-02: redo by id', () => {
  test('the entry a bare redo would take is redone', () => {
    const { taskId, second } = threeEntries()
    undoLatest(USER, second)
    expect(redoNext(USER, second)).toMatchObject({
      status: 'redone',
      id: second,
      result: { redone_action: 'edit', tasks_affected: 1 },
    })
    expect(title(taskId)).toBe('Three')
  })

  test('with two undone, only the last one undone (the oldest undone) is next', () => {
    const { taskId, first, second } = threeEntries()
    undoLatest(USER, second)
    undoLatest(USER, first)
    expect(getNextRedoableId(USER)).toBe(first)
    expect(redoNext(USER, second)).toEqual({
      status: 'conflict',
      reason: 'not_next',
      next_redoable_id: first,
    })
    expect(title(taskId)).toBe('One')
    expect(redoNext(USER, first).status).toBe('redone')
    expect(redoNext(USER, second).status).toBe('redone')
    expect(title(taskId)).toBe('Three')
  })

  test('a live entry is not_undone; one cleared by a newer action is gone', () => {
    const { taskId, first, second } = threeEntries()
    expect(redoNext(USER, second)).toEqual({
      status: 'conflict',
      reason: 'not_undone',
      next_redoable_id: null,
    })
    undoLatest(USER, second)
    // A new action clears the redo stack (`logAction`): the undone entry is deleted.
    updateTask({ userId: USER, userTimezone: TEST_TIMEZONE, taskId, input: { title: 'Four' } })
    expect(redoNext(USER, second)).toEqual({
      status: 'conflict',
      reason: 'gone',
      next_redoable_id: null,
    })
    expect(redoNext(USER, first).status).toBe('conflict')
    expect(title(taskId)).toBe('Four')
  })

  test("another user's undone entry is gone", () => {
    const { second } = threeEntries()
    const theirs = otherUsersEntry()
    undoLatest(OTHER, theirs)
    undoLatest(USER, second)
    expect(redoNext(USER, theirs)).toEqual({
      status: 'conflict',
      reason: 'gone',
      next_redoable_id: second,
    })
    expect(undoneFlags()[theirs]).toBe(1)
  })

  test('without an id it is the bare redo', () => {
    const { taskId, second } = threeEntries()
    executeUndo(USER)
    expect(redoNext(USER)).toMatchObject({ status: 'redone', id: second })
    expect(redoNext(USER)).toEqual({ status: 'empty' })
    executeUndo(USER)
    expect(executeRedo(USER)).toMatchObject({ redone_action: 'edit' })
    expect(title(taskId)).toBe('Three')
  })
})

describe('UR-ID-03: the status ids', () => {
  test('newest_undoable_id skips undone entries; latest_id does not', () => {
    const { first, second } = threeEntries()
    expect(getNewestUndoableId(USER)).toBe(second)
    expect(getNextRedoableId(USER)).toBeNull()
    executeUndo(USER)
    expect(getLatestUndoId(USER)).toBe(second)
    expect(getNewestUndoableId(USER)).toBe(first)
    expect(getNextRedoableId(USER)).toBe(second)
    // Per user: User 2 has none.
    expect(getNewestUndoableId(OTHER)).toBeNull()
    expect(getNextRedoableId(OTHER)).toBeNull()
  })
})

describe('UR-ID-04: the request records the undo entry it wrote', () => {
  const request = { path: '/api/test', header: null }

  test("a mutation's entry is the request's undo id", () => {
    const id = runWithRequestContext(request, () => {
      expect(requestUndoId()).toBeNull()
      createTask({ userId: USER, userTimezone: TEST_TIMEZONE, input: { title: 'Mine' } })
      return requestUndoId()
    })
    expect(id).not.toBeNull()
    expect(id).toBe(getNewestUndoableId(USER))
  })

  test('two entries in one request: the newest', () => {
    const ids = runWithRequestContext(request, () => {
      const a = logAction(USER, 'edit', 'a', [], [])
      const b = logAction(USER, 'edit', 'b', [], [])
      return { a, b, recorded: requestUndoId() }
    })
    expect(ids.b).toBeGreaterThan(ids.a)
    expect(ids.recorded).toBe(ids.b)
  })

  test('carried across an await, as a route reads it after awaiting its body', async () => {
    const id = await runWithRequestContext(request, async () => {
      await Promise.resolve()
      const logged = logAction(USER, 'edit', 'after await', [], [])
      await Promise.resolve()
      return { logged, recorded: requestUndoId() }
    })
    expect(id.recorded).toBe(id.logged)
  })

  test('a request that logs nothing answers null', () => {
    expect(runWithRequestContext(request, () => requestUndoId())).toBeNull()
  })

  test('outside a request (a cron job) nothing is recorded', () => {
    logAction(USER, 'edit', 'cron', [], [])
    expect(requestUndoId()).toBeNull()
  })

  test("runAsSystem inside a request records nothing, and leaves the request's id alone", () => {
    const seen = runWithRequestContext(request, () => {
      const mine = logAction(USER, 'edit', 'mine', [], [])
      const inside = runAsSystem(() => {
        logAction(USER, 'edit', 'enrichment', [], [])
        return requestUndoId()
      })
      return { mine, inside, after: requestUndoId() }
    })
    expect(seen.inside).toBeNull()
    expect(seen.after).toBe(seen.mine)
    // The system's entry is still the newest on the stack: a native Undo of
    // `mine` is refused as not_latest, as it should be.
    expect(getNewestUndoableId(USER)).toBeGreaterThan(seen.mine)
    expect(undoLatest(USER, seen.mine)).toMatchObject({ status: 'conflict', reason: 'not_latest' })
  })

  test('requests are independent: one never sees the other’s id', () => {
    const first = runWithRequestContext(request, () => {
      logAction(USER, 'edit', 'one', [], [])
      return requestUndoId()
    })
    const second = runWithRequestContext(request, () => requestUndoId())
    expect(first).not.toBeNull()
    expect(second).toBeNull()
  })
})
