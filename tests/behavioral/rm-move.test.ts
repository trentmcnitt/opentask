/**
 * The one-day move (2026-11-21): a reminder or a quota prompt moved to a
 * later period for today only. Rules RM-MOVE-STORE, RM-MOVE-PLACE,
 * RM-MOVE-TARGET, RM-MOVE-COMMIT (src/core/tasks/reminder-move.ts,
 * src/lib/time-slot-assign.ts). The default periods: Early morning 07:00,
 * Morning 09:00, Midday 12:00, Afternoon 16:00, Evening 20:30.
 */
import { describe, test, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { DateTime } from 'luxon'

vi.mock('@/core/notifications/dismiss', () => ({
  dismissNotificationsForTasks: vi.fn(),
  dismissPromptNotifications: vi.fn(),
  syncBadgeCount: vi.fn(),
  getOverdueCount: vi.fn().mockReturnValue(0),
}))
vi.mock('@/core/webhooks/dispatch', () => ({ dispatchWebhookEvent: vi.fn() }))

import { getDb } from '@/core/db'
import { createTask, markDone, updateTask } from '@/core/tasks'
import { moveForToday } from '@/core/tasks/reminder-move'
import { getRemindersBySlot } from '@/core/tasks/reminders'
import { getQuotaPromptsBySlot } from '@/core/tasks/quota-prompts'
import { pendingReminderNags, REMINDER_NAG_SOURCE } from '@/core/notifications/reminder-nags'
import { planTick } from '@/core/notifications/tick'
import {
  dismissNotificationsForTasks,
  dismissPromptNotifications,
} from '@/core/notifications/dismiss'
import { listTimeSlots } from '@/core/time-slots'
import { executeRedo, executeUndo } from '@/core/undo'
import { ValidationError } from '@/core/errors'
import { validateTaskUpdate } from '@/core/validation'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

const tz = TEST_TIMEZONE

/** A UTC instant for a wall-clock time on 2026-01-<day> in the test zone. */
function at(hour: number, minute = 0, day = 15): Date {
  return DateTime.fromObject({ year: 2026, month: 1, day, hour, minute }, { zone: tz }).toJSDate()
}

function slotId(label: string): number {
  const slot = listTimeSlots(TEST_USER_ID).find((s) => s.label === label)
  if (!slot) throw new Error(`no slot ${label}`)
  return slot.id
}

/** A one-off reminder at 09:30 today (Morning) by default; invented title. */
function reminder(priority = 0, hour = 9, minute = 30) {
  return createTask({
    userId: TEST_USER_ID,
    userTimezone: tz,
    input: {
      title: 'Iron the shirts',
      is_reminder: true,
      due_at: at(hour, minute).toISOString(),
      priority,
    },
  })
}

/** Which period each reminder is in on `now`'s day, by label ("Anytime" for none). */
function periodOf(id: number, now: Date): string | null {
  for (const group of getRemindersBySlot(TEST_USER_ID, tz, now)) {
    if (group.reminders.some((t) => t.id === id)) return group.slot?.label ?? 'Anytime'
  }
  return null
}

function move(ids: number[], label: string, promptKeys: string[] = []) {
  return moveForToday({
    userId: TEST_USER_ID,
    userTimezone: tz,
    ids,
    promptKeys,
    slotId: slotId(label),
    now: new Date(),
  })
}

beforeEach(() => {
  vi.setSystemTime(at(8))
  setupTestDb()
  vi.clearAllMocks()
})
afterEach(() => vi.useRealTimers())
afterAll(() => teardownTestDb())

describe('RM-MV-01 the move holds for today only (RM-MOVE-STORE, RM-MOVE-PLACE)', () => {
  test('a Morning reminder moved to Afternoon is in Afternoon today and home tomorrow', () => {
    const r = reminder()
    vi.setSystemTime(at(10))
    expect(periodOf(r.id, at(10))).toBe('Morning')
    const result = move([r.id], 'Afternoon')
    expect(result.moved).toEqual([r.id])
    expect(result.description).toBe('Moved “Iron the shirts” to Afternoon for today')
    expect(periodOf(r.id, at(10))).toBe('Afternoon')
    expect(periodOf(r.id, at(17))).toBe('Afternoon')
    // Tomorrow: home again, nothing cleared.
    expect(periodOf(r.id, at(10, 0, 16))).toBe('Morning')
    // Its time is untouched.
    const row = getDb().prepare('SELECT due_at FROM tasks WHERE id = ?').get(r.id) as {
      due_at: string
    }
    expect(row.due_at).toBe(at(9, 30).toISOString())
  })

  test('considered after the move, it is counted in the period it moved to', () => {
    const r = reminder()
    vi.setSystemTime(at(10))
    move([r.id], 'Afternoon')
    vi.setSystemTime(at(16, 30))
    markDone({ userId: TEST_USER_ID, userTimezone: tz, taskId: r.id })
    const groups = getRemindersBySlot(TEST_USER_ID, tz, at(16, 31))
    const afternoon = groups.find((g) => g.slot?.label === 'Afternoon')!
    expect(afternoon.consideredItems.map((t) => t.id)).toEqual([r.id])
    expect(groups.find((g) => g.slot?.label === 'Morning')!.consideredItems).toEqual([])
  })

  test('a move into a period deleted since falls back home', () => {
    const r = reminder()
    vi.setSystemTime(at(10))
    move([r.id], 'Afternoon')
    getDb().prepare('DELETE FROM time_slots WHERE id = ?').run(slotId('Afternoon'))
    expect(periodOf(r.id, at(10))).toBe('Morning')
  })
})

describe('RM-MV-02 one undo entry; undo puts it home, redo moves it again (RM-MOVE-COMMIT)', () => {
  test('undo and redo', () => {
    const r = reminder()
    vi.setSystemTime(at(10))
    move([r.id], 'Evening')
    expect(periodOf(r.id, at(10))).toBe('Evening')
    executeUndo(TEST_USER_ID)
    expect(periodOf(r.id, at(10))).toBe('Morning')
    executeRedo(TEST_USER_ID)
    expect(periodOf(r.id, at(10))).toBe('Evening')
  })

  test('the moved reminders’ banners are dismissed', () => {
    const a = reminder(2)
    const b = reminder(2, 10)
    vi.setSystemTime(at(10, 30))
    move([a.id, b.id], 'Midday')
    expect(dismissNotificationsForTasks).toHaveBeenCalledWith(TEST_USER_ID, [a.id, b.id])
    expect(dismissPromptNotifications).not.toHaveBeenCalled()
  })
})

describe('RM-MV-03 to any other period of today, earlier or later, open or not (RM-MOVE-TARGET)', () => {
  const refused = (fn: () => unknown) => expect(fn).toThrow(ValidationError)

  test('a period already open is accepted, earlier and later (Trent, 2026-11-27)', () => {
    const r = reminder() // Morning
    vi.setSystemTime(at(13))
    expect(move([r.id], 'Midday').moved).toEqual([r.id]) // later, already open
    expect(periodOf(r.id, at(13))).toBe('Midday')
    expect(move([r.id], 'Early morning').moved).toEqual([r.id]) // earlier than its home
    expect(periodOf(r.id, at(13))).toBe('Early morning')
  })

  test('a period earlier than its own, not yet reached, is accepted', () => {
    const r = reminder(0, 17, 0) // Afternoon
    vi.setSystemTime(at(8))
    expect(move([r.id], 'Morning').moved).toEqual([r.id])
    expect(periodOf(r.id, at(8))).toBe('Morning')
  })

  test('its own period (a moved one: the period it moved to) is refused', () => {
    const r = reminder(0, 12, 30) // Midday
    vi.setSystemTime(at(8))
    refused(() => move([r.id], 'Midday'))
    move([r.id], 'Evening')
    refused(() => move([r.id], 'Evening'))
    expect(move([r.id], 'Midday').moved).toEqual([r.id]) // back to its home is a move
  })

  test('not waiting today: considered, Anytime, another user’s id, an unknown period', () => {
    const considered = reminder()
    vi.setSystemTime(at(9, 45))
    markDone({ userId: TEST_USER_ID, userTimezone: tz, taskId: considered.id })
    refused(() => move([considered.id], 'Afternoon'))
    const anytime = reminder(0, 5, 0) // before every period
    refused(() => move([anytime.id], 'Afternoon'))
    refused(() => move([999_999], 'Afternoon'))
    expect(() =>
      moveForToday({
        userId: TEST_USER_ID,
        userTimezone: tz,
        ids: [reminder().id],
        promptKeys: [],
        slotId: 999_999,
        now: new Date(),
      }),
    ).toThrow(ValidationError)
  })

  test('nothing is written when any item is refused', () => {
    const ok = reminder()
    const already = reminder(0, 17, 0) // Afternoon
    vi.setSystemTime(at(10))
    refused(() => move([ok.id, already.id], 'Afternoon'))
    expect(periodOf(ok.id, at(10))).toBe('Morning')
  })
})

describe('RM-MV-04 the named nag starts fresh at the new period (NAMED-PUSH-TIMING)', () => {
  /** One tick of the named reminder pushes (claims applied): did anything go? */
  const tick = (now: Date) =>
    planTick([REMINDER_NAG_SOURCE], now, { apns: true, webPush: true }).sends.length > 0

  test('pushed at Morning’s open; moved to Afternoon, silent until 16:00, then pushed', () => {
    const r = reminder(2)
    expect(tick(at(9))).toBe(true)
    vi.setSystemTime(at(10))
    move([r.id], 'Afternoon')
    for (const hour of [11, 12, 13, 14, 15]) {
      expect(pendingReminderNags(at(hour)), `${hour}:00`).toEqual([])
    }
    expect(pendingReminderNags(at(15, 59))).toEqual([])
    expect(pendingReminderNags(at(16))).toMatchObject([{ taskId: r.id, slotLabel: 'Afternoon' }])
  })
})

describe('RM-MV-05 a quota prompt moves for today the same way', () => {
  test('its key moves to the later period; undo puts it back', () => {
    const q = createTask({
      userId: TEST_USER_ID,
      userTimezone: tz,
      input: {
        title: 'Practise scales',
        rrule: 'FREQ=WEEKLY',
        progress_target: 3,
        is_tracked: true,
      },
    })
    updateTask({
      userId: TEST_USER_ID,
      userTimezone: tz,
      taskId: q.id,
      input: validateTaskUpdate({ quota_prompt_config: { slot_id: slotId('Morning') } }),
    })
    vi.setSystemTime(at(10))
    const where = () => {
      for (const [id, prompts] of getQuotaPromptsBySlot(TEST_USER_ID, tz, at(10))) {
        const hit = prompts.find((p) => p.task_id === q.id)
        if (hit)
          return {
            slot: listTimeSlots(TEST_USER_ID).find((s) => s.id === id)?.label,
            key: hit.prompt_key,
          }
      }
      return null
    }
    const before = where()!
    expect(before.slot).toBe('Morning')
    const result = move([], 'Evening', [before.key])
    expect(result.movedPrompts).toEqual([before.key])
    expect(where()!.slot).toBe('Evening')
    expect(dismissPromptNotifications).toHaveBeenCalledWith(TEST_USER_ID, [before.key])
    executeUndo(TEST_USER_ID)
    expect(where()!.slot).toBe('Morning')
  })
})

describe('RM-MV-06 moved into an open period, the named push starts at once (RM-MOVE-NAG)', () => {
  const tick = (now: Date) =>
    planTick([REMINDER_NAG_SOURCE], now, { apns: true, webPush: true }).sends.length > 0

  test('pushed at Midday; moved back to Morning at 13:10, pushed at the next tick, then on its cadence', () => {
    const r = reminder(2, 12, 30) // Medium, Midday
    expect(tick(at(12))).toBe(true)
    vi.setSystemTime(at(13, 10))
    expect(pendingReminderNags(at(13, 10))).toEqual([]) // its cadence has not come round
    move([r.id], 'Morning')
    expect(pendingReminderNags(at(13, 11))).toMatchObject([{ taskId: r.id, slotLabel: 'Morning' }])
    expect(tick(at(13, 11))).toBe(true)
    expect(pendingReminderNags(at(13, 12))).toEqual([]) // then its cadence again
  })

  test('undo puts the old floor back: no stray push', () => {
    const r = reminder(2, 12, 30)
    expect(tick(at(12))).toBe(true)
    vi.setSystemTime(at(13, 10))
    move([r.id], 'Morning')
    executeUndo(TEST_USER_ID)
    expect(periodOf(r.id, at(13, 11))).toBe('Midday')
    expect(pendingReminderNags(at(13, 11))).toEqual([])
  })

  test('moved into a period still ahead, the period’s open is the floor, as before', () => {
    const r = reminder(2) // Morning
    expect(tick(at(9))).toBe(true)
    vi.setSystemTime(at(10))
    move([r.id], 'Afternoon')
    expect(pendingReminderNags(at(10, 1))).toEqual([])
    expect(pendingReminderNags(at(16))).toMatchObject([{ taskId: r.id, slotLabel: 'Afternoon' }])
  })
})
