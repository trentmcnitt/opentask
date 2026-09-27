'use client'

import { ArrowDown } from 'lucide-react'

interface OverdueJumpFabProps {
  /** The date-facet overdue count — the same number as the top bar's red pill. */
  overdueCount: number
  /** The Overdue date filter is selected (the pinned chip's solid state). */
  overdueFilterOn: boolean
  isSelectionMode: boolean
  /** Apply the Overdue filter exclusively and scroll to the first task group. */
  onJump: () => void
}

/**
 * Phone-only "jump to overdue" button, stacked directly above `SnoozeAllFab`
 * (Trent, 2026-09-27). On a phone the Reminders and Quotas panels sit above the
 * task list, so getting to the overdue tasks meant scrolling past both; one tap
 * here filters to overdue and scrolls the first group up under the top bar
 * (`useJumpToTaskList`).
 *
 * - **Neutral, not red.** It is a way to get somewhere, not an alarm — the red
 *   already lives on the snooze FAB's badge and the top bar's pill. So it is
 *   an outlined neutral pill on the app's floating-surface colour
 *   (`bg-popover`, as menus and popovers use): white in light, and one step
 *   lifted off the page in dark, where `bg-background` left only a hairline
 *   border separating it from the rows it floats over.
 * - **Content: "↓ N overdue".** A text pill rather than a second 48px circle:
 *   a bare number in a circle directly above the snooze FAB's red count badge
 *   would read as a second copy of that badge, not as a destination. The words
 *   say where it goes; the arrow says it moves the page. The pill grows to the
 *   LEFT from the FAB column's right edge (`right-4`, the snooze FAB's), so the
 *   two share a right edge.
 * - **Position.** Its bottom clears the snooze FAB (`4.5rem` + its `3rem`)
 *   plus a `0.75rem` gap — the snooze FAB's red badge pokes 4px above its top
 *   (`-top-1`), so this leaves 8px of air above the badge.
 * - **Hidden** when nothing is overdue, while the Overdue filter is on (the
 *   job is done — the pinned chip shows it, and a second tap here would only
 *   clear it, which is the chip's and the pill's job), and in selection mode,
 *   where `SnoozeAllFab` hides too and the selection bar owns the bottom.
 * - **`md:hidden`, like `SnoozeAllFab`.** From `md` up the top bar's pills are
 *   always visible and do the same jump; at `xl` the panels move to their own
 *   column beside the list, so there is nothing to scroll past.
 */
export function OverdueJumpFab({
  overdueCount,
  overdueFilterOn,
  isSelectionMode,
  onJump,
}: OverdueJumpFabProps) {
  if (overdueCount === 0 || overdueFilterOn || isSelectionMode) return null

  return (
    <button
      type="button"
      onClick={onJump}
      aria-label={`${overdueCount} overdue — show only overdue tasks and scroll to them`}
      data-overdue-jump-fab
      className="border-border bg-popover text-popover-foreground hover:bg-accent active:bg-accent fixed right-4 bottom-[calc(env(safe-area-inset-bottom,0px)+8.25rem)] z-40 flex h-9 items-center gap-1.5 rounded-full border pr-3.5 pl-3 text-sm font-medium shadow-md transition-colors md:hidden"
    >
      <ArrowDown className="text-muted-foreground size-4" aria-hidden />
      <span className="tabular-nums">{overdueCount > 999 ? '999+' : overdueCount}</span>
      <span>overdue</span>
    </button>
  )
}
