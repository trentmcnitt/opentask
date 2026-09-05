/**
 * countTasks — the one definition of total / overdue / due today shared by
 * the Tasks top bar, the nav badges and GET /api/tasks/counts.
 */
import { describe, test, expect } from 'vitest'
import { countTasks } from '@/lib/task-counts'

describe('countTasks', () => {
  // Thursday 2026-01-15, 10:00 Chicago (16:00 UTC).
  const now = new Date('2026-01-15T16:00:00Z')
  const tz = 'America/Chicago'

  test('one now for both filters: past-today is overdue AND today', () => {
    const counts = countTasks(
      [
        { due_at: '2026-01-15T15:00:00.000Z' }, // 9am today, past
        { due_at: '2026-01-15T20:00:00.000Z' }, // 2pm today, ahead
        { due_at: '2026-01-14T15:00:00.000Z' }, // yesterday
        { due_at: '2026-01-16T15:00:00.000Z' }, // tomorrow
        { due_at: null },
      ],
      tz,
      now,
    )
    expect(counts).toEqual({ total: 5, overdue: 2, today: 2 })
  })

  test('nothing due counts nothing', () => {
    expect(countTasks([], tz, now)).toEqual({ total: 0, overdue: 0, today: 0 })
  })
})
