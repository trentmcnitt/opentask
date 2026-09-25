/**
 * QN-001..: quota prompts in the slot notifications and the hourly nags
 * (quota reminders phase 3, 2026-09-24).
 *
 * Trent's rule: prompts behave EXACTLY like reminders. A slot with only
 * prompts still notifies; a slot stays unfinished for the nags until every
 * prompt is considered or done; the body counts both. Both off switches take
 * prompts out entirely, and the app-icon badge never counts them.
 *
 * The test user has the five default periods: Early morning 07:00, Morning
 * 09:00, Midday 12:00, Afternoon 16:00, Evening 20:30. Default waking window
 * 07:00-22:00. A weekly quota prompts in Early morning by default.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { DateTime } from 'luxon'
import { getDb } from '@/core/db'
import { createTask, markDone } from '@/core/tasks'
import { actOnPrompts } from '@/core/tasks/quota-prompt-actions'
import { countCurrentlyDue } from '@/core/tasks/currently-due'
import { listTimeSlots } from '@/core/time-slots'
import { pendingSlotNotifications, waitingBySlot } from '@/core/notifications/slot-reminders'
import { pendingSlotNags, slotNagBody } from '@/core/notifications/slot-nags'
import { slotWaitingBody } from '@/core/notifications/apns'
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

function weeklyQuota(title = 'Cook vegetables', target = 5) {
  return createTask({
    ...base,
    input: { title, rrule: 'FREQ=WEEKLY', progress_target: target, is_tracked: true },
  })
}

function reminderAt(hour: number, minute = 0) {
  return createTask({
    ...base,
    input: {
      title: 'Depressed = Past, Anxious = Future',
      is_reminder: true,
      due_at: DateTime.fromJSDate(at(hour, minute)).toUTC().toISO()!,
    },
  })
}

function slotId(label: string): number {
  const slot = listTimeSlots(TEST_USER_ID).find((s) => s.label === label)
  if (!slot) throw new Error(`no slot ${label}`)
  return slot.id
}

function consider(taskId: number, now: Date, did = false, date = '2026-01-15') {
  actOnPrompts({ ...base, now, actions: [{ key: promptKey(taskId, 0, date), did }] })
}

beforeEach(() => {
  vi.setSystemTime(at(7))
  setupTestDb()
  delete process.env.OPENTASK_QUOTA_PROMPTS
})

afterEach(() => {
  vi.useRealTimers()
  delete process.env.OPENTASK_QUOTA_PROMPTS
  teardownTestDb()
})

describe('Quota prompts — slot-open push', () => {
  test('QN-001: a slot with only prompts still notifies, counting them', () => {
    weeklyQuota('Cook vegetables')
    weeklyQuota('Read')

    const pending = pendingSlotNotifications(at(7))
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ slotLabel: 'Early morning', count: 0, promptCount: 2 })
  })

  test('QN-002: reminders and prompts in one slot are counted separately', () => {
    reminderAt(7)
    reminderAt(7, 30)
    weeklyQuota()

    const [pending] = pendingSlotNotifications(at(7))
    expect(pending).toMatchObject({ count: 2, promptCount: 1 })
  })

  test('QN-003: a considered or done prompt no longer counts; all handled is silence', () => {
    const a = weeklyQuota('Cook vegetables')
    const b = weeklyQuota('Read')

    consider(a.id, at(6, 30))
    expect(pendingSlotNotifications(at(7))[0]).toMatchObject({ promptCount: 1 })

    consider(b.id, at(6, 45), true) // did it: +1, and considered
    expect(pendingSlotNotifications(at(7))).toHaveLength(0)
  })

  test('QN-004: a prompt in another slot does not wake this one', () => {
    getDb()
      .prepare('UPDATE users SET quota_prompt_slot_id = ? WHERE id = ?')
      .run(slotId('Evening'), TEST_USER_ID)
    weeklyQuota()

    expect(pendingSlotNotifications(at(7))).toHaveLength(0)
    expect(pendingSlotNotifications(at(20, 30))[0]).toMatchObject({
      slotLabel: 'Evening',
      promptCount: 1,
    })
  })

  test("QN-005: the user's switch takes prompts out of the push", () => {
    reminderAt(7)
    weeklyQuota()
    getDb().prepare('UPDATE users SET quota_prompts_enabled = 0 WHERE id = ?').run(TEST_USER_ID)

    expect(pendingSlotNotifications(at(7))[0]).toMatchObject({ count: 1, promptCount: 0 })
  })

  test('QN-006: the server kill switch takes prompts out of the push', () => {
    weeklyQuota()
    expect(pendingSlotNotifications(at(7))).toHaveLength(1)

    process.env.OPENTASK_QUOTA_PROMPTS = 'off'
    expect(pendingSlotNotifications(at(7))).toHaveLength(0)
  })

  test("QN-007: prompts are keyed by the owner's local date — yesterday's consider does not carry over", () => {
    const q = weeklyQuota()
    consider(q.id, at(6, 30))
    expect(pendingSlotNotifications(at(7))).toHaveLength(0)

    // The next local day: yesterday's consider is yesterday's key.
    vi.setSystemTime(at(7, 0, 16))
    expect(pendingSlotNotifications(at(7, 0, 16))[0]).toMatchObject({ promptCount: 1 })
  })

  test('QN-008: 23:30 local is still the same day, even though UTC has rolled over', () => {
    const q = weeklyQuota()
    getDb()
      .prepare('UPDATE users SET quota_prompt_slot_id = ? WHERE id = ?')
      .run(slotId('Evening'), TEST_USER_ID)
    // 20:30 Chicago on the 15th is 02:30 UTC on the 16th.
    consider(q.id, at(20, 0))
    expect(waitingBySlot(TEST_USER_ID, TEST_TIMEZONE, at(23, 30)).get(slotId('Evening'))).toEqual({
      reminders: 0,
      prompts: 0,
    })
  })
})

describe('Quota prompts — hourly nags', () => {
  test('QN-010: nags continue while only prompts remain', () => {
    const reminder = reminderAt(7)
    const q = weeklyQuota()

    expect(pendingSlotNags(at(8))[0]).toMatchObject({ count: 1, promptCount: 1 })

    markDone({ ...base, taskId: reminder.id })
    const [nag] = pendingSlotNags(at(8))
    expect(nag).toMatchObject({ slotLabel: 'Early morning', count: 0, promptCount: 1 })
    expect(slotNagBody(nag.count, nag.promptCount, nag.otherSlots)).toBe('1 quota waiting')

    consider(q.id, at(8))
    expect(pendingSlotNags(at(10))).toHaveLength(0)
  })

  test('QN-011: a prompts-only slot counts as an earlier unfinished slot', () => {
    weeklyQuota() // Early morning
    reminderAt(9) // Morning

    const [nag] = pendingSlotNags(at(10))
    expect(nag).toMatchObject({ slotLabel: 'Morning', count: 1, promptCount: 0, otherSlots: 1 })
  })

  test('QN-012: both off switches silence a prompts-only nag', () => {
    weeklyQuota()
    expect(pendingSlotNags(at(8))).toHaveLength(1)

    process.env.OPENTASK_QUOTA_PROMPTS = 'off'
    expect(pendingSlotNags(at(8))).toHaveLength(0)

    delete process.env.OPENTASK_QUOTA_PROMPTS
    getDb().prepare('UPDATE users SET quota_prompts_enabled = 0 WHERE id = ?').run(TEST_USER_ID)
    expect(pendingSlotNags(at(8))).toHaveLength(0)
  })

  test('QN-013: a met-before-today quota does not nag', () => {
    const q = weeklyQuota('Read', 1)
    consider(q.id, at(6, 30), true) // met on the 15th
    vi.setSystemTime(at(8, 0, 16))
    expect(pendingSlotNags(at(8, 0, 16))).toHaveLength(0)
  })
})

describe('Quota prompts — copy', () => {
  test('QN-020: the slot body counts both, leaving out a zero side', () => {
    expect(slotWaitingBody(1)).toBe('1 reminder waiting')
    expect(slotWaitingBody(3, 0)).toBe('3 reminders waiting')
    expect(slotWaitingBody(0, 1)).toBe('1 quota waiting')
    expect(slotWaitingBody(0, 2)).toBe('2 quotas waiting')
    expect(slotWaitingBody(3, 2)).toBe('3 reminders · 2 quotas waiting')
    expect(slotWaitingBody(1, 1)).toBe('1 reminder · 1 quota waiting')
  })

  test('QN-021: the nag body appends the other slots to the same phrase', () => {
    expect(slotNagBody(3, 2, 1)).toBe('3 reminders · 2 quotas waiting, and 1 earlier slot')
    expect(slotNagBody(0, 2, 2)).toBe('2 quotas waiting, and 2 earlier slots')
  })
})

describe('Quota prompts — never the badge', () => {
  test('QN-030: an unmet quota with a waiting prompt is not in countCurrentlyDue', () => {
    createTask({
      ...base,
      input: {
        title: 'Walk',
        rrule: 'FREQ=DAILY',
        progress_target: 2,
        is_tracked: true,
      },
    })
    expect(pendingSlotNotifications(at(7))[0]).toMatchObject({ promptCount: 1 })
    expect(countCurrentlyDue(TEST_USER_ID, at(7))).toBe(0)
  })
})
