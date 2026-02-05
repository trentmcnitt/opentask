/**
 * Tests for field-labels.ts — shared field labels and unified toast description formatters.
 *
 * Pure function tests (no DB, no HTTP) plus integration-level tests that verify
 * undo descriptions flow through updateTask() correctly.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  formatFieldSummary,
  formatSnoozeTarget,
  formatEditDescription,
  formatBulkEditDescription,
  truncateTitle,
} from '@/lib/field-labels'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'
import { updateTask } from '@/core/tasks/update'
import { getDb } from '@/core/db'
import { executeUndo } from '@/core/undo'

const TZ = 'America/Chicago'

describe('truncateTitle', () => {
  test('short title unchanged', () => {
    expect(truncateTitle('Buy groceries')).toBe('Buy groceries')
  })

  test('exactly maxLen unchanged', () => {
    expect(truncateTitle('12345678901234567890')).toBe('12345678901234567890')
  })

  test('longer than maxLen truncated with ellipsis', () => {
    expect(truncateTitle('This is a very long task title')).toBe('This is a very lo...')
  })

  test('custom maxLen', () => {
    expect(truncateTitle('Buy groceries now', 16)).toBe('Buy groceries...')
  })

  test('custom maxLen short enough', () => {
    expect(truncateTitle('Short', 16)).toBe('Short')
  })
})

describe('formatFieldSummary', () => {
  test('single user-facing field', () => {
    expect(formatFieldSummary(['priority'])).toBe('priority')
  })

  test('two user-facing fields', () => {
    expect(formatFieldSummary(['priority', 'due_at'])).toBe('priority and due date')
  })

  test('three+ user-facing fields', () => {
    expect(formatFieldSummary(['priority', 'due_at', 'rrule'])).toBe('3 fields')
  })

  test('internal-only fields return null', () => {
    expect(formatFieldSummary(['anchor_time', 'anchor_dow', 'snooze_count'])).toBeNull()
  })

  test('mixed internal and user-facing fields', () => {
    expect(formatFieldSummary(['priority', 'anchor_time', 'snooze_count'])).toBe('priority')
  })

  test('empty array returns null', () => {
    expect(formatFieldSummary([])).toBeNull()
  })
})

describe('formatSnoozeTarget', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  test('same day shows time only', () => {
    // Freeze at Jan 15, 2026 10:00 AM Chicago (16:00 UTC)
    vi.setSystemTime(new Date('2026-01-15T16:00:00Z'))
    // Target: Jan 15, 2026 5:00 PM Chicago (23:00 UTC)
    const result = formatSnoozeTarget('2026-01-15T23:00:00Z', TZ)
    expect(result).toBe('5:00 PM')
  })

  test('tomorrow shows "tomorrow" with time', () => {
    vi.setSystemTime(new Date('2026-01-15T16:00:00Z'))
    // Target: Jan 16, 2026 9:00 AM Chicago (15:00 UTC)
    const result = formatSnoozeTarget('2026-01-16T15:00:00Z', TZ)
    expect(result).toBe('tomorrow 9:00 AM')
  })

  test('within 7 days shows day name with time', () => {
    vi.setSystemTime(new Date('2026-01-15T16:00:00Z')) // Thursday
    // Target: Jan 19, 2026 9:00 AM Chicago (15:00 UTC) — Monday
    const result = formatSnoozeTarget('2026-01-19T15:00:00Z', TZ)
    expect(result).toBe('Mon 9:00 AM')
  })

  test('beyond 7 days shows date with time', () => {
    vi.setSystemTime(new Date('2026-01-15T16:00:00Z'))
    // Target: Jan 25, 2026 9:00 AM Chicago (15:00 UTC)
    const result = formatSnoozeTarget('2026-01-25T15:00:00Z', TZ)
    expect(result).toBe('Jan 25 9:00 AM')
  })
})

describe('formatEditDescription', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-01-15T16:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // --- Priority fragments ---

  test('priority set from None', () => {
    const result = formatEditDescription('Buy groceries', ['priority'], {
      isSnooze: false,
      beforeState: { id: 1, priority: 0 },
      afterState: { id: 1, priority: 3 },
      userTimezone: TZ,
    })
    expect(result).toBe('Priority set to High \u2014 "Buy groceries"')
  })

  test('priority change between values', () => {
    const result = formatEditDescription('Buy groceries', ['priority'], {
      isSnooze: false,
      beforeState: { id: 1, priority: 2 },
      afterState: { id: 1, priority: 3 },
      userTimezone: TZ,
    })
    expect(result).toBe('Priority Medium \u2192 High \u2014 "Buy groceries"')
  })

  test('priority cleared', () => {
    const result = formatEditDescription('Buy groceries', ['priority'], {
      isSnooze: false,
      beforeState: { id: 1, priority: 3 },
      afterState: { id: 1, priority: 0 },
      userTimezone: TZ,
    })
    expect(result).toBe('Priority cleared \u2014 "Buy groceries"')
  })

  // --- Snooze fragments ---

  test('snooze with delta', () => {
    const result = formatEditDescription(
      'Buy groceries',
      ['due_at', 'original_due_at', 'snooze_count'],
      {
        isSnooze: true,
        beforeState: { id: 1, due_at: '2026-01-15T15:00:00Z' },
        afterState: { id: 1, due_at: '2026-01-19T15:00:00Z' },
        userTimezone: TZ,
      },
    )
    expect(result).toBe('Snoozed to Mon 9:00 AM (+4d) \u2014 "Buy groceries"')
  })

  test('snooze + priority change', () => {
    const result = formatEditDescription(
      'Buy groceries',
      ['due_at', 'original_due_at', 'snooze_count', 'priority'],
      {
        isSnooze: true,
        beforeState: { id: 1, due_at: '2026-01-15T15:00:00Z', priority: 2 },
        afterState: { id: 1, due_at: '2026-01-19T15:00:00Z', priority: 3 },
        userTimezone: TZ,
      },
    )
    expect(result).toContain('Snoozed to Mon 9:00 AM (+4d)')
    expect(result).toContain('Priority Medium \u2192 High')
    expect(result).toContain('\u2014 "Buy groceries"')
  })

  // --- Due date (non-snooze) ---

  test('due date set (non-snooze)', () => {
    const result = formatEditDescription('Buy groceries', ['due_at'], {
      isSnooze: false,
      beforeState: { id: 1, due_at: null },
      afterState: { id: 1, due_at: '2026-01-19T15:00:00Z' },
      userTimezone: TZ,
    })
    expect(result).toBe('Due date set \u2014 "Buy groceries"')
  })

  test('due date cleared', () => {
    const result = formatEditDescription('Buy groceries', ['due_at'], {
      isSnooze: false,
      beforeState: { id: 1, due_at: '2026-01-15T15:00:00Z' },
      afterState: { id: 1, due_at: null },
      userTimezone: TZ,
    })
    expect(result).toBe('Due date cleared \u2014 "Buy groceries"')
  })

  // --- Recurrence fragments ---

  test('recurrence set', () => {
    const result = formatEditDescription('Buy groceries', ['rrule', 'anchor_time', 'anchor_dow'], {
      isSnooze: false,
      beforeState: { id: 1, rrule: null },
      afterState: { id: 1, rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0', anchor_time: '09:00' },
      userTimezone: TZ,
    })
    expect(result).toBe('Recurrence set to Daily at 9:00 AM \u2014 "Buy groceries"')
  })

  test('recurrence changed', () => {
    const result = formatEditDescription('Buy groceries', ['rrule', 'anchor_time', 'anchor_dow'], {
      isSnooze: false,
      beforeState: { id: 1, rrule: 'FREQ=DAILY' },
      afterState: { id: 1, rrule: 'FREQ=WEEKLY;BYDAY=MO', anchor_time: '09:00' },
      userTimezone: TZ,
    })
    expect(result).toBe('Recurrence set to Mondays at 9:00 AM \u2014 "Buy groceries"')
  })

  test('recurrence cleared', () => {
    const result = formatEditDescription(
      'Buy groceries',
      ['rrule', 'anchor_time', 'anchor_dow', 'anchor_dom'],
      {
        isSnooze: false,
        beforeState: { id: 1, rrule: 'FREQ=DAILY' },
        afterState: { id: 1, rrule: null },
        userTimezone: TZ,
      },
    )
    expect(result).toBe('Recurrence cleared \u2014 "Buy groceries"')
  })

  // --- Project fragment ---

  test('project change with name', () => {
    const result = formatEditDescription('Buy groceries', ['project_id'], {
      isSnooze: false,
      beforeState: { id: 1, project_id: 1 },
      afterState: { id: 1, project_id: 2 },
      userTimezone: TZ,
      projectName: 'Work',
    })
    expect(result).toBe('Moved to Work \u2014 "Buy groceries"')
  })

  test('project change without name', () => {
    const result = formatEditDescription('Buy groceries', ['project_id'], {
      isSnooze: false,
      beforeState: { id: 1, project_id: 1 },
      afterState: { id: 1, project_id: 2 },
      userTimezone: TZ,
    })
    expect(result).toBe('Project updated \u2014 "Buy groceries"')
  })

  // --- Title rename ---

  test('title rename', () => {
    const result = formatEditDescription('New title', ['title'], {
      isSnooze: false,
      beforeState: { id: 1, title: 'Old title' },
      afterState: { id: 1, title: 'New title' },
      userTimezone: TZ,
    })
    expect(result).toBe('Renamed "Old title" \u2192 "New title"')
  })

  test('title rename with truncation', () => {
    const result = formatEditDescription('A very long new title here', ['title'], {
      isSnooze: false,
      beforeState: { id: 1, title: 'A very long old title here' },
      afterState: { id: 1, title: 'A very long new title here' },
      userTimezone: TZ,
    })
    expect(result).toBe('Renamed "A very long o..." \u2192 "A very long n..."')
  })

  // --- Labels and notes ---

  test('labels updated', () => {
    const result = formatEditDescription('Buy groceries', ['labels'], {
      isSnooze: false,
      beforeState: { id: 1 },
      afterState: { id: 1 },
      userTimezone: TZ,
    })
    expect(result).toBe('Labels updated \u2014 "Buy groceries"')
  })

  test('notes updated', () => {
    const result = formatEditDescription('Buy groceries', ['meta_notes'], {
      isSnooze: false,
      beforeState: { id: 1 },
      afterState: { id: 1 },
      userTimezone: TZ,
    })
    expect(result).toBe('Notes updated \u2014 "Buy groceries"')
  })

  // --- Two-field combos ---

  test('snooze + priority (two fields)', () => {
    const result = formatEditDescription(
      'Buy groceries',
      ['due_at', 'original_due_at', 'snooze_count', 'priority'],
      {
        isSnooze: true,
        beforeState: { id: 1, due_at: '2026-01-15T15:00:00Z', priority: 0 },
        afterState: { id: 1, due_at: '2026-01-16T15:00:00Z', priority: 3 },
        userTimezone: TZ,
      },
    )
    // Two user-facing fields: due_at + priority → fragment, fragment — title
    expect(result).toContain('Snoozed to tomorrow 9:00 AM (+1d)')
    expect(result).toContain('Priority set to High')
    expect(result).toContain('\u2014 "Buy groceries"')
  })

  test('recurrence + notes (two fields)', () => {
    const result = formatEditDescription('Buy groceries', ['rrule', 'anchor_time', 'meta_notes'], {
      isSnooze: false,
      beforeState: { id: 1 },
      afterState: { id: 1, rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0', anchor_time: '09:00' },
      userTimezone: TZ,
    })
    expect(result).toBe('Recurrence set to Daily at 9:00 AM, Notes updated \u2014 "Buy groceries"')
  })

  // --- Three+ fields ---

  test('three+ fields uses field names', () => {
    const result = formatEditDescription(
      'Buy groceries',
      ['priority', 'due_at', 'rrule', 'anchor_time'],
      {
        isSnooze: false,
        beforeState: { id: 1, priority: 0 },
        afterState: { id: 1, priority: 2 },
        userTimezone: TZ,
      },
    )
    expect(result).toBe('Updated priority, due date, and recurrence \u2014 "Buy groceries"')
  })

  // --- Title truncation in em-dash descriptions ---

  test('long title truncated in description', () => {
    const result = formatEditDescription(
      'This is a very long task title that should be truncated',
      ['priority'],
      {
        isSnooze: false,
        beforeState: { id: 1, priority: 2 },
        afterState: { id: 1, priority: 3 },
        userTimezone: TZ,
      },
    )
    expect(result).toContain('"This is a very lo..."')
  })

  // --- Fallback ---

  test('fallback when only internal fields changed', () => {
    const result = formatEditDescription('Buy groceries', ['anchor_time', 'anchor_dow'], {
      isSnooze: false,
      beforeState: { id: 1 },
      afterState: { id: 1 },
      userTimezone: TZ,
    })
    expect(result).toBe('Edited "Buy groceries"')
  })
})

describe('formatBulkEditDescription', () => {
  test('single field', () => {
    expect(formatBulkEditDescription(3, ['priority'])).toBe('Updated priority on 3 tasks')
  })

  test('two fields', () => {
    expect(formatBulkEditDescription(5, ['priority', 'project_id'])).toBe(
      'Updated priority and project on 5 tasks',
    )
  })

  test('fallback when only internal fields', () => {
    expect(formatBulkEditDescription(2, ['snooze_count', 'original_due_at'])).toBe('Edited 2 tasks')
  })
})

describe('Integration: undo description enrichment', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-01-15T16:00:00Z'))
    setupTestDb()
    // Create a test task
    const db = getDb()
    db.prepare(
      `INSERT INTO tasks (user_id, project_id, title, done, priority, due_at, labels)
       VALUES (?, 1, 'Test Task', 0, 2, '2026-01-15T15:00:00Z', '[]')`,
    ).run(TEST_USER_ID)
  })

  afterEach(() => {
    vi.useRealTimers()
    teardownTestDb()
  })

  test('priority change description uses new format', () => {
    updateTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: 1,
      input: { priority: 4 },
    })

    const db = getDb()
    const log = db
      .prepare('SELECT description FROM undo_log WHERE user_id = ? ORDER BY id DESC LIMIT 1')
      .get(TEST_USER_ID) as { description: string }
    expect(log.description).toBe('Priority Medium \u2192 Urgent \u2014 "Test Task"')
  })

  test('priority set from None uses "set to" format', () => {
    // First clear priority to None
    updateTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: 1,
      input: { priority: 0 },
    })
    // Then set to High
    updateTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: 1,
      input: { priority: 3 },
    })

    const db = getDb()
    const log = db
      .prepare('SELECT description FROM undo_log WHERE user_id = ? ORDER BY id DESC LIMIT 1')
      .get(TEST_USER_ID) as { description: string }
    expect(log.description).toBe('Priority set to High \u2014 "Test Task"')
  })

  test('snooze description includes target and delta', () => {
    // Snooze to tomorrow 9:00 AM Chicago = Jan 16 15:00 UTC
    updateTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: 1,
      input: { due_at: '2026-01-16T15:00:00Z' },
    })

    const db = getDb()
    const log = db
      .prepare('SELECT description FROM undo_log WHERE user_id = ? ORDER BY id DESC LIMIT 1')
      .get(TEST_USER_ID) as { description: string }
    expect(log.description).toBe('Snoozed to tomorrow 9:00 AM (+1d) \u2014 "Test Task"')
  })

  test('updateTask returns description', () => {
    const result = updateTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: 1,
      input: { priority: 4 },
    })
    expect(result.description).toBe('Priority Medium \u2192 Urgent \u2014 "Test Task"')
  })

  test('undo restores previous state after enriched description', () => {
    updateTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: 1,
      input: { priority: 4 },
    })

    const result = executeUndo(TEST_USER_ID)
    expect(result).not.toBeNull()

    // Verify the task was actually restored
    const db = getDb()
    const task = db.prepare('SELECT priority FROM tasks WHERE id = 1').get() as { priority: number }
    expect(task.priority).toBe(2)
  })
})
