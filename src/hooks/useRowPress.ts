'use client'

/**
 * A task row's press: what a click, a tap, a double-click and a long-press
 * do — selection, activation (the keyboard focus glow) and the details panel.
 * One rule for every row that offers selection (`TaskRow`; the dashboard-
 * modes prototype's lean row), so they cannot drift.
 */
import { useCallback, useEffect } from 'react'
import { useLongPress } from '@/hooks/useLongPress'

export interface RowPressOptions {
  isSelectionMode?: boolean
  onSelect?: () => void
  onSelectOnly?: () => void
  onRangeSelect?: () => void
  onActivate?: () => void
  onDoubleClick?: () => void
  /** Filled with the long-press cancel, for a parent that drags (SwipeableRow). */
  cancelLongPressRef?: React.MutableRefObject<(() => void) | null>
}

export function useRowPress({
  isSelectionMode,
  onSelect,
  onSelectOnly,
  onRangeSelect,
  onActivate,
  onDoubleClick,
  cancelLongPressRef,
}: RowPressOptions) {
  // Long-press: range-select when already in selection mode, otherwise toggle
  const longPressAction = isSelectionMode && onRangeSelect ? onRangeSelect : onSelect
  const pointer = useLongPress({ onLongPress: longPressAction, trackDoubleClick: true })

  // Expose long-press cancel function to parent (SwipeableRow)
  useEffect(() => {
    if (cancelLongPressRef) {
      cancelLongPressRef.current = pointer.onPointerLeave
    }
  }, [cancelLongPressRef, pointer.onPointerLeave])

  /**
   * Selection behavior by input type:
   *
   * | Context              | Input                   | Action                                     |
   * |----------------------|-------------------------|--------------------------------------------|
   * | Not in selection mode| Desktop click           | activate - show blue glow only (no select) |
   * | Not in selection mode| Desktop double-click    | onDoubleClick - open QuickActionPanel      |
   * | Not in selection mode| Mobile tap              | onDoubleClick - open QuickActionPanel      |
   * | In selection mode    | Desktop plain click     | selectOnly - replace selection             |
   * | In selection mode    | Desktop Cmd/Ctrl+click  | toggle - accumulate selection              |
   * | In selection mode    | Desktop Shift+click     | rangeSelect - select range                 |
   * | In selection mode    | Mobile tap              | toggle - accumulate (no blue glow)         |
   *
   * Rationale: Desktop click just shows focus (blue glow) like Finder - you use Space to
   * actually select. Double-click opens QuickActionPanel for quick edits.
   * Long-press enters selection mode on both desktop and mobile. Mobile tap opens
   * the QuickActionPanel (same as desktop double-click) for quick edits.
   * This separates "where you are" (focus/blue glow) from "what's selected" (checkboxes).
   */
  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (pointer.didFire()) {
        e.preventDefault()
        return
      }

      e.preventDefault()

      // Double-click opens QuickActionPanel (desktop quick edit)
      if (!isSelectionMode && pointer.didDoubleClick() && onDoubleClick) {
        onDoubleClick()
        return
      }

      // In selection mode, also move keyboard focus (blue glow) to the clicked task
      if (e.shiftKey && onRangeSelect) {
        onRangeSelect()
        onActivate?.()
      } else if ((e.metaKey || e.ctrlKey) && onSelect) {
        onSelect()
        onActivate?.()
      } else if (isSelectionMode && pointer.wasTouch() && onSelect) {
        // Touch in selection mode: toggle selection only, no keyboard focus (blue glow).
        // Keyboard focus is a desktop affordance (arrow keys, Space, Cmd+D) with no
        // purpose on mobile — showing it on touch just creates visual noise.
        onSelect()
      } else if (isSelectionMode && onSelectOnly) {
        onSelectOnly()
        onActivate?.()
      } else if (pointer.wasTouch() && onDoubleClick) {
        onDoubleClick()
      } else if (onActivate) {
        onActivate()
      }
    },
    [isSelectionMode, onSelect, onSelectOnly, onRangeSelect, onActivate, onDoubleClick, pointer],
  )

  return { pointer, handleClick }
}
