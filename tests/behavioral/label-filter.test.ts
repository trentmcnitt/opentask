/**
 * The label filter's rules (src/lib/label-filter.ts) — shared by the
 * dashboard's filter bar and the Quotas page's label chips (2026-10-24).
 * Pure functions: no database.
 */
import { describe, it, expect } from 'vitest'
import {
  EMPTY_LABEL_FILTER,
  excludeLabelIn,
  exclusiveLabelIn,
  filterByLabels,
  labelChipCounts,
  labelFilterCount,
  parseStoredLabelFilter,
  toggleLabelIn,
} from '@/lib/label-filter'
import { applyTaskFilters, type TaskFilterCriteria } from '@/hooks/useFilterState'
import type { Task } from '@/types'

const items = [
  { id: 1, labels: ['red'] },
  { id: 2, labels: ['blue'] },
  { id: 3, labels: ['red', 'blue'] },
  { id: 4, labels: ['green'] },
  { id: 5, labels: [] },
]
const ids = (xs: { id: number }[]) => xs.map((x) => x.id)

describe('filterByLabels', () => {
  it('an empty selection lets everything through', () => {
    expect(ids(filterByLabels(items, EMPTY_LABEL_FILTER))).toEqual([1, 2, 3, 4, 5])
  })

  it('selected labels are OR: an item with either label is shown', () => {
    const c = { selectedLabels: ['red', 'green'], excludedLabels: [] }
    expect(ids(filterByLabels(items, c))).toEqual([1, 3, 4])
  })

  it('an unlabeled item drops out as soon as any label is selected', () => {
    expect(ids(filterByLabels(items, { selectedLabels: ['red'], excludedLabels: [] }))).toEqual([
      1, 3,
    ])
  })

  it('an excluded label removes every item carrying it', () => {
    expect(ids(filterByLabels(items, { selectedLabels: [], excludedLabels: ['blue'] }))).toEqual([
      1, 4, 5,
    ])
  })

  it('includes apply first, then excludes remove from the result', () => {
    const c = { selectedLabels: ['red'], excludedLabels: ['blue'] }
    expect(ids(filterByLabels(items, c))).toEqual([1])
  })

  it('matches the dashboard: applyTaskFilters with only labels set gives the same set', () => {
    const c = { selectedLabels: ['red', 'green'], excludedLabels: ['blue'] }
    const criteria: TaskFilterCriteria = {
      ...c,
      selectedPriorities: [],
      excludedPriorities: [],
      selectedDateFilters: [],
      excludedDateFilters: [],
      attributeFilters: new Set(),
      excludedAttributes: new Set(),
      selectedProjects: [],
      excludedProjects: [],
    }
    expect(
      ids(applyTaskFilters(items as unknown as Task[], criteria, { dayStart: '03:00' })),
    ).toEqual(ids(filterByLabels(items, c)))
  })
})

describe('labelChipCounts', () => {
  it('counts an item once per label it carries, most-used first then by name', () => {
    expect(labelChipCounts(items, EMPTY_LABEL_FILTER)).toEqual([
      ['blue', 2],
      ['red', 2],
      ['green', 1],
    ])
  })

  it('a selected or excluded label nobody carries still has a chip, at 0', () => {
    const c = { selectedLabels: ['gone'], excludedLabels: ['also-gone'] }
    expect(labelChipCounts(items, c)).toContainEqual(['gone', 0])
    expect(labelChipCounts(items, c)).toContainEqual(['also-gone', 0])
  })

  it('counts are over the items passed in — not narrowed by its own selection', () => {
    // The chip row is handed the searched set, never the label-filtered one,
    // so selecting "red" leaves the "blue" chip still saying 2.
    const c = { selectedLabels: ['red'], excludedLabels: [] }
    expect(labelChipCounts(items, c)).toContainEqual(['blue', 2])
  })
})

describe('the chip gestures', () => {
  it('tap toggles a label in and out of the includes', () => {
    const on = toggleLabelIn(EMPTY_LABEL_FILTER, 'red')
    expect(on.selectedLabels).toEqual(['red'])
    const both = toggleLabelIn(on, 'blue')
    expect(both.selectedLabels).toEqual(['red', 'blue'])
    expect(toggleLabelIn(both, 'red').selectedLabels).toEqual(['blue'])
  })

  it('exclude moves a label out of the includes, and toggles it back off', () => {
    const c = excludeLabelIn({ selectedLabels: ['red', 'blue'], excludedLabels: [] }, 'red')
    expect(c).toEqual({ selectedLabels: ['blue'], excludedLabels: ['red'] })
    expect(excludeLabelIn(c, 'red')).toEqual({ selectedLabels: ['blue'], excludedLabels: [] })
  })

  it('exclusive makes it the only include and clears the excludes; again clears it', () => {
    const c = exclusiveLabelIn(
      { selectedLabels: ['red', 'blue'], excludedLabels: ['green'] },
      'red',
    )
    expect(c).toEqual({ selectedLabels: ['red'], excludedLabels: [] })
    expect(exclusiveLabelIn(c, 'red')).toEqual(EMPTY_LABEL_FILTER)
  })

  it('labelFilterCount counts includes and excludes', () => {
    expect(labelFilterCount(EMPTY_LABEL_FILTER)).toBe(0)
    expect(labelFilterCount({ selectedLabels: ['a', 'b'], excludedLabels: ['c'] })).toBe(3)
  })
})

describe('parseStoredLabelFilter', () => {
  it('reads back what was stored', () => {
    const c = { selectedLabels: ['red'], excludedLabels: ['blue'] }
    expect(parseStoredLabelFilter(JSON.stringify(c))).toEqual(c)
  })

  it('nothing, garbage or the wrong shape read as no filter', () => {
    expect(parseStoredLabelFilter(null)).toEqual(EMPTY_LABEL_FILTER)
    expect(parseStoredLabelFilter('{not json')).toEqual(EMPTY_LABEL_FILTER)
    expect(parseStoredLabelFilter('null')).toEqual(EMPTY_LABEL_FILTER)
    expect(parseStoredLabelFilter('{"selectedLabels":"red","excludedLabels":[1,"x"]}')).toEqual({
      selectedLabels: [],
      excludedLabels: ['x'],
    })
  })
})
