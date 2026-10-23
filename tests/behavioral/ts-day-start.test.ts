/**
 * "Day starts at" (TDS-001..) — when the OpenTask day turns (2026-10-23,
 * `resolveDayStart` in `src/lib/anchor-times.ts`, `getDayStart` in
 * `src/core/users/anchor-times.ts`).
 *
 * Pins: unset (the default) follows the FIRST period, whichever that is, else
 * Morning — the rollover every user had before; a custom time and a link
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

  test('TDS-001: unset follows the FIRST period by start, not by id or order', () => {
    expect(resolveDayStart(unset, slots, '09:00')).toEqual({
      time: '06:30',
      slot_id: 4,
      slot_label: 'Dawn',
      first_period: true,
    })
  })

  test('TDS-002: unset with no periods reads the Morning time', () => {
    expect(resolveDayStart(unset, [], '09:15')).toEqual({
      time: '09:15',
      slot_id: null,
      slot_label: null,
      first_period: true,
    })
  })

  test('TDS-003: a custom time reads as itself — 03:00, before every period', () => {
    expect(
      resolveDayStart({ day_start_time: '03:00', day_start_slot_id: null }, slots, '09:00'),
    ).toEqual({ time: '03:00', slot_id: null, slot_label: null, first_period: false })
  })

  test("TDS-004: a link reads the period's start; a gone link its snapshot", () => {
    expect(
      resolveDayStart({ day_start_time: '19:00', day_start_slot_id: 6 }, slots, '09:00'),
    ).toEqual({ time: '20:00', slot_id: 6, slot_label: 'Evening', first_period: false })
    expect(
      resolveDayStart({ day_start_time: '19:00', day_start_slot_id: 99 }, slots, '09:00'),
    ).toEqual({ time: '19:00', slot_id: null, slot_label: null, first_period: false })
  })

  test('TDS-005: dayStartTimeOf (the bare-row twin) agrees with the resolver in every state', () => {
    const rows = [
      unset,
      { day_start_time: '03:00', day_start_slot_id: null },
      { day_start_time: '19:00', day_start_slot_id: 6 },
      { day_start_time: '19:00', day_start_slot_id: 99 },
    ]
    for (const row of rows) {
      for (const periods of [slots, []]) {
        expect(dayStartTimeOf(row, periods, '09:00')).toBe(
          resolveDayStart(row, periods, '09:00').time,
        )
      }
    }
  })

  test('TDS-006: a slot id with no time (never written) reads as unset', () => {
    expect(dayStartSetting({ day_start_time: null, day_start_slot_id: 6 })).toBeNull()
  })

  test('TDS-007: the summary line says what it follows', () => {
    expect(dayStartLabel(resolveDayStart(unset, slots, '09:00'))).toBe(
      '6:30 AM · first period (Dawn)',
    )
    expect(dayStartLabel(resolveDayStart(unset, [], '09:00'))).toBe('9:00 AM · Morning time')
    expect(
      dayStartLabel(
        resolveDayStart({ day_start_time: '03:00', day_start_slot_id: null }, slots, '09:00'),
      ),
    ).toBe('3:00 AM')
    expect(
      dayStartLabel(
        resolveDayStart({ day_start_time: '20:00', day_start_slot_id: 6 }, slots, '09:00'),
      ),
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

  test('TDS-020: unset is the first period, and moves with it (the rollover as it always was)', () => {
    expect(readAnchorRow(TEST_USER_ID).day_start_time).toBeNull()
    expect(rolloverTimeForUser(TEST_USER_ID)).toBe('07:00')
    expect(sqlRollover()).toBe('07:00')
    const dawn = createTimeSlot(TEST_USER_ID, 'Dawn', '05:45')
    expect(rolloverTimeForUser(TEST_USER_ID)).toBe('05:45')
    expect(getDayStart(TEST_USER_ID)).toMatchObject({ slot_id: dawn.id, first_period: true })
    expect(sqlRollover()).toBe('05:45')
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
    expect(stamped()).toBe('2026-01-14') // unset: 07:00, so 04:00 is still yesterday

    setRow({ day_start_time: '03:00', day_start_slot_id: null })
    reset()
    stampRolloverDates(getDb(), at0400)
    expect(stamped()).toBe('2026-01-15') // 03:00: the day has started
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
      first_period: false,
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
    expect(getDayStart(TEST_USER_ID)).toMatchObject({ slot_id: midday.id, first_period: false })

    executeRedo(TEST_USER_ID)
    expect(getDayStart(TEST_USER_ID)).toMatchObject({
      time: '12:00',
      slot_id: null,
      first_period: false,
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

  test('TDS-033: unset — deleting the first period converts nothing; the day starts at the next one', () => {
    const early = slotByLabel('Early morning')
    const result = deleteTimeSlot({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      slotId: early.id,
    })
    expect(result.settings_converted).toEqual([])
    expect(getDayStart(TEST_USER_ID)).toMatchObject({
      time: '09:00',
      slot_label: 'Morning',
      first_period: true,
    })
    executeUndo(TEST_USER_ID)
    expect(rolloverTimeForUser(TEST_USER_ID)).toBe('07:00')
  })
})
