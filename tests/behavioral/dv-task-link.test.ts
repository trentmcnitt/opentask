/**
 * `resolveTaskLink` (src/lib/task-link.ts) — what the dashboard does with a
 * notification tap's `/?task=<id>`, one step per render: show and select the
 * row, or first clear what hides it (search/filters), send a reminder or
 * quota to its own surface, and give up with a toast rather than loop.
 *
 * Real `buildTaskGroups` output for the groups, so "Now's fold keeps a task
 * due next week in its project's group" is the real view's rule, not a stub's.
 */
import { describe, test, expect } from 'vitest'
import { resolveTaskLink, missingTaskMessage, type TaskLinkInput } from '@/lib/task-link'
import { buildTaskGroups } from '@/lib/task-grouping'
import type { GroupingMode } from '@/lib/grouping'
import type { Project, Task } from '@/types'

const TZ = 'America/Chicago'
const PROJECTS = [{ id: 1, name: 'Inbox', sort_order: 0, color: null } as unknown as Project]
// Thu 2026-01-15, 10:00 AM Chicago.
const NOW = new Date('2026-01-15T16:00:00Z')

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

const dueToday = makeTask({ id: 1, title: 'Due this afternoon', due_at: '2026-01-15T21:00:00Z' })
const dueNextWeek = makeTask({ id: 2, title: 'Call the dentist', due_at: '2026-01-22T15:00:00Z' })
const reminder = makeTask({ id: 3, title: 'Vitamins', is_reminder: true, rrule: 'FREQ=DAILY' })
const quota = makeTask({ id: 4, title: 'Workouts', is_tracked: true, progress_target: 3 })
const all = [dueToday, dueNextWeek, reminder, quota]
// What the dashboard lists: reminders and quotas are never rows (§5, §6).
const listable = all.filter((t) => !t.is_reminder && !t.is_tracked)

function input(
  taskId: number,
  grouping: GroupingMode,
  listed: Task[] = listable,
  tried = { narrowing: false },
): TaskLinkInput {
  return {
    taskId,
    tasks: all,
    listed,
    groups: buildTaskGroups(listed, PROJECTS, grouping),
    tried,
  }
}

describe('resolveTaskLink', () => {
  test('a row in the current view is shown, with its group', () => {
    const step = resolveTaskLink(input(1, 'project'))
    expect(step.kind).toBe('show')
    if (step.kind === 'show') expect(step.task.id).toBe(1)
  })

  test('a task not open at all is missing', () => {
    expect(resolveTaskLink(input(99, 'project')).kind).toBe('missing')
  })

  test('a reminder and a quota go to their own surfaces', () => {
    expect(resolveTaskLink(input(3, 'project')).kind).toBe('reminder')
    expect(resolveTaskLink(input(4, 'project')).kind).toBe('quota')
  })

  test('a search or filter hiding it is cleared first — once', () => {
    const narrowed = [dueToday]
    expect(resolveTaskLink(input(2, 'project', narrowed)).kind).toBe('clear-narrowing')
    expect(resolveTaskLink(input(2, 'project', narrowed, { narrowing: true })).kind).toBe(
      'unreachable',
    )
  })

  test("Now keeps a task behind its project's fold in the group, so it is shown", () => {
    // Due next week: not relevant now, so it is folded — but still in the
    // Inbox group, and the caller opens the fold (2026-10-14; the Today view
    // used to drop it and switch views).
    const step = resolveTaskLink(input(2, 'project'))
    expect(step.kind).toBe('show')
    if (step.kind === 'show') expect(step.groupLabel).toBe('Inbox')
  })

  test('flat views hold every listed task too', () => {
    expect(resolveTaskLink(input(2, 'new')).kind).toBe('show')
    expect(resolveTaskLink(input(2, 'unified')).kind).toBe('show')
  })
})

describe('missingTaskMessage', () => {
  test('says why the task has no row', () => {
    expect(missingTaskMessage({ title: 'Call', done: true, deleted_at: null })).toBe(
      '“Call” is already done',
    )
    expect(missingTaskMessage({ title: 'Call', done: false, deleted_at: '2026-01-15' })).toBe(
      '“Call” is in the trash',
    )
    expect(missingTaskMessage(null)).toBe('That task no longer exists')
  })
})
