'use client'

import { useRef, useCallback } from 'react'

interface UseChipSelectOptions {
  onToggle: (key: string) => void
  onExclusive: (key: string) => void
}

interface UseChipSelectReturn {
  /** Click handler: Cmd/Ctrl+click → exclusive, normal click → toggle */
  handleClick: (key: string, e: React.MouseEvent) => void
  /** Returns pointer event handlers for long-press exclusive select (touch-only, 400ms, 10px jitter) */
  getLongPressHandlers: (key: string) => {
    onPointerDown: (e: React.PointerEvent) => void
    onPointerUp: () => void
    onPointerMove: (e: React.PointerEvent) => void
    onPointerLeave: () => void
  }
}

const LONG_PRESS_MS = 400
const JITTER_PX = 10

/**
 * Shared Cmd+click + long-press logic for filter chips.
 *
 * - Normal click: toggles the chip (additive multi-select)
 * - Cmd/Ctrl+click: exclusive select (deselect all others, select only this one;
 *   if already the only one selected, clear all)
 * - Mobile long-press (400ms, 10px jitter, touch-only): same as Cmd+click
 */
export function useChipSelect({
  onToggle,
  onExclusive,
}: UseChipSelectOptions): UseChipSelectReturn {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const originRef = useRef<{ x: number; y: number } | null>(null)
  const firedRef = useRef(false)

  const cancel = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    originRef.current = null
  }, [])

  const handleClick = useCallback(
    (key: string, e: React.MouseEvent) => {
      // Skip if long-press already fired
      if (firedRef.current) {
        firedRef.current = false
        return
      }
      if (e.metaKey || e.ctrlKey) {
        onExclusive(key)
      } else {
        onToggle(key)
      }
    },
    [onToggle, onExclusive],
  )

  const getLongPressHandlers = useCallback(
    (key: string) => ({
      onPointerDown: (e: React.PointerEvent) => {
        if (e.pointerType !== 'touch') return
        firedRef.current = false
        originRef.current = { x: e.clientX, y: e.clientY }
        timerRef.current = setTimeout(() => {
          timerRef.current = null
          firedRef.current = true
          onExclusive(key)
        }, LONG_PRESS_MS)
      },
      onPointerUp: () => {
        cancel()
      },
      onPointerMove: (e: React.PointerEvent) => {
        if (timerRef.current === null || originRef.current === null) return
        const dx = e.clientX - originRef.current.x
        const dy = e.clientY - originRef.current.y
        if (Math.sqrt(dx * dx + dy * dy) > JITTER_PX) cancel()
      },
      onPointerLeave: () => {
        cancel()
      },
    }),
    [onExclusive, cancel],
  )

  return { handleClick, getLongPressHandlers }
}
