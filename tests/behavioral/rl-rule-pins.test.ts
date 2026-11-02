/**
 * RL-: PINS FOR THE RULES MAP (2026-10-30; src/lib/rule-registry.ts) — the
 * rules that had no test of their own, pinned on the pure functions that are
 * their homes. No database.
 *
 * A pin of CURRENT behaviour on an OPEN issue says so in its title ("current
 * behaviour, I-xx open"): when Trent rules on that issue and the code changes
 * on purpose, editing that test is expected, not a regression.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { DateTime } from 'luxon'
import { isOverdue } from '@/lib/task-counts'
import { effectiveDueAt, isCurrentlyDue, type OccurrenceTask } from '@/core/recurrence/occurrence'
import {
  attemptsOffer,
  capsAt,
  deckIsToday,
  effectiveHorizon,
  isPastDeadline,
  offersDeferAll,
  queueRowState,
  setHorizonOrUnset,
  type SegmentKind,
} from '@/lib/task-segments'
import { deckTapDay } from '@/lib/deck-menu'
import { agedOutGroup, cutoffWords, growStep } from '@/lib/aged-out'
import { listedSegments, mergePulled, type SegmentView } from '@/hooks/useTaskSegments'
import { withoutRuleOnDeadline } from '@/core/ai/enrichment'
import type { EnrichmentResult } from '@/core/ai/types'
import { PULLED, PULLED_DAYS } from '@/lib/modes/sections'
import { nextTargetDayFirst } from '@/lib/target-day-first'
import { localMoment, addDays, openTaskDayOf } from '@/lib/opentask-day'
import { HIGH_PRIORITY_THRESHOLD, URGENT_PRIORITY } from '@/lib/priority'
import { interruptionLevelFor } from '@/core/notifications/format'
import type { Task } from '@/types'

const TZ = 'America/Chicago'
const DAY_START = '03:00'
/** Wed 2026-10-28, noon in Chicago. */
const NOW = new Date('2026-10-28T17:00:00.000Z')
const at = (local: string) => DateTime.fromISO(local, { zone: TZ }).toUTC().toISO()!
const plus = (ms: number) => new Date(NOW.getTime() + ms).toISOString()

beforeEach(() => {
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

const countable = (due_at: string | null) =>
  ({ due_at, progress_target: 1, is_tracked: false }) as Pick<
    Task,
    'due_at' | 'progress_target' | 'is_tracked'
  >

describe('RL: overdue — the client and the server', () => {
  test('RL-TGT-OVERDUE-CLIENT: isOverdue is strict — a target AT now is not overdue, 1 ms later it is (current behaviour, boundary issue I-03 open)', () => {
    expect(isOverdue(countable(NOW.toISOString()), NOW)).toBe(false)
    expect(isOverdue(countable(plus(-1)), NOW)).toBe(true)
    expect(isOverdue(countable(plus(1)), NOW)).toBe(false)
    expect(isOverdue(countable(null), NOW)).toBe(false)
  })

  test('RL-TGT-OVERDUE: isCurrentlyDue is <= now; a target-anchored from_due repeat with no target is due from today’s occurrence; a deadline-anchored one and a target-less deck are never due (current behaviour, boundary issue I-03 open)', () => {
    const oneOff: OccurrenceTask = { due_at: NOW.toISOString(), rrule: null, anchor_time: null }
    expect(isCurrentlyDue(oneOff, TZ, DAY_START, NOW)).toBe(true)
    expect(isCurrentlyDue({ ...oneOff, due_at: plus(1) }, TZ, DAY_START, NOW)).toBe(false)

    const daily: OccurrenceTask = {
      due_at: null,
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      recurrence_mode: 'from_due',
      anchor_time: '09:00',
      repeat_anchor: 'target',
    }
    expect(effectiveDueAt(daily, TZ, DAY_START, NOW)?.toISOString()).toBe(at('2026-10-28T09:00:00'))
    expect(isCurrentlyDue(daily, TZ, DAY_START, NOW)).toBe(true)

    expect(effectiveDueAt({ ...daily, repeat_anchor: 'deadline' }, TZ, DAY_START, NOW)).toBeNull()
    expect(effectiveDueAt({ ...daily, on_deck_day: '2026-10-28' }, TZ, DAY_START, NOW)).toBeNull()
    expect(
      effectiveDueAt({ ...oneOff, due_at: null, on_deck_day: '2026-10-28' }, TZ, DAY_START, NOW),
    ).toBeNull()
  })
})

describe('RL: the deadline cap and the passed marker', () => {
  test('RL-DL-CAP-BOUNDARY: a deadline exactly AT now caps nothing and is not yet passed (current behaviour, boundary issue I-04 open)', () => {
    const later = plus(60_000)
    expect(capsAt(later, NOW.toISOString(), NOW)).toBe(false)
    expect(isPastDeadline(NOW.toISOString(), NOW)).toBe(false)
    // One millisecond either side.
    expect(capsAt(later, plus(1), NOW)).toBe(true)
    expect(isPastDeadline(plus(-1), NOW)).toBe(true)
  })

  test('RL-TGT-ATTEMPTS-OFFER: a High one-off with a passed deadline at 3× — Remove target with the queue on, nothing off (current behaviour, I-05 open)', () => {
    const task = {
      due_at: plus(-3 * 86_400_000),
      deadline_at: plus(-86_400_000),
      target_auto: false,
      rrule: null,
      attempts: 3,
      priority: HIGH_PRIORITY_THRESHOLD,
    }
    expect(attemptsOffer(task, NOW, { queue: true })).toBe('remove')
    expect(attemptsOffer(task, NOW)).toBeNull()
    expect(attemptsOffer({ ...task, attempts: 2 }, NOW, { queue: true })).toBeNull()
  })
})

describe('RL: segments on the web', () => {
  const row = (id: number, state: 'waiting' | 'considered' = 'waiting') => ({
    task: { id } as Task,
    state,
    recurring: false,
  })
  const view = (horizon: SegmentKind, rows: ReturnType<typeof row>[]): SegmentView => ({
    horizon,
    rows,
    waiting: rows.filter((r) => r.state === 'waiting').length,
    considered: rows.filter((r) => r.state === 'considered').length,
    deferred: 0,
    nudge: false,
  })

  test('RL-SEG-VISIBLE-WEB: listedSegments drops a kind with no rows and keeps one that is all considered, in order', () => {
    const views = [
      view('deadlines', []),
      view('upcoming', [row(1, 'considered')]),
      view('days', [row(2)]),
      view('weeks', []),
    ]
    expect(listedSegments(views).map((v) => v.horizon)).toEqual(['upcoming', 'days'])
  })

  test('RL-SEG-PULLED-MERGE: the two queue panels become one view in queue_today’s place, counts summed', () => {
    const merged = mergePulled([
      view('deadlines', [row(1)]),
      view('queue_today', [row(2)]),
      view('queue_previous', [row(3), row(4, 'considered')]),
      view('days', [row(5)]),
    ])
    expect(merged.map((v) => v.horizon)).toEqual(['deadlines', 'queue_today', 'days'])
    const pulled = merged[1]
    expect(pulled.pulled).toBe(true)
    expect(pulled.rows.map((r) => [r.task.id, r.pulled])).toEqual([
      [2, 'today'],
      [3, 'earlier'],
      [4, 'earlier'],
    ])
    expect([pulled.waiting, pulled.considered]).toEqual([2, 1])
  })

  test('RL-SEG-NOT-TODAY: "Not today, all" on every segment but the queue panels and the deadlines page', () => {
    const offered = (
      [
        'deadlines',
        'upcoming',
        'queue_today',
        'queue_previous',
        'days',
        'weeks',
        'months',
        'eventually',
        'aged_out',
      ] as SegmentKind[]
    ).filter(offersDeferAll)
    expect(offered).toEqual(['upcoming', 'days', 'weeks', 'months', 'eventually', 'aged_out'])
  })

  test('RL-SEG-ROW-STATE: considered today, else deferred today ("Not today"), else waiting — OpenTask days', () => {
    const today = NOW.toISOString()
    const yesterday = plus(-86_400_000)
    const state = (last_considered_at: string | null, segment_deferred_at: string | null) =>
      queueRowState({ last_considered_at, segment_deferred_at }, TZ, NOW, DAY_START)
    expect(state(null, today)).toBe('deferred')
    expect(state(today, today)).toBe('considered')
    expect(state(yesterday, yesterday)).toBe('waiting')
    // 01:30 on Thursday is still Wednesday's OpenTask day with a 3:00 AM start.
    const lateNight = new Date(at('2026-10-29T01:30:00'))
    expect(
      queueRowState(
        { last_considered_at: null, segment_deferred_at: today },
        TZ,
        lateNight,
        DAY_START,
      ),
    ).toBe('deferred')
  })

  test('RL-TQ-PANEL-PULLED: Scan’s Pulled takes a pull from the last 14 OpenTask days, today included, and not the 15th (current behaviour, I-37 open)', () => {
    const ctx = { now: NOW, timezone: TZ, dayStart: DAY_START }
    const pulledOn = (daysAgo: number) =>
      ({
        queued_at: plus(-daysAgo * 86_400_000),
        queued_from_due_at: plus(-(daysAgo + 1) * 86_400_000),
        queued_from_deck_day: null,
      }) as Task
    expect(PULLED_DAYS).toBe(14)
    expect(PULLED.match(pulledOn(0), ctx)).toBe(true)
    expect(PULLED.match(pulledOn(14), ctx)).toBe(true)
    expect(PULLED.match(pulledOn(15), ctx)).toBe(false)
    // Queued with nothing remembered is no pull.
    expect(PULLED.match({ ...pulledOn(0), queued_from_due_at: null } as Task, ctx)).toBe(false)
  })
})

describe('RL: decks', () => {
  test('RL-DECK-TODAY: deckTapDay takes a deck off exactly when deckIsToday says it is today’s, across midnight and the 3:00 day start', () => {
    const moments = ['2026-10-28T23:30', '2026-10-29T00:30', '2026-10-29T02:59', '2026-10-29T03:00']
    for (const local of moments) {
      const now = new Date(at(local))
      const today = openTaskDayOf(now, TZ, DAY_START)
      for (const day of [addDays(today, -1), today, addDays(today, 1), null]) {
        const task = { on_deck_day: day }
        const tap = deckTapDay(task, TZ, now, DAY_START)
        expect(tap === null, `${local} deck ${day}`).toBe(deckIsToday(task, TZ, now, DAY_START))
        if (tap !== null) expect(tap).toBeUndefined()
      }
    }
  })
})

describe('RL: horizons', () => {
  test('RL-HZ-UNSET: unset reads as Weeks in every rule — grow, the cutoff words, the Aged out group, the effective horizon', () => {
    expect(setHorizonOrUnset(null)).toBe('weeks')
    expect(growStep(null)).toBe(growStep('weeks'))
    expect(cutoffWords(null)).toBe(cutoffWords('weeks'))
    expect(agedOutGroup(null)).toBe(agedOutGroup('weeks'))
    expect(effectiveHorizon({ horizon: null, deadline_at: null }, NOW)).toBe(
      effectiveHorizon({ horizon: 'weeks', deadline_at: null }, NOW),
    )
    // Any other stored value reads as unset too.
    expect(setHorizonOrUnset('fortnights')).toBe('weeks')
  })
})

describe('RL: enrichment and deadlines', () => {
  test('RL-DL-ENRICH: a rule the model gives a task with a deadline is dropped; without one it stays', () => {
    const answer = { rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0' } as EnrichmentResult
    const withDeadline = {
      id: 1,
      rrule: null,
      deadline_at: plus(5 * 86_400_000),
      repeat_anchor: 'target',
    } as Task
    expect(withoutRuleOnDeadline(withDeadline, answer).rrule).toBeNull()
    const without = { ...withDeadline, deadline_at: null } as Task
    expect(withoutRuleOnDeadline(without, answer).rrule).toBe(answer.rrule)
  })
})

describe('RL: the day', () => {
  test('RL-TGT-DAY-FIRST: a move within the OpenTask day keeps the day’s first target; a move to another day resets it', () => {
    const nine = at('2026-10-28T09:00:00')
    const two = at('2026-10-28T14:00:00')
    const tomorrow = at('2026-10-29T09:00:00')
    expect(nextTargetDayFirst(nine, null, two, TZ, DAY_START)).toBe(nine)
    expect(nextTargetDayFirst(nine, nine, tomorrow, TZ, DAY_START)).toBe(tomorrow)
    expect(nextTargetDayFirst(null, null, two, TZ, DAY_START)).toBe(two)
    expect(nextTargetDayFirst(nine, nine, null, TZ, DAY_START)).toBeNull()
  })

  test('RL-LOCAL-MOMENT-DST: a time the spring-forward gap skips is the next valid minute; a repeated fall-back time is its first instant', () => {
    // Chicago, 2026-03-08: 02:00 → 03:00.
    expect(localMoment('2026-03-08', '02:30', TZ).toISOString()).toBe('2026-03-08T08:00:00.000Z')
    // Chicago, 2026-11-01: 01:00–01:59 happens twice; the first is CDT (UTC−5).
    expect(localMoment('2026-11-01', '01:30', TZ).toISOString()).toBe('2026-11-01T06:30:00.000Z')
  })
})

describe('RL: priority and delivery', () => {
  test('RL-PRIO-THRESHOLDS: High is 3 and Urgent 4', () => {
    expect(HIGH_PRIORITY_THRESHOLD).toBe(3)
    expect(URGENT_PRIORITY).toBe(4)
  })

  test('RL-INTERRUPTION-LEVEL: only Urgent is critical; High and below are active', () => {
    expect(interruptionLevelFor(4)).toBe('critical')
    expect([0, 1, 2, 3].map(interruptionLevelFor)).toEqual(['active', 'active', 'active', 'active'])
  })
})
