/**
 * taskKind: which of quota / reminder / task a row is. The task page picks its
 * editor, home surface and noun from it. Pure — no database.
 */
import { describe, test, expect } from 'vitest'
import { taskKind } from '@/lib/track'

describe('taskKind', () => {
  test('a plain task is a task', () => {
    expect(taskKind({ progress_target: 1, is_tracked: false, is_reminder: false })).toBe('task')
  })

  test('a reminder is a reminder', () => {
    expect(taskKind({ progress_target: 1, is_tracked: false, is_reminder: true })).toBe('reminder')
  })

  test('a target above 1 makes a quota', () => {
    expect(taskKind({ progress_target: 3, is_tracked: false, is_reminder: false })).toBe('quota')
  })

  test('the tracked flag makes a quota at a target of 1', () => {
    expect(taskKind({ progress_target: 1, is_tracked: true, is_reminder: false })).toBe('quota')
  })

  test('quota is checked before reminder', () => {
    expect(taskKind({ progress_target: 2, is_tracked: true, is_reminder: true })).toBe('quota')
  })
})
