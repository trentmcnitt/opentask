'use client'

import { useRef, type CSSProperties, type ReactNode } from 'react'
import { useToastClearance } from '@/hooks/useToastClearance'
import { useSelectionBarClearance } from '@/hooks/useSelectionBarClearance'

/**
 * The dashboard's right-hand FAB column — one fixed container for every
 * floating button, top to bottom (Trent, 2026-09-29):
 *
 *   1. `JumpToTasksFab` — the frosted chevron (phone only)
 *   2. `ViewModeFab` — the "you're in Today / Newest" button
 *   3. `OverdueJumpFab` — the coral overdue toggle (a phone and a desktop copy)
 *   4. `SnoozeOverdueTrigger` (`variant="fab"`) — the blue snooze-all button
 *
 * WHY ONE CONTAINER. Each button used to be `fixed` on its own, with its
 * `bottom` worked out from which of the buttons below it happened to be
 * showing (`8.25rem` or `12rem`, and so on). With a fourth button that became
 * a table of cases. Now the column is a `flex-col` with a 12px `gap-3`, and a
 * button that doesn't apply returns null — so the ones that remain close up
 * with no hole, whatever combination is showing. The chevron's fade keeps its
 * box (it's `invisible`, not unmounted), but it is the top slot, so that
 * reserves empty space only above the column, never inside it.
 *
 * WHERE. Phone: `right-4`, bottom `4.5rem` above the safe-area inset — clear
 * of the bottom tab bar. From `md`: the viewport's bottom-right, `right-6
 * bottom-6`. The same corner every button used before this refactor.
 *
 * TAPS. The container is `pointer-events-none` so the 12px gaps (and the
 * chevron's reserved slot while faded) don't swallow taps on the rows under
 * them; each button turns them back on for itself (`pointer-events-auto`).
 * `z-40`, as the buttons each had.
 *
 * ABOVE A TOAST (Trent's phone review, 2026-10-22): on a phone the toast is
 * full width just above the tab bar, where the column's bottom buttons sit,
 * and the two overlapped. While a toast is up the column lifts clear of it
 * (snackbar-style) and drops back when it goes: `--toast-clearance`
 * (`useToastClearance`) feeds a `max()` with the usual bottom, so the column
 * only ever moves up. On a wide screen the centred toast never reaches the
 * column, the hook reports nothing, and `md:bottom-6` holds.
 *
 * ABOVE THE SELECTION BAR (2026-10-26): the Defer FAB stays in selection mode
 * now, and on a phone the selection bar's right end meets the column. The bar
 * keeps its place; the column lifts above it the same way
 * (`useSelectionBarClearance`, fed into the same variable as the larger of
 * the two), and only where the two actually overlap.
 */
export function DashboardFabStack({
  selectionBarUp = false,
  children,
}: {
  /** The selection bar is on screen (a task selection) — see below. */
  selectionBarUp?: boolean
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const toast = useToastClearance(ref)
  const bar = useSelectionBarClearance(ref, selectionBarUp)
  const clearance = toast === null && bar === null ? null : Math.max(toast ?? 0, bar ?? 0)
  return (
    <div
      ref={ref}
      data-fab-stack
      data-toast-lifted={clearance !== null ? '' : undefined}
      style={
        clearance !== null
          ? ({ '--toast-clearance': `${clearance}px` } as CSSProperties)
          : undefined
      }
      className="pointer-events-none fixed right-4 bottom-[max(calc(env(safe-area-inset-bottom,0px)+4.5rem),var(--toast-clearance,0px))] z-40 flex flex-col items-end gap-3 transition-[bottom] duration-300 md:right-6 md:bottom-6"
    >
      {children}
    </div>
  )
}
