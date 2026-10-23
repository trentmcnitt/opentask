/**
 * Unfinished-slot nag behavioral tests (RN-001 … RN-021)
 *
 * The nag is a CONSCIOUS EXCEPTION to §6's "a reminder carries no debt" (see
 * `src/core/notifications/slot-nags.ts`). Since Trent's 2026-10-22 ruling ("one
 * considering ladder, no special cases") it is paced by the nag ladder alone:
 * the user's Unset tier ×2 (60 minutes by default) after the slot's own push or
 * the last nag — no daily cap, no derived gap, no evening reserve, no Wake–Sleep
 * window, no top-of-the-hour alignment. These tests pin that, and the parts
 * that did not change: ONE notification per user, naming the latest unfinished
 * slot; never a slot that hasn't opened; silent once the slot is finished; the
 * day is the OpenTask day.
 *
 * TIME-AGNOSTIC: every test builds its instants explicitly through luxon in a
 * named zone and freezes the clock to match.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { DateTime } from 'luxon'
import { getDb } from '@/core/db'
import { createTask, markDone } from '@/core/tasks'
import { pendingSlotNags, purgeOldSlotNags, slotNagBody } from '@/core/notifications/slot-nags'
import { pendingSlotNotifications } from '@/core/notifications/slot-reminders'
import { buildSlotReminderNotification } from '@/core/notifications/apns'
import { claimNagSend, stampNagSend, SLOT_NAG_KEY } from '@/core/notifications/nag-sends'
import {
  setupTestDb,
  teardownTestDb,
  seedTestUser,
  seedTestProject,
  TEST_TIMEZONE,
  TEST_USER_ID,
} from '../helpers/setup'

/**
 * Default slots (seeded per user): 07:00 Early morning, 09:00 Morning,
 * 12:00 Midday, 16:00 Afternoon, 20:30 Evening. The OpenTask day turns at the
 * earliest period's start: 07:00. Default Unset tier 30 → the nag every 60.
 */

/** A UTC instant for a wall-clock time on 2026-01-<day> in the test timezone. */
function at(hour: number, minute = 0, day = 15, zone: string = TEST_TIMEZONE): Date {
  return DateTime.fromObject({ year: 2026, month: 1, day, hour, minute }, { zone }).toJSDate()
}

/** A reminder due at a local wall-clock time, which is what puts it in a slot. */
function makeReminder(
  hour: number,
  minute = 0,
  userId = TEST_USER_ID,
  zone = TEST_TIMEZONE,
  extra: Record<string, unknown> = {},
) {
  return createTask({
    userId,
    userTimezone: zone,
    input: {
      title: 'Morning = Focus, Afternoon = Meetings',
      is_reminder: true,
      due_at: DateTime.fromJSDate(at(hour, minute, 15, zone))
        .toUTC()
        .toISO()!,
      ...extra,
    },
  })
}

/**
 * One cron tick, minus APNs: the slot-open push first (it stamps the nag's
 * clock, as `checkSlotReminders` does), then the nag — decide, then claim.
 * Returns the nags that went out.
 */
function tick(now: Date) {
  for (const push of pendingSlotNotifications(now)) stampNagSend(push.userId, SLOT_NAG_KEY, now)
  return pendingSlotNags(now).filter((nag) =>
    claimNagSend(nag.userId, SLOT_NAG_KEY, nag.intervalMinutes, now),
  )
}

/** Tick every minute from `from` to `to` (inclusive) and list the local "HH:mm" that nagged. */
function firingMinutes(from: Date, to: Date): string[] {
  const fired: string[] = []
  for (let t = from.getTime(); t <= to.getTime(); t += 60_000) {
    const now = new Date(t)
    if (tick(now).length > 0) {
      fired.push(DateTime.fromJSDate(now).setZone(TEST_TIMEZONE).toFormat('dd HH:mm'))
    }
  }
  return fired
}

const hourly = (day: string, from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `${day} ${String(from + i).padStart(2, '0')}:00`)

/** Every group freezes the clock the same way, before the DB is seeded. */
function freezeAndSeed() {
  beforeEach(() => {
    // 2026-01-15 08:00 Chicago.
    vi.setSystemTime(at(8))
    setupTestDb()
  })

  afterEach(() => {
    vi.useRealTimers()
    teardownTestDb()
  })
}

describe('Unfinished-slot nag — the ladder paces it', () => {
  freezeAndSeed()

  /**
   * RN-001: a whole day, minute by minute. The slot opens at 07:00 (its own
   * push), the nag follows every 60 minutes from then — past the old 22:00
   * Sleep edge, with no cap of three.
   */
  test('RN-001: every 60 minutes after the slot opens, all day, no cap', () => {
    makeReminder(7)
    expect(firingMinutes(at(7), at(23, 59))).toEqual(hourly('15', 8, 23))
  })

  /**
   * RN-002: the slot's own push restarts the clock: a later slot opening with
   * reminders (09:00) pushes, and the nag waits 60 from it.
   */
  test("RN-002: a slot's own push counts as the last send", () => {
    makeReminder(7)
    makeReminder(9)
    expect(firingMinutes(at(7), at(11, 59))).toEqual(['15 08:00', '15 10:00', '15 11:00'])
  })

  /** RN-003: never a minute after a slot's banner — 07:01 is not 08:00. */
  test('RN-003: no nag the minute after a slot opens', () => {
    makeReminder(7)
    tick(at(7))
    expect(tick(at(7, 1))).toHaveLength(0)
    expect(tick(at(7, 59))).toHaveLength(0)
    expect(tick(at(8))).toHaveLength(1)
  })

  /** RN-004: the interval is the user's Unset tier ×2 (the ladder's slot_nag row). */
  test("RN-004: the user's Unset tier moves the pace", () => {
    makeReminder(7)
    getDb().prepare('UPDATE users SET auto_snooze_minutes = 45 WHERE id = ?').run(TEST_USER_ID)
    expect(tick(at(8))).toHaveLength(1)
    expect(pendingSlotNags(at(9, 29))).toHaveLength(0)
    expect(pendingSlotNags(at(9, 30))).toMatchObject([{ intervalMinutes: 90 }])
  })

  /** RN-005: a double tick sends once; restart-safe (the clock is `nag_sends`). */
  test('RN-005: a same-minute double run sends one nag', () => {
    makeReminder(7)
    expect(tick(at(8))).toHaveLength(1)
    expect(tick(at(8))).toHaveLength(0)
    expect(tick(at(8, 59))).toHaveLength(0)
    expect(tick(at(9))).toHaveLength(1)
  })

  /** RN-006: a slot NOTIFYING on this exact minute puts its own banner up. */
  test('RN-006: silent on a minute when a slot actually notifies', () => {
    makeReminder(7)
    makeReminder(9)
    expect(pendingSlotNags(at(9))).toHaveLength(0)
    expect(pendingSlotNags(at(10))).toHaveLength(1)
  })

  /**
   * RN-007: ...but an EMPTY slot opening this minute sends nothing, so there is
   * no banner to collide with and the nag must still fire.
   */
  test('RN-007: an empty slot opening this minute does not suppress the nag', () => {
    makeReminder(7)
    expect(pendingSlotNotifications(at(9))).toHaveLength(0)
    const [nag] = pendingSlotNags(at(9))
    expect(nag).toMatchObject({ slotLabel: 'Early morning', count: 1 })
  })
})

describe('Unfinished-slot nag — the OpenTask day', () => {
  freezeAndSeed()

  /**
   * RN-008: a daily reminder left undone nags into the night, goes quiet from
   * local midnight to the rollover (nothing of the new OpenTask day has opened),
   * and starts again when the slot reopens.
   */
  test('RN-008: silent between midnight and the rollover; the new day re-arms it', () => {
    makeReminder(7, 0, TEST_USER_ID, TEST_TIMEZONE, { rrule: 'FREQ=DAILY' })
    expect(firingMinutes(at(22), at(23, 59))).toEqual(['15 22:00', '15 23:00'])
    expect(firingMinutes(at(0, 0, 16), at(6, 59, 16))).toEqual([])
    // 07:00 the slot opens (its own push), the nag an interval later.
    expect(firingMinutes(at(7, 0, 16), at(8, 0, 16))).toEqual(['16 08:00'])
  })

  /** RN-009: silencing = acting — finished today, silent today, back tomorrow. */
  test('RN-009: a finished slot is silent for the day and back the next', () => {
    const daily = makeReminder(7, 0, TEST_USER_ID, TEST_TIMEZONE, { rrule: 'FREQ=DAILY' })
    expect(tick(at(8))).toHaveLength(1)
    vi.setSystemTime(at(8, 30))
    markDone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: daily.id })
    expect(firingMinutes(at(8, 31), at(23, 59))).toEqual([])
    expect(firingMinutes(at(7, 0, 16), at(8, 0, 16))).toEqual(['16 08:00'])
  })
})

describe('Unfinished-slot nag — what it sends', () => {
  freezeAndSeed()

  /** RN-010: ONE notification, however many slots are unfinished. */
  test('RN-010: several unfinished slots produce exactly one nag', () => {
    makeReminder(7)
    makeReminder(7, 30)
    makeReminder(9)
    makeReminder(12)
    expect(pendingSlotNags(at(13))).toHaveLength(1)
  })

  /** RN-011: it names the MOST RECENT unfinished slot, counting the rest. */
  test('RN-011: the nag targets the latest opened unfinished slot', () => {
    makeReminder(7)
    makeReminder(7, 30)
    makeReminder(9)
    makeReminder(12)

    const [nag] = pendingSlotNags(at(13))
    expect(nag).toMatchObject({
      userId: TEST_USER_ID,
      slotLabel: 'Midday',
      count: 1,
      otherSlots: 2,
      intervalMinutes: 60,
    })
    expect(nag.slotId).toBeGreaterThan(0)
  })

  /** RN-012: a later slot already cleared is skipped, not targeted. */
  test('RN-012: a later slot that is already finished is skipped, not targeted', () => {
    makeReminder(7)
    const midday = makeReminder(12)
    markDone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: midday.id })

    const [nag] = pendingSlotNags(at(13))
    expect(nag).toMatchObject({ slotLabel: 'Early morning', count: 1, otherSlots: 0 })
  })

  /** RN-013: the body names the target and its count; the others are a count only. */
  test('RN-013: the body counts the other slots without enumerating them', () => {
    expect(slotNagBody(1, 0, 0)).toBe('1 reminder waiting')
    expect(slotNagBody(3, 0, 0)).toBe('3 reminders waiting')
    expect(slotNagBody(3, 0, 1)).toBe('3 reminders waiting, and 1 earlier slot')
    expect(slotNagBody(3, 0, 2)).toBe('3 reminders waiting, and 2 earlier slots')
  })

  /**
   * RN-013b: the nag is a SILENT banner (ruling 5: sound only on overdue); the
   * slot-open push keeps its sound. Same category, thread, collapse id and
   * userInfo either way, so the nag still replaces the slot's banner.
   */
  test('RN-013b: the nag payload has no sound; the slot-open payload is unchanged', () => {
    const open = buildSlotReminderNotification('tok', 'io.mcnitt.opentask', {
      slotId: 7,
      slotLabel: 'Morning',
      count: 3,
      promptCount: 1,
    })
    expect(open.buildApnsOptions()).toEqual({
      aps: {
        alert: { title: 'Morning', body: '3 reminders · 1 quota waiting' },
        category: 'SLOT_REMINDER',
        'thread-id': 'ot-reminders',
        sound: 'default',
        'interruption-level': 'active',
      },
      slot_id: 7,
      slot_label: 'Morning',
      reminder_count: 4,
      prompt_count: 1,
      deck_count: 0,
    })
    expect(open.options.collapseId).toBe('slot-7')

    const nag = buildSlotReminderNotification('tok', 'io.mcnitt.opentask', {
      slotId: 7,
      slotLabel: 'Morning',
      count: 3,
      promptCount: 1,
      body: slotNagBody(3, 1, 1),
      silent: true,
    })
    const { aps, ...data } = nag.buildApnsOptions() as { aps: Record<string, unknown> }
    expect(aps).not.toHaveProperty('sound')
    expect(aps).toEqual({
      alert: { title: 'Morning', body: '3 reminders · 1 quota waiting, and 1 earlier slot' },
      category: 'SLOT_REMINDER',
      'thread-id': 'ot-reminders',
      'interruption-level': 'active',
    })
    expect(data).toEqual({
      slot_id: 7,
      slot_label: 'Morning',
      reminder_count: 4,
      prompt_count: 1,
      deck_count: 0,
    })
    expect(nag.options.collapseId).toBe('slot-7')
  })

  /** RN-014: nothing waiting, nothing said. */
  test('RN-014: silent when no reminders exist', () => {
    expect(pendingSlotNags(at(10))).toHaveLength(0)
  })

  /** RN-015: ...and silent once the waiting ones have been done. */
  test('RN-015: silent when every reminder has been done', () => {
    const first = makeReminder(7)
    const second = makeReminder(9)
    expect(pendingSlotNags(at(13))).toHaveLength(1)

    markDone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: first.id })
    markDone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: second.id })

    expect(pendingSlotNags(at(13))).toHaveLength(0)
  })

  /** RN-016: NEVER for a slot that has not opened. */
  test('RN-016: a slot that has not opened yet is never nagged about', () => {
    makeReminder(20, 30) // Evening, opens at 20:30

    expect(pendingSlotNags(at(10))).toHaveLength(0)
    expect(pendingSlotNags(at(20, 29))).toHaveLength(0)
    const [nag] = pendingSlotNags(at(20, 31))
    expect(nag).toMatchObject({ slotLabel: 'Evening', count: 1, otherSlots: 0 })
  })
})

describe('Unfinished-slot nag — who and where', () => {
  freezeAndSeed()

  /**
   * RN-017: every clock decision is the USER's local clock. Kolkata is
   * UTC+05:30; its slots open at its own local times.
   */
  test('RN-017: the slots and the OpenTask day are user-local', () => {
    const KOLKATA = 'Asia/Kolkata'
    seedTestUser(2, 'kolkata@example.com', KOLKATA)
    seedTestProject(2, 'Inbox', 2)
    makeReminder(7, 0, 2, KOLKATA)
    makeReminder(16, 0, 2, KOLKATA)

    // 19:30 in Kolkata: Afternoon (16:00) has opened, Evening (20:30) not yet.
    const pending = pendingSlotNags(at(19, 30, 15, KOLKATA))
    expect(pending).toEqual([
      expect.objectContaining({ userId: 2, slotLabel: 'Afternoon', count: 1, otherSlots: 1 }),
    ])
    // 06:30 the next morning in Kolkata: before its 07:00 rollover — silent.
    expect(pendingSlotNags(at(6, 30, 16, KOLKATA))).toEqual([])
  })

  /** RN-018: a user who turned notifications off is not nagged. */
  test('RN-018: users with notifications disabled are skipped', () => {
    makeReminder(7)
    getDb().prepare('UPDATE users SET notifications_enabled = 0 WHERE id = ?').run(TEST_USER_ID)
    expect(pendingSlotNags(at(10))).toHaveLength(0)
  })

  /** RN-019: nor the demo user (`notifiableUsers`). */
  test('RN-019: the demo user is skipped', () => {
    makeReminder(7)
    getDb().prepare('UPDATE users SET is_demo = 1 WHERE id = ?').run(TEST_USER_ID)
    expect(pendingSlotNags(at(10))).toHaveLength(0)
  })

  /** RN-020: the retired `slot_nags` rows drain; nothing writes them any more. */
  test('RN-020: the purge drops old slot_nags rows', () => {
    const db = getDb()
    const insert = db.prepare(
      'INSERT INTO slot_nags (user_id, local_date, sent_count, last_hour) VALUES (?, ?, 1, 8)',
    )
    insert.run(TEST_USER_ID, '2020-01-01')
    insert.run(TEST_USER_ID, DateTime.utc().toISODate()!)
    expect(purgeOldSlotNags()).toBe(1)

    makeReminder(7)
    tick(at(8))
    const rows = db.prepare('SELECT COUNT(*) AS n FROM slot_nags').get() as { n: number }
    expect(rows.n).toBe(1)
  })
})
