'use client'

import type { ReactNode } from 'react'

/**
 * The dashboard's right-hand FAB column — one fixed container for every
 * floating button, top to bottom (Trent, 2026-09-29):
 *
 *   1. `JumpToTasksFab` — the frosted chevron (phone only)
 *   2. `ViewModeFab` — the "you're in Today / Newest" button
 *   3. `OverdueJumpFab` — the coral overdue toggle (a phone and a desktop copy)
 *   4. `SnoozeAllFab` — the blue snooze-all button
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
 */
export function DashboardFabStack({ children }: { children: ReactNode }) {
  return (
    <div
      data-fab-stack
      className="pointer-events-none fixed right-4 bottom-[calc(env(safe-area-inset-bottom,0px)+4.5rem)] z-40 flex flex-col items-end gap-3 md:right-6 md:bottom-6"
    >
      {children}
    </div>
  )
}
