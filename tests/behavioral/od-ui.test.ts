/**
 * OD-UI: On deck's web helpers (D2, 2026-10-20; spec rules 7–9) — the hold
 * menu's days (`deckMenuDays`), the A1 limit (`deckLimit`), the date picker's first day, the
 * tap's toggle (`deckTapDay`, A10), which rows offer the button
 * (`offersDeck`), Now's On deck section (`withDeckSection`, A13), the toast
 * words (`deckToastMessage`), the Just now tag for a deck, and the Quick
 * panel's one-request save.
 */
import { CALENDAR_DAY_START } from '@/lib/opentask-day'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { DateTime } from 'luxon'
import {
  deckLimit,
  deckMenuDays,
  deckReplaces,
  deckTapDay,
  deckTomorrowDay,
  deferLeadDays,
  offersDeck,
  todayReplaces,
} from '@/lib/deck-menu'
import { deckPickerDefault } from '@/components/OnDeckButton'
import { deckToastMessage, type DeckResponse } from '@/lib/deck-request'
import { inDeckSection } from '@/lib/now-view'
import {
  DECK_GROUP_LABEL,
  applyNowFolds,
  buildTaskGroups,
  orderedTaskIds,
  sortTaskGroups,
  withDeckSection,
} from '@/lib/task-grouping'
import { justAddedTag } from '@/lib/just-added'
import { saveTaskChanges } from '@/lib/save-task-changes'
import type { Project, Task } from '@/types'

const TZ = 'America/Chicago'
// Thu 2026-01-15, 10:00 AM Chicago.
const NOW = new Date('2026-01-15T16:00:00Z')

/** A UTC ISO string for `hour:00` local, `days` from today. */
function local(days: number, hour: number): string {
  return DateTime.fromISO('2026-01-15T00:00:00', { zone: TZ })
    .plus({ days })
    .set({ hour })
    .toUTC()
    .toISO()!
}

let nextId = 1
function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: nextId++,
    user_id: 1,
    project_id: 1,
    title: 'task',
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
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

beforeEach(() => vi.setSystemTime(NOW))
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('OD-UI-01: the hold menu days', () => {
  test('Tomorrow, then the next days by name, the check-in Saturday marked', () => {
    const days = deckMenuDays(TZ, NOW, CALENDAR_DAY_START, 6)
    expect(days.map((d) => d.label)).toEqual([
      'Tomorrow',
      'Saturday · check-in',
      'Sunday',
      'Monday',
      'Tuesday',
      'Wednesday',
    ])
    expect(days[0].day).toBe('2026-01-16')
    expect(days[5].day).toBe('2026-01-21')
    expect(days.every((d) => !d.disabled)).toBe(true)
  })

  test('check-in tomorrow is marked on Tomorrow; check-in today adds next week’s', () => {
    // Friday Jan 16: tomorrow is Saturday.
    const fri = new Date('2026-01-16T16:00:00Z')
    expect(deckMenuDays(TZ, fri, CALENDAR_DAY_START, 6)[0].label).toBe('Tomorrow · check-in')
    // Saturday Jan 17: the next check-in is a week out.
    const sat = new Date('2026-01-17T16:00:00Z')
    const days = deckMenuDays(TZ, sat, CALENDAR_DAY_START, 6)
    expect(days).toHaveLength(7)
    expect(days[6]).toEqual({ label: 'Sat Jan 24 · check-in', day: '2026-01-24', disabled: false })
  })

  test('between midnight and the rollover, Tomorrow is the next calendar day (A2)', () => {
    // 1 AM Friday Jan 16 Chicago.
    const early = new Date('2026-01-16T07:00:00Z')
    expect(deckMenuDays(TZ, early, CALENDAR_DAY_START, 6)[0].day).toBe('2026-01-17')
  })

  test('the row’s one-tap "On deck tomorrow" sends the menu’s Tomorrow, at any hour', () => {
    expect(deckTomorrowDay(TZ, NOW, CALENDAR_DAY_START)).toBe('2026-01-16')
    // Just before and after local midnight, a check-in day, and 1 AM (A2).
    for (const iso of [
      '2026-01-16T05:59:00Z',
      '2026-01-16T06:01:00Z',
      '2026-01-16T07:00:00Z',
      '2026-01-17T16:00:00Z',
    ]) {
      const at = new Date(iso)
      expect(deckTomorrowDay(TZ, at, CALENDAR_DAY_START), iso).toBe(
        deckMenuDays(TZ, at, CALENDAR_DAY_START, 6)[0].day,
      )
    }
    expect(deckTomorrowDay(TZ, new Date('2026-01-16T05:59:00Z'), CALENDAR_DAY_START)).toBe(
      '2026-01-16',
    )
    expect(deckTomorrowDay(TZ, new Date('2026-01-16T06:01:00Z'), CALENDAR_DAY_START)).toBe(
      '2026-01-17',
    )
  })

  test('A1: the days after the latest are greyed, with the caption', () => {
    const limit = { latestDay: '2026-01-18', caption: 'deadline reminds from Mon' }
    const days = deckMenuDays(TZ, NOW, CALENDAR_DAY_START, 6, limit)
    expect(days.filter((d) => d.disabled).map((d) => d.day)).toEqual([
      '2026-01-19',
      '2026-01-20',
      '2026-01-21',
    ])
    expect(days.find((d) => d.day === '2026-01-19')?.caption).toBe('deadline reminds from Mon')
    expect(days.find((d) => d.day === '2026-01-18')?.caption).toBeUndefined()
  })

  test('the limit: up to the deadline day (the deadlines page, 2026-10-22), stored or staged', () => {
    const ctx = { timezone: TZ, morningTime: '08:30' }
    // Deadline Tue Jan 20 17:00 → the latest is Tue Jan 20 itself.
    expect(deckLimit({ deadline_at: local(5, 17), due_at: null }, TZ, NOW, null, null)).toEqual({
      latestDay: '2026-01-20',
      caption: 'deadline Tue',
    })
    // A staged deadline (the Quick panel): the same, Tue Jan 27.
    const staged = { deadline_at: local(12, 23), due_at: null }
    expect(deckLimit(staged, TZ, NOW, ctx, null)).toEqual({
      latestDay: '2026-01-27',
      caption: 'deadline Tue',
    })
    // A passed deadline: no day left (the latest is yesterday).
    expect(deckLimit({ deadline_at: local(-1, 17), due_at: null }, TZ, NOW, null, null)).toEqual({
      latestDay: '2026-01-14',
      caption: 'deadline passed',
    })
    expect(deckLimit({ deadline_at: null, due_at: null }, TZ, NOW, null, null)).toBeNull()
  })

  test('the date picker opens on a day that can be chosen', () => {
    expect(deckPickerDefault('2026-01-15', '2026-01-20', null)).toBe('2026-01-20')
    expect(deckPickerDefault('2026-01-15', null, null)).toBe('2026-01-16')
    // The deck's day is past the limit: tomorrow; tomorrow too: today.
    expect(deckPickerDefault('2026-01-15', '2026-01-20', '2026-01-16')).toBe('2026-01-16')
    expect(deckPickerDefault('2026-01-15', null, '2026-01-15')).toBe('2026-01-15')
    expect(deckPickerDefault('2026-01-15', null, '2026-01-14')).toBeNull()
  })
})

describe('OD-UI-02: the tap and the rows that offer it', () => {
  test("a tap takes today's (or a leftover) deck off, else decks for today (A10)", () => {
    expect(deckTapDay({ on_deck_day: '2026-01-15' }, TZ, NOW, CALENDAR_DAY_START)).toBeNull()
    expect(deckTapDay({ on_deck_day: '2026-01-14' }, TZ, NOW, CALENDAR_DAY_START)).toBeNull()
    expect(deckTapDay({ on_deck_day: '2026-01-17' }, TZ, NOW, CALENDAR_DAY_START)).toBeUndefined()
    expect(deckTapDay({ on_deck_day: null }, TZ, NOW, CALENDAR_DAY_START)).toBeUndefined()
  })

  test('every open task but a reminder or quota (2026-10-22: a picked target too)', () => {
    expect(offersDeck(makeTask())).toBe(true)
    expect(offersDeck(makeTask({ due_at: local(1, 9), target_auto: true }))).toBe(true)
    // The deadlines page, plan §5: a deck may replace a target — faded, it asks.
    expect(offersDeck(makeTask({ due_at: local(1, 9) }))).toBe(true)
    // A repeating task always offers it (2026-10-20): it decks the occurrence.
    expect(offersDeck(makeTask({ rrule: 'FREQ=DAILY', due_at: local(1, 9) }))).toBe(true)
    expect(offersDeck(makeTask({ is_reminder: true }))).toBe(false)
    expect(offersDeck(makeTask({ progress_target: 3 }))).toBe(false)
    expect(offersDeck(makeTask({ done: true }))).toBe(false)
    expect(offersDeck(makeTask({ on_deck_day: '2026-01-16' }))).toBe(true)
  })
})

describe('OD-UI-02b: what a deck or Today replaces (plan §5, the faded buttons)', () => {
  test("a deck replaces a one-off's picked target, said with its day and time", () => {
    const at = DateTime.fromISO('2026-01-16T18:00', { zone: TZ }).toUTC().toISO()!
    expect(deckReplaces(makeTask({ due_at: at }), TZ)).toBe('target Fri 6 PM')
    const half = DateTime.fromISO('2026-01-16T18:30', { zone: TZ }).toUTC().toISO()!
    expect(deckReplaces(makeTask({ due_at: half }), TZ)).toBe('target Fri 6:30 PM')
    expect(deckReplaces(makeTask(), TZ)).toBeNull()
    expect(deckReplaces(makeTask({ due_at: at, target_auto: true }), TZ)).toBeNull()
    expect(deckReplaces(makeTask({ due_at: at, rrule: 'FREQ=DAILY' }), TZ)).toBeNull()
  })

  test('Today replaces a deck', () => {
    expect(todayReplaces({ on_deck_day: '2026-01-17' }, TZ, CALENDAR_DAY_START, NOW)).toBe(
      'On deck Sat',
    )
    expect(todayReplaces({ on_deck_day: '2026-01-15' }, TZ, CALENDAR_DAY_START, NOW)).toBe(
      'On deck today',
    )
    expect(todayReplaces({ on_deck_day: null }, TZ, CALENDAR_DAY_START, NOW)).toBeNull()
  })
})

describe('OD-UI-02c: the deadlines page Defer menu (tomorrow … D−2)', () => {
  // NOW is Thu Jan 15 2026, 10:00 Chicago.
  const at = (local: string) => DateTime.fromISO(local, { zone: TZ }).toUTC().toISO()!

  test('tomorrow to two days before the deadline, the last one marked', () => {
    const days = deferLeadDays(at('2026-01-20T17:00'), TZ, NOW, null)
    expect(days.map((d) => d.day)).toEqual(['2026-01-16', '2026-01-17', '2026-01-18'])
    expect(days[0].label).toBe('Tomorrow')
    expect(days[1].label).toBe('Saturday')
    expect(days[2].caption).toBe('2 days before the deadline')
  })

  test('a far deadline: the next six days, then its last allowed day', () => {
    const days = deferLeadDays(at('2026-02-10T17:00'), TZ, NOW, null)
    expect(days).toHaveLength(7)
    expect(days[6]).toMatchObject({ day: '2026-02-08', label: 'Sun Feb 8' })
  })

  test('only days after the current lead day; none once tomorrow is D−1', () => {
    const days = deferLeadDays(at('2026-01-20T17:00'), TZ, NOW, null, '2026-01-16')
    expect(days.map((d) => d.day)).toEqual(['2026-01-17', '2026-01-18'])
    expect(deferLeadDays(at('2026-01-17T17:00'), TZ, NOW, null)).toEqual([])
  })
})

describe("OD-UI-03: Now's On deck section", () => {
  const projects = [
    { id: 1, name: 'Inbox', sort_order: 0 },
    { id: 2, name: 'Home', sort_order: 1 },
  ] as Project[]
  const sorted = (tasks: Task[]) =>
    sortTaskGroups(buildTaskGroups(tasks, projects, 'project'), 'due_date', false)
  const build = (tasks: Task[]) =>
    applyNowFolds(
      withDeckSection(sorted(tasks), TZ, NOW, { dayStart: CALENDAR_DAY_START }),
      TZ,
      NOW,
      { queue: true, dayStart: CALENDAR_DAY_START },
    )

  test("today's decks leave their projects for one section before them, priority then id", () => {
    const low = makeTask({ project_id: 1, on_deck_day: '2026-01-15', priority: 1 })
    const high = makeTask({ project_id: 2, on_deck_day: '2026-01-15', priority: 3 })
    const leftover = makeTask({ project_id: 1, on_deck_day: '2026-01-14', priority: 1 })
    const later = makeTask({ project_id: 1, on_deck_day: '2026-01-20' })
    const plain = makeTask({ project_id: 1 })
    const groups = build([low, high, leftover, later, plain])
    // Home held only a deck, so it is gone.
    expect(groups.map((g) => g.label)).toEqual([DECK_GROUP_LABEL, 'Inbox'])
    const deck = groups[0]
    expect(deck.deck).toBe(true)
    expect(deck.now).toBeUndefined()
    expect(deck.sortedTasks.map((t) => t.id)).toEqual([high.id, low.id, leftover.id])
    // Not drawn twice: the project keeps the rest only (in its fold).
    expect(groups[1].tasks.map((t) => t.id).sort()).toEqual([later.id, plain.id].sort())
    // The keyboard order reaches each deck once, first — as drawn.
    const ids = orderedTaskIds(
      groups,
      () => false,
      () => true,
    )
    expect(ids.filter((id) => id === high.id)).toHaveLength(1)
    expect(ids.slice(0, 3)).toEqual([high.id, low.id, leftover.id])
  })

  test('no decks today: no section (no empty chrome), the groups unchanged', () => {
    const groups = sorted([makeTask({ on_deck_day: '2026-01-20' }), makeTask()])
    expect(withDeckSection(groups, TZ, NOW, { dayStart: CALENDAR_DAY_START })).toBe(groups)
  })

  test('a deck already over target (its deadline nags) stays in its project', () => {
    const nagging = makeTask({
      on_deck_day: '2026-01-15',
      due_at: local(0, 8),
      target_auto: true,
      deadline_at: local(2, 17),
    })
    expect(inDeckSection(nagging, TZ, NOW, { dayStart: CALENDAR_DAY_START })).toBe(false)
    expect(
      inDeckSection(makeTask({ on_deck_day: '2026-01-15' }), TZ, NOW, {
        dayStart: CALENDAR_DAY_START,
      }),
    ).toBe(true)
  })

  test('the deadlines page (queue on): a target-less deadline task in its safety net is the page’s, not the section’s', () => {
    const opts = { queue: true, dayStart: CALENDAR_DAY_START }
    const inNet = makeTask({ on_deck_day: '2026-01-15', deadline_at: local(1, 17) })
    expect(inDeckSection(inNet, TZ, NOW, opts)).toBe(false)
    // Further out the deck day is the section's (the page suppresses it that day).
    const ahead = makeTask({ on_deck_day: '2026-01-15', deadline_at: local(5, 17) })
    expect(inDeckSection(ahead, TZ, NOW, opts)).toBe(true)
    // Queue off: as before.
    expect(inDeckSection(inNet, TZ, NOW, { dayStart: CALENDAR_DAY_START })).toBe(true)
  })
})

describe('OD-UI-04: words', () => {
  const base: DeckResponse = {
    day: '2026-01-15',
    decked: 1,
    undecked: 0,
    skipped_recurring: 0,
    skipped_reminder: 0,
    skipped_quota: 0,
    skipped_done: 0,
    skipped_trashed: 0,
    refused: [],
    summary: '1 task on deck for today',
  }

  test('a deck, a later deck, an un-deck; nothing changed is null (the summary shows)', () => {
    expect(deckToastMessage(base, 'Gloves', TZ, CALENDAR_DAY_START, NOW)).toBe(
      'On deck for today: “Gloves”',
    )
    expect(
      deckToastMessage({ ...base, day: '2026-01-17' }, 'Gloves', TZ, CALENDAR_DAY_START, NOW),
    ).toBe('On deck for Sat Jan 17: “Gloves”')
    expect(
      deckToastMessage(
        { ...base, day: null, decked: 0, undecked: 1 },
        'G',
        TZ,
        CALENDAR_DAY_START,
        NOW,
      ),
    ).toBe('Taken off deck: “G”')
    const refused = {
      ...base,
      decked: 0,
      refused: [{ id: 1, reason: 'deadline_nagging' as const }],
    }
    expect(deckToastMessage(refused, 'G', TZ, CALENDAR_DAY_START, NOW)).toBeNull()
  })

  test('Just now names a deck "On deck", a target "Targeted"', () => {
    const at = new Date(NOW.getTime() - 60_000).toISOString()
    const decked = makeTask({ segment_targeted_at: at, on_deck_day: '2026-01-15' })
    expect(justAddedTag(decked, +NOW, undefined, CALENDAR_DAY_START)).toBe('On deck')
    expect(
      justAddedTag(makeTask({ segment_targeted_at: at }), +NOW, undefined, CALENDAR_DAY_START),
    ).toBe('Targeted')
  })
})

describe('OD-UI-05: the Quick panel save', () => {
  test('a deck is one PATCH, with or without a deadline (one write, one undo entry)', async () => {
    const bodies: unknown[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        bodies.push(JSON.parse(init.body))
        return new Response(JSON.stringify({ data: { id: 1, description: `d${bodies.length}` } }))
      }),
    )
    await saveTaskChanges(1, { on_deck_day: '2026-01-16', priority: 2 })
    expect(bodies).toEqual([{ on_deck_day: '2026-01-16', priority: 2 }])
    bodies.length = 0
    const deadline = local(5, 17)
    const result = await saveTaskChanges(1, { on_deck_day: '2026-01-16', deadline_at: deadline })
    expect(bodies).toEqual([{ on_deck_day: '2026-01-16', deadline_at: deadline }])
    expect(result.description).toBe('d1')
  })
})
