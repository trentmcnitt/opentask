/**
 * The one-day move's client rule (2026-11-21; earlier periods too since
 * 11-27): which periods the web offers (`movePeriodsToday`,
 * `movePeriodsForAll` in src/lib/reminder-move.ts),
 * how a move is drawn before the server confirms it (`applyDayMoves`), and
 * the parity that matters most — every period the web offers is one the
 * server accepts, and every other one it refuses (RULE RM-MOVE-TARGET).
 * Invented titles only.
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

import { createTask } from '@/core/tasks'
import { moveForToday, describeMove } from '@/core/tasks/reminder-move'
import { getRemindersBySlot } from '@/core/tasks/reminders'
import { dayBoundaryForUser } from '@/core/tasks/rollover-time'
import { listTimeSlots } from '@/core/time-slots'
import { ValidationError } from '@/core/errors'
import {
  applyDayMoves,
  movePeriodsForAll,
  movePeriodsToday,
  moveMessage,
} from '@/lib/reminder-move'
import type { TimeSlot } from '@/lib/time-slot-assign'
import type { QuotaPrompt } from '@/lib/quota-prompts'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

const tz = TEST_TIMEZONE

/** A UTC instant for a wall-clock time on 2026-01-<day> in the test zone. */
function at(hour: number, minute = 0, day = 15): Date {
  return DateTime.fromObject({ year: 2026, month: 1, day, hour, minute }, { zone: tz }).toJSDate()
}

const slot = (id: number, label: string, start_time: string): TimeSlot =>
  ({ id, label, start_time }) as TimeSlot

const EARLY = slot(1, 'Early morning', '07:00')
const MORNING = slot(2, 'Morning', '09:00')
const MIDDAY = slot(3, 'Midday', '12:00')
const AFTERNOON = slot(4, 'Afternoon', '16:00')
const EVENING = slot(5, 'Evening', '20:30')
// Listed out of order on purpose: the result is in opening order.
const SLOTS = [EVENING, EARLY, AFTERNOON, MORNING, MIDDAY]
const labels = (slots: TimeSlot[]) => slots.map((s) => s.label)

describe('RM-ML-01 movePeriodsToday: every period of today but its own, in day order', () => {
  test('from Morning at 10:00: the rest, earlier and later, in opening order', () => {
    expect(labels(movePeriodsToday(MORNING, SLOTS, at(10), tz, '00:00'))).toEqual([
      'Early morning',
      'Midday',
      'Afternoon',
      'Evening',
    ])
  })

  test('periods already open are offered too (Morning at 16:30)', () => {
    expect(labels(movePeriodsToday(MORNING, SLOTS, at(16, 30), tz, '00:00'))).toEqual([
      'Early morning',
      'Midday',
      'Afternoon',
      'Evening',
    ])
  })

  test('the last period moves earlier; Anytime has none', () => {
    expect(labels(movePeriodsToday(EVENING, SLOTS, at(21), tz, '00:00'))).toEqual([
      'Early morning',
      'Morning',
      'Midday',
      'Afternoon',
    ])
    expect(movePeriodsToday(null, SLOTS, at(10), tz, '00:00')).toEqual([])
  })

  test('an unparseable start is neither a current period nor a target', () => {
    const bad = slot(9, 'Broken', '9am')
    expect(movePeriodsToday(bad, SLOTS, at(10), tz, '00:00')).toEqual([])
    expect(labels(movePeriodsToday(MIDDAY, [...SLOTS, bad], at(10), tz, '00:00'))).toEqual([
      'Early morning',
      'Morning',
      'Afternoon',
      'Evening',
    ])
  })

  test('a period before the day start is the LAST of the day (01:00 with a 03:00 start)', () => {
    const late = slot(6, 'Late night', '01:00')
    const slots = [...SLOTS, late]
    expect(labels(movePeriodsToday(EVENING, slots, at(22), tz, '03:00')).at(-1)).toBe('Late night')
    // With a midnight day start 01:00 is the day's first period.
    expect(labels(movePeriodsToday(EVENING, slots, at(22), tz, '00:00'))[0]).toBe('Late night')
  })
})

describe('RM-ML-02 movePeriodsForAll: the periods every selected item can go to', () => {
  test('Morning and Afternoon: every period but those two', () => {
    expect(labels(movePeriodsForAll([MORNING, AFTERNOON], SLOTS, at(10), tz, '00:00'))).toEqual([
      'Early morning',
      'Midday',
      'Evening',
    ])
  })

  test('one in Anytime: none', () => {
    expect(movePeriodsForAll([MORNING, null], SLOTS, at(10), tz, '00:00')).toEqual([])
  })

  test('nothing selected: none; one item: its own', () => {
    expect(movePeriodsForAll([], SLOTS, at(10), tz, '00:00')).toEqual([])
    expect(labels(movePeriodsForAll([MIDDAY], SLOTS, at(10), tz, '00:00'))).toEqual([
      'Early morning',
      'Morning',
      'Afternoon',
      'Evening',
    ])
  })
})

type Row = { id: number; priority: number | null }
type Group = {
  slot: TimeSlot | null
  reminders: Row[]
  count: number
  prompts: QuotaPrompt[]
}
const group = (s: TimeSlot | null, reminders: Row[], prompts: QuotaPrompt[] = []): Group => ({
  slot: s,
  reminders,
  count: reminders.length,
  prompts,
})
const prompt = (key: string, slotId: number): QuotaPrompt =>
  ({
    prompt_key: key,
    slot_id: slotId,
    task_id: 50,
    title: 'Stretch',
    priority: 0,
    number: null,
  }) as unknown as QuotaPrompt

describe('RM-ML-03 applyDayMoves draws a move before the server confirms it', () => {
  const base = () => [
    group(MORNING, [
      { id: 1, priority: 0 },
      { id: 2, priority: 0 },
    ]),
    group(AFTERNOON, [
      { id: 3, priority: 0 },
      { id: 4, priority: 0 },
    ]),
    group(EVENING, [], [prompt('q:50:-:2026-01-15', EVENING.id)]),
    group(null, []),
  ]

  test('a reminder moves into its period in the server order (priority, then id)', () => {
    const out = applyDayMoves(base(), new Map([[2, AFTERNOON.id]]))
    expect(out[0].reminders.map((r) => r.id)).toEqual([1])
    expect(out[0].count).toBe(1)
    expect(out[1].reminders.map((r) => r.id)).toEqual([2, 3, 4])
    expect(out[1].count).toBe(3)
  })

  test('a higher priority goes first', () => {
    const high = applyDayMoves(
      [group(MORNING, [{ id: 9, priority: 3 }]), group(AFTERNOON, [{ id: 3, priority: 0 }])],
      new Map([[9, AFTERNOON.id]]),
    )
    expect(high[1].reminders.map((r) => r.id)).toEqual([9, 3])
    const low = applyDayMoves(
      [group(MORNING, [{ id: 9, priority: 1 }]), group(AFTERNOON, [{ id: 3, priority: 0 }])],
      new Map([[9, AFTERNOON.id]]),
    )
    // Low (1) ranks below unset (0).
    expect(low[1].reminders.map((r) => r.id)).toEqual([3, 9])
  })

  test('idempotent: a payload that already has it is unchanged', () => {
    const once = applyDayMoves(base(), new Map([[2, AFTERNOON.id]]))
    expect(applyDayMoves(once, new Map([[2, AFTERNOON.id]]))).toEqual(once)
  })

  test('a prompt moves by its key; an unknown id or a missing period is skipped', () => {
    const out = applyDayMoves(
      base(),
      new Map<number | string, number>([
        ['q:50:-:2026-01-15', AFTERNOON.id],
        [77, EVENING.id],
        [1, 999],
      ]),
    )
    expect(out[1].prompts.map((p) => [p.prompt_key, p.slot_id])).toEqual([
      ['q:50:-:2026-01-15', AFTERNOON.id],
    ])
    expect(out[2].prompts).toEqual([])
    expect(out[0].reminders.map((r) => r.id)).toEqual([1, 2])
  })
})

describe('RM-ML-04 the toast is the server’s own words', () => {
  test('one, and several', () => {
    expect(moveMessage(['Water the ferns'], 'Evening')).toBe(
      describeMove(['Water the ferns'], 'Evening'),
    )
    expect(moveMessage(['a', 'b', 'c'], 'Midday')).toBe(describeMove(['a', 'b', 'c'], 'Midday'))
  })
})

describe('RM-ML-05 parity: the web offers exactly the periods the server accepts', () => {
  beforeEach(() => {
    vi.setSystemTime(at(8))
    setupTestDb()
  })
  afterEach(() => vi.useRealTimers())
  afterAll(() => teardownTestDb())

  /** A one-off reminder at `hour`:30 today; invented title. */
  const reminder = (hour: number) =>
    createTask({
      userId: TEST_USER_ID,
      userTimezone: tz,
      input: { title: 'Wind the clock', is_reminder: true, due_at: at(hour, 30).toISOString() },
    })

  const periodOf = (id: number, now: Date): TimeSlot | null | undefined =>
    getRemindersBySlot(TEST_USER_ID, tz, now).find((g) => g.reminders.some((t) => t.id === id))
      ?.slot

  // A reminder in each of Morning, Midday and Afternoon, at several moments of the day.
  for (const [hour, nowHour] of [
    [9, 10],
    [12, 10],
    [9, 13],
    [16, 17],
    [7, 21],
  ] as const) {
    test(`a ${hour}:30 reminder at ${nowHour}:00`, () => {
      const now = at(nowHour)
      vi.setSystemTime(now)
      const slots = listTimeSlots(TEST_USER_ID)
      const dayStart = dayBoundaryForUser(TEST_USER_ID)
      for (const target of slots) {
        const r = reminder(hour)
        const current = periodOf(r.id, now) ?? null
        const offered = movePeriodsToday(current, slots, now, tz, dayStart).some(
          (s) => s.id === target.id,
        )
        const call = () =>
          moveForToday({
            userId: TEST_USER_ID,
            userTimezone: tz,
            ids: [r.id],
            promptKeys: [],
            slotId: target.id,
            now,
          })
        if (offered) expect(call().slot.id, target.label).toBe(target.id)
        else expect(call, target.label).toThrow(ValidationError)
      }
    })
  }
})
