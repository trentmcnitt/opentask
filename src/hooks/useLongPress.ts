/**
 * Shared long-press hook for pointer-based interactions.
 *
 * Provides a consistent 400ms long-press pattern used by TaskRow, Header,
 * and SnoozeAllFab. Handles touch jitter, double-click detection, and
 * cleanup on unmount.
 *
 * Two variants:
 * - Full (default): Returns React pointer event handlers for components that
 *   need jitter tolerance and double-click detection (TaskRow).
 * - Simple: Returns plain () => void handlers for components that wire into
 *   existing event props without React.PointerEvent parameters (Header buttons,
 *   SnoozeAllFab).
 */

import { useRef, useEffect, useCallback } from 'react'

interface UseLongPressOptions {
  /** Callback when long-press fires (after delay) */
  onLongPress?: () => void
  /** Long-press delay in ms (default 400) */
  delay?: number
  /** Enable double-click detection (default false, mouse only) */
  trackDoubleClick?: boolean
}

interface UseLongPressReturn {
  onPointerDown: (e: React.PointerEvent) => void
  onPointerUp: () => void
  onPointerMove: (e: React.PointerEvent) => void
  onPointerLeave: () => void
  /** True if the most recent pointer interaction triggered the long-press callback. Resets on read. */
  didFire: () => boolean
  /** True if the last interaction was a touch (not mouse/pen) */
  wasTouch: () => boolean
  /** True if this is a double-click. Resets on read. Only meaningful when trackDoubleClick is true. */
  didDoubleClick: () => boolean
}

/**
 * Full long-press hook with React.PointerEvent handlers.
 *
 * Includes jitter tolerance (10px threshold) and optional double-click detection.
 * Use this variant for components that receive React pointer events directly.
 */
export function useLongPress(options: UseLongPressOptions = {}): UseLongPressReturn {
  const { onLongPress, delay = 400, trackDoubleClick = false } = options
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const origin = useRef<{ x: number; y: number } | null>(null)
  const fired = useRef(false)
  const lastPointerType = useRef<string>('mouse')
  const lastClickTime = useRef(0)
  const doubleClicked = useRef(false)

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  const cancel = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
    origin.current = null
  }, [])

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      lastPointerType.current = e.pointerType

      if (trackDoubleClick) {
        const now = Date.now()
        if (e.pointerType === 'mouse' && now - lastClickTime.current < 300) {
          doubleClicked.current = true
        } else {
          doubleClicked.current = false
        }
        lastClickTime.current = now
      }

      if (!onLongPress) return
      fired.current = false
      origin.current = { x: e.clientX, y: e.clientY }
      timer.current = setTimeout(() => {
        fired.current = true
        onLongPress()
      }, delay)
    },
    [onLongPress, delay, trackDoubleClick],
  )

  const onPointerUp = useCallback(() => {
    cancel()
  }, [cancel])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!timer.current || !origin.current) return
    const dx = e.clientX - origin.current.x
    const dy = e.clientY - origin.current.y
    if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  const didFire = useCallback(() => {
    const result = fired.current
    fired.current = false
    return result
  }, [])

  const wasTouch = useCallback(() => lastPointerType.current === 'touch', [])

  const didDoubleClick = useCallback(() => {
    const result = doubleClicked.current
    doubleClicked.current = false
    return result
  }, [])

  return {
    onPointerDown,
    onPointerUp,
    onPointerMove,
    onPointerLeave: cancel,
    didFire,
    wasTouch,
    didDoubleClick,
  }
}

interface UseSimpleLongPressOptions {
  /** Callback when long-press fires (after delay) */
  onLongPress: () => void
  /** Callback for short press (pointerup before delay) */
  onShortPress: () => void
  /** Long-press delay in ms (default 400) */
  delay?: number
}

interface UseSimpleLongPressReturn {
  onPointerDown: () => void
  onPointerUp: () => void
  onPointerLeave: () => void
  /** Keyboard fallback — calls onShortPress if pointer didn't fire */
  onClick: () => void
}

/**
 * Simple long-press hook returning plain () => void handlers.
 *
 * For components where the handler is wired into existing event props
 * without needing React.PointerEvent parameters (Header buttons, SnoozeAllFab).
 * Includes keyboard fallback via onClick.
 */
export function useSimpleLongPress(options: UseSimpleLongPressOptions): UseSimpleLongPressReturn {
  const { onLongPress, onShortPress, delay = 400 } = options
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fired = useRef(false)

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  const onPointerDown = useCallback(() => {
    fired.current = false
    timer.current = setTimeout(() => {
      fired.current = true
      onLongPress()
    }, delay)
  }, [onLongPress, delay])

  const onPointerUp = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
    if (!fired.current) {
      fired.current = true
      onShortPress()
    }
  }, [onShortPress])

  const onPointerLeave = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  const onClick = useCallback(() => {
    if (fired.current) {
      fired.current = false
      return
    }
    onShortPress()
  }, [onShortPress])

  return { onPointerDown, onPointerUp, onPointerLeave, onClick }
}
