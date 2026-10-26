/**
 * ONE DAY BOUNDARY (TQ-D01..) — "Day starts at" 03:00 moves every day-keyed
 * reader together (Trent, 2026-10-23): with the task queue's switch on, the
 * stretch from midnight to 03:00 belongs to the day before, and 03:00
 * exactly starts the new one. Each area is checked at 00:30, 02:59 and
 * 03:00 the night after Thursday 2026-01-15 (America/Chicago):
 *
 * - the Reminders roster and "considered today" (a check-off at 00:30 is
 *   Thursday's), and a weekly reminder's day;
 * - quota prompts' `prompt_key` dates, and the stale-key refusal at the same
 *   instant; a daily quota's count (its day ends at 03:00 too), and a
 *   midnight anchor closing one short period;
 * - the slot nag (Thursday's unfinished Evening keeps nagging until 03:00; a
 *   1:00 AM period opens at the end of Thursday's day);
 * - the task rollover, attempts, the deadlines page's "seen", and the queue
 *   panels' day roster.
 *
 * Default slots (seeded by setupTestDb): Early morning 07:00, Morning 09:00,
 * Midday 12:00, Afternoon 16:00, Evening 20:30. 03:00 is also the unset
 * default (2026-10-24); several checks pin the contrast with a 07:00 start.
 */
import { CALENDAR_DAY_START } from '@/lib/opentask-day'
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { DateTime } from 'luxon'

vi.mock('@/core/notifications/dismiss', () => ({
  dismissNotificationsForTasks: vi.fn(),
  syncBadgeCount: vi.fn(),
}))
vi.mock('@/core/webhooks/dispatch', () => ({ dispatchWebhookEvent: vi.fn() }))

import { getDb } from '@/core/db'
import { createTask, markDone } from '@/core/tasks'
import { incrementProgress } from '@/core/tasks/progress'
import { getTaskById } from '@/core/tasks/read'
import {
  getConsideredToday,
  getRemindersBySlot,
  getRemindersNotToday,
} from '@/core/tasks/reminders'
import { getQuotaPromptsBySlot } from '@/core/tasks/quota-prompts'
import { planPromptActions } from '@/core/tasks/quota-prompt-actions'
import { rolloverTrackedPeriods } from '@/core/tasks/period-rollover'
import { runTaskRollover } from '@/core/tasks/task-rollover'
import { considerTasks, getTaskSegments } from '@/core/tasks/task-segments'
import { createTimeSlot } from '@/core/time-slots'
import { pendingSlotNags } from '@/core/notifications/slot-nags'
import { updatePreferences } from '@/core/users/preferences'
import { slotHasStarted, summarizeReminders } from '@/lib/reminders-summary'
import {
  naturalSlotIndex,
  orderGroupsByDay,
  pageAfterFinishing,
  type TimeSlot,
} from '@/lib/time-slot-assign'
import { offSyncEvent, onSyncEvent, type SyncEventInfo } from '@/lib/sync-events'
import type { Task } from '@/types'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

const tz = TEST_TIMEZONE
const u = { userId: TEST_USER_ID, userTimezone: tz }

function at(local: string): string {
  return DateTime.fromISO(local, { zone: tz }).toUTC().toISO()!
}
function clock(local: string): Date {
  const now = new Date(at(local))
  vi.setSystemTime(now)
  return now
}
function makeAt(local: string, input: Record<string, unknown>): Task {
  clock(local)
  return createTask({ ...u, input: { title: 'Synthetic task', ...input } })
}
function task(id: number): Task {
  return getTaskById(id)!
}

/** The Evening group's waiting reminders and considered count, as GET /api/reminders reads them. */
function evening(local: string): { waiting: number[]; considered: number } {
  const group = getRemindersBySlot(TEST_USER_ID, tz, clock(local)).find(
    (g) => g.slot?.label === 'Evening',
  )
  return { waiting: group?.reminders.map((t) => t.id) ?? [], considered: group?.considered ?? 0 }
}

/** Every prompt key the Reminders screen would send at `local`. */
function promptKeys(local: string): string[] {
  const now = clock(local)
  return [...getQuotaPromptsBySlot(TEST_USER_ID, tz, now).values()].flat().map((p) => p.prompt_key)
}

function setDayStart(time: string | null) {
  updatePreferences(TEST_USER_ID, { day_start_time: time, day_start_slot_id: null })
}

/** Thursday 2026-01-15 08:00, the switch on, the day starting at 03:00, Thursday's rollover run. */
function dayStartsAtThree() {
  beforeEach(() => {
    clock('2026-01-15T08:00')
    setupTestDb()
    vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
    setDayStart('03:00')
    getDb()
      .prepare("UPDATE users SET last_rollover_date = '2026-01-15' WHERE id = ?")
      .run(TEST_USER_ID)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.useRealTimers()
    teardownTestDb()
  })
}

describe('TQ-D: "Day starts at" 03:00 — the Reminders screen and quotas', () => {
  dayStartsAtThree()

  test('TQ-D01: a reminder checked off at 00:30 is Thursday’s; at 03:00 it waits again', () => {
    const r = makeAt('2026-01-15T08:00', {
      title: 'Evening thought',
      is_reminder: true,
      rrule: 'FREQ=DAILY',
      due_at: at('2026-01-15T20:30'),
    })
    expect(evening('2026-01-15T21:00')).toEqual({ waiting: [r.id], considered: 0 })
    expect(evening('2026-01-16T00:30')).toEqual({ waiting: [r.id], considered: 0 })

    clock('2026-01-16T00:30')
    markDone({ ...u, taskId: r.id })
    expect(evening('2026-01-16T00:31')).toEqual({ waiting: [], considered: 1 })
    expect(evening('2026-01-16T02:59')).toEqual({ waiting: [], considered: 1 })
    expect(
      getConsideredToday(TEST_USER_ID, tz, clock('2026-01-16T02:59')).map((t) => t.id),
    ).toEqual([r.id])
    // 03:00 exactly: Friday — the 00:30 check-off was yesterday's.
    expect(evening('2026-01-16T03:00')).toEqual({ waiting: [r.id], considered: 0 })
    expect(getConsideredToday(TEST_USER_ID, tz, clock('2026-01-16T03:00'))).toEqual([])

    // Starting at 07:00, 03:00 is still Thursday's day.
    setDayStart('07:00')
    expect(evening('2026-01-16T03:00')).toEqual({ waiting: [], considered: 1 })
  })

  test('TQ-D02: a Thursday-only reminder is on the roster until 03:00 Friday, then not today', () => {
    const r = makeAt('2026-01-15T08:00', {
      title: 'Thursday thought',
      is_reminder: true,
      rrule: 'FREQ=WEEKLY;BYDAY=TH',
      due_at: at('2026-01-15T20:30'),
    })
    expect(evening('2026-01-16T00:30').waiting).toEqual([r.id])
    expect(evening('2026-01-16T02:59').waiting).toEqual([r.id])
    expect(evening('2026-01-16T03:00').waiting).toEqual([])
    expect(
      getRemindersNotToday(TEST_USER_ID, tz, clock('2026-01-16T03:00')).map((t) => t.id),
    ).toEqual([r.id])
  })

  test('TQ-D03: prompt keys carry the OpenTask day, and a key is refused at exactly that boundary', () => {
    const q = makeAt('2026-01-15T08:00', {
      title: 'Stretch',
      rrule: 'FREQ=WEEKLY',
      progress_target: 3,
      is_tracked: true,
    })
    const thursday = `q:${q.id}:0:2026-01-15`
    const friday = `q:${q.id}:0:2026-01-16`
    expect(promptKeys('2026-01-16T00:30')).toEqual([thursday])
    expect(promptKeys('2026-01-16T02:59')).toEqual([thursday])
    expect(promptKeys('2026-01-16T03:00')).toEqual([friday])

    const plan = (key: string, local: string) =>
      planPromptActions(TEST_USER_ID, tz, [{ key, did: false }], clock(local))
    expect(plan(thursday, '2026-01-16T02:59')).toHaveLength(1)
    expect(() => plan(friday, '2026-01-16T02:59')).toThrow(/stale prompt keys/)
    expect(() => plan(thursday, '2026-01-16T03:00')).toThrow(/stale prompt keys/)
    expect(plan(friday, '2026-01-16T03:00')).toHaveLength(1)
  })

  test("TQ-D04: a daily quota's +1 at 00:30 counts for Thursday; its day ends at 03:00", () => {
    const q = makeAt('2026-01-15T20:00', {
      title: 'Water',
      rrule: 'FREQ=DAILY',
      progress_target: 1,
      is_tracked: true,
    })
    // Anchored at the OpenTask day's start, not midnight.
    expect(task(q.id).progress_period_start).toBe(new Date(at('2026-01-15T03:00')).toISOString())
    expect(task(q.id).progress_period_end).toBe(at('2026-01-16T03:00'))

    clock('2026-01-16T00:30')
    incrementProgress({ ...u, taskId: q.id })
    expect(task(q.id).progress_current).toBe(1)
    const thursday = () =>
      [...getQuotaPromptsBySlot(TEST_USER_ID, tz, new Date()).values()]
        .flat()
        .filter((p) => p.task_id === q.id)
    clock('2026-01-16T02:59')
    expect(thursday()).toEqual([
      expect.objectContaining({ prompt_key: `q:${q.id}:1:2026-01-15`, current: 1, done: true }),
    ])
    clock('2026-01-16T03:00')
    expect(thursday()).toEqual([
      expect.objectContaining({ prompt_key: `q:${q.id}:1:2026-01-16`, current: 0, done: false }),
    ])
    rolloverTrackedPeriods(new Date(), TEST_USER_ID)
    expect(task(q.id)).toMatchObject({ progress_current: 0, completion_count: 1 })
  })

  test('TQ-D05: a daily quota anchored at midnight keeps its day — it ends at the next 03:00, no short period — then runs 03:00 → 03:00', () => {
    const q = makeAt('2026-01-15T08:00', {
      title: 'Read',
      rrule: 'FREQ=DAILY',
      progress_target: 2,
      is_tracked: true,
    })
    // As anchored before the day start was 03:00.
    getDb()
      .prepare('UPDATE tasks SET progress_period_start = ? WHERE id = ?')
      .run(new Date(at('2026-01-15T00:00')).toISOString(), q.id)
    expect(task(q.id).progress_period_end).toBe(at('2026-01-16T03:00'))
    // "Day starts at" PR 2 review: the anchor's DATE (Jan 15) is the period's
    // identity, so the day in progress runs to the new day start of Jan 16 —
    // nothing closes early, nothing is a transition.
    clock('2026-01-15T10:00')
    expect(rolloverTrackedPeriods(new Date(), TEST_USER_ID).rolled).toBe(0)
    clock('2026-01-16T10:00')
    expect(rolloverTrackedPeriods(new Date(), TEST_USER_ID).rolled).toBe(1)
    expect(task(q.id).progress_period_start).toBe(new Date(at('2026-01-16T03:00')).toISOString())
    expect(
      getDb()
        .prepare(
          'SELECT period_start, period_end, transition FROM progress_periods WHERE task_id = ?',
        )
        .all(q.id),
    ).toEqual([
      {
        period_start: new Date(at('2026-01-15T00:00')).toISOString(),
        period_end: new Date(at('2026-01-16T03:00')).toISOString(),
        transition: 0,
      },
    ])
  })
})

describe('TQ-D: "Day starts at" 03:00 — the nag, the rollover and the task side', () => {
  dayStartsAtThree()

  test("TQ-D06: Thursday's unfinished Evening keeps nagging until 03:00, then the day starts clean", () => {
    makeAt('2026-01-15T08:00', {
      title: 'Evening thought',
      is_reminder: true,
      rrule: 'FREQ=DAILY',
      due_at: at('2026-01-15T20:30'),
    })
    const nag = (local: string) => pendingSlotNags(clock(local))
    expect(nag('2026-01-16T00:30')).toEqual([
      expect.objectContaining({ userId: TEST_USER_ID, slotLabel: 'Evening', count: 1 }),
    ])
    expect(nag('2026-01-16T02:59')).toEqual([expect.objectContaining({ slotLabel: 'Evening' })])
    // 03:00: Friday, and none of its periods has opened (the first is 07:00).
    expect(nag('2026-01-16T03:00')).toEqual([])
    expect(nag('2026-01-16T06:59')).toEqual([])

    // The switch off: midnight is the boundary, and the night is silent.
    vi.stubEnv('OPENTASK_TASK_QUEUE', '')
    expect(nag('2026-01-16T00:30')).toEqual([])
  })

  test('TQ-D07: a period before the day start opens at the END of its day', () => {
    createTimeSlot(TEST_USER_ID, 'Late night', '01:00')
    makeAt('2026-01-15T08:00', {
      title: 'Wind down',
      is_reminder: true,
      rrule: 'FREQ=DAILY',
      due_at: at('2026-01-16T01:00'),
    })
    // 00:30: Thursday's Late night has not opened yet; nothing else is waiting.
    expect(pendingSlotNags(clock('2026-01-16T00:30'))).toEqual([])
    expect(pendingSlotNags(clock('2026-01-16T01:30'))).toEqual([
      expect.objectContaining({ slotLabel: 'Late night', count: 1 }),
    ])
    // Friday's day: Late night is hours away again.
    expect(pendingSlotNags(clock('2026-01-16T03:00'))).toEqual([])
  })

  test('TQ-D08: the rollover runs at 03:00, not before', () => {
    const t = makeAt('2026-01-15T09:00', { due_at: at('2026-01-15T16:00') })
    const roll = (local: string) => runTaskRollover({ now: clock(local), userId: TEST_USER_ID })
    expect(roll('2026-01-16T00:30').ran).toBe(0)
    expect(roll('2026-01-16T02:59').ran).toBe(0)
    expect(task(t.id).due_at).toBe(at('2026-01-15T16:00'))
    expect(roll('2026-01-16T03:00')).toMatchObject({ ran: 1, stripped: 1 })
    expect(task(t.id).due_at).toBeNull()
  })

  test('TQ-D08b: the day turning at 03:00 sends one sync event (widgets too), even with nothing to strip', () => {
    const events: [number, SyncEventInfo][] = []
    const listener = (userId: number, info: SyncEventInfo) => events.push([userId, info])
    onSyncEvent(listener)
    try {
      runTaskRollover({ now: clock('2026-01-16T02:59'), userId: TEST_USER_ID })
      expect(events).toEqual([])
      runTaskRollover({ now: clock('2026-01-16T03:00'), userId: TEST_USER_ID })
      expect(events).toEqual([[TEST_USER_ID, {}]])
      // Once a day: the next tick sends nothing.
      runTaskRollover({ now: clock('2026-01-16T03:01'), userId: TEST_USER_ID })
      expect(events).toHaveLength(1)
    } finally {
      offSyncEvent(listener)
    }
  })

  test('TQ-D09: attempts count OpenTask days from 03:00', () => {
    const t = makeAt('2026-01-15T09:00', { due_at: at('2026-01-15T22:00') })
    clock('2026-01-15T23:00')
    expect(task(t.id)).toMatchObject({ attempts: 1, attempts_counted_through: '2026-01-15' })
    clock('2026-01-16T00:30')
    expect(task(t.id)).toMatchObject({ attempts: 1, attempts_counted_through: '2026-01-15' })
    clock('2026-01-16T02:59')
    expect(task(t.id).attempts).toBe(1)
    clock('2026-01-16T03:00')
    expect(task(t.id)).toMatchObject({ attempts: 2, attempts_counted_through: '2026-01-16' })
    // Starting at 07:00: 03:00 is still Thursday.
    setDayStart('07:00')
    expect(task(t.id)).toMatchObject({ attempts: 1, attempts_counted_through: '2026-01-15' })
  })

  test('TQ-D10: the deadlines page — seen at 23:50 stays seen until 03:00', () => {
    const t = makeAt('2026-01-15T09:00', { deadline_at: at('2026-01-25T23:59') })
    // Its lead day (the page's first day) is Thursday the 22nd; the safety
    // net (D−1) not until the 24th.
    expect(task(t.id).lead_from).toBe('2026-01-22')
    const row = (local: string) =>
      getTaskSegments(TEST_USER_ID, tz, clock(local), {
        queuePanels: true,
        deckRows: true,
        deadlineRows: true,
      })
        .find((s) => s.horizon === 'deadlines')
        ?.tasks.find((r) => r.task.id === t.id)
    expect(row('2026-01-22T21:00')).toMatchObject({ state: 'waiting', seen: false })
    clock('2026-01-22T23:50')
    considerTasks(TEST_USER_ID, [t.id])
    expect(row('2026-01-23T00:30')).toMatchObject({ state: 'considered', seen: true })
    expect(row('2026-01-23T02:59')).toMatchObject({ state: 'considered', seen: true })
    expect(row('2026-01-23T03:00')).toMatchObject({ state: 'waiting', seen: false })
  })

  test("TQ-D11: the queue panel's day roster turns at 03:00", () => {
    const t = makeAt('2026-01-15T09:00', { horizon: 'days', due_at: at('2026-01-15T16:00') })
    runTaskRollover({ now: clock('2026-01-16T03:00'), userId: TEST_USER_ID })
    const queueToday = (local: string) => {
      const seg = getTaskSegments(TEST_USER_ID, tz, clock(local), {
        queuePanels: true,
        deckRows: true,
        handledRows: true,
      }).find((s) => s.horizon === 'queue_today')
      return seg ? `${seg.tasks.length - seg.waiting} of ${seg.tasks.length}` : 'none'
    }
    expect(queueToday('2026-01-16T03:05')).toBe('0 of 1')
    clock('2026-01-16T09:00')
    considerTasks(TEST_USER_ID, [t.id])
    expect(queueToday('2026-01-17T00:30')).toBe('1 of 1')
    expect(queueToday('2026-01-17T02:59')).toBe('1 of 1')
    expect(queueToday('2026-01-17T03:00')).toBe('none')
  })
})

describe('TQ-D: the web reads the same day (pure)', () => {
  const slot = (id: number, start_time: string): TimeSlot => ({
    id,
    user_id: 1,
    label: `Slot ${start_time}`,
    start_time,
    sort_order: 0,
    created_at: '2026-01-01T00:00:00Z',
  })
  const early = slot(1, '07:00')
  const eveningSlot = slot(2, '20:30')
  const late = slot(3, '01:00')
  const local = (iso: string) => new Date(at(iso))

  test('TQ-D12: slotHasStarted / naturalSlotIndex / the badge count from the day start', () => {
    // 00:30, the day starting at 03:00: the evening's day — every slot of it
    // has started except a 1:00 AM one, which ends it.
    const t0030 = local('2026-01-16T00:30')
    expect(slotHasStarted(eveningSlot, tz, t0030, '03:00')).toBe(true)
    expect(slotHasStarted(early, tz, t0030, '03:00')).toBe(true)
    expect(slotHasStarted(late, tz, t0030, '03:00')).toBe(false)
    expect(slotHasStarted(late, tz, local('2026-01-16T02:59'), '03:00')).toBe(true)
    // 03:00: a new day, nothing started before its 07:00 slot.
    expect(slotHasStarted(eveningSlot, tz, local('2026-01-16T03:00'), '03:00')).toBe(false)
    // Midnight (the switch off): as it always was.
    expect(slotHasStarted(eveningSlot, tz, t0030, CALENDAR_DAY_START)).toBe(false)

    const groups = [
      { slot: late, reminders: [{ id: 1 }], considered: 0 },
      { slot: early, reminders: [], considered: 0 },
      { slot: eveningSlot, reminders: [{ id: 2 }], considered: 0 },
    ]
    expect(naturalSlotIndex(groups, tz, t0030, '03:00')).toBe(2) // the evening
    expect(naturalSlotIndex(groups, tz, local('2026-01-16T01:30'), '03:00')).toBe(0) // late night
    expect(naturalSlotIndex(groups, tz, t0030, CALENDAR_DAY_START)).toBe(0) // midnight: the 1:00 one ahead → first
    expect(summarizeReminders(groups, tz, t0030, '03:00').waitingSoFar).toBe(1)
    expect(summarizeReminders(groups, tz, t0030, CALENDAR_DAY_START).waitingSoFar).toBe(0)
  })

  test("TQ-D13: the dashboard pager walks the day's order — finishing the evening at 00:30 goes to a started slot, not the 1:00 AM one", () => {
    const t0030 = local('2026-01-16T00:30')
    const anytime = { slot: null, reminders: [{ id: 9 }], considered: 0 }
    const groups = [
      { slot: late, reminders: [{ id: 1 }], considered: 0 },
      { slot: early, reminders: [{ id: 3 }], considered: 0 },
      { slot: eveningSlot, reminders: [], considered: 0 },
      anytime,
    ]
    const day = orderGroupsByDay(groups, '03:00')
    expect(day.map((g) => g.slot?.start_time ?? null)).toEqual(['07:00', '20:30', '01:00', null])
    // Midnight: start order, unchanged.
    expect(orderGroupsByDay(groups, '00:00')).toEqual(groups)

    const natural = naturalSlotIndex(day, tz, t0030, '03:00')
    expect(day[natural].slot).toBe(eveningSlot)
    // The evening just finished: the earliest started slot still waiting is
    // the 07:00 one — never the 1:00 AM slot, which hasn't come round yet.
    const waiting = day.map((g) => g.reminders.length)
    const to = pageAfterFinishing(waiting, 3, natural, natural)
    expect(to).not.toBeNull()
    expect(day[to!].slot).toBe(early)
  })
})
