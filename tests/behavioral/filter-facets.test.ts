/**
 * Faceted filter counts (dashboard FilterBar, Trent 2026-09-23).
 *
 * Bug: every filter row counted independently over the full task list, so a
 * chip's count ignored every OTHER active filter — with the Work project
 * filter active, the "Today" date chip still showed the corpus-wide count of
 * 3 even though none of Work's tasks were due today (the 3 were in Inbox and
 * Personal). `applyTaskFilters` is the single predicate `useFilterState`'s
 * `filteredTasks` and FilterBar's per-row facet counts both call — these
 * tests exercise it directly as a pure function, reproducing Trent's exact
 * scenario with `skipGroup: 'dateFilters'` (what the Today chip's own row
 * computes when the Work project filter is active elsewhere).
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { applyTaskFilters, type TaskFilterCriteria } from '@/hooks/useFilterState'
import { classifyTaskDueDate } from '@/components/DueDateFilterBar'
import { getTimezoneDayBoundaries } from '@/lib/format-date'
import type { Task } from '@/types'

const TIMEZONE = 'America/Chicago'

function makeTask(overrides: Partial<Task> & { id: number; title: string }): Task {
  return {
    user_id: 1,
    project_id: 1,
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
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function emptyCriteria(): TaskFilterCriteria {
  return {
    selectedLabels: [],
    excludedLabels: [],
    selectedPriorities: [],
    excludedPriorities: [],
    selectedDateFilters: [],
    excludedDateFilters: [],
    attributeFilters: new Set(),
    excludedAttributes: new Set(),
    selectedProjects: [],
    excludedProjects: [],
  }
}

// Project ids for this test — arbitrary, just distinct.
const INBOX = 1
const PERSONAL = 2
const WORK = 3

describe('applyTaskFilters — faceted counts', () => {
  beforeEach(() => {
    // Thursday 2026-01-15, 10am Chicago (16:00 UTC).
    vi.setSystemTime(new Date('2026-01-15T16:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  test('with no filters active, skipGroup has no effect (equivalent to the full filter)', () => {
    const tasks: Task[] = [
      makeTask({
        id: 1,
        title: 'Inbox today',
        project_id: INBOX,
        due_at: '2026-01-15T22:00:00Z',
      }),
      makeTask({
        id: 2,
        title: 'Work later',
        project_id: WORK,
        due_at: '2026-01-25T22:00:00Z',
      }),
    ]
    const criteria = emptyCriteria()
    const full = applyTaskFilters(tasks, criteria, { timezone: TIMEZONE })
    const faceted = applyTaskFilters(tasks, criteria, {
      timezone: TIMEZONE,
      skipGroup: 'dateFilters',
    })
    expect(full).toHaveLength(2)
    expect(faceted).toHaveLength(2)
  })

  test("Trent's bug: the Today chip's facet count reflects the active Work project filter, not the whole corpus", () => {
    const todayAt5pm = '2026-01-15T23:00:00Z' // 5pm Chicago, same day as "now"
    const nextWeek = '2026-01-22T23:00:00Z'

    const tasks: Task[] = [
      makeTask({ id: 1, title: 'Inbox task due today', project_id: INBOX, due_at: todayAt5pm }),
      makeTask({
        id: 2,
        title: 'Personal task due today',
        project_id: PERSONAL,
        due_at: todayAt5pm,
      }),
      makeTask({ id: 3, title: 'Another inbox today', project_id: INBOX, due_at: todayAt5pm }),
      makeTask({ id: 4, title: 'Work task due next week', project_id: WORK, due_at: nextWeek }),
    ]

    const criteria: TaskFilterCriteria = {
      ...emptyCriteria(),
      selectedProjects: [WORK],
    }

    // The fix: the Today chip's row facets over every OTHER active group
    // (here, the Work project filter) with its own group (dateFilters)
    // skipped — this is exactly what DueDateFilterBar buckets to build each
    // chip's count. Work has nothing due today, so only the Work task due
    // NEXT WEEK survives the project narrowing.
    const dateChipFacet = applyTaskFilters(tasks, criteria, {
      timezone: TIMEZONE,
      skipGroup: 'dateFilters',
    })
    expect(dateChipFacet.map((t) => t.id)).toEqual([4])

    // Bucketing the facet (what DueDateFilterBar does next) finds zero
    // "today" tasks — reproducing Trent's report that Work's Today chip
    // should read 0, not the corpus-wide 3.
    const boundaries = getTimezoneDayBoundaries(TIMEZONE)
    const now = new Date()
    const todayCountForWork = dateChipFacet.filter((t) =>
      classifyTaskDueDate(t, now, boundaries).includes('today'),
    )
    expect(todayCountForWork).toHaveLength(0)

    // Clearing the project filter (what Trent did next) restores the full
    // corpus for faceting — all 4 tasks are candidates again.
    const cleared = applyTaskFilters(tasks, emptyCriteria(), {
      timezone: TIMEZONE,
      skipGroup: 'dateFilters',
    })
    expect(cleared).toHaveLength(4)
  })

  test('skipGroup only exempts its own group — other active groups still apply', () => {
    const tasks: Task[] = [
      makeTask({ id: 1, title: 'Work, P2', project_id: WORK, priority: 2 }),
      makeTask({ id: 2, title: 'Work, P0', project_id: WORK, priority: 0 }),
      makeTask({ id: 3, title: 'Inbox, P2', project_id: INBOX, priority: 2 }),
    ]
    const criteria: TaskFilterCriteria = {
      ...emptyCriteria(),
      selectedProjects: [WORK],
      selectedPriorities: [2],
    }
    // Priority row's facet: the project filter (Work) still applies, the
    // priority filter is skipped — so both Work tasks are visible for the
    // priority row's own counts, regardless of their own priority.
    const priorityFacet = applyTaskFilters(tasks, criteria, { skipGroup: 'priorities' })
    expect(priorityFacet.map((t) => t.id).sort()).toEqual([1, 2])

    // Project row's facet: the priority filter (P2) still applies, the
    // project filter is skipped — so both P2 tasks are visible regardless of
    // which project they're in.
    const projectFacet = applyTaskFilters(tasks, criteria, { skipGroup: 'projects' })
    expect(projectFacet.map((t) => t.id).sort()).toEqual([1, 3])
  })

  test('excluded chips facet the same way as included chips', () => {
    const tasks: Task[] = [
      makeTask({ id: 1, title: 'Work', project_id: WORK, priority: 1 }),
      makeTask({ id: 2, title: 'Inbox', project_id: INBOX, priority: 1 }),
      makeTask({ id: 3, title: 'Personal', project_id: PERSONAL, priority: 3 }),
    ]
    const criteria: TaskFilterCriteria = {
      ...emptyCriteria(),
      excludedProjects: [WORK],
    }
    // Priority row's facet: Work is excluded (still applies), priority group
    // itself is skipped.
    const priorityFacet = applyTaskFilters(tasks, criteria, { skipGroup: 'priorities' })
    expect(priorityFacet.map((t) => t.id).sort()).toEqual([2, 3])
  })
})
