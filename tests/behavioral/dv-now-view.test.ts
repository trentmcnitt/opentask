/**
 * DV-NOW: the dashboard's Now view (`'project'`, 2026-10-14) — which rows are
 * "relevant now" (`isRelevantNow`, src/lib/now-view.ts) and how each project
 * group splits into those rows and its "+ N more" fold.
 *
 * Relevant now: over target, targeted today (later today included), in
 * today's Upcoming heads-up (the Upcoming segment's own rule, not deferred),
 * or undated High/Urgent. Everything else folds. The clock is frozen.
 */
import { CALENDAR_DAY_START } from '@/lib/opentask-day'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { DateTime } from 'luxon'
import { isRelevantNow, splitNow } from '@/lib/now-view'
import {
  applyNowFolds,
  buildTaskGroups,
  nowFoldKey,
  orderedTaskIds,
  shownGroupTasks,
  sortTaskGroups,
} from '@/lib/task-grouping'
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

const relevant = (task: Task) => isRelevantNow(task, TZ, NOW, { dayStart: CALENDAR_DAY_START })

describe('DV-NOW: what is relevant now', () => {
  beforeEach(() => vi.setSystemTime(NOW))
  afterEach(() => vi.useRealTimers())

  test('over target is relevant, however long ago', () => {
    expect(relevant(makeTask({ due_at: local(-1, 9) }))).toBe(true)
    expect(relevant(makeTask({ due_at: local(-30, 9) }))).toBe(true)
    // Earlier this morning.
    expect(relevant(makeTask({ due_at: local(0, 8) }))).toBe(true)
  })

  test('targeted today is relevant before the hour comes', () => {
    expect(relevant(makeTask({ due_at: local(0, 15) }))).toBe(true)
    expect(relevant(makeTask({ due_at: local(0, 23) }))).toBe(true)
  })

  test('a target tomorrow or later is not, outside its heads-up days', () => {
    // Set today for tomorrow: no heads-up (the day before is the day it was made).
    expect(relevant(makeTask({ due_at: local(1, 9), target_set_at: local(0, 8) }))).toBe(false)
    // Set yesterday for Jan 25 (wait 11): heads-ups Jan 22 and Jan 24, not today.
    expect(relevant(makeTask({ due_at: local(10, 9), target_set_at: local(-1, 9) }))).toBe(false)
  })

  test("today's Upcoming heads-up is relevant — the segment's own rule", () => {
    // Set Jan 5 for Jan 16 (wait 11): heads-ups Jan 13 and Jan 15 (today).
    const dayBefore = makeTask({ due_at: local(1, 9), target_set_at: local(-10, 9) })
    expect(relevant(dayBefore)).toBe(true)
    // Set Jan 1 for Jan 18 (wait 17, lead 4): heads-ups Jan 14 and Jan 17. The
    // Jan 14 one was never considered, so it carries over to today.
    const carried = makeTask({ due_at: local(3, 9), target_set_at: '2026-01-01T15:00:00Z' })
    expect(relevant(carried)).toBe(true)
    // Considered since that heads-up (yesterday): off until the next one.
    expect(relevant({ ...carried, last_considered_at: local(-1, 12) })).toBe(false)
  })

  test('a heads-up considered today stays; one deferred today does not', () => {
    const heads = makeTask({ due_at: local(1, 9), target_set_at: local(-10, 9) })
    expect(relevant({ ...heads, last_considered_at: local(0, 9) })).toBe(true)
    expect(relevant({ ...heads, segment_deferred_at: local(0, 9) })).toBe(false)
  })

  test('undated High and Urgent are relevant; lower priorities fold', () => {
    expect(relevant(makeTask({ priority: 4 }))).toBe(true)
    expect(relevant(makeTask({ priority: 3 }))).toBe(true)
    expect(relevant(makeTask({ priority: 2 }))).toBe(false)
    expect(relevant(makeTask({ priority: 1 }))).toBe(false)
    expect(relevant(makeTask({ priority: 0 }))).toBe(false)
  })

  test('High with a future target is not relevant until its target or heads-up', () => {
    expect(
      relevant(makeTask({ priority: 4, due_at: local(10, 9), target_set_at: local(-1, 9) })),
    ).toBe(false)
  })

  test("a deadline's automatic target counts only once its day comes", () => {
    // Auto targets have no Upcoming heads-ups (§8.5).
    const later = makeTask({
      due_at: local(1, 9),
      target_auto: true,
      deadline_at: local(4, 23),
      target_set_at: local(-10, 9),
    })
    expect(relevant(later)).toBe(false)
    expect(relevant({ ...later, due_at: local(0, 9) })).toBe(true)
  })
})

describe('DV-NOW: project groups split into relevant rows and the fold', () => {
  beforeEach(() => vi.setSystemTime(NOW))
  afterEach(() => vi.useRealTimers())

  const projects = [
    { id: 1, name: 'Inbox', sort_order: 0, color: 'blue' },
    { id: 2, name: 'Infra', sort_order: 1, color: null },
  ] as unknown as Project[]

  const overdue = makeTask({ project_id: 1, due_at: local(-1, 9) })
  const later = makeTask({ project_id: 1, due_at: local(10, 9), target_set_at: local(-1, 9) })
  const urgent = makeTask({ project_id: 1, priority: 4 })
  const someday = makeTask({ project_id: 1 })
  const infraA = makeTask({ project_id: 2 })
  const infraB = makeTask({ project_id: 2, priority: 1 })

  const groups = () =>
    applyNowFolds(
      sortTaskGroups(
        buildTaskGroups([overdue, later, urgent, someday, infraA, infraB], projects, 'project'),
        'due_date',
        false,
      ),
      TZ,
      NOW,
      { dayStart: CALENDAR_DAY_START },
    )

  test('each project keeps every task; the split keeps the sort order', () => {
    const [inbox] = groups()
    expect(inbox.tasks).toHaveLength(4)
    // due_date order: overdue, later, then the undated by priority.
    expect(inbox.sortedTasks.map((t) => t.id)).toEqual([
      overdue.id,
      later.id,
      urgent.id,
      someday.id,
    ])
    expect(inbox.now?.relevant.map((t) => t.id)).toEqual([overdue.id, urgent.id])
    expect(inbox.now?.more.map((t) => t.id)).toEqual([later.id, someday.id])
  })

  test('a project with nothing relevant is still a group — all fold', () => {
    const infra = groups()[1]
    expect(infra.label).toBe('Infra')
    expect(infra.now?.relevant).toEqual([])
    expect(infra.now?.more).toHaveLength(2)
  })

  test('folds are keyed by project id', () => {
    const [inbox, infra] = groups()
    expect(nowFoldKey(inbox)).toBe('1')
    expect(nowFoldKey(infra)).toBe('2')
  })

  test('a shut fold hides its rows from the reachable order; open, they follow the relevant ones', () => {
    const g = groups()
    expect(orderedTaskIds(g, () => false)).toEqual([overdue.id, urgent.id])
    expect(
      orderedTaskIds(
        g,
        () => false,
        (key) => key === '1',
      ),
    ).toEqual([overdue.id, urgent.id, later.id, someday.id])
    expect(
      orderedTaskIds(
        g,
        () => false,
        (key) => key === '2',
      ),
    ).toEqual([overdue.id, urgent.id, infraA.id, infraB.id])
    // A collapsed group drops out entirely, fold or not.
    expect(
      orderedTaskIds(
        g,
        (label) => label === 'Inbox',
        () => true,
      ),
    ).toEqual([infraA.id, infraB.id])
  })

  test('without the folds (Show all, a search or a filter) every row is shown', () => {
    const plain = sortTaskGroups(
      buildTaskGroups([overdue, later, urgent, someday], projects, 'project'),
      'due_date',
      false,
    )
    expect(plain[0].now).toBeUndefined()
    expect(shownGroupTasks(plain[0], false)).toHaveLength(4)
    expect(orderedTaskIds(plain, () => false)).toHaveLength(4)
  })

  test('splitNow counts add up to the project', () => {
    const { relevant: r, more } = splitNow([overdue, later, urgent, someday], TZ, NOW, {
      dayStart: CALENDAR_DAY_START,
    })
    expect(r.length + more.length).toBe(4)
  })
})
