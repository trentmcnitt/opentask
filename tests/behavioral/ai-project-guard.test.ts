/**
 * Project assignment guard (filterProjectMatch)
 *
 * Enrichment sets a project on an explicit instruction or when the task text
 * contains the project's name (Trent, 2026-09-28) — never from topic. The model
 * sometimes files by topic anyway, so the server keeps its answer only when a
 * word of the project's name appears in the input as a whole word. Whether a
 * present word is used AS the name ("after work", "work out") is the prompt's
 * job, not this guard's; see the function's comment.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { setupTestDb, teardownTestDb, TEST_USER_ID, TEST_TIMEZONE } from '../helpers/setup'

process.env.OPENTASK_AI_PROVIDER = 'anthropic'
process.env.ANTHROPIC_API_KEY = 'test-key'
process.env.OPENTASK_AI_ENRICHMENT_MODEL = 'test-model'

vi.mock('@/core/ai/sdk', () => ({
  isAIEnabled: () => true,
  initAI: async () => {},
  aiQuery: vi.fn(),
}))

vi.mock('@/core/ai/enrichment-slot', () => ({
  enrichmentQuery: vi.fn(),
  initEnrichmentSlot: vi.fn(),
  getEnrichmentSlotStats: vi.fn(),
  shutdownEnrichmentSlot: vi.fn(),
}))

import { getDb } from '@/core/db'
import { createTask, getTaskById } from '@/core/tasks'
import {
  allowProjectMove,
  enrichSingleTask,
  filterProjectMatch,
  _resetProcessingState,
  _resetCircuitBreaker,
} from '@/core/ai/enrichment'
import { enrichmentQuery } from '@/core/ai/enrichment-slot'

const mockEnrichmentQuery = vi.mocked(enrichmentQuery)

describe('filterProjectMatch', () => {
  test('keeps a project whose full name is in the text', () => {
    expect(filterProjectMatch('Job Search', 'Test task for job search')).toBe('Job Search')
    expect(filterProjectMatch('Work', 'print the expense report for work')).toBe('Work')
    expect(filterProjectMatch('Work Travel', 'book the hotel for work travel')).toBe('Work Travel')
  })

  test('keeps an explicit assignment by part of the name', () => {
    expect(filterProjectMatch('Shopping List', 'oat milk put it in shopping')).toBe('Shopping List')
    expect(filterProjectMatch('Family', 'call mom, add it to family')).toBe('Family')
  })

  test('drops a project chosen from topic alone', () => {
    expect(filterProjectMatch('Home', 'fix the leak in the kitchen')).toBeNull()
    expect(filterProjectMatch('Shopping List', 'pick up bananas and bread')).toBeNull()
    expect(filterProjectMatch('Job Search', 'apply to Acme by Friday')).toBeNull()
    expect(filterProjectMatch('Work', 'weekly standup every Monday 9am')).toBeNull()
  })

  test('matches whole words only', () => {
    expect(filterProjectMatch('Home', "check the kids' homework")).toBeNull()
    expect(filterProjectMatch('Work', "check the kids' homework")).toBeNull()
    expect(filterProjectMatch('Work', 'go to my workout class')).toBeNull()
  })

  test('a name made only of short words is matched on those', () => {
    expect(filterProjectMatch('HR', 'send the form to HR')).toBe('HR')
    expect(filterProjectMatch('HR', 'three hours of paperwork')).toBeNull()
  })

  test('null stays null', () => {
    expect(filterProjectMatch(null, 'anything for work')).toBeNull()
  })
})

describe('allowProjectMove', () => {
  test('a task in the Inbox moves on a name match', () => {
    expect(
      allowProjectMove({
        currentIsInbox: true,
        projectName: 'Job Search',
        enrichedTitle: 'Test task for job search',
      }),
    ).toBe(true)
  })

  test('a task in a chosen project does not move on a name match', () => {
    expect(
      allowProjectMove({
        currentIsInbox: false,
        projectName: 'Job Search',
        enrichedTitle: 'Test task for job search',
      }),
    ).toBe(false)
  })

  test('a task in a chosen project moves on an instruction the title no longer carries', () => {
    expect(
      allowProjectMove({
        currentIsInbox: false,
        projectName: 'Job Search',
        enrichedTitle: 'Update my resume',
      }),
    ).toBe(true)
  })
})

describe('enrichment applies the guard', () => {
  let workId: number
  let homeId: number
  let jobSearchId: number

  beforeAll(() => {
    setupTestDb()
    const db = getDb()
    db.prepare("UPDATE users SET ai_enrichment_mode = 'sdk' WHERE id = ?").run(TEST_USER_ID)
    workId = Number(
      db
        .prepare('INSERT INTO projects (name, owner_id, shared, sort_order) VALUES (?, ?, 0, 4)')
        .run('Work', TEST_USER_ID).lastInsertRowid,
    )
    homeId = Number(
      db
        .prepare('INSERT INTO projects (name, owner_id, shared, sort_order) VALUES (?, ?, 0, 5)')
        .run('Home', TEST_USER_ID).lastInsertRowid,
    )
    jobSearchId = Number(
      db
        .prepare('INSERT INTO projects (name, owner_id, shared, sort_order) VALUES (?, ?, 0, 6)')
        .run('Job Search', TEST_USER_ID).lastInsertRowid,
    )
  })

  afterAll(() => {
    teardownTestDb()
  })

  beforeEach(() => {
    _resetProcessingState()
    _resetCircuitBreaker()
    mockEnrichmentQuery.mockReset()
  })

  function modelSays(title: string, projectName: string | null) {
    mockEnrichmentQuery.mockResolvedValueOnce({
      structuredOutput: {
        title,
        due_at: null,
        priority: 0,
        labels: [],
        project_name: projectName,
        rrule: null,
        auto_snooze_minutes: null,
        recurrence_mode: null,
        notes: null,
        reasoning: 'test',
      },
      text: null,
      durationMs: 1,
    })
  }

  test('a name match moves the task into the project', async () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Test task for job search' },
    })
    modelSays('Test task for job search', 'Job Search')
    await enrichSingleTask(task.id, TEST_USER_ID)
    expect(getTaskById(task.id)!.project_id).toBe(jobSearchId)
  })

  test('a topic-only pick leaves the task where it was', async () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'fix the leak in the kitchen' },
    })
    const before = task.project_id
    modelSays('Fix the leak in the kitchen', 'Home')
    await enrichSingleTask(task.id, TEST_USER_ID)
    const after = getTaskById(task.id)!
    expect(after.project_id).toBe(before)
    expect(after.project_id).not.toBe(homeId)
    expect(after.title).toBe('Fix the leak in the kitchen')
  })

  // A name match never moves a task out of a project the user chose.
  test('a task created in another project stays there on a name match', async () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Test task for job search', project_id: workId },
    })
    expect(task.labels).toContain('ai-to-process')
    modelSays('Test task for job search', 'Job Search')
    await enrichSingleTask(task.id, TEST_USER_ID)
    const after = getTaskById(task.id)!
    expect(after.project_id).toBe(workId)
    expect(after.labels).not.toContain('ai-to-process')
  })

  test('a task created in another project moves on an explicit instruction', async () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'update my resume put it in job search', project_id: workId },
    })
    modelSays('Update my resume', 'Job Search')
    await enrichSingleTask(task.id, TEST_USER_ID)
    const after = getTaskById(task.id)!
    expect(after.project_id).toBe(jobSearchId)
    expect(after.title).toBe('Update my resume')
  })
})
