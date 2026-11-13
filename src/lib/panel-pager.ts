/**
 * The dashboard pager cards' decisions about MOVING BY THEMSELVES (2026-11-13),
 * as pure functions `usePanelPager` runs: when the clock takes the card to a
 * newly opened period, when a finished page moves on, and when an Undo brings
 * the card back. Where a finished page goes is `pageAfterFinishing`
 * (src/lib/time-slot-assign.ts), unchanged.
 */
import { nextRollover } from '@/lib/opentask-day'
import {
  naturalPageIndex,
  nextSlotStart,
  pageAfterFinishing,
  parseHHMM,
} from '@/lib/time-slot-assign'

/**
 * How long a finished page's green count shows before the card moves on
 * (Trent's ask, 2026-11-13: the finished state is seen, then the card goes).
 */
export const FINISH_BEAT_MS = 1000

/** What the card last settled with the clock: the clock's period and the OpenTask day. */
export interface ClockAck {
  /** The clock's period, a page key; null on a card with no periods (the Task queue). */
  natural: string | null
  /** The OpenTask day (`openTaskDayOf`). */
  day: string
  /**
   * What the clock is read against: the day start, the timezone, the
   * periods' start times. A change of it (the preferences arriving, a period
   * retimed) is not the clock moving.
   */
  basis: string
}

/**
 * What the clock does to the card:
 * - `none`: nothing changed;
 * - `rebase`: the settings the clock is read against changed, not the time:
 *   a held page stays held, and the card settles with the clock afresh;
 * - `take`: the card lets go of its page and shows the clock's own;
 * - `pin`: the card keeps the page in view, for good (until the next change);
 * - `wait`: it would take, but the card is held; ask again at the next render.
 */
export type ClockMove = 'none' | 'rebase' | 'take' | 'pin' | 'wait'

// RULE PAGER-CLOCK-TAKEOVER: When a period opens while a dashboard pager
//   card is mounted (seen at once, or on coming back to the app), the card
//   goes to that period only if the page in view has nothing waiting; a
//   page with rows waiting is never left by the clock (the strip shows the
//   new period; finishing the page moves on, PAGER-FINISH-BEAT). A page
//   reached by hand or by a move is kept until then. When the OpenTask day
//   turns, the card lets go of its page whatever it holds. Neither happens
//   while the card is held (PAGER-HELD), only when the hold ends. A change
//   of the settings the clock is read against (the day start, the periods)
//   is not the clock moving: a held page stays held.
// Why: A card paged or moved once stayed on that page for as long as the
//   app sat open; a finished early period hid the one that had opened.
// Ruling: Trent, 2026-11-13: "if I'm on OpenTask and the period changes,
//   then it should switch to that new period"; only a finished page, and
//   the day's turn: the design session, the same day.
export function clockMove(
  ack: ClockAck,
  now: ClockAck,
  /** Rows waiting on the page in view. */
  waitingInView: number,
  held: boolean,
): ClockMove {
  const dayTurned = ack.day !== now.day
  if (!dayTurned && ack.natural === now.natural) return ack.basis === now.basis ? 'none' : 'rebase'
  if (ack.basis !== now.basis) return 'rebase'
  if (!dayTurned && waitingInView > 0) return 'pin'
  return held ? 'wait' : 'take'
}

/**
 * What a finished page's beat does once it is over:
 * - `drop`: the page is no longer the one finished (paged away, or a row is
 *   back): no move;
 * - `wait`: the card is held, ask again;
 * - `move`: go where `pageAfterFinishing` says (or stay, if it says so).
 */
export type BeatMove = 'drop' | 'wait' | 'move'

// RULE PAGER-FINISH-BEAT: When the last waiting row of the page in view on a
//   dashboard pager card is considered, done or swept, the card shows the
//   finished page for FINISH_BEAT_MS and then moves to the page
//   `pageAfterFinishing` names (the earliest opened period still waiting;
//   the first task segment still waiting), or stays when it names none. A
//   page turned by hand, a notification's or a search result's lift, or a
//   row coming back (Undo) during the beat cancels the move. A page that was
//   already finished when the user paged to it never moves by this rule.
//   After the move, an Undo that puts a row back on the finished page brings
//   the card back to it, unless the user has touched the card since.
// Why: The move was instant, so the finished count was never seen; and the
//   Undo's row came back on a page no longer in view.
// Ruling: Trent, 2026-09-23: "it should take you to the earliest undone tab
//   next"; the beat and the Undo's return, the design session, 2026-11-13.
export function beatMove(
  /** The page the beat belongs to. */
  finishedKey: string,
  inView: { key: string; waiting: number },
  held: boolean,
): BeatMove {
  if (inView.key !== finishedKey || inView.waiting > 0) return 'drop'
  return held ? 'wait' : 'move'
}

/**
 * The next instant the clock can change a pager card: the next period start
 * or the next day start, whichever comes first, strictly after `now`.
 */
export function nextPagerBoundary(
  startTimes: readonly string[],
  timezone: string,
  dayStart: string,
  now: Date,
): Date {
  let best = nextRollover(now, timezone, dayStart).getTime()
  for (const start of startTimes) {
    if (parseHHMM(start) === null) continue
    const at = new Date(nextSlotStart(start, timezone, now)).getTime()
    if (at < best) best = at
  }
  return new Date(best)
}

/** What a pager card remembers between renders (`usePanelPager`). */
export interface PagerState {
  /** The page the card holds, by key; null: the natural page. */
  overrideKey: string | null
  /** The page in view and what waited on it at the last render. */
  seen: { key: string; waiting: number } | null
  /** A finished page in its beat, and whether the beat is over. */
  beat: { key: string; due: boolean } | null
  /** The page an automatic move left: an Undo there brings the card back. */
  movedFrom: string | null
  /** What the card last settled with the clock. */
  ack: ClockAck | null
}

export const PAGER_START: PagerState = {
  overrideKey: null,
  seen: null,
  beat: null,
  movedFrom: null,
  ack: null,
}

/** What a render knows: the pages, the clock, and whether the card is held. */
export interface PagerInput {
  pages: readonly { key: string; waiting: number }[]
  /** How many of the pages are periods (they come first). */
  slotCount: number
  /** The clock's period, an index into `pages`. */
  naturalSlot: number
  /** The OpenTask day. */
  day: string
  /** What the clock is read against (`ClockAck.basis`). */
  basis: string
  held: boolean
}

/** The page in view for a state: the held page, else the natural one. */
function pageInView(state: PagerState, input: PagerInput): number {
  const { pages, slotCount, naturalSlot } = input
  // Until a clock change is settled the card stands where it stood: on the
  // period the clock was in when it last settled.
  const stood = state.ack?.natural ? pages.findIndex((p) => p.key === state.ack?.natural) : -1
  const standing = stood >= 0 && stood < slotCount ? stood : naturalSlot
  const held = state.overrideKey ? pages.findIndex((p) => p.key === state.overrideKey) : -1
  if (held >= 0) return held
  return naturalPageIndex(
    pages.map((p) => p.waiting),
    slotCount,
    standing,
  )
}

/** The clock's step (RULE PAGER-CLOCK-TAKEOVER). */
function settleClock(state: PagerState, input: PagerInput): PagerState {
  const { pages, slotCount, naturalSlot, day, basis, held } = input
  const clock: ClockAck = {
    natural: slotCount > 0 ? (pages[naturalSlot]?.key ?? null) : null,
    day,
    basis,
  }
  if (state.ack === null) return { ...state, ack: clock }
  const page = pages[pageInView(state, input)]
  const move = clockMove(state.ack, clock, page.waiting, held)
  if (move === 'take') {
    return { ...state, ack: clock, overrideKey: null, beat: null, movedFrom: null }
  }
  if (move === 'rebase') return { ...state, ack: clock }
  if (move === 'pin') return { ...state, ack: clock, overrideKey: page.key }
  return state
}

/** The finished page's step (RULE PAGER-FINISH-BEAT): start a beat, end one, move. */
function settleFinish(state: PagerState, input: PagerInput): PagerState {
  const { pages, slotCount, naturalSlot, held } = input
  const index = pageInView(state, input)
  const page = pages[index]
  let next = state
  const { seen } = state
  if (seen?.key !== page.key || seen.waiting !== page.waiting) {
    // Only a page that went from something waiting to nothing while in view
    // is finished: paging to one already done leaves you there to look at it.
    const finished = seen?.key === page.key && seen.waiting > 0 && page.waiting === 0
    next = {
      ...next,
      seen: { key: page.key, waiting: page.waiting },
      beat: finished ? { key: page.key, due: false } : next.beat,
    }
  }
  if (next.beat === null) return next
  const after = beatMove(next.beat.key, page, held)
  if (after === 'drop') return { ...next, beat: null }
  if (after === 'wait' || !next.beat.due) return next
  const target = pageAfterFinishing(
    pages.map((p) => p.waiting),
    slotCount,
    index,
    naturalSlot,
  )
  if (target === null) return { ...next, beat: null }
  return { ...next, beat: null, overrideKey: pages[target].key, movedFrom: page.key }
}

/** An Undo of the consider that finished a page brings the card back to it. */
function settleUndo(state: PagerState, input: PagerInput): PagerState {
  if (state.movedFrom === null || input.held) return state
  const page = input.pages[pageInView(state, input)]
  if (page.key === state.movedFrom) return { ...state, movedFrom: null }
  const back = input.pages.find((p) => p.key === state.movedFrom)
  if (!back) return { ...state, movedFrom: null }
  if (back.waiting === 0) return state
  return { ...state, movedFrom: null, overrideKey: back.key }
}

/**
 * ONE RENDER of a pager card: the state after the clock, a finished page and
 * an Undo have each had their say, and the page in view for it. `next` is
 * `state` itself when nothing changed. Needs at least one page.
 */
export function settlePager(
  state: PagerState,
  input: PagerInput,
): { next: PagerState; index: number } {
  // To a fixed point: a move changes the page in view, which the steps then
  // record (`seen`). Each pass either changes nothing or settles one thing
  // for good, so a few passes always suffice.
  let next = state
  for (let pass = 0; pass < 4; pass++) {
    const after = settleUndo(settleFinish(settleClock(next, input), input), input)
    if (after === next) break
    next = after
  }
  return { next, index: pageInView(next, input) }
}

/** A page turned on purpose (by hand, a notification's lift, a link): it is held. */
export function turnPage(state: PagerState, key: string): PagerState {
  return { ...state, overrideKey: key, beat: null, movedFrom: null }
}

/**
 * The card was touched: an Undo's return (RULE PAGER-FINISH-BEAT) is over, so
 * a row arriving later on the page the card left does not pull it back.
 */
export function touchCard(state: PagerState): PagerState {
  return state.movedFrom === null ? state : { ...state, movedFrom: null }
}

/** The beat of `key` is over (the timer's answer). */
export function beatOver(state: PagerState, key: string): PagerState {
  return state.beat?.key === key ? { ...state, beat: { key, due: true } } : state
}
