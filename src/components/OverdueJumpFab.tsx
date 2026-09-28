'use client'

import { CalendarClock } from 'lucide-react'

interface OverdueJumpFabProps {
  /** The date-facet overdue count — the same number as the top bar's red pill. */
  overdueCount: number
  /** The Overdue date filter is selected (the pinned chip's solid state). */
  overdueFilterOn: boolean
  isSelectionMode: boolean
  /** Apply the Overdue filter exclusively and scroll to the first task group. */
  onJump: () => void
  /**
   * `phone`: fixed above `SnoozeAllFab`, below `md`. `desktop`: fixed at the
   * viewport's bottom-right, from `md` up. Rendered once of each — see the
   * placement notes below.
   */
  placement: 'phone' | 'desktop'
}

/**
 * "Jump to overdue" button (Trent, 2026-09-27). One tap filters to overdue and
 * scrolls the first group up under the top bar (`useJumpToTaskList`).
 *
 * - **Coral, with a calendar-clock icon** (Trent, 2026-09-27, after several
 *   rounds of mockups). A down arrow didn't say "overdue"; a calendar with a
 *   clock does. The colour is a warm light coral (`#fb7a6a`), deliberately not
 *   the badge red — a hint of "overdue", not an alarm — and not the snooze
 *   FAB's blue, white or dark grey (all rejected: blue made the two buttons
 *   twins, white/grey read as a black disc in dark mode). A red "unread" dot
 *   was mocked and liked but left off for now to keep it quiet.
 * - **A 48px circle, icon only**, the snooze FAB's size and shape so the two
 *   stack as one column. No number on it, so it can't read as a second copy
 *   of the snooze FAB's red count badge; the count and destination are in the
 *   aria-label and the tooltip.
 * - **Hidden** when nothing is overdue, while the Overdue filter is on (the
 *   job is done — the pinned chip shows it, and a second tap here would only
 *   clear it, which is the chip's and the pill's job), and in selection mode,
 *   where `SnoozeAllFab` hides too and the selection bar owns the bottom.
 *
 * **Phone (`placement="phone"`, below `md`).** The Reminders and Quotas panels
 * sit above the task list, so getting to the overdue tasks meant scrolling
 * past both. Fixed, stacked directly above `SnoozeAllFab`: the pill grows to
 * the LEFT from the FAB column's right edge (`right-4`, the snooze FAB's), so
 * the two share a right edge, and its bottom clears the snooze FAB (`4.5rem` +
 * its `3rem`) plus a `0.75rem` gap — the snooze FAB's red badge pokes 4px
 * above its top (`-top-1`), so this leaves 8px of air above the badge.
 *
 * **Desktop (`placement="desktop"`, `md` and up) — added the same day at
 * Trent's request.** It was first phone-only, on the reasoning that the top
 * bar's pills do the same jump there. But the pills are small and scroll-bound
 * in attention, and on a long list nothing on screen offers the jump once
 * you are down among the rows; this does, because it stays in view.
 * - Fixed at the viewport's bottom-right (`right-6 bottom-6`), where a
 *   floating button is expected (Trent, 2026-09-28). It first sat at the task
 *   list column's right edge to stay off the Reminders/Quotas column at `xl`,
 *   but the page is centred, so that edge is mid-screen and the button read
 *   as misplaced. At `xl` it can now float over the Quotas column's lower
 *   rows, so it is 90% opaque (full on hover): whatever it covers still shows
 *   through.
 * - Nothing else lives down there from `md` up: `SnoozeAllFab` is phone-only,
 *   the selection bar only exists while this is hidden, and the toaster is
 *   bottom-center and 356px wide, so even at `md` (768px) it ends well left
 *   of this corner.
 */
export function OverdueJumpFab({
  overdueCount,
  overdueFilterOn,
  isSelectionMode,
  onJump,
  placement,
}: OverdueJumpFabProps) {
  const hidden = overdueCount === 0 || overdueFilterOn || isSelectionMode
  if (hidden) return null

  const content = <CalendarClock className="size-5" aria-hidden />
  const label = `${overdueCount} overdue — show only overdue tasks and scroll to them`
  const pill =
    'size-12 items-center justify-center rounded-full bg-[#fb7a6a] text-white shadow-md hover:bg-[#f86a58] active:bg-[#f86a58]'

  if (placement === 'phone') {
    return (
      <button
        type="button"
        onClick={onJump}
        aria-label={label}
        title={`${overdueCount} overdue`}
        data-overdue-jump-fab="phone"
        className={`${pill} fixed right-4 bottom-[calc(env(safe-area-inset-bottom,0px)+8.25rem)] z-40 flex transition-colors md:hidden`}
      >
        {content}
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={onJump}
      aria-label={label}
      title={`${overdueCount} overdue`}
      data-overdue-jump-fab="desktop"
      className={`${pill} fixed right-6 bottom-6 z-40 hidden opacity-90 transition-[background-color,opacity] hover:opacity-100 md:flex`}
    >
      {content}
    </button>
  )
}
