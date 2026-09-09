/**
 * The Track panel's stream (§5, Trent 2026-09-09 — variation G of the
 * `track-by-label` mockup, with D's stripe).
 *
 * The panel draws its quotas as ONE wrapping row in which a cluster's heading
 * is a peer of the chips rather than a container around them, so the thing
 * under test is a FLAT ordered list: title, its quotas, the next title, its
 * quotas. Everything the panel needs to paint a stripe travels in that list,
 * which is why the colour is resolved here and not in the component.
 *
 * Pure functions over plain objects — no database, no clock, so nothing here
 * depends on when it runs.
 */
import { describe, test, expect } from 'vitest'
import { trackStream, periodSuffix, type TrackStreamItem } from '@/lib/track'
import type { LabelConfig, Task } from '@/types'

const quota = (title: string, labels: string[], rrule = 'FREQ=WEEKLY'): Task =>
  ({ title, labels, rrule, progress_current: 0, progress_target: 3 }) as Task

/** The corpus as `trackedItems` hands it over: alphabetical, case-insensitive. */
const CORPUS = [
  quota('Beef For Kids', []),
  quota('Check for new certifications', ['job-hunt']),
  quota('Clean bedroom fans', ['house'], 'FREQ=MONTHLY'),
  quota('Cook daily vegetables', ['health']),
  quota('Daily Walks', ['health'], 'FREQ=DAILY'),
  quota('Eggs', []),
  quota('Josie clean dishes (chore)', ['kids']),
  quota('Kids Smoothie', ['health', 'kids']),
]

const CONFIG: LabelConfig[] = [
  { name: 'health', color: 'blue' },
  { name: 'house', color: 'orange' },
  { name: 'kids', color: 'purple' },
]

const titles = (items: TrackStreamItem[]) =>
  items.filter((i) => i.kind === 'title').map((i) => i.name)

/** Every item as "TITLE" or "· chip title", so order reads as one sequence. */
const shape = (items: TrackStreamItem[]) =>
  items.map((i) => (i.kind === 'title' ? i.name : `· ${i.task.title}`))

describe('the Track panel streams its quotas by label', () => {
  test('a title opens each cluster, alphabetically, unlabelled last', () => {
    const items = trackStream(CORPUS, CONFIG)
    expect(titles(items)).toEqual(['health', 'house', 'job-hunt', 'kids', 'Unlabelled'])
    // Not "no label": the leftovers are a named group, and they sort last
    // however the names happen to fall.
    expect(items[items.length - 1]).toMatchObject({ kind: 'chip' })
  })

  test('every chip follows its own title, and each quota appears exactly once', () => {
    const items = trackStream(CORPUS, CONFIG)
    expect(shape(items)).toEqual([
      'health',
      '· Cook daily vegetables',
      '· Daily Walks',
      // Two labels, filed under the FIRST — it is not in the kids cluster too.
      '· Kids Smoothie',
      'house',
      '· Clean bedroom fans',
      'job-hunt',
      '· Check for new certifications',
      'kids',
      '· Josie clean dishes (chore)',
      'Unlabelled',
      '· Beef For Kids',
      '· Eggs',
    ])
    const chips = items.filter((i) => i.kind === 'chip')
    expect(chips).toHaveLength(CORPUS.length)
    expect(new Set(chips.map((c) => c.task.title)).size).toBe(CORPUS.length)
  })

  test('the first item is always a title, so nothing is orphaned', () => {
    expect(trackStream([quota('Eggs', [])], [])[0]).toMatchObject({
      kind: 'title',
      name: 'Unlabelled',
      label: null,
    })
  })

  test('a cluster keeps the order it was given — a tap never reshuffles it', () => {
    // `trackedItems` froze this order; grouping must not re-sort within it.
    const given = [quota('Weight Lift', ['health']), quota('Cook', ['health'])]
    expect(shape(trackStream(given, CONFIG))).toEqual(['health', '· Weight Lift', '· Cook'])
  })

  test('an empty corpus is an empty stream, not a lone title', () => {
    expect(trackStream([], CONFIG)).toEqual([])
  })
})

describe('the colour a cluster is drawn in', () => {
  test('comes from label_config, and is copied onto its chips', () => {
    const items = trackStream([quota('Daily Walks', ['health'])], CONFIG)
    expect(items).toEqual([
      { kind: 'title', name: 'health', label: 'health', color: 'blue' },
      { kind: 'chip', task: expect.objectContaining({ title: 'Daily Walks' }), color: 'blue' },
    ])
  })

  test('is null when the label has no colour configured — a neutral stripe', () => {
    // Trent's labels carry no colours today, so this is the shipping case, not
    // an edge one: the panel must read as itself with an empty config.
    const items = trackStream(CORPUS, [])
    expect(items.every((i) => i.color === null)).toBe(true)
  })

  test('is null for the unlabelled cluster even when a label is named ""', () => {
    const items = trackStream([quota('Eggs', [])], [{ name: 'Unlabelled', color: 'red' }])
    // "Unlabelled" is this panel's word for the gap, not a label anybody can
    // colour by registering that name.
    expect(items.map((i) => i.color)).toEqual([null, null])
  })

  test('matches a label whatever case it was configured in', () => {
    const items = trackStream([quota('Josie dishes', ['kids'])], [{ name: 'Kids', color: 'pink' }])
    expect(items.map((i) => i.color)).toEqual(['pink', 'pink'])
  })

  test('a reserved ai-* label is not a colour, because it is not a filing', () => {
    // `quotaLabelOf` skips them, so such a quota is unlabelled and neutral —
    // it must not pick up ai-failed's hard-wired red.
    const items = trackStream([quota('Eggs', ['ai-failed'])], CONFIG)
    expect(items.map((i) => i.color)).toEqual([null, null])
    expect(titles(items)).toEqual(['Unlabelled'])
  })
})

describe('the period suffix on a chip', () => {
  test('is two letters at most, one per period', () => {
    expect(periodSuffix('today')).toBe('d')
    expect(periodSuffix('this week')).toBe('wk')
    expect(periodSuffix('this month')).toBe('mo')
    expect(periodSuffix('this year')).toBe('yr')
  })

  test('is nothing at all when the period is not one we know', () => {
    // A quota with no rule has no period; printing the raw string inside a chip
    // would be worse than printing nothing.
    expect(periodSuffix('every other Tuesday')).toBeNull()
  })
})
