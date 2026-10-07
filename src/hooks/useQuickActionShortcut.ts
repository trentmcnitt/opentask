import { useEffect, useRef } from 'react'
import type { Task } from '@/types'

interface ShortcutTargetContext {
  isSelectionMode: boolean
  selectedCount: number
  openBulkSheet: () => void
  /** The row with the keyboard's blue glow, when keyboard mode is on. */
  getKeyboardFocusedTask: () => Task | null
  setFocusedTask: (task: Task) => void
}

/**
 * Hook to add Cmd+S / Ctrl+S shortcut for opening the quick action panel.
 *
 * The panel opens on the task the user picked, in this order:
 * 1. Any selection — even one task — opens the selection's panel (the action
 *    bar's More), so a snooze lands on exactly what is selected.
 * 2. The keyboard-focused row.
 * 3. Otherwise `focusedTask`, which rows set on mouse HOVER (TaskRow's
 *    `onMouseEnter`).
 *
 * Hover used to win whenever fewer than two tasks were selected. Moving the
 * mouse down to the action bar crosses the rows the bar sits over, so Cmd+S
 * then +1h snoozed one of those instead of the selected task (2026-10-07).
 */
export function useQuickActionShortcut(
  focusedTask: Task | null,
  setOpen: (open: boolean) => void,
  isOpen: boolean,
  context?: ShortcutTargetContext,
) {
  const focusedTaskRef = useRef(focusedTask)
  useEffect(() => {
    focusedTaskRef.current = focusedTask
  }, [focusedTask])

  const contextRef = useRef(context)
  useEffect(() => {
    contextRef.current = context
  }, [context])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== 's') return
      e.preventDefault()
      if (isOpen) {
        setOpen(false)
        return
      }
      const ctx = contextRef.current
      if (ctx?.isSelectionMode && ctx.selectedCount > 0) {
        ctx.openBulkSheet()
        return
      }
      const keyboardTask = ctx?.getKeyboardFocusedTask() ?? null
      if (keyboardTask) {
        ctx?.setFocusedTask(keyboardTask)
        setOpen(true)
      } else if (focusedTaskRef.current) {
        setOpen(true)
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [isOpen, setOpen])
}
