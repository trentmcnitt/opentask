/**
 * Tests for field-labels.ts — shared field labels and undo/redo description formatters.
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
} from '@/lib/field-labels'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'
import { updateTask } from '@/core/tasks/update'
import { getDb } from '@/core/db'
import { executeUndo } from '@/core/undo'

const TZ = 'America/Chicago'

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
  test('snooze only', () => {
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
    // Should start with Snoozed and include a target
    expect(result).toMatch(/^Snoozed "Buy groceries" to /)
  })

  test('snooze + priority change', () => {
    vi.setSystemTime(new Date('2026-01-15T16:00:00Z'))
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
    expect(result).toMatch(/^Snoozed "Buy groceries" to /)
    expect(result).toContain('Priority Medium \u2192 High')
    vi.useRealTimers()
  })

  test('priority only shows from/to', () => {
    const result = formatEditDescription('Buy groceries', ['priority'], {
      isSnooze: false,
      beforeState: { id: 1, priority: 2 },
      afterState: { id: 1, priority: 3 },
      userTimezone: TZ,
    })
    expect(result).toBe('Priority Medium \u2192 High on "Buy groceries"')
  })

  test('priority + other fields', () => {
    const result = formatEditDescription('Buy groceries', ['priority', 'rrule', 'anchor_time'], {
      isSnooze: false,
      beforeState: { id: 1, priority: 1 },
      afterState: { id: 1, priority: 4 },
      userTimezone: TZ,
    })
    expect(result).toBe('Priority Low \u2192 Urgent, updated recurrence on "Buy groceries"')
  })

  test('single non-priority field', () => {
    const result = formatEditDescription('Buy groceries', ['rrule', 'anchor_time', 'anchor_dow'], {
      isSnooze: false,
      beforeState: { id: 1 },
      afterState: { id: 1 },
      userTimezone: TZ,
    })
    expect(result).toBe('Updated recurrence on "Buy groceries"')
  })

  test('two non-priority fields', () => {
    const result = formatEditDescription('Buy groceries', ['rrule', 'meta_notes'], {
      isSnooze: false,
      beforeState: { id: 1 },
      afterState: { id: 1 },
      userTimezone: TZ,
    })
    expect(result).toBe('Updated recurrence and notes on "Buy groceries"')
  })

  test('many fields', () => {
    const result = formatEditDescription(
      'Buy groceries',
      ['title', 'priority', 'rrule', 'due_at'],
      {
        isSnooze: false,
        beforeState: { id: 1, priority: 0 },
        afterState: { id: 1, priority: 2 },
        userTimezone: TZ,
      },
    )
    // Priority + 3 others = priority fragment + "updated 3 fields"
    expect(result).toContain('Priority None \u2192 Medium')
    expect(result).toContain('on "Buy groceries"')
  })

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

  test('priority change undo description includes from/to values', () => {
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
    expect(log.description).toBe('Priority Medium \u2192 Urgent on "Test Task"')
  })

  test('snooze undo description includes target time', () => {
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
    expect(log.description).toBe('Snoozed "Test Task" to tomorrow 9:00 AM')
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
