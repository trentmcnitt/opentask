'use client'

import { useState } from 'react'
import { naturalPageIndex, pageAfterFinishing } from '@/lib/time-slot-assign'

/** What a pager needs to know about a page. */
export interface PagerPage {
  key: string
  waiting: number
}

/**
 * What changed about the page on screen since the last render, and whether
 * that was finishing it: the new `seen` to record (null when nothing changed)
 * and the page key to move to, if finishing it means moving on.
 */
function afterFinishing(
  seen: { key: string; waiting: number } | null,
  pages: PagerPage[],
  index: number,
  slotCount: number,
  naturalSlot: number,
): { seen: { key: string; waiting: number }; to: string | null } | null {
  const page = pages[index]
  if (seen?.key === page.key && seen.waiting === page.waiting) return null
  const finished = seen?.key === page.key && seen.waiting > 0 && page.waiting === 0
  const target = finished
    ? pageAfterFinishing(
        pages.map((p) => p.waiting),
        slotCount,
        index,
        naturalSlot,
      )
    : null
  const landing = pages[target ?? index]
  return {
    seen: { key: landing.key, waiting: landing.waiting },
    to: target === null ? null : landing.key,
  }
}

/**
 * The state of one of the dashboard's pager cards: which page is on screen,
 * which pages are uncapped, and whether the page's considered rows show.
 *
 * Two cards use it (2026-10-11): the Reminders card over the slots
 * (`slotCount` = every page, `naturalSlot` = the clock's slot), and the Tasks
 * card over the task segments (`slotCount` 0: no page is a slot, so the
 * natural page is the first segment still waiting, and finishing one moves to
 * the next that waits — `naturalPageIndex`, `pageAfterFinishing`).
 */
export function usePanelPager<P extends PagerPage>(
  pages: P[],
  slotCount: number,
  naturalSlot: number,
) {
  // The chevron override, by page key rather than index: pages can reorder or
  // shrink on a refresh, and a key survives that where an index wouldn't.
  const [overrideKey, setOverrideKey] = useState<string | null>(null)
  // Per-page uncapped state — a Set so paging away and back remembers it.
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set())
  // The page on screen and how many were waiting in it at the last render —
  // how finishing it is told apart from paging to one already finished.
  const [seen, setSeen] = useState<{ key: string; waiting: number } | null>(null)
  // Whether this page's already-considered rows are showing. Per-page, and
  // reset by paging, because "what did I already do here" is a question about
  // one page rather than a mode the card sits in.
  const [showConsidered, setShowConsidered] = useState(false)
  if (pages.length === 0) return null

  const natural = naturalPageIndex(
    pages.map((p) => p.waiting),
    slotCount,
    naturalSlot,
  )
  const overrideIndex = overrideKey ? pages.findIndex((p) => p.key === overrideKey) : -1
  const index = overrideIndex >= 0 ? overrideIndex : natural
  const page = pages[index]

  // FINISHING A PAGE MOVES THE PAGER TO THE EARLIEST UNDONE ONE (Trent,
  // 2026-09-22, refined 2026-09-23 — see `pageAfterFinishing` for the rule).
  // Only a page that went from something waiting to nothing, while on screen,
  // counts: paging to one that was already done leaves you there to look at
  // it. Last check-off, "Considered all" and "Defer all" all qualify. Set
  // during render, not in an effect, so the emptied page is never painted
  // before the move.
  const move = afterFinishing(seen, pages, index, slotCount, naturalSlot)
  if (move) {
    setSeen(move.seen)
    if (move.to) {
      setOverrideKey(move.to)
      setShowConsidered(false)
    }
  }

  const goTo = (nextIndex: number) => {
    if (nextIndex < 0 || nextIndex >= pages.length) return
    setOverrideKey(pages[nextIndex].key)
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
  }
}
