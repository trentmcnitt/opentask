/**
 * Anchor times (TAT-001..) — Morning, Wake, Sleep and the number pad's four
 * buttons, each a custom time or linked to a reminder period (2026-10-21,
 * `src/lib/anchor-times.ts`, `src/core/users/anchor-times.ts`).
 *
 * Pins: the one resolver rule; a linked setting following its period's
 * retime into every server reader; deleting a linked period keeps its time as
 * custom, and undo/redo move the links back and forth compare-and-set.
 *
 * Default slots (seeded by setupTestDb): Early morning 07:00, Morning 09:00,
 * Midday 12:00, Afternoon 16:00, Evening 20:30.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { DateTime } from 'luxon'
import { getDb } from '@/core/db'
import { createTask } from '@/core/tasks'
import { executeUndo, executeRedo } from '@/core/undo'
import {
  createTimeSlot,
  listTimeSlots,
  seedDefaultTimeSlots,
  type TimeSlot,
} from '@/core/time-slots'
import { updateTimeSlot, deleteTimeSlot } from '@/core/time-slots/edit'
import { getTargetContext } from '@/core/tasks/target-context'
import { rolloverTimeForUser } from '@/core/tasks/rollover-time'
import { getAnchorTimes, readAnchorRow } from '@/core/users/anchor-times'
import { updatePreferences } from '@/core/users/preferences'
import { getScheduleBlock } from '@/core/ai/format'
import { pendingSlotNags } from '@/core/notifications/slot-nags'
import { initWidgetPushSync, WIDGET_PUSH_SETTLE_MS } from '@/core/notifications/widget-push'
import { emitSyncEvent } from '@/lib/sync-events'
import {
  anchorLabel,
  DEFAULT_ANCHOR_ROW,
  DEFAULT_PAD_PRESETS,
  hasAnyLink,
  newAccountLinks,
  parsePadPresets,
  resolveAnchorTimes,
  resolveTime,
  serializePadPresets,
  settingWrites,
  unlinkSlot,
  type AnchorRow,
} from '@/lib/anchor-times'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

function slotByLabel(label: string): TimeSlot {
  const slot = listTimeSlots(TEST_USER_ID).find((s) => s.label === label)
  if (!slot) throw new Error(`no slot ${label}`)
  return slot
}

function setRow(changes: Partial<AnchorRow>) {
  updatePreferences(TEST_USER_ID, changes)
}

function localHHMM(iso: string | null): string | null {
  return iso
    ? DateTime.fromISO(iso, { zone: 'utc' }).setZone(TEST_TIMEZONE).toFormat('HH:mm')
    : null
}

const slot = (id: number, label: string, start_time: string): TimeSlot => ({
  id,
  user_id: 1,
  label,
  start_time,
  sort_order: 0,
  created_at: '2026-01-01T00:00:00Z',
})

describe('the resolver (pure)', () => {
  const slots = [slot(5, 'Morning', '08:30'), slot(6, 'Evening', '20:00')]

  test('TAT-001: a custom time reads as itself', () => {
    expect(resolveTime({ time: '07:15', slot_id: null }, slots)).toEqual({
      time: '07:15',
      slot_id: null,
      slot_label: null,
    })
  })

  test("TAT-002: a link reads the period's start, not its snapshot", () => {
    expect(resolveTime({ time: '09:00', slot_id: 5 }, slots)).toEqual({
      time: '08:30',
      slot_id: 5,
      slot_label: 'Morning',
    })
  })

  test('TAT-003: a link to a period that is gone falls back to its snapshot, unlinked', () => {
    expect(resolveTime({ time: '09:00', slot_id: 99 }, slots)).toEqual({
      time: '09:00',
      slot_id: null,
      slot_label: null,
    })
  })

  test('TAT-004: a NULL, unparseable or wrong-length pad is the four defaults', () => {
    const defaults = DEFAULT_PAD_PRESETS.map((p) => ({ ...p }))
    expect(parsePadPresets(null)).toEqual(defaults)
    expect(parsePadPresets('not json')).toEqual(defaults)
    expect(parsePadPresets('[{"time":"07:00","slot_id":null}]')).toEqual(defaults)
    expect(parsePadPresets(JSON.stringify([...defaults.slice(0, 3), { time: '25:00' }]))).toEqual(
      defaults,
    )
    expect(defaults.map((p) => p.time)).toEqual(['09:00', '12:00', '16:00', '20:30'])
  })

  test('TAT-005: an existing user (all NULL) resolves to the times they had and the default pad', () => {
    const resolved = resolveAnchorTimes(DEFAULT_ANCHOR_ROW, slots)
    expect([resolved.morning.time, resolved.wake.time, resolved.sleep.time]).toEqual([
      '09:00',
      '07:00',
      '22:00',
    ])
    expect(resolved.pad.map((p) => p.time)).toEqual(['09:00', '12:00', '16:00', '20:30'])
    expect(hasAnyLink(DEFAULT_ANCHOR_ROW)).toBe(false)
  })

  test("TAT-006: Settings' summary line names the period it follows", () => {
    expect(anchorLabel({ time: '08:30', slot_id: 5, slot_label: 'Morning' })).toBe(
      '8:30 AM · Morning period',
    )
    expect(anchorLabel({ time: '22:00', slot_id: null, slot_label: null })).toBe('10:00 PM')
  })

  test('TAT-007: compare-and-set is per setting — a newer custom time is never re-linked', () => {
    const linked: AnchorRow = {
      ...DEFAULT_ANCHOR_ROW,
      morning_slot_id: 5,
      morning_time: '09:00',
      pad_presets: serializePadPresets([
        { time: '09:00', slot_id: null },
        { time: '08:30', slot_id: 5 },
        { time: '16:00', slot_id: null },
        { time: '20:30', slot_id: null },
      ]),
    }
    const changes = unlinkSlot(linked, { id: 5, start_time: '08:30' })
    expect(changes.map((c) => c.setting)).toEqual(['morning', 1])

    const converted = { ...linked, ...settingWrites(linked, changes, 'after') }
    expect(converted.morning_slot_id).toBeNull()
    expect(converted.morning_time).toBe('08:30')
    expect(parsePadPresets(converted.pad_presets)[1]).toEqual({ time: '08:30', slot_id: null })

    // The user then sets Morning to a custom 07:00: undo leaves it alone (its
    // slot_id is null, as the converted value's is — compared as a pair).
    const edited = { ...converted, morning_time: '07:00' }
    const undone = { ...edited, ...settingWrites(edited, changes, 'before') }
    expect([undone.morning_time, undone.morning_slot_id]).toEqual(['07:00', null])
    expect(parsePadPresets(undone.pad_presets)[1]).toEqual({ time: '08:30', slot_id: 5 })
  })
})

describe('a linked setting follows its period', () => {
  beforeEach(() => {
    // Thursday 2026-01-15, 10:00 Chicago.
    vi.setSystemTime(new Date('2026-01-15T16:00:00Z'))
    setupTestDb()
  })
  afterEach(() => {
    vi.useRealTimers()
    teardownTestDb()
  })

  test('TAT-010: an existing user reads exactly as before', () => {
    const times = getAnchorTimes(TEST_USER_ID)
    expect([times.morning.time, times.wake.time, times.sleep.time]).toEqual([
      '09:00',
      '07:00',
      '22:00',
    ])
    expect(times.pad.map((p) => p.time)).toEqual(['09:00', '12:00', '16:00', '20:30'])
    expect(getTargetContext(TEST_USER_ID).morningTime).toBe('09:00')
  })

  test('TAT-011: Morning linked to a period that moves to 08:30 — every task-side reader takes 08:30', () => {
    const morning = slotByLabel('Morning')
    setRow({ morning_slot_id: morning.id, morning_time: morning.start_time })
    updateTimeSlot({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      slotId: morning.id,
      input: { start_time: '08:30' },
    })

    expect(getAnchorTimes(TEST_USER_ID).morning).toEqual({
      time: '08:30',
      slot_id: morning.id,
      slot_label: 'Morning',
    })
    expect(getTargetContext(TEST_USER_ID).morningTime).toBe('08:30')

    // The deadline's automatic target lands on the (resolved) Morning.
    const deadline = DateTime.fromISO('2026-01-25T17:00', { zone: TEST_TIMEZONE })
    const withDeadline = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'File the report', deadline_at: deadline.toUTC().toISO()! },
    })
    expect(withDeadline.target_auto).toBe(true)
    expect(localHHMM(withDeadline.due_at)).toBe('08:30')

    // A timeless rule takes the Morning time as its time.
    const daily = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Stretch', rrule: 'FREQ=DAILY' },
    })
    expect(daily.rrule).toBe('FREQ=DAILY;BYHOUR=8;BYMINUTE=30')
  })

  test('TAT-012: the AI schedule line reads the resolved Wake and Sleep', () => {
    const early = slotByLabel('Early morning')
    setRow({ wake_slot_id: early.id, wake_time: '07:00' })
    updateTimeSlot({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      slotId: early.id,
      input: { start_time: '06:15' },
    })
    expect(getScheduleBlock(TEST_USER_ID)).toContain('wakes at 6:15 AM, sleeps at 10:00 PM')
  })

  test('TAT-013: the rollover never follows Morning — unset, it is the 3:00 AM default', () => {
    // Since 2026-10-24 "Day starts at" has no Morning (or first-period) fallback.
    setRow({ morning_slot_id: slotByLabel('Midday').id, morning_time: '12:00' })
    expect(rolloverTimeForUser(TEST_USER_ID)).toBe('03:00')
  })
})

describe('wake and sleep in the push readers', () => {
  // 2026-01-15 in Chicago, built per hour.
  const at = (hour: number) =>
    DateTime.fromObject({ year: 2026, month: 1, day: 15, hour }, { zone: TEST_TIMEZONE }).toJSDate()

  beforeEach(() => {
    vi.setSystemTime(at(8))
    setupTestDb()
  })
  afterEach(() => {
    vi.useRealTimers()
    teardownTestDb()
  })

  // Since 2026-10-22 the slot nag has no Wake–Sleep window (Trent: no
  // time-of-day behaviour), so a linked Wake no longer holds it back.
  test('TAT-020: the slot nag ignores Wake, linked or not', () => {
    createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: {
        title: 'Vitamins',
        is_reminder: true,
        due_at: DateTime.fromJSDate(at(7)).toUTC().toISO()!,
      },
    })
    const brunch = createTimeSlot(TEST_USER_ID, 'Brunch', '10:30')
    // The snapshot says 07:00; the link says 10:30 — the link wins.
    setRow({ wake_slot_id: brunch.id, wake_time: '07:00' })

    expect(pendingSlotNags(at(10))).toHaveLength(1)
  })

  test('TAT-021: widget-push quiet hours end at a linked Wake, not its snapshot', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(at(6))
    getDb()
      .prepare(
        `INSERT INTO widget_push_tokens (user_id, push_token, bundle_id, platform, environment)
         VALUES (?, 'phone', 'io.mcnitt.opentask', 'ios', 'production')`,
      )
      .run(TEST_USER_ID)
    // Wake linked to a 05:30 period; its snapshot says 07:00, which would
    // make 06:00 quiet and hold the push (widget-push.test.ts covers holding).
    const dawn = createTimeSlot(TEST_USER_ID, 'Dawn', '05:30')
    setRow({ wake_slot_id: dawn.id, wake_time: '07:00' })
    const sent: number[] = []
    const stop = initWidgetPushSync({
      minIntervalMs: 300_000,
      quietHours: true,
      send: async (tokenId) => {
        sent.push(tokenId)
        return true
      },
    })
    try {
      emitSyncEvent(TEST_USER_ID)
      await vi.advanceTimersByTimeAsync(WIDGET_PUSH_SETTLE_MS)
      expect(sent).toHaveLength(1)
    } finally {
      stop()
    }
  })
})

describe('deleting a period something links to', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-01-15T16:00:00Z'))
    setupTestDb()
  })
  afterEach(() => {
    vi.useRealTimers()
    teardownTestDb()
  })

  function linkMorningAndPad2(midday: TimeSlot) {
    setRow({
      morning_slot_id: midday.id,
      morning_time: midday.start_time,
      pad_presets: serializePadPresets([
        { time: '09:00', slot_id: null },
        { time: midday.start_time, slot_id: midday.id },
        { time: '16:00', slot_id: null },
        { time: '20:30', slot_id: null },
      ]),
    })
  }

  test('TAT-030: the links keep the period’s time as custom, and say so', () => {
    const midday = slotByLabel('Midday')
    linkMorningAndPad2(midday)

    const result = deleteTimeSlot({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      slotId: midday.id,
    })
    expect(result.settings_converted).toEqual(['Default task time', 'Number pad button 2'])

    const row = readAnchorRow(TEST_USER_ID)
    expect([row.morning_time, row.morning_slot_id]).toEqual(['12:00', null])
    expect(parsePadPresets(row.pad_presets)[1]).toEqual({ time: '12:00', slot_id: null })
    expect(getAnchorTimes(TEST_USER_ID).morning.time).toBe('12:00')

    const entry = getDb()
      .prepare('SELECT description FROM undo_log WHERE id = ?')
      .get(result.undo_id) as { description: string }
    expect(entry.description).toBe(
      'Removed "Midday"; kept Default task time, Number pad button 2 at 12:00 PM',
    )
  })

  test('TAT-031: undo restores the period under its id AND the links; redo converts again', () => {
    const midday = slotByLabel('Midday')
    linkMorningAndPad2(midday)
    deleteTimeSlot({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, slotId: midday.id })

    executeUndo(TEST_USER_ID)
    expect(slotByLabel('Midday').id).toBe(midday.id)
    let times = getAnchorTimes(TEST_USER_ID)
    expect(times.morning).toEqual({ time: '12:00', slot_id: midday.id, slot_label: 'Midday' })
    expect(times.pad[1].slot_id).toBe(midday.id)

    executeRedo(TEST_USER_ID)
    times = getAnchorTimes(TEST_USER_ID)
    expect(times.morning).toEqual({ time: '12:00', slot_id: null, slot_label: null })
    expect(times.pad[1]).toEqual({ time: '12:00', slot_id: null, slot_label: null })
  })

  test('TAT-032: a setting changed after the delete keeps the newer value on undo', () => {
    const midday = slotByLabel('Midday')
    linkMorningAndPad2(midday)
    deleteTimeSlot({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, slotId: midday.id })
    setRow({ morning_time: '07:00', morning_slot_id: null })

    executeUndo(TEST_USER_ID)
    const times = getAnchorTimes(TEST_USER_ID)
    expect(times.morning).toEqual({ time: '07:00', slot_id: null, slot_label: null })
    // The pad button the user didn't touch is linked again.
    expect(times.pad[1].slot_id).toBe(midday.id)
  })

  test('TAT-033: a period nothing links to deletes as before (no settings in the entry)', () => {
    const evening = slotByLabel('Evening')
    const result = deleteTimeSlot({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      slotId: evening.id,
    })
    expect(result.settings_converted).toEqual([])
    const entry = getDb()
      .prepare('SELECT slot_state FROM undo_log WHERE id = ?')
      .get(result.undo_id) as { slot_state: string }
    expect(JSON.parse(entry.slot_state).user_settings).toBeUndefined()
  })

  test('TAT-035: redo unlinks what links to the period NOW, and a later undo restores exactly that', () => {
    const midday = slotByLabel('Midday')
    linkMorningAndPad2(midday)
    deleteTimeSlot({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, slotId: midday.id })
    executeUndo(TEST_USER_ID)

    // Between the undo and the redo: Wake linked to the restored period, and
    // Morning made custom.
    setRow({ wake_slot_id: midday.id, wake_time: midday.start_time })
    setRow({ morning_time: '06:45', morning_slot_id: null })

    executeRedo(TEST_USER_ID)
    let times = getAnchorTimes(TEST_USER_ID)
    expect(times.wake).toEqual({ time: '12:00', slot_id: null, slot_label: null })
    expect(times.pad[1]).toEqual({ time: '12:00', slot_id: null, slot_label: null })
    expect(times.morning).toEqual({ time: '06:45', slot_id: null, slot_label: null })

    executeUndo(TEST_USER_ID)
    times = getAnchorTimes(TEST_USER_ID)
    expect(times.wake.slot_id).toBe(midday.id)
    expect(times.pad[1].slot_id).toBe(midday.id)
    expect(times.morning).toEqual({ time: '06:45', slot_id: null, slot_label: null })
  })

  test('TAT-034: invariant — no link outlives its period, so with no periods none can exist', () => {
    // Link everything to different periods, then delete periods down to the last.
    const slots = listTimeSlots(TEST_USER_ID)
    setRow({
      morning_slot_id: slots[1].id,
      wake_slot_id: slots[0].id,
      sleep_slot_id: slots[4].id,
      pad_presets: serializePadPresets(
        slots.slice(1, 5).map((s) => ({ time: s.start_time, slot_id: s.id })),
      ),
    })
    for (const s of slots.slice(0, -1)) {
      deleteTimeSlot({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, slotId: s.id })
      const live = new Set(listTimeSlots(TEST_USER_ID).map((x) => x.id))
      const row = readAnchorRow(TEST_USER_ID)
      const ids = [
        row.morning_slot_id,
        row.wake_slot_id,
        row.sleep_slot_id,
        ...parsePadPresets(row.pad_presets).map((p) => p.slot_id),
      ].filter((id): id is number => id !== null)
      expect(ids.every((id) => live.has(id))).toBe(true)
    }
    const last = listTimeSlots(TEST_USER_ID)
    expect(last).toHaveLength(1)
    expect(() =>
      deleteTimeSlot({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, slotId: last[0].id }),
    ).toThrow('Keep at least one reminder period')
  })
})

describe('a new account starts linked (2026-10-24)', () => {
  const defaults = [
    slot(11, 'Early morning', '07:00'),
    slot(12, 'Morning', '09:00'),
    slot(13, 'Midday', '12:00'),
    slot(14, 'Afternoon', '16:00'),
    slot(15, 'Evening', '20:30'),
  ]

  afterEach(() => {
    vi.useRealTimers()
    teardownTestDb()
  })

  test('TAT-040: each setting at a new period’s start links to it; Sleep and Day starts at stay', () => {
    const writes = newAccountLinks(DEFAULT_ANCHOR_ROW, defaults)
    expect(writes).toEqual({
      morning_slot_id: 12,
      wake_slot_id: 11,
      pad_presets: serializePadPresets([
        { time: '09:00', slot_id: 12 },
        { time: '12:00', slot_id: 13 },
        { time: '16:00', slot_id: 14 },
        { time: '20:30', slot_id: 15 },
      ]),
    })
    // Nothing moves: every setting resolves to the time it had.
    const before = resolveAnchorTimes(DEFAULT_ANCHOR_ROW, defaults)
    const after = resolveAnchorTimes({ ...DEFAULT_ANCHOR_ROW, ...writes }, defaults)
    expect(after.morning.time).toBe(before.morning.time)
    expect(after.wake.time).toBe(before.wake.time)
    expect(after.sleep).toEqual(before.sleep)
    expect(after.pad.map((p) => p.time)).toEqual(before.pad.map((p) => p.time))
    expect(after.morning.slot_label).toBe('Morning')
    expect(after.wake.slot_label).toBe('Early morning')
  })

  test('TAT-041: a custom time off every start, a link, or a customised pad is left alone', () => {
    const row: AnchorRow = {
      ...DEFAULT_ANCHOR_ROW,
      morning_time: '08:30',
      wake_slot_id: 99,
      pad_presets: serializePadPresets(DEFAULT_PAD_PRESETS),
    }
    expect(newAccountLinks(row, defaults)).toEqual({})
  })

  test('TAT-042: seedDefaultTimeSlots links a new user once; a second call changes nothing', () => {
    setupTestDb()
    const db = getDb()
    db.prepare(
      "INSERT INTO users (id, email, name, password_hash, timezone) VALUES (7, 'new@example.com', 'new', 'x', 'UTC')",
    ).run()
    seedDefaultTimeSlots(7)
    const slots = listTimeSlots(7)
    const id = (label: string) => slots.find((s) => s.label === label)!.id
    const row = readAnchorRow(7)
    expect(row).toMatchObject({
      morning_time: '09:00',
      morning_slot_id: id('Morning'),
      wake_time: '07:00',
      wake_slot_id: id('Early morning'),
      sleep_time: '22:00',
      sleep_slot_id: null,
      day_start_time: null,
      day_start_slot_id: null,
    })
    expect(parsePadPresets(row.pad_presets).map((p) => p.slot_id)).toEqual([
      id('Morning'),
      id('Midday'),
      id('Afternoon'),
      id('Evening'),
    ])
    seedDefaultTimeSlots(7)
    expect(readAnchorRow(7)).toEqual(row)
    expect(listTimeSlots(7)).toHaveLength(5)
  })
})
