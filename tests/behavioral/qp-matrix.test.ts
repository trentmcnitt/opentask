/**
 * QPM-001..: the quota-prompt risk matrix's gaps (testing pass, 2026-09-25,
 * WP1). Each test fills one cell the existing qp-* files left open: an action
 * on a period that was never exercised alone, a period's whole lifecycle
 * across its boundary, a slot edit or delete under a prompt, and the three
 * decisions Trent made for this pass:
 *
 *   1. "Did it" on a weekly/monthly prompt is +1 even when progress was
 *      already logged today from elsewhere — idempotent per prompt KEY only.
 *   2. Deleting a slot moves its prompts to the NEAREST remaining slot, as it
 *      moves its reminders, and one Undo puts them back.
 *   3. A quota always has a period: create, edit and bulk edit refuse one
 *      without (this replaces the matrix's "no period (opt-in)" column).
 *
 * The test user has the five default periods: Early morning 07:00, Morning
 * 09:00, Midday 12:00, Afternoon 16:00, Evening 20:30. The clock starts frozen
 * on Thursday 2026-01-15, 10:00 Chicago; tests that cross a boundary move it
 * with `dayAt`. All titles are synthetic.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { DateTime } from 'luxon'
import { getDb } from '@/core/db'
import { bulkEdit, createTask, getTaskById, rolloverTrackedPeriods, updateTask } from '@/core/tasks'
import { incrementProgress } from '@/core/tasks/progress'
import { getQuotaPromptsBySlot, type QuotaPrompt } from '@/core/tasks/quota-prompts'
import { actOnPrompts } from '@/core/tasks/quota-prompt-actions'
import { getRemindersBySlot } from '@/core/tasks/reminders'
import { listTimeSlots } from '@/core/time-slots'
import {
  deleteTimeSlot,
  promptSlotAfterDelete,
  repointPromptConfig,
  updateTimeSlot,
} from '@/core/time-slots/edit'
import { executeRedo, executeUndo } from '@/core/undo'
import { ValidationError } from '@/core/errors'
import { QUOTA_PERIOD_MESSAGE, validateTaskUpdate } from '@/core/validation'
import { movedPromptConfig, promptKey } from '@/lib/quota-prompts'
import type { TimeSlot } from '@/lib/time-slot-assign'
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

/** A local wall-clock instant in the test timezone. Default 10:00. */
function dayAt(date: string, hour = 10, minute = 0, zone = TEST_TIMEZONE): Date {
  return DateTime.fromISO(`${date}T00:00`, { zone }).set({ hour, minute }).toJSDate()
}

function quota(title: string, rrule: string, target: number, extra = {}) {
  return createTask({
    ...base,
    input: { title, rrule, progress_target: target, is_tracked: true, ...extra },
  })
}

function slotId(label: string): number {
  const slot = listTimeSlots(TEST_USER_ID).find((s) => s.label === label)
  if (!slot) throw new Error(`no slot ${label}`)
  return slot.id
}

function setUserDefault(id: number | null) {
  getDb().prepare('UPDATE users SET quota_prompt_slot_id = ? WHERE id = ?').run(id, TEST_USER_ID)
}

function configure(taskId: number, config: object | null) {
  updateTask({ ...base, taskId, input: validateTaskUpdate({ quota_prompt_config: config }) })
}

/** Every prompt at `now`, flattened, with the label of the period it sits in. */
function prompts(now: Date = THU): (QuotaPrompt & { slot: string | null })[] {
  const labels = new Map(listTimeSlots(TEST_USER_ID).map((s) => [s.id, s.label]))
  const out: (QuotaPrompt & { slot: string | null })[] = []
  for (const [id, list] of getQuotaPromptsBySlot(TEST_USER_ID, TEST_TIMEZONE, now)) {
    for (const p of list) out.push({ ...p, slot: id === null ? null : (labels.get(id) ?? null) })
  }
  return out
}

/** Move the clock and read the prompts there. */
function promptsOn(date: string, hour = 10): (QuotaPrompt & { slot: string | null })[] {
  const now = dayAt(date, hour)
  vi.setSystemTime(now)
  return prompts(now)
}

function act(key: string, did: boolean, now: Date = new Date()) {
  return actOnPrompts({ ...base, now, actions: [{ key, did }] })
}

function deltas(taskId: number): number[] {
  return (
    getDb()
      .prepare('SELECT delta FROM progress_events WHERE task_id = ? ORDER BY id')
      .all(taskId) as { delta: number }[]
  ).map((r) => r.delta)
}

beforeEach(() => {
  vi.setSystemTime(THU)
  setupTestDb()
  delete process.env.OPENTASK_QUOTA_PROMPTS
})

afterEach(() => {
  vi.useRealTimers()
  delete process.env.OPENTASK_QUOTA_PROMPTS
  teardownTestDb()
})

describe('Daily N>1 — actions on one number', () => {
  test('QPM-001: considering #1 of a daily quota considers only #1, and logs nothing', () => {
    setUserDefault(slotId('Morning'))
    const q = quota('Glasses of water', 'FREQ=DAILY', 2)
    act(promptKey(q.id, 1, TODAY), false)

    expect(prompts().map((p) => [p.slot, p.number, p.considered, p.done])).toEqual([
      ['Morning', 1, true, false],
      ['Midday', 2, false, false],
    ])
    expect(getTaskById(q.id)!.progress_current).toBe(0)
    expect(deltas(q.id)).toEqual([])
  })

  test('QPM-002: a −1 after did-it #2 makes #2 not done; its did-key is kept, so did-it #2 again tops up by one', () => {
    setUserDefault(slotId('Morning'))
    const q = quota('Glasses of water', 'FREQ=DAILY', 2)
    const two = promptKey(q.id, 2, TODAY)
    act(two, true)
    expect(prompts().map((p) => [p.number, p.done])).toEqual([
      [1, true],
      [2, true],
    ])

    incrementProgress({ userId: TEST_USER_ID, taskId: q.id, delta: -1 })
    const after = prompts()
    expect(after.map((p) => [p.number, p.current, p.done])).toEqual([
      [1, 1, true],
      [2, 1, false],
    ])
    // PINNED AS-IS, OPEN FOR TRENT: #2 is no longer done (a daily row's
    // done-ness is its count, which the −1 took back), but the did-it's
    // implied `considered` stays, so the row reads handled, not waiting —
    // Undo, not a −1, is the documented way back. Whether a −1 should also
    // un-consider it is a product call (weekly behaves the same, QP-038).
    expect(after[1].considered).toBe(true)
    expect(getTaskById(q.id)!.quota_day_state!.did).toEqual([two])

    act(two, true)
    expect(getTaskById(q.id)!.progress_current).toBe(2)
    expect(deltas(q.id)).toEqual([2, -1, 1])
  })
})

describe('Redo of a did-it', () => {
  test('QPM-003: daily — undo takes the count and the row back; redo puts both back', () => {
    setUserDefault(slotId('Morning'))
    const q = quota('Glasses of water', 'FREQ=DAILY', 2)
    act(promptKey(q.id, 1, TODAY), true)

    executeUndo(TEST_USER_ID)
    expect(getTaskById(q.id)!.progress_current).toBe(0)
    expect(prompts()[0]).toMatchObject({ number: 1, considered: false, done: false })

    executeRedo(TEST_USER_ID)
    expect(getTaskById(q.id)!.progress_current).toBe(1)
    expect(prompts().map((p) => [p.number, p.considered, p.done])).toEqual([
      [1, true, true],
      [2, false, false],
    ])
  })

  test('QPM-004: weekly — redo restores the +1 and the day record, and the key stays idempotent', () => {
    const q = quota('Cook vegetables', 'FREQ=WEEKLY', 5)
    const key = promptKey(q.id, 0, TODAY)
    act(key, true)
    executeUndo(TEST_USER_ID)
    expect(prompts()[0]).toMatchObject({ current: 0, considered: false, done: false })

    executeRedo(TEST_USER_ID)
    expect(prompts()[0]).toMatchObject({ current: 1, considered: true, done: true })
    expect(getTaskById(q.id)!.quota_day_state).toMatchObject({ logged: 1, did: [key] })

    // The redone record still names the key, so a retried did-it adds nothing.
    act(key, true)
    expect(getTaskById(q.id)!.progress_current).toBe(1)
  })
})

describe('Period lifecycles across the boundary', () => {
  test('QPM-005: a met weekly prompt stays gone through Sunday and comes back Monday at 0', () => {
    const q = quota('Date night', 'FREQ=WEEKLY', 1)
    act(promptKey(q.id, 0, TODAY), true)

    expect(promptsOn('2026-01-16')).toEqual([]) // Friday
    expect(promptsOn('2026-01-18', 23)).toEqual([]) // Sunday, late

    // Monday (ISO week start), before the cron has closed the week…
    expect(promptsOn('2026-01-19', 7)).toEqual([
      expect.objectContaining({
        prompt_key: promptKey(q.id, 0, '2026-01-19'),
        current: 0,
        considered: false,
        done: false,
      }),
    ])
    // …and after it has.
    rolloverTrackedPeriods(dayAt('2026-01-19', 7))
    expect(prompts(dayAt('2026-01-19', 7))[0]).toMatchObject({ current: 0, done: false })
  })

  test('QPM-006: a monthly prompt asks daily until met, stays gone to month end, and returns on the 1st', () => {
    const q = quota('Call the utility', 'FREQ=MONTHLY', 2)
    act(promptKey(q.id, 0, TODAY), true)

    // Not met: it asks again the next day, with the month's count.
    expect(promptsOn('2026-01-16')[0]).toMatchObject({ current: 1, done: false })
    // A +1 from elsewhere on the 20th meets it — handled that day…
    vi.setSystemTime(dayAt('2026-01-20'))
    incrementProgress({ userId: TEST_USER_ID, taskId: q.id })
    expect(prompts(dayAt('2026-01-20'))[0]).toMatchObject({ current: 2, done: true })
    // …then gone for the rest of January…
    expect(promptsOn('2026-01-21')).toEqual([])
    expect(promptsOn('2026-01-31', 22)).toEqual([])
    // …and back on February 1st, from zero.
    expect(promptsOn('2026-02-01')).toEqual([
      expect.objectContaining({ prompt_key: promptKey(q.id, 0, '2026-02-01'), current: 0 }),
    ])
  })

  test('QPM-007: a yearly quota prompts only once opted in, and comes back on January 1st', () => {
    const q = quota('Annual checkup', 'FREQ=YEARLY', 1)
    expect(prompts()).toEqual([]) // off by default
    configure(q.id, { enabled: true })
    expect(prompts()).toEqual([expect.objectContaining({ period: 'YEARLY', number: null })])

    // Consider alone is handled for today only.
    act(promptKey(q.id, 0, TODAY), false)
    expect(prompts()[0]).toMatchObject({ considered: true, done: false, current: 0 })
    expect(promptsOn('2026-01-16')[0]).toMatchObject({ considered: false, done: false })

    act(promptKey(q.id, 0, '2026-01-16'), true) // met
    expect(promptsOn('2026-06-01')).toEqual([])
    expect(promptsOn('2026-12-31', 22)).toEqual([])
    expect(promptsOn('2027-01-01')).toEqual([
      expect.objectContaining({ prompt_key: promptKey(q.id, 0, '2027-01-01'), current: 0 }),
    ])
  })

  test('QPM-008: daily INTERVAL=2 — met on day one, gone on day two, back on day three', () => {
    const q = quota('Stretch', 'FREQ=DAILY;INTERVAL=2', 1)
    act(promptKey(q.id, 0, TODAY), true) // anchors the period at Thursday 00:00

    expect(promptsOn('2026-01-16')).toEqual([]) // Friday: same two-day period, met
    expect(promptsOn('2026-01-17')).toEqual([
      expect.objectContaining({
        prompt_key: promptKey(q.id, 0, '2026-01-17'),
        number: null,
        current: 0,
        done: false,
      }),
    ])
  })
})

describe('Progress from elsewhere', () => {
  test("QPM-009: a partner's +1 on a shared quota lands on the OWNER's day, in the owner's timezone", () => {
    seedTestUser(2, 'partner@example.com', 'Asia/Tokyo')
    seedTestProject(2, 'Household', TEST_USER_ID, true)
    const q = quota('Cook vegetables', 'FREQ=WEEKLY', 5, { project_id: 2 })

    // 23:00 Thursday in Chicago is already Friday afternoon in Tokyo.
    const late = dayAt(TODAY, 23)
    vi.setSystemTime(late)
    incrementProgress({ userId: 2, taskId: q.id })

    expect(getTaskById(q.id)!.quota_day_state).toMatchObject({ date: TODAY, logged: 1 })
    expect(prompts(late)[0]).toMatchObject({
      prompt_key: promptKey(q.id, 0, TODAY),
      current: 1,
      done: true,
    })
    // The owner's Friday starts fresh.
    expect(promptsOn('2026-01-16')[0]).toMatchObject({ current: 1, done: false })
  })

  test('QPM-010: did-it after a +1 elsewhere still adds +1 (Trent, 2026-09-25) — idempotent per key only', () => {
    const weekly = quota('Cook vegetables', 'FREQ=WEEKLY', 5)
    const monthly = quota('Call the utility', 'FREQ=MONTHLY', 3)
    for (const q of [weekly, monthly]) {
      incrementProgress({ userId: TEST_USER_ID, taskId: q.id }) // the watch, say
      const key = promptKey(q.id, 0, TODAY)
      act(key, true) // a prompt loaded before that +1
      act(key, true) // and a retry of it
      expect(getTaskById(q.id)!.progress_current).toBe(2)
      expect(deltas(q.id)).toEqual([1, 1])
      expect(getTaskById(q.id)!.quota_day_state).toMatchObject({ logged: 2, did: [key] })
    }
  })
})

describe('Slots under prompts', () => {
  test("QPM-011: retiming a slot keeps its prompts — they're keyed by id, and nothing is rewritten", () => {
    const q = quota('Cook vegetables', 'FREQ=WEEKLY', 5)
    const morning = slotId('Morning')
    configure(q.id, { slot_id: morning })

    const result = updateTimeSlot({ ...base, slotId: morning, input: { start_time: '09:30' } })
    expect(result.quotas_moved).toBe(0)
    expect(prompts()[0].slot).toBe('Morning')
    expect(getTaskById(q.id)!.quota_prompt_config).toEqual({ slot_id: morning })
    // Undoing the retime leaves the prompt where it was, too.
    executeUndo(TEST_USER_ID)
    expect(prompts()[0].slot).toBe('Morning')
  })

  test('QPM-012: delete a slot → move the prompt → undo both: the slot and the config come back together', () => {
    const q = quota('Cook vegetables', 'FREQ=WEEKLY', 5)
    const afternoon = slotId('Afternoon')
    configure(q.id, { slot_id: afternoon })

    deleteTimeSlot({ ...base, slotId: afternoon })
    expect(prompts()[0].slot).toBe('Midday')

    // The user then moves it by hand, as the bubble's chips do.
    const [row] = prompts()
    updateTask({
      ...base,
      taskId: q.id,
      input: validateTaskUpdate({
        quota_prompt_config: movedPromptConfig(
          getTaskById(q.id)!.quota_prompt_config,
          row,
          slotId('Evening'),
        ),
      }),
    })
    expect(prompts()[0].slot).toBe('Evening')

    executeUndo(TEST_USER_ID) // the move
    expect(prompts()[0].slot).toBe('Midday')
    executeUndo(TEST_USER_ID) // the delete
    expect(listTimeSlots(TEST_USER_ID).some((s) => s.id === afternoon)).toBe(true)
    expect(getTaskById(q.id)!.quota_prompt_config).toEqual({ slot_id: afternoon })
    expect(prompts()[0].slot).toBe('Afternoon')

    executeRedo(TEST_USER_ID) // the delete again
    expect(listTimeSlots(TEST_USER_ID).some((s) => s.id === afternoon)).toBe(false)
    expect(prompts()[0].slot).toBe('Midday')
    executeRedo(TEST_USER_ID) // the move again
    expect(prompts()[0].slot).toBe('Evening')
  })

  test('QPM-013: the nearest-slot rule — ties go to the earlier slot, the first slot goes to the next, and only named ids change', () => {
    const slot = (id: number, start_time: string) =>
      ({ id, user_id: 1, label: `S${id}`, start_time, sort_order: 0 }) as TimeSlot
    const slots = [slot(1, '08:00'), slot(2, '10:00'), slot(3, '12:00')]
    expect(promptSlotAfterDelete(slots, 2)?.id).toBe(1) // 2h either way: the earlier
    expect(promptSlotAfterDelete(slots, 1)?.id).toBe(2) // no earlier slot
    expect(promptSlotAfterDelete(slots, 3)?.id).toBe(2)

    expect(
      repointPromptConfig({ enabled: true, slot_id: 2, numbers: { '1': 2, '2': 3 } }, 2, 1),
    ).toEqual({ enabled: true, slot_id: 1, numbers: { '1': 1, '2': 3 } })
    expect(repointPromptConfig({ slot_id: 3 }, 2, 1)).toBeNull()
    expect(repointPromptConfig(null, 2, 1)).toBeNull()
  })

  test('QPM-014: every prompt lands in a group GET /api/reminders sends — stale ids and no slots included', () => {
    const inGroups = () => {
      const groupIds = new Set(
        getRemindersBySlot(TEST_USER_ID, TEST_TIMEZONE, THU).map((g) => g.slot?.id ?? null),
      )
      const promptIds = [...getQuotaPromptsBySlot(TEST_USER_ID, TEST_TIMEZONE, THU).keys()]
      return { promptIds, missing: promptIds.filter((id) => !groupIds.has(id)) }
    }

    const a = quota('Cook vegetables', 'FREQ=WEEKLY', 5)
    quota('Glasses of water', 'FREQ=DAILY', 4)
    configure(a.id, { slot_id: slotId('Evening') })
    expect(inGroups().missing).toEqual([])

    // A stale id, as a delete made before 2026-09-25 left it.
    getDb().prepare('DELETE FROM time_slots WHERE id = ?').run(slotId('Evening'))
    expect(inGroups().missing).toEqual([])

    // No periods at all: every prompt is un-slotted, and the null group is sent.
    getDb().prepare('DELETE FROM time_slots WHERE user_id = ?').run(TEST_USER_ID)
    const bare = inGroups()
    expect(bare.promptIds).toEqual([null])
    expect(bare.missing).toEqual([])
  })
})

describe('A quota always has a period (Trent, 2026-09-25)', () => {
  test('QPM-015: create refuses a quota without a period, by flag or by target', () => {
    for (const input of [
      { title: 'Loose count', is_tracked: true },
      { title: 'Loose count', progress_target: 3 },
    ]) {
      expect(() => createTask({ ...base, input })).toThrow(QUOTA_PERIOD_MESSAGE)
    }
    // A rule that names no quota period is no period either.
    expect(() =>
      createTask({ ...base, input: { title: 'Hourly', rrule: 'FREQ=HOURLY', progress_target: 3 } }),
    ).toThrow(ValidationError)
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({ n: 0 })
  })

  test('QPM-016: edit refuses clearing a quota’s rule and making a period-less task a quota; retiring still works', () => {
    const q = quota('Cook vegetables', 'FREQ=WEEKLY', 5)
    expect(() => updateTask({ ...base, taskId: q.id, input: { rrule: null } })).toThrow(
      QUOTA_PERIOD_MESSAGE,
    )
    expect(getTaskById(q.id)!.rrule).toBe('FREQ=WEEKLY')

    const plain = createTask({ ...base, input: { title: 'Plain task' } })
    expect(() =>
      updateTask({ ...base, taskId: plain.id, input: { is_tracked: true, progress_target: 3 } }),
    ).toThrow(QUOTA_PERIOD_MESSAGE)
    // With a period in the same write, it converts.
    updateTask({
      ...base,
      taskId: plain.id,
      input: { is_tracked: true, progress_target: 3, rrule: 'FREQ=WEEKLY' },
    })
    expect(getTaskById(plain.id)!.progress_target).toBe(3)

    // Retiring takes the rule with it — the result is not a quota, so allowed.
    updateTask({ ...base, taskId: q.id, input: { is_tracked: false, progress_target: 1 } })
    expect(getTaskById(q.id)!).toMatchObject({ is_tracked: false, rrule: null })
  })

  test('QPM-017: bulk edit refuses the whole batch; a legacy period-less quota stays editable', () => {
    const q = quota('Cook vegetables', 'FREQ=WEEKLY', 5)
    const plain = createTask({ ...base, input: { title: 'Plain task', rrule: 'FREQ=DAILY' } })
    expect(() =>
      bulkEdit({ ...base, taskIds: [q.id, plain.id], changes: { rrule: null } }),
    ).toThrow(QUOTA_PERIOD_MESSAGE)
    // All or nothing: the plain task kept its rule too.
    expect(getTaskById(plain.id)!.rrule).toBe('FREQ=DAILY')
    expect(getTaskById(q.id)!.rrule).toBe('FREQ=WEEKLY')

    // A legacy row (none in production) can still be renamed and re-slotted,
    // and it still reads harmlessly — prompts default off for it.
    getDb().prepare('UPDATE tasks SET rrule = NULL WHERE id = ?').run(q.id)
    updateTask({ ...base, taskId: q.id, input: { title: 'Cook more vegetables' } })
    configure(q.id, { slot_id: slotId('Midday') })
    expect(getTaskById(q.id)!.title).toBe('Cook more vegetables')
    expect(prompts()).toEqual([])
    // Touching its rule must give it a period.
    expect(() => updateTask({ ...base, taskId: q.id, input: { rrule: null } })).toThrow(
      QUOTA_PERIOD_MESSAGE,
    )
  })
})
