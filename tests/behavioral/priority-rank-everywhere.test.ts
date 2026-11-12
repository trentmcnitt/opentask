/**
 * One priority order everywhere (2026-11-11): Urgent, High, Medium, unset,
 * Low (`byPriorityRank`). Unset is just below Medium, never below Low, in
 * every priority-first comparator. The keys after priority don't change.
 */
import { describe, expect, test } from 'vitest'
import { byPriorityRank, priorityRank } from '@/lib/priority'
import { compareDeadlineRows, compareQueueRows } from '@/lib/task-segments'
import { deckSectionOrder } from '@/lib/now-view'
import { comparePrompts } from '@/lib/quota-prompts'
import type { Task } from '@/types'

// Made Low first, ids in that order: the raw value (b - a) would put unset
// last, and an id tie-break can't rescue it.
const ORDER = [1, 0, 2, 3, 4]
const RANKED = [4, 3, 2, 0, 1]

function ranked<T extends { priority: number }>(rows: T[], cmp: (a: T, b: T) => number) {
  return [...rows].sort(cmp).map((r) => r.priority)
}

describe('priorityRank: one order', () => {
  test('Urgent, High, Medium, unset, Low; a missing priority is unset', () => {
    expect([...ORDER].sort((a, b) => priorityRank(a) - priorityRank(b))).toEqual(RANKED)
    expect(byPriorityRank({ priority: null }, { priority: 0 })).toBe(0)
  })
})

describe('every priority-first comparator ranks unset above Low', () => {
  test('the queue panels (compareQueueRows)', () => {
    const rows = ORDER.map((priority, i) => ({ id: i + 1, priority }))
    expect(ranked(rows, (a, b) => compareQueueRows(a, b))).toEqual(RANKED)
  })

  test('the deadlines page (compareDeadlineRows)', () => {
    const rows = ORDER.map((priority, i) => ({ id: i + 1, priority, deadline_at: null }))
    expect(ranked(rows, compareDeadlineRows)).toEqual(RANKED)
  })

  test("Now's On deck group (deckSectionOrder)", () => {
    const rows = ORDER.map((priority, i) => ({ id: i + 1, priority }) as Task)
    expect(ranked(rows, deckSectionOrder)).toEqual(RANKED)
  })

  test('quota prompts (comparePrompts)', () => {
    const rows = ORDER.map((priority, i) => ({ task_id: i + 1, priority, title: 'same' }))
    expect(ranked(rows, comparePrompts)).toEqual(RANKED)
  })

  test('a tie keeps the next key (the deadlines page: the nearer deadline)', () => {
    const far = { id: 1, priority: 0, deadline_at: '2026-12-01T17:00:00Z' }
    const near = { id: 2, priority: 0, deadline_at: '2026-11-20T17:00:00Z' }
    expect([far, near].sort(compareDeadlineRows).map((r) => r.id)).toEqual([2, 1])
  })
})
