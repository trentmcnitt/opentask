/**
 * The dashboard's Recent view (`default_grouping === 'recent'`).
 *
 * Recent is one flat list of the tasks added in the last 7 days (rolling
 * 7 × 24h), newest first by `created_at`, across every project. Its order is
 * fixed: the stored sort preference must not apply, and every consumer of a
 * group's order (the rendered list, the keyboard/shift-click order, the
 * clipboard) goes through `effectiveSort` so they agree.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { selectRecentTasks, RECENT_GROUP_LABEL } from '@/lib/recent-view'
import { buildTaskGroups, effectiveSort, sortTasks } from '@/components/TaskList'
import { formatAddedAgo } from '@/lib/format-date'
import type { Task } from '@/types'

const TIMEZONE = 'America/Chicago'
// Jan 15, 2026 at 10am Chicago.
const NOW = new Date('2026-01-15T16:00:00Z')
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

function ago(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString()
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
    original_title: null,
    short_title: null,
    original_due_at: null,
    last_notified_at: null,
    last_critical_alert_at: null,
    auto_snooze_minutes: null,
    deleted_at: null,
    archived_at: null,
    labels: [],
    completion_count: 0,
    snooze_count: 0,
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

describe('selectRecentTasks', () => {
  test('keeps the last 7 days, newest first, across projects', () => {
    const tasks = [
      makeTask({ id: 1, project_id: 1, created_at: ago(3 * DAY) }),
      makeTask({ id: 2, project_id: 2, created_at: ago(5 * 60 * 1000) }),
      makeTask({ id: 3, project_id: 3, created_at: ago(8 * DAY) }),
      makeTask({ id: 4, project_id: 1, created_at: ago(2 * HOUR), due_at: ago(-DAY) }),
      makeTask({ id: 5, project_id: 2, created_at: ago(30 * DAY) }),
    ]
    expect(selectRecentTasks(tasks, NOW).map((t) => t.id)).toEqual([2, 4, 1])
  })

  test('the window is rolling 7 × 24h: exactly 7 days is in, a second older is out', () => {
    const tasks = [
      makeTask({ id: 1, created_at: ago(7 * DAY) }),
      makeTask({ id: 2, created_at: ago(7 * DAY + 1000) }),
    ]
    expect(selectRecentTasks(tasks, NOW).map((t) => t.id)).toEqual([1])
  })

  test('the same created_at breaks ties by id, higher (later insert) first', () => {
    const same = ago(HOUR)
    const tasks = [
      makeTask({ id: 10, created_at: same }),
      makeTask({ id: 12, created_at: same }),
      makeTask({ id: 11, created_at: same }),
    ]
    expect(selectRecentTasks(tasks, NOW).map((t) => t.id)).toEqual([12, 11, 10])
  })

  test('defaults "now" to the clock', () => {
    const tasks = [
      makeTask({ id: 1, created_at: ago(DAY) }),
      makeTask({ id: 2, created_at: ago(9 * DAY) }),
    ]
    expect(selectRecentTasks(tasks).map((t) => t.id)).toEqual([1])
  })
})

describe('Recent grouping', () => {
  const tasks = [
    makeTask({ id: 1, created_at: ago(DAY), due_at: ago(-HOUR), priority: 4 }),
    makeTask({ id: 2, created_at: ago(HOUR), due_at: ago(-5 * DAY), priority: 0 }),
    makeTask({ id: 3, created_at: ago(10 * DAY), due_at: ago(-2 * HOUR) }),
  ]

  test('builds one flat group of the slice, in newest-first order', () => {
    const groups = buildTaskGroups(tasks, [], 'recent', TIMEZONE)
    expect(groups).toHaveLength(1)
    expect(groups[0].label).toBe(RECENT_GROUP_LABEL)
    expect(groups[0].tasks.map((t) => t.id)).toEqual([2, 1])
  })

  test('an empty slice is no group at all (the view shows its empty state)', () => {
    expect(buildTaskGroups([tasks[2]], [], 'recent', TIMEZONE)).toEqual([])
  })

  test('ignores the stored sort preference — due date, priority, reversed', () => {
    const [group] = buildTaskGroups(tasks, [], 'recent', TIMEZONE)
    for (const [option, reversed] of [
      ['due_date', false],
      ['priority', false],
      ['title', true],
      ['age', true],
    ] as const) {
      const sort = effectiveSort('recent', option, reversed)
      expect(sort).toEqual({ sortOption: 'age', reversed: false })
      expect(sortTasks(group.tasks, sort.sortOption, sort.reversed).map((t) => t.id)).toEqual([
        2, 1,
      ])
    }
  })

  test('other views keep the stored sort', () => {
    expect(effectiveSort('project', 'priority', true)).toEqual({
      sortOption: 'priority',
      reversed: true,
    })
  })

  test('a same-timestamp tie survives the re-sort in id order', () => {
    const same = ago(HOUR)
    const tied = [makeTask({ id: 7, created_at: same }), makeTask({ id: 9, created_at: same })]
    const [group] = buildTaskGroups(tied, [], 'recent', TIMEZONE)
    expect(sortTasks(group.tasks, 'age', false).map((t) => t.id)).toEqual([9, 7])
  })
})

describe('formatAddedAgo', () => {
  test('reads in the overdue vocabulary, past tense', () => {
    expect(formatAddedAgo(ago(20 * 1000), TIMEZONE, NOW)).toBe('added just now')
    expect(formatAddedAgo(ago(12 * 60 * 1000), TIMEZONE, NOW)).toBe('added 12m ago')
    expect(formatAddedAgo(ago(3 * HOUR), TIMEZONE, NOW)).toBe('added 3h ago')
    // 10am Chicago now; 20h ago is 2pm yesterday.
    expect(formatAddedAgo(ago(20 * HOUR), TIMEZONE, NOW)).toBe('added yesterday')
    expect(formatAddedAgo(ago(3 * DAY), TIMEZONE, NOW)).toBe('added 3d ago')
  })

  test('a created_at slightly ahead of the device clock is "just now"', () => {
    expect(formatAddedAgo(ago(-2000), TIMEZONE, NOW)).toBe('added just now')
  })
})
