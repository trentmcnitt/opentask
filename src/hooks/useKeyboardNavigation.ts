'use client'

import { useCallback, useState, useRef, useEffect } from 'react'
import type { SelectionContextType } from '@/components/SelectionProvider'

/**
 * Keyboard Navigation for Task List
 *
 * Implements the single-container-with-arrow-keys pattern (like Gmail, VS Code file explorer):
 * - The task list is one tab stop (no tabbing through 100+ items)
 * - Arrow keys navigate within the list
 * - Space toggles selection
 * - Cmd/Ctrl+D completes focused/selected tasks
 * - Cmd/Ctrl+A selects all visible tasks
 * - Home/End jumps to first/last task
 * - Escape clears selection or exits keyboard mode
 * - Shift+Arrow extends selection range
 *
 * Focus vs Selection:
 * - "Keyboard focus" = which task has the focus ring (navigated via arrows)
 * - "Selection" = which tasks are selected (checkbox state, for bulk operations)
 * - These are independent: you can focus one task while having others selected
 */

export interface TaskGroup {
  label: string
  tasks: { id: number }[]
}

export interface UseKeyboardNavigationOptions {
  /** Flattened task IDs in display order */
  orderedIds: number[]
  /** Groups with their task IDs (for finding "first in group" after completion) */
  groups: TaskGroup[]
  /** Currently keyboard-focused task ID */
  keyboardFocusedId: number | null
  /** Setter for keyboard focus */
  setKeyboardFocusedId: (id: number | null) => void
  /** Selection context from useSelection() */
  selection: SelectionContextType
  /** Callback when tasks should be completed via keyboard (Cmd+D) */
  onComplete: (taskIds: number[]) => void
  /** Whether keyboard navigation is enabled (disable when dialogs/sheets are open) */
  enabled?: boolean
}

export interface UseKeyboardNavigationReturn {
  /** Key event handler for the list container */
  handleKeyDown: (e: React.KeyboardEvent) => void
  /** Focus handler - focuses first task if none focused */
  handleFocus: () => void
  /** Blur handler */
  handleBlur: () => void
  /** True when actively navigating via keyboard */
  isKeyboardActive: boolean
  /** Call when mouse interaction detected to exit keyboard mode */
  exitKeyboardMode: () => void
}

export function useKeyboardNavigation({
  orderedIds,
  groups,
  keyboardFocusedId,
  setKeyboardFocusedId,
  selection,
  onComplete,
  enabled = true,
}: UseKeyboardNavigationOptions): UseKeyboardNavigationReturn {
  const [isKeyboardActive, setIsKeyboardActive] = useState(false)

  // Track consecutive escape presses
  const lastEscapeTime = useRef<number>(0)

  // Find the first task in the same group as the given task ID
  const findFirstTaskInGroup = useCallback(
    (taskId: number): number | null => {
      for (const group of groups) {
        const taskInGroup = group.tasks.find((t) => t.id === taskId)
        if (taskInGroup && group.tasks.length > 0) {
          return group.tasks[0].id
        }
      }
      return orderedIds[0] ?? null
    },
    [groups, orderedIds],
  )

  // Move focus to adjacent task
  const moveFocus = useCallback(
    (direction: 'up' | 'down') => {
      if (orderedIds.length === 0) return

      const currentIndex = keyboardFocusedId !== null ? orderedIds.indexOf(keyboardFocusedId) : -1

      let nextIndex: number
      if (direction === 'down') {
        nextIndex = currentIndex === -1 ? 0 : Math.min(currentIndex + 1, orderedIds.length - 1)
      } else {
        nextIndex = currentIndex === -1 ? 0 : Math.max(currentIndex - 1, 0)
      }

      setKeyboardFocusedId(orderedIds[nextIndex])
    },
    [orderedIds, keyboardFocusedId, setKeyboardFocusedId],
  )

  // Extend selection in direction (Shift+Arrow)
  const extendSelection = useCallback(
    (direction: 'up' | 'down') => {
      if (orderedIds.length === 0 || keyboardFocusedId === null) {
        moveFocus(direction)
        return
      }

      const currentIndex = orderedIds.indexOf(keyboardFocusedId)
      if (currentIndex === -1) return

      let nextIndex: number
      if (direction === 'down') {
        nextIndex = Math.min(currentIndex + 1, orderedIds.length - 1)
      } else {
        nextIndex = Math.max(currentIndex - 1, 0)
      }

      const nextId = orderedIds[nextIndex]

      // Enter selection mode if not already, and select both current and next
      if (!selection.isSelectionMode) {
        selection.toggle(keyboardFocusedId)
      }

      // Add the next task to selection
      if (!selection.selectedIds.has(nextId)) {
        selection.toggle(nextId)
      }

      setKeyboardFocusedId(nextId)
    },
    [orderedIds, keyboardFocusedId, setKeyboardFocusedId, selection, moveFocus],
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!enabled) return

      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0
      const cmdKey = isMac ? e.metaKey : e.ctrlKey

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setIsKeyboardActive(true)
          // If no task is focused yet, focus the first one
          if (keyboardFocusedId === null && orderedIds.length > 0) {
            setKeyboardFocusedId(orderedIds[0])
          } else if (e.shiftKey) {
            extendSelection('down')
          } else {
            moveFocus('down')
          }
          break

        case 'ArrowUp':
          e.preventDefault()
          setIsKeyboardActive(true)
          // If no task is focused yet, focus the first one
          if (keyboardFocusedId === null && orderedIds.length > 0) {
            setKeyboardFocusedId(orderedIds[0])
          } else if (e.shiftKey) {
            extendSelection('up')
          } else {
            moveFocus('up')
          }
          break

        case ' ':
          // Space toggles selection of focused task
          e.preventDefault()
          if (keyboardFocusedId !== null) {
            selection.toggle(keyboardFocusedId)
          }
          break

        case 'd':
        case 'D':
          // Cmd/Ctrl+D marks focused task(s) as done
          if (cmdKey) {
            e.preventDefault()
            const idsToComplete = selection.isSelectionMode
              ? [...selection.selectedIds]
              : keyboardFocusedId
                ? [keyboardFocusedId]
                : []

            if (idsToComplete.length > 0) {
              // Find first task in current group for post-completion focus
              const currentGroupFirstId = keyboardFocusedId
                ? findFirstTaskInGroup(keyboardFocusedId)
                : null

              onComplete(idsToComplete)

              // After completion: focus first task in group, clear selection
              selection.clear()
              if (currentGroupFirstId !== null) {
                setKeyboardFocusedId(currentGroupFirstId)
              }
            }
          }
          break

        case 'a':
        case 'A':
          // Cmd/Ctrl+A selects all visible tasks
          if (cmdKey) {
            e.preventDefault()
            selection.selectAll(orderedIds)
          }
          break

        case 'Home':
          e.preventDefault()
          setIsKeyboardActive(true)
          if (orderedIds.length > 0) {
            setKeyboardFocusedId(orderedIds[0])
          }
          break

        case 'End':
          e.preventDefault()
          setIsKeyboardActive(true)
          if (orderedIds.length > 0) {
            setKeyboardFocusedId(orderedIds[orderedIds.length - 1])
          }
          break

        case 'Escape':
          e.preventDefault()
          const now = Date.now()
          const timeSinceLastEscape = now - lastEscapeTime.current
          lastEscapeTime.current = now

          if (selection.isSelectionMode) {
            // First Escape: clear selection
            selection.clear()
          } else if (timeSinceLastEscape < 500) {
            // Second Escape within 500ms: exit keyboard mode
            setIsKeyboardActive(false)
            setKeyboardFocusedId(null)
          } else {
            // Single Escape when no selection: exit keyboard mode
            setIsKeyboardActive(false)
            setKeyboardFocusedId(null)
          }
          break
      }
    },
    [
      enabled,
      keyboardFocusedId,
      setKeyboardFocusedId,
      selection,
      orderedIds,
      moveFocus,
      extendSelection,
      onComplete,
      findFirstTaskInGroup,
    ],
  )

  const handleFocus = useCallback(() => {
    // Don't immediately enter keyboard mode on focus - wait for a keyboard event.
    // This prevents mouse clicks from accidentally entering keyboard mode.
    // The first arrow key press will set isKeyboardActive = true and focus a task.
  }, [])

  const handleBlur = useCallback(() => {
    // Don't immediately exit keyboard mode on blur - user might be clicking
    // within the list. The exitKeyboardMode function handles mouse interactions.
  }, [])

  const exitKeyboardMode = useCallback(() => {
    setIsKeyboardActive(false)
  }, [])

  // Reset keyboard focus when orderedIds changes and current focus is no longer in list
  useEffect(() => {
    if (keyboardFocusedId !== null && !orderedIds.includes(keyboardFocusedId)) {
      // Find nearest visible task
      const nearestId = orderedIds[0] ?? null
      setKeyboardFocusedId(nearestId)
    }
  }, [orderedIds, keyboardFocusedId, setKeyboardFocusedId])

  return {
    handleKeyDown,
    handleFocus,
    handleBlur,
    isKeyboardActive,
    exitKeyboardMode,
  }
}
