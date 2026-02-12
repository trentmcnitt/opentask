'use client'

import { useEffect } from 'react'

/** Check if click/touch target is inside a zone that handles its own interaction */
function isInsideInteractiveZone(target: HTMLElement) {
  return (
    target.closest('[role="listbox"]') !== null ||
    target.closest('[id^="task-row-"]') !== null ||
    target.closest('[role="dialog"]') !== null ||
    target.closest('[data-selection-sheet]') !== null ||
    target.closest('button') !== null ||
    target.closest('a') !== null ||
    target.closest('input') !== null ||
    target.closest('textarea') !== null ||
    target.closest('select') !== null
  )
}

interface UseExitModesOptions {
  keyboard: {
    isKeyboardActive: boolean
    exitKeyboardMode: () => void
  }
  selection: {
    isSelectionMode: boolean
    clear: () => void
  }
}

/**
 * Handles exiting keyboard and selection modes on click/touch outside
 * interactive zones. Extracted from HomeContent to reduce page.tsx line count.
 *
 * Three behaviors:
 * 1. Exit keyboard mode on click outside the task list
 * 2. Exit selection mode on double-click outside interactive zones (desktop)
 * 3. Exit selection mode on long-press outside interactive zones (mobile)
 */
export function useExitModes({ keyboard, selection }: UseExitModesOptions) {
  // Exit keyboard mode when clicking outside the task list
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (!keyboard.isKeyboardActive) return

      const target = e.target as HTMLElement
      const isInsideTaskList =
        target.closest('[role="listbox"]') !== null || target.closest('[id^="task-row-"]') !== null

      if (!isInsideTaskList) {
        keyboard.exitKeyboardMode()
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [keyboard])

  // Exit selection mode on double-click outside interactive zones (desktop)
  useEffect(() => {
    if (!selection.isSelectionMode) return

    const handleDblClick = (e: MouseEvent) => {
      if (!isInsideInteractiveZone(e.target as HTMLElement)) {
        selection.clear()
      }
    }

    document.addEventListener('dblclick', handleDblClick)
    return () => document.removeEventListener('dblclick', handleDblClick)
  }, [selection])

  // Exit selection mode on long-press outside interactive zones (mobile)
  useEffect(() => {
    if (!selection.isSelectionMode) return

    const LONG_PRESS_MS = 400
    const JITTER_PX = 10

    let timerId: ReturnType<typeof setTimeout> | null = null
    let startX = 0
    let startY = 0

    const cancel = () => {
      if (timerId !== null) {
        clearTimeout(timerId)
        timerId = null
      }
    }

    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return
      if (isInsideInteractiveZone(e.target as HTMLElement)) return
      startX = e.clientX
      startY = e.clientY
      timerId = setTimeout(() => {
        timerId = null
        selection.clear()
      }, LONG_PRESS_MS)
    }

    const onPointerMove = (e: PointerEvent) => {
      if (timerId === null) return
      const dx = e.clientX - startX
      const dy = e.clientY - startY
      if (Math.sqrt(dx * dx + dy * dy) > JITTER_PX) cancel()
    }

    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('pointermove', onPointerMove)
    document.addEventListener('pointerup', cancel)
    document.addEventListener('pointercancel', cancel)
    return () => {
      cancel()
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('pointermove', onPointerMove)
      document.removeEventListener('pointerup', cancel)
      document.removeEventListener('pointercancel', cancel)
    }
  }, [selection])
}
