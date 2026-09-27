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
import { executeUndo } from '@/core/undo'
import { ValidationError } from '@/core/errors'
import type { QuotaPromptConfig } from '@/types'
import { validateTaskUpdate } from '@/core/validation'
import {
  applyPromptMoves,
  movedPromptConfig,
  numbersLabel,
  promptKey,
  quotaPeriodRows,
} from '@/lib/quota-prompts'
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
    // `deleteTimeSlot` repoints stored ids since 2026-09-25 (QP-011), so a
    // stale one only survives from a delete made before that — removed here
    // the way that delete left it: the slot row gone, the config untouched.
    getDb().prepare('DELETE FROM time_slots WHERE id = ?').run(afternoon)

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

describe('Quota prompt moves — number keys', () => {
  test('QP-071: number keys run to 1000, the largest target a quota can have', () => {
    const numbers = (k: string) => ({ quota_prompt_config: { numbers: { [k]: 1 } } })
    expect(() => validateTaskUpdate(numbers('1000'))).not.toThrow()
    expect(() => validateTaskUpdate(numbers('1001'))).toThrow()
    expect(() => validateTaskUpdate(numbers('0'))).toThrow()
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
    has_notes: false,
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

/**
 * A Track chip's bubble (2026-09-25): the chip stands for the whole quota, so
 * its rows are computed from the quota itself, by the same placement rule the
 * server's prompt rows use.
 */
describe("Quota prompt moves — a quota chip's rows", () => {
  const rowsOf = (id: number) =>
    quotaPeriodRows(getTaskById(id)!, listTimeSlots(TEST_USER_ID), slotId('Morning'))

  test('QP-072: a non-daily quota is one row, in its period; switched off, none', () => {
    const task = quota('Cook vegetables', 'FREQ=WEEKLY', 5)
    expect(rowsOf(task.id)).toEqual([{ numbers: null, slotId: slotId('Morning') }])
    configure(task.id, { slot_id: slotId('Evening') })
    expect(rowsOf(task.id)).toEqual([{ numbers: null, slotId: slotId('Evening') }])
    configure(task.id, { enabled: false })
    expect(rowsOf(task.id)).toEqual([])
    // Yearly prompts nothing by default.
    const yearly = quota('Physical', 'FREQ=YEARLY', 1)
    expect(rowsOf(yearly.id)).toEqual([])
    // No periods, nothing to move between.
    expect(quotaPeriodRows(task, [], null)).toEqual([])
  })

  test('QP-073: a small daily target is one row per number, where the editor shows it', () => {
    const task = quota('Floss', 'FREQ=DAILY', 2)
    expect(rowsOf(task.id)).toEqual([
      { numbers: [1], slotId: slotId('Morning') },
      { numbers: [2], slotId: slotId('Midday') },
    ])
  })

  test("QP-074: a large daily target groups by period — exactly the server's prompt rows", () => {
    const task = quota('Water', 'FREQ=DAILY', 7)
    const rows = rowsOf(task.id)
    expect(rows).toEqual(
      prompts()
        .filter((p) => p.task_id === task.id)
        .map((p) => ({ numbers: p.numbers, slotId: p.slot_id })),
    )
    expect(rows.map((r) => numbersLabel(r.numbers!, 7))).toEqual([
      '1st of 7',
      '2nd of 7',
      '3rd of 7',
      '4th–7th of 7',
    ])
  })

  test('QP-075: numbersLabel collapses runs', () => {
    expect(numbersLabel([2], 2)).toBe('2nd of 2')
    expect(numbersLabel([1, 4, 5, 11, 12, 13], 13)).toBe('1st, 4th–5th, 11th–13th of 13')
  })
})

/**
 * The Quotas page's multi-edit (2026-09-25): a bulk `quota_prompt_config` is
 * merged over each quota's stored config, never written over it, so the
 * fields a multi-edit did not change survive on every quota.
 */
describe('Quota prompt configs — bulk edit merges per quota', () => {
  function bulkConfig(ids: number[], config: QuotaPromptConfig | null) {
    return bulkEdit({ ...base, taskIds: ids, changes: { quota_prompt_config: config } })
  }

  test('QP-080: switching several off keeps each one its own period and numbers', () => {
    const weekly = quota('Cook vegetables', 'FREQ=WEEKLY', 3)
    const daily = quota('Water', 'FREQ=DAILY', 3)
    configure(weekly.id, { slot_id: slotId('Evening') })
    configure(daily.id, { slot_id: slotId('Morning'), numbers: { '3': slotId('Evening') } })

    bulkConfig([weekly.id, daily.id], { enabled: false })

    expect(getTaskById(weekly.id)!.quota_prompt_config).toEqual({
      slot_id: slotId('Evening'),
      enabled: false,
    })
    expect(getTaskById(daily.id)!.quota_prompt_config).toEqual({
      slot_id: slotId('Morning'),
      numbers: { '3': slotId('Evening') },
      enabled: false,
    })
  })

  test('QP-081: a period for a daily quota sets its base, clears its numbers, keeps its switch', () => {
    const daily = quota('Water', 'FREQ=DAILY', 3)
    const weekly = quota('Read', 'FREQ=WEEKLY', 2)
    configure(daily.id, { enabled: true, numbers: { '1': slotId('Evening') } })

    bulkConfig([daily.id, weekly.id], { slot_id: slotId('Midday'), numbers: {} })

    // The numbers key is gone, not left as an empty map.
    expect(getTaskById(daily.id)!.quota_prompt_config).toEqual({
      enabled: true,
      slot_id: slotId('Midday'),
    })
    // Untouched before: it gets only what was sent.
    expect(getTaskById(weekly.id)!.quota_prompt_config).toEqual({ slot_id: slotId('Midday') })
    // The numbers spread from the new base exactly as a fresh daily quota's do.
    const placed = prompts()
      .filter((p) => p.task_id === daily.id)
      .map((p) => [p.numbers, p.slot])
    expect(placed).toEqual([
      [[1], 'Midday'],
      [[2], 'Afternoon'],
      [[3], 'Evening'],
    ])
  })

  test('QP-082: a quota the merge leaves unchanged is not written, and null still clears', () => {
    const a = quota('Walks', 'FREQ=WEEKLY', 3)
    const b = quota('Stretch', 'FREQ=WEEKLY', 3)
    configure(a.id, { slot_id: slotId('Evening') })

    expect(bulkConfig([a.id, b.id], { slot_id: slotId('Evening') }).tasksAffected).toBe(1)

    bulkConfig([a.id, b.id], null)
    expect(getTaskById(a.id)!.quota_prompt_config).toBeNull()
    expect(getTaskById(b.id)!.quota_prompt_config).toBeNull()
  })

  test("QP-083: the merged config is still held to the owner's periods", () => {
    seedTestUser(2, 'casey@example.com', TEST_TIMEZONE)
    const a = quota('Walks', 'FREQ=WEEKLY', 3)
    configure(a.id, { enabled: false })
    expect(() => bulkConfig([a.id], { slot_id: slotId('Evening', 2) })).toThrow(ValidationError)
    expect(getTaskById(a.id)!.quota_prompt_config).toEqual({ enabled: false })
  })

  test('QP-084: one Undo puts every quota back to its own config', () => {
    const a = quota('Walks', 'FREQ=WEEKLY', 3)
    const b = quota('Water', 'FREQ=DAILY', 2)
    const c = quota('Read', 'FREQ=MONTHLY', 2)
    configure(a.id, { slot_id: slotId('Evening') })
    configure(b.id, { enabled: false, numbers: { '2': slotId('Evening') } })

    bulkConfig([a.id, b.id, c.id], { enabled: true, slot_id: slotId('Midday'), numbers: {} })
    expect(getTaskById(b.id)!.quota_prompt_config).toEqual({
      enabled: true,
      slot_id: slotId('Midday'),
    })

    executeUndo(TEST_USER_ID)
    expect(getTaskById(a.id)!.quota_prompt_config).toEqual({ slot_id: slotId('Evening') })
    expect(getTaskById(b.id)!.quota_prompt_config).toEqual({
      enabled: false,
      numbers: { '2': slotId('Evening') },
    })
    expect(getTaskById(c.id)!.quota_prompt_config).toBeNull()
  })
})
