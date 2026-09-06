'use client'

import { useRef, useCallback } from 'react'

/**
 * A leftward drag on a control that is also a button.
 *
 * Built for the Track chips (REDESIGN-V03 §5), where a tap is +1 and a drag to
 * the left is −1 — Trent, 2026-09-06: "I think I want to try swiping left to
 * reduce them… For the mouse it would be click and drag to the left."
 *
 * Three details that are easy to get wrong and are the reason this is a hook
 * rather than three inline handlers:
 *
 * 1. **Pointer capture.** Without it the element stops receiving `pointermove`
 *    the moment the finger leaves its bounds, and a chip is about 100px wide —
 *    a real swipe leaves it almost immediately.
 * 2. **`touch-action` is the caller's job**, and it must be `pan-y`: the chips
 *    sit in a vertically scrolling page, so the browser must keep vertical
 *    scrolling while surrendering horizontal movement to us. `touch-manipulation`
 *    would let the browser consume the horizontal drag first.
 * 3. **Suppressing the click.** A drag ends in a `click` on most platforms, and
 *    on a chip that click is +1 — so a swipe that subtracted one would
 *    immediately add it back. `didSwipe()` reports and clears that, exactly the
 *    way useLongPress's `didFire()` does, so the two read the same at the call
 *    site.
 */
/** How far left counts as a swipe. */
const THRESHOLD_PX = 40
/** Past this much vertical movement it is a scroll, not a swipe. */
const VERTICAL_TOLERANCE_PX = 30

export function useHorizontalSwipe({ onSwipeLeft }: { onSwipeLeft: () => void }): {
  onPointerDown: (e: React.PointerEvent) => void
  onPointerMove: (e: React.PointerEvent) => void
  onPointerUp: (e: React.PointerEvent) => void
  onPointerCancel: (e: React.PointerEvent) => void
  didSwipe: () => boolean
} {
  const start = useRef<{ x: number; y: number } | null>(null)
  // ONE flag, cleared at the start of every gesture.
  //
  // There used to be a second, cleared only when `didSwipe()` was read — and
  // the call site reads it behind a `||`, so a long press short-circuited past
  // it and left it set. Worse, iOS Safari suppresses the trailing `click`
  // after a real drag, so nothing read it at all and the NEXT tap on that chip
  // was swallowed: a silently lost +1 on the exact surface this is for.
  const fired = useRef(false)

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    start.current = { x: e.clientX, y: e.clientY }
    fired.current = false
    try {
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    } catch {
      // Capture is an optimisation, not a requirement — a browser that refuses
      // it still swipes correctly as long as the pointer stays on the element.
    }
  }, [])

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!start.current || fired.current) return
      const dx = e.clientX - start.current.x
      const dy = Math.abs(e.clientY - start.current.y)
      if (dy > VERTICAL_TOLERANCE_PX) {
        // Vertical intent wins: this is the page scrolling past.
        start.current = null
        return
      }
      if (dx <= -THRESHOLD_PX) {
        fired.current = true
        onSwipeLeft()
      }
    },
    [onSwipeLeft],
  )

  const release = useCallback((e: React.PointerEvent) => {
    start.current = null
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      // Already released, or never captured.
    }
  }, [])

  const onPointerCancel = useCallback((e: React.PointerEvent) => {
    // Release the capture here too — cancel and up must clean up alike, or a
    // cancelled gesture leaves the element holding the pointer.
    start.current = null
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      // Already released, or never captured.
    }
  }, [])

  /** Did the gesture just ended swipe? Reads the same flag the next
   *  pointerdown clears, so an unread value can never leak into a later tap. */
  const didSwipe = useCallback(() => fired.current, [])

  return { onPointerDown, onPointerMove, onPointerUp: release, onPointerCancel, didSwipe }
}
