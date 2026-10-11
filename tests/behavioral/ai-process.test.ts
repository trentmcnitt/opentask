/**
 * Process button — the AI half (src/core/ai/process.ts)
 *
 * The model is mocked. These pin the contract the Process modal builds on:
 * - AI off (server-wide or the user's mode) → a 'disabled' result, which the
 *   routes turn into an empty list with 200 — never an error
 * - a project id the user doesn't have is dropped, never shown
 * - ids that are not the caller's live tasks are ignored, never sent
 * - the prompt carries project descriptions and the user's ai_context
 * - duplicates only consider open one-off tasks, and groups are cleaned up
 * - nothing is written
 */

import { describe, test, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import {
  setupTestDb,
  teardownTestDb,
  seedTestUser,
  seedTestProject,
  TEST_USER_ID,
  TEST_TIMEZONE,
} from '../helpers/setup'

process.env.OPENTASK_AI_PROVIDER = 'anthropic'
process.env.ANTHROPIC_API_KEY = 'test-key'
process.env.OPENTASK_AI_INSIGHTS_MODEL = 'test-model'

vi.mock('@/core/ai/sdk', () => ({
  isAIEnabled: vi.fn(() => true),
  initAI: vi.fn(),
  aiQuery: vi.fn(),
}))

import { getDb } from '@/core/db'
import { createTask, getTaskById } from '@/core/tasks'
import { aiQuery, isAIEnabled } from '@/core/ai/sdk'
import {
  recommendProjects,
  findDuplicates,
  sanitizeRecommendations,
  sanitizeDuplicateGroups,
  validateRecommendProjectsInput,
} from '@/core/ai/process'

const mockAiQuery = vi.mocked(aiQuery)
const mockIsAIEnabled = vi.mocked(isAIEnabled)

const OTHER_USER = 2
const WORK = 10
const HOME = 11
const OTHERS_PROJECT = 20

function answer(structuredOutput: Record<string, unknown>) {
  return {
    structuredOutput,
    textResult: null,
    durationMs: 10,
    success: true,
    error: null,
  }
}

function task(title: string, input: Record<string, unknown> = {}, userId = TEST_USER_ID) {
  return createTask({ userId, userTimezone: TEST_TIMEZONE, input: { title, ...input } })
}

beforeAll(() => {
  setupTestDb()
  seedTestUser(OTHER_USER, 'other@example.com')
  seedTestProject(WORK, 'Work')
  seedTestProject(HOME, 'Home')
  seedTestProject(OTHERS_PROJECT, 'Secret', OTHER_USER)
  seedTestProject(21, 'Inbox', OTHER_USER)
  const db = getDb()
  db.prepare('UPDATE projects SET description = ? WHERE id = ?').run(
    'Client deliverables and invoices',
    WORK,
  )
  db.prepare('UPDATE users SET ai_context = ?, ai_insights_mode = ? WHERE id = ?').run(
    'I freelance as a designer',
    'api',
    TEST_USER_ID,
  )
})

afterAll(() => teardownTestDb())

afterEach(() => {
  mockAiQuery.mockReset()
  mockIsAIEnabled.mockReset()
  mockIsAIEnabled.mockReturnValue(true)
  getDb().prepare("UPDATE users SET ai_insights_mode = 'api' WHERE id = ?").run(TEST_USER_ID)
})

describe('recommendProjects', () => {
  test('AI disabled server-wide → disabled, no model call', async () => {
    mockIsAIEnabled.mockReturnValue(false)
    const t = task('Send the invoice to Acme')

    expect(await recommendProjects(TEST_USER_ID, [t.id])).toEqual({ status: 'disabled' })
    expect(mockAiQuery).not.toHaveBeenCalled()
  })

  test("the user's own AI mode off → disabled", async () => {
    getDb().prepare("UPDATE users SET ai_insights_mode = 'off' WHERE id = ?").run(TEST_USER_ID)
    const t = task('Send the invoice to Acme')

    expect(await recommendProjects(TEST_USER_ID, [t.id])).toEqual({ status: 'disabled' })
    expect(mockAiQuery).not.toHaveBeenCalled()
  })

  test('returns valid picks; a hallucinated or foreign project id is dropped', async () => {
    const invoice = task('Send the invoice to Acme')
    const gutter = task('Clean the gutters')
    const mystery = task('Look into the thing')
    const secret = task('Plan the surprise')
    mockAiQuery.mockResolvedValueOnce(
      answer({
        recommendations: [
          { task_id: invoice.id, project_id: WORK, reason: 'Client invoice' },
          { task_id: gutter.id, project_id: 999, reason: 'Made up' },
          { task_id: mystery.id, project_id: null, reason: 'Nothing fits' },
          { task_id: secret.id, project_id: OTHERS_PROJECT, reason: "Someone else's" },
        ],
      }),
    )

    const result = await recommendProjects(TEST_USER_ID, [
      invoice.id,
      gutter.id,
      mystery.id,
      secret.id,
    ])

    expect(result).toEqual({
      status: 'ok',
      items: [
        { task_id: invoice.id, project_id: WORK, reason: 'Client invoice' },
        { task_id: mystery.id, project_id: null, reason: 'Nothing fits' },
      ],
    })
  })

  test('the prompt carries descriptions and context, never the Inbox or foreign projects', async () => {
    const t = task('Send the invoice to Acme')
    mockAiQuery.mockResolvedValueOnce(answer({ recommendations: [] }))

    await recommendProjects(TEST_USER_ID, [t.id])

    const prompt = mockAiQuery.mock.calls[0][0].prompt
    expect(prompt).toContain(`[${WORK}] Work — Client deliverables and invoices`)
    expect(prompt).toContain(`[${HOME}] Home — (no description)`)
    expect(prompt).toContain('User context: I freelance as a designer')
    expect(prompt).not.toMatch(/\] Inbox/)
    expect(prompt).not.toContain('Secret')
  })

  test("ids that are not the caller's live tasks are never sent", async () => {
    const mine = task('Mine')
    const theirs = task('Theirs', {}, OTHER_USER)
    const deleted = task('Deleted')
    getDb()
      .prepare('UPDATE tasks SET deleted_at = ? WHERE id = ?')
      .run(new Date().toISOString(), deleted.id)
    mockAiQuery.mockResolvedValueOnce(
      answer({
        recommendations: [
          { task_id: theirs.id, project_id: HOME, reason: 'x' },
          { task_id: mine.id, project_id: HOME, reason: 'y' },
        ],
      }),
    )

    const result = await recommendProjects(TEST_USER_ID, [mine.id, theirs.id, deleted.id])

    const prompt = mockAiQuery.mock.calls[0][0].prompt
    expect(prompt).toContain('"Mine"')
    expect(prompt).not.toContain('"Theirs"')
    expect(prompt).not.toContain('"Deleted"')
    expect(result).toEqual({
      status: 'ok',
      items: [{ task_id: mine.id, project_id: HOME, reason: 'y' }],
    })
  })

  test('nothing to ask about → ok and empty, no model call', async () => {
    const theirs = task('Theirs', {}, OTHER_USER)
    expect(await recommendProjects(TEST_USER_ID, [theirs.id])).toEqual({ status: 'ok', items: [] })
    expect(mockAiQuery).not.toHaveBeenCalled()
  })

  test('a failed model call → failed', async () => {
    const t = task('Anything')
    mockAiQuery.mockResolvedValueOnce({
      structuredOutput: null,
      textResult: null,
      durationMs: 10,
      success: false,
      error: 'timeout',
    })
    expect(await recommendProjects(TEST_USER_ID, [t.id])).toEqual({ status: 'failed' })
  })

  test('writes nothing', async () => {
    const t = task('Send the invoice to Acme')
    const before = getTaskById(t.id)!
    mockAiQuery.mockResolvedValueOnce(
      answer({ recommendations: [{ task_id: t.id, project_id: WORK, reason: 'Client' }] }),
    )

    await recommendProjects(TEST_USER_ID, [t.id])

    expect(getTaskById(t.id)).toEqual(before)
  })

  test('input: 1–100 positive ids', () => {
    expect(validateRecommendProjectsInput({ ids: [1, 2] })).toEqual({ ids: [1, 2] })
    expect(() => validateRecommendProjectsInput({ ids: [] })).toThrow()
    expect(() => validateRecommendProjectsInput({ ids: [0] })).toThrow()
    expect(() =>
      validateRecommendProjectsInput({ ids: Array.from({ length: 101 }, (_, i) => i + 1) }),
    ).toThrow()
  })
})

describe('sanitizeRecommendations', () => {
  test('first entry per task wins, order follows the request', () => {
    expect(
      sanitizeRecommendations(
        [
          { task_id: 2, project_id: 5, reason: 'b' },
          { task_id: 1, project_id: null, reason: 'a' },
          { task_id: 2, project_id: null, reason: 'dup' },
          { task_id: 3, project_id: 5, reason: 'not asked' },
        ],
        [1, 2],
        new Set([5]),
      ),
    ).toEqual([
      { task_id: 1, project_id: null, reason: 'a' },
      { task_id: 2, project_id: 5, reason: 'b' },
    ])
  })
})

describe('findDuplicates', () => {
  test('AI disabled → disabled, no model call', async () => {
    mockIsAIEnabled.mockReturnValue(false)
    expect(await findDuplicates(TEST_USER_ID)).toEqual({ status: 'disabled' })
    expect(mockAiQuery).not.toHaveBeenCalled()
  })

  test('only open one-off tasks are candidates; groups are cleaned', async () => {
    const a = task('Call the dentist')
    const b = task('Phone dentist about the cleaning')
    const recurring = task('Water plants', { rrule: 'FREQ=WEEKLY;BYDAY=MO' })
    const done = task('Old dentist call')
    getDb().prepare('UPDATE tasks SET done = 1 WHERE id = ?').run(done.id)
    const theirs = task('Call the dentist', {}, OTHER_USER)
    mockAiQuery.mockResolvedValueOnce(
      answer({
        groups: [
          { task_ids: [a.id, b.id, a.id, 99999], reason: 'Same call' },
          { task_ids: [recurring.id, done.id], reason: 'Not candidates' },
          { task_ids: [b.id, theirs.id], reason: 'b already used' },
        ],
      }),
    )

    const result = await findDuplicates(TEST_USER_ID)

    const prompt = mockAiQuery.mock.calls[0][0].prompt
    expect(prompt).toContain(`[${a.id}] "Call the dentist"`)
    expect(prompt).not.toContain('Water plants')
    expect(prompt).not.toContain('Old dentist call')
    expect(result).toEqual({
      status: 'ok',
      items: [{ task_ids: [a.id, b.id], reason: 'Same call' }],
    })
  })

  test('sanitizeDuplicateGroups drops groups that fall under two tasks', () => {
    expect(
      sanitizeDuplicateGroups(
        [
          { task_ids: [1, 2], reason: 'x' },
          { task_ids: [2, 3], reason: 'y' },
          { task_ids: [4], reason: 'z' },
        ],
        new Set([1, 2, 3, 4]),
      ),
    ).toEqual([{ task_ids: [1, 2], reason: 'x' }])
  })
})
