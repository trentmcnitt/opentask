/**
 * DV-010 / DV-011: tracked items (Track, §5) are always on the Today front
 * door, in the un-slotted group, regardless of what their rrule says about
 * today (§7.3: "they must not become invisible from the front door").
 *
 * Why this needs pinning: the §9 migration rewrote quota rules to the bare
 * period ("FREQ=WEEKLY"), which rrule.js places on one weekday. Read as an
 * occurrence, an "eggs 2x/week" row would appear one day in seven. It is a
 * counter over the week, so the week containing today is its day, every day.
 */
import { describe, expect, test } from 'vitest'
import { groupByTimeSlot, UNSLOTTED_LABEL } from '@/lib/slot-view'
import type { TimeSlot } from '@/lib/time-slot-assign'
import type { Task } from '@/types'

const TZ = 'America/Chicago'
const NOW = new Date('2026-09-03T16:00:00Z') // Thursday, 11:00 local
const SLOTS: TimeSlot[] = [
  { id: 1, user_id: 1, label: 'Early morning', start_time: '07:00', sort_order: 0, created_at: '' },
  { id: 2, user_id: 1, label: 'Midday', start_time: '12:00', sort_order: 1, created_at: '' },
]

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

describe('Tracked items on the Today front door', () => {
  test('DV-010: a weekly quota not "occurring" today still lands in Anytime today', () => {
    // FREQ=WEEKLY with no BYDAY occurs on the epoch weekday (a Wednesday);
    // today is Thursday. The stale due_at is last week's 1:00 PM.
    const eggs = task({
      title: 'Eggs',
      rrule: 'FREQ=WEEKLY',
      due_at: '2026-08-27T18:00:00.000Z',
      progress_target: 2,
      progress_current: 1,
    })
    // Control: the same rule on an ordinary task is correctly NOT today.
    const routine = task({ title: 'Wednesday thing', rrule: 'FREQ=WEEKLY', due_at: eggs.due_at })

    const groups = groupByTimeSlot([routine, eggs], SLOTS, TZ, NOW)
    const anytime = groups.find((g) => g.label === UNSLOTTED_LABEL)
    expect(anytime?.tasks.map((t) => t.title)).toEqual(['Eggs'])
    expect(groups.flatMap((g) => g.tasks).some((t) => t.title === 'Wednesday thing')).toBe(false)
  })

  test('DV-011: a quota with a due time of day is still un-slotted, and leads the group', () => {
    // Its due_at names 1:00 PM today; that is the period boundary, not a slot.
    const eggs = task({
      title: 'Eggs',
      rrule: 'FREQ=WEEKLY',
      due_at: '2026-09-03T18:00:00.000Z',
      progress_target: 2,
    })
    const undated = task({ title: 'Undated one-off' })
    const midday = task({
      title: 'Lunch walk',
      anchor_time: '12:30',
      due_at: '2026-09-03T17:30:00.000Z',
    })

    const groups = groupByTimeSlot([undated, midday, eggs], SLOTS, TZ, NOW)
    expect(groups.map((g) => g.label)).toEqual(['Early morning', 'Midday', UNSLOTTED_LABEL])
    expect(groups.find((g) => g.label === 'Midday')?.tasks.map((t) => t.title)).toEqual([
      'Lunch walk',
    ])
    expect(groups.find((g) => g.label === UNSLOTTED_LABEL)?.tasks.map((t) => t.title)).toEqual([
      'Eggs',
      'Undated one-off',
    ])
  })

  test('DV-012: a day with only quotas is not an empty day', () => {
    const eggs = task({ title: 'Eggs', rrule: 'FREQ=WEEKLY', progress_target: 3 })
    const groups = groupByTimeSlot([eggs], SLOTS, TZ, NOW)
    expect(groups.length).toBeGreaterThan(0)
    expect(groups.find((g) => g.label === UNSLOTTED_LABEL)?.tasks).toHaveLength(1)
  })
})
