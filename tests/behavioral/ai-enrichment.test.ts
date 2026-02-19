/**
 * AI enrichment behavioral tests
 *
 * Tests the label-based enrichment pipeline with mocked SDK responses.
 * Verifies that:
 * - Tasks created with title-only get the `ai-to-process` label when AI is enabled
 * - Tasks created with fields set skip AI enrichment
 * - The enrichment queue picks up tasks with `ai-to-process` label
 * - ai-locked tasks are skipped and have ai-to-process removed
 * - Failed enrichments use retry logic (ai-failed after 2 attempts)
 * - In-memory processing guard prevents double-processing
 * - Circuit breaker trips after rapid failures and resets after pause
 * - Fair queuing interleaves tasks from different users
 * - Label merging combines AI labels with existing user labels
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { setupTestDb, teardownTestDb, TEST_USER_ID, TEST_TIMEZONE } from '../helpers/setup'

// Mock isAIEnabled to return true for these tests
vi.mock('@/core/ai/sdk', () => ({
  isAIEnabled: () => true,
  initAI: async () => {},
  aiQuery: vi.fn(),
}))

// Mock enrichment-slot to avoid launching real subprocesses
vi.mock('@/core/ai/enrichment-slot', () => ({
  enrichmentQuery: vi.fn(),
  initEnrichmentSlot: vi.fn(),
  getEnrichmentSlotStats: vi.fn(() => ({
    state: 'available',
    model: 'haiku',
    totalRequests: 0,
    totalRecycles: 0,
    activatedAt: null,
    lastRequestAt: null,
  })),
  shutdownEnrichmentSlot: vi.fn(),
}))

import { getDb } from '@/core/db'
import { createTask, getTaskById } from '@/core/tasks'
import {
  processEnrichmentQueue,
  enrichSingleTask,
  _resetCircuitBreaker,
  _resetProcessingState,
} from '@/core/ai/enrichment'
import { enrichmentQuery } from '@/core/ai/enrichment-slot'

const mockEnrichmentQuery = vi.mocked(enrichmentQuery)

/** Helper to build a mock enrichment result */
function mockResult(overrides: Record<string, unknown> = {}) {
  return {
    structuredOutput: {
      title: 'Clean title',
      priority: 3,
      due_at: '2026-02-20T14:00:00Z',
      labels: ['errand'],
      rrule: null,
      project_name: null,
      auto_snooze_minutes: null,
      recurrence_mode: null,
      notes: null,
      reasoning: 'Test reasoning',
      ...overrides,
    },
    text: null,
    durationMs: 100,
  }
}

/**
 * Remove all ai-to-process labels from tasks so previous tests don't
 * leave queue items that interfere with subsequent tests.
 */
function clearPendingEnrichment(): void {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT id, labels FROM tasks
       WHERE EXISTS (SELECT 1 FROM json_each(labels) WHERE value = 'ai-to-process')`,
    )
    .all() as { id: number; labels: string }[]
  for (const row of rows) {
    const labels = JSON.parse(row.labels) as string[]
    const cleaned = labels.filter((l) => l !== 'ai-to-process')
    db.prepare('UPDATE tasks SET labels = ? WHERE id = ?').run(JSON.stringify(cleaned), row.id)
  }
}

beforeAll(() => {
  setupTestDb()
})

afterAll(() => {
  teardownTestDb()
})

afterEach(() => {
  _resetCircuitBreaker()
  _resetProcessingState()
  mockEnrichmentQuery.mockReset()
  vi.useRealTimers()
})

describe('AI enrichment trigger (label-based)', () => {
  test('title-only task gets ai-to-process label when AI is enabled', () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'call dentist next tuesday high priority' },
    })

    const fromDb = getTaskById(task.id)
    expect(fromDb).not.toBeNull()
    expect(fromDb!.labels).toContain('ai-to-process')
  })

  test('task with due_at set skips AI enrichment', () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Meeting',
        due_at: '2026-02-15T14:00:00Z',
      },
    })

    const fromDb = getTaskById(task.id)
    expect(fromDb!.labels).not.toContain('ai-to-process')
  })

  test('task with priority set skips AI enrichment', () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Important thing',
        priority: 3,
      },
    })

    const fromDb = getTaskById(task.id)
    expect(fromDb!.labels).not.toContain('ai-to-process')
  })

  test('task with labels set skips AI enrichment', () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Buy groceries',
        labels: ['shopping'],
      },
    })

    const fromDb = getTaskById(task.id)
    expect(fromDb!.labels).not.toContain('ai-to-process')
    expect(fromDb!.labels).toContain('shopping')
  })

  test('task with rrule set skips AI enrichment', () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Daily standup',
        rrule: 'FREQ=DAILY',
      },
    })

    const fromDb = getTaskById(task.id)
    expect(fromDb!.labels).not.toContain('ai-to-process')
  })
})

describe('processEnrichmentQueue ai-locked skip', () => {
  beforeEach(() => clearPendingEnrichment())

  test('ai-locked task has ai-to-process removed when processed through the queue', async () => {
    const db = getDb()

    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'do not enrich me' },
    })

    expect(getTaskById(task.id)!.labels).toContain('ai-to-process')

    // Manually add ai-locked label alongside ai-to-process
    const labels = JSON.stringify(['ai-to-process', 'ai-locked'])
    db.prepare('UPDATE tasks SET labels = ? WHERE id = ?').run(labels, task.id)

    await processEnrichmentQueue()

    const after = getTaskById(task.id)
    expect(after!.labels).not.toContain('ai-to-process')
    expect(after!.labels).toContain('ai-locked')
    expect(after!.title).toBe('do not enrich me')
  })
})

describe('enrichment success path', () => {
  beforeEach(() => clearPendingEnrichment())

  test('applies title, priority, due_at from AI result, strips inferred labels', async () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'call dentist next tuesday high priority' },
    })
    expect(getTaskById(task.id)!.labels).toContain('ai-to-process')

    // AI returns an inferred "errand" label, but the guard strips it because
    // the input has no explicit label-intent keywords ("label it as", "tag it", etc.)
    mockEnrichmentQuery.mockResolvedValueOnce(
      mockResult({
        title: 'Call dentist',
        priority: 3,
        due_at: '2026-02-20T14:00:00Z',
        labels: ['errand'],
      }),
    )

    await processEnrichmentQueue()

    const after = getTaskById(task.id)!
    expect(after.title).toBe('Call dentist')
    expect(after.priority).toBe(3)
    expect(after.due_at).toBe('2026-02-20T14:00:00Z')
    expect(after.labels).not.toContain('errand')
    expect(after.labels).not.toContain('ai-to-process')
  })

  test('applies rrule and derives anchor fields', async () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'weekly standup every tuesday' },
    })

    mockEnrichmentQuery.mockResolvedValueOnce(
      mockResult({
        title: 'Weekly standup',
        priority: 0,
        due_at: '2026-02-17T15:00:00Z',
        labels: [],
        rrule: 'FREQ=WEEKLY;BYDAY=TU',
      }),
    )

    await processEnrichmentQueue()

    const after = getTaskById(task.id)!
    expect(after.rrule).toBe('FREQ=WEEKLY;BYDAY=TU')
    expect(after.anchor_dow).not.toBeNull()
    expect(after.labels).not.toContain('ai-to-process')
  })

  test('resolves project_name to project_id', async () => {
    const db = getDb()
    db.prepare('INSERT OR IGNORE INTO projects (name, owner_id, sort_order) VALUES (?, ?, ?)').run(
      'Work',
      TEST_USER_ID,
      1,
    )
    const project = db.prepare('SELECT id FROM projects WHERE name = ?').get('Work') as {
      id: number
    }

    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'finish report for work' },
    })

    mockEnrichmentQuery.mockResolvedValueOnce(
      mockResult({
        title: 'Finish report',
        priority: 2,
        labels: [],
        project_name: 'Work',
      }),
    )

    await processEnrichmentQueue()

    const after = getTaskById(task.id)!
    expect(after.project_id).toBe(project.id)
    expect(after.labels).not.toContain('ai-to-process')
  })

  test('removes ai-to-process even when no fields changed', async () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'simple task' },
    })

    mockEnrichmentQuery.mockResolvedValueOnce(
      mockResult({
        title: 'simple task',
        priority: 0,
        due_at: null,
        labels: [],
        rrule: null,
        project_name: null,
      }),
    )

    await processEnrichmentQueue()

    const after = getTaskById(task.id)!
    expect(after.labels).not.toContain('ai-to-process')
    expect(after.title).toBe('simple task')
  })

  test('enrichment is logged in undo history', async () => {
    createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'log me in undo' },
    })

    mockEnrichmentQuery.mockResolvedValueOnce(
      mockResult({
        title: 'Log me in undo',
        priority: 2,
        labels: ['work'],
      }),
    )

    await processEnrichmentQueue()

    const db = getDb()
    const undoEntry = db
      .prepare('SELECT * FROM undo_log WHERE user_id = ? ORDER BY id DESC LIMIT 1')
      .get(TEST_USER_ID) as { id: number; action: string; description: string } | undefined

    expect(undoEntry).toBeDefined()
    expect(undoEntry!.action).toBe('edit')
    expect(undoEntry!.description).toContain('AI')
  })
})

describe('enrichSingleTask (fire-and-forget)', () => {
  beforeEach(() => clearPendingEnrichment())

  test('processes a title-only task, strips inferred labels', async () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'pick up dry cleaning tomorrow' },
    })

    // AI returns inferred "errand" label — guard strips it (no label-intent in input)
    mockEnrichmentQuery.mockResolvedValueOnce(
      mockResult({
        title: 'Pick up dry cleaning',
        priority: 1,
        due_at: '2026-02-10T17:00:00Z',
        labels: ['errand'],
      }),
    )

    await enrichSingleTask(task.id, TEST_USER_ID)

    const after = getTaskById(task.id)!
    expect(after.title).toBe('Pick up dry cleaning')
    expect(after.priority).toBe(1)
    expect(after.labels).not.toContain('errand')
    expect(after.labels).not.toContain('ai-to-process')
  })

  test('skips task without ai-to-process label', async () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Explicit task', labels: ['work'] },
    })

    await enrichSingleTask(task.id, TEST_USER_ID)

    expect(mockEnrichmentQuery).not.toHaveBeenCalled()
    const after = getTaskById(task.id)!
    expect(after.title).toBe('Explicit task')
  })

  test('skips task with ai-locked label', async () => {
    const db = getDb()
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'locked task' },
    })

    const labels = JSON.stringify(['ai-to-process', 'ai-locked'])
    db.prepare('UPDATE tasks SET labels = ? WHERE id = ?').run(labels, task.id)

    await enrichSingleTask(task.id, TEST_USER_ID)

    expect(mockEnrichmentQuery).not.toHaveBeenCalled()
    const after = getTaskById(task.id)!
    expect(after.labels).not.toContain('ai-to-process')
    expect(after.labels).toContain('ai-locked')
  })

  test('handles failure with retry tracking', async () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'fail me once' },
    })

    mockEnrichmentQuery.mockRejectedValueOnce(new Error('SDK error'))

    await enrichSingleTask(task.id, TEST_USER_ID)

    const after = getTaskById(task.id)!
    expect(after.labels).toContain('ai-to-process')
    expect(after.labels).not.toContain('ai-failed')
  })
})

describe('retry logic', () => {
  beforeEach(() => clearPendingEnrichment())

  test('first failure keeps ai-to-process label', async () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'retry task first fail' },
    })

    mockEnrichmentQuery.mockRejectedValueOnce(new Error('SDK error'))

    await processEnrichmentQueue()

    const after = getTaskById(task.id)!
    expect(after.labels).toContain('ai-to-process')
    expect(after.labels).not.toContain('ai-failed')
  })

  test('second failure swaps ai-to-process to ai-failed', async () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'retry task second fail' },
    })

    // First failure — retryCount goes to 1
    mockEnrichmentQuery.mockRejectedValueOnce(new Error('SDK error 1'))
    await processEnrichmentQueue()

    const afterFirst = getTaskById(task.id)!
    expect(afterFirst.labels).toContain('ai-to-process')

    // Second failure — retryCount goes to 2 (>= MAX_ATTEMPTS), swaps label.
    // The processing lock and processingTasks set are cleared by the finally
    // block, so the next call picks the task up. retryCount persists.
    mockEnrichmentQuery.mockRejectedValueOnce(new Error('SDK error 2'))
    await processEnrichmentQueue()

    const afterSecond = getTaskById(task.id)!
    expect(afterSecond.labels).not.toContain('ai-to-process')
    expect(afterSecond.labels).toContain('ai-failed')
  })

  test('success after first failure clears retry count', async () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'retry then succeed' },
    })

    // First call: failure
    mockEnrichmentQuery.mockRejectedValueOnce(new Error('SDK error'))
    await processEnrichmentQueue()

    const afterFail = getTaskById(task.id)!
    expect(afterFail.labels).toContain('ai-to-process')

    // Second call: success — retryCount is cleared on success
    mockEnrichmentQuery.mockResolvedValueOnce(
      mockResult({
        title: 'Retry then succeed',
        priority: 1,
        labels: [],
      }),
    )
    await processEnrichmentQueue()

    const afterSuccess = getTaskById(task.id)!
    expect(afterSuccess.labels).not.toContain('ai-to-process')
    expect(afterSuccess.labels).not.toContain('ai-failed')
    expect(afterSuccess.title).toBe('Retry then succeed')
  })
})

describe('circuit breaker', () => {
  beforeEach(() => clearPendingEnrichment())

  test('circuit breaker exports are available', () => {
    expect(typeof _resetCircuitBreaker).toBe('function')
    _resetCircuitBreaker()
  })

  test('trips after 5 failures within 60s window', async () => {
    vi.setSystemTime(new Date('2026-02-15T12:00:00Z'))

    // Create 5 tasks that will all fail
    for (let i = 0; i < 5; i++) {
      createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: `circuit breaker fail ${i}` },
      })
    }

    mockEnrichmentQuery.mockRejectedValue(new Error('SDK error'))
    await processEnrichmentQueue()

    // Circuit breaker is now tripped. Create a new task.
    mockEnrichmentQuery.mockReset()
    mockEnrichmentQuery.mockResolvedValue(mockResult({ title: 'Should not run' }))

    const newTask = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'should not be processed yet' },
    })

    // Process again — circuit breaker should prevent all processing
    await processEnrichmentQueue()

    const after = getTaskById(newTask.id)!
    expect(after.labels).toContain('ai-to-process')
  })

  test('paused queue skips processing during pause', async () => {
    vi.setSystemTime(new Date('2026-02-15T12:00:00Z'))

    for (let i = 0; i < 5; i++) {
      createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: `cb pause fail ${i}` },
      })
    }
    mockEnrichmentQuery.mockRejectedValue(new Error('SDK error'))
    await processEnrichmentQueue()

    mockEnrichmentQuery.mockReset()

    // Advance by only 60s — not enough to reset the 300s pause
    vi.setSystemTime(new Date('2026-02-15T12:01:00Z'))

    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'paused task' },
    })

    await processEnrichmentQueue()

    const after = getTaskById(task.id)!
    expect(after.labels).toContain('ai-to-process')
  })

  test('circuit breaker resets after 300s pause expires', async () => {
    vi.setSystemTime(new Date('2026-02-15T12:00:00Z'))

    for (let i = 0; i < 5; i++) {
      createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: `cb reset fail ${i}` },
      })
    }
    mockEnrichmentQuery.mockRejectedValue(new Error('SDK error'))
    await processEnrichmentQueue()

    // Clear leftover failed tasks so they don't interfere
    clearPendingEnrichment()
    mockEnrichmentQuery.mockReset()

    // Advance past the 300s pause
    vi.setSystemTime(new Date('2026-02-15T12:05:01Z'))

    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'after reset task' },
    })

    mockEnrichmentQuery.mockResolvedValueOnce(
      mockResult({
        title: 'After reset task',
        priority: 0,
        labels: [],
      }),
    )

    await processEnrichmentQueue()

    const after = getTaskById(task.id)!
    expect(after.labels).not.toContain('ai-to-process')
    expect(after.title).toBe('After reset task')
  })
})

describe('processing state', () => {
  test('processing state reset function is callable', () => {
    expect(typeof _resetProcessingState).toBe('function')
    _resetProcessingState()
  })
})

describe('processing guard', () => {
  beforeEach(() => clearPendingEnrichment())

  test('concurrent processEnrichmentQueue calls do not overlap', async () => {
    createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'concurrent guard test' },
    })

    let callCount = 0
    mockEnrichmentQuery.mockImplementation(
      () =>
        new Promise((resolve) => {
          callCount++
          setTimeout(
            () =>
              resolve(
                mockResult({
                  title: 'Concurrent guard test',
                  priority: 0,
                  labels: [],
                }),
              ),
            50,
          )
        }),
    )

    // Start two concurrent calls — the second should return early
    // because the `processing` lock is held
    const p1 = processEnrichmentQueue()
    const p2 = processEnrichmentQueue()
    await Promise.all([p1, p2])

    expect(callCount).toBe(1)
  })
})

describe('fair queuing', () => {
  beforeEach(() => clearPendingEnrichment())

  test('interleaves tasks from different users', async () => {
    const db = getDb()

    // Insert a second user (password_hash required by NOT NULL constraint)
    db.prepare(
      'INSERT OR IGNORE INTO users (id, name, email, password_hash, timezone) VALUES (?, ?, ?, ?, ?)',
    ).run(2, 'user2', 'user2@test.com', 'hash', 'America/Chicago')

    // Get default project ID (Inbox, ID 1)
    const defaultProjectId = 1

    // Create tasks for user 1
    createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'user1 task A' },
    })
    createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'user1 task B' },
    })

    // Create tasks for user 2 directly in the DB (createTask requires auth setup)
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO tasks (title, user_id, project_id, labels, priority, done, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, 0, ?, ?)`,
    ).run('user2 task A', 2, defaultProjectId, JSON.stringify(['ai-to-process']), now, now)
    db.prepare(
      `INSERT INTO tasks (title, user_id, project_id, labels, priority, done, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, 0, ?, ?)`,
    ).run('user2 task B', 2, defaultProjectId, JSON.stringify(['ai-to-process']), now, now)

    // Track the order of user IDs processed
    const processedUserIds: number[] = []
    mockEnrichmentQuery.mockImplementation((_prompt, opts) => {
      if (opts?.userId) processedUserIds.push(opts.userId)
      return Promise.resolve(
        mockResult({
          title: 'Enriched',
          priority: 0,
          labels: [],
        }),
      )
    })

    await processEnrichmentQueue()

    // Should have processed tasks from both users
    expect(processedUserIds.length).toBeGreaterThanOrEqual(4)

    // Verify interleaving: first two processed should be from different users
    expect(processedUserIds[0]).not.toBe(processedUserIds[1])

    // Clean up user 2 data
    db.prepare('DELETE FROM tasks WHERE user_id = 2').run()
  })

  test('limits to 10 tasks per cycle', async () => {
    for (let i = 0; i < 15; i++) {
      createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: `limit test task ${i}` },
      })
    }

    mockEnrichmentQuery.mockResolvedValue(
      mockResult({
        title: 'Enriched',
        priority: 0,
        labels: [],
      }),
    )

    await processEnrichmentQueue()

    expect(mockEnrichmentQuery).toHaveBeenCalledTimes(10)
  })
})

describe('label merging', () => {
  beforeEach(() => clearPendingEnrichment())

  test('explicit AI labels merged with existing user labels, ai-to-process removed', async () => {
    const db = getDb()

    // Input contains explicit label-intent keyword ("label it as") so AI labels pass through
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'buy milk and clean house label it as errand' },
    })

    // Set labels to include both shopping and ai-to-process
    db.prepare('UPDATE tasks SET labels = ? WHERE id = ?').run(
      JSON.stringify(['shopping', 'ai-to-process']),
      task.id,
    )

    mockEnrichmentQuery.mockResolvedValueOnce(
      mockResult({
        title: 'Buy milk and clean house',
        priority: 0,
        labels: ['errand'],
      }),
    )

    await processEnrichmentQueue()

    const after = getTaskById(task.id)!
    expect(after.labels).toContain('shopping')
    expect(after.labels).toContain('errand')
    expect(after.labels).not.toContain('ai-to-process')
  })

  test('inferred AI labels stripped when input has no label-intent keywords', async () => {
    const db = getDb()

    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'buy milk and clean house' },
    })

    db.prepare('UPDATE tasks SET labels = ? WHERE id = ?').run(
      JSON.stringify(['shopping', 'ai-to-process']),
      task.id,
    )

    // AI returns inferred labels — guard strips them (no label-intent in input)
    mockEnrichmentQuery.mockResolvedValueOnce(
      mockResult({
        title: 'Buy milk and clean house',
        priority: 0,
        labels: ['errand', 'home'],
      }),
    )

    await processEnrichmentQueue()

    const after = getTaskById(task.id)!
    expect(after.labels).toContain('shopping')
    expect(after.labels).not.toContain('errand')
    expect(after.labels).not.toContain('home')
    expect(after.labels).not.toContain('ai-to-process')
  })

  test('all inferred labels are stripped without label-intent keywords', async () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'refill heart medication critical alert' },
    })

    // AI returns inferred labels — all should be stripped without label-intent keywords
    mockEnrichmentQuery.mockResolvedValueOnce(
      mockResult({
        title: 'Refill heart medication',
        priority: 4,
        labels: ['critical', 'medical'],
      }),
    )

    await processEnrichmentQueue()

    const after = getTaskById(task.id)!
    expect(after.labels).not.toContain('critical')
    expect(after.labels).not.toContain('medical')
    expect(after.labels).not.toContain('ai-to-process')
  })
})

describe('original_title', () => {
  test('create task sets original_title to input title', () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'call dentist tomorrow morning high priority' },
    })

    const fromDb = getTaskById(task.id)!
    expect(fromDb.original_title).toBe('call dentist tomorrow morning high priority')
  })

  test('original_title is preserved after enrichment changes title', async () => {
    clearPendingEnrichment()

    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'um call the dentist tomorrow or whatever' },
    })

    expect(task.original_title).toBe('um call the dentist tomorrow or whatever')

    mockEnrichmentQuery.mockResolvedValueOnce(
      mockResult({
        title: 'Call the dentist',
        priority: 0,
        due_at: '2026-02-20T15:00:00Z',
        labels: ['medical'],
      }),
    )

    await processEnrichmentQueue()

    const after = getTaskById(task.id)!
    expect(after.title).toBe('Call the dentist')
    expect(after.original_title).toBe('um call the dentist tomorrow or whatever')
  })
})

describe('new enrichment fields', () => {
  beforeEach(() => clearPendingEnrichment())

  test('applies auto_snooze_minutes from enrichment', async () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'water plants auto-snooze 30 minutes' },
    })

    mockEnrichmentQuery.mockResolvedValueOnce(
      mockResult({
        title: 'Water plants',
        priority: 0,
        labels: [],
        auto_snooze_minutes: 30,
      }),
    )

    await processEnrichmentQueue()

    const after = getTaskById(task.id)!
    expect(after.auto_snooze_minutes).toBe(30)
    expect(after.labels).not.toContain('ai-to-process')
  })

  test('applies recurrence_mode from_completion from enrichment', async () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'water plants every 3 days from completion' },
    })

    mockEnrichmentQuery.mockResolvedValueOnce(
      mockResult({
        title: 'Water plants',
        priority: 0,
        labels: [],
        rrule: 'FREQ=DAILY;INTERVAL=3',
        recurrence_mode: 'from_completion',
      }),
    )

    await processEnrichmentQueue()

    const after = getTaskById(task.id)!
    expect(after.recurrence_mode).toBe('from_completion')
    expect(after.rrule).toBe('FREQ=DAILY;INTERVAL=3')
  })

  test('applies notes from enrichment', async () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'call insurance about claim 847293 phone 1-800-555-0123 tomorrow high priority',
      },
    })

    mockEnrichmentQuery.mockResolvedValueOnce(
      mockResult({
        title: 'Call insurance about denied claim',
        priority: 3,
        due_at: '2026-02-20T15:00:00Z',
        labels: ['finance'],
        notes: 'Claim #847293. Call 1-800-555-0123.',
      }),
    )

    await processEnrichmentQueue()

    const after = getTaskById(task.id)!
    expect(after.notes).toBe('Claim #847293. Call 1-800-555-0123.')
    expect(after.title).toBe('Call insurance about denied claim')
    expect(after.priority).toBe(3)
  })

  test('null enrichment fields do not overwrite existing values', async () => {
    const db = getDb()

    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'task with existing meta' },
    })

    // Manually set notes and auto_snooze_minutes on the task
    db.prepare('UPDATE tasks SET notes = ?, auto_snooze_minutes = ? WHERE id = ?').run(
      'Existing notes',
      60,
      task.id,
    )

    mockEnrichmentQuery.mockResolvedValueOnce(
      mockResult({
        title: 'Task with existing meta',
        priority: 0,
        labels: [],
        auto_snooze_minutes: null,
        recurrence_mode: null,
        notes: null,
      }),
    )

    await processEnrichmentQueue()

    const after = getTaskById(task.id)!
    // null means "not mentioned" — should not overwrite existing values
    expect(after.notes).toBe('Existing notes')
    expect(after.auto_snooze_minutes).toBe(60)
  })

  test('undo reverts new enrichment fields', async () => {
    const { executeUndo } = await import('@/core/undo')

    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'undo test for new fields' },
    })

    mockEnrichmentQuery.mockResolvedValueOnce(
      mockResult({
        title: 'Undo test for new fields',
        priority: 2,
        labels: ['work'],
        auto_snooze_minutes: 45,
        notes: 'Some context notes',
      }),
    )

    await processEnrichmentQueue()

    const enriched = getTaskById(task.id)!
    expect(enriched.auto_snooze_minutes).toBe(45)
    expect(enriched.notes).toBe('Some context notes')

    executeUndo(TEST_USER_ID)

    const undone = getTaskById(task.id)!
    expect(undone.auto_snooze_minutes).toBeNull()
    expect(undone.notes).toBeNull()
    expect(undone.title).toBe('undo test for new fields')
  })
})

describe('reprocess uses original_title', () => {
  beforeEach(() => clearPendingEnrichment())

  test('enrichment sends original_title to the model, not current title', async () => {
    const db = getDb()

    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'call my dentist tomorrow morning high priority or whatever' },
    })

    // Simulate enrichment that changed the title
    db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run('Call my dentist', task.id)

    // Re-add ai-to-process label for reprocessing
    const labels = JSON.stringify(['ai-to-process'])
    db.prepare('UPDATE tasks SET labels = ? WHERE id = ?').run(labels, task.id)

    mockEnrichmentQuery.mockResolvedValueOnce(
      mockResult({
        title: 'Call my dentist',
        priority: 3,
        due_at: '2026-02-20T15:00:00Z',
        labels: ['medical'],
      }),
    )

    await processEnrichmentQueue()

    // Verify the model received the original_title, not the current title
    expect(mockEnrichmentQuery).toHaveBeenCalledTimes(1)
    const [prompt] = mockEnrichmentQuery.mock.calls[0]
    expect(prompt).toContain('call my dentist tomorrow morning high priority or whatever')
    expect(prompt).not.toContain('"Call my dentist"')
  })

  test('legacy task with null original_title falls back to current title', async () => {
    const db = getDb()

    // Create a task and null out original_title to simulate a legacy task
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'legacy task with no original' },
    })

    db.prepare('UPDATE tasks SET original_title = NULL WHERE id = ?').run(task.id)

    mockEnrichmentQuery.mockResolvedValueOnce(
      mockResult({
        title: 'Legacy task with no original',
        priority: 0,
        labels: [],
      }),
    )

    await processEnrichmentQueue()

    // Verify the model received the current title as fallback
    expect(mockEnrichmentQuery).toHaveBeenCalledTimes(1)
    const [prompt] = mockEnrichmentQuery.mock.calls[0]
    expect(prompt).toContain('legacy task with no original')
  })
})

describe('auto_snooze_minutes in task creation', () => {
  test('auto_snooze_minutes passed at creation is persisted', () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'task with auto-snooze', auto_snooze_minutes: 120, priority: 2 },
    })

    const fromDb = getTaskById(task.id)!
    expect(fromDb.auto_snooze_minutes).toBe(120)
  })

  test('auto_snooze_minutes defaults to null when not provided', () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'task without auto-snooze', priority: 1 },
    })

    const fromDb = getTaskById(task.id)!
    expect(fromDb.auto_snooze_minutes).toBeNull()
  })
})

describe('AI activity log table', () => {
  test('ai_activity_log table exists and accepts inserts', () => {
    const db = getDb()
    const now = new Date().toISOString()

    db.prepare(
      `INSERT INTO ai_activity_log (user_id, task_id, action, status, input, output, model, duration_ms, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      TEST_USER_ID,
      null,
      'enrich',
      'success',
      'test input',
      '{"title":"test"}',
      'haiku',
      500,
      null,
      now,
    )

    const rows = db
      .prepare('SELECT * FROM ai_activity_log WHERE user_id = ? AND action = ?')
      .all(TEST_USER_ID, 'enrich') as { id: number; action: string; status: string }[]

    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0].action).toBe('enrich')
    expect(rows[0].status).toBe('success')
  })
})
