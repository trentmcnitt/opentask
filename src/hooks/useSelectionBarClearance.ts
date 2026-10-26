'use client'

import { useEffect, useState, type RefObject } from 'react'

/** Space between the top of the selection bar and the bottom of the FAB column. */
const GAP_PX = 12

/**
 * How far above the viewport's bottom edge the FAB column must sit to clear
 * the selection bar (`SelectionBarShell`, `[data-selection-sheet]`), in px —
 * or null when the bar is not in its way. `useToastClearance`'s sibling, fed
 * into the same `max()` by `DashboardFabStack`.
 *
 * WHY (2026-10-26): the Defer FAB now stays in selection mode (it defers the
 * selection). On a phone the bar is centred just above the tab bar, as wide as
 * its verbs, and its right end reaches the column's corner, so the two
 * overlapped. The bar keeps its place; the column lifts above it while it is
 * up and drops back when the selection clears. On a wide screen the bar is
 * centred and narrow, clear of the column, so nothing moves — the overlap is
 * checked, not assumed from a breakpoint.
 *
 * WHERE THE BAR RESTS, not where it is mid-animation: it slides up with a
 * transform (`animate-slide-up`), so its measured top is off for 200ms.
 * Instead its resting top is its fixed `bottom` plus its height. Its left and
 * right are read from the rect (the slide is vertical only).
 *
 * `active` is the dashboard's selection mode: the bar mounts in the same
 * commit, so the effect runs with it in the DOM. A ResizeObserver catches it
 * changing size ("2 selected" → "12 selected", a larger text size wrapping it
 * to two rows), and a window resize re-measures. No timers.
 */
export function useSelectionBarClearance(
  target: RefObject<HTMLElement | null>,
  active: boolean,
): number | null {
  const [clearance, setClearance] = useState<number | null>(null)
  useEffect(() => {
    if (!active) return
    const bar = document.querySelector<HTMLElement>('[data-selection-sheet]')
    let frame = 0
    const measure = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setClearance(barClearance(bar, target.current)))
    }
    const resize = new ResizeObserver(measure)
    if (bar) resize.observe(bar)
    window.addEventListener('resize', measure)
    measure()
    return () => {
      cancelAnimationFrame(frame)
      resize.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [target, active])
  // Inactive, the last measurement is ignored rather than reset in the effect
  // (and the next activation measures afresh before the bar can be met).
  return active ? clearance : null
}

function barClearance(bar: HTMLElement | null, target: HTMLElement | null): number | null {
  if (!bar || !target || !bar.isConnected) return null
  const box = bar.getBoundingClientRect()
  const mine = target.getBoundingClientRect()
  // Clear (the X) sits on the pill's top-right corner, past the bar's own box
  // (2026-10-26) — right under the column's corner. Measured against the bar,
  // so the slide moving both doesn't matter.
  const clear = bar.querySelector('[data-selection-clear]')?.getBoundingClientRect()
  const overhang = clear ? Math.max(0, box.top - clear.top) : 0
  const right = clear ? Math.max(box.right, clear.right) : box.right
  // Side by side (a wide screen's centred bar): nothing to clear.
  if (right <= mine.left || box.left >= mine.right) return null
  const restingTop =
    window.innerHeight - parseFloat(getComputedStyle(bar).bottom) - bar.offsetHeight
  return Math.ceil(window.innerHeight - restingTop + overhang + GAP_PX)
}
