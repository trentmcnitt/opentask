'use client'

import { Clock } from 'lucide-react'

interface SnoozeAllFabProps {
  overdueCount: number
  isSelectionMode: boolean
  onSnoozeOverdue: () => void
}

export function SnoozeAllFab({
  overdueCount,
  isSelectionMode,
  onSnoozeOverdue,
}: SnoozeAllFabProps) {
  if (overdueCount === 0 || isSelectionMode) return null

  return (
    <button
      onClick={onSnoozeOverdue}
      aria-label={`Snooze ${overdueCount} overdue tasks +1h`}
      className="fixed right-4 bottom-[calc(4rem+1rem)] z-40 flex size-12 items-center justify-center rounded-full bg-blue-500 text-white shadow-lg shadow-blue-500/25 transition-colors hover:bg-blue-600 active:bg-blue-700 md:hidden"
    >
      <Clock className="size-5" />
      <span className="bg-destructive text-destructive-foreground absolute -top-1 -right-1 flex size-5 items-center justify-center rounded-full text-[10px] font-bold">
        {overdueCount > 99 ? '99+' : overdueCount}
      </span>
    </button>
  )
}
