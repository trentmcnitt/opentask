/**
 * RM-020..022: "considered today" per slot (REDESIGN-V03 §6, progress).
 *
 * The Reminders surface keeps exactly one score — what the user considered
 * today — and only that, per L1 (absence is never a signal). These pin that a
 * considered reminder leaves the waiting set and enters its slot's considered
 * count, for recurring and one-off reminders alike, and that yesterday's
 * considerations do not leak into today.
 */
import { describe, test, expect, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { getDb } from '@/core/db'
import { createTask, markDone } from '@/core/tasks'
import { getRemindersBySlot, getConsideredToday } from '@/core/tasks/reminders'
import { summarizeReminders } from '@/lib/reminders-summary'
import {
  setupTestDb,
  teardownTestDb,
  localTime,
  TEST_TIMEZONE,
  TEST_USER_ID,
} from '../helpers/setup'

function makeReminder(overrides: Record<string, unknown> = {}) {
  return createTask({
    userId: TEST_USER_ID,
    userTimezone: TEST_TIMEZONE,
    input: {
      title: 'Depressed = Past, Anxious = Future',
      is_reminder: true,
      rrule: 'FREQ=DAILY',
      due_at: localTime(7, 0),
      ...overrides,
    },
  })
}

describe('Reminders considered today', () => {
  afterAll(() => teardownTestDb())
  beforeEach(() => {
    // Thursday 2026-01-15, 10:00 Chicago. Slots: Early morning 07:00, Midday 12:00.
    vi.setSystemTime(new Date('2026-01-15T16:00:00Z'))
    setupTestDb()
    getDb()
      .prepare(
        "INSERT INTO time_slots (user_id, label, start_time, sort_order) VALUES (?, 'Early morning', '07:00', 0), (?, 'Midday', '12:00', 1)",
      )
      .run(TEST_USER_ID, TEST_USER_ID)
  })
  afterEach(() => vi.useRealTimers())

  test('RM-020: a considered recurring reminder moves from waiting to its slot count', () => {
    const a = makeReminder({ title: 'A' })
    const b = makeReminder({ title: 'B' })
    const noon = makeReminder({ title: 'Noon', due_at: localTime(12, 30) })

    let groups = getRemindersBySlot(TEST_USER_ID, TEST_TIMEZONE)
    const early = () => groups.find((g) => g.slot?.label === 'Early morning')!
    expect(
      early()
        .reminders.map((t) => t.title)
        .sort(),
    ).toEqual(['A', 'B'])
    expect(early().considered).toBe(0)

    markDone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: a.id })
    groups = getRemindersBySlot(TEST_USER_ID, TEST_TIMEZONE)
    expect(early().reminders.map((t) => t.title)).toEqual(['B'])
    expect(early().considered).toBe(1)
    expect(groups.find((g) => g.slot?.label === 'Midday')!.reminders.map((t) => t.id)).toEqual([
      noon.id,
    ])
    expect(getConsideredToday(TEST_USER_ID, TEST_TIMEZONE).map((t) => t.id)).toEqual([a.id])
    expect(b.id).toBeGreaterThan(0)
  })

  test('RM-021: a considered one-off reminder counts too', () => {
    const once = makeReminder({ title: 'Once', rrule: null })
    markDone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: once.id })
    const groups = getRemindersBySlot(TEST_USER_ID, TEST_TIMEZONE)
    expect(groups.find((g) => g.slot?.label === 'Early morning')!.considered).toBe(1)
    expect(groups.flatMap((g) => g.reminders)).toHaveLength(0)
  })

  test("RM-022: yesterday's considerations do not count today", () => {
    const stale = makeReminder({ title: 'Yesterday' })
    getDb()
      .prepare('UPDATE tasks SET last_completed_at = ? WHERE id = ?')
      .run('2026-01-14T15:00:00.000Z', stale.id)
    const groups = getRemindersBySlot(TEST_USER_ID, TEST_TIMEZONE)
    expect(groups.find((g) => g.slot?.label === 'Early morning')!.considered).toBe(0)
  })

  test('RM-023: the headline arithmetic — waiting so far, later, and the day total', () => {
    makeReminder({ title: 'Early 1' })
    makeReminder({ title: 'Early 2' })
    const done = makeReminder({ title: 'Early done' })
    markDone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: done.id })
    makeReminder({ title: 'Noon', due_at: localTime(12, 30) })
    makeReminder({ title: 'Anytime', rrule: null, due_at: null })

    const groups = getRemindersBySlot(TEST_USER_ID, TEST_TIMEZONE)
    // 10:00 local: Early morning has started, Midday has not.
    const s = summarizeReminders(groups, TEST_TIMEZONE, new Date('2026-01-15T16:00:00Z'))
    expect(s.waitingSoFar).toBe(3) // Early 1, Early 2, Anytime
    expect(s.waitingLater).toBe(1) // Noon
    expect(s.consideredTotal).toBe(1)
    expect(s.dayTotal).toBe(5)
    expect(s.nextUp?.slot.label).toBe('Midday')
    expect(s.nextUp?.waiting).toBe(1)

    // 12:30 local: Midday has started too.
    const later = summarizeReminders(groups, TEST_TIMEZONE, new Date('2026-01-15T18:30:00Z'))
    expect(later.waitingSoFar).toBe(4)
    expect(later.nextUp).toBeNull()
  })
})
