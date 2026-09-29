/**
 * PJ-002 through PJ-007: project CRUD in src/core/projects.
 *
 * - The single-project read counts exactly what the list counts (it used to
 *   count reminders and quotas too).
 * - overdue_count uses the "due right now" rule (countCurrentlyDue), so a
 *   recurring task with no due_at whose occurrence today has passed counts.
 * - The Inbox can't be renamed.
 * - Deleting a shared project sends each member's tasks to their own Inbox.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { getDb } from '@/core/db'
import { createTask } from '@/core/tasks'
import {
  createProject,
  deleteProject,
  getInboxId,
  getProjectById,
  getProjects,
  updateProject,
} from '@/core/projects'
import { ValidationError } from '@/core/errors'
import { offSyncEvent, onSyncEvent } from '@/lib/sync-events'
import {
  seedTestProject,
  seedTestUser,
  setupTestDb,
  teardownTestDb,
  TEST_TIMEZONE,
  TEST_USER_ID,
} from '../helpers/setup'

const OTHER_USER_ID = 2
const OTHER_INBOX_ID = 20
const PAST = '2026-01-15T13:00:00.000Z' // 7am Chicago, three hours before "now"

function addTask(userId: number, projectId: number, extra: Record<string, unknown> = {}) {
  return createTask({
    userId,
    userTimezone: TEST_TIMEZONE,
    input: { title: `Task ${Math.random()}`, project_id: projectId, ...extra },
  })
}

function projectOf(taskId: number): number {
  return (
    getDb().prepare('SELECT project_id FROM tasks WHERE id = ?').get(taskId) as {
      project_id: number
    }
  ).project_id
}

describe('Project CRUD (core)', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-01-15T16:00:00Z'))
    setupTestDb()
  })
  afterEach(() => {
    vi.useRealTimers()
    teardownTestDb()
  })

  test('PJ-002: GET-by-id counts match the list (no reminders, no quotas)', () => {
    const project = createProject(TEST_USER_ID, { name: 'Errands', shared: false })
    addTask(TEST_USER_ID, project.id, { due_at: PAST })
    addTask(TEST_USER_ID, project.id, {
      due_at: PAST,
      rrule: 'FREQ=DAILY',
      is_reminder: true,
    })
    addTask(TEST_USER_ID, project.id, { progress_target: 3, rrule: 'FREQ=WEEKLY' })

    const one = getProjectById(project.id, TEST_USER_ID)
    const listed = getProjects(TEST_USER_ID).find((p) => p.id === project.id)
    expect(one).toEqual(listed)
    expect(one?.active_count).toBe(2)
    expect(one?.overdue_count).toBe(1)
  })

  test('PJ-003: a recurring task with no due_at, past its time today, is overdue', () => {
    const project = createProject(TEST_USER_ID, { name: 'Chores', shared: false })
    const task = addTask(TEST_USER_ID, project.id, { rrule: 'FREQ=DAILY;BYHOUR=7;BYMINUTE=0' })
    getDb()
      .prepare('UPDATE tasks SET due_at = NULL, anchor_time = ? WHERE id = ?')
      .run('07:00', task.id)
    expect(getProjects(TEST_USER_ID).find((p) => p.id === project.id)?.overdue_count).toBe(1)
    expect(getProjectById(project.id, TEST_USER_ID)?.overdue_count).toBe(1)
  })

  test('PJ-004: the Inbox cannot be renamed; other fields still change', () => {
    const inboxId = getInboxId(TEST_USER_ID)!
    expect(() => updateProject(TEST_USER_ID, inboxId, { name: 'Triage' })).toThrow(ValidationError)
    expect(updateProject(TEST_USER_ID, inboxId, { name: ' Inbox ', color: 'red' }).color).toBe(
      'red',
    )
    expect(getInboxId(TEST_USER_ID)).toBe(inboxId)
  })

  test('PJ-005: another project can still be renamed', () => {
    const project = createProject(TEST_USER_ID, { name: 'Old', shared: false })
    expect(updateProject(TEST_USER_ID, project.id, { name: '  New  ' }).name).toBe('New')
  })

  test("PJ-006: deleting a shared project moves each member's tasks to their own Inbox", () => {
    seedTestUser(OTHER_USER_ID, 'other@example.com')
    seedTestProject(OTHER_INBOX_ID, 'Inbox', OTHER_USER_ID)
    const shared = createProject(TEST_USER_ID, { name: 'Household', shared: true })
    const mine = addTask(TEST_USER_ID, shared.id)
    const theirs = addTask(OTHER_USER_ID, shared.id)

    const synced: number[] = []
    const listener = (userId: number) => synced.push(userId)
    onSyncEvent(listener)
    try {
      deleteProject(TEST_USER_ID, shared.id)
    } finally {
      offSyncEvent(listener)
    }

    expect(projectOf(mine.id)).toBe(getInboxId(TEST_USER_ID))
    expect(projectOf(theirs.id)).toBe(OTHER_INBOX_ID)
    expect(getProjectById(shared.id, TEST_USER_ID)).toBeNull()
    expect(new Set(synced)).toEqual(new Set([TEST_USER_ID, OTHER_USER_ID]))
  })

  test('PJ-007: a member without an Inbox blocks the delete and nothing moves', () => {
    seedTestUser(OTHER_USER_ID, 'other@example.com')
    const shared = createProject(TEST_USER_ID, { name: 'Household', shared: true })
    const mine = addTask(TEST_USER_ID, shared.id)
    addTask(OTHER_USER_ID, shared.id)

    expect(() => deleteProject(TEST_USER_ID, shared.id)).toThrow(ValidationError)
    expect(projectOf(mine.id)).toBe(shared.id)
    expect(getProjectById(shared.id, TEST_USER_ID)).not.toBeNull()
  })
})
