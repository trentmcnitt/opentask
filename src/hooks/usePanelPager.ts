'use client'

import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import {
  FINISH_BEAT_MS,
  PAGER_START,
  beatOver,
  settlePager,
  touchCard,
  turnPage,
  type PagerState,
} from '@/lib/panel-pager'

/** What a pager needs to know about a page. */
export interface PagerPage {
  key: string
  waiting: number
}

/**
 * A hold on the card from inside it (`usePagerHold`): a row's menu, open in a
 * portal the card cannot see. Null outside a pager card.
 */
const PagerHoldContext = createContext<((delta: 1 | -1) => void) | null>(null)
export const PagerHoldProvider = PagerHoldContext.Provider

/** Holds the pager card this sits in while `open` (a row's own menu). */
export function usePagerHold(open: boolean): void {
  const hold = useContext(PagerHoldContext)
  useEffect(() => {
    if (!open || !hold) return
    hold(1)
    return () => hold(-1)
  }, [open, hold])
}

/**
 * Whether the card is held: a pointer down on it, or one of its rows' menus
 * open (`usePagerHold`). The card's own flags (select mode, a bubble, an
 * editor) come from the card.
 */
function useCardHold() {
  const [pressing, setPressing] = useState(false)
  const [menus, setMenus] = useState(0)
  useEffect(() => {
    if (!pressing) return
    const release = () => setPressing(false)
    // Every way a press ends without a pointerup reaching the page: the
    // system's context menu, the window losing focus mid-press.
    const ends = ['pointerup', 'pointercancel', 'contextmenu', 'blur'] as const
    for (const name of ends) window.addEventListener(name, release)
    return () => {
      for (const name of ends) window.removeEventListener(name, release)
    }
  }, [pressing])
  const hold = useCallback((delta: 1 | -1) => setMenus((n) => n + delta), [])
  // The primary button (a finger, a pen): a right-click is not a press held.
  const onPointerDownCapture = useCallback((e: { button: number }) => {
    if (e.button === 0) setPressing(true)
  }, [])
  return { held: pressing || menus > 0, hold, onPointerDownCapture }
}

/**
 * The state of one of the dashboard's pager cards: which page is on screen,
 * which pages are uncapped, and whether the page's considered rows show.
 *
 * Two cards use it (2026-10-11): the Reminders card over the slots
 * (`slotCount` = every page, `naturalSlot` = the clock's slot), and the Tasks
 * card over the task segments (`slotCount` 0: no page is a slot, so the
 * natural page is the first segment still waiting, and finishing one moves to
 * the first that waits — `naturalPageIndex`, `pageAfterFinishing`).
 *
 * WHICH PAGE SHOWS: the page the card holds (`overrideKey`: a chevron or
 * strip tap, a notification's or a link's page, an automatic move), else the
 * natural one. The card lets go of a held page when the clock says so
 * (RULE PAGER-CLOCK-TAKEOVER, src/lib/panel-pager.ts). It moves by itself in
 * three cases, each decided once a render by `settlePager`:
 * a finished page's beat ending (RULE PAGER-FINISH-BEAT), a period opening or
 * the day turning, and an Undo bringing back the row that finished a page.
 *
 * `day` is the OpenTask day, `basis` what the clock is read against
 * (`usePagerClock`), and `blocked` the card's own reasons to be held.
 * The card spreads `cardProps` on its section and wraps its rows in
 * `PagerHoldProvider value={hold}`.
 */
export function usePanelPager<P extends PagerPage>(
  pages: P[],
  slotCount: number,
  naturalSlot: number,
  { day, basis, blocked = false }: { day: string; basis: string; blocked?: boolean },
) {
  // Which page is held, the finished page's beat, the clock last settled
  // with: one state, settled once a render (`settlePager`).
  const [state, setState] = useState<PagerState>(PAGER_START)
  // Per-page uncapped state — a Set so paging away and back remembers it.
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set())
  // Whether this page's already-considered rows are showing. Per-page, and
  // reset by paging, because "what did I already do here" is a question about
  // one page rather than a mode the card sits in.
  const [showConsidered, setShowConsidered] = useState(false)
  const cardHold = useCardHold()

  const beatKey = state.beat && !state.beat.due ? state.beat.key : null
  useEffect(() => {
    if (beatKey === null) return
    const id = window.setTimeout(() => setState((s) => beatOver(s, beatKey)), FINISH_BEAT_MS)
    return () => window.clearTimeout(id)
  }, [beatKey])

  if (pages.length === 0) return null

  // RULE PAGER-HELD: A dashboard pager card never moves by itself while it
  //   is held: a pointer down on it, select mode, a row's bubble, menu,
  //   editor or sheet open, or the page's considered rows showing. A move
  //   that came due meanwhile is decided again when the hold ends, from the
  //   state then.
  // Why: A page turning under a press, or behind an open menu, acts on a row
  //   the user was not looking at.
  // Ruling: The design session, 2026-11-13 (the hand-off Trent asked for).
  const held = blocked || cardHold.held || showConsidered

  // Settled during render, not in an effect, so a page the card is leaving
  // is not painted once more after its move is due.
  const { next, index } = settlePager(state, {
    pages,
    slotCount,
    naturalSlot,
    day,
    basis,
    held,
  })
  if (next !== state) setState(next)
  const page = pages[index]

  /** A page turned on purpose: by hand, a notification's lift, a link. */
  const goTo = (nextIndex: number) => {
    if (nextIndex < 0 || nextIndex >= pages.length) return
    const key = pages[nextIndex].key
    setState((s) => turnPage(s, key))
    setShowConsidered(false)
  }
  const expanded = expandedKeys.has(page.key)
  const setExpanded = (next: boolean) => {
    setExpandedKeys((prev) => {
      const copy = new Set(prev)
      if (next) copy.add(page.key)
      else copy.delete(page.key)
      return copy
    })
  }
  return {
    page,
    index,
    goTo,
    expanded,
    setExpanded,
    showConsidered,
    toggleConsidered: () => setShowConsidered((v) => !v),
    /** Spread on the card's section: a press on the card holds it. */
    cardProps: {
      onPointerDownCapture: (e: { button: number }) => {
        cardHold.onPointerDownCapture(e)
        setState(touchCard)
      },
    },
    /** For `PagerHoldProvider`: a row's menu holds the card. */
    hold: cardHold.hold,
  }
}
