'use client'

import { useEffect, useState, type RefObject } from 'react'
import { ChevronDown } from 'lucide-react'

interface JumpToTasksFabProps {
  /** The task list's wrapper (`useJumpToTaskList`'s `listRef`). */
  listRef: RefObject<HTMLDivElement | null>
  /** `OverdueJumpFab` (phone) is showing, so this button stacks above it. */
  aboveOverdueFab: boolean
  isSelectionMode: boolean
  searching: boolean
  /** Scroll the first task group up under the top bar (`useJumpToTaskList`). */
  onJump: () => void
}

/**
 * "Jump to tasks" button — phone only (Trent, 2026-09-29).
 *
 * On a phone the Reminders and Quotas panels sit above the task list, and on a
 * busy day they fill more than a screen, so the tasks start below the fold.
 * This is a way down to them that needs no filter (the overdue button's jump
 * filters to overdue first). One tap smooth-scrolls the first task group up
 * under the top bar — the same `useJumpToTaskList` request the overdue button
 * and the top-bar pills use, so it lands on the same spot.
 *
 * **When it shows.** Only while the start of the task list is BELOW the
 * viewport — i.e. there is still something to jump down to. Once the list's
 * start is on screen (scrolled to it, or it was already there at load) or has
 * gone above the top (scrolled past it), the button fades out; scroll back up
 * until the list's start drops below the bottom edge again and it fades back
 * in. If the list starts on screen at load it never appears.
 *
 * Computed with an IntersectionObserver on the task list's wrapper
 * (`listRef`), not scroll events: `visible = the list is not in the viewport
 * at all AND it is below it` (`boundingClientRect.top > 0`). "List entirely
 * below the viewport" is exactly "its start is below the viewport". The whole
 * list is observed rather than a 1px marker at its top because an observer
 * only reports a CHANGE of intersection: a jump from far down the list
 * straight back to the top (scrollTo, iOS's tap-the-status-bar) takes a 1px
 * marker from "above" to "below" without it ever intersecting, so no callback
 * fires and the button stays hidden. The whole list can't be skipped over
 * like that — leaving it always reports. The observer's bottom edge is pulled
 * up by the bottom tab bar's height (4rem), since a list start hidden behind
 * the tabs is not on screen either. It starts hidden; the observer's first
 * callback, which fires as soon as it starts observing, sets the real state.
 *
 * **Hidden outright** (unmounted, no fade) while searching — the results ARE
 * the list, and the panels above it are hidden then — and in selection mode,
 * where `SnoozeAllFab` and `OverdueJumpFab` hide too and the selection bar
 * owns the bottom.
 *
 * **Where it sits.** The top of the right-hand FAB column: the snooze FAB is
 * at `4.5rem`, the overdue button above it at `8.25rem` (each 3rem tall, with
 * a 0.75rem gap). This one takes the next slot up (`12rem`) — or the overdue
 * button's slot (`8.25rem`) when that one is absent (nothing overdue), so the
 * column never has a hole in it. Same right edge (`right-4`) and 48px size.
 *
 * **Style "A1"** (Trent's pick): a frosted, quiet disc — translucent white with
 * a blurred backdrop, a hairline border and a soft shadow, dark-grey chevron —
 * so it reads as navigation, not as another action like the coral and blue
 * buttons below it. Dark mode: the same frosting on the dark surface with a
 * light chevron.
 *
 * The fade uses `visibility` as well as opacity: an `invisible` button can't be
 * tapped or focused, and visibility flips only at the END of a fade-out (and
 * at the start of a fade-in), so the fade still plays.
 */
export function JumpToTasksFab({
  listRef,
  aboveOverdueFab,
  isSelectionMode,
  searching,
  onJump,
}: JumpToTasksFabProps) {
  const [listBelow, setListBelow] = useState(false)
  const hidden = isSelectionMode || searching

  useEffect(() => {
    if (hidden) return
    const list = listRef.current
    if (!list) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        setListBelow(!entry.isIntersecting && entry.boundingClientRect.top > 0)
      },
      { rootMargin: '0px 0px -64px 0px' },
    )
    observer.observe(list)
    return () => observer.disconnect()
  }, [listRef, hidden])

  if (hidden) return null

  const bottom = aboveOverdueFab
    ? 'bottom-[calc(env(safe-area-inset-bottom,0px)+12rem)]'
    : 'bottom-[calc(env(safe-area-inset-bottom,0px)+8.25rem)]'

  return (
    <button
      type="button"
      onClick={onJump}
      aria-label="Jump to tasks"
      title="Jump to tasks"
      aria-hidden={!listBelow}
      tabIndex={listBelow ? undefined : -1}
      data-jump-to-tasks-fab
      className={`fixed right-4 ${bottom} z-40 flex size-12 cursor-pointer items-center justify-center rounded-full border border-black/12 bg-white/70 text-zinc-700 shadow-md backdrop-blur-md transition-[opacity,visibility] duration-200 hover:bg-white/85 md:hidden dark:border-white/15 dark:bg-zinc-800/70 dark:text-zinc-100 dark:hover:bg-zinc-800/85 ${
        listBelow ? 'visible opacity-100' : 'pointer-events-none invisible opacity-0'
      }`}
    >
      <ChevronDown className="size-6" aria-hidden />
    </button>
  )
}
