'use client'

import { useCallback, useState, useEffect } from 'react'
import type { SelectionContextType } from '@/components/SelectionProvider'
import { debug } from '@/lib/logger'
import { isMacPlatform } from '@/lib/utils'

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

  // Find the first task in the same group as the given task ID
  // Uses orderedIds to respect the current sort order
  const findFirstTaskInGroup = useCallback(
    (taskId: number): number | null => {
      for (const group of groups) {
        const taskInGroup = group.tasks.find((t) => t.id === taskId)
        if (taskInGroup && group.tasks.length > 0) {
          // Get all task IDs in this group
          const groupTaskIds = new Set(group.tasks.map((t) => t.id))
          // Find the first one that appears in orderedIds (respects sort order)
          for (const id of orderedIds) {
            if (groupTaskIds.has(id)) {
              return id
            }
          }
        }
      }
      return orderedIds[0] ?? null
    },
    [groups, orderedIds],
  )

  // Find the last task in the same group as the given task ID
  // Uses orderedIds to respect the current sort order
  const findLastTaskInGroup = useCallback(
    (taskId: number): number | null => {
      for (const group of groups) {
        const taskInGroup = group.tasks.find((t) => t.id === taskId)
        if (taskInGroup && group.tasks.length > 0) {
          // Get all task IDs in this group
          const groupTaskIds = new Set(group.tasks.map((t) => t.id))
          // Find the last one that appears in orderedIds (respects sort order)
          for (let i = orderedIds.length - 1; i >= 0; i--) {
            if (groupTaskIds.has(orderedIds[i])) {
              return orderedIds[i]
            }
          }
        }
      }
      return orderedIds[orderedIds.length - 1] ?? null
    },
    [groups, orderedIds],
  )

  // Get all task IDs in the current group (for Cmd+Shift+A)
  const getTaskIdsInCurrentGroup = useCallback(
    (taskId: number): number[] => {
      for (const group of groups) {
        if (group.tasks.some((t) => t.id === taskId)) {
          const groupTaskIds = new Set(group.tasks.map((t) => t.id))
          // Return in orderedIds order (respects sort)
          return orderedIds.filter((id) => groupTaskIds.has(id))
        }
      }
      return []
    },
    [groups, orderedIds],
  )

  // Find the first task in the next group (for Cmd+Ctrl+Down)
  const findNextGroupFirstTask = useCallback(
    (taskId: number): number | null => {
      // Find current group index
      const currentGroupIndex = groups.findIndex((g) => g.tasks.some((t) => t.id === taskId))
      if (currentGroupIndex === -1 || currentGroupIndex >= groups.length - 1) return null

      // Get next group's task IDs
      const nextGroup = groups[currentGroupIndex + 1]
      const groupTaskIds = new Set(nextGroup.tasks.map((t) => t.id))

      // Find first task in orderedIds that belongs to next group
      for (const id of orderedIds) {
        if (groupTaskIds.has(id)) return id
      }
      return null
    },
    [groups, orderedIds],
  )

  // Find the last task in the previous group (for Cmd+Ctrl+Up)
  const findPrevGroupLastTask = useCallback(
    (taskId: number): number | null => {
      const currentGroupIndex = groups.findIndex((g) => g.tasks.some((t) => t.id === taskId))
      if (currentGroupIndex <= 0) return null

      const prevGroup = groups[currentGroupIndex - 1]
      const groupTaskIds = new Set(prevGroup.tasks.map((t) => t.id))

      // Find last task in orderedIds that belongs to prev group
      for (let i = orderedIds.length - 1; i >= 0; i--) {
        if (groupTaskIds.has(orderedIds[i])) return orderedIds[i]
      }
      return null
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

      const isMac = isMacPlatform()
      const cmdKey = isMac ? e.metaKey : e.ctrlKey

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setIsKeyboardActive(true)
          // If no task is focused yet, just focus the first one (don't select)
          if (keyboardFocusedId === null && orderedIds.length > 0) {
            setKeyboardFocusedId(orderedIds[0])
            document.getElementById(`task-row-${orderedIds[0]}`)?.focus()
          } else if (cmdKey && e.shiftKey && keyboardFocusedId !== null) {
            // Cmd+Shift+Down: Jump to last task in current group, or first of next group if already there
            const lastInGroup = findLastTaskInGroup(keyboardFocusedId)
            if (lastInGroup !== null && lastInGroup !== keyboardFocusedId) {
              // Not at end of group yet - jump to end
              setKeyboardFocusedId(lastInGroup)
              document.getElementById(`task-row-${lastInGroup}`)?.focus()
            } else {
              // Already at end of group - wrap to first of next group
              const nextFirst = findNextGroupFirstTask(keyboardFocusedId)
              if (nextFirst !== null) {
                setKeyboardFocusedId(nextFirst)
                document.getElementById(`task-row-${nextFirst}`)?.focus()
              }
            }
          } else if (cmdKey) {
            // Cmd+Down: Jump to last task in entire list
            if (orderedIds.length > 0) {
              const lastId = orderedIds[orderedIds.length - 1]
              setKeyboardFocusedId(lastId)
              document.getElementById(`task-row-${lastId}`)?.focus()
            }
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
          } else if (cmdKey && e.shiftKey && keyboardFocusedId !== null) {
            // Cmd+Shift+Up: Jump to first task in current group, or last of previous group if already there
            const firstInGroup = findFirstTaskInGroup(keyboardFocusedId)
            if (firstInGroup !== null && firstInGroup !== keyboardFocusedId) {
              // Not at start of group yet - jump to start
              setKeyboardFocusedId(firstInGroup)
              document.getElementById(`task-row-${firstInGroup}`)?.focus()
            } else {
              // Already at start of group - wrap to last of previous group
              const prevLast = findPrevGroupLastTask(keyboardFocusedId)
              if (prevLast !== null) {
                setKeyboardFocusedId(prevLast)
                document.getElementById(`task-row-${prevLast}`)?.focus()
              }
            }
          } else if (cmdKey) {
            // Cmd+Up: Jump to first task in entire list
            if (orderedIds.length > 0) {
              setKeyboardFocusedId(orderedIds[0])
              document.getElementById(`task-row-${orderedIds[0]}`)?.focus()
            }
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
              // Compute next focus BEFORE completion removes the task from state.
              // orderedIds still contains the completed task(s) here because React
              // batches state updates — the closure captures the pre-completion list.
              const completionSet = new Set(idsToComplete)
              let nextFocusId: number | null = null

              if (keyboardFocusedId !== null) {
                const currentIndex = orderedIds.indexOf(keyboardFocusedId)
                if (currentIndex !== -1) {
                  // Look forward first — enables rapid sequential completion
                  for (let i = currentIndex + 1; i < orderedIds.length; i++) {
                    if (!completionSet.has(orderedIds[i])) {
                      nextFocusId = orderedIds[i]
                      break
                    }
                  }
                  // If nothing forward, look backward
                  if (nextFocusId === null) {
                    for (let i = currentIndex - 1; i >= 0; i--) {
                      if (!completionSet.has(orderedIds[i])) {
                        nextFocusId = orderedIds[i]
                        break
                      }
                    }
                  }
                }
              }

              onComplete(idsToComplete)
              selection.clear()
              setKeyboardFocusedId(nextFocusId)

              // Sync browser focus to match the visual blue glow.
              // (Existing code elsewhere does this imperatively — no useEffect auto-syncs it.)
              if (nextFocusId !== null) {
                document.getElementById(`task-row-${nextFocusId}`)?.focus()
              }
            }
          }
          break

        case 'a':
        case 'A':
          if (cmdKey && e.shiftKey) {
            // Cmd+Shift+A: Toggle select all in current group (or first group if nothing focused)
            e.preventDefault()
            setIsKeyboardActive(true)
            const targetTaskId = keyboardFocusedId ?? orderedIds[0]
            if (targetTaskId !== undefined) {
              const groupIds = getTaskIdsInCurrentGroup(targetTaskId)
              if (groupIds.length > 0) {
                const allSelected = groupIds.every((id) => selection.selectedIds.has(id))
                if (allSelected) {
                  selection.removeAll(groupIds)
                } else {
                  selection.addAll(groupIds)
                  // Focus first task in group if not already focused
                  if (keyboardFocusedId === null) {
                    setKeyboardFocusedId(groupIds[0])
                    document.getElementById(`task-row-${groupIds[0]}`)?.focus()
                  }
                }
              }
            }
          } else if (cmdKey) {
            // Cmd/Ctrl+A toggles select all visible tasks
            e.preventDefault()
            setIsKeyboardActive(true)
            const allSelected =
              orderedIds.length > 0 && orderedIds.every((id) => selection.selectedIds.has(id))
            if (allSelected) {
              selection.clear()
            } else {
              selection.selectAll(orderedIds)
              // Focus first task if not already focused
              if (keyboardFocusedId === null && orderedIds.length > 0) {
                setKeyboardFocusedId(orderedIds[0])
                document.getElementById(`task-row-${orderedIds[0]}`)?.focus()
              }
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
          if (selection.isSelectionMode) {
            selection.clear()
          } else {
            setIsKeyboardActive(false)
            setKeyboardFocusedId(null)
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
      findLastTaskInGroup,
      getTaskIdsInCurrentGroup,
      findNextGroupFirstTask,
      findPrevGroupLastTask,
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

  // Clear keyboard focus when the focused task is removed from the list.
  // Keyboard-driven completions (Cmd+D) precompute next focus in the keydown handler,
  // so this only fires for non-keyboard removals (swipe, SSE sync) where clearing is correct.
  useEffect(() => {
    if (keyboardFocusedId !== null && !orderedIds.includes(keyboardFocusedId)) {
      setKeyboardFocusedId(null)
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
