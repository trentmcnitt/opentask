'use client'

import { useCallback, useEffect } from 'react'
import { useSelectionMode } from '@/hooks/useSelectionMode'

/**
 * Selecting quota chips on the Quotas page (2026-10-16) — the dashboard's
 * selection model (`useSelectionMode`), fitted to a chip whose plain tap is
 * already spoken for.
 *
 * HOW SELECTION IS ENTERED, AND WHAT EACH GESTURE DOES THERE. A chip is a
 * counter first: a plain tap or click is +1, exactly as before, whenever
 * nothing is selected. So, like a Reminders row (whose tap considers — the
 * nearest sibling with a tap that already acts), selection is entered only by
 * gestures that never meant +1:
 *
 * | Input                         | Nothing selected     | Something selected      |
 * | ----------------------------- | -------------------- | ----------------------- |
 * | Tap / click                   | +1                   | toggle this chip        |
 * | Press and hold (touch, mouse) | select this chip     | range from the anchor   |
 * | Cmd/Ctrl-click                | select this chip     | toggle this chip        |
 * | Shift-click                   | select this chip     | range from the anchor   |
 * | Swipe left, right-click       | −1                   | nothing                 |
 * | Escape                        | —                    | clear                   |
 *
 * (Cmd-click on a Mac, Ctrl-click elsewhere: a Mac's Ctrl-click is a
 * right-click, so it subtracts, as it always has.)
 *
 * - THE PHONE'S SELECT MODE is the dashboard's: a hold turns it on, then a tap
 *   toggles, a further hold extends the range, and the bar's × (or emptying
 *   the selection) turns it off. There is no separate Select button on the
 *   dashboard either.
 * - A TAP IN SELECTION MODE TOGGLES on every platform, as on Reminders, rather
 *   than the dashboard desktop's select-only: the dashboard can afford a
 *   select-only click because a desktop click there does nothing else; here a
 *   click that dropped the rest of a selection would be one slip from a +1.
 * - −1 GESTURES ARE INERT IN SELECTION MODE: a chip being picked is not a
 *   counter, and a stray swipe must not log against a quota that is only
 *   being selected.
 * - WHAT THIS TOOK FROM THE CHIP, ON THIS PAGE ONLY: the hold used to open
 *   the chip's bubble, and shift-click used to subtract. The bubble is now
 *   the bar's Details with one chip selected; −1 keeps swipe-left and
 *   right-click. The dashboard's Track panel is untouched — no selection
 *   there, the hold still opens the bubble and shift still subtracts — since
 *   its selection is the task list's.
 *
 * THE RANGE IS OVER THE CHIPS ON SCREEN. A folded label cluster's chips and a
 * met quota that was put away are still in the DOM, hidden; a shift-range
 * across them must not pick up quotas nobody can see. So the order is read
 * from the panel at the moment of the range — every `[data-track-chip]` that
 * has a box (`getClientRects()` is empty under `display: none`) — which is
 * exactly what is rendered, in rendered order, whatever the fold state.
 */
export function useQuotaChipSelection({
  enabled,
  query,
  filterKey = '',
  panelRef,
}: {
  /** Only the Quotas page selects (`TrackPanel`'s `standalone`). */
  enabled: boolean
  /** The search: a selection made before it no longer matches the screen. */
  query: string
  /** The label filter's selection, as a string: changing it clears, like a new query. */
  filterKey?: string
  panelRef: React.RefObject<HTMLElement | null>
}) {
  const selection = useSelectionMode()
  const { selectedIds, isSelectionMode, toggle, rangeSelect, clear } = selection

  // Escape clears, as on the dashboard and Reminders — but not while a dialog
  // (the multi-edit) is open: there Escape cancels the edit, and the
  // selection must survive to retry it.
  useEffect(() => {
    if (!enabled) return
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape' || selectedIds.size === 0) return
      if (document.querySelector('[role="dialog"]')) return
      clear()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled, selectedIds, clear])

  // A new query clears, exactly as on the Tasks and Reminders pages — and so
  // does a new label filter, as a label chip clears the dashboard's selection.
  useEffect(() => {
    clear()
  }, [query, filterKey, clear])

  const visibleIds = useCallback((): number[] => {
    const panel = panelRef.current
    if (!panel) return []
    return [...panel.querySelectorAll<HTMLElement>('[data-track-chip]')]
      .filter((el) => el.getClientRects().length > 0)
      .map((el) => Number(el.dataset.trackChip))
  }, [panelRef])

  const range = useCallback(
    (id: number) => rangeSelect(id, visibleIds()),
    [rangeSelect, visibleIds],
  )

  /** A press-and-hold on a chip — see the table above. */
  const onHold = useCallback(
    (id: number) => (isSelectionMode ? range(id) : toggle(id)),
    [isSelectionMode, range, toggle],
  )

  /**
   * A click on a chip. True when it was a selection click (the caller then
   * logs nothing); false when it is a plain +1.
   */
  const onClick = useCallback(
    (id: number, e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }): boolean => {
      if (e.shiftKey) {
        range(id)
        return true
      }
      if (e.metaKey || e.ctrlKey || isSelectionMode) {
        toggle(id)
        return true
      }
      return false
    },
    [isSelectionMode, range, toggle],
  )

  return { selectedIds, isSelectionMode, clear, onHold, onClick }
}

export type QuotaChipSelection = ReturnType<typeof useQuotaChipSelection>
