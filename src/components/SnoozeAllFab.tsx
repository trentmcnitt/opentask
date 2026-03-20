'use client'

import { useState } from 'react'
import { Clock } from 'lucide-react'
import { SnoozeMenu } from '@/components/SnoozeMenu'
import { useSimpleLongPress } from '@/hooks/useLongPress'

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

  const press = useSimpleLongPress({
    onLongPress: () => setMenuOpen(true),
    onShortPress: () => onSnoozeOverdue(),
  })

  if (isSelectionMode) return null

  return (
    <SnoozeMenu
      open={menuOpen}
      onOpenChange={setMenuOpen}
      onSnooze={(until) => onSnoozeOverdue(until)}
    >
      <button
        onClick={press.onClick}
        onPointerDown={press.onPointerDown}
        onPointerUp={press.onPointerUp}
        onPointerLeave={press.onPointerLeave}
        aria-label={
          overdueCount > 0
            ? `Snooze ${overdueCount} overdue tasks (hold for options)`
            : 'Snooze overdue tasks (hold for options)'
        }
        className="fixed right-4 bottom-[calc(env(safe-area-inset-bottom,0px)+4.5rem)] z-40 flex size-12 items-center justify-center rounded-full bg-blue-500 text-white shadow-lg shadow-blue-500/25 transition-colors hover:bg-blue-600 active:bg-blue-700 md:hidden"
      >
        <Clock className="size-5" />
        {overdueCount > 0 && (
          <span className="bg-badge-destructive text-destructive-foreground absolute -top-1 -right-1 flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[10px] font-bold">
            {overdueCount > 999 ? '999+' : overdueCount}
          </span>
        )}
      </button>
    </SnoozeMenu>
  )
}
