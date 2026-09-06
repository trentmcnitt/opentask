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
        { due_at: '2026-01-15T15:00:00.000Z', progress_target: 1, is_tracked: false }, // 9am today, past
        { due_at: '2026-01-15T20:00:00.000Z', progress_target: 1, is_tracked: false }, // 2pm today, ahead
        { due_at: '2026-01-14T15:00:00.000Z', progress_target: 1, is_tracked: false }, // yesterday
        { due_at: '2026-01-16T15:00:00.000Z', progress_target: 1, is_tracked: false }, // tomorrow
        { due_at: null, progress_target: 1, is_tracked: false },
      ],
      tz,
      now,
    )
    expect(counts).toEqual({ total: 5, overdue: 2, today: 2 })
  })

  test('a quota is never overdue and never due today', () => {
    // "Four times this week" cannot be late on a Tuesday. The quota still
    // carries a due_at (the iOS widget draws its pace from it), so the count
    // has to skip it deliberately rather than rely on the column being empty.
    const counts = countTasks(
      [
        { due_at: '2026-01-14T15:00:00.000Z', progress_target: 4, is_tracked: true },
        { due_at: '2026-01-15T15:00:00.000Z', progress_target: 1, is_tracked: true },
        { due_at: '2026-01-15T15:00:00.000Z', progress_target: 1, is_tracked: false },
      ],
      tz,
      now,
    )
    // All three are still tasks — only the two quotas drop out of the debt.
    expect(counts).toEqual({ total: 3, overdue: 1, today: 1 })
  })

  test('nothing due counts nothing', () => {
    expect(countTasks([], tz, now)).toEqual({ total: 0, overdue: 0, today: 0 })
  })
})
