import { describe, test, expect, beforeAll } from 'vitest'
import { setupTestDb, TEST_USER_ID } from '../helpers/setup'
import { getDb } from '@/core/db'
import { exportUserData, tasksToCsv, projectsToCsv } from '@/core/export'
import type { FormattedTask } from '@/lib/format-task'
import type { Project } from '@/types'

describe('Data export', () => {
  beforeAll(() => {
    setupTestDb()

    const db = getDb()
    const now = new Date().toISOString()

    // Create a few tasks with various states
    db.prepare(
      `INSERT INTO tasks (id, user_id, project_id, title, done, priority, due_at, labels, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      100,
      TEST_USER_ID,
      1,
      'Active task',
      0,
      2,
      now,
      '["work","urgent"]',
      'Some notes',
      now,
      now,
    )

    db.prepare(
      `INSERT INTO tasks (id, user_id, project_id, title, done, done_at, priority, labels, archived_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(101, TEST_USER_ID, 1, 'Done task', 1, now, 1, '[]', now, now, now)

    db.prepare(
      `INSERT INTO tasks (id, user_id, project_id, title, done, priority, labels, deleted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(102, TEST_USER_ID, 1, 'Trashed task', 0, 0, '[]', now, now, now)

    // Add a completion record
    db.prepare(`INSERT INTO completions (task_id, user_id, completed_at) VALUES (?, ?, ?)`).run(
      101,
      TEST_USER_ID,
      now,
    )
  })

  describe('exportUserData', () => {
    test('returns tasks, projects, and completions', () => {
      const data = exportUserData(TEST_USER_ID)

      expect(data.tasks.length).toBeGreaterThanOrEqual(3)
      expect(data.projects.length).toBeGreaterThanOrEqual(1)
      expect(data.completions.length).toBeGreaterThanOrEqual(1)

      const taskIds = data.tasks.map((t) => t.id)
      expect(taskIds).toContain(100) // active
      expect(taskIds).toContain(101) // done/archived
      expect(taskIds).toContain(102) // trashed
    })

    test('tasks include computed fields is_recurring and is_snoozed', () => {
      const data = exportUserData(TEST_USER_ID)
      const task = data.tasks.find((t) => t.id === 100)!
      expect(task).toHaveProperty('is_recurring')
      expect(task).toHaveProperty('is_snoozed')
    })
  })

  describe('tasksToCsv', () => {
    test('produces header row with correct columns', () => {
      const csv = tasksToCsv([])
      const header = csv.split('\n')[0]
      expect(header).toContain('"id"')
      expect(header).toContain('"title"')
      expect(header).toContain('"done"')
      expect(header).toContain('"priority"')
      expect(header).toContain('"labels"')
      expect(header).toContain('"is_recurring"')
      expect(header).toContain('"is_snoozed"')
    })

    test('empty data produces header-only CSV', () => {
      const csv = tasksToCsv([])
      const lines = csv.split('\n')
      expect(lines).toHaveLength(1) // header only
    })

    test('labels are joined with semicolons', () => {
      const task = makeFakeTask({ id: 1, labels: ['work', 'urgent', 'home'] })
      const csv = tasksToCsv([task])
      const dataRow = csv.split('\n')[1]
      expect(dataRow).toContain('"work;urgent;home"')
    })

    test('quotes are escaped by doubling', () => {
      const task = makeFakeTask({ id: 1, title: 'Task with "quotes" inside' })
      const csv = tasksToCsv([task])
      const dataRow = csv.split('\n')[1]
      expect(dataRow).toContain('"Task with ""quotes"" inside"')
    })

    test('formula injection prevention — equals sign', () => {
      const task = makeFakeTask({ id: 1, title: '=SUM(A1:A10)' })
      const csv = tasksToCsv([task])
      const dataRow = csv.split('\n')[1]
      expect(dataRow).toContain('"\'=SUM(A1:A10)"')
    })

    test('formula injection prevention — plus sign', () => {
      const task = makeFakeTask({ id: 1, title: '+cmd|stuff' })
      const csv = tasksToCsv([task])
      const dataRow = csv.split('\n')[1]
      expect(dataRow).toContain('"\'+cmd|stuff"')
    })

    test('formula injection prevention — minus sign', () => {
      const task = makeFakeTask({ id: 1, title: '-cmd|stuff' })
      const csv = tasksToCsv([task])
      const dataRow = csv.split('\n')[1]
      expect(dataRow).toContain('"\'-cmd|stuff"')
    })

    test('formula injection prevention — at sign', () => {
      const task = makeFakeTask({ id: 1, title: '@SUM(A1)' })
      const csv = tasksToCsv([task])
      const dataRow = csv.split('\n')[1]
      expect(dataRow).toContain('"\'@SUM(A1)"')
    })

    test('formula injection prevention — tab character', () => {
      const task = makeFakeTask({ id: 1, title: '\tcmd' })
      const csv = tasksToCsv([task])
      const dataRow = csv.split('\n')[1]
      expect(dataRow).toContain('"\'\tcmd"')
    })

    test('formula injection prevention — carriage return', () => {
      const task = makeFakeTask({ id: 1, title: '\rcmd' })
      const csv = tasksToCsv([task])
      const dataRow = csv.split('\n')[1]
      expect(dataRow).toContain('"\'\rcmd"')
    })

    test('normal titles are not prefixed', () => {
      const task = makeFakeTask({ id: 1, title: 'Buy groceries' })
      const csv = tasksToCsv([task])
      const dataRow = csv.split('\n')[1]
      expect(dataRow).toContain('"Buy groceries"')
    })
  })

  describe('CSV edge cases', () => {
    test('null due_at produces empty CSV field', () => {
      const task = makeFakeTask({ id: 1, due_at: null })
      const csv = tasksToCsv([task])
      const dataRow = csv.split('\n')[1]
      const fields = dataRow.match(/"[^"]*"|""/g)!
      // due_at is the 5th column (0-indexed: id, title, done, priority, due_at)
      expect(fields[4]).toBe('""')
    })

    test('newlines in notes are preserved inside quoted CSV field', () => {
      const task = makeFakeTask({ id: 1, notes: 'Line 1\nLine 2\nLine 3' })
      const csv = tasksToCsv([task])
      // The notes field should contain the newlines within quotes
      expect(csv).toContain('"Line 1\nLine 2\nLine 3"')
    })

    test('labels containing semicolons are preserved in value', () => {
      const task = makeFakeTask({ id: 1, labels: ['sales;marketing', 'urgent'] })
      const csv = tasksToCsv([task])
      const dataRow = csv.split('\n')[1]
      expect(dataRow).toContain('"sales;marketing;urgent"')
    })

    test('null notes produces empty CSV field', () => {
      const task = makeFakeTask({ id: 1, notes: null })
      const csv = tasksToCsv([task])
      const dataRow = csv.split('\n')[1]
      // Notes column should be an empty quoted string
      expect(dataRow).toContain('""')
    })

    test('each data row has same number of columns as header', () => {
      const tasks = [
        makeFakeTask({ id: 1, title: 'Task A', labels: ['a', 'b'], notes: 'Some notes' }),
        makeFakeTask({ id: 2, title: 'Task B', due_at: null, notes: null }),
      ]
      const csv = tasksToCsv(tasks)
      const lines = csv.split('\n')
      const headerColCount = lines[0].split(',').length
      for (let i = 1; i < lines.length; i++) {
        // Count commas to check column count (all fields are quoted, so commas inside quotes won't interfere)
        const rowColCount = lines[i].split(',').length
        expect(rowColCount).toBe(headerColCount)
      }
    })
  })

  describe('Export limits', () => {
    test('exportUserData caps at 10,000 tasks', () => {
      const db = getDb()
      const now = new Date().toISOString()

      // Batch insert 10,001 tasks using a prepared statement
      const insert = db.prepare(
        `INSERT INTO tasks (user_id, project_id, title, done, priority, labels, created_at, updated_at)
         VALUES (?, 1, ?, 0, 0, '[]', ?, ?)`,
      )
      const batchInsert = db.transaction(() => {
        for (let i = 0; i < 10001; i++) {
          insert.run(TEST_USER_ID, `Limit task ${i}`, now, now)
        }
      })
      batchInsert()

      const data = exportUserData(TEST_USER_ID)
      expect(data.tasks.length).toBe(10000)
    })
  })

  describe('projectsToCsv', () => {
    test('produces header row with correct columns', () => {
      const csv = projectsToCsv([])
      const header = csv.split('\n')[0]
      expect(header).toContain('"id"')
      expect(header).toContain('"name"')
      expect(header).toContain('"sort_order"')
      expect(header).toContain('"color"')
      expect(header).toContain('"active_count"')
      expect(header).toContain('"overdue_count"')
      expect(header).toContain('"created_at"')
    })

    test('empty data produces header-only CSV', () => {
      const csv = projectsToCsv([])
      const lines = csv.split('\n')
      expect(lines).toHaveLength(1)
    })

    test('project data is correctly formatted', () => {
      const project: Project = {
        id: 1,
        name: 'Test Project',
        owner_id: 1,
        shared: false,
        sort_order: 0,
        color: null,
        active_count: 5,
        overdue_count: 2,
        created_at: '2026-01-01T00:00:00Z',
      }
      const csv = projectsToCsv([project])
      const dataRow = csv.split('\n')[1]
      expect(dataRow).toContain('"Test Project"')
      expect(dataRow).toContain('"5"')
      expect(dataRow).toContain('"2"')
    })
  })
})

/**
 * Helper to create a minimal FormattedTask for CSV testing.
 */
function makeFakeTask(overrides: Partial<FormattedTask>): FormattedTask {
  return {
    id: 1,
    user_id: 1,
    project_id: 1,
    title: 'Test task',
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
    completion_count: 0,
    snooze_count: 0,
    first_completed_at: null,
    last_completed_at: null,
    notes: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    is_recurring: false,
    is_snoozed: false,
    ...overrides,
  }
}
