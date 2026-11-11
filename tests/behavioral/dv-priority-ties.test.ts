/**
 * DV-PRI: All's sorts break a tie by priority in the one order (2026-11-11):
 * Urgent, High, Medium, unset, Low (`byPriorityRank`). Unset is just below
 * Medium, never below Low. The primary keys don't change.
 */
import { describe, expect, test } from 'vitest'
import { sortTasks } from '@/lib/task-grouping'
import type { Task } from '@/types'

const NOW = Date.now()
const iso = (hoursFromNow: number) => new Date(NOW + hoursFromNow * 3_600_000).toISOString()

function task(id: number, priority: number, o: Partial<Task> = {}): Task {
  return {
    id,
    title: `t${id}`,
    priority,
    done: false,
    due_at: null,
    deadline_at: null,
    horizon: 'weeks',
    rrule: null,
    original_due_at: null,
    created_at: iso(-24),
    updated_at: iso(-24),
    labels: [],
    ...o,
  } as Task
}

// Made Low first: the raw value (b - a) would put unset last.
const ORDER = [1, 0, 2, 3, 4]
const RANKED = [4, 3, 2, 0, 1]
const priorities = (tasks: Task[]) => tasks.map((t) => t.priority)

describe('DV-PRI: All breaks ties by priority, unset above Low', () => {
  test('due_date: the same due time ranks by priority', () => {
    const due = iso(5)
    const tasks = ORDER.map((p, i) => task(i + 1, p, { due_at: due }))
    expect(priorities(sortTasks(tasks, 'due_date'))).toEqual(RANKED)
  })

  test('due_date: the due time still leads', () => {
    const sooner = task(1, 1, { due_at: iso(2) })
    const later = task(2, 4, { due_at: iso(5) })
    expect(sortTasks([later, sooner], 'due_date').map((t) => t.id)).toEqual([1, 2])
  })

  test('horizon: the same horizon and deadline rank by priority', () => {
    const tasks = ORDER.map((p, i) => task(i + 1, p))
    expect(priorities(sortTasks(tasks, 'horizon'))).toEqual(RANKED)
  })

  test('original_due: the same original target ranks by priority', () => {
    const tasks = ORDER.map((p, i) => task(i + 1, p, { original_due_at: iso(-48) }))
    expect(priorities(sortTasks(tasks, 'original_due'))).toEqual(RANKED)
  })

  test('priority: unset above Low; reversed is the exact opposite', () => {
    const tasks = ORDER.map((p, i) => task(i + 1, p))
    expect(priorities(sortTasks(tasks, 'priority'))).toEqual(RANKED)
    expect(priorities(sortTasks(tasks, 'priority', true))).toEqual([...RANKED].reverse())
  })
})
