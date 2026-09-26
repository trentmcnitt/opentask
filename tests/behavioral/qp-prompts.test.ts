/**
 * QP-010..: quota prompts — which prompts a day has, where they sit, and what
 * the two actions do (quota reminders, 2026-09-24).
 *
 * The test user has the five default periods: Early morning 07:00, Morning
 * 09:00, Midday 12:00, Afternoon 16:00, Evening 20:30. The clock is frozen on
 * Thursday 2026-01-15, 10:00 Chicago.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { getDb } from '@/core/db'
import { createTask, getTaskById, bulkDone, updateTask } from '@/core/tasks'
import { incrementProgress } from '@/core/tasks/progress'
import { getQuotaPromptsBySlot, type QuotaPrompt } from '@/core/tasks/quota-prompts'
import { actOnPrompts } from '@/core/tasks/quota-prompt-actions'
import { listTimeSlots } from '@/core/time-slots'
import { deleteTimeSlot } from '@/core/time-slots/edit'
import { executeUndo, executeRedo } from '@/core/undo'
import { validateTaskUpdate } from '@/core/validation'
import { promptKey } from '@/lib/quota-prompts'
import {
  setupTestDb,
  teardownTestDb,
  seedTestUser,
  seedTestProject,
  seedTestLabels,
  TEST_TIMEZONE,
  TEST_USER_ID,
} from '../helpers/setup'

const THU = new Date('2026-01-15T16:00:00Z')
const TODAY = '2026-01-15'
const base = { userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE }

function quota(title: string, rrule: string | null, target: number, extra = {}) {
  return createTask({
    ...base,
    input: {
      title,
      ...(rrule ? { rrule } : {}),
      progress_target: target,
      is_tracked: true,
      ...extra,
    },
  })
}

function slotId(label: string): number {
  const slot = listTimeSlots(TEST_USER_ID).find((s) => s.label === label)
  if (!slot) throw new Error(`no slot ${label}`)
  return slot.id
}

/** Every prompt today, flattened, with the label of the period it sits in. */
function prompts(now: Date = THU): (QuotaPrompt & { slot: string | null })[] {
  const labels = new Map(listTimeSlots(TEST_USER_ID).map((s) => [s.id, s.label]))
  const out: (QuotaPrompt & { slot: string | null })[] = []
  for (const [id, list] of getQuotaPromptsBySlot(TEST_USER_ID, TEST_TIMEZONE, now)) {
    for (const p of list) out.push({ ...p, slot: id === null ? null : (labels.get(id) ?? null) })
  }
  return out
}

function setUserDefault(id: number | null) {
  getDb().prepare('UPDATE users SET quota_prompt_slot_id = ? WHERE id = ?').run(id, TEST_USER_ID)
}

function configure(taskId: number, config: object | null) {
  updateTask({
    ...base,
    taskId,
    input: validateTaskUpdate({ quota_prompt_config: config }),
  })
}

/** Every block: a fresh database, the clock frozen, the kill switch unset. */
function freshDay() {
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
}

const act = (key: string, did: boolean) => actOnPrompts({ ...base, actions: [{ key, did }] })

describe('Quota prompts — placement', () => {
  freshDay()

  test('QP-010: a weekly quota prompts once, in the first period by default', () => {
    const q = quota('Cook vegetables', 'FREQ=WEEKLY', 5)
    expect(prompts()).toEqual([
      expect.objectContaining({
        prompt_key: promptKey(q.id, 0, TODAY),
        task_id: q.id,
        number: null,
        title: 'Cook vegetables',
        current: 0,
        target: 5,
        period: 'WEEKLY',
        considered: false,
        done: false,
        slot: 'Early morning',
      }),
    ])
  })

  test("QP-011: fallbacks — the quota's slot, else the user default, else the first period", () => {
    const q = quota('Cook vegetables', 'FREQ=WEEKLY', 5)
    setUserDefault(slotId('Morning'))
    expect(prompts()[0].slot).toBe('Morning')

    configure(q.id, { slot_id: slotId('Afternoon') })
    expect(prompts()[0].slot).toBe('Afternoon')

    // The quota's own slot is deleted: back to the user's default...
    deleteTimeSlot({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      slotId: slotId('Afternoon'),
    })
    expect(prompts()[0].slot).toBe('Morning')
    // ...and with that gone too, the first period of the day.
    deleteTimeSlot({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, slotId: slotId('Morning') })
    expect(prompts()[0].slot).toBe('Early morning')

    // Undoing the delete brings the slot back under its old id, and the prompt with it.
    executeUndo(TEST_USER_ID)
    expect(prompts()[0].slot).toBe('Morning')
  })

  test('QP-012: a daily quota spreads its numbers, one row per period, showing progress', () => {
    setUserDefault(slotId('Morning'))
    const q = quota('Daily Stretch', 'FREQ=DAILY', 2)
    const rows = prompts()
    expect(rows.map((p) => [p.slot, p.number, p.prompt_key])).toEqual([
      ['Morning', 1, promptKey(q.id, 1, TODAY)],
      ['Midday', 2, promptKey(q.id, 2, TODAY)],
    ])

    incrementProgress({ userId: TEST_USER_ID, taskId: q.id })
    const after = prompts()
    expect(after.map((p) => [p.number, p.current, p.done])).toEqual([
      [1, 1, true],
      [2, 1, false],
    ])
  })

  test('QP-013: numbers past the last period clamp there, never wrapping to the morning', () => {
    setUserDefault(slotId('Midday'))
    quota('Water', 'FREQ=DAILY', 7)
    expect(prompts().map((p) => [p.slot, p.number])).toEqual([
      ['Midday', 1],
      ['Afternoon', 2],
      ['Evening', 7],
    ])
  })

  test('QP-014: per-number overrides win; an override to a deleted slot falls back', () => {
    const q = quota('Daily Stretch', 'FREQ=DAILY', 2)
    configure(q.id, { numbers: { '1': slotId('Evening'), '2': slotId('Evening') } })
    expect(prompts().map((p) => [p.slot, p.number])).toEqual([['Evening', 2]])

    // #2 alone in Afternoon, and then Afternoon is deleted (a write naming a
    // slot the user does not have is refused — QP-060 — so a stale override
    // only ever arises this way).
    configure(q.id, { numbers: { '2': slotId('Afternoon') } })
    deleteTimeSlot({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      slotId: slotId('Afternoon'),
    })
    expect(prompts().map((p) => [p.slot, p.number])).toEqual([
      ['Early morning', 1],
      ['Morning', 2],
    ])
  })

  test('QP-015: a weekly prompt is done for today once progress is logged from anywhere', () => {
    const q = quota('Cook vegetables', 'FREQ=WEEKLY', 5)
    incrementProgress({ userId: TEST_USER_ID, taskId: q.id })
    expect(prompts()[0]).toMatchObject({ current: 1, done: true })

    // Tomorrow it asks again.
    const fri = new Date('2026-01-16T16:00:00Z')
    vi.setSystemTime(fri)
    expect(prompts(fri)[0]).toMatchObject({
      prompt_key: promptKey(q.id, 0, '2026-01-16'),
      current: 1,
      done: false,
    })
  })

  test('QP-016: once met, a weekly prompt is gone until the period resets', () => {
    const q = quota('Date night', 'FREQ=WEEKLY', 1)
    incrementProgress({ userId: TEST_USER_ID, taskId: q.id })
    expect(prompts()).toHaveLength(1) // met today: still today's, handled

    const fri = new Date('2026-01-16T16:00:00Z')
    vi.setSystemTime(fri)
    expect(prompts(fri)).toHaveLength(0)
  })
})

describe('Quota prompts — which quotas prompt', () => {
  freshDay()

  test('QP-017: yearly and period-less quotas are off by default; the switch overrides', () => {
    const yearly = quota('Physical', 'FREQ=YEARLY', 1)
    quota('Loose count', null, 3)
    const weekly = quota('Cook vegetables', 'FREQ=WEEKLY', 5)
    expect(prompts().map((p) => p.task_id)).toEqual([weekly.id])

    configure(yearly.id, { enabled: true })
    configure(weekly.id, { enabled: false })
    expect(prompts().map((p) => p.task_id)).toEqual([yearly.id])
  })

  test('QP-018: daily with INTERVAL=2 prompts once a day, like a non-daily quota', () => {
    const q = quota('Stretch', 'FREQ=DAILY;INTERVAL=2', 3)
    expect(prompts()).toEqual([
      expect.objectContaining({ prompt_key: promptKey(q.id, 0, TODAY), number: null }),
    ])
  })

  test("QP-019: another user's quota in a shared project never prompts", () => {
    seedTestUser(2, 'casey@example.com', TEST_TIMEZONE)
    seedTestProject(2, 'Family', 2, true)
    createTask({
      userId: 2,
      userTimezone: TEST_TIMEZONE,
      input: { title: "Casey's walks", rrule: 'FREQ=WEEKLY', progress_target: 3, project_id: 2 },
    })
    expect(prompts()).toEqual([])
  })

  test('QP-020: the user switch and the server kill switch each hide every prompt', () => {
    quota('Cook vegetables', 'FREQ=WEEKLY', 5)
    expect(prompts()).toHaveLength(1)

    getDb().prepare('UPDATE users SET quota_prompts_enabled = 0 WHERE id = ?').run(TEST_USER_ID)
    expect(prompts()).toEqual([])
    getDb().prepare('UPDATE users SET quota_prompts_enabled = 1 WHERE id = ?').run(TEST_USER_ID)

    process.env.OPENTASK_QUOTA_PROMPTS = 'off'
    expect(prompts()).toEqual([])
    process.env.OPENTASK_QUOTA_PROMPTS = 'on'
    expect(prompts()).toHaveLength(1)
  })

  test('QP-021: the stripe is the label colour, and green is never spent', () => {
    seedTestLabels(['kids', 'health'])
    getDb()
      .prepare('UPDATE users SET label_config = ? WHERE id = ?')
      .run(
        JSON.stringify([
          { name: 'kids', color: 'blue' },
          { name: 'health', color: 'green' },
        ]),
        TEST_USER_ID,
      )
    quota('Read to kids', 'FREQ=WEEKLY', 3, { labels: ['kids'] })
    quota('Run', 'FREQ=WEEKLY', 3, { labels: ['health'] })
    quota('Plain', 'FREQ=WEEKLY', 3)
    const colors = Object.fromEntries(prompts().map((p) => [p.title, p.stripe_color]))
    expect(colors).toEqual({ 'Read to kids': 'blue', Run: null, Plain: null })
  })

  test('QP-076: has_notes marks a quota with notes; blank notes are no notes', () => {
    quota('Cook', 'FREQ=WEEKLY', 3, { notes: 'The good pan' })
    quota('Stretch', 'FREQ=WEEKLY', 3, { notes: '  \n ' })
    quota('Read', 'FREQ=WEEKLY', 3)
    const flags = Object.fromEntries(prompts().map((p) => [p.title, p.has_notes]))
    expect(flags).toEqual({ Cook: true, Stretch: false, Read: false })
  })

  test("QP-022: at 00:02, before the cron, yesterday's met daily reads 0 and is not done", () => {
    const q = quota('Daily Stretch', 'FREQ=DAILY', 1)
    incrementProgress({ userId: TEST_USER_ID, taskId: q.id }) // anchors + met Thursday
    const fri0002 = new Date('2026-01-16T06:02:00Z')
    vi.setSystemTime(fri0002)
    expect(prompts(fri0002)).toEqual([
      expect.objectContaining({ current: 0, done: false, considered: false }),
    ])
  })
})

describe('Quota prompts — actions', () => {
  freshDay()

  test('QP-030: consider hides the prompt for today without logging progress; undo restores it', () => {
    const q = quota('Cook vegetables', 'FREQ=WEEKLY', 5)
    const key = promptKey(q.id, 0, TODAY)
    act(key, false)
    expect(prompts()[0]).toMatchObject({ considered: true, done: false, current: 0 })
    expect(getTaskById(q.id)!.progress_current).toBe(0)

    executeUndo(TEST_USER_ID)
    expect(prompts()[0]).toMatchObject({ considered: false, done: false })
    executeRedo(TEST_USER_ID)
    expect(prompts()[0].considered).toBe(true)
  })

  test('QP-031: did-it on a weekly prompt is +1, considered, and idempotent', () => {
    const q = quota('Cook vegetables', 'FREQ=WEEKLY', 5)
    const key = promptKey(q.id, 0, TODAY)
    act(key, true)
    act(key, true)
    expect(getTaskById(q.id)!.progress_current).toBe(1)
    expect(prompts()[0]).toMatchObject({ considered: true, done: true, current: 1 })

    // Progress events record what was applied: one +1.
    const events = getDb()
      .prepare('SELECT delta FROM progress_events WHERE task_id = ?')
      .all(q.id) as { delta: number }[]
    expect(events).toEqual([{ delta: 1 }])
  })

  test('QP-032: did-it on daily #k raises the count to at least k, never past it', () => {
    setUserDefault(slotId('Morning'))
    const q = quota('Daily Stretch', 'FREQ=DAILY', 3)
    act(promptKey(q.id, 2, TODAY), true)
    expect(getTaskById(q.id)!.progress_current).toBe(2)
    act(promptKey(q.id, 1, TODAY), true)
    expect(getTaskById(q.id)!.progress_current).toBe(2)
    act(promptKey(q.id, 2, TODAY), true)
    expect(getTaskById(q.id)!.progress_current).toBe(2)
  })

  test('QP-033: undo of a did-it restores the count AND the prompt', () => {
    const q = quota('Cook vegetables', 'FREQ=WEEKLY', 5)
    act(promptKey(q.id, 0, TODAY), true)
    executeUndo(TEST_USER_ID)
    expect(getTaskById(q.id)!.progress_current).toBe(0)
    expect(prompts()[0]).toMatchObject({ considered: false, done: false, current: 0 })
  })
})

describe('Quota prompts — batches and refusals', () => {
  freshDay()

  test('QP-034: stale, foreign and malformed keys refuse the whole batch', () => {
    const q = quota('Cook vegetables', 'FREQ=WEEKLY', 5)
    const good = promptKey(q.id, 0, TODAY)
    const yesterday = promptKey(q.id, 0, '2026-01-14')
    expect(() =>
      actOnPrompts({
        ...base,
        actions: [
          { key: good, did: true },
          { key: yesterday, did: true },
        ],
      }),
    ).toThrow(/stale/)
    expect(getTaskById(q.id)!.progress_current).toBe(0)

    expect(() => act('nonsense', false)).toThrow()
    expect(() => act(promptKey(q.id, 3, TODAY), false)).toThrow() // weekly has no numbers
    const daily = quota('Walks', 'FREQ=DAILY', 2)
    expect(() => act(promptKey(daily.id, 3, TODAY), true)).toThrow() // only 1..2

    seedTestUser(2, 'casey@example.com', TEST_TIMEZONE)
    seedTestProject(2, 'Family', 2, true)
    const theirs = createTask({
      userId: 2,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Theirs', rrule: 'FREQ=WEEKLY', progress_target: 3, project_id: 2 },
    })
    expect(() => act(promptKey(theirs.id, 0, TODAY), true)).toThrow()
  })

  test('QP-035: a mixed bulk commit is one transaction and one undo entry', () => {
    const reminder = createTask({
      ...base,
      input: { title: 'Breathe', is_reminder: true, rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0' },
    })
    const weekly = quota('Cook vegetables', 'FREQ=WEEKLY', 5)
    const daily = quota('Daily Stretch', 'FREQ=DAILY', 2)
    const before = (getDb().prepare('SELECT COUNT(*) AS n FROM undo_log').get() as { n: number }).n

    const result = bulkDone({
      ...base,
      taskIds: [reminder.id],
      prompts: [
        { key: promptKey(weekly.id, 0, TODAY), did: false },
        { key: promptKey(daily.id, 1, TODAY), did: true },
      ],
    })
    expect(result).toMatchObject({ tasksAffected: 1, promptsConsidered: 1, promptsDid: 1 })
    expect(getTaskById(daily.id)!.progress_current).toBe(1)
    const after = (getDb().prepare('SELECT COUNT(*) AS n FROM undo_log').get() as { n: number }).n
    expect(after).toBe(before + 1)

    // One undo takes all three back.
    executeUndo(TEST_USER_ID)
    expect(getTaskById(daily.id)!.progress_current).toBe(0)
    expect(getTaskById(reminder.id)!.completion_count).toBe(0)
    expect(prompts().every((p) => !p.considered && !p.done)).toBe(true)
  })

  test('QP-036: bulk complete with prompts only, and bare quota ids still refused', () => {
    const weekly = quota('Cook vegetables', 'FREQ=WEEKLY', 5)
    const result = bulkDone({
      ...base,
      taskIds: [],
      prompts: [{ key: promptKey(weekly.id, 0, TODAY), did: false }],
    })
    expect(result).toMatchObject({ tasksAffected: 0, promptsConsidered: 1 })
    expect(() => bulkDone({ ...base, taskIds: [weekly.id] })).toThrow(/quota/i)
  })

  test('QP-038: a did-it taken back with a −1 brings the weekly prompt back, and can be done again', () => {
    const q = quota('Cook vegetables', 'FREQ=WEEKLY', 5)
    const key = promptKey(q.id, 0, TODAY)
    act(key, true)
    incrementProgress({ userId: TEST_USER_ID, taskId: q.id, delta: -1 })
    expect(prompts()[0]).toMatchObject({ done: false, current: 0 })
    act(key, true)
    expect(getTaskById(q.id)!.progress_current).toBe(1)
  })

  test('QP-039: daily did-it adds only what is missing up to k', () => {
    setUserDefault(slotId('Morning'))
    const q = quota('Daily Stretch', 'FREQ=DAILY', 3)
    incrementProgress({ userId: TEST_USER_ID, taskId: q.id })
    act(promptKey(q.id, 3, TODAY), true)
    expect(getTaskById(q.id)!.progress_current).toBe(3)
    const deltas = getDb()
      .prepare('SELECT delta FROM progress_events WHERE task_id = ? ORDER BY id')
      .all(q.id) as { delta: number }[]
    expect(deltas.map((d) => d.delta)).toEqual([1, 2])
  })

  test('QP-040: a stale prompt key refuses a mixed bulk commit, reminders included', () => {
    const reminder = createTask({
      ...base,
      input: { title: 'Breathe', is_reminder: true, rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0' },
    })
    const q = quota('Cook vegetables', 'FREQ=WEEKLY', 5)
    expect(() =>
      bulkDone({
        ...base,
        taskIds: [reminder.id],
        prompts: [{ key: promptKey(q.id, 0, '2026-01-14'), did: false }],
      }),
    ).toThrow(/stale/)
    expect(getTaskById(reminder.id)!.completion_count).toBe(0)
  })

  test("QP-037: undo of a did-it after the period rolled over leaves today's count alone", () => {
    const q = quota('Daily Stretch', 'FREQ=DAILY', 2)
    act(promptKey(q.id, 1, TODAY), true)
    const fri = new Date('2026-01-16T16:00:00Z')
    vi.setSystemTime(fri)
    incrementProgress({ userId: TEST_USER_ID, taskId: q.id }) // Friday's own +1 (rolls Thursday)
    executeUndo(TEST_USER_ID) // Friday's +1
    executeUndo(TEST_USER_ID) // Thursday's did-it: a no-op now
    expect(getTaskById(q.id)!.progress_current).toBe(0)
    // Friday's first undo put Thursday's record back — a stale date, which
    // reads as an empty day: Friday's prompts are all waiting again.
    expect(prompts(fri).every((p) => !p.considered && !p.done && p.current === 0)).toBe(true)
  })
})
