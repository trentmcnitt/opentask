'use client'

import { useRef, useCallback } from 'react'

export type ChipState = 'unselected' | 'included' | 'excluded'

interface UseChipInteractionOptions<T> {
  chipKey: T
  chipState: ChipState
  onToggle: (key: T) => void
  onExclusive?: (key: T) => void
  onExclude?: (key: T) => void
}

/**
 * Shared chip interaction hook for filter bar chips.
 *
 * Encapsulates three interaction patterns:
 * - **Single click**: toggles include (unselected <-> included), or clears exclude (excluded -> unselected)
 * - **Double-click/double-tap** (two clicks within 300ms): toggles exclude.
 *   The first click briefly includes the chip; the second click corrects to excluded.
 * - **Cmd/Ctrl+click or long-press** (400ms touch): exclusive select (include only this, clear all excludes)
 *
 * Interaction model:
 * - Single click on unselected -> included
 * - Single click on included -> unselected
 * - Double-click on unselected -> excluded (first click includes, second corrects to excluded)
 * - Double-click on included -> excluded
 * - Single click on excluded -> unselected
 * - Cmd/Ctrl+click or long-press -> exclusive select (clears excludes)
 *
 * The 300ms double-click window doesn't conflict with the 400ms long-press
 * since they use different input types (click vs pointer).
 */
export function useChipInteraction<T extends string | number>({
  chipKey,
  chipState,
  onToggle,
  onExclusive,
  onExclude,
}: UseChipInteractionOptions<T>) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const originRef = useRef<{ x: number; y: number } | null>(null)
  const firedRef = useRef(false)
  const lastClickTimeRef = useRef(0)

  const cancelLongPress = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    originRef.current = null
  }, [])

  const onClick = useCallback(
    (e: React.MouseEvent) => {
      if (firedRef.current) {
        firedRef.current = false
        return
      }

      // Cmd/Ctrl+click -> exclusive select
      if ((e.metaKey || e.ctrlKey) && onExclusive) {
        lastClickTimeRef.current = 0
        onExclusive(chipKey)
        return
      }

      // Single click on excluded -> unselected (clear exclude)
      if (chipState === 'excluded' && onExclude) {
        lastClickTimeRef.current = 0
        onExclude(chipKey)
        return
      }

      // Double-click detection: two clicks within 300ms -> exclude
      const now = Date.now()
      if (onExclude && now - lastClickTimeRef.current < 300) {
        lastClickTimeRef.current = 0
        onExclude(chipKey)
        return
      }

      lastClickTimeRef.current = now
      onToggle(chipKey)
    },
    [chipKey, chipState, onToggle, onExclusive, onExclude],
  )

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerType !== 'touch' || !onExclusive) return
      firedRef.current = false
      originRef.current = { x: e.clientX, y: e.clientY }
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        firedRef.current = true
        onExclusive(chipKey)
      }, 400)
    },
    [chipKey, onExclusive],
  )

  const onPointerUp = cancelLongPress

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!timerRef.current || !originRef.current) return
      const dx = e.clientX - originRef.current.x
      const dy = e.clientY - originRef.current.y
      if (Math.sqrt(dx * dx + dy * dy) > 10) cancelLongPress()
    },
    [cancelLongPress],
  )

  const onPointerLeave = cancelLongPress

  return { onClick, onPointerDown, onPointerUp, onPointerMove, onPointerLeave }
}
