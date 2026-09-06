/**
 * PJ-001: a project's overdue badge never counts reminders (§6: reminders have
 * no debt). Trent (2026-09-05) saw the "Reminders" project chip on the Tasks
 * page wearing a red 19 / 29 / 33 — every one of them a reminder past its
 * time-of-day.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTask } from '@/core/tasks'
import { getProjects } from '@/core/projects'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

describe('Project overdue count', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-01-15T16:00:00Z'))
    setupTestDb()
  })
  afterEach(() => {
    vi.useRealTimers()
    teardownTestDb()
  })

  test('PJ-001: a reminder past its time is not overdue for its project', () => {
    const past = '2026-01-15T13:00:00.000Z' // 7am Chicago, three hours ago
    const errand = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Return the library book', due_at: past },
    })
    createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Breathe before replying',
        due_at: past,
        rrule: 'FREQ=DAILY',
        is_reminder: true,
      },
    })
    const project = getProjects(TEST_USER_ID).find((p) => p.id === errand.project_id)
    expect(project?.overdue_count).toBe(1)
    expect(project?.active_count).toBe(2)
  })
})
