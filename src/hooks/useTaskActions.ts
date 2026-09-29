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
import { showSaveError, showToast } from '@/lib/toast'
import { useUndoRedo } from '@/hooks/useUndoRedo'
import { saveTaskChanges } from '@/lib/save-task-changes'

/**
 * Shared task action handlers used by the dashboard and the task detail page.
 *
 * Consolidates handleDone, handleSnooze, and handleSaveAllChanges — which were
 * previously duplicated across pages with slight behavioral differences.
 * Pages with no task list to act on (Reminders, Quotas, History) use
 * `useUndoRedo` on its own instead.
 *
 * Config-based interface handles two modes:
 * - List mode (dashboard): operates on a task array with optimistic updates
 * - Single-task mode (task detail): operates on a single task by ID
 *
 * The config is stored in a ref so callbacks don't need it in their dependency
 * arrays. This avoids eslint-disable for react-hooks/exhaustive-deps and keeps
 * callbacks stable.
 *
 * Undo/redo (handlers, refs and the Header's counts) comes from `useUndoRedo`,
 * spread into both return shapes; the mutation handlers here bump its count.
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

  // Session-scoped undo/redo, its counts and refs (see useUndoRedo).
  const undoRedo = useUndoRedo({ onRefresh: config.onRefresh })
  const { handleUndoRef, bumpUndoCount } = undoRedo

  // --- List-mode handlers (dashboard) ---

  const handleDoneList = useCallback(
    async (taskId: number) => {
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
        // Bump undo count since a new action was logged
        bumpUndoCount()
        cfg.onRefresh()
        showToast({
          message: task.rrule ? 'Task advanced' : 'Task completed',
          type: 'success',
          action: { label: 'Undo', onClick: () => handleUndoRef.current?.() },
        })
      } catch {
        cfg.onRefresh()
      }
    },
    [bumpUndoCount, handleUndoRef],
  )

  const handleDoneSingle = useCallback(async () => {
    const cfg = configRef.current
    if (cfg.mode !== 'single' || !cfg.task) return

    try {
      const res = await fetch(`/api/tasks/${cfg.taskId}/done`, { method: 'POST' })
      if (!res.ok) throw new Error('Failed to mark done')
      const data = await res.json()
      bumpUndoCount()
      if (data.data.was_recurring) {
        cfg.setTask(data.data.task as Task)
      } else {
        cfg.onCompletedNavigation?.()
      }
    } catch {
      cfg.onRefresh()
    }
  }, [bumpUndoCount])

  const handleSnooze = useCallback(
    async (taskId: number, until: string) => {
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
        const data = await res.json()
        cfg.onRefresh()
        bumpUndoCount()
        showToast({
          message: data.data?.description || 'Task snoozed',
          type: 'success',
          action: { label: 'Undo', onClick: () => handleUndoRef.current?.() },
        })
      } catch {
        cfg.onRefresh()
      }
    },
    [bumpUndoCount, handleUndoRef],
  )

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
        const { description } = await saveTaskChanges(taskId, changes)
        cfg.onRefresh()
        bumpUndoCount()
        showToast({
          message: description || 'Changes saved',
          type: 'success',
          action: { label: 'Undo', onClick: () => handleUndoRef.current?.() },
        })
      } catch (err) {
        cfg.onRefresh()
        showSaveError(err)
      }
    },
    [bumpUndoCount, handleUndoRef],
  )

  const handleSaveAllChangesSingle = useCallback(
    async (changes: QuickActionPanelChanges) => {
      const cfg = configRef.current
      if (cfg.mode !== 'single' || !cfg.task || Object.keys(changes).length === 0) return

      try {
        const { task: updatedTask, description } = await saveTaskChanges(cfg.taskId, changes)
        cfg.setTask(updatedTask)
        bumpUndoCount()
        showToast({
          message: description || 'Changes saved',
          type: 'success',
          action: { label: 'Undo', onClick: () => handleUndoRef.current?.() },
        })
      } catch (err) {
        cfg.onRefresh()
        showSaveError(err)
        // Reported above; rethrown so the editor keeps its staged edits and the
        // task page's save-and-leave stays put instead of navigating as if the
        // save had worked (the same contract RemindersView's saveDetail keeps).
        throw err
      }
    },
    [bumpUndoCount, handleUndoRef],
  )

  if (config.mode === 'list') {
    return {
      ...undoRedo,
      handleDone: handleDoneList,
      handleSnooze,
      handleSaveAllChanges: handleSaveAllChangesList,
    }
  }

  return {
    ...undoRedo,
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
  undoCount: number
  redoCount: number
  bumpUndoCount: () => void
}
export type SingleTaskActionsReturn = {
  handleUndo: () => Promise<void>
  handleRedo: () => Promise<void>
  handleUndoRef: MutableRefObject<(() => Promise<void>) | null>
  handleRedoRef: MutableRefObject<(() => Promise<void>) | null>
  handleDone: () => Promise<void>
  handleSaveAllChanges: (changes: QuickActionPanelChanges) => Promise<void>
  undoCount: number
  redoCount: number
  bumpUndoCount: () => void
}
