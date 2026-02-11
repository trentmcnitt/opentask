/**
 * Clipboard formatting tests for formatTasksForClipboard.
 *
 * Tests the human-readable text output used when copying selected tasks via Cmd+C.
 * The function receives pre-grouped, pre-sorted ClipboardGroup[] that mirrors the
 * screen grouping (time buckets or projects) with sort context.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { formatTasksForClipboard, type ClipboardGroup } from '@/lib/format-task'
import type { Task } from '@/types'
import type { SortOption } from '@/hooks/useGroupSort'

const TIMEZONE = 'America/Chicago'

// Freeze time so formatDueTimeParts produces deterministic output
beforeEach(() => {
  // Jan 15, 2026 at 10am Chicago (16:00 UTC)
  vi.setSystemTime(new Date('2026-01-15T16:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
})

function makeTask(overrides: Partial<Task> & { id: number; title: string }): Task {
  return {
    user_id: 1,
    project_id: 1,
    done: false,
    done_at: null,
    priority: 0,
    due_at: null,
    rrule: null,
    recurrence_mode: 'from_due',
    anchor_time: null,
    anchor_dow: null,
    anchor_dom: null,
    original_title: null,
    original_due_at: null,
    last_notified_at: null,
    auto_snooze_minutes: null,
    deleted_at: null,
    archived_at: null,
    labels: [],
    completion_count: 0,
    snooze_count: 0,
    first_completed_at: null,
    last_completed_at: null,
    meta_notes: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function makeGroup(
  overrides: Partial<ClipboardGroup> & { label: string; tasks: Task[] },
): ClipboardGroup {
  return {
    sort: 'due_date' as SortOption,
    reversed: false,
    ...overrides,
  }
}

describe('formatTasksForClipboard', () => {
  test('empty groups returns empty string', () => {
    expect(formatTasksForClipboard([], TIMEZONE)).toBe('')
  })

  test('single task with no metadata', () => {
    const groups = [
      makeGroup({
        label: 'Today',
        tasks: [makeTask({ id: 1, title: 'Clean kitchen' })],
      }),
    ]
    const result = formatTasksForClipboard(groups, TIMEZONE)
    expect(result).toBe('Today (Soonest First):\nClean kitchen')
  })

  test('single task with due date only', () => {
    const groups = [
      makeGroup({
        label: 'Tomorrow',
        tasks: [
          makeTask({
            id: 1,
            title: 'Buy groceries',
            due_at: '2026-01-16T21:00:00Z',
          }),
        ],
      }),
    ]
    const result = formatTasksForClipboard(groups, TIMEZONE)
    expect(result).toBe('Tomorrow (Soonest First):\nBuy groceries (Tomorrow 3:00 PM)')
  })

  test('single task with all metadata', () => {
    const groups = [
      makeGroup({
        label: 'Today',
        tasks: [
          makeTask({
            id: 1,
            title: 'Team standup',
            due_at: '2026-01-15T16:00:00Z',
            rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
            anchor_time: '09:00',
            priority: 3,
            labels: ['meetings'],
          }),
        ],
      }),
    ]
    const result = formatTasksForClipboard(groups, TIMEZONE)
    expect(result).toContain('Today (Soonest First):')
    expect(result).toContain('Team standup (')
    expect(result).toContain('Daily at 9:00 AM')
    expect(result).toContain('High')
    expect(result).toContain('meetings')
  })

  test('multiple tasks in same group use bullet prefix', () => {
    const groups = [
      makeGroup({
        label: 'Work',
        tasks: [makeTask({ id: 1, title: 'Task A' }), makeTask({ id: 2, title: 'Task B' })],
      }),
    ]
    const result = formatTasksForClipboard(groups, TIMEZONE)
    expect(result).toBe('Work (Soonest First):\n- Task A\n- Task B')
  })

  test('multiple groups separated by blank lines', () => {
    const groups = [
      makeGroup({
        label: 'Overdue',
        tasks: [makeTask({ id: 1, title: 'Review PR' }), makeTask({ id: 2, title: 'Standup' })],
      }),
      makeGroup({
        label: 'Today',
        tasks: [makeTask({ id: 3, title: 'Buy groceries' })],
      }),
    ]
    const result = formatTasksForClipboard(groups, TIMEZONE)
    const lines = result.split('\n')
    expect(lines[0]).toBe('Overdue (Soonest First):')
    expect(lines[1]).toBe('- Review PR')
    expect(lines[2]).toBe('- Standup')
    expect(lines[3]).toBe('') // blank line between groups
    expect(lines[4]).toBe('Today (Soonest First):')
    expect(lines[5]).toBe('Buy groceries') // single task in group — no bullet
  })

  test('priority None (0) is omitted from metadata', () => {
    const groups = [
      makeGroup({
        label: 'Today',
        tasks: [makeTask({ id: 1, title: 'Task', priority: 0 })],
      }),
    ]
    const result = formatTasksForClipboard(groups, TIMEZONE)
    expect(result).toBe('Today (Soonest First):\nTask')
  })

  test('priority values are labeled correctly', () => {
    const groups = [
      makeGroup({
        label: 'Work',
        tasks: [
          makeTask({ id: 1, title: 'Low task', priority: 1 }),
          makeTask({ id: 2, title: 'Medium task', priority: 2 }),
          makeTask({ id: 3, title: 'High task', priority: 3 }),
          makeTask({ id: 4, title: 'Urgent task', priority: 4 }),
        ],
      }),
    ]
    const result = formatTasksForClipboard(groups, TIMEZONE)
    expect(result).toContain('Low task (Low)')
    expect(result).toContain('Medium task (Medium)')
    expect(result).toContain('High task (High)')
    expect(result).toContain('Urgent task (Urgent)')
  })

  test('labels are comma-separated in metadata', () => {
    const groups = [
      makeGroup({
        label: 'Home',
        tasks: [
          makeTask({
            id: 1,
            title: 'Buy groceries',
            labels: ['groceries', 'errands'],
          }),
        ],
      }),
    ]
    const result = formatTasksForClipboard(groups, TIMEZONE)
    expect(result).toBe('Home (Soonest First):\nBuy groceries (groceries, errands)')
  })

  test('metadata order: due date, recurrence, priority, labels', () => {
    const groups = [
      makeGroup({
        label: 'Tomorrow',
        tasks: [
          makeTask({
            id: 1,
            title: 'Task',
            due_at: '2026-01-16T21:00:00Z',
            rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
            priority: 2,
            labels: ['code-review'],
          }),
        ],
      }),
    ]
    const result = formatTasksForClipboard(groups, TIMEZONE)
    const match = result.match(/\((.+)\)$/)
    expect(match).toBeTruthy()
    const parts = match![1].split(', ')
    expect(parts[0]).toBe('Tomorrow 3:00 PM')
    expect(parts[1]).toBe('Daily at 9:00 AM')
    expect(parts[2]).toBe('Medium')
    expect(parts[3]).toBe('code-review')
  })

  test('empty groups are skipped', () => {
    const groups = [
      makeGroup({ label: 'Overdue', tasks: [] }),
      makeGroup({
        label: 'Today',
        tasks: [makeTask({ id: 1, title: 'Only task' })],
      }),
      makeGroup({ label: 'Tomorrow', tasks: [] }),
    ]
    const result = formatTasksForClipboard(groups, TIMEZONE)
    expect(result).toBe('Today (Soonest First):\nOnly task')
  })

  test('recurrence without BYHOUR uses anchor_time', () => {
    const groups = [
      makeGroup({
        label: 'Later This Week',
        tasks: [
          makeTask({
            id: 1,
            title: 'Weekly review',
            rrule: 'FREQ=WEEKLY;BYDAY=FR',
            anchor_time: '14:00',
          }),
        ],
      }),
    ]
    const result = formatTasksForClipboard(groups, TIMEZONE)
    expect(result).toContain('Weekly on Friday at 2:00 PM')
  })

  describe('sort label annotations', () => {
    test('due_date default shows "Soonest First"', () => {
      const groups = [
        makeGroup({
          label: 'Today',
          tasks: [makeTask({ id: 1, title: 'Task' })],
          sort: 'due_date',
          reversed: false,
        }),
      ]
      const result = formatTasksForClipboard(groups, TIMEZONE)
      expect(result).toMatch(/^Today \(Soonest First\):/)
    })

    test('due_date reversed shows "Latest First"', () => {
      const groups = [
        makeGroup({
          label: 'Today',
          tasks: [makeTask({ id: 1, title: 'Task' })],
          sort: 'due_date',
          reversed: true,
        }),
      ]
      const result = formatTasksForClipboard(groups, TIMEZONE)
      expect(result).toMatch(/^Today \(Latest First\):/)
    })

    test('priority default shows "Highest Priority"', () => {
      const groups = [
        makeGroup({
          label: 'Work',
          tasks: [makeTask({ id: 1, title: 'Task' })],
          sort: 'priority',
          reversed: false,
        }),
      ]
      const result = formatTasksForClipboard(groups, TIMEZONE)
      expect(result).toMatch(/^Work \(Highest Priority\):/)
    })

    test('priority reversed shows "Lowest Priority"', () => {
      const groups = [
        makeGroup({
          label: 'Work',
          tasks: [makeTask({ id: 1, title: 'Task' })],
          sort: 'priority',
          reversed: true,
        }),
      ]
      const result = formatTasksForClipboard(groups, TIMEZONE)
      expect(result).toMatch(/^Work \(Lowest Priority\):/)
    })

    test('title default shows "A-Z"', () => {
      const groups = [
        makeGroup({
          label: 'Home',
          tasks: [makeTask({ id: 1, title: 'Task' })],
          sort: 'title',
          reversed: false,
        }),
      ]
      const result = formatTasksForClipboard(groups, TIMEZONE)
      expect(result).toMatch(/^Home \(A-Z\):/)
    })

    test('title reversed shows "Z-A"', () => {
      const groups = [
        makeGroup({
          label: 'Home',
          tasks: [makeTask({ id: 1, title: 'Task' })],
          sort: 'title',
          reversed: true,
        }),
      ]
      const result = formatTasksForClipboard(groups, TIMEZONE)
      expect(result).toMatch(/^Home \(Z-A\):/)
    })

    test('age default shows "Newest First"', () => {
      const groups = [
        makeGroup({
          label: 'No Date',
          tasks: [makeTask({ id: 1, title: 'Task' })],
          sort: 'age',
          reversed: false,
        }),
      ]
      const result = formatTasksForClipboard(groups, TIMEZONE)
      expect(result).toMatch(/^No Date \(Newest First\):/)
    })

    test('age reversed shows "Oldest First"', () => {
      const groups = [
        makeGroup({
          label: 'No Date',
          tasks: [makeTask({ id: 1, title: 'Task' })],
          sort: 'age',
          reversed: true,
        }),
      ]
      const result = formatTasksForClipboard(groups, TIMEZONE)
      expect(result).toMatch(/^No Date \(Oldest First\):/)
    })

    test('modified default shows "Recently Modified"', () => {
      const groups = [
        makeGroup({
          label: 'Overdue',
          tasks: [makeTask({ id: 1, title: 'Task' })],
          sort: 'modified',
          reversed: false,
        }),
      ]
      const result = formatTasksForClipboard(groups, TIMEZONE)
      expect(result).toMatch(/^Overdue \(Recently Modified\):/)
    })

    test('modified reversed shows "Least Recently Modified"', () => {
      const groups = [
        makeGroup({
          label: 'Overdue',
          tasks: [makeTask({ id: 1, title: 'Task' })],
          sort: 'modified',
          reversed: true,
        }),
      ]
      const result = formatTasksForClipboard(groups, TIMEZONE)
      expect(result).toMatch(/^Overdue \(Least Recently Modified\):/)
    })
  })

  test('different sort options per group', () => {
    const groups = [
      makeGroup({
        label: 'Overdue',
        tasks: [makeTask({ id: 1, title: 'Fix bug' })],
        sort: 'priority',
        reversed: false,
      }),
      makeGroup({
        label: 'Today',
        tasks: [makeTask({ id: 2, title: 'Call dentist' })],
        sort: 'due_date',
        reversed: false,
      }),
    ]
    const result = formatTasksForClipboard(groups, TIMEZONE)
    const lines = result.split('\n')
    expect(lines[0]).toBe('Overdue (Highest Priority):')
    expect(lines[3]).toBe('Today (Soonest First):')
  })
})
