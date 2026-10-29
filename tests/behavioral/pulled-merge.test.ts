/**
 * PULLED, ONE SEGMENT (Trent, 2026-10-29): the web draws the queue's two
 * panels — Today's pulls, Previous pulls — as one segment, its rows tagged by
 * the panel they came from (`mergePulled` in src/hooks/useTaskSegments.ts).
 * The server's two kinds are unchanged.
 */
import { describe, expect, test } from 'vitest'
import { mergePulled, type SegmentView } from '@/hooks/useTaskSegments'
import type { Task } from '@/types'

const row = (id: number, state: 'waiting' | 'considered' = 'waiting') => ({
  task: { id } as Task,
  state,
  recurring: false,
})
const view = (horizon: SegmentView['horizon'], rows: ReturnType<typeof row>[]): SegmentView => ({
  horizon,
  rows,
  waiting: rows.filter((r) => r.state === 'waiting').length,
  considered: rows.filter((r) => r.state === 'considered').length,
  deferred: 0,
  nudge: false,
})

describe('mergePulled', () => {
  test("one Pulled view in Today's pulls' place: Today's rows first, counts summed", () => {
    const views = [
      view('deadlines', []),
      view('upcoming', [row(1)]),
      view('queue_today', [row(2), row(3, 'considered')]),
      view('queue_previous', [row(4)]),
      view('days', [row(5)]),
    ]
    const merged = mergePulled(views)
    expect(merged.map((v) => v.horizon)).toEqual(['deadlines', 'upcoming', 'queue_today', 'days'])
    const pulled = merged[2]
    expect(pulled.pulled).toBe(true)
    expect(pulled.rows.map((r) => [r.task.id, r.pulled])).toEqual([
      [2, 'today'],
      [3, 'today'],
      [4, 'earlier'],
    ])
    expect([pulled.waiting, pulled.considered]).toEqual([2, 1])
  })

  test('with only the earlier panel, still one Pulled view; with neither, nothing changes', () => {
    const only = mergePulled([view('queue_previous', [row(4)]), view('days', [])])
    expect(only.map((v) => [v.horizon, v.pulled])).toEqual([
      ['queue_today', true],
      ['days', undefined],
    ])
    const none = [view('days', [])]
    expect(mergePulled(none)).toBe(none)
  })
})
