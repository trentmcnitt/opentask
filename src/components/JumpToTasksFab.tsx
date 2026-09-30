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
 * toolbar row's top at least 1px below the landing line (the landing read from
 * the wrapper's computed `scroll-margin-top`, so the iOS safe area is
 * included and nothing is hardcoded) — so it comes back
 * the moment you scroll up at all from where a tap put you. At the landing or
 * anywhere past it, it is hidden. (It used to wait until the whole list had
 * dropped below the screen.)
 *
 * **A short page still gets it** (Trent, 09-29 — in Today his list was too
 * short to scroll the toolbar row all the way up to the line, and the button
 * used to hide there, so it looked like the view button had replaced it). The
 * target is the landing scroll position OR the page's maximum scroll,
 * whichever comes first — a tap scrolls there (the browser stops at the
 * bottom of a short page on its own), and the button shows whenever the page
 * is scrolled above that target by more than 1px. So: shown while there is
 * still somewhere to scroll toward the list, hidden at the target, and never
 * shown on a page that can't scroll at all. Measured on scroll (a passive
 * listener, coalesced to one read per frame — a scroll event also fires for a
 * programmatic jump, so a jump straight to the top still reports), when the
 * document's size changes (a `ResizeObserver` on `<html>` — the panels above
 * the list load after the list does) and on window resize. A page that loads
 * already at or past the target never shows it until scrolled above.
 *
 * **Hidden outright** (unmounted, no fade) while searching — the results ARE
 * the list, and the panels above it are hidden then — and in selection mode,
 * where the whole FAB column hides and the selection bar owns the bottom.
 *
 * **Where it sits.** The top of the right-hand FAB column
 * (`DashboardFabStack`), 48px like the rest. While faded it keeps its slot —
 * the top one, so the column shows no hole for it.
 *
 * **Style "A1"** (Trent's pick): a quiet, see-through disc — white at 50% with
 * a hairline border and a soft shadow, dark-grey chevron — so it reads as
 * navigation, not as another action like the coloured buttons below it. Dark
 * mode: the same on the dark surface with a light chevron. No backdrop blur and
 * no heavier fill (Trent, 09-29): it sits over the quota chips, and at 70% with
 * a blur the text underneath was unreadable.
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
    const publish = () => {
      const landingScroll = marker.getBoundingClientRect().top + window.scrollY - landing()
      const maxScroll = document.documentElement.scrollHeight - window.innerHeight
      const target = Math.min(landingScroll, maxScroll)
      setShow(window.scrollY < target - 1)
    }

    let frame = 0
    const onScroll = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        publish()
      })
    }
    publish()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    const ro = new ResizeObserver(onScroll)
    ro.observe(document.documentElement)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      ro.disconnect()
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
      className={`flex size-12 cursor-pointer items-center justify-center rounded-full border border-black/12 bg-white/50 text-zinc-700 shadow-md transition-[opacity,visibility] duration-200 hover:bg-white/80 md:hidden dark:border-white/15 dark:bg-zinc-800/50 dark:text-zinc-100 dark:hover:bg-zinc-800/80 ${
        show ? 'pointer-events-auto visible opacity-100' : 'pointer-events-none invisible opacity-0'
      }`}
    >
      <ChevronDown className="size-6" aria-hidden />
    </button>
  )
}
