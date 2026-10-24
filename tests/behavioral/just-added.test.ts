/**
 * Just now (`src/lib/just-added.ts`): for 15 minutes after a task is created
 * — or targeted from a task segment (`segment_targeted_at`) — it is listed in
 * the dashboard's Just now card, newest event first, with which event and how
 * long ago. Pure selection logic, frozen clock.
 */
import { CALENDAR_DAY_START } from '@/lib/opentask-day'
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  JUST_ADDED_WINDOW_MS,
  deckTagLabel,
  formatJustAddedAge,
  formatJustAddedLabel,
  isDeckUpdate,
  isJustAdded,
  justAddedEntryKey,
  justAddedEvent,
  justAddedTag,
  nextJustAddedExpiry,
  nextJustAddedTick,
  selectJustAddedEntries,
} from '@/lib/just-added'
import type { Task } from '@/types'

// Jan 15, 2026 at 10am Chicago.
const NOW = new Date('2026-01-15T16:00:00Z').getTime()
const MIN = 60 * 1000
const HOUR = 60 * MIN

function ago(ms: number): string {
  return new Date(NOW - ms).toISOString()
}

function makeTask(overrides: Partial<Task> & { id: number; created_at: string }): Task {
  return {
    user_id: 1,
    project_id: 1,
    title: `Task ${overrides.id}`,
    done: false,
    done_at: null,
    progress_target: 1,
    is_reminder: false,
    is_tracked: false,
    progress_period_start: null,
    quota_prompt_config: null,
    quota_day_state: null,
    progress_current: 0,
    skip_count: 0,
    priority: 0,
    due_at: null,
    rrule: null,
    recurrence_mode: 'from_due',
    anchor_time: null,
    anchor_dow: null,
    anchor_dom: null,
    repeat_anchor: null,
    target_days_before: null,
    target_time: null,
    target_slot_id: null,
    repeat_count: null,
    repeat_count_used: 0,
    repeat_until: null,
    original_title: null,
    short_title: null,
    original_due_at: null,
    deadline_at: null,
    horizon: null,
    horizon_set_at: null,
    last_considered_at: null,
    segment_deferred_at: null,
    segment_targeted_at: null,
    target_set_at: null,
    occurrence_at: null,
    attempts: 0,
    attempts_counted_through: null,
    growth_kept_at: null,
    queue_mark: false,
    try_tomorrow: false,
    queued_at: null,
    queued_from_due_at: null,
    rolled_over_at: null,
    on_deck_day: null,
    queued_from_deck_day: null,
    lead_days: null,
    lead_from: null,
    target_auto: false,
    last_notified_at: null,
    last_critical_alert_at: null,
    auto_snooze_minutes: null,
    deleted_at: null,
    archived_at: null,
    labels: [],
    completion_count: 0,
    first_completed_at: null,
    last_completed_at: null,
    notes: null,
    updated_at: overrides.created_at,
    ...overrides,
  }
}

beforeEach(() => {
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('isJustAdded', () => {
  test('the window is 15 minutes, and exactly 15 minutes old is out', () => {
    expect(isJustAdded(makeTask({ id: 1, created_at: ago(0) }), NOW)).toBe(true)
    expect(isJustAdded(makeTask({ id: 1, created_at: ago(14 * MIN + 59_000) }), NOW)).toBe(true)
    expect(isJustAdded(makeTask({ id: 1, created_at: ago(15 * MIN) }), NOW)).toBe(false)
    expect(isJustAdded(makeTask({ id: 1, created_at: ago(HOUR) }), NOW)).toBe(false)
  })

  test('a created_at a little ahead of this clock (server/client skew) is in', () => {
    expect(isJustAdded(makeTask({ id: 1, created_at: ago(-5000) }), NOW)).toBe(true)
  })

  test('an unparseable created_at is never pinned', () => {
    expect(isJustAdded(makeTask({ id: 1, created_at: 'garbage' }), NOW)).toBe(false)
  })
})

describe('nextJustAddedExpiry', () => {
  test('is the earliest moment a task in the window turns 15 minutes old', () => {
    const tasks = [
      makeTask({ id: 1, created_at: ago(2 * MIN) }),
      makeTask({ id: 2, created_at: ago(12 * MIN) }), // ages out first, in 3 minutes
      makeTask({ id: 3, created_at: ago(HOUR) }), // already out — no timer for it
    ]
    expect(nextJustAddedExpiry(tasks, NOW)).toBe(NOW + 3 * MIN)
  })

  test('null when nothing is in the window, so no timer is scheduled', () => {
    expect(nextJustAddedExpiry([makeTask({ id: 1, created_at: ago(HOUR) })], NOW)).toBeNull()
    expect(nextJustAddedExpiry([], NOW)).toBeNull()
  })

  test('advancing to each expiry walks the tasks out one by one', () => {
    const tasks = [
      makeTask({ id: 1, created_at: ago(1 * MIN) }),
      makeTask({ id: 2, created_at: ago(4 * MIN) }),
    ]
    const first = nextJustAddedExpiry(tasks, NOW)!
    expect(first).toBe(NOW + 11 * MIN)
    expect(tasks.filter((t) => isJustAdded(t, first)).map((t) => t.id)).toEqual([1])
    const second = nextJustAddedExpiry(tasks, first)!
    expect(second).toBe(NOW + 14 * MIN)
    expect(tasks.filter((t) => isJustAdded(t, second))).toEqual([])
    expect(nextJustAddedExpiry(tasks, second)).toBeNull()
    expect(first).toBe(Date.parse(tasks[1].created_at) + JUST_ADDED_WINDOW_MS)
  })
})

describe('nextJustAddedTick', () => {
  test('is the next minute boundary of the newest-changing age, ending at the age-out', () => {
    const task = makeTask({ id: 1, created_at: ago(2 * MIN + 40_000) })
    let now = NOW
    const badges: string[] = []
    for (;;) {
      const tick = nextJustAddedTick([task], now)
      if (tick === null) break
      expect(tick).toBeGreaterThan(now)
      now = tick
      badges.push(isJustAdded(task, now) ? formatJustAddedAge(task, now) : 'gone')
    }
    expect(nextJustAddedTick([task], NOW)).toBe(NOW + 20_000)
    expect(badges).toEqual([
      '3m ago',
      '4m ago',
      '5m ago',
      '6m ago',
      '7m ago',
      '8m ago',
      '9m ago',
      '10m ago',
      '11m ago',
      '12m ago',
      '13m ago',
      '14m ago',
      'gone',
    ])
    expect(now).toBe(nextJustAddedExpiry([task], NOW))
  })

  test('the soonest across tasks; a created_at ahead of this clock ticks a minute after it', () => {
    const tasks = [
      makeTask({ id: 1, created_at: ago(30_000) }), // next: +30s
      makeTask({ id: 2, created_at: ago(-5000) }), // skew: +65s
    ]
    expect(nextJustAddedTick(tasks, NOW)).toBe(NOW + 30_000)
    expect(nextJustAddedTick([tasks[1]], NOW)).toBe(NOW + 65_000)
  })

  test('null when nothing is in the window', () => {
    expect(nextJustAddedTick([makeTask({ id: 1, created_at: ago(HOUR) })], NOW)).toBeNull()
  })
})

describe('selectJustAddedEntries', () => {
  test('only the window, newest first; a same-second tie goes to the higher id', () => {
    const tasks = [
      makeTask({ id: 1, created_at: ago(HOUR) }),
      makeTask({ id: 2, created_at: ago(5 * MIN) }),
      makeTask({ id: 3, created_at: ago(MIN) }),
      makeTask({ id: 4, created_at: ago(MIN) }),
      makeTask({ id: 5, created_at: ago(16 * MIN) }),
    ]
    expect(selectJustAddedEntries(tasks, NOW).map((e) => e.task.id)).toEqual([4, 3, 2])
  })

  test('a task targeted in the window is in, ordered by the targeting, labelled targeted', () => {
    const tasks = [
      makeTask({ id: 1, created_at: ago(HOUR), segment_targeted_at: ago(2 * MIN) }),
      makeTask({ id: 2, created_at: ago(5 * MIN) }),
      makeTask({ id: 3, created_at: ago(HOUR), segment_targeted_at: ago(20 * MIN) }), // aged out
      makeTask({ id: 4, created_at: ago(30_000) }),
    ]
    const entries = selectJustAddedEntries(tasks, NOW)
    expect(entries.map((e) => [e.task.id, e.kind])).toEqual([
      [4, 'added'],
      [1, 'targeted'],
      [2, 'added'],
    ])
    expect(entries[1].at).toBe(NOW - 2 * MIN)
  })

  test('added AND targeted in the window: listed once, under the later event', () => {
    const task = makeTask({ id: 1, created_at: ago(10 * MIN), segment_targeted_at: ago(MIN) })
    const entries = selectJustAddedEntries([task], NOW)
    expect(entries).toHaveLength(1)
    expect(entries[0].kind).toBe('targeted')
    expect(formatJustAddedLabel(entries[0], NOW)).toBe('Targeted 1m ago')
    // The window runs from the targeting: in at 14m after it, out at 15m —
    // though the add itself left the window long before.
    expect(isJustAdded(task, NOW + 13 * MIN)).toBe(true)
    expect(isJustAdded(task, NOW + 14 * MIN)).toBe(false)
  })

  test('an old targeting never revives an add: only the latest event counts', () => {
    const task = makeTask({ id: 1, created_at: ago(2 * MIN), segment_targeted_at: ago(HOUR) })
    expect(justAddedEvent(task, NOW)).toEqual({ kind: 'added', at: NOW - 2 * MIN })
  })
})

describe('the targeted event drives the clock, the tag and Clear', () => {
  test('expiry and ticks run from the latest event', () => {
    const task = makeTask({
      id: 1,
      created_at: ago(14 * MIN + 30_000),
      segment_targeted_at: ago(40_000),
    })
    expect(nextJustAddedExpiry([task], NOW)).toBe(NOW - 40_000 + JUST_ADDED_WINDOW_MS)
    expect(nextJustAddedTick([task], NOW)).toBe(NOW + 20_000)
  })

  test('the real row is tagged "New" for an add and "Targeted" for a targeting', () => {
    expect(
      justAddedTag(makeTask({ id: 1, created_at: ago(MIN) }), NOW, undefined, CALENDAR_DAY_START),
    ).toBe('New')
    expect(
      justAddedTag(
        makeTask({ id: 2, created_at: ago(HOUR), segment_targeted_at: ago(MIN) }),
        NOW,
        undefined,
        CALENDAR_DAY_START,
      ),
    ).toBe('Targeted')
    expect(
      justAddedTag(makeTask({ id: 3, created_at: ago(HOUR) }), NOW, undefined, CALENDAR_DAY_START),
    ).toBeUndefined()
  })

  test('a Clear key is per event: re-targeting after a Clear makes a new key', () => {
    const before = selectJustAddedEntries([makeTask({ id: 7, created_at: ago(5 * MIN) })], NOW)[0]
    const after = selectJustAddedEntries(
      [makeTask({ id: 7, created_at: ago(5 * MIN), segment_targeted_at: ago(0) })],
      NOW,
    )[0]
    expect(justAddedEntryKey(before)).not.toBe(justAddedEntryKey(after))
    expect(formatJustAddedLabel(before, NOW)).toBe('Added 5m ago')
    expect(formatJustAddedLabel(after, NOW)).toBe('Targeted just now')
  })
})

describe('deck updates fold (isDeckUpdate, Trent 2026-10-22)', () => {
  const decked = (id: number, createdAgo: number, day: string) =>
    makeTask({ id, created_at: ago(createdAgo), segment_targeted_at: ago(MIN), on_deck_day: day })

  test('a task decked inside the window, created before it, is a deck update', () => {
    const [entry] = selectJustAddedEntries([decked(1, HOUR, '2026-01-16')], NOW)
    expect(entry.kind).toBe('decked')
    expect(isDeckUpdate(entry)).toBe(true)
  })

  test('created and decked inside the window: new, never folded', () => {
    const [entry] = selectJustAddedEntries([decked(2, 3 * MIN, '2026-01-15')], NOW)
    expect(entry.kind).toBe('decked')
    expect(isDeckUpdate(entry)).toBe(false)
  })

  test('added and targeted entries are never deck updates', () => {
    const entries = selectJustAddedEntries(
      [
        makeTask({ id: 3, created_at: ago(2 * MIN) }),
        makeTask({ id: 4, created_at: ago(HOUR), segment_targeted_at: ago(MIN) }),
      ],
      NOW,
    )
    expect(entries.map((e) => e.kind).sort()).toEqual(['added', 'targeted'])
    expect(entries.some((e) => isDeckUpdate(e))).toBe(false)
  })
})

describe("a deck's tag names its day (deckTagLabel, Trent 2026-10-22)", () => {
  const TZ = 'America/Chicago' // NOW is Thu Jan 15 2026, 10am here
  const decked = (day: string) =>
    makeTask({ id: 9, created_at: ago(HOUR), segment_targeted_at: ago(MIN), on_deck_day: day })

  test('today: "On deck"; tomorrow: "On deck tomorrow"; later: "On deck Jan 20"', () => {
    expect(justAddedTag(decked('2026-01-15'), NOW, TZ, CALENDAR_DAY_START)).toBe('On deck')
    expect(justAddedTag(decked('2026-01-16'), NOW, TZ, CALENDAR_DAY_START)).toBe('On deck tomorrow')
    expect(justAddedTag(decked('2026-01-20'), NOW, TZ, CALENDAR_DAY_START)).toBe('On deck Jan 20')
    expect(justAddedTag(decked('2026-11-15'), NOW, TZ, CALENDAR_DAY_START)).toBe('On deck Nov 15')
  })

  test("the day is the user's: late evening UTC-next-day is still today", () => {
    // 11:30pm Chicago on Jan 15 is Jan 16 in UTC.
    const late = new Date('2026-01-16T05:30:00Z').getTime()
    expect(deckTagLabel('2026-01-15', TZ, late, CALENDAR_DAY_START)).toBe('On deck')
    expect(deckTagLabel('2026-01-16', TZ, late, CALENDAR_DAY_START)).toBe('On deck tomorrow')
  })

  test('no zone or an unreadable day: plain "On deck"', () => {
    expect(justAddedTag(decked('2026-01-20'), NOW, undefined, CALENDAR_DAY_START)).toBe('On deck')
    expect(deckTagLabel('not-a-day', TZ, NOW, CALENDAR_DAY_START)).toBe('On deck')
  })
})

describe('formatJustAddedAge', () => {
  test('"just now" under a minute, whole minutes after', () => {
    expect(formatJustAddedAge(makeTask({ id: 1, created_at: ago(20_000) }), NOW)).toBe('just now')
    expect(formatJustAddedAge(makeTask({ id: 1, created_at: ago(3 * MIN + 40_000) }), NOW)).toBe(
      '3m ago',
    )
    // Skew: a created_at ahead of this clock is "just now", never negative.
    expect(formatJustAddedAge(makeTask({ id: 1, created_at: ago(-5000) }), NOW)).toBe('just now')
  })
})
