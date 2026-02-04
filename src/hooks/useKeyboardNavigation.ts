'use client'

import { useCallback, useState, useRef, useEffect } from 'react'
import type { SelectionContextType } from '@/components/SelectionProvider'
import { debug } from '@/lib/logger'

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
  /** Focus handler - enters keyboard mode when listbox itself receives focus */
  handleFocus: (e: React.FocusEvent) => void
  /** Blur handler - exits keyboard mode when focus leaves the list */
  handleBlur: (e: React.FocusEvent) => void
  /** True when actively navigating via keyboard */
  isKeyboardActive: boolean
  /** Call when mouse interaction detected to exit keyboard mode */
  exitKeyboardMode: () => void
  /** Call to enter keyboard mode (e.g., when clicking a task) */
  enterKeyboardMode: () => void
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

  // Move focus only (arrow keys move focus, not selection)
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

      const nextId = orderedIds[nextIndex]
      setKeyboardFocusedId(nextId)

      // Sync browser focus to match the visual blue glow
      document.getElementById(`task-row-${nextId}`)?.focus()
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

      // Sync browser focus to match the visual blue glow
      document.getElementById(`task-row-${nextId}`)?.focus()
    },
    [orderedIds, keyboardFocusedId, setKeyboardFocusedId, selection, moveFocus],
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      debug('keyboard-nav', 'handleKeyDown:', e.key, {
        enabled,
        keyboardFocusedId,
        isKeyboardActive,
      })
      if (!enabled) return

      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0
      const cmdKey = isMac ? e.metaKey : e.ctrlKey

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setIsKeyboardActive(true)
          // If no task is focused yet, just focus the first one (don't select)
          if (keyboardFocusedId === null && orderedIds.length > 0) {
            setKeyboardFocusedId(orderedIds[0])
            document.getElementById(`task-row-${orderedIds[0]}`)?.focus()
          } else if (e.shiftKey) {
            extendSelection('down')
          } else {
            moveFocus('down')
          }
          break

        case 'ArrowUp':
          e.preventDefault()
          setIsKeyboardActive(true)
          // If no task is focused yet, just focus the first one (don't select)
          if (keyboardFocusedId === null && orderedIds.length > 0) {
            setKeyboardFocusedId(orderedIds[0])
            document.getElementById(`task-row-${orderedIds[0]}`)?.focus()
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
            debug('keyboard-nav', 'Space toggling selection for task:', keyboardFocusedId)
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
          // Cmd/Ctrl+A toggles select all visible tasks
          if (cmdKey) {
            e.preventDefault()
            const allSelected =
              orderedIds.length > 0 && orderedIds.every((id) => selection.selectedIds.has(id))
            if (allSelected) {
              selection.clear()
            } else {
              selection.selectAll(orderedIds)
            }
          }
          break

        case 'Home':
          e.preventDefault()
          setIsKeyboardActive(true)
          if (orderedIds.length > 0) {
            setKeyboardFocusedId(orderedIds[0])
            document.getElementById(`task-row-${orderedIds[0]}`)?.focus()
          }
          break

        case 'End':
          e.preventDefault()
          setIsKeyboardActive(true)
          if (orderedIds.length > 0) {
            const lastId = orderedIds[orderedIds.length - 1]
            setKeyboardFocusedId(lastId)
            document.getElementById(`task-row-${lastId}`)?.focus()
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
            // Blur the currently focused element so focus leaves the list entirely
            if (document.activeElement instanceof HTMLElement) {
              document.activeElement.blur()
            }
          } else {
            // Single Escape when no selection: exit keyboard mode
            setIsKeyboardActive(false)
            setKeyboardFocusedId(null)
            // Blur the currently focused element so focus leaves the list entirely
            if (document.activeElement instanceof HTMLElement) {
              document.activeElement.blur()
            }
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
      isKeyboardActive,
    ],
  )

  const handleFocus = useCallback(
    (e: React.FocusEvent) => {
      const target = e.target as HTMLElement
      const targetId = target.id
      const isTaskRow = targetId?.startsWith('task-row-')

      // Check if focus target is inside a task row (e.g., Done button, Link)
      const taskRowAncestor = target.closest('[id^="task-row-"]') as HTMLElement | null
      const taskIdFromAncestor = taskRowAncestor?.id?.replace('task-row-', '')

      debug('keyboard-nav', 'handleFocus:', {
        target: targetId || target.className?.slice(0, 30),
        taskRowAncestor: taskRowAncestor?.id,
        isKeyboardActive,
      })

      // If already in keyboard mode, nothing to do
      if (isKeyboardActive) {
        debug('keyboard-nav', 'handleFocus: already in keyboard mode')
        return
      }

      // If listbox itself receives focus (tabbing in), enter keyboard mode
      if (e.target === e.currentTarget) {
        debug('keyboard-nav', 'handleFocus: listbox focused, entering keyboard mode')
        setIsKeyboardActive(true)
        if (orderedIds.length > 0) {
          setKeyboardFocusedId(orderedIds[0])
          document.getElementById(`task-row-${orderedIds[0]}`)?.focus()
        }
        return
      }

      // If focus is on or inside a task row, enter keyboard mode for that task
      if (isTaskRow || taskRowAncestor) {
        const taskId = isTaskRow
          ? parseInt(targetId.replace('task-row-', ''))
          : parseInt(taskIdFromAncestor || '0')
        if (taskId && orderedIds.includes(taskId)) {
          debug(
            'keyboard-nav',
            'handleFocus: focus inside task row, entering keyboard mode for task',
            taskId,
          )
          setIsKeyboardActive(true)
          setKeyboardFocusedId(taskId)
          return
        }
      }

      debug('keyboard-nav', 'handleFocus: ignoring focus on non-task element')
    },
    [orderedIds, setKeyboardFocusedId, isKeyboardActive],
  )

  const handleBlur = useCallback(
    (e: React.FocusEvent) => {
      const newFocusTarget = e.relatedTarget as HTMLElement | null
      debug('keyboard-nav', 'handleBlur:', {
        target: (e.target as HTMLElement).id || (e.target as HTMLElement).className?.slice(0, 30),
        currentTarget: (e.currentTarget as HTMLElement).getAttribute('role'),
        relatedTarget: newFocusTarget?.id || newFocusTarget?.className?.slice(0, 30) || null,
      })

      // Stay in keyboard mode if focus is moving to:
      // 1. Another task row
      // 2. The listbox itself (can happen when DOM changes, e.g., selection toggle)
      // 3. An element inside a task row (e.g., Done button, Link)
      const isMovingToTaskRow = newFocusTarget?.id?.startsWith('task-row-')
      const isMovingToListbox = newFocusTarget === e.currentTarget
      const isMovingInsideTaskRow = newFocusTarget?.closest('[id^="task-row-"]') != null

      if (isMovingToTaskRow || isMovingToListbox || isMovingInsideTaskRow) {
        debug('keyboard-nav', 'handleBlur: focus staying within list, not exiting')
        return
      }

      debug('keyboard-nav', 'handleBlur: exiting keyboard mode')
      // Focus is leaving task navigation - exit keyboard mode
      setIsKeyboardActive(false)
      setKeyboardFocusedId(null)
    },
    [setKeyboardFocusedId],
  )

  const exitKeyboardMode = useCallback(() => {
    setIsKeyboardActive(false)
    setKeyboardFocusedId(null)
  }, [setKeyboardFocusedId])

  const enterKeyboardMode = useCallback(() => {
    setIsKeyboardActive(true)
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
    enterKeyboardMode,
  }
}
