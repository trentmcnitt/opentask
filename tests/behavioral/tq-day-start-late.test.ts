/**
 * ONE DAY BOUNDARY AT 11 PM (TQ-DE01.., Trent 2026-10-24) — the TQ-D checks
 * (tq-day-start-boundary.test.ts, at 3:00 AM) re-run with a day start AFTER
 * noon, where the day is named by the NEXT date: with 23:00, Friday
 * 2026-01-16 runs Thu 23:00 → Fri 23:00, so Thursday 23:00 exactly is
 * already Friday. Each area is checked at 22:30, 22:59 and 23:00 on
 * Thursday 2026-01-15 (America/Chicago):
 *
 * - the Reminders roster and "considered today", and a weekly reminder's day;
 * - quota prompts' `prompt_key` dates and the stale-key refusal; a daily
 *   quota's period (anchored at the day's start, Wed 23:00; its last day is
 *   the date it is named by), and a midnight anchor's one short period;
 * - the slot nag (the Evening keeps nagging until 23:00; a period after the
 *   day start — 23:30 — opens at the START of its day);
 * - the task rollover, its sync event, attempts, the deadlines page's "seen"
 *   and the queue panels' day roster;
 * - the web's slotHasStarted / naturalSlotIndex / orderGroupsByDay.
 *
 * Default slots (seeded by setupTestDb): Early morning 07:00, Morning 09:00,
 * Midday 12:00, Afternoon 16:00, Evening 20:30.
 */
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
import { addDays } from '@/lib/opentask-day'
import { slotHasStarted, summarizeReminders } from '@/lib/reminders-summary'
import { naturalSlotIndex, orderGroupsByDay, type TimeSlot } from '@/lib/time-slot-assign'
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

function group(label: string, local: string): { waiting: number[]; considered: number } {
  const g = getRemindersBySlot(TEST_USER_ID, tz, clock(local)).find((x) => x.slot?.label === label)
  return { waiting: g?.reminders.map((t) => t.id) ?? [], considered: g?.considered ?? 0 }
}

function promptKeys(local: string): string[] {
  const now = clock(local)
  return [...getQuotaPromptsBySlot(TEST_USER_ID, tz, now).values()].flat().map((p) => p.prompt_key)
}

/** Thursday 2026-01-15 08:00, the switch on, the day starting at 23:00, Thursday's rollover run. */
function dayStartsAtEleven() {
  beforeEach(() => {
    clock('2026-01-15T08:00')
    setupTestDb()
    vi.stubEnv('OPENTASK_TASK_QUEUE', '1')
    updatePreferences(TEST_USER_ID, { day_start_time: '23:00', day_start_slot_id: null })
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

describe('TQ-DE: "Day starts at" 23:00 — the Reminders screen and quotas', () => {
  dayStartsAtEleven()

  test('TQ-DE01: a reminder checked off at 22:30 is Thursday’s; at 23:00 Friday’s roster has it waiting', () => {
    const r = makeAt('2026-01-15T08:00', {
      title: 'Evening thought',
      is_reminder: true,
      rrule: 'FREQ=DAILY',
      due_at: at('2026-01-15T20:30'),
    })
    expect(group('Evening', '2026-01-15T21:00')).toEqual({ waiting: [r.id], considered: 0 })
    clock('2026-01-15T22:30')
    markDone({ ...u, taskId: r.id })
    expect(group('Evening', '2026-01-15T22:31')).toEqual({ waiting: [], considered: 1 })
    expect(group('Evening', '2026-01-15T22:59')).toEqual({ waiting: [], considered: 1 })
    // 23:00 exactly: Friday — the 22:30 check-off was yesterday's.
    expect(group('Evening', '2026-01-15T23:00')).toEqual({ waiting: [r.id], considered: 0 })
    expect(getConsideredToday(TEST_USER_ID, tz, clock('2026-01-15T23:00'))).toEqual([])
  })

  test('TQ-DE02: a Thursday-only reminder is on the roster until 23:00 Thursday, then not today', () => {
    const r = makeAt('2026-01-15T08:00', {
      title: 'Thursday thought',
      is_reminder: true,
      rrule: 'FREQ=WEEKLY;BYDAY=TH',
      due_at: at('2026-01-15T20:30'),
    })
    expect(group('Evening', '2026-01-15T22:59').waiting).toEqual([r.id])
    expect(group('Evening', '2026-01-15T23:00').waiting).toEqual([])
    expect(
      getRemindersNotToday(TEST_USER_ID, tz, clock('2026-01-15T23:00')).map((t) => t.id),
    ).toEqual([r.id])
    // Wednesday 23:30 was already Thursday: it is on that roster.
    expect(group('Evening', '2026-01-14T23:30').waiting).toEqual([r.id])
  })

  test('TQ-DE03: prompt keys turn at 23:00 Thursday — to Friday’s date — and the stale key is refused there', () => {
    const q = makeAt('2026-01-15T08:00', {
      title: 'Stretch',
      rrule: 'FREQ=WEEKLY',
      progress_target: 3,
      is_tracked: true,
    })
    const thursday = `q:${q.id}:0:2026-01-15`
    const friday = `q:${q.id}:0:2026-01-16`
    expect(promptKeys('2026-01-15T22:30')).toEqual([thursday])
    expect(promptKeys('2026-01-15T22:59')).toEqual([thursday])
    expect(promptKeys('2026-01-15T23:00')).toEqual([friday])

    const plan = (key: string, local: string) =>
      planPromptActions(TEST_USER_ID, tz, [{ key, did: false }], clock(local))
    expect(plan(thursday, '2026-01-15T22:59')).toHaveLength(1)
    expect(() => plan(friday, '2026-01-15T22:59')).toThrow(/stale prompt keys/)
    expect(() => plan(thursday, '2026-01-15T23:00')).toThrow(/stale prompt keys/)
    expect(plan(friday, '2026-01-15T23:00')).toHaveLength(1)
  })

  test("TQ-DE04: a daily quota's day is Wed 23:00 → Thu 23:00, its last day Thursday; a +1 at 22:30 counts for Thursday", () => {
    const q = makeAt('2026-01-15T20:00', {
      title: 'Water',
      rrule: 'FREQ=DAILY',
      progress_target: 1,
      is_tracked: true,
    })
    expect(task(q.id).progress_period_start).toBe(new Date(at('2026-01-14T23:00')).toISOString())
    expect(task(q.id).progress_period_end).toBe(at('2026-01-15T23:00'))
    expect(task(q.id).period_last_day).toBe('2026-01-15')

    clock('2026-01-15T22:30')
    incrementProgress({ ...u, taskId: q.id })
    const today = () =>
      [...getQuotaPromptsBySlot(TEST_USER_ID, tz, new Date()).values()]
        .flat()
        .filter((p) => p.task_id === q.id)
    clock('2026-01-15T22:59')
    expect(today()).toEqual([
      expect.objectContaining({ prompt_key: `q:${q.id}:1:2026-01-15`, current: 1, done: true }),
    ])
    clock('2026-01-15T23:00')
    expect(today()).toEqual([
      expect.objectContaining({ prompt_key: `q:${q.id}:1:2026-01-16`, current: 0, done: false }),
    ])
    rolloverTrackedPeriods(new Date(), TEST_USER_ID)
    expect(task(q.id)).toMatchObject({
      progress_current: 0,
      completion_count: 1,
      progress_period_end: at('2026-01-16T23:00'),
      period_last_day: '2026-01-16',
    })
  })

  test('TQ-DE05: a daily quota anchored at midnight closes one short period at 23:00, then aligns', () => {
    const q = makeAt('2026-01-15T08:00', {
      title: 'Read',
      rrule: 'FREQ=DAILY',
      progress_target: 2,
      is_tracked: true,
    })
    getDb()
      .prepare('UPDATE tasks SET progress_period_start = ? WHERE id = ?')
      .run(new Date(at('2026-01-15T00:00')).toISOString(), q.id)
    expect(task(q.id).progress_period_end).toBe(at('2026-01-15T23:00'))
    clock('2026-01-15T23:10')
    expect(rolloverTrackedPeriods(new Date(), TEST_USER_ID).rolled).toBe(1)
    expect(task(q.id).progress_period_start).toBe(new Date(at('2026-01-15T23:00')).toISOString())
    expect(task(q.id).progress_period_end).toBe(at('2026-01-16T23:00'))
  })
})

describe('TQ-DE: "Day starts at" 23:00 — the nag, the rollover and the task side', () => {
  dayStartsAtEleven()

  test("TQ-DE06: Thursday's unfinished Evening keeps nagging until 23:00, then Friday starts clean", () => {
    makeAt('2026-01-15T08:00', {
      title: 'Evening thought',
      is_reminder: true,
      rrule: 'FREQ=DAILY',
      due_at: at('2026-01-15T20:30'),
    })
    const nag = (local: string) => pendingSlotNags(clock(local))
    expect(nag('2026-01-15T20:45')).toEqual([
      expect.objectContaining({ userId: TEST_USER_ID, slotLabel: 'Evening', count: 1 }),
    ])
    expect(nag('2026-01-15T22:59')).toEqual([expect.objectContaining({ slotLabel: 'Evening' })])
    // 23:00: Friday, and none of its periods has opened (the first is Fri 07:00).
    expect(nag('2026-01-15T23:00')).toEqual([])
    expect(nag('2026-01-16T06:59')).toEqual([])
  })

  test('TQ-DE07: a period after the day start opens at the START of its day', () => {
    createTimeSlot(TEST_USER_ID, 'Late night', '23:30')
    makeAt('2026-01-15T08:00', {
      title: 'Wind down',
      is_reminder: true,
      rrule: 'FREQ=DAILY',
      due_at: at('2026-01-15T23:30'),
    })
    // 23:15 Thursday is Friday already; its first period, Late night, opens at 23:30.
    expect(pendingSlotNags(clock('2026-01-15T23:15'))).toEqual([])
    expect(pendingSlotNags(clock('2026-01-15T23:45'))).toEqual([
      expect.objectContaining({ slotLabel: 'Late night', count: 1 }),
    ])
    // Friday's day goes on: Late night stays opened (it is Friday's first period).
    expect(pendingSlotNags(clock('2026-01-16T12:00'))).toEqual([
      expect.objectContaining({ slotLabel: 'Late night' }),
    ])
  })

  test('TQ-DE08: the rollover runs at 23:00, not before', () => {
    const t = makeAt('2026-01-15T09:00', { due_at: at('2026-01-15T16:00') })
    const roll = (local: string) => runTaskRollover({ now: clock(local), userId: TEST_USER_ID })
    expect(roll('2026-01-15T22:30').ran).toBe(0)
    expect(roll('2026-01-15T22:59').ran).toBe(0)
    expect(task(t.id).due_at).toBe(at('2026-01-15T16:00'))
    expect(roll('2026-01-15T23:00')).toMatchObject({ ran: 1, stripped: 1 })
    expect(task(t.id).due_at).toBeNull()
    expect(
      (
        getDb().prepare('SELECT last_rollover_date FROM users WHERE id = ?').get(TEST_USER_ID) as {
          last_rollover_date: string
        }
      ).last_rollover_date,
    ).toBe('2026-01-16')
  })

  test('TQ-DE08b: the day turning at 23:00 sends one sync event, once', () => {
    const events: [number, SyncEventInfo][] = []
    const listener = (userId: number, info: SyncEventInfo) => events.push([userId, info])
    onSyncEvent(listener)
    try {
      runTaskRollover({ now: clock('2026-01-15T22:59'), userId: TEST_USER_ID })
      expect(events).toEqual([])
      runTaskRollover({ now: clock('2026-01-15T23:00'), userId: TEST_USER_ID })
      expect(events).toEqual([[TEST_USER_ID, {}]])
      runTaskRollover({ now: clock('2026-01-16T00:30'), userId: TEST_USER_ID })
      expect(events).toHaveLength(1)
    } finally {
      offSyncEvent(listener)
    }
  })

  test('TQ-DE09: attempts count OpenTask days from 23:00', () => {
    const t = makeAt('2026-01-15T09:00', { due_at: at('2026-01-15T22:00') })
    clock('2026-01-15T22:30')
    expect(task(t.id)).toMatchObject({ attempts: 1, attempts_counted_through: '2026-01-15' })
    clock('2026-01-15T22:59')
    expect(task(t.id).attempts).toBe(1)
    clock('2026-01-15T23:00')
    expect(task(t.id)).toMatchObject({ attempts: 2, attempts_counted_through: '2026-01-16' })
    clock('2026-01-16T12:00')
    expect(task(t.id).attempts).toBe(2)
  })

  test('TQ-DE10: the deadlines page — seen at 22:30 stays seen until 23:00', () => {
    const t = makeAt('2026-01-15T09:00', { deadline_at: at('2026-01-25T20:00') })
    const lead = task(t.id).lead_from!
    expect(lead).toMatch(/^2026-01-2\d$/)
    const row = (local: string) =>
      getTaskSegments(TEST_USER_ID, tz, clock(local), {
        queuePanels: true,
        deckRows: true,
        deadlineRows: true,
      })
        .find((s) => s.horizon === 'deadlines')
        ?.tasks.find((r) => r.task.id === t.id)
    expect(row(`${lead}T21:00`)).toMatchObject({ state: 'waiting', seen: false })
    // The lead day's eve, 23:00 the day before, is already the lead day.
    expect(row(`${addDays(lead, -1)}T23:00`)).toMatchObject({ state: 'waiting' })
    expect(row(`${addDays(lead, -1)}T22:59`)).toBeUndefined()
    clock(`${lead}T22:30`)
    considerTasks(TEST_USER_ID, [t.id])
    expect(row(`${lead}T22:59`)).toMatchObject({ state: 'considered', seen: true })
    expect(row(`${lead}T23:00`)).toMatchObject({ state: 'waiting', seen: false })
  })

  test("TQ-DE11: the queue panel's day roster turns at 23:00", () => {
    const t = makeAt('2026-01-15T09:00', { horizon: 'days', due_at: at('2026-01-15T16:00') })
    runTaskRollover({ now: clock('2026-01-15T23:00'), userId: TEST_USER_ID })
    const queueToday = (local: string) => {
      const seg = getTaskSegments(TEST_USER_ID, tz, clock(local), {
        queuePanels: true,
        deckRows: true,
        handledRows: true,
      }).find((s) => s.horizon === 'queue_today')
      return seg ? `${seg.tasks.length - seg.waiting} of ${seg.tasks.length}` : 'none'
    }
    expect(queueToday('2026-01-15T23:05')).toBe('0 of 1')
    clock('2026-01-16T09:00')
    considerTasks(TEST_USER_ID, [t.id])
    expect(queueToday('2026-01-16T22:30')).toBe('1 of 1')
    expect(queueToday('2026-01-16T22:59')).toBe('1 of 1')
    expect(queueToday('2026-01-16T23:00')).toBe('none')
  })
})

describe('TQ-DE: the web reads the same day at 23:00 (pure)', () => {
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
  const late = slot(3, '23:30')
  const local = (iso: string) => new Date(at(iso))

  test('TQ-DE12: slotHasStarted / naturalSlotIndex / the badge count from an 11 PM start', () => {
    // 21:00 Thursday: Thursday's evening has started, its 23:30 slot (which
    // opened at the start of Thursday, Wed 23:30) too.
    const t2100 = local('2026-01-15T21:00')
    expect(slotHasStarted(eveningSlot, tz, t2100, '23:00')).toBe(true)
    expect(slotHasStarted(late, tz, t2100, '23:00')).toBe(true)
    // 23:15: Friday — nothing has started; 23:30 its first slot opens.
    const t2315 = local('2026-01-15T23:15')
    expect(slotHasStarted(eveningSlot, tz, t2315, '23:00')).toBe(false)
    expect(slotHasStarted(early, tz, t2315, '23:00')).toBe(false)
    expect(slotHasStarted(late, tz, t2315, '23:00')).toBe(false)
    expect(slotHasStarted(late, tz, local('2026-01-15T23:30'), '23:00')).toBe(true)

    const groups = [
      { slot: early, reminders: [{ id: 1 }], considered: 0 },
      { slot: eveningSlot, reminders: [{ id: 2 }], considered: 0 },
      { slot: late, reminders: [{ id: 3 }], considered: 0 },
    ]
    const day = orderGroupsByDay(groups, '23:00')
    expect(day.map((g) => g.slot?.start_time)).toEqual(['23:30', '07:00', '20:30'])
    expect(day[naturalSlotIndex(day, tz, t2100, '23:00')].slot).toBe(eveningSlot)
    expect(day[naturalSlotIndex(day, tz, local('2026-01-15T23:45'), '23:00')].slot).toBe(late)
    expect(summarizeReminders(groups, tz, t2100, '23:00').waitingSoFar).toBe(3)
    expect(summarizeReminders(groups, tz, t2315, '23:00').waitingSoFar).toBe(0)
  })
})
