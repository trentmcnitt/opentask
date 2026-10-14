/**
 * DV-010, DV-012, DV-014: tracked items (Track, §5) always come back from
 * `trackedItems` for the Track panel — regardless of what their rrule says
 * about today. That panel is how §7.3's "they must not become invisible from
 * the front door" is met. (They are never dashboard rows at all: the
 * dashboard drops them before grouping. DV-011 and DV-013 pinned the Today
 * view's time-slot groups, which went with that view on 2026-10-14.)
 *
 * Why this needs pinning: the §9 migration rewrote quota rules to the bare
 * period ("FREQ=WEEKLY"), which rrule.js places on one weekday. Read as an
 * occurrence, an "eggs 2x/week" row would appear one day in seven. It is a
 * counter over the week, so the week containing today is its day, every day.
 */
import { describe, expect, test } from 'vitest'
import { trackedItems } from '@/lib/slot-view'
import { trackSummary } from '@/lib/track'
import type { Task } from '@/types'

let nextId = 1
function task(overrides: Partial<Task>): Task {
  return {
    id: nextId++,
    user_id: 1,
    project_id: 1,
    title: 'task',
    original_title: null,
    done: false,
    done_at: null,
    priority: 0,
    due_at: null,
    rrule: null,
    recurrence_mode: 'from_due',
    anchor_time: null,
    anchor_dow: null,
    anchor_dom: null,
    original_due_at: null,
    last_notified_at: null,
    last_critical_alert_at: null,
    auto_snooze_minutes: null,
    deleted_at: null,
    archived_at: null,
    labels: [],
    progress_target: 1,
    progress_current: 0,
    is_reminder: false,
    completion_count: 0,
    snooze_count: 0,
    skip_count: 0,
    first_completed_at: null,
    last_completed_at: null,
    notes: '',
    ...overrides,
  } as Task
}

describe('Tracked items and the front door', () => {
  test('DV-010: a weekly quota is always in the panel set, whatever its rule says about today', () => {
    // FREQ=WEEKLY with no BYDAY occurs on the epoch weekday (a Wednesday);
    // today is Thursday. The stale due_at is last week's 1:00 PM.
    const eggs = task({
      title: 'Eggs',
      rrule: 'FREQ=WEEKLY',
      due_at: '2026-08-27T18:00:00.000Z',
      progress_target: 2,
      progress_current: 1,
    })
    // Control: the same rule on an ordinary task is not a quota.
    const routine = task({ title: 'Wednesday thing', rrule: 'FREQ=WEEKLY', due_at: eggs.due_at })

    expect(trackedItems([routine, eggs]).map((t) => t.title)).toEqual(['Eggs'])
  })

  test('DV-014: the folded summary caps each quota at its target', () => {
    const summary = trackSummary([
      { progress_target: 4, progress_current: 1 },
      { progress_target: 2, progress_current: 3 }, // overflow counts as 2, not 3
      { progress_target: 3, progress_current: 0 },
    ])
    expect(summary).toEqual({ done: 3, total: 9 })
  })

  test('DV-012: the panel set is alphabetical, skips done quotas, and never reorders on a tap', () => {
    const swim = task({ title: 'Swim lessons', rrule: 'FREQ=WEEKLY', progress_target: 2 })
    const beef = task({ title: 'bean soup', rrule: 'FREQ=WEEKLY', progress_target: 4 })
    const eggs = task({
      title: 'Eggs',
      rrule: 'FREQ=WEEKLY',
      progress_target: 3,
      progress_current: 3,
    })
    const finished = task({ title: 'Archived quota', progress_target: 2, done: true })
    const plain = task({ title: 'Not a quota' })
    const before = trackedItems([swim, beef, eggs, finished, plain]).map((t) => t.title)
    expect(before).toEqual(['bean soup', 'Eggs', 'Swim lessons'])
    // Logging changes counts, never position.
    const after = trackedItems([
      swim,
      { ...beef, progress_current: 4 },
      { ...eggs, progress_current: 0 },
    ]).map((t) => t.title)
    expect(after).toEqual(before)
  })
})
