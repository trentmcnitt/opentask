'use client'

import type React from 'react'
import { useEffect } from 'react'
import { sortTasks } from '@/components/TaskList'
import type { TaskGroup } from '@/components/TaskList'
import type { SortOption } from '@/hooks/useGroupSort'
import type { Project } from '@/types'
import { formatTasksForClipboard, type ClipboardGroup } from '@/lib/format-task'
import { showToast } from '@/lib/toast'
import { taskWord, isMacPlatform } from '@/lib/utils'

interface UseDashboardKeyboardOptions {
  keyboard: {
    isKeyboardActive: boolean
    enterKeyboardMode: () => void
  }
  keyboardNavEnabled: boolean
  orderedIds: number[]
  setKeyboardFocusedId: (id: number | null) => void
  selection: {
    isSelectionMode: boolean
    selectedIds: Set<number>
    selectAll: (ids: number[]) => void
    addAll: (ids: number[]) => void
    removeAll: (ids: number[]) => void
    clear: () => void
  }
  taskGroups: TaskGroup[]
  sortOption: SortOption
  reversed: boolean
  timezone: string
  projects: Project[]
  annotationMap?: Map<number, string>
  showAnnotations: boolean
  setShowShortcutsDialog: (show: boolean) => void
  searchFocusRef?: React.MutableRefObject<(() => void) | null>
}

/**
 * Global keyboard shortcuts for the dashboard.
 * Extracted from HomeContent to reduce page.tsx line count.
 *
 * Handles: ?, Cmd+C (copy), Cmd+L (focus first), Arrow keys (enter list),
 * Home/End, Cmd+A (select all), Cmd+Shift+A (select first group).
 */
export function useDashboardKeyboard({
  keyboard,
  keyboardNavEnabled,
  orderedIds,
  setKeyboardFocusedId,
  selection,
  taskGroups,
  sortOption,
  reversed,
  timezone,
  projects,
  annotationMap,
  showAnnotations,
  setShowShortcutsDialog,
  searchFocusRef,
}: UseDashboardKeyboardOptions) {
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      const isMac = isMacPlatform()
      const cmdKey = isMac ? e.metaKey : e.ctrlKey

      // Don't intercept when user is in an input, textarea, or contenteditable
      const activeEl = document.activeElement
      const isInInput =
        activeEl instanceof HTMLInputElement ||
        activeEl instanceof HTMLTextAreaElement ||
        (activeEl as HTMLElement)?.isContentEditable

      // ?: Open keyboard shortcuts help dialog (works globally, even with dialogs open)
      if (e.key === '?' && !isInInput) {
        e.preventDefault()
        setShowShortcutsDialog(true)
        return
      }

      // Cmd+K: Focus search bar (works even with dialogs open)
      if (cmdKey && e.key === 'k' && !isInInput) {
        e.preventDefault()
        searchFocusRef?.current?.()
        return
      }

      // Cmd+C: Copy selected tasks to clipboard (works even with dialogs open — read-only)
      if (
        cmdKey &&
        e.key === 'c' &&
        !isInInput &&
        selection.isSelectionMode &&
        selection.selectedIds.size > 0
      ) {
        e.preventDefault()
        const clipboardGroups: ClipboardGroup[] = taskGroups
          .map((g) => {
            const sorted = sortTasks(g.tasks, sortOption, reversed)
            const selected = sorted.filter((t) => selection.selectedIds.has(t.id))
            return { label: g.label, tasks: selected, sort: sortOption, reversed }
          })
          .filter((g) => g.tasks.length > 0)
        if (clipboardGroups.length > 0) {
          const projMap = new Map(projects.map((p) => [p.id, p.name]))
          const annotations = showAnnotations ? annotationMap : undefined
          const text = formatTasksForClipboard(clipboardGroups, timezone, projMap, annotations)
          const n = clipboardGroups.reduce((sum, g) => sum + g.tasks.length, 0)
          navigator.clipboard.writeText(text).then(
            () => showToast({ message: `Copied ${n} ${taskWord(n)}`, type: 'success' }),
            () => showToast({ message: 'Copy failed', type: 'error' }),
          )
        }
        return
      }

      // Undo/redo handled by useUndoRedoShortcuts hook

      // Don't intercept other shortcuts when dialogs/sheets are open
      if (!keyboardNavEnabled) return

      // Cmd+L: Always focus first task (works even in keyboard mode)
      if (cmdKey && e.key === 'l' && !isInInput) {
        e.preventDefault()
        if (orderedIds.length > 0) {
          const firstTaskId = orderedIds[0]
          setKeyboardFocusedId(firstTaskId)
          keyboard.enterKeyboardMode()
          document.getElementById(`task-row-${firstTaskId}`)?.focus()
        }
        return
      }

      // ArrowDown: Focus first task (only when not in keyboard mode and not in input)
      if (e.key === 'ArrowDown' && !keyboard.isKeyboardActive && !isInInput) {
        e.preventDefault()
        if (orderedIds.length > 0) {
          const firstTaskId = orderedIds[0]
          setKeyboardFocusedId(firstTaskId)
          keyboard.enterKeyboardMode()
          document.getElementById(`task-row-${firstTaskId}`)?.focus()
        }
        return
      }

      // ArrowUp: Focus last task (only when not in keyboard mode and not in input)
      if (e.key === 'ArrowUp' && !keyboard.isKeyboardActive && !isInInput) {
        e.preventDefault()
        if (orderedIds.length > 0) {
          const lastTaskId = orderedIds[orderedIds.length - 1]
          setKeyboardFocusedId(lastTaskId)
          keyboard.enterKeyboardMode()
          document.getElementById(`task-row-${lastTaskId}`)?.focus()
        }
        return
      }

      // Home: Focus first task (works globally, even when not in keyboard mode)
      if (e.key === 'Home' && !isInInput) {
        e.preventDefault()
        if (orderedIds.length > 0) {
          const firstTaskId = orderedIds[0]
          setKeyboardFocusedId(firstTaskId)
          keyboard.enterKeyboardMode()
          document.getElementById(`task-row-${firstTaskId}`)?.focus()
        }
        return
      }

      // End: Focus last task (works globally, even when not in keyboard mode)
      if (e.key === 'End' && !isInInput) {
        e.preventDefault()
        if (orderedIds.length > 0) {
          const lastTaskId = orderedIds[orderedIds.length - 1]
          setKeyboardFocusedId(lastTaskId)
          keyboard.enterKeyboardMode()
          document.getElementById(`task-row-${lastTaskId}`)?.focus()
        }
        return
      }

      // Cmd+Shift+A: Select all tasks in first group (works globally)
      if (cmdKey && e.shiftKey && e.key.toLowerCase() === 'a' && !isInInput) {
        e.preventDefault()
        if (taskGroups.length > 0 && orderedIds.length > 0) {
          const firstGroup = taskGroups[0]
          const firstGroupTaskIds = new Set(firstGroup.tasks.map((t) => t.id))
          const groupIds = orderedIds.filter((id) => firstGroupTaskIds.has(id))

          if (groupIds.length > 0) {
            const allSelected = groupIds.every((id) => selection.selectedIds.has(id))
            if (allSelected) {
              selection.removeAll(groupIds)
            } else {
              selection.addAll(groupIds)
              if (!keyboard.isKeyboardActive) {
                setKeyboardFocusedId(groupIds[0])
                keyboard.enterKeyboardMode()
                document.getElementById(`task-row-${groupIds[0]}`)?.focus()
              }
            }
          }
        }
        return
      }

      // Cmd+A: Select all visible tasks (or deselect if all selected) - works globally
      if (cmdKey && e.key.toLowerCase() === 'a' && !isInInput) {
        e.preventDefault()
        if (orderedIds.length > 0) {
          const allSelected = orderedIds.every((id) => selection.selectedIds.has(id))
          if (allSelected) {
            selection.clear()
          } else {
            selection.selectAll(orderedIds)
            if (!keyboard.isKeyboardActive) {
              setKeyboardFocusedId(orderedIds[0])
              keyboard.enterKeyboardMode()
              document.getElementById(`task-row-${orderedIds[0]}`)?.focus()
            }
          }
        }
        return
      }
    }

    document.addEventListener('keydown', handleGlobalKeyDown)
    return () => document.removeEventListener('keydown', handleGlobalKeyDown)
  }, [
    keyboard,
    keyboardNavEnabled,
    orderedIds,
    setKeyboardFocusedId,
    selection,
    taskGroups,
    sortOption,
    reversed,
    timezone,
    showAnnotations,
    annotationMap,
    projects,
    setShowShortcutsDialog,
    searchFocusRef,
  ])
}
