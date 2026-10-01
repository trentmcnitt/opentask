/**
 * The multi-task quick panel's starting date (`computeInitialDisplay` in
 * useBulkQuickSelectDate). `earliestDueAt` is what the bulk date picker opens
 * on: the shared date when every selected task has the same one, else the
 * earliest, else null (the picker then opens on "now").
 */
import { describe, it, expect } from 'vitest'
import { computeInitialDisplay } from '@/hooks/useBulkQuickSelectDate'
import type { Task } from '@/types'

const TZ = 'America/Chicago'
const tasks = (...dues: (string | null)[]) => dues.map((due_at) => ({ due_at }) as Task)

describe('computeInitialDisplay — earliestDueAt (the bulk picker start)', () => {
  it('is the shared date when every task has the same one', () => {
    const d = computeInitialDisplay(tasks('2026-03-02T15:00:00Z', '2026-03-02T15:00:00Z'), TZ)
    expect(d.earliestDueAt).toBe('2026-03-02T15:00:00Z')
    expect(d.allSame).toBe(true)
    expect(d.hasMixedDates).toBe(false)
  })

  it('is the earliest date when the dates differ', () => {
    const d = computeInitialDisplay(
      tasks('2026-03-05T15:00:00Z', '2026-03-02T09:00:00Z', '2026-03-04T12:00:00Z'),
      TZ,
    )
    expect(d.earliestDueAt).toBe('2026-03-02T09:00:00Z')
    expect(d.hasMixedDates).toBe(true)
  })

  it('ignores tasks with no date when some have one', () => {
    const d = computeInitialDisplay(tasks(null, '2026-03-04T12:00:00Z'), TZ)
    expect(d.earliestDueAt).toBe('2026-03-04T12:00:00Z')
    expect(d.hasMixedDates).toBe(true)
  })

  it('is null when no task has a date', () => {
    const d = computeInitialDisplay(tasks(null, null), TZ)
    expect(d.earliestDueAt).toBeNull()
    expect(d.headerText).toBe('No due date')
  })
})
