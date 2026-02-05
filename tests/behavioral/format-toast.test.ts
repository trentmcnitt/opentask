import { describe, test, expect } from 'vitest'
import { formatChangesToast } from '@/lib/format-toast'

describe('formatChangesToast', () => {
  test('returns "No changes" for empty object', () => {
    expect(formatChangesToast({})).toBe('No changes')
  })

  // Single field changes
  test('returns "Due date updated" when due_at is set', () => {
    expect(formatChangesToast({ due_at: '2026-01-15T17:00:00Z' })).toBe('Due date updated')
  })

  test('returns "Due date cleared" when due_at is null', () => {
    expect(formatChangesToast({ due_at: null })).toBe('Due date cleared')
  })

  test('returns "Recurrence updated" when rrule is set', () => {
    expect(formatChangesToast({ rrule: 'FREQ=DAILY' })).toBe('Recurrence updated')
  })

  test('returns "Recurrence removed" when rrule is null', () => {
    expect(formatChangesToast({ rrule: null })).toBe('Recurrence removed')
  })

  test('returns "Priority updated" for priority change', () => {
    expect(formatChangesToast({ priority: 3 })).toBe('Priority updated')
  })

  test('returns "Title updated" for title change', () => {
    expect(formatChangesToast({ title: 'New title' })).toBe('Title updated')
  })

  test('returns "Labels updated" for labels change', () => {
    expect(formatChangesToast({ labels: ['bug', 'urgent'] })).toBe('Labels updated')
  })

  test('returns "Project updated" for project_id change', () => {
    expect(formatChangesToast({ project_id: 5 })).toBe('Project updated')
  })

  // Two field changes
  test('returns "Updated X and Y" for two fields', () => {
    expect(formatChangesToast({ priority: 2, title: 'New' })).toBe('Updated priority and title')
  })

  test('two fields with due_at', () => {
    expect(formatChangesToast({ due_at: '2026-01-15T17:00:00Z', priority: 3 })).toBe(
      'Updated due date and priority',
    )
  })

  // Three+ field changes
  test('returns "Updated N fields" for 3+ fields', () => {
    expect(formatChangesToast({ priority: 1, title: 'X', labels: ['a'] })).toBe('Updated 3 fields')
  })

  // recurrence_mode is filtered out
  test('filters out recurrence_mode from count', () => {
    expect(formatChangesToast({ recurrence_mode: 'from_due' })).toBe('No changes')
  })

  test('recurrence_mode is not counted alongside other fields', () => {
    expect(formatChangesToast({ priority: 2, recurrence_mode: 'from_due' })).toBe(
      'Priority updated',
    )
  })
})
