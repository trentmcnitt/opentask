/**
 * AI enrichment behavioral tests
 *
 * Tests the label-based enrichment pipeline with mocked SDK responses.
 * Verifies that:
 * - Tasks created with title-only get the `ai-to-process` label when AI is enabled
 * - Tasks created with fields set skip AI enrichment
 * - The enrichment queue picks up tasks with `ai-to-process` label
 * - Failed enrichments use retry logic (ai-failed after 2 attempts)
 * - In-memory processing guard prevents double-processing
 * - Circuit breaker trips after rapid failures and resets after pause
 * - Fair queuing interleaves tasks from different users
 * - Label merging combines AI labels with existing user labels
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import {
  setupTestDb,
  teardownTestDb,
  seedTestLabels,
  TEST_USER_ID,
  TEST_TIMEZONE,
} from '../helpers/setup'

// Set provider and models so resolveFeatureAIConfig() works in tests (no real API calls are made)
process.env.OPENTASK_AI_PROVIDER = 'anthropic'
process.env.ANTHROPIC_API_KEY = 'test-key'
process.env.OPENTASK_AI_ENRICHMENT_MODEL = 'test-model'

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
  SLOT_WAIT_LIMIT_MS,
} from '@/core/ai/enrichment'
import { enrichmentQuery } from '@/core/ai/enrichment-slot'
import { SlotUnavailableError } from '@/core/ai/slot-shared'

const mockEnrichmentQuery = vi.mocked(enrichmentQuery)

/** Helper to build a mock enrichment result */
function mockResult(overrides: Record<string, unknown> = {}) {
  return {
    structuredOutput: {
      title: 'Clean title',
      priority: 3,
      due_at: '2026-02-20T08:00:00',
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
  // §7.2: these tests are about enrichment triggering, not label gating — the
  // user already has these domain labels.
  seedTestLabels(['shopping', 'work'])
  // Set enrichment mode to 'sdk' so tests use the mocked enrichmentQuery slot path
  const db = getDb()
  db.prepare("UPDATE users SET ai_enrichment_mode = 'sdk' WHERE id = ?").run(TEST_USER_ID)
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

  test('enrich:true asks for enrichment even with fields already set', () => {
    // A caller that sends a schedule is disqualified from the title-only
    // trigger; `enrich` opts back in, so what the user actually said is still
    // read. (The Reminders quick add now sends only the title and lets the
    // server apply the default slot — see rm-default-slot.test.ts.)
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'every friday evening think about the week ahead',
        is_reminder: true,
        rrule: 'FREQ=DAILY;BYHOUR=16;BYMINUTE=0',
        enrich: true,
      },
    })

    const fromDb = getTaskById(task.id)
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
        due_at: '2026-02-20T08:00:00',
        labels: ['errand'],
      }),
    )

    await processEnrichmentQueue()

    const after = getTaskById(task.id)!
    expect(after.title).toBe('Call dentist')
    expect(after.priority).toBe(3)
    // 8 AM CST (UTC-6) = 14:00 UTC
    expect(after.due_at).toBe('2026-02-20T14:00:00.000Z')
    expect(after.labels).not.toContain('errand')
    expect(after.labels).not.toContain('ai-to-process')
  })

  test('a target the AI sets stamps target_set_at (Upcoming, 2026-10-12)', async () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'renew the passport by friday' },
    })
    getDb()
      .prepare('UPDATE tasks SET target_set_at = ? WHERE id = ?')
      .run('2026-01-01T00:00:00.000Z', task.id)
    mockEnrichmentQuery.mockResolvedValueOnce(
      mockResult({ title: 'Renew the passport', due_at: '2026-02-20T08:00:00', labels: [] }),
    )
    await processEnrichmentQueue()
    const after = getTaskById(task.id)!
    expect(after.due_at).toBe('2026-02-20T14:00:00.000Z')
    expect(after.target_set_at).not.toBe('2026-01-01T00:00:00.000Z')
    expect(Date.now() - Date.parse(after.target_set_at!)).toBeLessThan(60_000)
    // (A first enrichment is not an undo entry of its own: the create's undo
    // removes the task. Undo of a later write restores the stamp — UP-tests.)
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
        due_at: '2026-02-17T09:00:00',
        labels: [],
        rrule: 'FREQ=WEEKLY;BYDAY=TU',
      }),
    )

    await processEnrichmentQueue()

    const after = getTaskById(task.id)!
    // The rule takes the time of the date the model sent (09:00, 2026-10-12).
    expect(after.rrule).toBe('FREQ=WEEKLY;BYDAY=TU;BYHOUR=9;BYMINUTE=0')
    expect(after.anchor_time).toBe('09:00')
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

  test('initial enrichment does not create a separate undo entry', async () => {
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

    // The most recent undo entry should be 'create', not 'edit' —
    // initial enrichment of a newly created task skips the undo log
    // so that a single undo removes the task entirely.
    const db = getDb()
    const undoEntry = db
      .prepare('SELECT * FROM undo_log WHERE user_id = ? ORDER BY id DESC LIMIT 1')
      .get(TEST_USER_ID) as { id: number; action: string; description: string } | undefined

    expect(undoEntry).toBeDefined()
    expect(undoEntry!.action).toBe('create')
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
        due_at: '2026-02-10T11:00:00',
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

/**
 * A DEAD SLOT SPENDS NO ATTEMPT (2026-10-28): the warm slot's warmup was
 * refused on prod, the slot died, and the on-demand attempt and the next
 * minute's retry both met it dead — five tasks ai-failed that the model never
 * saw. Now a task the slot could not take waits for it, up to
 * SLOT_WAIT_LIMIT_MS.
 */
describe('slot unavailable', () => {
  beforeEach(() => clearPendingEnrichment())
  afterEach(() => vi.useRealTimers())

  const unavailable = () => new SlotUnavailableError('Enrichment', 'dead')

  test('spends no attempt: the task waits through several tries, then is enriched', async () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'slot dead, wait for it' },
    })
    mockEnrichmentQuery.mockRejectedValueOnce(unavailable())
    await enrichSingleTask(task.id, TEST_USER_ID)
    for (let i = 0; i < 3; i++) {
      mockEnrichmentQuery.mockRejectedValueOnce(unavailable())
      await processEnrichmentQueue()
    }
    const waiting = getTaskById(task.id)!
    expect(waiting.labels).toContain('ai-to-process')
    expect(waiting.labels).not.toContain('ai-failed')

    mockEnrichmentQuery.mockResolvedValueOnce(
      mockResult({ title: 'Slot dead, wait for it', priority: 0, labels: [] }),
    )
    await processEnrichmentQueue()
    const done = getTaskById(task.id)!
    expect(done.labels).not.toContain('ai-to-process')
    expect(done.labels).not.toContain('ai-failed')
  })

  test('a real failure after waiting still has both its attempts', async () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'wait, then fail once' },
    })
    mockEnrichmentQuery.mockRejectedValueOnce(unavailable())
    await processEnrichmentQueue()
    mockEnrichmentQuery.mockRejectedValueOnce(new Error('SDK error'))
    await processEnrichmentQueue()
    expect(getTaskById(task.id)!.labels).toContain('ai-to-process')
    mockEnrichmentQuery.mockRejectedValueOnce(new Error('SDK error 2'))
    await processEnrichmentQueue()
    expect(getTaskById(task.id)!.labels).toContain('ai-failed')
  })

  test('waiting longer than SLOT_WAIT_LIMIT_MS marks it ai-failed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const start = new Date('2026-10-28T12:00:00Z')
    vi.setSystemTime(start)
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'slot dead for good' },
    })
    mockEnrichmentQuery.mockRejectedValueOnce(unavailable())
    await processEnrichmentQueue()
    vi.setSystemTime(start.getTime() + SLOT_WAIT_LIMIT_MS - 1)
    mockEnrichmentQuery.mockRejectedValueOnce(unavailable())
    await processEnrichmentQueue()
    expect(getTaskById(task.id)!.labels).toContain('ai-to-process')

    vi.setSystemTime(start.getTime() + SLOT_WAIT_LIMIT_MS)
    mockEnrichmentQuery.mockRejectedValueOnce(unavailable())
    await processEnrichmentQueue()
    const after = getTaskById(task.id)!
    expect(after.labels).not.toContain('ai-to-process')
    expect(after.labels).toContain('ai-failed')
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
    // Set enrichment mode to 'sdk' so it uses the mocked slot path
    db.prepare("UPDATE users SET ai_enrichment_mode = 'sdk' WHERE id = 2").run()

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

describe('local→UTC timezone conversion', () => {
  // The answers below are dated 2026-02-20: frozen before it, so the past-date
  // guard (dropUnstatedPastDates) never sees them as past, whenever this runs.
  beforeEach(() => {
    clearPendingEnrichment()
    vi.setSystemTime(new Date('2026-02-15T16:00:00Z'))
  })
  afterEach(() => vi.useRealTimers())

  test('converts local time to UTC correctly across DST boundary', async () => {
    // March 4 is CST (UTC-6), but March 9 is CDT (UTC-5) — DST starts March 8
    vi.setSystemTime(new Date('2026-03-04T16:00:00Z'))

    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'team meeting next Monday at 10am' },
    })

    mockEnrichmentQuery.mockResolvedValueOnce(
      mockResult({
        title: 'Team standup',
        due_at: '2026-03-09T10:00:00', // March 9 = CDT (UTC-5)
        rrule: 'FREQ=WEEKLY;BYDAY=MO',
      }),
    )

    await processEnrichmentQueue()

    const after = getTaskById(task.id)!
    // 10 AM CDT (UTC-5) = 15:00 UTC, NOT 16:00 UTC (CST offset)
    expect(after.due_at).toBe('2026-03-09T15:00:00.000Z')
  })

  test('strips Z suffix if AI includes it despite instructions', async () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'test z stripping' },
    })

    mockEnrichmentQuery.mockResolvedValueOnce(
      mockResult({ title: 'Test Z stripping', due_at: '2026-02-20T09:00:00Z' }),
    )

    await processEnrichmentQueue()

    const after = getTaskById(task.id)!
    // Z stripped, then parsed as local → 9 AM CST (UTC-6) = 15:00 UTC
    expect(after.due_at).toBe('2026-02-20T15:00:00.000Z')
  })

  test('strips timezone offset if AI includes one despite instructions', async () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'test offset stripping' },
    })

    mockEnrichmentQuery.mockResolvedValueOnce(
      mockResult({ title: 'Test offset stripping', due_at: '2026-02-20T09:00:00-06:00' }),
    )

    await processEnrichmentQueue()

    const after = getTaskById(task.id)!
    // Offset stripped, then parsed as local → 9 AM CST (UTC-6) = 15:00 UTC
    expect(after.due_at).toBe('2026-02-20T15:00:00.000Z')
  })

  test('strips colon-free timezone offset', async () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'test colon-free offset' },
    })

    mockEnrichmentQuery.mockResolvedValueOnce(
      mockResult({ title: 'Test colon-free offset', due_at: '2026-02-20T09:00:00-0600' }),
    )

    await processEnrichmentQueue()

    const after = getTaskById(task.id)!
    // Colon-free offset stripped, then parsed as local → 9 AM CST = 15:00 UTC
    expect(after.due_at).toBe('2026-02-20T15:00:00.000Z')
  })

  test('sets due_at to null when AI returns invalid date', async () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'test invalid date' },
    })

    // Feb 30 passes Zod's new Date() refine but fails Luxon's stricter parsing
    mockEnrichmentQuery.mockResolvedValueOnce(
      mockResult({ title: 'Test invalid date', due_at: '2026-02-30T09:00:00' }),
    )

    await processEnrichmentQueue()

    const after = getTaskById(task.id)!
    expect(after.due_at).toBeNull()
  })

  test('snaps due_at forward to a BYDAY-valid weekday when AI picks a conflicting day', async () => {
    // Repro of the demo-account bug: AI returned Fri Apr 17 with rrule BYDAY=TH.
    // The snap should move the due_at forward to the next Thursday (Apr 23),
    // preserving the 9:00 AM local time.
    vi.setSystemTime(new Date('2026-04-15T19:16:00Z'))

    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'weekly newsletter post thursdays 9am' },
    })

    mockEnrichmentQuery.mockResolvedValueOnce(
      mockResult({
        title: 'Weekly newsletter post',
        due_at: '2026-04-17T09:00:00', // Friday — wrong weekday for BYDAY=TH
        rrule: 'FREQ=WEEKLY;BYDAY=TH',
      }),
    )

    await processEnrichmentQueue()

    const after = getTaskById(task.id)!
    // Snapped forward to Thursday Apr 23 at 9 AM CDT = 14:00 UTC.
    expect(after.due_at).toBe('2026-04-23T14:00:00.000Z')
    expect(after.rrule).toBe('FREQ=WEEKLY;BYDAY=TH;BYHOUR=9;BYMINUTE=0')
  })

  test('does not snap due_at when weekday already matches BYDAY', async () => {
    vi.setSystemTime(new Date('2026-04-15T19:16:00Z'))

    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'weekly thursday task' },
    })

    mockEnrichmentQuery.mockResolvedValueOnce(
      mockResult({
        title: 'Weekly Thursday task',
        due_at: '2026-04-16T09:00:00', // Thursday — correct
        rrule: 'FREQ=WEEKLY;BYDAY=TH',
      }),
    )

    await processEnrichmentQueue()

    const after = getTaskById(task.id)!
    // 9 AM CDT = 14:00 UTC, unchanged.
    expect(after.due_at).toBe('2026-04-16T14:00:00.000Z')
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
        due_at: '2026-02-20T09:00:00',
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
    expect(after.rrule).toBe('FREQ=DAILY;INTERVAL=3;BYHOUR=8;BYMINUTE=0')
  })

  test('an every-N rule with no date starts on the enrichment day (creation day is day 0, 2026-10-12)', async () => {
    // Mon Oct 12 2026, 10:00 Chicago. Before its 8 PM → today; the 2020 epoch's
    // grid used to say Oct 22.
    vi.setSystemTime(new Date('2026-10-12T15:00:00Z'))
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'check the water softener every 22 days at 8pm' },
    })
    mockEnrichmentQuery.mockResolvedValueOnce(
      mockResult({
        title: 'Check the water softener',
        priority: 0,
        due_at: null,
        labels: [],
        rrule: 'FREQ=DAILY;INTERVAL=22;BYHOUR=20;BYMINUTE=0',
      }),
    )

    await processEnrichmentQueue()

    const after = getTaskById(task.id)!
    expect(after.rrule).toBe('FREQ=DAILY;INTERVAL=22;BYHOUR=20;BYMINUTE=0')
    // 8 PM CDT = 01:00 UTC the next day.
    expect(after.due_at).toBe('2026-10-13T01:00:00.000Z')
    expect(after.occurrence_at).toBe(after.due_at)
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
        due_at: '2026-02-20T09:00:00',
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

  test('undo of enriched new task soft-deletes it (single undo)', async () => {
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

    // Single undo should soft-delete the task (undoing the 'create' action)
    // because initial enrichment doesn't log a separate undo entry
    executeUndo(TEST_USER_ID)

    const undone = getTaskById(task.id)!
    expect(undone.deleted_at).not.toBeNull()
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
        due_at: '2026-02-20T09:00:00',
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

/**
 * §5, review finding 2026-09-08: enrichment writes `due_at`, `rrule` and the
 * derived anchors with raw SQL, so it bypasses the quota guards in
 * `collectFieldChanges` entirely. Two ways in: a user re-enriches a quota by
 * adding `ai-to-process`, or an enrichment is in flight while the task is
 * converted into one. `applyEnrichment` re-reads the task before writing, so
 * the guard sits on that re-read.
 */
describe('enrichment leaves a quota dateless', () => {
  beforeEach(() => clearPendingEnrichment())

  test('a date and a schedule from the model are dropped on a tracked task', async () => {
    const quota = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'eat beef four times a week', progress_target: 4, rrule: 'FREQ=WEEKLY' },
    })
    expect(getTaskById(quota.id)!.due_at).toBeNull()

    // Re-enrichment: the user adds the trigger label back by hand.
    getDb()
      .prepare(
        "UPDATE tasks SET labels = json_insert(labels, '$[#]', 'ai-to-process') WHERE id = ?",
      )
      .run(quota.id)

    mockEnrichmentQuery.mockResolvedValueOnce(
      mockResult({
        title: 'Eat beef',
        priority: 2,
        labels: [],
        due_at: '2026-02-20T08:00:00',
        rrule: 'FREQ=WEEKLY;BYDAY=TU',
        recurrence_mode: 'from_completion',
      }),
    )

    await processEnrichmentQueue()

    const after = getTaskById(quota.id)!
    // Nothing schedule-shaped landed...
    expect(after.due_at).toBeNull()
    expect(after.original_due_at).toBeNull()
    expect(after.rrule).toBe('FREQ=WEEKLY')
    expect(after.anchor_dow).toBeNull()
    expect(after.recurrence_mode).toBe('from_due')
    // ...but the fields that mean the same thing on a quota still did.
    expect(after.title).toBe('Eat beef')
    expect(after.priority).toBe(2)
    expect(after.labels).not.toContain('ai-to-process')
  })
})

describe('every rule has a time; a repeat with no day starts today (2026-10-12)', () => {
  beforeEach(() => clearPendingEnrichment())
  afterEach(() => vi.useRealTimers())

  test("a timeless rule with no date takes the user's Morning time (every rule has a time, 2026-10-12)", async () => {
    // Mon Oct 12 2026, 07:00 Chicago; Morning time 08:30 (Trent's own).
    vi.setSystemTime(new Date('2026-10-12T12:00:00Z'))
    const db = getDb()
    const before = db.prepare('SELECT morning_time FROM users WHERE id = ?').get(TEST_USER_ID) as {
      morning_time: string
    }
    db.prepare("UPDATE users SET morning_time = '08:30' WHERE id = ?").run(TEST_USER_ID)
    try {
      const task = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'stretch every day' },
      })
      mockEnrichmentQuery.mockResolvedValueOnce(
        mockResult({
          title: 'Stretch',
          priority: 0,
          due_at: null,
          labels: [],
          rrule: 'FREQ=DAILY',
        }),
      )

      await processEnrichmentQueue()

      const after = getTaskById(task.id)!
      expect(after.rrule).toBe('FREQ=DAILY;BYHOUR=8;BYMINUTE=30')
      expect(after.anchor_time).toBe('08:30')
      // Today at 08:30 CDT = 13:30 UTC: before its time, so the creation day.
      expect(after.due_at).toBe('2026-10-12T13:30:00.000Z')
    } finally {
      db.prepare('UPDATE users SET morning_time = ? WHERE id = ?').run(
        before.morning_time,
        TEST_USER_ID,
      )
    }
  })

  test("a Morning linked to a period is the period's start, in the prompt and the rule (anchor times, 2026-10-21)", async () => {
    vi.setSystemTime(new Date('2026-10-12T12:00:00Z'))
    const db = getDb()
    const slot = db
      .prepare("SELECT id FROM time_slots WHERE user_id = ? AND label = 'Morning'")
      .get(TEST_USER_ID) as { id: number }
    const before = db.prepare('SELECT start_time FROM time_slots WHERE id = ?').get(slot.id) as {
      start_time: string
    }
    // Linked, with a stale 09:00 snapshot: the period's 08:45 must win.
    db.prepare("UPDATE time_slots SET start_time = '08:45' WHERE id = ?").run(slot.id)
    db.prepare("UPDATE users SET morning_slot_id = ?, morning_time = '09:00' WHERE id = ?").run(
      slot.id,
      TEST_USER_ID,
    )
    try {
      const task = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'water plants every day' },
      })
      mockEnrichmentQuery.mockClear()
      mockEnrichmentQuery.mockResolvedValueOnce(
        mockResult({
          title: 'Water plants',
          priority: 0,
          due_at: null,
          labels: [],
          rrule: 'FREQ=DAILY',
        }),
      )

      await processEnrichmentQueue()

      const [prompt] = mockEnrichmentQuery.mock.calls[0]
      expect(prompt).toContain('8:45 AM')
      expect(getTaskById(task.id)!.rrule).toBe('FREQ=DAILY;BYHOUR=8;BYMINUTE=45')
    } finally {
      db.prepare('UPDATE users SET morning_slot_id = NULL WHERE id = ?').run(TEST_USER_ID)
      db.prepare('UPDATE time_slots SET start_time = ? WHERE id = ?').run(
        before.start_time,
        slot.id,
      )
    }
  })

  test('a quota re-enriched with a bare period rule keeps it bare', async () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Run', rrule: 'FREQ=WEEKLY', progress_target: 3 },
    })
    getDb().prepare(`UPDATE tasks SET labels = '["ai-to-process"]' WHERE id = ?`).run(task.id)
    mockEnrichmentQuery.mockResolvedValueOnce(
      mockResult({
        title: 'Run',
        priority: 0,
        due_at: null,
        labels: [],
        rrule: 'FREQ=WEEKLY;BYDAY=MO',
      }),
    )

    await processEnrichmentQueue()

    // §5: enrichment leaves a quota's schedule alone entirely.
    expect(getTaskById(task.id)!.rrule).toBe('FREQ=WEEKLY')
  })

  test('"every 2 weeks" with no day starts today: the model\'s Monday becomes Thursday (2026-10-12)', async () => {
    // Thu Oct 15 2026, 07:00 Chicago — before the 09:00 Morning time.
    vi.setSystemTime(new Date('2026-10-15T12:00:00Z'))
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'clean the fish tank every 2 weeks' },
    })
    mockEnrichmentQuery.mockResolvedValueOnce(
      mockResult({
        title: 'Clean the fish tank',
        priority: 0,
        due_at: null,
        labels: [],
        rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO',
      }),
    )

    await processEnrichmentQueue()

    const after = getTaskById(task.id)!
    const morning = (
      getDb().prepare('SELECT morning_time FROM users WHERE id = ?').get(TEST_USER_ID) as {
        morning_time: string
      }
    ).morning_time
    const [h, m] = morning.split(':').map(Number)
    expect(after.rrule).toBe(`FREQ=WEEKLY;INTERVAL=2;BYDAY=TH;BYHOUR=${h};BYMINUTE=${m}`)
    // The creation day is day 0: today, at Morning time.
    expect(after.due_at!.slice(0, 10)).toBe('2026-10-15')
  })
})
