'use client'

import { useEffect, useState, type RefObject } from 'react'
import { ChevronDown } from 'lucide-react'

interface JumpToTasksFabProps {
  /** The task list's wrapper (`useJumpToTaskList`'s `listRef`). Its
   *  `scroll-margin-top` is the landing line. */
  listRef: RefObject<HTMLDivElement | null>
  /** A zero-height marker at the very top of `listRef` — the top of the
   *  list's toolbar row, which is what a tap lands under the top bar. */
  landingRef: RefObject<HTMLDivElement | null>
  isSelectionMode: boolean
  searching: boolean
  /** Scroll the list's toolbar row up under the top bar
   *  (`useJumpToTaskList`'s `'list'` target). */
  onJump: () => void
}

/**
 * How far below the viewport the IntersectionObserver's root reaches — past
 * any page. See "When it shows" below.
 */
const BELOW_EVERYTHING_PX = 1_000_000

/**
 * "Jump to tasks" button — phone only (Trent, 2026-09-29).
 *
 * On a phone the Reminders and Quotas panels sit above the task list, and on a
 * busy day they fill more than a screen, so the tasks start below the fold.
 * This is a way down to them that needs no filter (the overdue button's jump
 * filters to overdue first).
 *
 * **Where a tap lands** (Trent, later the same day). The list's TOOLBAR ROW —
 * "Select All" on the left, the sort control (or Newest's "Newest added"
 * caption, and Unified) on the right — just under the sticky top bar, with the
 * first group right below it. It first landed on the first group, the same
 * spot as the overdue jump, which put that row behind the top bar. The target
 * is now the list wrapper, whose first child is that row
 * (`useJumpToTaskList`'s `'list'` target); its `scroll-below-header` margin is
 * the landing line — the safe-area inset plus 4.5rem, 72px in a browser.
 *
 * **When it shows.** Whenever the page is scrolled ABOVE that landing — the
 * toolbar row's top at least 1px below the landing line — so it comes back
 * the moment you scroll up at all from where a tap put you. At the landing or
 * anywhere past it, it is hidden. (It used to wait until the whole list had
 * dropped below the screen.)
 *
 * Computed without scroll events, by an IntersectionObserver on a zero-height
 * marker at the top of the list wrapper (`landingRef`). Its root is the
 * viewport cut down to a half-plane: the top edge pulled DOWN to 1px below
 * the landing line (`rootMargin` top = −(landing + 1)px, the landing read
 * from the wrapper's computed `scroll-margin-top`, so the iOS safe area is
 * included and nothing is hardcoded) and the bottom edge pushed a million
 * pixels down. So "marker inside the root" is exactly "toolbar row at least
 * 1px below the landing line" (a zero-area target on the root's edge counts
 * as intersecting), and the landing line is the ONLY boundary the marker can
 * cross. That matters because an observer only reports a CHANGE: with a
 * plain viewport root, a jump from far down the list straight back to the
 * top (scrollTo, iOS's tap-the-status-bar) takes a marker from "above the
 * viewport" to "below it" without ever intersecting, so nothing fires. Here
 * "below the viewport" is still inside the root, so every crossing of the
 * landing line, however fast, reports.
 *
 * **Never shows when the landing can't be reached** — a page too short to
 * scroll the toolbar row up to the line, where a tap would scroll a little
 * and stop with the button still showing. Reachable = the scroll position
 * that puts the row on the line is within 1px of the page's maximum scroll or
 * less. Measured whenever the observer reports and whenever the document's
 * size changes (a `ResizeObserver` on `<html>` — the panels above the list
 * load after the list does), again with no polling. A window resize
 * (rotation, which changes the safe-area inset) rebuilds the observer with
 * the new landing. A page that loads already at or past the landing never
 * shows it until scrolled above.
 *
 * **Hidden outright** (unmounted, no fade) while searching — the results ARE
 * the list, and the panels above it are hidden then — and in selection mode,
 * where the whole FAB column hides and the selection bar owns the bottom.
 *
 * **Where it sits.** The top of the right-hand FAB column
 * (`DashboardFabStack`), 48px like the rest. While faded it keeps its slot —
 * the top one, so the column shows no hole for it.
 *
 * **Style "A1"** (Trent's pick): a frosted, quiet disc — translucent white with
 * a blurred backdrop, a hairline border and a soft shadow, dark-grey chevron —
 * so it reads as navigation, not as another action like the coloured buttons
 * below it. Dark mode: the same frosting on the dark surface with a light
 * chevron.
 *
 * The fade uses `visibility` as well as opacity: an `invisible` button can't be
 * tapped or focused, and visibility flips only at the END of a fade-out (and
 * at the start of a fade-in), so the fade still plays.
 */
export function JumpToTasksFab({
  listRef,
  landingRef,
  isSelectionMode,
  searching,
  onJump,
}: JumpToTasksFabProps) {
  const [show, setShow] = useState(false)
  const hidden = isSelectionMode || searching

  useEffect(() => {
    if (hidden) return
    const list = listRef.current
    const marker = landingRef.current
    if (!list || !marker) return

    const landing = () => parseFloat(getComputedStyle(list).scrollMarginTop) || 0
    let aboveLanding = false
    const publish = () => {
      const targetScroll = marker.getBoundingClientRect().top + window.scrollY - landing()
      const maxScroll = document.documentElement.scrollHeight - window.innerHeight
      const reachable = targetScroll - maxScroll < 1
      setShow(aboveLanding && reachable)
    }

    let io: IntersectionObserver | null = null
    const observe = () => {
      io?.disconnect()
      io = new IntersectionObserver(
        ([entry]) => {
          aboveLanding = entry.isIntersecting
          publish()
        },
        { rootMargin: `-${landing() + 1}px 0px ${BELOW_EVERYTHING_PX}px 0px` },
      )
      io.observe(marker)
    }
    observe()
    const ro = new ResizeObserver(publish)
    ro.observe(document.documentElement)
    window.addEventListener('resize', observe)
    return () => {
      io?.disconnect()
      ro.disconnect()
      window.removeEventListener('resize', observe)
    }
  }, [listRef, landingRef, hidden])

  if (hidden) return null

  return (
    <button
      type="button"
      onClick={onJump}
      aria-label="Jump to tasks"
      title="Jump to tasks"
      aria-hidden={!show}
      tabIndex={show ? undefined : -1}
      data-jump-to-tasks-fab
      className={`flex size-12 cursor-pointer items-center justify-center rounded-full border border-black/12 bg-white/70 text-zinc-700 shadow-md backdrop-blur-md transition-[opacity,visibility] duration-200 hover:bg-white/85 md:hidden dark:border-white/15 dark:bg-zinc-800/70 dark:text-zinc-100 dark:hover:bg-zinc-800/85 ${
        show ? 'pointer-events-auto visible opacity-100' : 'pointer-events-none invisible opacity-0'
      }`}
    >
      <ChevronDown className="size-6" aria-hidden />
    </button>
  )
}
