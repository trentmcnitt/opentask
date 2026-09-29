/**
 * loadTaskForMutation and taskColumns (src/core/tasks/access.ts, read.ts)
 *
 * The shared guard every single-task mutation starts with. Its error classes,
 * messages and order (missing → 404, no access → 403, trashed → 400) are what
 * the per-mutation checks it replaced produced, and API clients read them.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { getDb } from '@/core/db'
import { createTask, deleteTask, getTaskById, loadTaskForMutation } from '@/core/tasks'
import { taskColumns } from '@/core/tasks/read'
import { NotFoundError, ForbiddenError, ValidationError } from '@/core/errors'
import {
  setupTestDb,
  teardownTestDb,
  seedTestUser,
  seedTestProject,
  TEST_TIMEZONE,
  TEST_USER_ID,
} from '../helpers/setup'

const OTHER_USER_ID = 2

describe('loadTaskForMutation', () => {
  beforeEach(() => {
    setupTestDb()
    seedTestUser(OTHER_USER_ID, 'other@example.com')
    seedTestProject(2, 'Inbox', OTHER_USER_ID)
    seedTestProject(3, 'Shared', OTHER_USER_ID, true)
  })

  afterEach(() => {
    teardownTestDb()
  })

  function make(userId: number, projectId: number) {
    return createTask({
      userId,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Thing', project_id: projectId },
    })
  }

  test('returns the task for its owner', () => {
    const task = make(TEST_USER_ID, 1)
    const loaded = loadTaskForMutation(TEST_USER_ID, task.id, { trashed: 'allow' })
    expect(loaded).toEqual(getTaskById(task.id))
  })

  test('a missing task is NotFoundError "Task not found"', () => {
    expect(() => loadTaskForMutation(TEST_USER_ID, 99999, { trashed: 'allow' })).toThrow(
      new NotFoundError('Task not found'),
    )
  })

  test('another user\'s private task is ForbiddenError "Access denied"', () => {
    const task = make(OTHER_USER_ID, 2)
    expect(() => loadTaskForMutation(TEST_USER_ID, task.id, { trashed: 'allow' })).toThrow(
      ForbiddenError,
    )
    expect(() => loadTaskForMutation(TEST_USER_ID, task.id, { trashed: 'allow' })).toThrow(
      'Access denied',
    )
  })

  test("another user's task in a shared project is accessible", () => {
    const task = make(OTHER_USER_ID, 3)
    expect(loadTaskForMutation(TEST_USER_ID, task.id, { trashed: 'allow' }).id).toBe(task.id)
  })

  test('a trashed task: allowed, or refused with the caller’s message', () => {
    const task = make(TEST_USER_ID, 1)
    deleteTask({ userId: TEST_USER_ID, taskId: task.id })

    expect(loadTaskForMutation(TEST_USER_ID, task.id, { trashed: 'allow' }).deleted_at).not.toBe(
      null,
    )
    expect(() =>
      loadTaskForMutation(TEST_USER_ID, task.id, { trashed: { reject: 'Nope, trashed' } }),
    ).toThrow(new ValidationError('Nope, trashed'))
  })

  test('access is checked before the trash', () => {
    const task = make(OTHER_USER_ID, 2)
    deleteTask({ userId: OTHER_USER_ID, taskId: task.id })
    expect(() =>
      loadTaskForMutation(TEST_USER_ID, task.id, { trashed: { reject: 'trashed' } }),
    ).toThrow(ForbiddenError)
  })
})

describe('taskColumns', () => {
  beforeEach(() => setupTestDb())
  afterEach(() => teardownTestDb())

  test('every listed column exists in the tasks table', () => {
    const tableColumns = (
      getDb().prepare('PRAGMA table_info(tasks)').all() as { name: string }[]
    ).map((c) => c.name)
    for (const col of taskColumns().split(', ')) expect(tableColumns).toContain(col)
  })

  test('qualifies each column with the alias', () => {
    const plain = taskColumns().split(', ')
    const aliased = taskColumns('tasks').split(', ')
    expect(aliased).toEqual(plain.map((c) => `tasks.${c}`))
  })
})
