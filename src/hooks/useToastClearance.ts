'use client'

import { useEffect, useState, type RefObject } from 'react'

/** Space between the top of a toast and the bottom of the FAB column. */
const GAP_PX = 12

/** Sonner's gap between stacked toasts (its default `gap`, 14px). */
const SONNER_GAP_PX = 14

/** Sonner's collapsed stack shows at most this many (its default `visibleToasts`). */
const SONNER_VISIBLE = 3

/**
 * How far above the viewport's bottom edge the FAB column must sit to clear
 * the toasts on screen, in px — or null when no toast is in its way.
 *
 * WHY (Trent's phone review, 2026-10-22, IMG_8857): on a phone the toast is
 * full width, above the tab bar, and the dashboard's FAB column (bottom-right,
 * also above the tab bar) sat across it — the toast's Undo and the snooze FAB
 * overlapped. The snackbar rule: while a toast is up the column lifts above
 * it, and drops back when it goes. On a wide screen the toast is centred and
 * narrow, clear of the column, so nothing moves (the overlap is checked, not
 * assumed from a breakpoint).
 *
 * WHERE A TOAST ENDS UP, not where it is mid-animation: Sonner slides toasts
 * in with a transform, so a measured rect is wrong for 400ms. Instead each
 * live toast's resting top is worked out from the toaster's bottom edge (its
 * fixed offset) and Sonner's own layout: collapsed, the front toast's height
 * plus the gap per toast peeking behind it; expanded (hovered), each toast's
 * `--offset` and `--initial-height`, the values Sonner positions it with. A
 * toast on its way out (`data-removed`) or hidden behind the third is ignored.
 *
 * Recomputed on every change to the toaster (toasts added, removed, mounted,
 * expanded, resized), with no timers.
 */
export function useToastClearance(target: RefObject<HTMLElement | null>): number | null {
  const [clearance, setClearance] = useState<number | null>(null)
  useEffect(() => {
    let frame = 0
    const measure = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setClearance(toastClearance(target.current)))
    }
    const observer = new MutationObserver(measure)
    // The toaster's <section> is always mounted (its list only while toasts
    // are up); observe it, or the body until it appears.
    const section = document.querySelector('section[aria-label^="Notifications"]')
    observer.observe(section ?? document.body, {
      subtree: true,
      childList: true,
      attributes: !!section,
      attributeFilter: section
        ? ['data-mounted', 'data-removed', 'data-expanded', 'data-front', 'style']
        : undefined,
    })
    window.addEventListener('resize', measure)
    measure()
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [target])
  return clearance
}

function toastClearance(target: HTMLElement | null): number | null {
  const toaster = document.querySelector<HTMLElement>('[data-sonner-toaster]')
  if (!target || !toaster) return null
  const toasts = [...toaster.querySelectorAll<HTMLElement>('[data-sonner-toast]')].filter(
    (t) => t.dataset.removed !== 'true' && t.dataset.visible !== 'false',
  )
  if (toasts.length === 0) return null
  const box = toaster.getBoundingClientRect()
  const mine = target.getBoundingClientRect()
  // Side by side (a wide screen's centred toast): nothing to clear.
  if (box.right <= mine.left || box.left >= mine.right) return null

  const front = toasts.find((t) => t.dataset.front === 'true') ?? toasts[0]
  const frontHeight = front.offsetHeight
  let tallest = 0
  if (toasts.some((t) => t.dataset.expanded === 'true')) {
    for (const t of toasts) {
      const offset = parseFloat(t.style.getPropertyValue('--offset')) || 0
      const height = parseFloat(t.style.getPropertyValue('--initial-height')) || t.offsetHeight
      tallest = Math.max(tallest, offset + height)
    }
  } else {
    const behind = Math.min(toasts.length, SONNER_VISIBLE) - 1
    tallest = frontHeight + behind * SONNER_GAP_PX
  }
  // The toaster's bottom edge is where its toasts rest (`bottom: 0` inside it).
  const restingTop = box.bottom - tallest
  return Math.ceil(window.innerHeight - restingTop + GAP_PX)
}
