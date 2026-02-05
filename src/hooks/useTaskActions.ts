'use client'

import {
  useCallback,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react'
import type { Task } from '@/types'
import type { QuickActionPanelChanges } from '@/components/QuickActionPanel'
import { showToast } from '@/lib/toast'
import { formatChangesToast } from '@/lib/format-toast'
import { saveTaskChanges } from '@/lib/save-task-changes'

/**
 * Shared task action handlers used by dashboard, project, and task detail pages.
 *
 * Consolidates handleUndo, handleRedo, handleDone, handleSnooze, and
 * handleSaveAllChanges — which were previously duplicated across 3 pages
 * with slight behavioral differences.
 *
 * Config-based interface handles two modes:
 * - List mode (dashboard/project): operates on a task array with optimistic updates
 * - Single-task mode (task detail): operates on a single task by ID
 *
 * The config is stored in a ref so callbacks don't need it in their dependency
 * arrays. This avoids eslint-disable for react-hooks/exhaustive-deps and keeps
 * callbacks stable.
 */

interface UseTaskActionsListConfig {
  mode: 'list'
  onRefresh: () => void
  tasks: Task[]
  setTasks: Dispatch<SetStateAction<Task[]>>
}

interface UseTaskActionsSingleConfig {
  mode: 'single'
  onRefresh: () => void
  task: Task | null
  taskId: number | string
  setTask: (task: Task) => void
  /** Called after a one-off (non-recurring) task is marked done — typically navigates away */
  onCompletedNavigation?: () => void
}

type UseTaskActionsConfig = UseTaskActionsListConfig | UseTaskActionsSingleConfig

export function useTaskActions(config: UseTaskActionsConfig) {
  // Store config in a ref so callbacks always see the latest values without
  // needing config fields in their dependency arrays.
  const configRef = useRef(config)
  configRef.current = config

  // Undo/redo refs break the circular dependency between the two handlers
  const handleUndoRef = useRef<(() => Promise<void>) | null>(null)
  const handleRedoRef = useRef<(() => Promise<void>) | null>(null)

  const handleUndo = useCallback(async () => {
    try {
      const res = await fetch('/api/undo', { method: 'POST' })
      if (!res.ok) {
        showToast({ message: 'Nothing to undo' })
        return
      }
      const data = await res.json()
      configRef.current.onRefresh()
      showToast({
        message: `Undid: ${data.data.description}`,
        action: { label: 'Redo', onClick: () => handleRedoRef.current?.() },
      })
    } catch {
      showToast({ message: 'Undo failed' })
    }
  }, [])

  const handleRedo = useCallback(async () => {
    try {
      const res = await fetch('/api/redo', { method: 'POST' })
      if (!res.ok) {
        showToast({ message: 'Nothing to redo' })
        return
      }
      const data = await res.json()
      configRef.current.onRefresh()
      showToast({
        message: `Redid: ${data.data.description}`,
        action: { label: 'Undo', onClick: () => handleUndoRef.current?.() },
      })
    } catch {
      showToast({ message: 'Redo failed' })
    }
  }, [])

  handleUndoRef.current = handleUndo
  handleRedoRef.current = handleRedo

  // --- List-mode handlers (dashboard, project page) ---

  const handleDoneList = useCallback(async (taskId: number) => {
    const cfg = configRef.current
    if (cfg.mode !== 'list') return
    const task = cfg.tasks.find((t) => t.id === taskId)
    if (!task) return

    // Optimistic: remove non-recurring tasks immediately
    if (!task.rrule) {
      cfg.setTasks((prev) => prev.filter((t) => t.id !== taskId))
    }

    try {
      const res = await fetch(`/api/tasks/${taskId}/done`, { method: 'POST' })
      if (!res.ok) throw new Error('Failed to mark done')
      const data = await res.json()
      if (data.data?.task?.rrule) {
        cfg.setTasks((prev) => prev.map((t) => (t.id === taskId ? data.data.task : t)))
      }
      showToast({
        message: task.rrule ? 'Task advanced' : 'Task completed',
        action: { label: 'Undo', onClick: () => handleUndoRef.current?.() },
      })
    } catch {
      cfg.onRefresh()
    }
  }, [])

  const handleDoneSingle = useCallback(async () => {
    const cfg = configRef.current
    if (cfg.mode !== 'single' || !cfg.task) return

    try {
      const res = await fetch(`/api/tasks/${cfg.taskId}/done`, { method: 'POST' })
      if (!res.ok) throw new Error('Failed to mark done')
      const data = await res.json()
      if (data.data.was_recurring) {
        cfg.setTask(data.data.task as Task)
      } else {
        cfg.onCompletedNavigation?.()
      }
    } catch {
      cfg.onRefresh()
    }
  }, [])

  const handleSnooze = useCallback(async (taskId: number, until: string) => {
    const cfg = configRef.current
    if (cfg.mode !== 'list') return
    cfg.setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, due_at: until } : t)))

    try {
      const res = await fetch(`/api/tasks/${taskId}/snooze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ until }),
      })
      if (!res.ok) throw new Error('Failed to snooze')
      cfg.onRefresh()
      showToast({
        message: 'Task snoozed',
        action: { label: 'Undo', onClick: () => handleUndoRef.current?.() },
      })
    } catch {
      cfg.onRefresh()
    }
  }, [])

  const handleSaveAllChangesList = useCallback(
    async (taskId: number, changes: QuickActionPanelChanges) => {
      const cfg = configRef.current
      if (cfg.mode !== 'list') return

      // Optimistic update for visible fields
      const optimistic: Partial<Task> = {}
      if (changes.priority !== undefined) optimistic.priority = changes.priority
      if (changes.due_at !== undefined) optimistic.due_at = changes.due_at
      if (Object.keys(optimistic).length > 0) {
        cfg.setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, ...optimistic } : t)))
      }

      try {
        await saveTaskChanges(taskId, changes)
        cfg.onRefresh()
        showToast({
          message: formatChangesToast(changes),
          action: { label: 'Undo', onClick: () => handleUndoRef.current?.() },
        })
      } catch {
        cfg.onRefresh()
      }
    },
    [],
  )

  const handleSaveAllChangesSingle = useCallback(async (changes: QuickActionPanelChanges) => {
    const cfg = configRef.current
    if (cfg.mode !== 'single' || !cfg.task || Object.keys(changes).length === 0) return

    try {
      const updatedTask = await saveTaskChanges(cfg.taskId, changes)
      cfg.setTask(updatedTask)
      showToast({
        message: formatChangesToast(changes),
        action: { label: 'Undo', onClick: () => handleUndoRef.current?.() },
      })
    } catch {
      cfg.onRefresh()
    }
  }, [])

  if (config.mode === 'list') {
    return {
      handleUndo,
      handleRedo,
      handleUndoRef,
      handleRedoRef,
      handleDone: handleDoneList,
      handleSnooze,
      handleSaveAllChanges: handleSaveAllChangesList,
    }
  }

  return {
    handleUndo,
    handleRedo,
    handleUndoRef,
    handleRedoRef,
    handleDone: handleDoneSingle,
    handleSaveAllChanges: handleSaveAllChangesSingle,
  }
}

export type UseTaskActionsReturn = ReturnType<typeof useTaskActions>
export type ListTaskActionsReturn = {
  handleUndo: () => Promise<void>
  handleRedo: () => Promise<void>
  handleUndoRef: MutableRefObject<(() => Promise<void>) | null>
  handleRedoRef: MutableRefObject<(() => Promise<void>) | null>
  handleDone: (taskId: number) => Promise<void>
  handleSnooze: (taskId: number, until: string) => Promise<void>
  handleSaveAllChanges: (taskId: number, changes: QuickActionPanelChanges) => Promise<void>
}
export type SingleTaskActionsReturn = {
  handleUndo: () => Promise<void>
  handleRedo: () => Promise<void>
  handleUndoRef: MutableRefObject<(() => Promise<void>) | null>
  handleRedoRef: MutableRefObject<(() => Promise<void>) | null>
  handleDone: () => Promise<void>
  handleSaveAllChanges: (changes: QuickActionPanelChanges) => Promise<void>
}
