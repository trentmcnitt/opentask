/**
 * QNM-001..: quota prompts in the slot notifications and hourly nags — the
 * risk matrix's gaps (testing pass, 2026-09-25, WP1). qp-notifications.test.ts
 * pins the rules with weekly quotas acted on through `actOnPrompts`; these
 * cover the paths it left open: a daily quota's numbers across the day's
 * pushes, progress logged from somewhere else (the widget, the watch — a
 * plain +1), the first nag of a new day, and a slot edited or deleted under a
 * prompt.
 *
 * The test user has the five default periods: Early morning 07:00, Morning
 * 09:00, Midday 12:00, Afternoon 16:00, Evening 20:30. Default waking window
 * 07:00-22:00. All titles are synthetic.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { DateTime } from 'luxon'
import { getDb } from '@/core/db'
import { createTask } from '@/core/tasks'
import { incrementProgress } from '@/core/tasks/progress'
import { actOnPrompts } from '@/core/tasks/quota-prompt-actions'
import { listTimeSlots } from '@/core/time-slots'
import { deleteTimeSlot, updateTimeSlot } from '@/core/time-slots/edit'
import { executeUndo } from '@/core/undo'
import { pendingSlotNotifications } from '@/core/notifications/slot-reminders'
import { pendingSlotNags } from '@/core/notifications/slot-nags'
import { validateTaskUpdate } from '@/core/validation'
import { updateTask } from '@/core/tasks'
import { promptKey } from '@/lib/quota-prompts'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

const base = { userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE }

/** A UTC instant for a wall-clock time in the test timezone, on 2026-01-<day>. */
function at(hour: number, minute = 0, day = 15): Date {
  return DateTime.fromObject(
    { year: 2026, month: 1, day, hour, minute },
    { zone: TEST_TIMEZONE },
  ).toJSDate()
}

/** Move the clock (a write reads it for its rollover), then act. */
function clock(now: Date): Date {
  vi.setSystemTime(now)
  return now
}

function quota(title: string, rrule: string, target: number) {
  return createTask({
    ...base,
    input: { title, rrule, progress_target: target, is_tracked: true },
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

/** The one push due at `now`, as [slot, reminders, prompts]; null when silent. */
function push(now: Date): [string, number, number] | null {
  const pending = pendingSlotNotifications(now)
  expect(pending.length).toBeLessThanOrEqual(1)
  return pending[0] ? [pending[0].slotLabel, pending[0].count, pending[0].promptCount] : null
}

beforeEach(() => {
  vi.setSystemTime(at(6))
  setupTestDb()
  delete process.env.OPENTASK_QUOTA_PROMPTS
})

afterEach(() => {
  vi.useRealTimers()
  delete process.env.OPENTASK_QUOTA_PROMPTS
  teardownTestDb()
})

describe('Daily N>1 across the day', () => {
  test('QNM-001: #1 wakes Morning, #2 wakes Midday, and a +1 elsewhere finishes #1 only', () => {
    setUserDefault(slotId('Morning'))
    const q = quota('Glasses of water', 'FREQ=DAILY', 2)

    expect(push(at(7))).toBeNull() // nothing in Early morning
    expect(push(at(9))).toEqual(['Morning', 0, 1])

    // The watch logs one at 10:00: #1 is done; #2 still waits for Midday.
    clock(at(10))
    incrementProgress({ userId: TEST_USER_ID, taskId: q.id })
    expect(push(at(12))).toEqual(['Midday', 0, 1])
    // Morning has nothing left, and Midday has not opened: no nag at 11:00.
    expect(pendingSlotNags(clock(at(11)))).toHaveLength(0)
  })

  test('QNM-002: a +1 before the Morning push finishes #1, so Morning stays silent', () => {
    setUserDefault(slotId('Morning'))
    const q = quota('Glasses of water', 'FREQ=DAILY', 2)
    clock(at(8))
    incrementProgress({ userId: TEST_USER_ID, taskId: q.id })

    expect(push(at(9))).toBeNull()
    expect(push(at(12))).toEqual(['Midday', 0, 1])
  })
})

describe('Progress from elsewhere', () => {
  test('QNM-003: a +1 from the widget or watch silences a weekly prompt’s push and its nags', () => {
    const q = quota('Cook vegetables', 'FREQ=WEEKLY', 5) // Early morning by default
    expect(push(at(7))).toEqual(['Early morning', 0, 1])
    expect(pendingSlotNags(clock(at(8)))).toHaveLength(1)

    // A plain +1 — not a prompt action — at 08:30.
    clock(at(8, 30))
    incrementProgress({ userId: TEST_USER_ID, taskId: q.id })
    expect(push(at(7))).toBeNull()
    expect(pendingSlotNags(clock(at(9)))).toHaveLength(0)

    // Taken back with a −1, the prompt waits again and the nag returns.
    incrementProgress({ userId: TEST_USER_ID, taskId: q.id, delta: -1 })
    expect(pendingSlotNags(clock(at(10)))).toEqual([
      expect.objectContaining({ slotLabel: 'Early morning', promptCount: 1 }),
    ])
  })
})

describe('The first nags of a new day', () => {
  test("QNM-004: after midnight, yesterday's considered and a met daily both wait again; a met weekly does not", () => {
    // Awake round the clock, so 01:00 is a nag hour.
    getDb()
      .prepare("UPDATE users SET wake_time = '00:00', sleep_time = '00:00' WHERE id = ?")
      .run(TEST_USER_ID)
    const considered = quota('Cook vegetables', 'FREQ=WEEKLY', 5)
    const daily = quota('Glasses of water', 'FREQ=DAILY', 1)
    const met = quota('Date night', 'FREQ=WEEKLY', 1)
    const thu = clock(at(20))
    actOnPrompts({
      ...base,
      now: thu,
      actions: [
        { key: promptKey(considered.id, 0, '2026-01-15'), did: false },
        { key: promptKey(daily.id, 1, '2026-01-15'), did: true },
        { key: promptKey(met.id, 0, '2026-01-15'), did: true },
      ],
    })
    expect(pendingSlotNags(clock(at(21)))).toHaveLength(0)

    // 01:00 Friday: no period of the new day has opened, and Thursday's
    // prompts are Thursday's — nothing nags.
    expect(pendingSlotNags(clock(at(1, 0, 16)))).toHaveLength(0)

    // 08:00 Friday, Early morning open: the considered weekly and the daily
    // (met yesterday, 0/1 today) wait again; the met weekly stays gone.
    const [nag] = pendingSlotNags(clock(at(8, 0, 16)))
    expect(nag).toMatchObject({ slotLabel: 'Early morning', count: 0, promptCount: 2 })
  })
})

describe('A slot edited or deleted under a prompt', () => {
  test('QNM-005: a retimed slot notifies its prompts at the NEW start, and at the old one after undo', () => {
    const q = quota('Cook vegetables', 'FREQ=WEEKLY', 5)
    const morning = slotId('Morning')
    updateTask({
      ...base,
      taskId: q.id,
      input: validateTaskUpdate({ quota_prompt_config: { slot_id: morning } }),
    })
    updateTimeSlot({ ...base, slotId: morning, input: { start_time: '09:30' } })

    expect(push(at(9))).toBeNull()
    expect(push(at(9, 30))).toEqual(['Morning', 0, 1])

    executeUndo(TEST_USER_ID)
    expect(push(at(9))).toEqual(['Morning', 0, 1])
    expect(push(at(9, 30))).toBeNull()
  })

  test("QNM-006: a deleted slot's prompts notify at the nearest slot's start; undo sends them back", () => {
    const q = quota('Cook vegetables', 'FREQ=WEEKLY', 5)
    const afternoon = slotId('Afternoon')
    updateTask({
      ...base,
      taskId: q.id,
      input: validateTaskUpdate({ quota_prompt_config: { slot_id: afternoon } }),
    })
    expect(push(at(16))).toEqual(['Afternoon', 0, 1])

    deleteTimeSlot({ ...base, slotId: afternoon })
    expect(push(at(7))).toBeNull() // not dropped to the first period
    expect(push(at(12))).toEqual(['Midday', 0, 1])

    executeUndo(TEST_USER_ID)
    expect(push(at(12))).toBeNull()
    expect(push(at(16))).toEqual(['Afternoon', 0, 1])
  })
})
