/**
 * Pure function tests for the dashboard filter chips' due-today/overdue
 * badges (feat/chip-due-badges, Trent 2026-09-23). No DB, no HTTP.
 */
import { describe, test, expect, afterEach, vi } from 'vitest'
import { classifyChipDueBadge, countChipDueBadges } from '@/lib/chip-due-badges'
import { getTimezoneDayBoundaries } from '@/lib/format-date'

const TZ = 'America/Chicago'

afterEach(() => {
  vi.useRealTimers()
})

describe('classifyChipDueBadge', () => {
  test('due later today → due_today', () => {
    vi.setSystemTime(new Date('2025-02-01T12:00:00Z')) // 6:00 AM CST
    const now = new Date()
    const boundaries = getTimezoneDayBoundaries(TZ, now)
    const badge = classifyChipDueBadge({ due_at: '2025-02-01T18:00:00Z' }, now, boundaries) // noon CST
    expect(badge).toBe('due_today')
  })

  test('due earlier today (already past) → overdue, not due_today', () => {
    vi.setSystemTime(new Date('2025-02-01T15:00:00Z')) // 9:00 AM CST
    const now = new Date()
    const boundaries = getTimezoneDayBoundaries(TZ, now)
    const badge = classifyChipDueBadge({ due_at: '2025-02-01T12:00:00Z' }, now, boundaries) // 6:00 AM CST
    expect(badge).toBe('overdue')
  })

  test('due yesterday → overdue', () => {
    vi.setSystemTime(new Date('2025-02-02T12:00:00Z')) // Feb 2, 6:00 AM CST
    const now = new Date()
    const boundaries = getTimezoneDayBoundaries(TZ, now)
    const badge = classifyChipDueBadge({ due_at: '2025-02-01T15:00:00Z' }, now, boundaries) // Feb 1, 9:00 AM CST
    expect(badge).toBe('overdue')
  })

  test('undated → neither', () => {
    vi.setSystemTime(new Date('2025-02-01T12:00:00Z'))
    const now = new Date()
    const boundaries = getTimezoneDayBoundaries(TZ, now)
    const badge = classifyChipDueBadge({ due_at: null }, now, boundaries)
    expect(badge).toBeNull()
  })

  test('due later than today (this week) → neither', () => {
    vi.setSystemTime(new Date('2025-02-01T12:00:00Z')) // Feb 1, 6:00 AM CST
    const now = new Date()
    const boundaries = getTimezoneDayBoundaries(TZ, now)
    const badge = classifyChipDueBadge({ due_at: '2025-02-03T12:00:00Z' }, now, boundaries) // Feb 3
    expect(badge).toBeNull()
  })

  describe('timezone boundary', () => {
    // now = 2025-02-01 11:00 PM CST = 2025-02-02 05:00 UTC. A raw-UTC-date
    // comparison would place both tasks below on "Feb 2" and get this wrong
    // in opposite directions; the Chicago day boundary is what must decide.
    test('due after midnight UTC but before midnight Chicago → still due_today', () => {
      vi.setSystemTime(new Date('2025-02-02T05:00:00Z'))
      const now = new Date()
      const boundaries = getTimezoneDayBoundaries(TZ, now)
      // 2025-02-01 11:30 PM CST — UTC date is already Feb 2, Chicago date is still Feb 1.
      const badge = classifyChipDueBadge({ due_at: '2025-02-02T05:30:00Z' }, now, boundaries)
      expect(badge).toBe('due_today')
    })

    test('due after midnight Chicago → not due_today (it is tomorrow locally)', () => {
      vi.setSystemTime(new Date('2025-02-02T05:00:00Z'))
      const now = new Date()
      const boundaries = getTimezoneDayBoundaries(TZ, now)
      // 2025-02-02 12:30 AM CST — already tomorrow in Chicago.
      const badge = classifyChipDueBadge({ due_at: '2025-02-02T06:30:00Z' }, now, boundaries)
      expect(badge).toBeNull()
    })
  })
})

describe('countChipDueBadges', () => {
  test('tallies a mixed list into exclusive due-today and overdue counts', () => {
    vi.setSystemTime(new Date('2025-02-01T15:00:00Z')) // 9:00 AM CST
    const now = new Date()
    const boundaries = getTimezoneDayBoundaries(TZ, now)
    const tasks = [
      { due_at: '2025-02-01T20:00:00Z' }, // 2:00 PM CST — due later today
      { due_at: '2025-02-01T21:00:00Z' }, // 3:00 PM CST — due later today
      { due_at: '2025-02-01T12:00:00Z' }, // 6:00 AM CST — overdue (earlier today)
      { due_at: '2025-01-31T15:00:00Z' }, // yesterday — overdue
      { due_at: null }, // undated — neither
      { due_at: '2025-02-05T15:00:00Z' }, // this week — neither
    ]
    expect(countChipDueBadges(tasks, now, boundaries)).toEqual({ dueToday: 2, overdue: 2 })
  })

  test('empty list → zero counts', () => {
    vi.setSystemTime(new Date('2025-02-01T12:00:00Z'))
    const now = new Date()
    const boundaries = getTimezoneDayBoundaries(TZ, now)
    expect(countChipDueBadges([], now, boundaries)).toEqual({ dueToday: 0, overdue: 0 })
  })
})
