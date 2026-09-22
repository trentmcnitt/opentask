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
  wakingWindowMinutes,
  minNagGapHours,
  slotNagBody,
  MAX_NAGS_PER_DAY,
} from '@/core/notifications/slot-nags'
import { pendingSlotNotifications } from '@/core/notifications/slot-reminders'
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
      title: 'Depressed = Past, Anxious = Future',
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

/**
 * Run the sweep on every hour in [from, to] and report which local hours
 * actually sent. This is how the day's SHAPE gets asserted rather than a
 * handful of hand-picked instants.
 */
function firingHours(from: number, to: number, day = 15): number[] {
  const fired: number[] = []
  for (let hour = from; hour <= to; hour++) {
    if (sweep(at(hour, 0, day)).length > 0) fired.push(hour)
  }
  return fired
}

/** Wipe the nag ledger so a scenario can be replayed from a clean day. */
function resetNagRows() {
  getDb().prepare('DELETE FROM slot_nags').run()
}

/** Put the user's day straight into a chosen state, to isolate one gate. */
function seedNagRow(sentCount: number, lastHour: number, localDate = '2026-01-15') {
  getDb()
    .prepare(
      `INSERT INTO slot_nags (user_id, local_date, sent_count, last_hour) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, local_date)
         DO UPDATE SET sent_count = excluded.sent_count, last_hour = excluded.last_hour`,
    )
    .run(TEST_USER_ID, localDate, sentCount, lastHour)
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
   * RN-006: A slot NOTIFYING on this exact minute puts its own banner up. Two
   * banners in one minute is the single thing this feature must not cause.
   */
  test('RN-006: silent on a minute when a slot actually notifies', () => {
    makeReminder(7)
    makeReminder(9) // gives the 09:00 Morning slot something to notify about

    expect(pendingSlotNags(at(9))).toHaveLength(0)
    // 10:00 is not a boundary, so the nag is free to speak.
    expect(pendingSlotNags(at(10))).toHaveLength(1)
  })

  /**
   * RN-006b: ...but an EMPTY slot opening this minute sends nothing, so there is
   * no banner to collide with and the nag must still fire.
   *
   * This is the coupling to watch: the suppression above is only justified
   * because `pendingSlotNotifications` stays silent for an empty slot. If that
   * ever changes, this test is the one that should start failing.
   */
  test('RN-006b: an empty slot opening this minute does not suppress the nag', () => {
    makeReminder(7) // Early morning unfinished; Morning (09:00) is empty

    // The slot-open path itself has nothing to say at 09:00...
    expect(pendingSlotNotifications(at(9))).toHaveLength(0)
    // ...so the nag is not competing with anything and should speak.
    const [nag] = pendingSlotNags(at(9))
    expect(nag).toMatchObject({ slotLabel: 'Early morning', count: 1 })
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

  /**
   * RN-014: the cap, in isolation. Seeding the row directly is what isolates it:
   * with the default window the gap is 5h, so a naturally-produced third nag
   * leaves no gap-passing hour before sleep, and a sweep-based test could not
   * tell the two gates apart.
   */
  test('RN-014: the daily cap stops the fourth nag', () => {
    makeReminder(7)
    expect(MAX_NAGS_PER_DAY).toBe(3)

    // 21:00: past the 20:30 last slot, so the reserve is lifted, and well past
    // the 5h gap — the cap is the only gate left in question.
    seedNagRow(2, 8)
    expect(pendingSlotNags(at(21))).toHaveLength(1)

    seedNagRow(3, 8)
    expect(pendingSlotNags(at(21))).toHaveLength(0)
  })

  /**
   * RN-014b: the gap, in isolation — one nag spent, cap nowhere near, so only
   * the spacing can be doing the work. The boundary is inclusive: a gap of
   * exactly minNagGapHours is allowed.
   */
  test('RN-014b: a second nag waits for the minimum gap, and fires on it', () => {
    makeReminder(7)
    expect(minNagGapHours('07:00', '22:00')).toBe(5)
    seedNagRow(1, 8)

    expect(pendingSlotNags(at(10))).toHaveLength(0) // 2h — too soon
    expect(pendingSlotNags(at(12))).toHaveLength(0) // 4h — still too soon
    expect(pendingSlotNags(at(13))).toHaveLength(1) // exactly 5h — allowed
    expect(pendingSlotNags(at(14))).toHaveLength(1)
  })

  /**
   * RN-014c: the whole point of the change, as a full day. Before spacing, a
   * missed morning nagged at 08:00, 10:00 and 11:00 and was then silent for
   * eleven hours. The day's three should instead land morning / midday /
   * late-afternoon.
   */
  test('RN-014c: a full default day spreads its three nags across the window', () => {
    makeReminder(7)

    // The third waits for the 20:30 Evening slot rather than going at 18:00.
    expect(firingHours(7, 22)).toEqual([8, 13, 21])
  })

  /**
   * RN-014d: a short window keeps its FULL allowance at tighter spacing rather
   * than losing nags — floor(6h / 3) = 2h, and all three still fit in 09:00-15:00.
   *
   * This is also the case the reserve's guard exists for: the 20:30 Evening slot
   * never opens inside a 09:00-15:00 window, so a reserve held for it could
   * never be spent and would silently cost a nag every single day. The guard
   * sees that the boundary is unreachable and keeps the full allowance.
   */
  test('RN-014d: a short waking window still spends its whole allowance', () => {
    makeReminder(7)
    setWindow('09:00', '15:00')
    expect(minNagGapHours('09:00', '15:00')).toBe(2)

    expect(firingHours(0, 23)).toEqual([9, 11, 13])
  })

  /**
   * RN-014e: a midnight-crossing window derives its gap from the REAL window
   * length (19h), not a negative one — the bug this test exists to prevent is
   * `sleep - wake` going negative and collapsing the gap to the 1h floor.
   */
  test('RN-014e: a midnight-crossing window computes a real gap, not a negative one', () => {
    expect(wakingWindowMinutes('07:00', '02:00')).toBe(19 * 60)
    expect(minNagGapHours('07:00', '02:00')).toBe(6)

    makeReminder(7)
    setWindow('07:00', '02:00')
    seedNagRow(1, 8)

    expect(pendingSlotNags(at(13))).toHaveLength(0) // 5h — under the 6h gap
    expect(pendingSlotNags(at(14))).toHaveLength(1) // 6h — allowed
  })

  /**
   * RN-014g: the reserve, end to end, on the day it exists for.
   *
   * This test previously documented the OPPOSITE: with only the gap rule, a
   * morning miss nagged at 08:00 / 13:00 / 18:00, every one of them about the
   * morning, and the evening never got a nag at all because the allowance was
   * gone by the time the Evening slot opened. Holding one back moves the third
   * nag to 21:00, where it can finally speak for the evening.
   */
  test("RN-014g: a morning miss no longer spends the evening's nag", () => {
    makeReminder(7)
    makeReminder(20, 30)

    expect(firingHours(7, 22)).toEqual([8, 13, 21])

    // ...and, crucially, WHAT each one said: two about the morning, the last
    // about the evening that was still sitting there.
    resetNagRows()
    const said = [8, 13, 21].map((hour) => {
      const [nag] = pendingSlotNags(at(hour))
      recordSlotNag(nag.userId, nag.localDate, nag.localHour)
      return nag.slotLabel
    })
    expect(said).toEqual(['Early morning', 'Early morning', 'Evening'])
  })

  /**
   * RN-014h: the reserve in isolation — two already spent, gap long cleared, so
   * only the reserve can be deciding. Withheld at 18:00, released at 21:00.
   */
  test('RN-014h: the last nag waits for the last slot to open', () => {
    makeReminder(7)
    seedNagRow(2, 8)

    expect(pendingSlotNags(at(18))).toHaveLength(0) // 20:30 has not opened
    expect(pendingSlotNags(at(21))).toHaveLength(1) // it has
  })

  /**
   * RN-014i: the reserve is a floor on when the LAST nag may fire, not a delay
   * on the first. An evening-only miss speaks at the first opportunity.
   */
  test('RN-014i: an evening-only miss nags as soon as it can', () => {
    makeReminder(20, 30)

    expect(firingHours(7, 22)).toEqual([21])
  })

  /**
   * RN-014j: a single configured slot must not deadlock the allowance. It
   * cannot: a nag needs an OPENED unfinished slot, and with one slot "opened"
   * and "the last slot has opened" are the same condition, so the reserve is
   * satisfied whenever a nag is possible at all. No guard needed.
   */
  test('RN-014j: a single-slot configuration still spends its whole allowance', () => {
    getDb().prepare('DELETE FROM time_slots WHERE start_time != ?').run('07:00')
    makeReminder(7)

    expect(firingHours(7, 22)).toEqual([8, 13, 18])
  })

  /**
   * RN-014k: an unspent reserve is the feature working. If the day is clear by
   * the time the last slot opens, the third nag simply never happens — it is
   * not owed, and nothing releases it early.
   */
  test('RN-014k: the reserved nag never fires when nothing is left undone', () => {
    const reminder = makeReminder(7)

    expect(firingHours(7, 19)).toEqual([8, 13])

    markDone({ userId: TEST_USER_ID, userTimezone: TEST_TIMEZONE, taskId: reminder.id })

    expect(firingHours(20, 22)).toEqual([])
    const row = getDb()
      .prepare('SELECT sent_count FROM slot_nags WHERE user_id = ? AND local_date = ?')
      .get(TEST_USER_ID, '2026-01-15') as { sent_count: number }
    expect(row.sent_count).toBe(2)
  })

  /** RN-014f: the window length and the derived gap, across the shapes. */
  test('RN-014f: the gap is derived from the waking window', () => {
    expect(wakingWindowMinutes('07:00', '22:00')).toBe(15 * 60)
    expect(minNagGapHours('07:00', '22:00')).toBe(5)

    // Uneven division floors rather than rounding up.
    expect(minNagGapHours('07:00', '22:30')).toBe(5)
    expect(minNagGapHours('00:00', '23:00')).toBe(7)

    // A degenerately short window still gets a 1h floor, never 0.
    expect(minNagGapHours('09:00', '10:00')).toBe(1)
    expect(minNagGapHours('09:00', '09:30')).toBe(1)

    // wake == sleep reads as all day, matching isAwake.
    expect(wakingWindowMinutes('07:00', '07:00')).toBe(24 * 60)
    expect(minNagGapHours('07:00', '07:00')).toBe(8)

    // Malformed times never fire anyway; a full day is the safe answer.
    expect(wakingWindowMinutes('nonsense', '22:00')).toBeNull()
    expect(minNagGapHours('nonsense', '22:00')).toBe(24)
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
    // 13:00 rather than 10:00 because the 5h spacing gate also has to clear.
    expect(sweep(at(13))).toHaveLength(1)
  })

  /** RN-016: both gates are per LOCAL day, so a new day starts fresh. */
  test('RN-016: the allowance resets on the next local day', () => {
    makeReminder(7)

    expect(firingHours(7, 22)).toEqual([8, 13, 21])

    // Next local day: the cap is clear again, and so is the gap — 08:00 the
    // following morning is not measured against 21:00 the night before.
    vi.setSystemTime(at(8, 0, 16))
    expect(firingHours(7, 22, 16)).toEqual([8, 13, 21])
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
