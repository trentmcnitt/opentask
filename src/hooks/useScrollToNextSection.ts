'use client'

import { useCallback, useEffect, useRef } from 'react'
import { sectionAfterFinishing } from '@/lib/time-slot-assign'
import { PAGE_RETAP_EVENT } from '@/lib/scroll-to-top'

/**
 * How long the finished section's green "done" shows before the page moves
 * on (Trent's spec, 2026-10-29: "so the section's done state registers").
 */
export const NEXT_SECTION_DELAY_MS = 600

/** Keys that scroll the page by hand: one of them cancels the move. */
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '])

/**
 * FINISHING A SECTION SCROLLS TO THE NEXT ONE (Trent, 2026-10-29, checking
 * things off on the Reminders tab: "after you complete a section, it
 * automatically jumps to the next one, the same way that filling segments
 * does on the dashboard or on the widget"). The /reminders twin of the
 * dashboard pager's move (`usePanelPager`), with a scroll in place of a page
 * turn.
 *
 * - WHICH section finished: the one the user last touched (a pointer or key
 *   inside a section, `data-section-key` — the surface's capture handler,
 *   `onInteract`), going from something waiting to nothing. So a check-off, a
 *   section's "Considered all" (its confirm dialog is outside the section,
 *   but the tap that opened it was inside) and a Defer all all count; a
 *   section finished on another device while the user was elsewhere does not
 *   scroll the page.
 * - WHERE: `sectionAfterFinishing` — the pager's own rule over the same
 *   pages: the earliest period up to now still waiting, then the task
 *   segments in screen order. Nothing left waiting: no move.
 * - WHEN: `NEXT_SECTION_DELAY_MS` later, so the finished section's green
 *   registers first. A wheel, touch scroll, scroll key or a re-tap of the tab
 *   (`PAGE_RETAP_EVENT`) in that time cancels it: the user has taken the page.
 * - Undo puts a row back (waiting up again) and never scrolls back.
 *
 * `goTo` is the surface's `goToSlot` (opens and uncaps the section, then
 * scrolls its header under the top bar — `scrollSectionIntoView`, which jumps
 * instead of animating under reduced motion).
 */
export function useScrollToNextSection({
  pages,
  slotCount,
  naturalSlot,
  goTo,
}: {
  /** The periods in the day's order, then the task segments in screen order. */
  pages: readonly { key: string; waiting: number }[]
  /** How many of `pages` are periods. */
  slotCount: number
  /** The clock's period, an index into `pages` (`naturalSlotIndex`). */
  naturalSlot: number
  goTo: (key: string) => void
}) {
  const lastTouched = useRef<string | null>(null)
  const previous = useRef<Map<string, number> | null>(null)
  const cancelPending = useRef<(() => void) | null>(null)
  const latest = useRef({ pages, slotCount, naturalSlot, goTo })
  useEffect(() => {
    latest.current = { pages, slotCount, naturalSlot, goTo }
  })

  // What the surface waits on, as one string, so the check below runs when a
  // count changes and not on every render.
  const signature = pages.map((p) => `${p.key}=${p.waiting}`).join('|')
  useEffect(() => {
    const { pages, slotCount, naturalSlot, goTo } = latest.current
    const before = previous.current
    previous.current = new Map(pages.map((p) => [p.key, p.waiting]))
    const key = lastTouched.current
    if (!before || !key) return
    const now = previous.current.get(key)
    if (!((before.get(key) ?? 0) > 0 && now === 0)) return
    const target = sectionAfterFinishing(pages, slotCount, key, naturalSlot)
    if (!target) return

    cancelPending.current?.()
    const onKey = (e: KeyboardEvent) => {
      if (SCROLL_KEYS.has(e.key)) cancel()
    }
    const cancel = () => {
      window.clearTimeout(timer)
      window.removeEventListener('wheel', cancel)
      window.removeEventListener('touchmove', cancel)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener(PAGE_RETAP_EVENT, cancel)
      if (cancelPending.current === cancel) cancelPending.current = null
    }
    const timer = window.setTimeout(() => {
      cancel()
      goTo(target)
    }, NEXT_SECTION_DELAY_MS)
    window.addEventListener('wheel', cancel, { passive: true })
    window.addEventListener('touchmove', cancel, { passive: true })
    window.addEventListener('keydown', onKey)
    // A re-tap of the Reminders tab (`scrollPageToTop`) takes the page too.
    window.addEventListener(PAGE_RETAP_EVENT, cancel)
    cancelPending.current = cancel
  }, [signature])

  useEffect(() => () => cancelPending.current?.(), [])

  /** The surface's capture handler: remembers which section was touched. */
  const onInteract = useCallback((e: { target: EventTarget | null }) => {
    const section = e.target instanceof Element ? e.target.closest('[data-section-key]') : null
    const key = section?.getAttribute('data-section-key')
    if (key) lastTouched.current = key
  }, [])

  return { onInteract }
}
