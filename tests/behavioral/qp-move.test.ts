/**
 * QP-060..: moving a quota prompt to another period (2026-09-25) — the period
 * chips in a prompt's bubble (web) and the hold list (watch). Both write the
 * quota editor's own PATCH of `quota_prompt_config`; these pin the server half
 * (the owner-slot check, the payload's `numbers`/`slot_id`) and the pure
 * helpers both clients lean on (`movedPromptConfig`, `applyPromptMoves`).
 *
 * The test user has the five default periods: Early morning 07:00, Morning
 * 09:00, Midday 12:00, Afternoon 16:00, Evening 20:30. The clock is frozen on
 * Thursday 2026-01-15, 10:00 Chicago.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { getDb } from '@/core/db'
import { bulkEdit, createTask, getTaskById, updateTask } from '@/core/tasks'
import { getQuotaPromptsBySlot, type QuotaPrompt } from '@/core/tasks/quota-prompts'
import { listTimeSlots } from '@/core/time-slots'
import { deleteTimeSlot } from '@/core/time-slots/edit'
import { executeUndo } from '@/core/undo'
import { ValidationError } from '@/core/errors'
import { validateTaskUpdate } from '@/core/validation'
import { applyPromptMoves, movedPromptConfig, promptKey } from '@/lib/quota-prompts'
import {
  setupTestDb,
  teardownTestDb,
  seedTestUser,
  seedTestProject,
  TEST_TIMEZONE,
  TEST_USER_ID,
} from '../helpers/setup'

const THU = new Date('2026-01-15T16:00:00Z')
const TODAY = '2026-01-15'
const base = { userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE }

function quota(title: string, rrule: string, target: number, userId = TEST_USER_ID, extra = {}) {
  return createTask({
    userId,
    userTimezone: TEST_TIMEZONE,
    input: { title, rrule, progress_target: target, is_tracked: true, ...extra },
  })
}

function slotId(label: string, userId = TEST_USER_ID): number {
  const slot = listTimeSlots(userId).find((s) => s.label === label)
  if (!slot) throw new Error(`no slot ${label}`)
  return slot.id
}

function configure(taskId: number, config: object | null, userId = TEST_USER_ID) {
  return updateTask({
    userId,
    userTimezone: TEST_TIMEZONE,
    taskId,
    input: validateTaskUpdate({ quota_prompt_config: config }),
  })
}

/**
 * Every prompt today, flattened in period order (as GET /api/reminders lists
 * them), with the label of the period it sits in.
 */
function prompts(): (QuotaPrompt & { slot: string | null })[] {
  const slots = listTimeSlots(TEST_USER_ID)
  const bySlot = getQuotaPromptsBySlot(TEST_USER_ID, TEST_TIMEZONE, THU)
  return slots.flatMap((s) => (bySlot.get(s.id) ?? []).map((p) => ({ ...p, slot: s.label })))
}

/** The move a client makes: the stored config, merged, PATCHed. */
function move(prompt: QuotaPrompt, toLabel: string) {
  const stored = getTaskById(prompt.task_id)!.quota_prompt_config
  return configure(prompt.task_id, movedPromptConfig(stored, prompt, slotId(toLabel)))
}

beforeEach(() => {
  vi.setSystemTime(THU)
  setupTestDb()
  delete process.env.OPENTASK_QUOTA_PROMPTS
  getDb()
    .prepare('UPDATE users SET quota_prompt_slot_id = ? WHERE id = ?')
    .run(slotId('Morning'), TEST_USER_ID)
})
afterEach(() => {
  vi.useRealTimers()
  teardownTestDb()
})

describe('Quota prompt moves — the owner-slot check', () => {
  test("QP-060: a config naming a slot the user doesn't have is refused, slot_id and numbers alike", () => {
    seedTestUser(2, 'casey@example.com', TEST_TIMEZONE)
    const q = quota('Cook vegetables', 'FREQ=WEEKLY', 5)
    const theirs = slotId('Evening', 2)

    expect(() => configure(q.id, { slot_id: theirs })).toThrow(ValidationError)
    expect(() => configure(q.id, { numbers: { '1': 999999 } })).toThrow(ValidationError)
    // Nothing was written.
    expect(getTaskById(q.id)!.quota_prompt_config).toBeNull()

    configure(q.id, { slot_id: slotId('Evening') })
    expect(getTaskById(q.id)!.quota_prompt_config).toEqual({ slot_id: slotId('Evening') })
  })

  test('QP-061: a stored id whose slot was deleted since does not block a re-save', () => {
    const q = quota('Cook vegetables', 'FREQ=WEEKLY', 5)
    const afternoon = slotId('Afternoon')
    configure(q.id, { slot_id: afternoon })
    deleteTimeSlot({ ...base, slotId: afternoon })

    // The editor re-sends the whole config — the stale id with it.
    configure(q.id, { enabled: true, slot_id: afternoon })
    expect(getTaskById(q.id)!.quota_prompt_config).toEqual({ enabled: true, slot_id: afternoon })
    // A NEW stale id is still refused.
    expect(() =>
      configure(q.id, { slot_id: afternoon, numbers: { '1': afternoon + 1000 } }),
    ).toThrow(ValidationError)
  })

  test('QP-062: create and bulk edit are held to the same check', () => {
    seedTestUser(2, 'casey@example.com', TEST_TIMEZONE)
    const theirs = slotId('Morning', 2)
    expect(() =>
      quota('Cook vegetables', 'FREQ=WEEKLY', 5, TEST_USER_ID, {
        quota_prompt_config: { slot_id: theirs },
      }),
    ).toThrow(ValidationError)

    const a = quota('Walks', 'FREQ=WEEKLY', 3)
    const b = quota('Reading', 'FREQ=WEEKLY', 3)
    expect(() =>
      bulkEdit({
        ...base,
        taskIds: [a.id, b.id],
        changes: { quota_prompt_config: { slot_id: theirs } },
      }),
    ).toThrow(ValidationError)
    expect(getTaskById(a.id)!.quota_prompt_config).toBeNull()
    expect(getTaskById(b.id)!.quota_prompt_config).toBeNull()
  })

  test("QP-063: a partner's shared-project quota takes the OWNER's periods, not the editor's", () => {
    seedTestUser(2, 'casey@example.com', TEST_TIMEZONE)
    seedTestProject(2, 'Family', 2, true)
    const q = quota('Family walks', 'FREQ=WEEKLY', 3, 2, { project_id: 2 })

    expect(() => configure(q.id, { slot_id: slotId('Evening') })).toThrow(ValidationError)
    configure(q.id, { slot_id: slotId('Evening', 2) })
    expect(getTaskById(q.id)!.quota_prompt_config).toEqual({ slot_id: slotId('Evening', 2) })
  })
})

describe('Quota prompt moves — the payload and the move', () => {
  test('QP-064: every prompt carries its slot_id; a daily row lists the numbers it stands for', () => {
    quota('Water', 'FREQ=DAILY', 7)
    quota('Cook vegetables', 'FREQ=WEEKLY', 5)
    expect(prompts().map((p) => [p.title, p.slot, p.slot_id, p.number, p.numbers])).toEqual([
      ['Cook vegetables', 'Morning', slotId('Morning'), null, null],
      ['Water', 'Morning', slotId('Morning'), 1, [1]],
      ['Water', 'Midday', slotId('Midday'), 2, [2]],
      ['Water', 'Afternoon', slotId('Afternoon'), 3, [3]],
      ['Water', 'Evening', slotId('Evening'), 7, [4, 5, 6, 7]],
    ])
  })

  test('QP-065: moving a non-daily prompt sets slot_id and keeps the rest of the config', () => {
    const q = quota('Cook vegetables', 'FREQ=WEEKLY', 5)
    configure(q.id, { enabled: true })
    move(prompts()[0], 'Evening')
    expect(getTaskById(q.id)!.quota_prompt_config).toEqual({
      enabled: true,
      slot_id: slotId('Evening'),
    })
    expect(prompts().map((p) => p.slot)).toEqual(['Evening'])
  })

  test("QP-066: moving a daily row moves only that row's numbers; the others stay", () => {
    const q = quota('Water', 'FREQ=DAILY', 7)
    const evening = prompts().find((p) => p.slot === 'Evening')!
    move(evening, 'Early morning')
    expect(getTaskById(q.id)!.quota_prompt_config).toEqual({
      numbers: Object.fromEntries(['4', '5', '6', '7'].map((k) => [k, slotId('Early morning')])),
    })
    expect(prompts().map((p) => [p.slot, p.numbers])).toEqual([
      ['Early morning', [4, 5, 6, 7]],
      ['Morning', [1]],
      ['Midday', [2]],
      ['Afternoon', [3]],
    ])

    // Into a period that already holds one of its numbers: one row, both numbers.
    move(prompts().find((p) => p.slot === 'Midday')!, 'Morning')
    expect(prompts().map((p) => [p.slot, p.numbers, p.prompt_key])).toEqual([
      ['Early morning', [4, 5, 6, 7], promptKey(q.id, 7, TODAY)],
      ['Morning', [1, 2], promptKey(q.id, 2, TODAY)],
      ['Afternoon', [3], promptKey(q.id, 3, TODAY)],
    ])
  })

  test('QP-067: a move is one undo entry, and undo puts the row back', () => {
    quota('Water', 'FREQ=DAILY', 2)
    move(prompts().find((p) => p.slot === 'Midday')!, 'Evening')
    expect(prompts().map((p) => p.slot)).toEqual(['Morning', 'Evening'])
    executeUndo(TEST_USER_ID)
    expect(prompts().map((p) => p.slot)).toEqual(['Morning', 'Midday'])
  })
})

describe('Quota prompt moves — the optimistic helper', () => {
  const p = (over: Partial<QuotaPrompt>): QuotaPrompt => ({
    prompt_key: 'q:1:0:2026-01-15',
    task_id: 1,
    number: null,
    numbers: null,
    slot_id: 1,
    title: 'Cook',
    current: 0,
    target: 3,
    period: 'WEEKLY',
    stripe_color: null,
    considered: false,
    done: false,
    ...over,
  })
  const group = (id: number, prompts: QuotaPrompt[]) => ({ slot: { id }, prompts })

  test('QP-068: a row moves to its period, alphabetically placed, and re-applying is a no-op', () => {
    const cook = p({})
    const art = p({ prompt_key: 'q:2:0:2026-01-15', task_id: 2, title: 'Art', slot_id: 2 })
    const zen = p({ prompt_key: 'q:3:0:2026-01-15', task_id: 3, title: 'Zen', slot_id: 2 })
    const groups = [group(1, [cook]), group(2, [art, zen])]
    const moves = new Map([[cook.prompt_key, 2]])
    const moved = applyPromptMoves(groups, moves)
    expect(moved.map((g) => g.prompts.map((x) => [x.title, x.slot_id]))).toEqual([
      [],
      [
        ['Art', 2],
        ['Cook', 2],
        ['Zen', 2],
      ],
    ])
    expect(applyPromptMoves(moved, moves)).toEqual(moved)
  })

  test('QP-069: a daily row merges into its sibling in the target period', () => {
    const one = p({ prompt_key: 'q:1:1:2026-01-15', number: 1, numbers: [1], current: 1 })
    const two = p({
      prompt_key: 'q:1:2:2026-01-15',
      number: 2,
      numbers: [2],
      slot_id: 2,
      current: 1,
    })
    const moved = applyPromptMoves(
      [group(1, [one]), group(2, [two])],
      new Map([[one.prompt_key, 2]]),
    )
    expect(moved[0].prompts).toEqual([])
    expect(moved[1].prompts).toEqual([
      { ...two, numbers: [1, 2], number: 2, prompt_key: 'q:1:2:2026-01-15', done: false },
    ])
  })

  test('QP-070: movedPromptConfig merges over the stored config', () => {
    expect(movedPromptConfig(null, { numbers: null }, 5)).toEqual({ slot_id: 5 })
    expect(
      movedPromptConfig({ enabled: true, slot_id: 2, numbers: { '1': 3 } }, { numbers: [2, 3] }, 5),
    ).toEqual({ enabled: true, slot_id: 2, numbers: { '1': 3, '2': 5, '3': 5 } })
  })
})
