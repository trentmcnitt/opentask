'use client'

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react'
import type { Task } from '@/types'
import type { QuickActionPanelChanges } from '@/components/QuickActionPanel'
import { showToast } from '@/lib/toast'
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
 *
 * Undo/redo counts are tracked and exposed for Header badges.
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

/** Update both counts from an API response that includes undoable_count/redoable_count */
function extractCounts(data: { data?: { undoable_count?: number; redoable_count?: number } }): {
  undoable: number | null
  redoable: number | null
} {
  return {
    undoable: data.data?.undoable_count ?? null,
    redoable: data.data?.redoable_count ?? null,
  }
}

export function useTaskActions(config: UseTaskActionsConfig) {
  // Store config in a ref so callbacks always see the latest values without
  // needing config fields in their dependency arrays.
  const configRef = useRef(config)
  configRef.current = config

  const [undoCount, setUndoCount] = useState(0)
  const [redoCount, setRedoCount] = useState(0)
  // Session watermark: the latest undo_log ID at page load. Actions after this ID
  // are "this session's" actions. Used to scope undo/redo counts to the session.
  const sessionWatermarkRef = useRef<number | null>(null)
  // Fetch the session watermark on mount (don't set counts — session starts at 0)
  useEffect(() => {
    fetch('/api/undo/status')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data?.data) return
        sessionWatermarkRef.current = data.data.latest_id ?? null
      })
      .catch(() => {})
  }, [])

  /** Update counts from an API response */
  const updateCounts = useCallback(
    (data: { data?: { undoable_count?: number; redoable_count?: number } }) => {
      const counts = extractCounts(data)
      if (counts.undoable !== null) setUndoCount(counts.undoable)
      if (counts.redoable !== null) setRedoCount(counts.redoable)
    },
    [],
  )

  // Undo/redo refs break the circular dependency between the two handlers
  const handleUndoRef = useRef<(() => Promise<void>) | null>(null)
  const handleRedoRef = useRef<(() => Promise<void>) | null>(null)

  const handleUndo = useCallback(async () => {
    try {
      const fetchOptions: RequestInit = { method: 'POST' }
      if (sessionWatermarkRef.current !== null) {
        fetchOptions.headers = { 'Content-Type': 'application/json' }
        fetchOptions.body = JSON.stringify({ session_start_id: sessionWatermarkRef.current })
      }
      const res = await fetch('/api/undo', fetchOptions)
      if (!res.ok) {
        showToast({ message: 'Nothing to undo' })
        return
      }
      const data = await res.json()
      updateCounts(data)
      configRef.current.onRefresh()
      const remaining = data.data?.undoable_count
      const countSuffix = typeof remaining === 'number' ? ` · ${remaining} left` : ''
      showToast({
        message: `Undid: ${data.data.description}${countSuffix}`,
        type: 'success',
        action: { label: 'Redo', onClick: () => handleRedoRef.current?.() },
      })
    } catch {
      showToast({ message: 'Undo failed', type: 'error' })
    }
  }, [updateCounts])

  const handleRedo = useCallback(async () => {
    try {
      const fetchOptions: RequestInit = { method: 'POST' }
      if (sessionWatermarkRef.current !== null) {
        fetchOptions.headers = { 'Content-Type': 'application/json' }
        fetchOptions.body = JSON.stringify({ session_start_id: sessionWatermarkRef.current })
      }
      const res = await fetch('/api/redo', fetchOptions)
      if (!res.ok) {
        showToast({ message: 'Nothing to redo' })
        return
      }
      const data = await res.json()
      updateCounts(data)
      configRef.current.onRefresh()
      const remaining = data.data?.redoable_count
      const countSuffix = typeof remaining === 'number' ? ` · ${remaining} left` : ''
      showToast({
        message: `Redid: ${data.data.description}${countSuffix}`,
        type: 'success',
        action: { label: 'Undo', onClick: () => handleUndoRef.current?.() },
      })
    } catch {
      showToast({ message: 'Redo failed', type: 'error' })
    }
  }, [updateCounts])

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
      // Bump undo count since a new action was logged
      setUndoCount((c) => c + 1)
      setRedoCount(0)
      cfg.onRefresh()
      showToast({
        message: task.rrule ? 'Task advanced' : 'Task completed',
        type: 'success',
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
      setUndoCount((c) => c + 1)
      setRedoCount(0)
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
      const data = await res.json()
      cfg.onRefresh()
      setUndoCount((c) => c + 1)
      setRedoCount(0)
      showToast({
        message: data.data?.description || 'Task snoozed',
        type: 'success',
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
        const { description } = await saveTaskChanges(taskId, changes)
        cfg.onRefresh()
        setUndoCount((c) => c + 1)
        setRedoCount(0)
        showToast({
          message: description || 'Changes saved',
          type: 'success',
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
      const { task: updatedTask, description } = await saveTaskChanges(cfg.taskId, changes)
      cfg.setTask(updatedTask)
      setUndoCount((c) => c + 1)
      setRedoCount(0)
      showToast({
        message: description || 'Changes saved',
        type: 'success',
        action: { label: 'Undo', onClick: () => handleUndoRef.current?.() },
      })
    } catch {
      cfg.onRefresh()
    }
  }, [])

  /** Increment undo count by 1 and clear redo. Call after any successful mutation. */
  const bumpUndoCount = useCallback(() => {
    setUndoCount((c) => c + 1)
    setRedoCount(0)
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
      undoCount,
      redoCount,
      bumpUndoCount,
    }
  }

  return {
    handleUndo,
    handleRedo,
    handleUndoRef,
    handleRedoRef,
    handleDone: handleDoneSingle,
    handleSaveAllChanges: handleSaveAllChangesSingle,
    undoCount,
    redoCount,
    bumpUndoCount,
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
