/**
 * "Day starts at" (TDS-001..) — when the OpenTask day turns (2026-10-23,
 * `resolveDayStart` in `src/lib/anchor-times.ts`, `getDayStart` in
 * `src/core/users/anchor-times.ts`).
 *
 * Pins: unset (the default) is a fixed 3:00 AM for every user (Trent,
 * 2026-10-24) — never the first period or Morning; a custom time and a link
 * resolve like Morning's; every server reader of the rollover agrees (the
 * resolver, `rolloverTimeForUser`, the attempts SQL, the startup stamp);
 * deleting a linked period converts the link to custom with undo/redo,
 * compare-and-set, and an unset day start has nothing to convert.
 *
 * Default slots (seeded by setupTestDb): Early morning 07:00, Morning 09:00,
 * Midday 12:00, Afternoon 16:00, Evening 20:30.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { getDb, stampRolloverDates } from '@/core/db'
import { executeUndo, executeRedo } from '@/core/undo'
import { createTask } from '@/core/tasks'
import { createTimeSlot, listTimeSlots, type TimeSlot } from '@/core/time-slots'
import { updateTimeSlot, deleteTimeSlot } from '@/core/time-slots/edit'
import { rolloverTimeForUser } from '@/core/tasks/rollover-time'
import { taskColumns } from '@/core/tasks/read'
import { getDayStart, readAnchorRow } from '@/core/users/anchor-times'
import { updatePreferences } from '@/core/users/preferences'
import {
  DEFAULT_ANCHOR_ROW,
  DEFAULT_DAY_START,
  dayStartLabel,
  dayStartSetting,
  dayStartTimeOf,
  resolveDayStart,
  settingWrites,
  unlinkSlot,
  type AnchorRow,
} from '@/lib/anchor-times'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

const slot = (id: number, label: string, start_time: string): TimeSlot => ({
  id,
  user_id: 1,
  label,
  start_time,
  sort_order: 0,
  created_at: '2026-01-01T00:00:00Z',
})

function slotByLabel(label: string): TimeSlot {
  const found = listTimeSlots(TEST_USER_ID).find((s) => s.label === label)
  if (!found) throw new Error(`no slot ${label}`)
  return found
}

function setRow(changes: Partial<AnchorRow>) {
  updatePreferences(TEST_USER_ID, changes)
}

/** The attempts SQL's rollover for a task of the test user (`owner_rollover_time`). */
function sqlRollover(): string {
  const task = createTask({
    userId: TEST_USER_ID,
    userTimezone: TEST_TIMEZONE,
    input: { title: 'Probe' },
  })
  const row = getDb().prepare(`SELECT ${taskColumns()} FROM tasks WHERE id = ?`).get(task.id) as {
    owner_rollover_time: string
  }
  return row.owner_rollover_time
}

describe('the day-start rule (pure)', () => {
  const slots = [slot(5, 'Morning', '08:30'), slot(4, 'Dawn', '06:30'), slot(6, 'Evening', '20:00')]
  const unset = { day_start_time: null, day_start_slot_id: null }

  test('TDS-001: unset is the fixed 3:00 AM default — not the first period, whatever the periods', () => {
    for (const periods of [slots, [slot(7, 'Night', '01:00')], []]) {
      expect(resolveDayStart(unset, periods)).toEqual({
        time: DEFAULT_DAY_START,
        slot_id: null,
        slot_label: null,
        default: true,
      })
    }
    expect(DEFAULT_DAY_START).toBe('03:00')
  })

  test('TDS-002: a custom time at any hour reads as itself — 11 PM, 1 AM, midnight, 06:30', () => {
    for (const time of ['23:00', '01:00', '00:00', '06:30']) {
      expect(resolveDayStart({ day_start_time: time, day_start_slot_id: null }, slots)).toEqual({
        time,
        slot_id: null,
        slot_label: null,
        default: false,
      })
    }
  })

  test('TDS-003: a custom 03:00 is not the default — it stays put if the default ever moves', () => {
    expect(resolveDayStart({ day_start_time: '03:00', day_start_slot_id: null }, slots)).toEqual({
      time: '03:00',
      slot_id: null,
      slot_label: null,
      default: false,
    })
  })

  test("TDS-004: a link reads the period's start; a gone link its snapshot", () => {
    expect(resolveDayStart({ day_start_time: '19:00', day_start_slot_id: 6 }, slots)).toEqual({
      time: '20:00',
      slot_id: 6,
      slot_label: 'Evening',
      default: false,
    })
    expect(resolveDayStart({ day_start_time: '19:00', day_start_slot_id: 99 }, slots)).toEqual({
      time: '19:00',
      slot_id: null,
      slot_label: null,
      default: false,
    })
  })

  test('TDS-005: dayStartTimeOf (the bare-row twin) agrees with the resolver in every state', () => {
    const rows = [
      unset,
      { day_start_time: '03:00', day_start_slot_id: null },
      { day_start_time: '23:00', day_start_slot_id: null },
      { day_start_time: '19:00', day_start_slot_id: 6 },
      { day_start_time: '19:00', day_start_slot_id: 99 },
    ]
    for (const row of rows) {
      for (const periods of [slots, []]) {
        expect(dayStartTimeOf(row, periods)).toBe(resolveDayStart(row, periods).time)
      }
    }
  })

  test('TDS-006: a slot id with no time (never written) reads as unset', () => {
    expect(dayStartSetting({ day_start_time: null, day_start_slot_id: 6 })).toBeNull()
  })

  test('TDS-007: the summary line says what it follows', () => {
    expect(dayStartLabel(resolveDayStart(unset, slots))).toBe('3:00 AM · default')
    expect(
      dayStartLabel(resolveDayStart({ day_start_time: '23:00', day_start_slot_id: null }, slots)),
    ).toBe('11:00 PM')
    expect(
      dayStartLabel(resolveDayStart({ day_start_time: '20:00', day_start_slot_id: 6 }, slots)),
    ).toBe('8:00 PM · Evening period')
  })

  test('TDS-008: unlinkSlot converts only an explicit link; settingWrites is compare-and-set', () => {
    const linked: AnchorRow = {
      ...DEFAULT_ANCHOR_ROW,
      day_start_time: '20:00',
      day_start_slot_id: 6,
    }
    const changes = unlinkSlot(linked, { id: 6, start_time: '20:00' })
    expect(changes).toEqual([
      {
        setting: 'day_start',
        before: { time: '20:00', slot_id: 6 },
        after: { time: '20:00', slot_id: null },
      },
    ])
    expect(settingWrites(linked, changes, 'after')).toEqual({
      day_start_time: '20:00',
      day_start_slot_id: null,
    })
    // Unset has nothing to convert.
    expect(unlinkSlot(DEFAULT_ANCHOR_ROW, { id: 6, start_time: '20:00' })).toEqual([])
    // A day start changed since (or reset to unset) is left alone by an undo.
    const changed: AnchorRow = { ...DEFAULT_ANCHOR_ROW, day_start_time: '03:00' }
    expect(settingWrites(changed, changes, 'before')).toEqual({})
    expect(settingWrites(DEFAULT_ANCHOR_ROW, changes, 'before')).toEqual({})
  })
})

describe('every server reader follows the setting', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-01-15T16:00:00Z'))
    setupTestDb()
  })
  afterEach(() => {
    vi.useRealTimers()
    teardownTestDb()
  })

  test('TDS-020: unset is 3:00 AM everywhere, and a new earliest period does not move it', () => {
    expect(readAnchorRow(TEST_USER_ID).day_start_time).toBeNull()
    expect(rolloverTimeForUser(TEST_USER_ID)).toBe('03:00')
    expect(sqlRollover()).toBe('03:00')
    createTimeSlot(TEST_USER_ID, 'Dawn', '05:45')
    createTimeSlot(TEST_USER_ID, 'Night', '01:30')
    expect(rolloverTimeForUser(TEST_USER_ID)).toBe('03:00')
    expect(getDayStart(TEST_USER_ID)).toMatchObject({ slot_id: null, default: true })
    expect(sqlRollover()).toBe('03:00')
    // A Morning time does not move it either (no fallback).
    updatePreferences(TEST_USER_ID, { morning_time: '05:00', morning_slot_id: null })
    expect(rolloverTimeForUser(TEST_USER_ID)).toBe('03:00')
    expect(sqlRollover()).toBe('03:00')
  })

  test('TDS-020b: a custom 11 PM — the resolver, rolloverTimeForUser and the SQL agree', () => {
    setRow({ day_start_time: '23:00', day_start_slot_id: null })
    expect(rolloverTimeForUser(TEST_USER_ID)).toBe('23:00')
    expect(sqlRollover()).toBe('23:00')
  })

  test('TDS-021: a custom 03:00 — the resolver, rolloverTimeForUser and the SQL agree', () => {
    setRow({ day_start_time: '03:00', day_start_slot_id: null })
    expect(rolloverTimeForUser(TEST_USER_ID)).toBe('03:00')
    expect(sqlRollover()).toBe('03:00')
  })

  test('TDS-022: a link follows its period when it is retimed', () => {
    const evening = slotByLabel('Evening')
    setRow({ day_start_time: evening.start_time, day_start_slot_id: evening.id })
    expect(rolloverTimeForUser(TEST_USER_ID)).toBe('20:30')
    updateTimeSlot({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      slotId: evening.id,
      input: { start_time: '21:00' },
    })
    expect(rolloverTimeForUser(TEST_USER_ID)).toBe('21:00')
    expect(sqlRollover()).toBe('21:00')
  })

  test("TDS-023: the startup stamp counts the user's OpenTask day from the day start", () => {
    // 16:00Z on Jan 15 is 10:00 Chicago; 04:00 Chicago is 10:00Z.
    const at0400 = new Date('2026-01-15T10:00:00Z')
    const reset = () =>
      getDb().prepare('UPDATE users SET last_rollover_date = NULL WHERE id = ?').run(TEST_USER_ID)
    const stamped = () =>
      (
        getDb().prepare('SELECT last_rollover_date FROM users WHERE id = ?').get(TEST_USER_ID) as {
          last_rollover_date: string
        }
      ).last_rollover_date

    reset()
    stampRolloverDates(getDb(), at0400)
    expect(stamped()).toBe('2026-01-15') // unset: 03:00, so at 04:00 the day has started

    setRow({ day_start_time: '07:00', day_start_slot_id: null })
    reset()
    stampRolloverDates(getDb(), at0400)
    expect(stamped()).toBe('2026-01-14') // 07:00: 04:00 is still yesterday

    // 11 PM: 22:30 Chicago on Jan 15 is still the 15th; 23:00 is already the 16th.
    setRow({ day_start_time: '23:00', day_start_slot_id: null })
    reset()
    stampRolloverDates(getDb(), new Date('2026-01-16T04:30:00Z'))
    expect(stamped()).toBe('2026-01-15')
    reset()
    stampRolloverDates(getDb(), new Date('2026-01-16T05:00:00Z'))
    expect(stamped()).toBe('2026-01-16')
  })
})

describe('deleting the period the day start links to', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-01-15T16:00:00Z'))
    setupTestDb()
  })
  afterEach(() => {
    vi.useRealTimers()
    teardownTestDb()
  })

  test('TDS-030: the link keeps the period’s time as custom, and the toast says so', () => {
    const midday = slotByLabel('Midday')
    setRow({ day_start_time: midday.start_time, day_start_slot_id: midday.id })
    const result = deleteTimeSlot({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      slotId: midday.id,
    })
    expect(result.settings_converted).toEqual(['Day start time'])
    expect(getDayStart(TEST_USER_ID)).toEqual({
      time: '12:00',
      slot_id: null,
      slot_label: null,
      default: false,
    })
    const entry = getDb()
      .prepare('SELECT description FROM undo_log WHERE id = ?')
      .get(result.undo_id) as { description: string }
    expect(entry.description).toBe('Removed "Midday"; kept Day start time at 12:00 PM')
  })

  test('TDS-031: undo puts the link back with the period; redo converts again', () => {
    const midday = slotByLabel('Midday')
    setRow({ day_start_time: midday.start_time, day_start_slot_id: midday.id })
    deleteTimeSlot({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, slotId: midday.id })

    executeUndo(TEST_USER_ID)
    expect(getDayStart(TEST_USER_ID)).toMatchObject({ slot_id: midday.id, default: false })

    executeRedo(TEST_USER_ID)
    expect(getDayStart(TEST_USER_ID)).toMatchObject({
      time: '12:00',
      slot_id: null,
      default: false,
    })
  })

  test('TDS-032: a day start changed after the delete keeps the newer value on undo', () => {
    const midday = slotByLabel('Midday')
    setRow({ day_start_time: midday.start_time, day_start_slot_id: midday.id })
    deleteTimeSlot({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, slotId: midday.id })
    setRow({ day_start_time: '03:00', day_start_slot_id: null })

    executeUndo(TEST_USER_ID)
    expect(getDayStart(TEST_USER_ID)).toMatchObject({ time: '03:00', slot_id: null })
    // The period itself is back.
    expect(slotByLabel('Midday').id).toBe(midday.id)
  })

  test('TDS-033: unset — deleting the first period converts nothing; the day still starts at 3:00', () => {
    const early = slotByLabel('Early morning')
    const result = deleteTimeSlot({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      slotId: early.id,
    })
    expect(result.settings_converted).toEqual([])
    expect(getDayStart(TEST_USER_ID)).toMatchObject({ time: '03:00', default: true })
    executeUndo(TEST_USER_ID)
    expect(rolloverTimeForUser(TEST_USER_ID)).toBe('03:00')
  })
})
