/**
 * One definition of "overdue" (Trent, 2026-09-26: the top bar's red pill said
 * 8 while the Overdue filter chip said 9).
 *
 * The pill counted with `countTasks` (src/lib/task-counts.ts) and the chip
 * with `classifyTaskDueDate` (DueDateFilterBar.tsx) — two hand-written
 * `due < now` comparisons — and, worse, over two different populations: the
 * pill over the FULLY filtered list, the chip over the date-filter facet
 * (every group applied but its own). Both now go through `isOverdue` /
 * `hasDebtDueDate`, and the pill counts the same facet as the chip
 * (`useDateFacetCounts`). These tests pin both halves.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { countTasks, isOverdue } from '@/lib/task-counts'
import { classifyTaskDueDate } from '@/components/DueDateFilterBar'
import { applyTaskFilters, type TaskFilterCriteria } from '@/hooks/useFilterState'
import { getTimezoneDayBoundaries } from '@/lib/format-date'
import type { Task } from '@/types'

const TZ = 'America/Chicago'
// Thursday 2026-01-15, 10:00 Chicago (16:00 UTC).
const NOW = new Date('2026-01-15T16:00:00Z')

function task(id: number, fields: Partial<Task>): Task {
  return {
    id,
    title: `Task ${id}`,
    project_id: 1,
    priority: 0,
    labels: [],
    due_at: null,
    original_due_at: null,
    rrule: null,
    auto_snooze_minutes: null,
    progress_target: 1,
    is_tracked: false,
    is_reminder: false,
    ...fields,
  } as Task
}

function emptyCriteria(): TaskFilterCriteria {
  return {
    selectedLabels: [],
    excludedLabels: [],
    selectedPriorities: [],
    excludedPriorities: [],
    selectedDateFilters: [],
    excludedDateFilters: [],
    attributeFilters: new Set(),
    excludedAttributes: new Set(),
    selectedProjects: [],
    excludedProjects: [],
  }
}

/** What the Overdue filter chip counts over a set. */
function chipOverdueCount(tasks: Task[]): number {
  const boundaries = getTimezoneDayBoundaries(TZ, NOW)
  return tasks.filter((t) => classifyTaskDueDate(t, NOW, boundaries).includes('overdue')).length
}

// Every shape the report's suspects named, in one corpus.
const corpus: Task[] = [
  task(1, { due_at: '2026-01-10T15:00:00Z' }), // days late
  task(2, { due_at: '2026-01-15T15:00:00Z' }), // 9am today, past: overdue AND today
  task(3, { due_at: '2026-01-15T20:00:00Z' }), // 2pm today, ahead
  task(4, { due_at: null }), // no due date
  // Snoozed past its original time: overdue follows the NEW due_at only.
  task(5, { due_at: '2026-01-15T18:00:00Z', original_due_at: '2026-01-14T15:00:00Z' }),
  // Recurring task whose occurrence has passed — just a past due_at.
  task(6, { due_at: '2026-01-14T15:00:00Z', rrule: 'FREQ=DAILY' }),
  // A shared-project task is an ordinary row here (different project id).
  task(7, { due_at: '2026-01-13T15:00:00Z', project_id: 9 }),
  // Legacy quota row still carrying a due_at: never overdue.
  task(8, { due_at: '2026-01-12T15:00:00Z', progress_target: 4, is_tracked: true }),
]

describe('isOverdue — the one definition', () => {
  test('a real due date strictly in the past; quotas and undated tasks never', () => {
    expect(corpus.filter((t) => isOverdue(t, NOW)).map((t) => t.id)).toEqual([1, 2, 6, 7])
  })

  test('the header count and the Overdue chip agree over the same set and now', () => {
    expect(countTasks(corpus, TZ, NOW).overdue).toBe(4)
    expect(chipOverdueCount(corpus)).toBe(4)
  })

  test('a legacy quota row lands in "No Due Date", matching countTasks', () => {
    const boundaries = getTimezoneDayBoundaries(TZ, NOW)
    expect(classifyTaskDueDate(corpus[7], NOW, boundaries)).toEqual(['no_due_date'])
    expect(countTasks([corpus[7]], TZ, NOW)).toEqual({ total: 1, overdue: 0, today: 0 })
  })
})

describe('the pill counts the date facet, not the filtered list', () => {
  beforeEach(() => {
    // `applyTaskFilters` classifies with its own `new Date()`.
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  test('with the Today chip on, the filtered list holds fewer overdue tasks than the chip counts', () => {
    const criteria: TaskFilterCriteria = { ...emptyCriteria(), selectedDateFilters: ['today'] }
    // The old header population: every filter applied — only #2 is overdue AND today.
    const filtered = applyTaskFilters(corpus, criteria, { timezone: TZ })
    expect(countTasks(filtered, TZ, NOW).overdue).toBe(1)
    // The date facet (what the pill and the Overdue chip now both count).
    const facet = applyTaskFilters(corpus, criteria, { timezone: TZ, skipGroup: 'dateFilters' })
    expect(countTasks(facet, TZ, NOW).overdue).toBe(chipOverdueCount(facet))
    expect(countTasks(facet, TZ, NOW).overdue).toBe(4)
  })

  test('other groups still narrow the facet: a project filter narrows pill and chip alike', () => {
    const criteria: TaskFilterCriteria = { ...emptyCriteria(), selectedProjects: [9] }
    const facet = applyTaskFilters(corpus, criteria, { timezone: TZ, skipGroup: 'dateFilters' })
    expect(countTasks(facet, TZ, NOW).overdue).toBe(1)
    expect(chipOverdueCount(facet)).toBe(1)
  })

  test('tapping the pill gives exactly the pill count (exclusive Overdue over the facet)', () => {
    const before: TaskFilterCriteria = { ...emptyCriteria(), selectedDateFilters: ['today'] }
    const pill = countTasks(
      applyTaskFilters(corpus, before, { timezone: TZ, skipGroup: 'dateFilters' }),
      TZ,
      NOW,
    ).overdue
    // `exclusiveDateFilter('overdue')`: Overdue becomes the only date filter.
    const after: TaskFilterCriteria = { ...before, selectedDateFilters: ['overdue'] }
    expect(applyTaskFilters(corpus, after, { timezone: TZ })).toHaveLength(pill)
  })
})
