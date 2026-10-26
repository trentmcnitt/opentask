/**
 * The every-N grid (Trent, 2026-10-12; docs/TASK-MODEL.md § Recurrence Model).
 *
 * An "every N" rule (INTERVAL > 1) runs on a grid anchored at the task's own
 * occurrence (`occurrence_at`, which starts at its first date), not at the
 * 2020 epoch. The golden suite found the old bug: every 22 days, first target
 * Nov 3 → it came again Nov 13 (the epoch grid's next day), not Nov 25.
 *
 * INTERVAL=1 rules that pin their day, and calls with no anchor, are
 * unchanged (the epoch). A bare rule with no day (FREQ=WEEKLY) follows its
 * anchor too since the creation-day ruling (rd-creation-day.test.ts).
 * Every date is a LOCAL time in America/Chicago.
 */
import { CALENDAR_DAY_START, openTaskDaySpan } from '@/lib/opentask-day'
import { describe, test, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { DateTime } from 'luxon'
import { RRule } from 'rrule'
import { getDb } from '@/core/db'
import { createTask, markDone } from '@/core/tasks'
import { skipOccurrence } from '@/core/tasks/skip'
import { snoozeTask } from '@/core/tasks/snooze'
import { computeNextOccurrence } from '@/core/recurrence'
import { advanceDtstart } from '@/core/recurrence/compute-next'
import { todaysOccurrence } from '@/core/recurrence/occurrence'
import { nextScheduledOccurrence } from '@/lib/snooze-guard'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

const tz = TEST_TIMEZONE
function at(local: string): string {
  return DateTime.fromISO(local, { zone: tz }).toUTC().toISO()!
}
function local(iso: string | Date | null): string {
  const d = typeof iso === 'string' ? DateTime.fromISO(iso) : DateTime.fromJSDate(iso as Date)
  return d.setZone(tz).toFormat("yyyy-MM-dd'T'HH:mm")
}

/** The next occurrence after `occurrence` (done on its day), on its own grid or (anchor null) the epoch's. */
function next(rrule: string, occurrence: string, anchored = true): string {
  const occ = new Date(at(occurrence))
  return local(
    computeNextOccurrence({
      rrule,
      recurrenceMode: 'from_due',
      anchorTime: null,
      timezone: tz,
      completedAt: occ,
      prevDueAt: occ,
      anchorAt: anchored ? occ : null,
    }),
  )
}

describe('RD-GRID: an every-N rule runs on its own grid', () => {
  test('RD-GRID-001: every 22 days, first Nov 3 → Nov 25 → Dec 17 (was Nov 13 off the epoch grid)', () => {
    const rule = 'FREQ=DAILY;INTERVAL=22;BYHOUR=9;BYMINUTE=0'
    expect(next(rule, '2026-11-03T09:00', false)).toBe('2026-11-13T09:00') // the bug
    expect(next(rule, '2026-11-03T09:00')).toBe('2026-11-25T09:00')
    expect(next(rule, '2026-11-25T09:00')).toBe('2026-12-17T09:00')
  })

  test('RD-GRID-002: every 2 weeks on Monday, first an off-epoch-grid Monday → two weeks on', () => {
    const rule = 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;BYHOUR=9;BYMINUTE=0'
    // Mon Nov 2 2026 is on the epoch's OFF week: the old answer was a week on.
    expect(next(rule, '2026-11-02T09:00', false)).toBe('2026-11-09T09:00')
    expect(next(rule, '2026-11-02T09:00')).toBe('2026-11-16T09:00')
    expect(next(rule, '2026-11-16T09:00')).toBe('2026-11-30T09:00')
    // An on-grid Monday (Oct 26) answers the same either way.
    expect(next(rule, '2026-10-26T09:00')).toBe(next(rule, '2026-10-26T09:00', false))
  })

  test('RD-GRID-003: every 2 weeks on Mon+Thu: both days of the anchor week, then two weeks on', () => {
    const rule = 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;BYHOUR=9;BYMINUTE=0'
    expect(next(rule, '2026-11-02T09:00')).toBe('2026-11-05T09:00')
    // Thu Nov 5 is an occurrence of the same grid (its week starts Mon Nov 2).
    expect(next(rule, '2026-11-05T09:00')).toBe('2026-11-16T09:00')
  })

  test('RD-GRID-004: every 3 months on the 15th, first Nov 15 → Feb 15, May 15 (the epoch said Jan 15)', () => {
    const rule = 'FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=15;BYHOUR=9;BYMINUTE=0'
    expect(next(rule, '2026-11-15T09:00', false)).toBe('2027-01-15T09:00')
    expect(next(rule, '2026-11-15T09:00')).toBe('2027-02-15T09:00')
    expect(next(rule, '2027-02-15T09:00')).toBe('2027-05-15T09:00')
  })

  test('RD-GRID-005: every 2 months on the 31st skips months without one, on the anchor phase', () => {
    const rule = 'FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=31;BYHOUR=9;BYMINUTE=0'
    // Grid from Aug 31 2026: Oct 31, Dec 31, (Feb — none), (Apr — none), …
    expect(next(rule, '2026-08-31T09:00')).toBe('2026-10-31T09:00')
    expect(next(rule, '2026-12-31T09:00')).toBe('2027-08-31T09:00')
  })

  test('RD-GRID-006: across both DST changes the local time holds and the grid holds', () => {
    const rule = 'FREQ=DAILY;INTERVAL=22;BYHOUR=9;BYMINUTE=0'
    // Fall back Sun Nov 1 2026: Oct 20 CDT → Nov 11 CST, still 9 AM.
    expect(next(rule, '2026-10-20T09:00')).toBe('2026-11-11T09:00')
    expect(at('2026-11-11T09:00')).toBe('2026-11-11T15:00:00.000Z')
    // Spring forward Sun Mar 14 2027: Mar 1 CST → Mar 23 CDT, still 9 AM.
    expect(next(rule, '2027-03-01T09:00')).toBe('2027-03-23T09:00')
    expect(at('2027-03-23T09:00')).toBe('2027-03-23T14:00:00.000Z')
    const fortnightly = 'FREQ=WEEKLY;INTERVAL=2;BYDAY=SU;BYHOUR=9;BYMINUTE=0'
    expect(next(fortnightly, '2027-03-07T09:00')).toBe('2027-03-21T09:00')
  })

  test('RD-GRID-007: done late (past several grid days) → the next grid day after now, no catch-up', () => {
    const rule = 'FREQ=DAILY;INTERVAL=22;BYHOUR=9;BYMINUTE=0'
    const occ = new Date(at('2026-11-03T09:00'))
    const r = computeNextOccurrence({
      rrule: rule,
      recurrenceMode: 'from_due',
      anchorTime: null,
      timezone: tz,
      completedAt: new Date(at('2027-01-01T12:00')),
      prevDueAt: occ,
      anchorAt: occ,
    })
    // Nov 3 + 22k: Nov 25, Dec 17, Jan 8.
    expect(local(r)).toBe('2027-01-08T09:00')
  })

  test('RD-GRID-008: from_completion is untouched by the anchor', () => {
    const occ = new Date(at('2026-11-03T09:00'))
    const opts = {
      rrule: 'FREQ=DAILY;INTERVAL=22;BYHOUR=9;BYMINUTE=0',
      recurrenceMode: 'from_completion' as const,
      anchorTime: null,
      timezone: tz,
      completedAt: new Date(at('2026-11-05T20:00')),
      prevDueAt: occ,
      dayStart: CALENDAR_DAY_START,
    }
    expect(local(computeNextOccurrence({ ...opts, anchorAt: occ }))).toBe('2026-11-27T09:00')
    expect(computeNextOccurrence({ ...opts, anchorAt: occ })).toEqual(computeNextOccurrence(opts))
  })
})

describe('RD-GRID: an INTERVAL=1 rule that pins its phase is exactly as before (regression)', () => {
  // A bare FREQ=WEEKLY / MONTHLY / YEARLY (no day) is NOT here: since the
  // creation-day ruling (2026-10-12) it takes its day from its own anchor —
  // RD-GRID-011 and tests/behavioral/rd-creation-day.test.ts.
  const RULES = [
    'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    'FREQ=DAILY',
    'FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=7;BYMINUTE=30',
    'FREQ=MONTHLY;BYMONTHDAY=15;BYHOUR=12;BYMINUTE=0',
    'FREQ=MONTHLY;BYMONTHDAY=-1;BYHOUR=9;BYMINUTE=0',
    'FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1;BYHOUR=17;BYMINUTE=0',
    'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0',
  ]
  test('RD-GRID-010: an anchor changes nothing for a pinned INTERVAL=1 rule', () => {
    const anchors = ['2026-11-03T09:00', '2025-02-28T23:30', '2027-07-31T06:15']
    let checked = 0
    for (const rrule of RULES) {
      for (
        let t = Date.UTC(2026, 0, 3, 5);
        t < Date.UTC(2028, 0, 1);
        t += (9 * 24 + 7) * 3_600_000
      ) {
        const ref = new Date(t)
        const base = {
          rrule,
          recurrenceMode: 'from_due' as const,
          anchorTime: null,
          timezone: tz,
          completedAt: ref,
          prevDueAt: ref,
        }
        const plain = computeNextOccurrence(base).toISOString()
        for (const a of anchors) {
          expect(computeNextOccurrence({ ...base, anchorAt: new Date(at(a)) }).toISOString()).toBe(
            plain,
          )
          checked++
        }
      }
    }
    expect(checked).toBeGreaterThan(1000)
  })

  test('RD-GRID-011: a bare rule (no day) follows its anchor; without one, the epoch as before', () => {
    // Anchored on a Sunday: weekly → Sundays; monthly → the 11th; yearly → Oct 11.
    expect(next('FREQ=WEEKLY;BYHOUR=18;BYMINUTE=0', '2026-10-11T18:00')).toBe('2026-10-18T18:00')
    expect(next('FREQ=MONTHLY;BYHOUR=18;BYMINUTE=0', '2026-10-11T18:00')).toBe('2026-11-11T18:00')
    expect(next('FREQ=YEARLY;BYHOUR=18;BYMINUTE=0', '2026-10-11T18:00')).toBe('2027-10-11T18:00')
    // No anchor: the epoch's Wednesday, the 1st, Jan 1 — unchanged.
    expect(next('FREQ=WEEKLY;BYHOUR=18;BYMINUTE=0', '2026-10-11T18:00', false)).toBe(
      '2026-10-14T18:00',
    )
    expect(next('FREQ=MONTHLY;BYHOUR=18;BYMINUTE=0', '2026-10-11T18:00', false)).toBe(
      '2026-11-01T18:00',
    )
    expect(next('FREQ=YEARLY;BYHOUR=18;BYMINUTE=0', '2026-10-11T18:00', false)).toBe(
      '2027-01-01T18:00',
    )
  })
})

describe('RD-GRID: advanceDtstart from an arbitrary anchor keeps parity', () => {
  const FREQ = {
    DAILY: RRule.DAILY,
    WEEKLY: RRule.WEEKLY,
    MONTHLY: RRule.MONTHLY,
    YEARLY: RRule.YEARLY,
  }
  const SHAPES: Array<{
    freq: keyof typeof FREQ
    interval: number
    base: string
    bymonthday?: number[]
  }> = [
    { freq: 'DAILY', interval: 22, base: '2023-11-03T09:00:00Z' },
    { freq: 'WEEKLY', interval: 2, base: '2023-11-08T09:00:00Z' },
    { freq: 'MONTHLY', interval: 2, base: '2023-01-31T09:00:00Z' }, // a 31st, no BYMONTHDAY
    { freq: 'MONTHLY', interval: 3, base: '2023-08-31T09:00:00Z', bymonthday: [31] },
    { freq: 'MONTHLY', interval: 1, base: '2023-03-30T09:00:00Z' }, // lands in Feb
    { freq: 'YEARLY', interval: 1, base: '2024-02-29T09:00:00Z' }, // a leap day
    { freq: 'YEARLY', interval: 2, base: '2024-02-29T09:00:00Z' },
  ]
  for (const shape of SHAPES) {
    test(`RD-GRID-020: ${shape.freq} INTERVAL=${shape.interval} from ${shape.base}`, () => {
      const base = new Date(shape.base)
      const mk = (dtstart: Date) =>
        new RRule({
          freq: FREQ[shape.freq],
          interval: shape.interval,
          dtstart,
          bymonthday: shape.bymonthday,
        })
      const slow = mk(base)
      // From the anchor on (before it, the slow rule has no occurrences at all
      // — that side is RD-GRID-021's).
      for (let t = base.getTime(); t < Date.UTC(2032, 0, 1); t += 37 * 86_400_000 + 3_600_000) {
        const ref = new Date(t)
        const advanced = advanceDtstart(base, shape.freq, shape.interval, ref, true)
        if (shape.freq === 'MONTHLY' || shape.freq === 'YEARLY') {
          expect(advanced.getUTCDate()).toBe(base.getUTCDate())
        } else if (shape.freq === 'WEEKLY') {
          expect(advanced.getUTCDay()).toBe(base.getUTCDay())
        }
        expect(advanced.getTime()).toBeLessThanOrEqual(ref.getTime())
        expect(mk(advanced).after(ref)?.toISOString()).toBe(slow.after(ref)?.toISOString())
      }
    }, 20_000)
  }

  test('RD-GRID-021: rewind moves an anchor after the reference back onto the same grid', () => {
    const base = new Date('2030-11-03T09:00:00Z')
    const ref = new Date('2026-10-01T00:00:00Z')
    const back = advanceDtstart(base, 'DAILY', 22, ref, true)
    expect(back.getTime()).toBeLessThan(ref.getTime())
    expect((base.getTime() - back.getTime()) % (22 * 86_400_000)).toBe(0)
    // Without rewind (the epoch), never moved back.
    expect(advanceDtstart(base, 'DAILY', 22, ref)).toEqual(base)
  })
})

describe('RD-GRID: the writers and readers agree on the grid', () => {
  beforeAll(() => setupTestDb())
  afterAll(() => teardownTestDb())
  beforeEach(() => {
    getDb().prepare('DELETE FROM completions').run()
    getDb().prepare('DELETE FROM tasks').run()
    getDb().prepare('DELETE FROM undo_log').run()
    vi.setSystemTime(new Date(at('2026-10-12T10:00')))
  })
  afterEach(() => vi.useRealTimers())

  const u = { userId: TEST_USER_ID, userTimezone: tz }
  function make(input: Record<string, unknown>) {
    return createTask({ ...u, input: { title: 'Task', ...input } })
  }

  test('RD-GRID-030: a deadline-anchored every-22-days: Nov 4 → Nov 26 → Dec 18, the target the day before', () => {
    // 2026-10-21: the rule walks the DEADLINE (17:00); the target sent with it
    // gives the offset (1 day before, 09:00).
    const t = make({
      rrule: 'FREQ=DAILY;INTERVAL=22;BYHOUR=17;BYMINUTE=0',
      due_at: at('2026-11-03T09:00'),
      deadline_at: at('2026-11-04T17:00'),
    })
    expect(t.occurrence_at).toBe(at('2026-11-04T17:00'))
    expect(t.due_at).toBe(at('2026-11-03T09:00'))
    vi.setSystemTime(new Date(at('2026-11-03T21:00')))
    const a = markDone({ ...u, taskId: t.id }).task
    expect(local(a.occurrence_at)).toBe('2026-11-26T17:00')
    expect(local(a.deadline_at)).toBe('2026-11-26T17:00')
    expect(local(a.due_at)).toBe('2026-11-25T09:00')
    vi.setSystemTime(new Date(at('2026-11-25T21:00')))
    const b = markDone({ ...u, taskId: t.id }).task
    expect(local(b.occurrence_at)).toBe('2026-12-18T17:00')
    expect(local(b.due_at)).toBe('2026-12-17T09:00')
  })

  test('RD-GRID-031: done early from a moved target → the grid, not the moved target, decides', () => {
    const t = make({
      rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;BYHOUR=9;BYMINUTE=0',
      due_at: at('2026-11-02T09:00'),
    })
    // Move the target to Wed Nov 4: the occurrence stays Mon Nov 2.
    snoozeTask({ ...u, taskId: t.id, until: at('2026-11-04T09:00') })
    vi.setSystemTime(new Date(at('2026-11-04T12:00')))
    const r = markDone({ ...u, taskId: t.id }).task
    expect(local(r.occurrence_at)).toBe('2026-11-16T09:00')
  })

  test('RD-GRID-032: skip advances on the same grid', () => {
    const t = make({
      rrule: 'FREQ=DAILY;INTERVAL=22;BYHOUR=9;BYMINUTE=0',
      due_at: at('2026-11-03T09:00'),
    })
    const r = skipOccurrence({ ...u, taskId: t.id }).task
    expect(local(r.occurrence_at)).toBe('2026-11-25T09:00')
    expect(local(r.due_at)).toBe('2026-11-25T09:00')
  })

  test('RD-GRID-033: the snooze guard reads the grid from the occurrence, not a moved target', () => {
    const task = {
      rrule: 'FREQ=DAILY;INTERVAL=22;BYHOUR=9;BYMINUTE=0',
      recurrence_mode: 'from_due' as const,
      anchor_time: '09:00',
      due_at: at('2026-11-06T09:00'), // moved from Nov 3
      occurrence_at: at('2026-11-03T09:00'),
    }
    expect(local(nextScheduledOccurrence(task, tz))).toBe('2026-11-25T09:00')
  })

  test("RD-GRID-034: a reminder's today follows its own grid, even with the occurrence ahead", () => {
    const reminder = {
      rrule: 'FREQ=DAILY;INTERVAL=3;BYHOUR=8;BYMINUTE=0',
      recurrence_mode: 'from_due' as const,
      anchor_time: '08:00',
      due_at: at('2026-11-09T08:00'),
      occurrence_at: at('2026-11-09T08:00'),
    }
    // Grid: … Nov 3, Nov 6, Nov 9 …
    const on = (day: string) =>
      todaysOccurrence(
        reminder,
        tz,
        openTaskDaySpan(new Date(at(`${day}T12:00`)), tz, CALENDAR_DAY_START),
      )
    expect(local(on('2026-11-06'))).toBe('2026-11-06T08:00')
    expect(on('2026-11-07')).toBeNull()
    expect(on('2026-11-08')).toBeNull()
    expect(local(on('2026-11-09'))).toBe('2026-11-09T08:00')
    expect(local(on('2026-11-12'))).toBe('2026-11-12T08:00')
  })

  test('RD-GRID-035: stored dates are never rewritten — only the next advance uses the grid', () => {
    const t = make({
      rrule: 'FREQ=DAILY;INTERVAL=22;BYHOUR=9;BYMINUTE=0',
      due_at: at('2026-11-03T09:00'),
    })
    const row = getDb()
      .prepare('SELECT due_at, occurrence_at FROM tasks WHERE id = ?')
      .get(t.id) as { due_at: string; occurrence_at: string }
    expect(row).toEqual({ due_at: at('2026-11-03T09:00'), occurrence_at: at('2026-11-03T09:00') })
  })
})
