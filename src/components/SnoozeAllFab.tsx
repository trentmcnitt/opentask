'use client'

import { useRef, useEffect, useCallback, useState } from 'react'
import { Clock } from 'lucide-react'
import { SnoozeMenu } from '@/components/SnoozeMenu'

interface SnoozeAllFabProps {
  overdueCount: number
  isSelectionMode: boolean
  /** Called with optional `until` parameter — omit for default snooze */
  onSnoozeOverdue: (until?: string) => void
}

/**
 * Floating action button for snoozing all overdue tasks.
 * Single tap: snooze using user's default option.
 * Long-press (400ms): opens SnoozeMenu with duration choices.
 */
export function SnoozeAllFab({
  overdueCount,
  isSelectionMode,
  onSnoozeOverdue,
}: SnoozeAllFabProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const firedRef = useRef(false)
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  const handlePointerDown = useCallback(() => {
    firedRef.current = false
    timerRef.current = setTimeout(() => {
      firedRef.current = true
      setMenuOpen(true)
    }, 400)
  }, [])

  // Primary trigger: quick tap detected via pointerup (not click),
  // because stopPropagation on pointerdown can prevent click synthesis.
  const handlePointerUp = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    if (!firedRef.current) {
      firedRef.current = true // suppress any subsequent click
      onSnoozeOverdue()
    }
  }, [onSnoozeOverdue])

  // Fallback for keyboard activation (Enter/Space)
  const handleClick = useCallback(() => {
    if (firedRef.current) {
      firedRef.current = false
      return
    }
    onSnoozeOverdue()
  }, [onSnoozeOverdue])

  if (overdueCount === 0 || isSelectionMode) return null

  return (
    <SnoozeMenu
      open={menuOpen}
      onOpenChange={setMenuOpen}
      onSnooze={(until) => onSnoozeOverdue(until)}
    >
      <button
        onClick={handleClick}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerLeave={() => {
          if (timerRef.current) {
            clearTimeout(timerRef.current)
            timerRef.current = null
          }
        }}
        aria-label={`Snooze ${overdueCount} overdue tasks (hold for options)`}
        className="fixed right-4 bottom-[calc(4rem+1.5rem)] z-40 flex size-12 items-center justify-center rounded-full bg-blue-500 text-white shadow-lg shadow-blue-500/25 transition-colors hover:bg-blue-600 active:bg-blue-700 md:hidden"
      >
        <Clock className="size-5" />
        <span className="bg-destructive text-destructive-foreground absolute -top-1 -right-1 flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[10px] font-bold">
          {overdueCount > 999 ? '999+' : overdueCount}
        </span>
      </button>
    </SnoozeMenu>
  )
}
