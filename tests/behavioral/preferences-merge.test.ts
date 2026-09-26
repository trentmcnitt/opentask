/**
 * Preferences load/save races — the pure half of PreferencesProvider
 * (src/lib/preferences-state.ts).
 *
 * 1. `mergeLoadedPrefs`: the mount GET must not undo a change the user made
 *    before it landed (the dashboard filter toggle clicked right after paint
 *    snapped shut again while the server kept it open).
 * 2. `createPreferenceSaver`: same-field PATCHes go out one at a time, so the
 *    last CLICK is the last write, not whichever request arrives last.
 */

import { describe, test, expect } from 'vitest'
import {
  DEFAULT_PREFS,
  createDirtyTracker,
  createPreferenceSaver,
  mergeLoadedPrefs,
  parseServerPrefs,
  type Prefs,
} from '@/lib/preferences-state'

/** A GET /api/user/preferences `data` payload, trimmed to what these tests read. */
const SERVER = {
  filters_expanded: false,
  track_expanded: true,
  default_grouping: 'slot',
  default_sort: 'priority',
  default_sort_reversed: true,
  morning_time: '08:30',
}

/** What a click does in the provider: change the field and mark it dirty. */
function click<K extends keyof Prefs>(
  state: Prefs,
  dirty: ReturnType<typeof createDirtyTracker>,
  key: K,
  value: Prefs[K],
): Prefs {
  dirty.mark(key)
  return { ...state, [key]: value }
}

describe('mergeLoadedPrefs', () => {
  test('click before load: the clicked field keeps the click, the rest take the server', () => {
    const dirty = createDirtyTracker()
    const local = click(DEFAULT_PREFS, dirty, 'filtersExpanded', true)

    const merged = mergeLoadedPrefs(local, dirty.take(), parseServerPrefs(SERVER))
    expect(merged.filtersExpanded).toBe(true) // the click, not the server's false
    expect(merged.trackExpanded).toBe(true) // untouched → server
    expect(merged.defaultGrouping).toBe('slot')
    expect(merged.defaultSort).toBe('priority')
    expect(merged.morningTime).toBe('08:30')
  })

  test('load before click: the load applies in full, and the later click then wins', () => {
    const dirty = createDirtyTracker()
    const loaded = mergeLoadedPrefs(DEFAULT_PREFS, dirty.take(), parseServerPrefs(SERVER))
    expect(loaded.filtersExpanded).toBe(false)
    expect(loaded.trackExpanded).toBe(true)

    const after = click(loaded, dirty, 'trackExpanded', false)
    expect(after.trackExpanded).toBe(false)
  })

  test('rapid toggle before load: the final local value survives, even when it matches the default', () => {
    const dirty = createDirtyTracker()
    let local = click(DEFAULT_PREFS, dirty, 'trackExpanded', true)
    local = click(local, dirty, 'trackExpanded', false) // back to the default
    // The server still holds an older `true` (the second PATCH hasn't landed).
    const merged = mergeLoadedPrefs(local, dirty.take(), parseServerPrefs(SERVER))
    expect(merged.trackExpanded).toBe(false)
  })

  test('reload: nothing dirty, so every field comes from the server', () => {
    const merged = mergeLoadedPrefs(
      DEFAULT_PREFS,
      createDirtyTracker().take(),
      parseServerPrefs({ ...SERVER, filters_expanded: true }),
    )
    expect(merged).toMatchObject({
      filtersExpanded: true,
      trackExpanded: true,
      defaultGrouping: 'slot',
      defaultSort: 'priority',
      defaultSortReversed: true,
      morningTime: '08:30',
    })
  })

  test('a field the response leaves out keeps its local value', () => {
    const merged = mergeLoadedPrefs(DEFAULT_PREFS, new Set(), parseServerPrefs({}))
    expect(merged).toEqual(DEFAULT_PREFS)
  })

  test('the dirty set is per load: take() resets it', () => {
    const dirty = createDirtyTracker()
    dirty.mark('filtersExpanded')
    expect([...dirty.take()]).toEqual(['filtersExpanded'])
    expect([...dirty.take()]).toEqual([])
  })
})

describe('parseServerPrefs', () => {
  test('keeps the provider’s long-standing coercions', () => {
    const parsed = parseServerPrefs({
      default_grouping: 'reminders', // retired view → the front door
      ai_mode: 'bubble', // legacy mode → on
      ai_enrichment_mode: 'nonsense', // invalid feature mode → ignored
      auto_snooze_minutes: 0, // zero means absent
      priority_display: { badgeStyle: 'dots' },
      bulk_snooze_default: 'default_option',
    })
    expect(parsed.defaultGrouping).toBe('slot')
    expect(parsed.aiMode).toBe('on')
    expect('aiEnrichmentMode' in parsed).toBe(false)
    expect('autoSnoozeDefault' in parsed).toBe(false)
    expect(parsed.priorityDisplay).toEqual({ ...DEFAULT_PREFS.priorityDisplay, badgeStyle: 'dots' })
    expect(parsed.bulkSnoozeDefault).toBe('default_option')
  })

  test('null / missing data parses to nothing', () => {
    expect(parseServerPrefs(null)).toEqual({})
    expect(parseServerPrefs(undefined)).toEqual({})
  })
})

describe('createPreferenceSaver', () => {
  /** A fake `send` whose requests stay open until the test settles them. */
  function fakeSend() {
    const calls: { body: Record<string, unknown>; resolve: () => void }[] = []
    const send = (body: Record<string, unknown>) =>
      new Promise<void>((resolve) => {
        calls.push({ body, resolve })
      })
    return { send, calls }
  }

  const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

  test('a lone save is sent at once', () => {
    const { send, calls } = fakeSend()
    createPreferenceSaver(send).save('track_expanded', { track_expanded: true })
    expect(calls.map((c) => c.body)).toEqual([{ track_expanded: true }])
  })

  test('a second save waits for the first to settle, then carries the final value', async () => {
    const { send, calls } = fakeSend()
    const saver = createPreferenceSaver(send)
    saver.save('filters_expanded', { filters_expanded: true })
    saver.save('filters_expanded', { filters_expanded: false })
    expect(calls).toHaveLength(1) // not raced against the first

    calls[0].resolve()
    await tick()
    expect(calls.map((c) => c.body)).toEqual([
      { filters_expanded: true },
      { filters_expanded: false },
    ])
  })

  test('three quick saves are two sends: the first and the last', async () => {
    const { send, calls } = fakeSend()
    const saver = createPreferenceSaver(send)
    saver.save('default_sort', { default_sort: 'title', default_sort_reversed: false })
    saver.save('default_sort', { default_sort: 'priority', default_sort_reversed: false })
    saver.save('default_sort', { default_sort: 'due_date', default_sort_reversed: true })

    calls[0].resolve()
    await tick()
    calls[1]?.resolve()
    await tick()
    expect(calls.map((c) => c.body)).toEqual([
      { default_sort: 'title', default_sort_reversed: false },
      { default_sort: 'due_date', default_sort_reversed: true },
    ])
  })

  test('toggling away and back while the first save is in flight sends nothing more', async () => {
    const { send, calls } = fakeSend()
    const saver = createPreferenceSaver(send)
    saver.save('track_expanded', { track_expanded: true })
    saver.save('track_expanded', { track_expanded: false })
    saver.save('track_expanded', { track_expanded: true })

    calls[0].resolve()
    await tick()
    expect(calls).toHaveLength(1)
  })

  test('a failed save still releases the next one', async () => {
    const bodies: Record<string, unknown>[] = []
    let rejectFirst: () => void = () => {}
    const saver = createPreferenceSaver((body) => {
      bodies.push(body)
      if (bodies.length === 1) {
        return new Promise((_resolve, reject) => {
          rejectFirst = () => reject(new Error('offline'))
        })
      }
      return Promise.resolve()
    })
    saver.save('filters_expanded', { filters_expanded: true })
    saver.save('filters_expanded', { filters_expanded: false })
    rejectFirst()
    await tick()
    expect(bodies).toEqual([{ filters_expanded: true }, { filters_expanded: false }])
  })

  test('after a failed save, toggling back to the failed value still sends it', async () => {
    const bodies: Record<string, unknown>[] = []
    let rejectFirst: () => void = () => {}
    const saver = createPreferenceSaver((body) => {
      bodies.push(body)
      if (bodies.length === 1) {
        return new Promise((_resolve, reject) => {
          rejectFirst = () => reject(new Error('500'))
        })
      }
      return Promise.resolve()
    })
    saver.save('track_expanded', { track_expanded: true }) // fails
    saver.save('track_expanded', { track_expanded: false })
    saver.save('track_expanded', { track_expanded: true }) // the last click
    rejectFirst()
    await tick()
    expect(bodies).toEqual([{ track_expanded: true }, { track_expanded: true }])
  })

  test('different fields do not wait on each other', () => {
    const { send, calls } = fakeSend()
    const saver = createPreferenceSaver(send)
    saver.save('filters_expanded', { filters_expanded: true })
    saver.save('track_expanded', { track_expanded: true })
    expect(calls).toHaveLength(2)
  })

  test('pagehide: a waiting value is sent right away instead of dying with the page', () => {
    const { send, calls } = fakeSend()
    const saver = createPreferenceSaver(send)
    saver.save('track_expanded', { track_expanded: true })
    saver.save('track_expanded', { track_expanded: false })
    expect(calls).toHaveLength(1)

    saver.flushPending()
    expect(calls.map((c) => c.body)).toEqual([{ track_expanded: true }, { track_expanded: false }])
    saver.flushPending()
    expect(calls).toHaveLength(2) // nothing waiting any more
  })
})
