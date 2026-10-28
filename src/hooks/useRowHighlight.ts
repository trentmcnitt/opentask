'use client'

/**
 * A task row's highlight: the widget's `?task=<id>&highlight=1` link lands
 * on the dashboard and the row flashes (`data-task-highlight`, the
 * `row-highlight` animation). One rule for every dashboard row (`TaskRow`,
 * `LeanRow`).
 *
 * `highlighted` (the widget's `?task=<id>&highlight=1` link): keep the row
 * centred for as long as the highlight is alive, not just once on mount.
 *
 * Unlike RemindersView's `?reminder=<id>` (a plain `ref={highlighted ?
 * scrollRowIntoView : undefined}` — see `scrollRowIntoView`'s doc comment),
 * the dashboard has several panels — Reminders, Track, AI Insights
 * annotations — that fetch and mount AFTER this row does, each one pushing
 * the row further down the page. A single scroll on mount goes stale the
 * moment any of them lands; found by browser-verifying against Trent's
 * real dev account, where the row scrolled off-screen again within a
 * second of landing on it.
 *
 * A `ResizeObserver` on `document.body` re-centers on every layout change
 * instead of guessing a delay — no timeout, no retry count, just a
 * response to the actual event (the page's height changing). It also
 * fires once immediately on `observe()`, so the initial scroll comes for
 * free. Torn down the moment the highlight's flash ends (`onHighlightDone`
 * flips `highlighted` false via `onAnimationEnd` below), so it never
 * outlives the thing it's centering.
 */
import { useEffect, useRef } from 'react'
import { scrollRowIntoView } from '@/lib/scroll-row-into-view'

export function useRowHighlight(highlighted: boolean | undefined, onHighlightDone?: () => void) {
  const rowRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!highlighted) return
    const ro = new ResizeObserver(() => scrollRowIntoView(rowRef.current))
    ro.observe(document.body)
    return () => ro.disconnect()
  }, [highlighted])

  const highlightProps = {
    'data-task-highlight': highlighted ? '' : undefined,
    onAnimationEnd: (e: React.AnimationEvent<HTMLDivElement>) => {
      // Filtered: the row can also run `animate-ai-processing`, whose
      // `animationend` must not spend the one-shot highlight early.
      if (e.target === e.currentTarget && e.animationName === 'row-highlight') {
        onHighlightDone?.()
      }
    },
  }
  return { rowRef, highlightProps }
}
