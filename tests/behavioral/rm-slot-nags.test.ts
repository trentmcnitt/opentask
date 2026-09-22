/**
 * Unfinished-slot nag behavioral tests (RN-001 … RN-019)
 *
 * The hourly nag is a CONSCIOUS EXCEPTION to §6's "a reminder carries no debt"
 * (see `src/core/notifications/slot-nags.ts` for the full statement of how far
 * the exception goes). These tests pin the exception's boundaries: when it
 * fires, when it must stay silent, and that it can never become more than one
 * notification at a time or more than three a day.
 *
 * TIME-AGNOSTIC: every test builds its instants explicitly through luxon in a
 * named zone and freezes the clock to match. Nothing here reads the wall clock,
 * so the suite behaves identically at 3am and at 3pm.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { DateTime } from 'luxon'
import { getDb } from '@/core/db'
import { createTask, markDone } from '@/core/tasks'
import {
  pendingSlotNags,
  recordSlotNag,
  purgeOldSlotNags,
  isAwake,
  slotNagBody,
  MAX_NAGS_PER_DAY,
} from '@/core/notifications/slot-nags'
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
 * 12:00 Midday, 16:00 Afternoon, 20:30 Evening.
 * Default window: wake 07:00, sleep 22:00.
 */

/** A UTC instant for a wall-clock time on 2026-01-15 in the test timezone. */
function at(hour: number, minute = 0, day = 15, zone: string = TEST_TIMEZONE): Date {
  return DateTime.fromObject({ year: 2026, month: 1, day, hour, minute }, { zone }).toJSDate()
}

/** A reminder due at a local wall-clock time, which is what puts it in a slot. */
function makeReminder(hour: number, minute = 0, userId = TEST_USER_ID, zone = TEST_TIMEZONE) {
  return createTask({
    userId,
    userTimezone: zone,
    input: {
      title: 'Yesterday = Lesson, Tomorrow = Plan',
      is_reminder: true,
      due_at: DateTime.fromJSDate(at(hour, minute, 15, zone))
        .toUTC()
        .toISO()!,
    },
  })
}

function setWindow(wake: string, sleep: string, userId = TEST_USER_ID) {
  getDb()
    .prepare('UPDATE users SET wake_time = ?, sleep_time = ? WHERE id = ?')
    .run(wake, sleep, userId)
}

/**
 * What the cron does, minus APNs: decide, then claim. Returns the nags that
 * actually went out. Lets the cap and the double-run be tested without
 * credentials, which is the whole reason the decision is a separate function.
 */
function sweep(now: Date) {
  return pendingSlotNags(now).filter((nag) =>
    recordSlotNag(nag.userId, nag.localDate, nag.localHour),
  )
}

/** Every group freezes the clock the same way, before the DB is seeded. */
function freezeAndSeed() {
  beforeEach(() => {
    // 2026-01-15 08:00 Chicago — an hour with no slot boundary on it.
    vi.setSystemTime(at(8))
    setupTestDb()
  })

  afterEach(() => {
    vi.useRealTimers()
    teardownTestDb()
  })
}

describe('Unfinished-slot nag — when it fires', () => {
  freezeAndSeed()

  /**
   * RN-001: The nag is hourly. Any other minute is silence — otherwise this
   * would be a per-minute nag, which is the failure mode §6 exists to prevent.
   */
  test('RN-001: fires on the hour and at no other minute', () => {
    makeReminder(7)

    expect(pendingSlotNags(at(8, 0))).toHaveLength(1)
    expect(pendingSlotNags(at(8, 1))).toHaveLength(0)
    expect(pendingSlotNags(at(8, 30))).toHaveLength(0)
    expect(pendingSlotNags(at(8, 59))).toHaveLength(0)
  })

  /**
   * RN-002: The waking window's lower edge is inclusive — "at or after
   * wake_time". 11:00 is used because 07:00 (the default wake) is also a slot
   * boundary, which RN-006 suppresses for an unrelated reason.
   */
  test('RN-002: silent before wake_time, fires at exactly wake_time', () => {
    makeReminder(7)
    setWindow('11:00', '22:00')

    expect(pendingSlotNags(at(10))).toHaveLength(0)
    expect(pendingSlotNags(at(11))).toHaveLength(1)
  })

  /**
   * RN-003: The upper edge is exclusive — "strictly before sleep_time". With
   * the default 22:00 sleep, 21:00 is the last nag of the day.
   */
  test('RN-003: fires before sleep_time, silent at exactly sleep_time', () => {
    makeReminder(7)

    expect(pendingSlotNags(at(21))).toHaveLength(1)
    expect(pendingSlotNags(at(22))).toHaveLength(0)
    expect(pendingSlotNags(at(23))).toHaveLength(0)
  })

  /**
   * RN-004: A window whose sleep_time is at or before its wake_time wraps past
   * midnight rather than being empty. Only the evening half is reachable
   * end-to-end (no slot has opened at 01:00), so the small-hours half is
   * covered by the isAwake unit tests below.
   */
  test('RN-004: a window crossing midnight stays open late', () => {
    makeReminder(20, 30)
    setWindow('07:00', '02:00')

    // 23:00 would be outside a 07:00-22:00 window, but this one wraps.
    expect(pendingSlotNags(at(23))).toHaveLength(1)
  })

  /** RN-005: the wrap arithmetic itself, at every edge. */
  test('RN-005: isAwake handles ordinary, wrapping and degenerate windows', () => {
    // Ordinary window: inclusive lower edge, exclusive upper edge.
    expect(isAwake(6 * 60 + 59, '07:00', '22:00')).toBe(false)
    expect(isAwake(7 * 60, '07:00', '22:00')).toBe(true)
    expect(isAwake(21 * 60 + 59, '07:00', '22:00')).toBe(true)
    expect(isAwake(22 * 60, '07:00', '22:00')).toBe(false)

    // Wrapping window (awake 07:00 -> 02:00 the next morning).
    expect(isAwake(23 * 60, '07:00', '02:00')).toBe(true)
    expect(isAwake(0, '07:00', '02:00')).toBe(true)
    expect(isAwake(1 * 60 + 59, '07:00', '02:00')).toBe(true)
    expect(isAwake(2 * 60, '07:00', '02:00')).toBe(false)
    expect(isAwake(6 * 60, '07:00', '02:00')).toBe(false)

    // Degenerate wake == sleep reads as "awake all day" — failing silent would
    // disable the feature invisibly.
    expect(isAwake(3 * 60, '07:00', '07:00')).toBe(true)

    // A malformed HH:MM must never become a 3am notification.
    expect(isAwake(3 * 60, 'nonsense', '22:00')).toBe(false)
    expect(isAwake(12 * 60, '07:00', '')).toBe(false)
  })

  /**
   * RN-006: A slot opening on this exact minute sends its own push. Two banners
   * in one minute is the single thing this feature must not cause.
   */
  test('RN-006: silent on a minute when a slot opens', () => {
    makeReminder(7)

    // 09:00 is the Morning boundary — that slot notifies for itself.
    expect(pendingSlotNags(at(9))).toHaveLength(0)
    // 10:00 is not a boundary.
    expect(pendingSlotNags(at(10))).toHaveLength(1)
  })

  /**
   * RN-007: Suppression is per-minute, not per-hour — a 20:30 boundary does not
   * silence the 20:00 nag.
   */
  test('RN-007: an off-the-hour slot boundary does not silence that hour', () => {
    makeReminder(7)
    expect(pendingSlotNags(at(20))).toHaveLength(1)
  })
})

describe('Unfinished-slot nag — what it sends', () => {
  freezeAndSeed()

  /**
   * RN-008: ONE notification, however many slots are unfinished. This is the
   * literal request: "At most you're getting one reminder nag, regardless of
   * how many time periods of the reminders are undone."
   */
  test('RN-008: several unfinished slots produce exactly one nag', () => {
    makeReminder(7)
    makeReminder(7, 30)
    makeReminder(9)
    makeReminder(12)

    const pending = pendingSlotNags(at(13))
    expect(pending).toHaveLength(1)
  })

  /**
   * RN-009: ...and it names the MOST RECENT unfinished slot, counting the rest
   * rather than listing them.
   */
  test('RN-009: the nag targets the latest opened unfinished slot', () => {
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
    })
    expect(nag.slotId).toBeGreaterThan(0)
  })

  /**
   * RN-009b: "Most recent UNFINISHED", not "most recent opened". A later slot
   * the user has already cleared is not the target and is not counted — without
   * this, RN-009 would still pass if the code simply took the latest opened
   * slot, because there every slot happens to be unfinished.
   */
  test('RN-009b: a later slot that is already finished is skipped, not targeted', () => {
    makeReminder(7)
    const midday = makeReminder(12)
    markDone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: midday.id })

    const [nag] = pendingSlotNags(at(13))
    expect(nag).toMatchObject({
      slotLabel: 'Early morning',
      count: 1,
      otherSlots: 0,
    })
  })

  /** RN-010: the body names the target and its count; the others are a count only. */
  test('RN-010: the body counts the other slots without enumerating them', () => {
    expect(slotNagBody(1, 0)).toBe('1 reminder waiting')
    expect(slotNagBody(3, 0)).toBe('3 reminders waiting')
    expect(slotNagBody(3, 1)).toBe('3 reminders waiting, and 1 earlier slot')
    expect(slotNagBody(3, 2)).toBe('3 reminders waiting, and 2 earlier slots')
  })

  /** RN-011: nothing waiting, nothing said. */
  test('RN-011: silent when no reminders exist', () => {
    expect(pendingSlotNags(at(10))).toHaveLength(0)
  })

  /** RN-012: ...and silent once the waiting ones have been considered. */
  test('RN-012: silent when every reminder has been done', () => {
    const first = makeReminder(7)
    const second = makeReminder(9)
    expect(pendingSlotNags(at(13))).toHaveLength(1)

    markDone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: first.id })
    markDone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: second.id })

    expect(pendingSlotNags(at(13))).toHaveLength(0)
  })

  /**
   * RN-013: NEVER for a slot that has not opened. The nag only re-surfaces a
   * moment that has already passed — it does not pre-announce one.
   */
  test('RN-013: a slot that has not opened yet is never nagged about', () => {
    makeReminder(20, 30) // Evening, opens at 20:30

    expect(pendingSlotNags(at(10))).toHaveLength(0)
    expect(pendingSlotNags(at(15))).toHaveLength(0)
    expect(pendingSlotNags(at(20))).toHaveLength(0)

    const [nag] = pendingSlotNags(at(21))
    expect(nag).toMatchObject({ slotLabel: 'Evening', count: 1, otherSlots: 0 })
  })
})

describe('Unfinished-slot nag — the daily allowance', () => {
  freezeAndSeed()

  /** RN-014: three a day, then quiet. */
  test('RN-014: the daily cap stops the fourth nag', () => {
    makeReminder(7)

    expect(sweep(at(8))).toHaveLength(1)
    expect(sweep(at(10))).toHaveLength(1)
    expect(sweep(at(11))).toHaveLength(1)
    expect(MAX_NAGS_PER_DAY).toBe(3)

    // Fourth eligible hour of the same day: still unfinished, still awake,
    // still on the hour — and silent.
    expect(sweep(at(13))).toHaveLength(0)
    expect(pendingSlotNags(at(13))).toHaveLength(0)

    const row = getDb()
      .prepare('SELECT sent_count FROM slot_nags WHERE user_id = ? AND local_date = ?')
      .get(TEST_USER_ID, '2026-01-15') as { sent_count: number }
    expect(row.sent_count).toBe(3)
  })

  /**
   * RN-015: The sweep can run twice in the same minute. That must cost one nag,
   * not two — otherwise a duplicate tick silently eats a third of the day's
   * allowance.
   */
  test('RN-015: a same-minute double run consumes only one nag', () => {
    makeReminder(7)

    expect(sweep(at(8))).toHaveLength(1)
    expect(sweep(at(8))).toHaveLength(0)
    expect(recordSlotNag(TEST_USER_ID, '2026-01-15', 8)).toBe(false)

    const row = getDb()
      .prepare('SELECT sent_count, last_hour FROM slot_nags WHERE user_id = ? AND local_date = ?')
      .get(TEST_USER_ID, '2026-01-15') as { sent_count: number; last_hour: number }
    expect(row.sent_count).toBe(1)
    expect(row.last_hour).toBe(8)

    // A later hour is still available — the guard is per-hour, not a one-shot.
    expect(sweep(at(10))).toHaveLength(1)
  })

  /** RN-016: the cap is per LOCAL day, so a new day starts fresh. */
  test('RN-016: the cap resets on the next local day', () => {
    makeReminder(7)

    sweep(at(8))
    sweep(at(10))
    sweep(at(11))
    expect(sweep(at(13))).toHaveLength(0)

    vi.setSystemTime(at(8, 0, 16))
    expect(sweep(at(8, 0, 16))).toHaveLength(1)
  })

  /**
   * RN-017: Every clock decision is the USER's local clock, not the server's.
   * Kolkata is UTC+05:30, so its top-of-the-hour never coincides with Chicago's
   * — which is exactly what makes this a real test.
   */
  test('RN-017: the hour, the window and the slots are all user-local', () => {
    const KOLKATA = 'Asia/Kolkata'
    seedTestUser(2, 'kolkata@example.com', KOLKATA)
    seedTestProject(2, 'Inbox', 2)
    // Chicago's user must not answer for Kolkata's, so give only user 2 reminders.
    makeReminder(7, 0, 2, KOLKATA)
    makeReminder(16, 0, 2, KOLKATA)

    // 14:00 UTC — 08:00 in Chicago (on the hour) but 19:30 in Kolkata.
    const chicagoHour = at(8, 0, 15, TEST_TIMEZONE)
    expect(pendingSlotNags(chicagoHour)).toHaveLength(0)

    // 14:30 UTC — 20:00 in Kolkata (on the hour) but 08:30 in Chicago.
    // Evening (20:30) has not opened in Kolkata yet, so Afternoon is the target;
    // that same instant is 04:30 in Chicago, where no slot has opened at all.
    const kolkataHour = at(20, 0, 15, KOLKATA)
    const pending = pendingSlotNags(kolkataHour)
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({
      userId: 2,
      slotLabel: 'Afternoon',
      count: 1,
      otherSlots: 1,
      localHour: 20,
    })
    expect(pending[0].localDate).toBe('2026-01-15')
  })

  /** RN-018: a user who turned notifications off is not nagged. */
  test('RN-018: users with notifications disabled are skipped', () => {
    makeReminder(7)
    getDb().prepare('UPDATE users SET notifications_enabled = 0 WHERE id = ?').run(TEST_USER_ID)

    expect(pendingSlotNags(at(10))).toHaveLength(0)
  })

  /** RN-019: old rows do not accumulate; the current day's row is untouched. */
  test('RN-019: the purge drops old rows and keeps the current one', () => {
    const db = getDb()
    const insert = db.prepare(
      'INSERT INTO slot_nags (user_id, local_date, sent_count, last_hour) VALUES (?, ?, 1, 8)',
    )
    insert.run(TEST_USER_ID, '2020-01-01')
    insert.run(TEST_USER_ID, DateTime.utc().toISODate()!)

    expect(purgeOldSlotNags()).toBe(1)

    const remaining = db.prepare('SELECT local_date FROM slot_nags').all() as {
      local_date: string
    }[]
    expect(remaining.map((r) => r.local_date)).toEqual([DateTime.utc().toISODate()!])
  })
})
