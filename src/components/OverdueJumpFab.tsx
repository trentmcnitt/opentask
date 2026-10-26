'use client'

import { OVERDUE_LOWER } from '@/lib/task-model-words'
import { CalendarClock } from 'lucide-react'

interface OverdueJumpFabProps {
  /** The date-facet overdue count — the same number as the top bar's red pill. */
  overdueCount: number
  /** The Overdue date filter is selected (the pinned chip's solid state). */
  overdueFilterOn: boolean
  isSelectionMode: boolean
  /** Off: apply the Overdue filter exclusively and scroll to the first task
   *  group. On: take the Overdue filter off, without scrolling. */
  onJump: () => void
  /**
   * `phone`: shown below `md`. `desktop`: shown from `md` up. Rendered once of
   * each, side by side in `DashboardFabStack` — see the placement notes below.
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
 *   2026-10-11: coral became the over-target plum (`bg-over-target`) — Trent
 *   wants nothing about an arrived target to signal that anything is wrong.
 * - **A 48px circle, icon only**, the snooze FAB's size and shape so the two
 *   stack as one column. No number on it, so it can't read as a second copy
 *   of the snooze FAB's red count badge; the count and destination are in the
 *   aria-label and the tooltip.
 * - **A toggle** (Trent, 2026-09-28). While the Overdue filter is on it stays,
 *   drawn pressed — a deeper coral with a coral ring around it — and a tap
 *   clears the filter where the page is, without scrolling (the lit pill's
 *   rule). It used to vanish once the filter was on, leaving no way back from
 *   the corner.
 * - **Hidden** only when nothing is overdue (an Overdue filter left empty
 *   clears itself, `ce069c6`) and in selection mode, where the selection
 *   bar owns the bottom. The Defer FAB below it (`SnoozeOverdueTrigger`) no
 *   longer hides with it (Trent, 2026-10-26): with a selection it stays,
 *   shows the selected count and defers the selection — only the selected
 *   tasks whose target is before the defer time; the rest are counted in the
 *   toast. A jump to the overdue filter has no meaning for a selection, so
 *   this one still goes.
 *
 * **Where it sits.** In the right-hand FAB column (`DashboardFabStack`, which
 * owns the position and the 12px gaps), directly above the snooze FAB — the
 * snooze FAB's red badge pokes 4px above its top (`-top-1`), which leaves 8px
 * of air above the badge. `ViewModeFab` and `JumpToTasksFab` may stack above.
 *
 * **Phone (`placement="phone"`, below `md`).** The Reminders and Quotas panels
 * sit above the task list, so getting to the overdue tasks meant scrolling
 * past both. 80% opaque while the filter is off (Trent, 2026-09-29: "a little
 * more transparency" — it floats over rows), full on press/hover; while the
 * filter is ON it is fully opaque, so the pressed toggle state stays
 * unmistakable.
 *
 * **Desktop (`placement="desktop"`, `md` and up) — added the same day at
 * Trent's request.** It was first phone-only, on the reasoning that the top
 * bar's pills do the same jump there. But the pills are small and scroll-bound
 * in attention, and on a long list nothing on screen offers the jump once
 * you are down among the rows; this does, because it stays in view.
 * - At the viewport's bottom-right with the rest of the column (Trent,
 *   2026-09-28). It first sat at the task list column's right edge to stay
 *   off the Reminders/Quotas column at `xl`, but the page is centred, so that
 *   edge is mid-screen and the button read as misplaced. At `xl` it can now
 *   float over the Quotas column's lower rows, so it is 90% opaque (full on
 *   hover): whatever it covers still shows through.
 * - The selection bar only exists while this button is hidden; the Defer FAB
 *   stays beside it, and `DashboardFabStack` lifts the column clear of the
 *   bar wherever the two would meet (on a phone). The toaster is
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
  const hidden = overdueCount === 0 || isSelectionMode
  if (hidden) return null

  const content = <CalendarClock className="size-5" aria-hidden />
  // The pressed label must not end like the top-bar pill's ("clear the
  // overdue filter"), which the E2E suite finds by its whole label.
  const label = overdueFilterOn
    ? `${overdueCount} ${OVERDUE_LOWER} — showing only ${OVERDUE_LOWER} tasks; tap to show everything`
    : `${overdueCount} ${OVERDUE_LOWER} — show only ${OVERDUE_LOWER} tasks and scroll to them`
  const pill = `size-12 items-center justify-center rounded-full text-white shadow-md ${
    overdueFilterOn
      ? 'bg-over-target ring-2 ring-over-target/50 ring-offset-2 ring-offset-background hover:bg-over-target/90'
      : 'bg-over-target/80 hover:bg-over-target/90 active:bg-over-target/90'
  }`

  if (placement === 'phone') {
    return (
      <button
        type="button"
        onClick={onJump}
        aria-label={label}
        aria-pressed={overdueFilterOn}
        title={`${overdueCount} ${OVERDUE_LOWER}`}
        data-overdue-jump-fab="phone"
        className={`${pill} pointer-events-auto flex cursor-pointer transition-[background-color,opacity] md:hidden ${
          overdueFilterOn ? '' : 'opacity-80 hover:opacity-100 active:opacity-100'
        }`}
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
      aria-pressed={overdueFilterOn}
      title={`${overdueCount} ${OVERDUE_LOWER}`}
      data-overdue-jump-fab="desktop"
      className={`${pill} pointer-events-auto hidden cursor-pointer opacity-90 transition-[background-color,opacity] hover:opacity-100 md:flex`}
    >
      {content}
    </button>
  )
}
