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
 * Long-press (400ms, touch or mouse) or right-click: opens SnoozeMenu with
 * duration choices.
 *
 * Shown on every width (Trent, 2026-09-28 — it was phone-only, with the top
 * bar's clock as the desktop control). It is the bottom of the right-hand FAB
 * column (`DashboardFabStack`, which places it: phone above the bottom tabs,
 * `md` and up the viewport's bottom-right). From `md` up it is 90% opaque like
 * the overdue jump button stacked above it, since at `xl` it can float over
 * the Quotas column's lower rows.
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
        onContextMenu={(e) => {
          e.preventDefault()
          setMenuOpen(true)
        }}
        data-snooze-all-fab
        aria-label={
          overdueCount > 0
            ? `Snooze ${overdueCount} overdue tasks (hold for options)`
            : 'Snooze overdue tasks (hold for options)'
        }
        className="pointer-events-auto relative flex size-12 cursor-pointer items-center justify-center rounded-full bg-blue-500 text-white shadow-lg shadow-blue-500/25 transition-[background-color,opacity] hover:bg-blue-600 active:bg-blue-700 md:opacity-90 md:hover:opacity-100"
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
