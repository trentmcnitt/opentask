/**
 * One label per quota, and the Quotas page's grouping by it (§5).
 *
 * Trent, 2026-09-08: "I think we need to have one label for quotas… there's a
 * bunch of stuff for the kids and there are other things." The editor writes a
 * single label from then on, but the corpus still holds quotas carrying two
 * (the migration deliberately left them alone), so "one label" has to be a rule
 * the READER enforces as well: the first entry wins, and a quota appears in
 * exactly one group.
 *
 * Pure functions over plain objects — no database, no clock, so nothing here
 * depends on when it runs.
 */
import { describe, test, expect } from 'vitest'
import { groupByLabel, quotaLabelOf, quotaGroupSummary } from '@/lib/track'
import type { Task } from '@/types'

const quota = (title: string, labels: string[], progress?: [number, number]): Task =>
  ({
    title,
    labels,
    progress_current: progress?.[0] ?? 0,
    progress_target: progress?.[1] ?? 3,
  }) as Task

describe('a quota has one label', () => {
  test('the first label wins when a quota still carries two', () => {
    // Six quotas on the real corpus look like this — e.g. ["health","kids"].
    expect(quotaLabelOf(quota('Kids Smoothie', ['health', 'kids']))).toBe('health')
    const groups = groupByLabel([quota('Kids Smoothie', ['health', 'kids'])])
    expect(groups.map((g) => g.label)).toEqual(['health'])
    expect(groups).toHaveLength(1)
  })

  test('no labels at all is a group, not a missing one', () => {
    expect(quotaLabelOf(quota('Eggs', []))).toBeNull()
    expect(groupByLabel([quota('Eggs', [])]).map((g) => g.label)).toEqual([null])
  })
})

describe('grouping quotas by label', () => {
  test('groups are alphabetical and the unlabelled one is last', () => {
    const groups = groupByLabel([
      quota('Weight Lift', ['health']),
      quota('Eggs', []),
      quota('Clean bedroom fans', ['house']),
      quota('Check for certifications', ['job-hunt']),
      quota('Clean car seat', ['kids', 'house']),
      quota('Broccoli Avocado', []),
    ])
    // Not sorted-with-null-in-place: "unlabelled" is the leftovers, so it goes
    // last however the names happen to sort.
    expect(groups.map((g) => g.label)).toEqual(['health', 'house', 'job-hunt', 'kids', null])
    expect(groups.map((g) => g.tasks.length)).toEqual([1, 1, 1, 1, 2])
  })

  test('case does not split or reorder a group', () => {
    const groups = groupByLabel([quota('B', ['Health']), quota('A', ['house'])])
    expect(groups.map((g) => g.label)).toEqual(['Health', 'house'])
  })

  test('every quota lands in exactly one group', () => {
    const quotas = [
      quota('a', ['health', 'kids']),
      quota('b', ['kids', 'house']),
      quota('c', []),
      quota('d', ['health']),
    ]
    const groups = groupByLabel(quotas)
    expect(groups.flatMap((g) => g.tasks)).toHaveLength(quotas.length)
    expect(new Set(groups.flatMap((g) => g.tasks.map((t) => t.title))).size).toBe(quotas.length)
  })

  test('within a group the given order is kept, untouched', () => {
    // The page hands these over already sorted by title (`trackedItems`), and
    // that order is FROZEN: a +1 must never move a row under the user's finger
    // (commit 9bcf03d). Grouping is not allowed to re-sort them.
    const groups = groupByLabel([
      quota('Cook daily vegetables', ['health'], [5, 5]),
      quota('Daily Walks', ['health'], [0, 2]),
      quota('Kids Smoothie', ['health', 'kids']),
      quota('Weight Lift', ['health'], [1, 3]),
    ])
    expect(groups[0].tasks.map((t) => t.title)).toEqual([
      'Cook daily vegetables',
      'Daily Walks',
      'Kids Smoothie',
      'Weight Lift',
    ])
  })

  test('nothing in, nothing out', () => {
    expect(groupByLabel([])).toEqual([])
  })
})

describe("a label group's header numbers", () => {
  test('counts quotas and met quotas, and never sums mixed targets', () => {
    const group = [
      quota('Cook daily vegetables', ['health'], [5, 5]), // met
      quota('Daily Walks', ['health'], [3, 2]), // met, and over
      quota('Weight Lift', ['health'], [1, 3]),
    ]
    // "3 quotas · 2 met" — not "9 of 10", which would add a weekly target to a
    // daily one and to a monthly one and mean nothing.
    expect(quotaGroupSummary(group)).toEqual({ count: 3, met: 2 })
  })

  test('a group nobody has logged yet reports zero met', () => {
    expect(quotaGroupSummary([quota('Eggs', [], [0, 2])])).toEqual({ count: 1, met: 0 })
  })
})
