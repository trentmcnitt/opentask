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
 * - Process is its own AI feature (2026-10-22): its own mode
 *   (`ai_process_mode`), model config and default timeout — independent of
 *   Insights — and it runs with the AI shelve switch unset
 */

import { describe, test, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { shelvedAiFeaturesOn } from '@/core/ai/shelved'
import { logAIActivity, getAIActivity } from '@/core/ai/activity'
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
  db.prepare('UPDATE users SET ai_context = ?, ai_process_mode = ? WHERE id = ?').run(
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
  getDb()
    .prepare(
      `UPDATE users SET ai_process_mode = 'api', ai_insights_mode = 'api',
         ai_insights_timeout_ms = NULL WHERE id = ?`,
    )
    .run(TEST_USER_ID)
  vi.unstubAllEnvs()
})

describe('recommendProjects', () => {
  test('AI disabled server-wide → disabled, no model call', async () => {
    mockIsAIEnabled.mockReturnValue(false)
    const t = task('Send the invoice to Acme')

    expect(await recommendProjects(TEST_USER_ID, [t.id])).toEqual({ status: 'disabled' })
    expect(mockAiQuery).not.toHaveBeenCalled()
  })

  test("the user's own Process mode off → disabled", async () => {
    getDb().prepare("UPDATE users SET ai_process_mode = 'off' WHERE id = ?").run(TEST_USER_ID)
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

describe('Process is its own AI feature (2026-10-22)', () => {
  const setModes = (process_: string, insights: string) =>
    getDb()
      .prepare('UPDATE users SET ai_process_mode = ?, ai_insights_mode = ? WHERE id = ?')
      .run(process_, insights, TEST_USER_ID)

  test('Insights off does not turn Process off', async () => {
    setModes('api', 'off')
    const t = task('Send the invoice to Acme')
    mockAiQuery.mockResolvedValueOnce(answer({ recommendations: [] }))
    expect((await recommendProjects(TEST_USER_ID, [t.id])).status).toBe('ok')
    mockAiQuery.mockResolvedValueOnce(answer({ groups: [] }))
    expect((await findDuplicates(TEST_USER_ID)).status).toBe('ok')
    expect(mockAiQuery).toHaveBeenCalledTimes(2)
  })

  test('Process off turns both steps off, whatever Insights says', async () => {
    setModes('off', 'api')
    const t = task('Send the invoice to Acme')
    expect(await recommendProjects(TEST_USER_ID, [t.id])).toEqual({ status: 'disabled' })
    expect(await findDuplicates(TEST_USER_ID)).toEqual({ status: 'disabled' })
    expect(mockAiQuery).not.toHaveBeenCalled()
  })

  test('the model is OPENTASK_AI_PROCESS_MODEL, else the Insights one', async () => {
    mockAiQuery.mockResolvedValue(answer({ groups: [] }))
    await findDuplicates(TEST_USER_ID)
    expect(mockAiQuery.mock.calls[0][0].model).toBe('test-model') // the Insights model

    vi.stubEnv('OPENTASK_AI_PROCESS_MODEL', 'process-model')
    await findDuplicates(TEST_USER_ID)
    expect(mockAiQuery.mock.calls[1][0].model).toBe('process-model')
    expect(mockAiQuery.mock.calls[1][0].provider).toBe('anthropic')
  })

  test('SDK mode: the Process SDK model, falling back to the Insights one', async () => {
    setModes('sdk', 'off')
    vi.stubEnv('OPENTASK_AI_INSIGHTS_SDK_MODEL', 'opus')
    mockAiQuery.mockResolvedValue(answer({ groups: [] }))
    await findDuplicates(TEST_USER_ID)
    expect(mockAiQuery.mock.calls[0][0]).toMatchObject({
      provider: 'sdk',
      model: 'opus',
      maxTurns: 3,
      timeoutMs: 300_000,
    })
    vi.stubEnv('OPENTASK_AI_PROCESS_SDK_MODEL', 'haiku')
    await findDuplicates(TEST_USER_ID)
    expect(mockAiQuery.mock.calls[1][0].model).toBe('haiku')
  })

  test("its timeout is Process's default, never the user's Insights override", async () => {
    getDb()
      .prepare('UPDATE users SET ai_insights_timeout_ms = 1200000 WHERE id = ?')
      .run(TEST_USER_ID)
    mockAiQuery.mockResolvedValueOnce(answer({ groups: [] }))
    await findDuplicates(TEST_USER_ID)
    expect(mockAiQuery.mock.calls[0][0].timeoutMs).toBe(180_000)
  })

  test("runs with the AI shelve switch unset (What's Next/Insights/Quick Take shelved)", async () => {
    vi.stubEnv('OPENTASK_AI_UNSHELVE', '')
    expect(shelvedAiFeaturesOn()).toBe(false)
    setModes('api', 'api')
    const t = task('Send the invoice to Acme')
    mockAiQuery.mockResolvedValueOnce(
      answer({ recommendations: [{ task_id: t.id, project_id: WORK, reason: 'Invoice' }] }),
    )
    expect(await recommendProjects(TEST_USER_ID, [t.id])).toEqual({
      status: 'ok',
      items: [{ task_id: t.id, project_id: WORK, reason: 'Invoice' }],
    })
    mockAiQuery.mockResolvedValueOnce(answer({ groups: [] }))
    expect(await findDuplicates(TEST_USER_ID)).toEqual({ status: 'ok', items: [] })
  })
})

describe("AI Status's Process filter", () => {
  test('`process` matches both of its logged actions, nothing else', () => {
    const log = (action: string) =>
      logAIActivity({
        user_id: TEST_USER_ID,
        task_id: null,
        action,
        status: 'success',
        input: null,
        output: null,
        model: 'm',
        duration_ms: 1,
        error: null,
        provider: 'anthropic',
      })
    log('process_projects')
    log('process_duplicates')
    log('enrich')

    const actions = getAIActivity(TEST_USER_ID, { action: 'process' }).map((e) => e.action)
    expect(actions.sort()).toEqual(['process_duplicates', 'process_projects'])
    expect(getAIActivity(TEST_USER_ID, { action: 'enrich' }).map((e) => e.action)).toEqual([
      'enrich',
    ])
  })
})
