/**
 * Batch undo/redo behavioral tests
 *
 * Tests the batch undo/redo core logic: count mode, throughId mode,
 * sessionStartId mode, atomicity, and remaining counts.
 */

import { describe, test, expect, beforeAll, beforeEach } from 'vitest'
import { setupTestDb, TEST_USER_ID, TEST_TIMEZONE } from '../helpers/setup'
import { getDb } from '@/core/db'
import { createTask } from '@/core/tasks/create'
import { updateTask } from '@/core/tasks/update'
import { executeBatchUndo, executeBatchRedo } from '@/core/undo/batch'
import { getTaskById } from '@/core/tasks/create'
import { getLatestUndoId } from '@/core/undo'

describe('Batch undo/redo', () => {
  beforeAll(() => {
    setupTestDb()
  })

  beforeEach(() => {
    // Clean undo log and tasks between tests
    const db = getDb()
    db.prepare('DELETE FROM undo_log').run()
    db.prepare('DELETE FROM tasks').run()
  })

  /** Helper: create a task and return its ID */
  function makeTask(title: string): number {
    return createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title, project_id: 1 },
    }).id
  }

  /** Helper: update a task's priority (creates an undo entry) */
  function editPriority(taskId: number, priority: number): void {
    updateTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId,
      input: { priority },
    })
  }

  describe('executeBatchUndo', () => {
    test('count mode: undoes exactly N most recent entries', () => {
      const id1 = makeTask('Task 1')
      const id2 = makeTask('Task 2')
      const id3 = makeTask('Task 3')

      editPriority(id1, 2)
      editPriority(id2, 3)
      editPriority(id3, 4)

      const result = executeBatchUndo(TEST_USER_ID, { count: 2 })

      expect(result.count).toBe(2)
      // Task 3 and Task 2 should be undone (most recent first)
      expect(getTaskById(id3)!.priority).toBe(0) // restored to default
      expect(getTaskById(id2)!.priority).toBe(0)
      // Task 1 should still have its edit
      expect(getTaskById(id1)!.priority).toBe(2)
    })

    test('throughId mode: undoes entries down to and including ID', () => {
      const id1 = makeTask('Task 1')
      editPriority(id1, 2) // undo entry 1
      editPriority(id1, 3) // undo entry 2

      // Get the ID of the first edit entry
      const db = getDb()
      const entries = db
        .prepare("SELECT id FROM undo_log WHERE user_id = ? AND action = 'edit' ORDER BY id ASC")
        .all(TEST_USER_ID) as Array<{ id: number }>

      const firstEditId = entries[0].id

      const result = executeBatchUndo(TEST_USER_ID, { throughId: firstEditId })

      // Should undo both edit entries (entry 2 and entry 1)
      expect(result.count).toBe(2)
      expect(getTaskById(id1)!.priority).toBe(0) // back to default
    })

    test('sessionStartId mode: undoes only entries after the given ID', () => {
      const id1 = makeTask('Task 1')
      editPriority(id1, 2) // entry before session

      const sessionStart = getLatestUndoId(TEST_USER_ID)!

      editPriority(id1, 3) // entry in session
      editPriority(id1, 4) // entry in session

      const result = executeBatchUndo(TEST_USER_ID, { sessionStartId: sessionStart })

      // Should only undo the 2 entries after sessionStart
      expect(result.count).toBe(2)
      // Priority should be back to 2 (the pre-session edit remains)
      expect(getTaskById(id1)!.priority).toBe(2)
    })

    test('returns zero count when nothing to undo', () => {
      const result = executeBatchUndo(TEST_USER_ID, { count: 5 })

      expect(result.count).toBe(0)
      expect(result.remaining_undoable).toBe(0)
    })

    test('remaining counts are accurate after partial undo', () => {
      const id1 = makeTask('Task 1')
      editPriority(id1, 1)
      editPriority(id1, 2)
      editPriority(id1, 3)

      const result = executeBatchUndo(TEST_USER_ID, { count: 2 })

      expect(result.count).toBe(2)
      // 1 create + 3 edits = 4 entries total; undid 2 edit entries
      // remaining undoable: 1 edit + 1 create = 2
      expect(result.remaining_undoable).toBe(2)
      expect(result.remaining_redoable).toBe(2)
    })

    test('batch undo restores all tasks in a single operation', () => {
      const id1 = makeTask('Task 1')
      const id2 = makeTask('Task 2')
      const id3 = makeTask('Task 3')

      editPriority(id1, 2)
      editPriority(id2, 3)
      editPriority(id3, 4)

      const result = executeBatchUndo(TEST_USER_ID, { count: 3 })

      expect(result.count).toBe(3)
      expect(getTaskById(id1)!.priority).toBe(0)
      expect(getTaskById(id2)!.priority).toBe(0)
      expect(getTaskById(id3)!.priority).toBe(0)
    })
  })

  describe('executeBatchRedo', () => {
    test('count mode: redoes exactly N oldest undone entries', () => {
      const id1 = makeTask('Task 1')
      const id2 = makeTask('Task 2')

      editPriority(id1, 2)
      editPriority(id2, 3)

      // Undo both
      executeBatchUndo(TEST_USER_ID, { count: 2 })
      expect(getTaskById(id1)!.priority).toBe(0)
      expect(getTaskById(id2)!.priority).toBe(0)

      // Redo 1 (oldest first = id1's edit)
      const result = executeBatchRedo(TEST_USER_ID, { count: 1 })

      expect(result.count).toBe(1)
      expect(getTaskById(id1)!.priority).toBe(2) // redone
      expect(getTaskById(id2)!.priority).toBe(0) // still undone
    })

    test('throughId mode: redoes entries up to the given ID', () => {
      const id1 = makeTask('Task 1')
      editPriority(id1, 2) // entry A
      editPriority(id1, 3) // entry B

      // Undo both
      executeBatchUndo(TEST_USER_ID, { count: 2 })

      const db = getDb()
      const entries = db
        .prepare(
          "SELECT id FROM undo_log WHERE user_id = ? AND action = 'edit' AND undone = 1 ORDER BY id ASC",
        )
        .all(TEST_USER_ID) as Array<{ id: number }>

      // Redo up to and including entry B
      const result = executeBatchRedo(TEST_USER_ID, { throughId: entries[1].id })

      expect(result.count).toBe(2) // Both redone
      expect(getTaskById(id1)!.priority).toBe(3) // back to final value
    })

    test('returns zero count when nothing to redo', () => {
      const result = executeBatchRedo(TEST_USER_ID, { count: 5 })

      expect(result.count).toBe(0)
      expect(result.remaining_redoable).toBe(0)
    })
  })

  describe('Round-trip', () => {
    test('batch undo then batch redo restores original state', () => {
      const id1 = makeTask('Round trip')
      editPriority(id1, 2)
      editPriority(id1, 3)

      // Batch undo both edits
      executeBatchUndo(TEST_USER_ID, { count: 2 })
      expect(getTaskById(id1)!.priority).toBe(0)

      // Batch redo both edits
      executeBatchRedo(TEST_USER_ID, { count: 2 })
      expect(getTaskById(id1)!.priority).toBe(3)
    })

    test('interleave single undo + batch undo', () => {
      const id1 = makeTask('Task 1')
      editPriority(id1, 1)
      editPriority(id1, 2)
      editPriority(id1, 3)

      // Batch undo 2 (edits 3 and 2)
      executeBatchUndo(TEST_USER_ID, { count: 2 })
      expect(getTaskById(id1)!.priority).toBe(1)

      // Batch undo remaining 1 edit
      executeBatchUndo(TEST_USER_ID, { count: 1 })
      expect(getTaskById(id1)!.priority).toBe(0)
    })
  })
})
