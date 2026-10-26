'use client'

import { OVERDUE_LOWER } from '@/lib/task-model-words'
import { useState } from 'react'
import { Clock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SnoozeMenu } from '@/components/SnoozeMenu'
import { useSnoozePreferences } from '@/components/PreferencesProvider'
import { useSimpleLongPress } from '@/hooks/useLongPress'
import { bulkSnoozeCompactLabel } from '@/lib/snooze'
import { cn } from '@/lib/utils'

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
  /**
   * Selected task rows (reminders and quotas left out). Above 0 the button
   * acts on the selection instead — a press and the menu both call
   * `onSnoozeSelected` — and its badge shows this count.
   */
  selectedCount?: number
  /** Whether the user has periods, for the header badge ("Next" needs one). */
  hasPeriods: boolean
  /** Called with optional `until` parameter — omit for the default snooze. */
  onSnoozeOverdue: (until?: string) => void
  /** The same, for the selection (`useSnoozeOverdue`'s `snoozeSelected`). */
  onSnoozeSelected?: (until?: string) => void
}

/**
 * The Defer button ("snooze all overdue"), in both of its places.
 *
 * - Tap (or Enter/Space): defer every overdue task — to the next period or
 *   the default option, per the bulk-snooze setting (`useSnoozeOverdue`).
 * - Long-press (400ms, touch or mouse) or right-click: open SnoozeMenu with
 *   the duration choices. `useSimpleLongPress` counts only the primary
 *   button, so a right-click never sweeps.
 *
 * WITH A SELECTION (Trent, 2026-10-26: "I would have kind of expected that the
 * fab button would have just stayed there during selection and the bulk
 * snooze fab would have just applied to the selected items"). The button
 * stays, and both the tap and the menu act on the selected tasks only — at
 * any priority, since a selection is deliberate — and, since a defer only
 * ever moves a target LATER, only on those whose target is before the defer
 * time; the rest are counted in the toast ("Deferred 2 tasks · 1 already
 * later"; `useSnoozeOverdue`, `src/lib/defer-selection.ts`). So that a press can't be
 * mistaken for a sweep of everything, the badge shows the SELECTED count, in
 * the selection bar's colours (`bg-primary`) rather than the overdue badge's,
 * and the label reads "Defer 3 selected". The selection bar keeps Done / More
 * / Trash: it has no Defer of its own.
 *
 * The top-bar clock and the FAB were two hand copies of this, and had drifted:
 * only the FAB opened its menu on a right-click, and the clock's badge read
 * the default snooze option ("+1h") while a press went to the next period.
 * The top-bar clock is kept alongside the FAB on desktop (Trent, 2026-09-29).
 *
 * The FAB sits in `DashboardFabStack`, which places it (phone above the bottom
 * tabs, `md` and up the viewport's bottom-right) and lifts it clear of the
 * selection bar where the two would meet. From `md` up it is 90% opaque like
 * the overdue jump button stacked above it, since at `xl` it can float over
 * the Quotas column's lower rows.
 */
export function SnoozeOverdueTrigger({
  variant,
  overdueCount,
  selectedCount = 0,
  hasPeriods,
  onSnoozeOverdue,
  onSnoozeSelected,
}: SnoozeOverdueTriggerProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const { defaultSnoozeOption, bulkSnoozeDefault } = useSnoozePreferences()
  const selecting = selectedCount > 0 && onSnoozeSelected !== undefined
  const snooze = (until?: string) => (selecting ? onSnoozeSelected(until) : onSnoozeOverdue(until))

  const press = useSimpleLongPress({
    onLongPress: () => setMenuOpen(true),
    onShortPress: () => snooze(),
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
  const ariaLabel = selecting
    ? `Defer ${selectedCount} selected (hold for options)`
    : overdueCount > 0
      ? `Defer ${overdueCount} ${OVERDUE_LOWER} tasks (hold for options)`
      : `Defer ${OVERDUE_LOWER} tasks (hold for options)`
  const badgeCount = selecting ? selectedCount : overdueCount
  const countText = badgeCount > 999 ? '999+' : badgeCount
  // The selected count wears the selection bar's colours, with a ring so it
  // reads against the blue FAB in both themes; the overdue count keeps its own.
  const badgeColors = selecting
    ? 'bg-primary text-primary-foreground ring-2 ring-background'
    : 'bg-over-target-badge text-white'
  const badgeAttrs = selecting ? { 'data-snooze-selected-count': '' } : {}

  return (
    <SnoozeMenu open={menuOpen} onOpenChange={setMenuOpen} onSnooze={(u) => snooze(u)}>
      {variant === 'header' ? (
        <Button
          variant="ghost"
          size="icon"
          {...handlers}
          aria-label={ariaLabel}
          className="relative hidden md:inline-flex"
        >
          <Clock className="size-5" />
          {badgeCount > 0 && (
            <span
              {...badgeAttrs}
              className={cn(
                badgeColors,
                'absolute top-0 right-0 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-none font-bold',
              )}
            >
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
          {badgeCount > 0 && (
            <span
              {...badgeAttrs}
              className={cn(
                badgeColors,
                'absolute -top-1 -right-1 flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[10px] font-bold',
              )}
            >
              {countText}
            </span>
          )}
        </button>
      )}
    </SnoozeMenu>
  )
}
