'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { scrollSectionIntoView } from '@/lib/scroll-row-into-view'

/**
 * "Take me to the tasks" for the dashboard (Trent, 2026-09-27): the overdue
 * jump FAB and the top bar's overdue / today pills apply a date filter AND
 * scroll the first task group up under the top bar, so on a phone the
 * Reminders and Quotas panels above the list are not in the way.
 *
 * Same shape as the Reminders surface's `goToSlot` / `useSlotScroll`: a
 * request is a sequence number, consumed in an EFFECT. The caller sets the
 * filter and requests the jump in the same event, React commits both in one
 * render, and the effect then runs against the FILTERED list — so the group
 * it scrolls to is the filtered list's first group, not the one that was
 * there before the tap. No timer involved. (`useFilterSection` derives its
 * auto-expand during render for the same reason — see the comment there.)
 *
 * The target is the first `[data-task-group]` section inside `listRef` (a
 * group — whatever the grouping; in the unified view that one section is the
 * whole flat list, with no header). The empty "All caught up" state has no
 * section, so it falls back to the list wrapper itself. Both carry
 * `scroll-below-header` (globals.css), which is what keeps the target clear
 * of the sticky top bar and the iOS safe area.
 *
 * A short filtered list may not make the page tall enough for the target to
 * reach the top; the browser then stops at the bottom of the page, which
 * still puts the whole filtered list on screen.
 */
export function useJumpToTaskList() {
  const listRef = useRef<HTMLDivElement>(null)
  const [request, setRequest] = useState(0)

  useEffect(() => {
    if (request === 0) return
    const list = listRef.current
    if (!list) return
    scrollSectionIntoView(list.querySelector<HTMLElement>('[data-task-group]') ?? list)
  }, [request])

  const requestJump = useCallback(() => setRequest((n) => n + 1), [])

  return { listRef, requestJump }
}
