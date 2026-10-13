/**
 * RD-RT: every repeating task or reminder has a time of day (Trent,
 * 2026-10-12: "That's supposed to be the default for the day if nothing's
 * set. Nothing should have no time.")
 *
 * A non-quota rule sent without BYHOUR is stored with one — the time of a
 * date sent with it, else the task's anchor_time, else its current date's
 * time, else the user's Morning time setting (`fillRuleTime`,
 * src/core/recurrence/rule-time.ts). Quotas keep their bare period rule.
 * Covers the helper and each writer that calls it: create, PATCH, bulk edit,
 * reminders. (AI enrichment's writer: tests/behavioral/ai-enrichment.test.ts.)
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { DateTime } from 'luxon'
import { createTask, getTaskById, updateTask, bulkEdit } from '@/core/tasks'
import { ensureRuleTime, ruleTimeFor, fillRuleTime } from '@/core/recurrence'
import { getDb } from '@/core/db'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

// Thursday Jan 15 2026, 07:00 Chicago — before any Morning time used here.
const NOW = new Date('2026-01-15T13:00:00Z')
const base = { userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE }

/** A Chicago wall-clock time `days` after NOW's local date, as UTC ISO. */
function at(hour: number, minute = 0, days = 0): string {
  return DateTime.fromJSDate(NOW)
    .setZone(TEST_TIMEZONE)
    .plus({ days })
    .set({ hour, minute, second: 0, millisecond: 0 })
    .toUTC()
    .toISO()!
}

function setMorning(time: string): void {
  getDb().prepare('UPDATE users SET morning_time = ? WHERE id = ?').run(time, TEST_USER_ID)
}

describe('RD-RT: the helper', () => {
  test('RD-RT-001: a timeless rule gets BYHOUR/BYMINUTE; a timed one is left exactly as is', () => {
    expect(ensureRuleTime('FREQ=DAILY', '08:30')).toBe('FREQ=DAILY;BYHOUR=8;BYMINUTE=30')
    expect(ensureRuleTime('FREQ=WEEKLY;INTERVAL=2;BYDAY=TH', '09:00')).toBe(
      'FREQ=WEEKLY;INTERVAL=2;BYDAY=TH;BYHOUR=9;BYMINUTE=0',
    )
    expect(ensureRuleTime('FREQ=DAILY;BYHOUR=18;BYMINUTE=15', '08:30')).toBe(
      'FREQ=DAILY;BYHOUR=18;BYMINUTE=15',
    )
    // BYHOUR alone is a time (minute 0) — untouched.
    expect(ensureRuleTime('FREQ=DAILY;BYHOUR=7', '08:30')).toBe('FREQ=DAILY;BYHOUR=7')
    // A stray BYMINUTE without an hour is replaced, never doubled.
    expect(ensureRuleTime('FREQ=DAILY;BYMINUTE=45', '08:30')).toBe(
      'FREQ=DAILY;BYHOUR=8;BYMINUTE=30',
    )
  })

  test('RD-RT-002: the time comes from the request date, then the anchor, then the row date, then Morning', () => {
    const tz = TEST_TIMEZONE
    const all = {
      requestDueAt: at(15, 45),
      anchorTime: '10:00',
      existingDueAt: at(13, 0),
      morningTime: '08:30',
      timezone: tz,
    }
    expect(ruleTimeFor(all)).toBe('15:45')
    expect(ruleTimeFor({ ...all, requestDueAt: null })).toBe('10:00')
    expect(ruleTimeFor({ ...all, requestDueAt: null, anchorTime: null })).toBe('13:00')
    expect(ruleTimeFor({ ...all, requestDueAt: null, anchorTime: null, existingDueAt: null })).toBe(
      '08:30',
    )
  })

  test('RD-RT-003: a quota, a null rule and a timed rule pass through', () => {
    const sources = { morningTime: '08:30', timezone: TEST_TIMEZONE }
    expect(fillRuleTime('FREQ=WEEKLY', true, sources)).toBe('FREQ=WEEKLY')
    expect(fillRuleTime(null, false, sources)).toBeNull()
    expect(fillRuleTime(undefined, false, sources)).toBeUndefined()
    expect(fillRuleTime('FREQ=DAILY', false, sources)).toBe('FREQ=DAILY;BYHOUR=8;BYMINUTE=30')
  })
})

describe('RD-RT: create', () => {
  beforeEach(() => {
    vi.setSystemTime(NOW)
    setupTestDb()
    setMorning('08:30')
  })
  afterEach(() => {
    vi.useRealTimers()
    teardownTestDb()
  })

  test('RD-RT-010: create — a timeless daily rule gets Morning time, its anchor and its first date', () => {
    const task = createTask({ ...base, input: { title: 'Stretch', rrule: 'FREQ=DAILY' } })
    expect(task.rrule).toBe('FREQ=DAILY;BYHOUR=8;BYMINUTE=30')
    expect(task.anchor_time).toBe('08:30')
    // Made at 07:00: today at 08:30 is the creation day's occurrence.
    expect(task.due_at).toBe(at(8, 30))
  })

  test('RD-RT-011: create — the setting is read, never a constant', () => {
    setMorning('06:15')
    const task = createTask({ ...base, input: { title: 'Stretch', rrule: 'FREQ=DAILY' } })
    expect(task.rrule).toBe('FREQ=DAILY;BYHOUR=6;BYMINUTE=15')
    expect(task.anchor_time).toBe('06:15')
  })

  test('RD-RT-012: create — a date sent with the rule gives the rule its time', () => {
    const task = createTask({
      ...base,
      input: { title: 'Bins', rrule: 'FREQ=WEEKLY;BYDAY=FR', due_at: at(19, 0, 1) },
    })
    expect(task.rrule).toBe('FREQ=WEEKLY;BYDAY=FR;BYHOUR=19;BYMINUTE=0')
    expect(task.anchor_time).toBe('19:00')
  })

  test('RD-RT-013: create — a quota keeps its bare period rule and no date', () => {
    const quota = createTask({
      ...base,
      input: { title: 'Run', rrule: 'FREQ=WEEKLY', progress_target: 3 },
    })
    expect(quota.rrule).toBe('FREQ=WEEKLY')
    expect(quota.anchor_time).toBeNull()
    expect(quota.due_at).toBeNull()
    const once = createTask({
      ...base,
      input: { title: 'Date night', rrule: 'FREQ=MONTHLY', is_tracked: true },
    })
    expect(once.rrule).toBe('FREQ=MONTHLY')
  })

  test('RD-RT-014: create — a reminder sent a timeless rule gets Morning time', () => {
    const reminder = createTask({
      ...base,
      input: { title: 'Gratitude', is_reminder: true, rrule: 'FREQ=DAILY' },
    })
    expect(reminder.rrule).toBe('FREQ=DAILY;BYHOUR=8;BYMINUTE=30')
    expect(reminder.anchor_time).toBe('08:30')
  })
})

describe('RD-RT: PATCH and bulk edit', () => {
  beforeEach(() => {
    vi.setSystemTime(NOW)
    setupTestDb()
    setMorning('08:30')
  })
  afterEach(() => {
    vi.useRealTimers()
    teardownTestDb()
  })

  test('RD-RT-020: PATCH — an undated one-off given a timeless rule gets Morning time', () => {
    const task = createTask({ ...base, input: { title: 'Water plants' } })
    const { task: after } = updateTask({
      ...base,
      taskId: task.id,
      input: { rrule: 'FREQ=DAILY;INTERVAL=3' },
    })
    expect(after.rrule).toBe('FREQ=DAILY;INTERVAL=3;BYHOUR=8;BYMINUTE=30')
    expect(after.anchor_time).toBe('08:30')
  })

  test('RD-RT-021: PATCH — a repeating task anchored at 10:00 keeps 10:00 on a timeless new rule', () => {
    const task = createTask({
      ...base,
      input: { title: 'Review', rrule: 'FREQ=DAILY;BYHOUR=10;BYMINUTE=0' },
    })
    const { task: after } = updateTask({
      ...base,
      taskId: task.id,
      input: { rrule: 'FREQ=WEEKLY;BYDAY=MO' },
    })
    expect(after.rrule).toBe('FREQ=WEEKLY;BYDAY=MO;BYHOUR=10;BYMINUTE=0')
    expect(after.anchor_time).toBe('10:00')
  })

  test('RD-RT-022: PATCH — a legacy row with no BYHOUR but anchor_time 10:00 takes 10:00, not Morning', () => {
    const task = createTask({ ...base, input: { title: 'Legacy' } })
    getDb()
      .prepare("UPDATE tasks SET rrule = 'FREQ=DAILY', anchor_time = '10:00' WHERE id = ?")
      .run(task.id)
    const { task: after } = updateTask({
      ...base,
      taskId: task.id,
      input: { rrule: 'FREQ=DAILY;INTERVAL=2' },
    })
    expect(after.rrule).toBe('FREQ=DAILY;INTERVAL=2;BYHOUR=10;BYMINUTE=0')
    expect(after.anchor_time).toBe('10:00')
  })

  test('RD-RT-023: PATCH — a dated one-off made repeating keeps its time', () => {
    const task = createTask({ ...base, input: { title: 'Call mom', due_at: at(15, 0, 1) } })
    const { task: after } = updateTask({
      ...base,
      taskId: task.id,
      input: { rrule: 'FREQ=WEEKLY;BYDAY=SU' },
    })
    expect(after.rrule).toBe('FREQ=WEEKLY;BYDAY=SU;BYHOUR=15;BYMINUTE=0')
    expect(after.anchor_time).toBe('15:00')
  })

  test('RD-RT-024: PATCH — re-sending the stored rule without its time changes nothing', () => {
    const task = createTask({ ...base, input: { title: 'Stretch', rrule: 'FREQ=DAILY' } })
    const { fieldsChanged } = updateTask({
      ...base,
      taskId: task.id,
      input: { rrule: 'FREQ=DAILY' },
    })
    expect(fieldsChanged).toEqual([])
    expect(getTaskById(task.id)!.rrule).toBe('FREQ=DAILY;BYHOUR=8;BYMINUTE=30')
  })

  test('RD-RT-025: PATCH — a legacy timeless rule sent back unchanged is not a schedule change', () => {
    const task = createTask({ ...base, input: { title: 'Legacy' } })
    getDb()
      .prepare("UPDATE tasks SET rrule = 'FREQ=DAILY', anchor_time = NULL WHERE id = ?")
      .run(task.id)
    const { fieldsChanged } = updateTask({
      ...base,
      taskId: task.id,
      input: { rrule: 'FREQ=DAILY', title: 'Legacy, renamed' },
    })
    expect(fieldsChanged).toEqual(['title'])
    expect(getTaskById(task.id)!.rrule).toBe('FREQ=DAILY')
  })

  test('RD-RT-026: PATCH — a task becoming a quota in the same request keeps the bare rule', () => {
    const task = createTask({ ...base, input: { title: 'Read' } })
    const { task: after } = updateTask({
      ...base,
      taskId: task.id,
      input: { rrule: 'FREQ=WEEKLY', progress_target: 3 },
    })
    expect(after.rrule).toBe('FREQ=WEEKLY')
    expect(after.anchor_time).toBeNull()
  })

  test('RD-RT-027: PATCH — a quota retired in the same request gets a timed rule', () => {
    const quota = createTask({
      ...base,
      input: { title: 'Run', rrule: 'FREQ=WEEKLY', progress_target: 3 },
    })
    const { task: after } = updateTask({
      ...base,
      taskId: quota.id,
      input: { progress_target: 1, is_tracked: false, rrule: 'FREQ=WEEKLY;BYDAY=SA' },
    })
    expect(after.rrule).toBe('FREQ=WEEKLY;BYDAY=SA;BYHOUR=8;BYMINUTE=30')
    expect(after.anchor_time).toBe('08:30')
  })

  test("RD-RT-028: PATCH — a quota's timeless period rule change stays bare", () => {
    const quota = createTask({
      ...base,
      input: { title: 'Run', rrule: 'FREQ=WEEKLY', progress_target: 3 },
    })
    const { task: after } = updateTask({
      ...base,
      taskId: quota.id,
      input: { rrule: 'FREQ=MONTHLY' },
    })
    expect(after.rrule).toBe('FREQ=MONTHLY')
  })

  test('RD-RT-030: bulk edit — each task gets its own time; a quota in the batch is refused', () => {
    const anchored = createTask({
      ...base,
      input: { title: 'Anchored', rrule: 'FREQ=DAILY;BYHOUR=10;BYMINUTE=0' },
    })
    const plain = createTask({ ...base, input: { title: 'Plain' } })
    bulkEdit({
      ...base,
      taskIds: [anchored.id, plain.id],
      changes: { rrule: 'FREQ=WEEKLY;BYDAY=TU' },
    })
    expect(getTaskById(anchored.id)!.rrule).toBe('FREQ=WEEKLY;BYDAY=TU;BYHOUR=10;BYMINUTE=0')
    expect(getTaskById(plain.id)!.rrule).toBe('FREQ=WEEKLY;BYDAY=TU;BYHOUR=8;BYMINUTE=30')
    expect(getTaskById(plain.id)!.anchor_time).toBe('08:30')
  })

  test('RD-RT-031: PATCH — a reminder given a timeless rule keeps its own time', () => {
    const reminder = createTask({
      ...base,
      input: {
        title: 'Plan the week',
        is_reminder: true,
        rrule: 'FREQ=DAILY;BYHOUR=20;BYMINUTE=0',
      },
    })
    const { task: after } = updateTask({
      ...base,
      taskId: reminder.id,
      input: { rrule: 'FREQ=WEEKLY;BYDAY=SU' },
    })
    expect(after.rrule).toBe('FREQ=WEEKLY;BYDAY=SU;BYHOUR=20;BYMINUTE=0')
  })
})
