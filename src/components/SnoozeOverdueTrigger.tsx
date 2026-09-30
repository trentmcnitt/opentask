'use client'

import { useState } from 'react'
import { Clock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SnoozeMenu } from '@/components/SnoozeMenu'
import { useSnoozePreferences } from '@/components/PreferencesProvider'
import { useSimpleLongPress } from '@/hooks/useLongPress'
import { bulkSnoozeCompactLabel } from '@/lib/snooze'

interface SnoozeOverdueTriggerProps {
  /**
   * `header`: the top bar's ghost clock, desktop only (`md` and up), with the
   * compact "where a press goes" badge in its corner.
   * `fab`: the blue floating button at the bottom of `DashboardFabStack`,
   * every width.
   */
  variant: 'header' | 'fab'
  /**
   * Overdue tasks a plain press would sweep. The dashboard passes the count of
   * `displayTasks` — the very list `useSnoozeOverdue` acts on — so the badge
   * and the toast agree (the FAB used to count the AI-filtered list and the
   * clock the date facet, and neither was what a press moved).
   */
  overdueCount: number
  /** Whether the user has periods, for the header badge ("Next" needs one). */
  hasPeriods: boolean
  /** Called with optional `until` parameter — omit for the default snooze. */
  onSnoozeOverdue: (until?: string) => void
}

/**
 * The "snooze all overdue" button, in both of its places.
 *
 * - Tap (or Enter/Space): snooze every overdue task — to the next period or
 *   the default option, per the bulk-snooze setting (`useSnoozeOverdue`).
 * - Long-press (400ms, touch or mouse) or right-click: open SnoozeMenu with
 *   the duration choices. `useSimpleLongPress` counts only the primary
 *   button, so a right-click never sweeps.
 *
 * The top-bar clock and the FAB were two hand copies of this, and had drifted:
 * only the FAB opened its menu on a right-click, and the clock's badge read
 * the default snooze option ("+1h") while a press went to the next period.
 * The top-bar clock is kept alongside the FAB on desktop (Trent, 2026-09-29).
 *
 * The FAB sits in `DashboardFabStack`, which places it (phone above the bottom
 * tabs, `md` and up the viewport's bottom-right). From `md` up it is 90%
 * opaque like the overdue jump button stacked above it, since at `xl` it can
 * float over the Quotas column's lower rows. The caller hides both in
 * selection mode.
 */
export function SnoozeOverdueTrigger({
  variant,
  overdueCount,
  hasPeriods,
  onSnoozeOverdue,
}: SnoozeOverdueTriggerProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const { defaultSnoozeOption, bulkSnoozeDefault } = useSnoozePreferences()

  const press = useSimpleLongPress({
    onLongPress: () => setMenuOpen(true),
    onShortPress: () => onSnoozeOverdue(),
  })

  const handlers = {
    onClick: press.onClick,
    onPointerDown: press.onPointerDown,
    onPointerUp: press.onPointerUp,
    onPointerLeave: press.onPointerLeave,
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault()
      setMenuOpen(true)
    },
  }
  const ariaLabel =
    overdueCount > 0
      ? `Snooze ${overdueCount} overdue tasks (hold for options)`
      : 'Snooze overdue tasks (hold for options)'
  const countText = overdueCount > 999 ? '999+' : overdueCount

  return (
    <SnoozeMenu open={menuOpen} onOpenChange={setMenuOpen} onSnooze={(u) => onSnoozeOverdue(u)}>
      {variant === 'header' ? (
        <Button
          variant="ghost"
          size="icon"
          {...handlers}
          aria-label={ariaLabel}
          className="relative hidden md:inline-flex"
        >
          <Clock className="size-5" />
          {overdueCount > 0 && (
            <span className="bg-badge-destructive text-destructive-foreground absolute top-0 right-0 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-none font-bold">
              {countText}
            </span>
          )}
          <span
            data-snooze-default-label
            className="bg-muted text-muted-foreground absolute right-0 bottom-0 rounded px-0.5 text-[8px] leading-tight font-medium"
          >
            {bulkSnoozeCompactLabel(bulkSnoozeDefault, defaultSnoozeOption, hasPeriods)}
          </span>
        </Button>
      ) : (
        <button
          {...handlers}
          data-snooze-all-fab
          aria-label={ariaLabel}
          className="pointer-events-auto relative flex size-12 cursor-pointer items-center justify-center rounded-full bg-blue-500 text-white shadow-lg shadow-blue-500/25 transition-[background-color,opacity] hover:bg-blue-600 active:bg-blue-700 md:opacity-90 md:hover:opacity-100"
        >
          <Clock className="size-5" />
          {overdueCount > 0 && (
            <span className="bg-badge-destructive text-destructive-foreground absolute -top-1 -right-1 flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[10px] font-bold">
              {countText}
            </span>
          )}
        </button>
      )}
    </SnoozeMenu>
  )
}
