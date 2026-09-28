'use client'

import { useEffect, useRef, useState } from 'react'
import { ArrowDown } from 'lucide-react'

interface OverdueJumpFabProps {
  /** The date-facet overdue count — the same number as the top bar's red pill. */
  overdueCount: number
  /** The Overdue date filter is selected (the pinned chip's solid state). */
  overdueFilterOn: boolean
  isSelectionMode: boolean
  /** Apply the Overdue filter exclusively and scroll to the first task group. */
  onJump: () => void
  /**
   * `phone`: fixed above `SnoozeAllFab`, below `md`. `desktop`: a sticky grid
   * child of the dashboard's `<main>`, from `md` up. Rendered once of each —
   * see the placement notes below.
   */
  placement: 'phone' | 'desktop'
}

/** The desktop button's resting gap from the viewport bottom (`bottom-6`). */
const DESKTOP_BOTTOM_PX = 24
/** Sonner's desktop `--offset-bottom` (its default; `sonner.tsx` sets none
 *  unless the selection bar is up, and the button is hidden then). */
const TOASTER_BOTTOM_PX = 24
/** Sonner's `--gap`: each collapsed toast behind the front one peeks this far
 *  above it, and at most two peek (`visibleToasts` defaults to 3). */
const TOAST_PEEK_PX = 14
const MAX_PEEKING_TOASTS = 2
/** Air between the top of the toast stack and the lifted button. */
const TOAST_CLEARANCE_GAP_PX = 12

/**
 * How far to lift the desktop button so a toast never sits on top of it.
 *
 * The toaster is `bottom-center` (layout.tsx) and 356px wide, so it only
 * reaches the button in the `xl` two-column layout, where the task column's
 * right edge falls near the middle of the screen, under the toast. Below `xl`
 * the list column is a centred 42rem and the right-aligned button starts well
 * right of the toast (measured: 1280 and 900 wide both clear it), so
 * the horizontal-overlap check keeps it still there rather than bobbing for
 * nothing. The lift is the toast stack's real height — the front toast's
 * layout height (collapsed toasts behind it take that same height) plus the
 * peek of the ones behind — so a toast whose message wraps is cleared too.
 *
 * Watched with a MutationObserver, the way `sonner.tsx` watches for the
 * selection bar: toasts mount and leave outside React's view of this
 * component, and an observer callback runs after the DOM change, so the toast
 * is there to be measured. It observes sonner's always-mounted `<section>`
 * (aria-label "Notifications …") rather than the whole body, so list
 * re-renders do not trigger a measure; the body is only a fallback.
 */
function useToastLift(buttonRef: React.RefObject<HTMLElement | null>, active: boolean): number {
  const [lift, setLift] = useState(0)

  useEffect(() => {
    if (!active) return
    const measure = () => {
      const button = buttonRef.current
      const toaster = document.querySelector<HTMLElement>('[data-sonner-toaster]')
      const toasts = toaster
        ? Array.from(
            toaster.querySelectorAll<HTMLElement>('[data-sonner-toast]:not([data-removed="true"])'),
          )
        : []
      if (!button || !toaster || toasts.length === 0) return setLift(0)
      const b = button.getBoundingClientRect()
      const t = toaster.getBoundingClientRect()
      if (b.width === 0 || b.right <= t.left || b.left >= t.right) return setLift(0)
      const front = Math.max(...toasts.map((el) => el.offsetHeight))
      const peek = Math.min(toasts.length - 1, MAX_PEEKING_TOASTS) * TOAST_PEEK_PX
      setLift(TOASTER_BOTTOM_PX + front + peek + TOAST_CLEARANCE_GAP_PX - DESKTOP_BOTTOM_PX)
    }
    measure()
    const observer = new MutationObserver(measure)
    const region = document.querySelector('section[aria-label^="Notifications"]')
    observer.observe(region ?? document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-removed', 'data-front'],
    })
    return () => observer.disconnect()
  }, [active, buttonRef])

  return active ? lift : 0
}

/**
 * "Jump to overdue" button (Trent, 2026-09-27). One tap filters to overdue and
 * scrolls the first group up under the top bar (`useJumpToTaskList`).
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
 *   say where it goes; the arrow says it moves the page.
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
 * - It sits at the bottom-right of the TASK LIST column, not the viewport's:
 *   at `xl` the viewport's bottom-right is over the Reminders/Quotas column
 *   (`mainClass`, `TrackColumn`). So it is not `fixed` — it is its own grid
 *   child of `<main>`, `sticky bottom-6`, placed in column 1 after the list,
 *   right-justified to that column's edge. Its containing block is `<main>`,
 *   which starts at the top of the page, so it rides the viewport bottom from
 *   the first screen (between `md` and `xl` the panels are still above the
 *   list, exactly the phone's problem) until the page end, where it settles
 *   in its own row below the last task instead of over it.
 * - The wrapper spans the column and is `pointer-events-none`, so only the
 *   pill itself takes clicks; the rows it floats beside stay clickable.
 * - Nothing else lives down there from `md` up: `SnoozeAllFab` is phone-only
 *   and the selection bar only exists while this is hidden. Toasts are the one
 *   neighbour — see `useToastLift`, which lifts the pill above them in the
 *   one layout where they would overlap.
 */
export function OverdueJumpFab({
  overdueCount,
  overdueFilterOn,
  isSelectionMode,
  onJump,
  placement,
}: OverdueJumpFabProps) {
  const hidden = overdueCount === 0 || overdueFilterOn || isSelectionMode
  const buttonRef = useRef<HTMLButtonElement>(null)
  const lift = useToastLift(buttonRef, placement === 'desktop' && !hidden)

  if (hidden) return null

  const content = (
    <>
      <ArrowDown className="text-muted-foreground size-4" aria-hidden />
      <span className="tabular-nums">{overdueCount > 999 ? '999+' : overdueCount}</span>
      <span>overdue</span>
    </>
  )
  const label = `${overdueCount} overdue — show only overdue tasks and scroll to them`
  const pill =
    'border-border bg-popover text-popover-foreground hover:bg-accent active:bg-accent flex h-9 items-center gap-1.5 rounded-full border pr-3.5 pl-3 text-sm font-medium shadow-md'

  if (placement === 'phone') {
    return (
      <button
        type="button"
        onClick={onJump}
        aria-label={label}
        data-overdue-jump-fab="phone"
        className={`${pill} fixed right-4 bottom-[calc(env(safe-area-inset-bottom,0px)+8.25rem)] z-40 transition-colors md:hidden`}
      >
        {content}
      </button>
    )
  }

  return (
    <div className="pointer-events-none sticky bottom-6 z-40 mt-4 hidden min-w-0 justify-end md:flex xl:col-start-1">
      <button
        ref={buttonRef}
        type="button"
        onClick={onJump}
        aria-label={label}
        data-overdue-jump-fab="desktop"
        style={lift ? { transform: `translateY(-${lift}px)` } : undefined}
        className={`${pill} pointer-events-auto transition-[background-color,transform] duration-300`}
      >
        {content}
      </button>
    </div>
  )
}
