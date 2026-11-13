import { describe, expect, it } from 'vitest'
import {
  PAGER_START,
  beatOver,
  nextPagerBoundary,
  settlePager,
  touchCard,
  turnPage,
  type PagerInput,
  type PagerState,
} from '@/lib/panel-pager'

/**
 * PH: THE DASHBOARD PAGER CARDS' HAND-OFF (2026-11-13; src/lib/panel-pager.ts).
 * `settlePager` is one render of a card; a test plays renders in a row.
 * Periods are pages `early`, `morning`, `midday` (in the day's order); the
 * Task queue card has segments and no period (`slotCount` 0).
 */
const KEYS = ['early', 'morning', 'midday']
function periods(waiting: number[], naturalSlot: number, extra: Partial<PagerInput> = {}) {
  return {
    pages: waiting.map((w, i) => ({ key: KEYS[i], waiting: w })),
    slotCount: waiting.length,
    naturalSlot,
    day: '2026-11-13',
    basis: 'settings',
    held: false,
    ...extra,
  }
}
function segments(waiting: number[], extra: Partial<PagerInput> = {}): PagerInput {
  return {
    pages: waiting.map((w, i) => ({ key: `seg${i}`, waiting: w })),
    slotCount: 0,
    naturalSlot: 0,
    day: '2026-11-13',
    basis: 'settings',
    held: false,
    ...extra,
  }
}
/** Plays renders one after another; answers the page key in view after the last. */
function play(start: PagerState, inputs: PagerInput[]): { state: PagerState; key: string } {
  let state = start
  let key = ''
  for (const input of inputs) {
    const { next, index } = settlePager(state, input)
    // A second settle of the same render changes nothing (the render converges).
    expect(settlePager(next, input).next).toBe(next)
    state = next
    key = input.pages[index].key
  }
  return { state, key }
}
/** The beat of the page in view ends. */
const endBeat = (state: PagerState) => beatOver(state, state.beat?.key ?? '')

describe('PH: finishing a page (RULE PAGER-FINISH-BEAT)', () => {
  it('PH-01: the finished page stays through its beat, then the card goes to the earliest opened period still waiting', () => {
    // Midday is the clock's; Early and Midday wait; Morning (paged to) is finished.
    let at = play(turnPage(PAGER_START, 'morning'), [periods([2, 1, 3], 2)])
    at = play(at.state, [periods([2, 0, 3], 2)])
    expect(at.key).toBe('morning')
    expect(at.state.beat).toEqual({ key: 'morning', due: false })
    at = play(endBeat(at.state), [periods([2, 0, 3], 2)])
    expect(at.key).toBe('early')
  })

  it('PH-02: never to a period that has not opened; nothing waiting up to now: it stays', () => {
    let at = play(PAGER_START, [periods([0, 1, 4], 1)])
    at = play(at.state, [periods([0, 0, 4], 1)])
    at = play(endBeat(at.state), [periods([0, 0, 4], 1)])
    expect(at.key).toBe('morning')
    expect(at.state.beat).toBeNull()
  })

  it('PH-03: a page turned by hand during the beat cancels the move', () => {
    let at = play(PAGER_START, [periods([2, 1, 0], 1)])
    at = play(at.state, [periods([2, 0, 0], 1)])
    at = play(turnPage(at.state, 'midday'), [periods([2, 0, 0], 1)])
    expect(at.state.beat).toBeNull()
    // The timer's answer, arriving late, moves nothing.
    at = play(beatOver(at.state, 'morning'), [periods([2, 0, 0], 1)])
    expect(at.key).toBe('midday')
  })

  it('PH-04: a page already finished when paged to is never left by this rule', () => {
    const at = play(turnPage(PAGER_START, 'early'), [periods([0, 3, 0], 1), periods([0, 3, 0], 1)])
    expect(at.key).toBe('early')
    expect(at.state.beat).toBeNull()
  })

  it('PH-05: an Undo during the beat keeps the page; after the move it brings the card back', () => {
    let at = play(PAGER_START, [periods([2, 1, 0], 1), periods([2, 0, 0], 1)])
    // The row is back before the beat ends: no move.
    at = play(at.state, [periods([2, 1, 0], 1)])
    expect(at.state.beat).toBeNull()
    expect(at.key).toBe('morning')
    // Finished again, moved to Early; then the Undo.
    at = play(at.state, [periods([2, 0, 0], 1)])
    at = play(endBeat(at.state), [periods([2, 0, 0], 1)])
    expect(at.key).toBe('early')
    at = play(at.state, [periods([2, 1, 0], 1)])
    expect(at.key).toBe('morning')
  })

  it('PH-06: after the move, a page turned by hand ends the Undo return', () => {
    let at = play(PAGER_START, [periods([2, 1, 0], 1), periods([2, 0, 0], 1)])
    at = play(endBeat(at.state), [periods([2, 0, 0], 1)])
    at = play(turnPage(at.state, 'midday'), [periods([2, 1, 0], 1)])
    expect(at.key).toBe('midday')
  })

  it('PH-08: once the card is touched after the move, a row arriving on the page it left does not pull it back', () => {
    let at = play(PAGER_START, [periods([2, 1, 0], 1), periods([2, 0, 0], 1)])
    at = play(endBeat(at.state), [periods([2, 0, 0], 1)])
    expect(at.key).toBe('early')
    at = play(touchCard(at.state), [periods([2, 1, 0], 1)])
    expect(at.key).toBe('early')
  })

  it('PH-07: the Task queue card goes to the first segment still waiting, and stays when none waits', () => {
    let at = play(PAGER_START, [segments([0, 2, 1])])
    expect(at.key).toBe('seg1')
    at = play(turnPage(at.state, 'seg2'), [segments([3, 2, 1]), segments([3, 2, 0])])
    at = play(endBeat(at.state), [segments([3, 2, 0])])
    expect(at.key).toBe('seg0')
    // The last one anywhere: the card stays on its finished page.
    at = play(turnPage(PAGER_START, 'seg1'), [segments([0, 1, 0]), segments([0, 0, 0])])
    at = play(endBeat(at.state), [segments([0, 0, 0])])
    expect(at.key).toBe('seg1')
  })
})

describe('PH: the clock (RULE PAGER-CLOCK-TAKEOVER)', () => {
  it('PH-10: a period opening takes a finished page, held by hand or by a move', () => {
    // Early is finished and held; Morning opens.
    let at = play(turnPage(PAGER_START, 'early'), [periods([0, 4, 0], 0)])
    expect(at.key).toBe('early')
    at = play(at.state, [periods([0, 4, 0], 1)])
    expect(at.key).toBe('morning')
    expect(at.state.overrideKey).toBeNull()
  })

  it('PH-11: a page with rows waiting is never left by the clock, held or not', () => {
    // Not held: the card was on the clock's own period.
    let at = play(PAGER_START, [periods([2, 4, 0], 0), periods([2, 4, 0], 1)])
    expect(at.key).toBe('early')
    // ...and stays through later renders, until it is finished.
    at = play(at.state, [periods([1, 4, 0], 1)])
    expect(at.key).toBe('early')
    at = play(at.state, [periods([0, 4, 0], 1)])
    at = play(endBeat(at.state), [periods([0, 4, 0], 1)])
    expect(at.key).toBe('morning')
  })

  it('PH-12: an unopened page peeked at stays until the next period opens', () => {
    let at = play(turnPage(PAGER_START, 'midday'), [periods([0, 0, 0], 0), periods([0, 0, 0], 0)])
    expect(at.key).toBe('midday')
    at = play(at.state, [periods([0, 0, 0], 1)])
    expect(at.key).toBe('morning')
  })

  it('PH-13: the day turning lets go of any page, waiting or not, on both cards', () => {
    let at = play(turnPage(PAGER_START, 'midday'), [periods([0, 0, 3], 2)])
    at = play(at.state, [periods([5, 0, 0], 0, { day: '2026-11-14' })])
    expect(at.key).toBe('early')
    let queue = play(turnPage(PAGER_START, 'seg2'), [segments([0, 0, 0])])
    expect(queue.key).toBe('seg2')
    queue = play(queue.state, [segments([0, 4, 0], { day: '2026-11-14' })])
    expect(queue.key).toBe('seg1')
  })

  it('PH-15: the settings arriving (day start, periods) are not the clock: a held page stays held, a lift included', () => {
    // A lift's page, then the preferences land: another day key, another clock period.
    let at = play(turnPage(PAGER_START, 'midday'), [periods([0, 0, 0], 2)])
    at = play(at.state, [periods([0, 0, 0], 0, { day: '2026-11-12', basis: 'loaded' })])
    expect(at.key).toBe('midday')
    // With no page held, the card shows the clock's period as now read.
    at = play(PAGER_START, [periods([0, 2, 0], 1)])
    at = play(at.state, [periods([0, 2, 0], 0, { day: '2026-11-12', basis: 'loaded' })])
    expect(at.key).toBe('early')
  })

  it('PH-14: with no page held the Task queue card has no clock to follow within a day', () => {
    const at = play(turnPage(PAGER_START, 'seg2'), [segments([1, 0, 0]), segments([2, 0, 0])])
    expect(at.key).toBe('seg2')
  })
})

describe('PH: a held card (RULE PAGER-HELD)', () => {
  it('PH-20: a beat that ends while the card is held moves when the hold ends', () => {
    let at = play(PAGER_START, [periods([2, 1, 0], 1), periods([2, 0, 0], 1)])
    at = play(endBeat(at.state), [periods([2, 0, 0], 1, { held: true })])
    expect(at.key).toBe('morning')
    at = play(at.state, [periods([2, 0, 0], 1)])
    expect(at.key).toBe('early')
  })

  it('PH-21: a period opening while the card is held takes over when the hold ends', () => {
    let at = play(PAGER_START, [periods([0, 4, 0], 0)])
    // Not held by key: the card stands on the period it stood on, not the clock's new one.
    at = play(at.state, [periods([0, 4, 0], 1, { held: true })])
    expect(at.key).toBe('early')
    at = play(at.state, [periods([0, 4, 0], 1)])
    expect(at.key).toBe('morning')
  })

  it('PH-22: decided from the state when the hold ends: a row back on the page keeps it', () => {
    let at = play(PAGER_START, [periods([0, 4, 0], 0)])
    at = play(at.state, [periods([0, 4, 0], 1, { held: true })])
    at = play(at.state, [periods([1, 4, 0], 1)])
    expect(at.key).toBe('early')
  })
})

describe('PH: a page turned on purpose wins', () => {
  it('PH-30: a lift to a page the same render the clock would take over still lands on its page', () => {
    let at = play(turnPage(PAGER_START, 'early'), [periods([0, 4, 2], 0)])
    // Morning opens; the takeover settles; the lift's page turn comes after it.
    at = play(at.state, [periods([0, 4, 2], 1)])
    at = play(turnPage(at.state, 'midday'), [periods([0, 4, 2], 1)])
    expect(at.key).toBe('midday')
  })
})

describe('PH: the next boundary', () => {
  const tz = 'America/Chicago'
  it('PH-40: the next period start today, else the day start, else tomorrow’s first', () => {
    const starts = ['06:10', '07:00', '12:00']
    // 06:30 Chicago (CST, UTC-6) on 2026-11-13.
    expect(nextPagerBoundary(starts, tz, '03:00', new Date('2026-11-13T12:30:00Z'))).toEqual(
      new Date('2026-11-13T13:00:00Z'),
    )
    // 13:00: nothing more today; the 03:00 day start comes before 06:10.
    expect(nextPagerBoundary(starts, tz, '03:00', new Date('2026-11-13T19:00:00Z'))).toEqual(
      new Date('2026-11-14T09:00:00Z'),
    )
    // Exactly on a start: the next one, never now.
    expect(nextPagerBoundary(starts, tz, '03:00', new Date('2026-11-13T13:00:00Z'))).toEqual(
      new Date('2026-11-13T18:00:00Z'),
    )
  })
})
