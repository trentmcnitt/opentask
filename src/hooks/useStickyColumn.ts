import { useEffect, useRef } from 'react'

/** Clearance under the sticky header — the element's class default `top-[4.5rem]`. */
const HEADER_OFFSET_PX = 72
/** Space left under the column's bottom edge when it is pinned there. */
const BOTTOM_GAP_PX = 24

/**
 * A sticky side column that never scrolls on its own ("It can't have two
 * scrollbars shown" — Trent, 09-28). It used to cap its height at the viewport
 * and scroll inside that cap, which put a second scrollbar beside the page's.
 *
 * Without the cap, a column taller than the viewport would stick at the header
 * with its bottom stranded below the fold. So `top` is measured instead:
 *
 * - Column fits: `top` stays at the class default (under the header), as before.
 * - Column is taller: `top` goes negative — `viewport − height − gap`. The
 *   column scrolls with the page until its bottom reaches the viewport's
 *   bottom, then sticks there. Its bottom is always reachable with the one
 *   page scrollbar. (Scrolling back up does not re-show its top until the page
 *   gets there; that is the standard behaviour of this pattern.)
 *
 * `top` is written straight to the element, not through state: it is layout,
 * not render output, and it changes whenever the column's content does
 * (a met quota leaving, a reminder checked off) — hence the ResizeObserver.
 */
export function useStickyColumn<T extends HTMLElement>(enabled: boolean) {
  const ref = useRef<T>(null)

  useEffect(() => {
    const el = ref.current
    if (!el || !enabled) return

    // The column is only sticky at the two-column breakpoint; below it the
    // resize listener clears the override rather than leaving an inert `top`.
    const update = () => {
      el.style.top = ''
      if (getComputedStyle(el).position !== 'sticky') return
      const fitTop = window.innerHeight - el.offsetHeight - BOTTOM_GAP_PX
      if (fitTop < HEADER_OFFSET_PX) el.style.top = `${fitTop}px`
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    window.addEventListener('resize', update)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', update)
      el.style.top = ''
    }
  }, [enabled])

  return ref
}
