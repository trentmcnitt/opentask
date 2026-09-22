'use client'

import { useState, useEffect, useCallback, useMemo, useRef, Suspense } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter, useSearchParams } from 'next/navigation'
import { TaskList, buildTaskGroups, sortTasks, type GroupingMode } from '@/components/TaskList'
import { useTimeSlots } from '@/hooks/useTimeSlots'
import { UNDATED_LABEL } from '@/lib/slot-view'
import { isTracked } from '@/lib/track'
import { publishTaskCounts } from '@/hooks/useTaskNavCounts'
import { TrackPanel } from '@/components/TrackPanel'
import { DashboardRemindersPanel } from '@/components/DashboardRemindersPanel'
import { ViewModeToggle } from '@/components/ViewModeToggle'
import type { TimeSlot } from '@/lib/time-slot-assign'
import type { SortOption } from '@/hooks/useGroupSort'
import { useCollapsedGroups } from '@/hooks/useCollapsedGroups'
import { useKeyboardNavigation } from '@/hooks/useKeyboardNavigation'
import { useTimezone } from '@/hooks/useTimezone'
import { Header } from '@/components/Header'
import { QuickAdd } from '@/components/QuickAdd'
import { DemoTour } from '@/components/DemoTour'
import { QuickTakeBanner } from '@/components/QuickTakeBanner'
import { FilterBar } from '@/components/FilterBar'
import { AiControlArea } from '@/components/AiControlArea'
import { SelectionProvider, useSelection } from '@/components/SelectionProvider'
import { SelectionActionSheet } from '@/components/SelectionActionSheet'
import { SnoozeAllFab } from '@/components/SnoozeAllFab'
import { useQuickActionShortcut } from '@/hooks/useQuickActionShortcut'
import { showToast, showSuccessToastWithAction, showAiSuccessToastWithAction } from '@/lib/toast'
import dynamic from 'next/dynamic'

const QuickActionPopover = dynamic(() =>
  import('@/components/QuickActionPopover').then((mod) => ({ default: mod.QuickActionPopover })),
)
const KeyboardShortcutsDialog = dynamic(() =>
  import('@/components/KeyboardShortcutsDialog').then((mod) => ({
    default: mod.KeyboardShortcutsDialog,
  })),
)
const ProjectPickerSheet = dynamic(() =>
  import('@/components/ProjectPickerSheet').then((mod) => ({ default: mod.ProjectPickerSheet })),
)

import {
  useSnoozePreferences,
  useDefaultGrouping,
  useDefaultSort,
  useAiAvailable,
  useAiPreferences,
} from '@/components/PreferencesProvider'
import { useProjects } from '@/components/ProjectsProvider'
import type { Task, Project } from '@/types'
import type { QuickActionPanelChanges } from '@/components/QuickActionPanel'
import { saveQuickPanelChanges } from '@/lib/save-quick-panel-changes'
import { useTaskActions } from '@/hooks/useTaskActions'
import type { ListTaskActionsReturn } from '@/hooks/useTaskActions'
import { useUndoRedoShortcuts } from '@/hooks/useUndoRedoShortcuts'
import { useFilterState } from '@/hooks/useFilterState'
import { useFilterSection } from '@/hooks/useFilterSection'
import { useTaskCounts } from '@/hooks/useTaskCounts'
import { useSnoozeOverdue } from '@/hooks/useSnoozeOverdue'
import { classifyTaskDueDate, type DueDateFilter } from '@/components/DueDateFilterBar'
import { getTimezoneDayBoundaries } from '@/lib/format-date'
import { cn, taskWord } from '@/lib/utils'
import { useAiInsights, type UseAiInsightsReturn } from '@/hooks/useAiInsights'
import { useAiMode, type AiMode } from '@/hooks/useAiMode'
import { useInsightsData, type UseInsightsDataReturn } from '@/hooks/useInsightsData'
import { useDashboardKeyboard } from '@/hooks/useDashboardKeyboard'
import { useExitModes } from '@/hooks/useExitModes'
import { useSyncStream } from '@/hooks/useSyncStream'
import { loginUrlFromLocation } from '@/lib/login-redirect'
import type { FormattedTask } from '@/lib/format-task'

interface DashboardClientProps {
  initialTasks?: FormattedTask[]
  /** Server-loaded with the tasks, so the first paint groups by slot (no un-slotted flash). */
  initialTimeSlots?: TimeSlot[]
}

export default function DashboardClient({ initialTasks, initialTimeSlots }: DashboardClientProps) {
  return (
    <Suspense>
      <SelectionProvider>
        <HomeContent initialTasks={initialTasks} initialTimeSlots={initialTimeSlots} />
      </SelectionProvider>
    </Suspense>
  )
}

function useFetchData(router: ReturnType<typeof useRouter>, initialTasks?: FormattedTask[]) {
  const [tasks, setTasks] = useState<Task[]>(initialTasks ?? [])
  const [loading, setLoading] = useState(initialTasks === undefined)
  const [error, setError] = useState<string | null>(null)

  const fetchTasks = useCallback(async () => {
    try {
      const res = await fetch('/api/tasks?limit=1000')
      if (res.status === 401) {
        router.push(loginUrlFromLocation())
        return
      }
      if (!res.ok) throw new Error('Failed to fetch tasks')
      const data = await res.json()
      setTasks(data.data?.tasks || [])
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [router])

  return {
    tasks,
    setTasks,
    loading,
    setLoading,
    error,
    setError,
    fetchTasks,
  }
}

/**
 * Dashboard-specific wrapper around the shared useTaskActions hook.
 * Adds handleQuickAdd which is dashboard-only (not needed by project or task detail pages).
 */
function useDashboardActions(
  fetchTasks: () => Promise<void>,
  tasks: Task[],
  setTasks: React.Dispatch<React.SetStateAction<Task[]>>,
  onViewTask: (task: Task) => void,
  onCreated?: (task: Task) => void,
): ListTaskActionsReturn & { handleQuickAdd: (title: string) => Promise<number | null> } {
  const actions = useTaskActions({
    mode: 'list',
    onRefresh: fetchTasks,
    tasks,
    setTasks,
  }) as ListTaskActionsReturn

  const handleQuickAdd = useCallback(
    async (title: string): Promise<number | null> => {
      try {
        const res = await fetch('/api/tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title }),
        })
        if (!res.ok) throw new Error('Failed to create task')
        const { data: task } = await res.json()
        onCreated?.(task)
        fetchTasks()
        showToast({
          message: 'Task added',
          type: 'success',
          id: `task-created-${task.id}`,
          action: { label: 'View', onClick: () => onViewTask(task) },
        })
        return task.id as number
      } catch {
        showToast({ message: 'Failed to add task', type: 'error' })
        return null
      }
    },
    [fetchTasks, onViewTask, onCreated],
  )

  return { ...actions, handleQuickAdd }
}

function useBulkActions(
  selection: ReturnType<typeof useSelection>,
  fetchTasks: () => Promise<void>,
  handleUndo: () => Promise<void>,
  bumpUndoCount: () => void,
  setShowProjectPicker: (show: boolean) => void,
  setSearchQuery: (q: string | null) => void,
  setSearchResults: React.Dispatch<React.SetStateAction<Task[]>>,
) {
  // Bulk "Done" from the floating selection action bar. This is the only
  // remaining direct bulk endpoint call from the dashboard — all panel-driven
  // mutations (date, priority, labels, project, recurrence) flow through
  // `bulkSaveAll` → `saveQuickPanelChanges`, which keeps the mobile selection
  // sheet and the desktop quick-action popover on exactly one save path.
  const bulkDone = async () => {
    const count = selection.selectedIds.size
    try {
      const res = await fetch('/api/tasks/bulk/done', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [...selection.selectedIds] }),
      })
      if (!res.ok) throw new Error('Bulk action failed')
      selection.clear()
      bumpUndoCount()
      fetchTasks()
      showToast({
        message: `${count} ${taskWord(count)} completed`,
        type: 'success',
        action: { label: 'Undo', onClick: handleUndo },
      })
    } catch {
      showToast({ message: 'Action failed', type: 'error' })
    }
  }

  /**
   * Unified save path for the SelectionActionSheet. Routes single-task saves
   * through PATCH /api/tasks/:id and multi-task saves through the bulk
   * endpoints (with `include_task_ids` so explicit selections bypass the
   * server's P3/P4 (High/Urgent) skip filter).
   *
   * `dateTaskIds` is forwarded as the effective task ID list for the save —
   * used when the snooze confirmation dialog opts some tasks out of the date
   * change. Non-date fields fall back to the full selection.
   */
  const bulkSaveAll = async (changes: QuickActionPanelChanges, dateTaskIds?: number[]) => {
    const allIds = [...selection.selectedIds]
    if (allIds.length === 0) return
    const hasDate = changes.due_at !== undefined || changes.delta_minutes !== undefined
    try {
      if (hasDate && dateTaskIds && dateTaskIds.length !== allIds.length) {
        // Date change targets a subset; split the save so non-date fields
        // still apply to every selected task.
        const { due_at: _du, delta_minutes: _dm, ...nonDateChanges } = changes
        void _du
        void _dm
        const dateOnly: QuickActionPanelChanges = {}
        if (changes.due_at !== undefined) dateOnly.due_at = changes.due_at
        if (changes.delta_minutes !== undefined) dateOnly.delta_minutes = changes.delta_minutes
        const calls: Promise<{ tasksAffected: number; description?: string }>[] = []
        if (dateTaskIds.length > 0 && Object.keys(dateOnly).length > 0) {
          calls.push(saveQuickPanelChanges(dateTaskIds, dateOnly))
        }
        if (Object.keys(nonDateChanges).length > 0) {
          calls.push(saveQuickPanelChanges(allIds, nonDateChanges))
        }
        const results = await Promise.all(calls)
        bumpUndoCount()
        fetchTasks()
        // Prefer the single-task description when available (most specific),
        // otherwise show a generic success.
        const desc = results.find((r) => r.description)?.description
        showToast({
          message: desc || `${allIds.length} ${taskWord(allIds.length)} updated`,
          type: 'success',
          action: { label: 'Undo', onClick: handleUndo },
        })
        return
      }
      const effectiveIds = hasDate && dateTaskIds ? dateTaskIds : allIds
      if (effectiveIds.length === 0) return
      const result = await saveQuickPanelChanges(effectiveIds, changes)
      bumpUndoCount()
      fetchTasks()
      showToast({
        message:
          result.description || `${result.tasksAffected} ${taskWord(result.tasksAffected)} updated`,
        type: 'success',
        action: { label: 'Undo', onClick: handleUndo },
      })
    } catch {
      showToast({ message: 'Save failed', type: 'error' })
    }
  }

  const bulkDelete = async () => {
    const count = selection.selectedIds.size
    const deletedIds = new Set(selection.selectedIds)
    try {
      const res = await fetch('/api/tasks/bulk/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [...selection.selectedIds] }),
      })
      if (!res.ok) throw new Error('Delete failed')
      setSearchResults((prev) => prev.filter((t) => !deletedIds.has(t.id)))
      selection.clear()
      bumpUndoCount()
      fetchTasks()
      showToast({
        message: `${count} ${taskWord(count)} deleted`,
        type: 'success',
        action: { label: 'Undo', onClick: handleUndo },
      })
    } catch {
      showToast({ message: 'Delete failed', type: 'error' })
    }
  }

  const handleBulkMoveToProject = async (projectId: number) => {
    const count = selection.selectedIds.size
    setShowProjectPicker(false)
    try {
      const res = await fetch('/api/tasks/bulk/edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ids: [...selection.selectedIds],
          changes: { project_id: projectId },
        }),
      })
      if (!res.ok) throw new Error('Move failed')
      selection.clear()
      bumpUndoCount()
      fetchTasks()
      showToast({
        message: `${count} ${taskWord(count)} moved`,
        type: 'success',
        action: { label: 'Undo', onClick: handleUndo },
      })
    } catch {
      showToast({ message: 'Move failed', type: 'error' })
    }
  }

  const handleSearch = async (query: string) => {
    selection.clear() // Clear selection when search changes
    setSearchQuery(query)
    try {
      const res = await fetch(`/api/tasks?search=${encodeURIComponent(query)}&limit=1000`)
      if (!res.ok) return
      const data = await res.json()
      setSearchResults(data.data?.tasks || [])
    } catch {
      // Silent fail
    }
  }

  return { bulkDone, bulkSaveAll, bulkDelete, handleBulkMoveToProject, handleSearch }
}

function HomeContent({
  initialTasks,
  initialTimeSlots,
}: {
  initialTasks?: FormattedTask[]
  initialTimeSlots?: TimeSlot[]
}) {
  const { status } = useSession()
  const router = useRouter()
  const searchParams = useSearchParams()
  const selection = useSelection()
  const timezone = useTimezone()
  const { timeSlots } = useTimeSlots(initialTimeSlots)
  const data = useFetchData(router, initialTasks)
  const { tasks, setTasks, loading, error, setError, setLoading, fetchTasks } = data
  const { projects, refreshProjects } = useProjects()
  const handleViewTask = useCallback((task: Task) => {
    setFocusedTask(task)
    setQuickActionOpen(true)
  }, [])
  // Registered by DashboardRemindersPanel while it is mounted (same pattern as
  // `refreshRef` on `/reminders` — see RemindersPage). The panel runs its own
  // `useReminders` instance, entirely separate from `tasks`/`visibleTasks`
  // above, so nothing else here refetches it: without this ref, undoing a
  // completed reminder (or a completion arriving over the sync stream) would
  // leave the panel showing stale data until a hard reload.
  const remindersRefreshRef = useRef<(() => void) | null>(null)
  const refreshAll = useCallback(async () => {
    await fetchTasks()
    refreshProjects()
    remindersRefreshRef.current?.()
  }, [fetchTasks, refreshProjects])
  // Banner state: combines quick take text, loading, title, and enrichment data
  interface QuickTakeBannerState {
    taskId: number | null
    title: string
    quickTakeText: string | null
    loading: boolean
    enrichment: { title?: string; due_at?: string | null; priority?: number } | null
  }
  const [bannerState, setBannerState] = useState<QuickTakeBannerState | null>(null)
  const bannerTaskIdRef = useRef<number | null>(null)
  const quickTakeAbortRef = useRef<AbortController | null>(null)

  useSyncStream({
    onSync: refreshAll,
    onTaskCreated: (data) => {
      // Sonner deduplicates by toast ID — if this device just created the task,
      // the local toast already has this ID, so Sonner updates it in place
      // rather than showing a duplicate.
      const task = tasks.find((t) => t.id === data.taskId)
      showSuccessToastWithAction(
        'Task added',
        {
          label: 'View',
          onClick: () => {
            if (task) handleViewTask(task)
            else router.push(`/tasks/${data.taskId}`)
          },
        },
        { id: `task-created-${data.taskId}` },
      )
    },
    onEnrichmentComplete: (data) => {
      // Update banner if it's showing for this task
      if (bannerTaskIdRef.current === data.taskId) {
        setBannerState((prev) =>
          prev
            ? {
                ...prev,
                enrichment: {
                  title: data.title,
                  due_at: data.due_at,
                  priority: data.priority,
                },
              }
            : prev,
        )
      }

      // Always show enrichment toast (replaces "Task added" toast via shared ID)
      const task = tasks.find((t) => t.id === data.taskId)
      showAiSuccessToastWithAction(
        `Enriched: ${data.title}`,
        {
          label: 'View',
          onClick: () => {
            if (task) handleViewTask(task)
            else router.push(`/tasks/${data.taskId}`)
          },
        },
        data.description,
        { id: `task-created-${data.taskId}` },
      )
    },
  })
  // The "Undated" pile starts folded so Today reads as a day. A task added
  // with no date would land inside it unseen, so adding one opens it.
  const { isCollapsed, toggleCollapse, expand } = useCollapsedGroups([UNDATED_LABEL])
  const onCreated = useCallback(
    (task: Task) => {
      if (!task.due_at) expand(UNDATED_LABEL)
    },
    [expand],
  )
  // `?task=<id>&highlight=1` — the widget's task deep link. Mirrors
  // RemindersView's `highlightId`/`clearHighlight`; see the `?task=` effect
  // below for the full rationale.
  const [highlightTaskId, setHighlightTaskId] = useState<number | null>(null)
  const clearHighlight = useCallback(() => setHighlightTaskId(null), [])
  const actions = useDashboardActions(refreshAll, tasks, setTasks, handleViewTask, onCreated)

  const handleQuickAddWithQuickTake = useCallback(
    async (title: string) => {
      // 1. Create the task (fast — returns immediately, unblocks input)
      const taskId = await actions.handleQuickAdd(title)

      // 2. Fire-and-forget the quick take fetch so the input re-enables immediately.
      //    The banner shows progress; the input doesn't need to wait.
      void (async () => {
        // Abort any previous in-flight quick take request
        quickTakeAbortRef.current?.abort()
        const controller = new AbortController()
        quickTakeAbortRef.current = controller

        // Track task ID for enrichment SSE matching
        bannerTaskIdRef.current = taskId

        // Client-side timeout — must exceed the server's 40s AI timeout so the
        // server responds first (with success or timeout error) and we don't
        // abort a request that was about to succeed.
        const timeoutId = setTimeout(() => controller.abort(), 45_000)

        try {
          // Dispatch the request — if fetch() throws, dots never appear
          const resPromise = fetch('/api/ai/quick-take', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title }),
            signal: controller.signal,
          })

          // Request is in flight — show banner with title + typing indicator
          setBannerState({
            taskId,
            title,
            quickTakeText: null,
            loading: true,
            enrichment: null,
          })

          const res = await resPromise
          clearTimeout(timeoutId)

          if (!res.ok) throw new Error('Quick take request failed')

          const { data } = await res.json()
          if (data?.text) {
            setBannerState((prev) => (prev ? { ...prev, quickTakeText: data.text } : prev))
          }
        } catch {
          // Swallow — abort, timeout, or server error
        } finally {
          clearTimeout(timeoutId)
          // Only update loading state if this is still the active request
          if (quickTakeAbortRef.current === controller) {
            setBannerState((prev) => {
              if (!prev) return prev
              // If both quick take and enrichment failed, dismiss immediately
              if (!prev.quickTakeText && !prev.enrichment) return null
              return { ...prev, loading: false }
            })
          }
        }
      })()
    },
    [actions],
  )

  const handleQuickTakeDismiss = useCallback(() => {
    quickTakeAbortRef.current?.abort()
    bannerTaskIdRef.current = null
    setBannerState(null)
  }, [])

  const handleQuickActionDelete = useCallback(
    async (taskId: number) => {
      try {
        const res = await fetch(`/api/tasks/${taskId}`, { method: 'DELETE' })
        if (!res.ok) throw new Error('Failed to delete')
        setSearchResults((prev) => prev.filter((t) => t.id !== taskId))
        refreshAll()
        showToast({
          message: 'Task moved to trash',
          type: 'success',
          action: { label: 'Undo', onClick: actions.handleUndo },
        })
      } catch {
        showToast({ message: 'Delete failed', type: 'error' })
      }
    },
    [refreshAll, actions.handleUndo],
  )

  const handleReprocess = useCallback(
    async (taskId: number) => {
      // Optimistic update: swap ai-failed → ai-to-process (triggers processing animation)
      setTasks((prev) =>
        prev.map((t) =>
          t.id === taskId
            ? { ...t, labels: t.labels.map((l) => (l === 'ai-failed' ? 'ai-to-process' : l)) }
            : t,
        ),
      )
      try {
        const res = await fetch(`/api/tasks/${taskId}/reprocess`, { method: 'POST' })
        if (!res.ok) throw new Error('Reprocess failed')
        showToast({ message: 'Retrying AI enrichment...' })
      } catch {
        fetchTasks() // Revert on failure
        showToast({ message: 'Failed to retry enrichment', type: 'error' })
      }
    },
    [setTasks, fetchTasks],
  )
  useUndoRedoShortcuts(actions.handleUndoRef, actions.handleRedoRef)
  const { defaultSnoozeOption, morningTime } = useSnoozePreferences()

  const [showProjectPicker, setShowProjectPicker] = useState(false)
  const [focusedTask, setFocusedTask] = useState<Task | null>(null)
  const [quickActionOpen, setQuickActionOpen] = useState(false)
  const [showShortcutsDialog, setShowShortcutsDialog] = useState(false)
  const [createPanelOpen, setCreatePanelOpen] = useState(false)
  const bulkSheetOpenRef = useRef<(() => void) | null>(null)
  const searchFocusRef = useRef<(() => void) | null>(null)

  // Track when the CreateTaskPanel modal (in AppLayout) is open so we can disable keyboard shortcuts
  useEffect(() => {
    const handler = (e: Event) => setCreatePanelOpen((e as CustomEvent).detail.open)
    window.addEventListener('create-panel-state', handler)
    return () => window.removeEventListener('create-panel-state', handler)
  }, [])

  // Keyboard navigation state
  const [keyboardFocusedId, setKeyboardFocusedId] = useState<number | null>(null)

  // Sort state — persisted via PreferencesProvider (single source of truth)
  const {
    defaultSort: sortOption,
    defaultSortReversed: reversed,
    setSortPreference,
  } = useDefaultSort()
  const setSortOption = useCallback(
    (option: SortOption) => {
      const newReversed = sortOption === option ? !reversed : false
      setSortPreference(option, newReversed)
    },
    [sortOption, reversed, setSortPreference],
  )
  useQuickActionShortcut(focusedTask, setQuickActionOpen, quickActionOpen, {
    isSelectionMode: selection.isSelectionMode,
    selectedCount: selection.selectedIds.size,
    openBulkSheet: () => bulkSheetOpenRef.current?.(),
  })
  const { defaultGrouping, setDefaultGrouping, groupingLoaded } = useDefaultGrouping()

  // AI sort auto-switches to unified as a local override (not persisted to DB).
  // This preserves the user's real grouping preference for when AI sort is disabled.
  const [aiSortUnified, setAiSortUnified] = useState(false)
  const grouping: GroupingMode = aiSortUnified ? 'unified' : defaultGrouping

  // Track the non-unified grouping so we can restore it when leaving manual unified toggle.
  const prevNonUnifiedGrouping = useRef<GroupingMode | null>(null)
  const prevSortOption = useRef(sortOption)

  useEffect(() => {
    const wasAiSort = prevSortOption.current === 'ai_insights'
    const isAiSort = sortOption === 'ai_insights'
    prevSortOption.current = sortOption

    if (!wasAiSort && isAiSort) {
      setAiSortUnified(true)
    } else if (wasAiSort && !isAiSort) {
      setAiSortUnified(false)
    }
  }, [sortOption])

  const [searchQuery, setSearchQuery] = useState<string | null>(null)
  const [searchResults, setSearchResults] = useState<Task[]>([])

  /**
   * §5/§6/§7.3: the dashboard is TASKS. Two populations are not tasks and are
   * dropped here — reminders (§6), which live on `/reminders`, and quotas (§5),
   * which live on `/quotas` and in the Track panel above this list.
   *
   * "A quota is not a task. It appears on the Quotas page and in the Track
   * panel and nowhere else" (Trent, 2026-09-08). It used to be a plain row in
   * the All and Projects views wearing a "0 / 4" chip, which put a thing with
   * no due date, no snooze and no Done in among things that have all three.
   *
   * Filtered in the client rather than server-side so `/api/tasks` keeps
   * returning the whole corpus for every other caller — the Track panel below
   * builds from that same fetch, and so does the iOS widget. Doing it at this
   * one point keeps both populations out of everything derived from the list:
   * the chip counts, "Showing N of M", the header counts, keyboard order,
   * select-all and the clipboard.
   */
  const visibleTasks = useMemo(() => tasks.filter((t) => !t.is_reminder && !isTracked(t)), [tasks])
  /**
   * The server decides what a search MATCHES (`/api/tasks?search=`), but the
   * matches are RENDERED out of `tasks`, never out of the fetched copy. Every
   * path that changes a task — the optimistic handlers in `useTaskActions`,
   * the bulk actions, `refreshAll()`, the SSE sync stream — writes to `tasks`
   * alone. A fetched copy held beside it goes stale the moment you act on a
   * result: completing a task from a search left it sitting in the list until
   * the query was re-run (Trent, 2026-09-16). Delete was the one handler that
   * remembered to trim `searchResults` too, which is why only delete worked.
   *
   * So `searchResults` contributes just the hit set and the server's ordering;
   * the row data always comes from `tasks`. A hit that is no longer in `tasks`
   * has been completed, deleted or filtered away, and correctly drops out of
   * the results as well.
   */
  const visibleSearchResults = useMemo(() => {
    const byId = new Map(tasks.map((t) => [t.id, t]))
    return searchResults.flatMap((hit) => {
      const live = byId.get(hit.id)
      return live && !live.is_reminder && !isTracked(live) ? [live] : []
    })
  }, [searchResults, tasks])

  const baseTasks = searchQuery ? visibleSearchResults : visibleTasks
  const onLabelToggle = useCallback(() => selection.clear(), [selection])

  // Support ?filter=overdue from notification links — read once, then clear from URL
  const filterParamProcessed = useRef(false)
  const initialDateFilters = useMemo(() => {
    if (filterParamProcessed.current) return undefined
    filterParamProcessed.current = true
    const filter = searchParams.get('filter')
    if (filter === 'overdue') return ['overdue'] as DueDateFilter[]
    return undefined
  }, [searchParams])
  useEffect(() => {
    if (searchParams.get('filter')) {
      router.replace('/', { scroll: false })
    }
  }, [searchParams, router])

  const {
    selectedLabels,
    selectedPriorities,
    selectedDateFilters,
    attributeFilters,
    selectedProjects,
    setSelectedProjects,
    toggleLabel,
    togglePriority,
    toggleDateFilter,
    toggleAttribute,
    toggleProject,
    excludedLabels,
    excludedPriorities,
    excludedDateFilters,
    excludedAttributes,
    excludedProjects,
    excludeLabel,
    excludePriority,
    excludeDateFilter,
    excludeAttribute,
    excludeProject,
    exclusivePriority,
    exclusiveLabel,
    exclusiveDateFilter,
    exclusiveAttribute,
    exclusiveProject,
    clearAllFilters,
    filteredTasks: displayTasks,
  } = useFilterState({
    tasks: baseTasks,
    onLabelToggle,
    timezone,
    initialDateFilters,
  })

  // Support ?project=<id> from sidebar/project list links — set project filter, then clear URL.
  // Uses useEffect (not useMemo+ref) because sidebar links navigate within the already-mounted dashboard.
  useEffect(() => {
    const projectParam = searchParams.get('project')
    if (!projectParam) return
    const projectId = parseInt(projectParam, 10)
    if (!isNaN(projectId)) {
      setSelectedProjects([projectId])
    }
    router.replace('/', { scroll: false })
  }, [searchParams, router, setSelectedProjects])

  // AI mode: Off / On toggle + feature preferences
  const {
    mode: aiMode,
    setMode: setAiMode,
    showInsights,
    setShowInsights,
    wnCommentaryUnfiltered,
    setWnCommentaryUnfiltered,
    wnHighlight,
    setWnHighlight,
    insightsSignalChips,
    setInsightsSignalChips,
    insightsScoreChips,
    setInsightsScoreChips,
  } = useAiMode()

  // AI enrichment: true when any task has the ai-to-process label
  const enrichmentActive = tasks.some((t) => t.labels.includes('ai-to-process'))

  // Server-side AI availability flag — gates all AI UI and prevents wasted requests
  const aiAvailable = useAiAvailable()
  const { aiQuickTakeMode } = useAiPreferences()

  // AI What's Next: fetch recommendations and resolve against current task list
  const aiInsights = useAiInsights(baseTasks, aiAvailable)

  // AI Insights: fetch/generate insights results
  const insightsData = useInsightsData(baseTasks, aiAvailable)

  // Refresh handlers for each AI system (guards are in AiControlArea)
  const handleRefreshAnnotations = aiInsights.refresh

  const handleRefreshInsights = insightsData.generate

  // Mode change handler: switching to 'on' auto-generates insights if no data
  const handleModeChange = useCallback(
    (mode: AiMode) => {
      setAiMode(mode)
      if (mode === 'on' && !insightsData.hasResults && !insightsData.generating) {
        insightsData.generate()
      }
    },
    [setAiMode, insightsData],
  )

  // Insights chip toggle: when turning ON with no data, auto-generate
  const handleInsightsChipToggle = useCallback(() => {
    const newValue = !showInsights
    setShowInsights(newValue)
    if (newValue && !insightsData.hasResults && !insightsData.generating) {
      insightsData.generate()
    }
  }, [showInsights, setShowInsights, insightsData])

  // What's Next AI filter toggle (filter task list to only AI-highlighted tasks)
  const [aiFilterActive, setAiFilterActive] = useState(false)

  // Signal filter state for Insight mode (multi-select with Cmd+click exclusive)
  const [selectedSignals, setSelectedSignals] = useState<string[]>([])

  const handleSignalClick = useCallback((key: string, e: React.MouseEvent) => {
    // Special key from "All" chip to clear signal filter
    if (key === '__clear_all__') {
      setSelectedSignals([])
      return
    }
    if (e.metaKey || e.ctrlKey) {
      setSelectedSignals((prev) => (prev.length === 1 && prev[0] === key ? [] : [key]))
    } else {
      setSelectedSignals((prev) =>
        prev.includes(key) ? prev.filter((s) => s !== key) : [...prev, key],
      )
    }
  }, [])

  const handleSignalLongPress = useCallback((key: string) => {
    setSelectedSignals((prev) => (prev.length === 1 && prev[0] === key ? [] : [key]))
  }, [])

  // Apply AI filter and signal filter after other filters
  const tasks_ = useMemo(() => {
    let result = displayTasks

    // What's Next: filter to highlighted tasks when chip is active
    if (aiMode !== 'off' && aiFilterActive && aiInsights.aiTaskIds.size > 0) {
      result = result.filter((t) => aiInsights.aiTaskIds.has(t.id))
    }

    // Filter by selected signals (union/OR) — signal chips visible via Insights chip or preference
    if (aiMode !== 'off' && selectedSignals.length > 0) {
      result = result.filter((t) => {
        const sigs = insightsData.insightsSignalMap.get(t.id)
        return sigs?.some((s) => selectedSignals.includes(s))
      })
    }

    return result
  }, [
    displayTasks,
    aiMode,
    aiFilterActive,
    aiInsights.aiTaskIds,
    selectedSignals,
    insightsData.insightsSignalMap,
  ])

  // WN annotations: shown when WN filter active OR wnCommentaryUnfiltered pref is on
  const effectiveAnnotationMap = useMemo(() => {
    if (aiMode === 'off') return new Map<number, string>()
    if (aiFilterActive || wnCommentaryUnfiltered) return aiInsights.annotationMap
    return new Map<number, string>()
  }, [aiMode, aiFilterActive, wnCommentaryUnfiltered, aiInsights.annotationMap])

  // Insights commentary: shown when Insights chip is ON (all overlays together)
  const effectiveCommentaryMap = useMemo(() => {
    if (aiMode === 'off' || !showInsights) return new Map<number, string>()
    return insightsData.annotationMap
  }, [aiMode, showInsights, insightsData.annotationMap])

  // WN highlight: decoupled from annotation visibility — based on preference + WN task set
  const showWnHighlight = aiMode !== 'off' && wnHighlight

  // Show annotations when AI mode is not off
  const showAnnotations = aiMode !== 'off'

  // Sort fallback: if Insights chip off and sorting by AI score, revert to due_date
  useEffect(() => {
    if (!showInsights && sortOption === 'ai_insights') {
      setSortOption('due_date')
    }
  }, [showInsights, sortOption, setSortOption])

  // Clear signal selections when signal chips become invisible to prevent hidden filtering
  useEffect(() => {
    const chipsVisible = aiMode !== 'off' && (showInsights || insightsSignalChips)
    if (!chipsVisible && selectedSignals.length > 0) {
      setSelectedSignals([])
    }
  }, [aiMode, showInsights, insightsSignalChips, selectedSignals.length])

  // Wrap clearAllFilters to also clear selection, AI filter, and signal filters
  const handleClearFilters = useCallback(() => {
    selection.clear()
    setAiFilterActive(false)
    setSelectedSignals([])
    clearAllFilters()
  }, [selection, clearAllFilters])

  // Full view reset: clears everything including search (triggered by tapping Dashboard tab)
  const handleDashboardReset = useCallback(() => {
    selection.clear()
    setAiFilterActive(false)
    setSelectedSignals([])
    clearAllFilters()
    setSearchQuery(null)
    setSearchResults([])
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }, [selection, clearAllFilters])

  // Build task groups for keyboard navigation.
  const taskGroups = useMemo(
    () => buildTaskGroups(tasks_, projects, grouping, timezone, timeSlots),
    [tasks_, projects, grouping, timezone, timeSlots],
  )

  /**
   * Support `?task=<id>` — two shapes, sharing one URL so every existing
   * producer keeps working:
   *
   * - `?task=<id>` alone: a notification tap (`AppDelegate`/`MacAppDelegate`
   *   call `WebViewManager.navigateToTask` directly) or a Web Push click
   *   (`overdue-checker.ts`, `notifications/test/route.ts`) — opens
   *   QuickActionPanel, same as always.
   * - `?task=<id>&highlight=1`: the widget's deep link
   *   (`WidgetLink.task`/`OpenTaskApp.handleWidgetLink`). Brings the row into
   *   view and flashes it once; opens nothing — mirrors RemindersView's
   *   `?reminder=<id>` (see its `highlightId` effect for the identical
   *   rationale: a tap from a list-like surface means "show me that one",
   *   not "act on it").
   *
   * The flag is additive rather than a new param name so the URL SHAPE stays
   * `?task=<id>` for every existing caller, per the login-redirect and
   * dashboardPath() query-string passthrough (`src/lib/login-redirect.ts`,
   * `src/app/page.tsx`) — neither needed to change.
   *
   * The param is consumed (and stripped from the URL) only once resolution is
   * DEFINITIVE: the task was found, or the list is non-empty and provably
   * doesn't contain it. `loading === false` alone is not proof the list is
   * ready — on WebKit (iOS webview, Safari) the initial fetch can fail
   * transiently during hydration, flipping `loading` false with zero tasks;
   * consuming the param then means a notification tap opens the app but never
   * the task. With an empty list we leave the param in place and let the
   * effect re-run when a retry/sync populates tasks.
   */
  const taskParamProcessed = useRef(false)
  useEffect(() => {
    if (taskParamProcessed.current || loading) return
    const taskIdParam = searchParams.get('task')
    if (!taskIdParam) return
    const taskId = parseInt(taskIdParam, 10)
    if (isNaN(taskId)) {
      taskParamProcessed.current = true
      window.history.replaceState(window.history.state, '', window.location.pathname)
      return
    }
    const task = tasks.find((t) => t.id === taskId)
    if (!task && tasks.length === 0) return
    const isHighlightLink = searchParams.get('highlight') === '1'
    // The highlight branch groups by `defaultGrouping` to find the row's
    // group — but `defaultGrouping` starts at a hardcoded fallback
    // ('project') until `PreferencesProvider`'s own fetch resolves (see
    // `useDefaultGrouping`'s doc comment), same shape as the `tasks.length
    // === 0` wait above: consuming the param against the fallback can expand
    // the wrong group and never revisit it. Found by browser-verifying
    // against Trent's dev account, whose real default is `slot`, not
    // `project` — a `?task=&highlight=1` tap resolved against the fallback
    // before this guard landed on the wrong group every time.
    if (task && isHighlightLink && !isTracked(task) && !groupingLoaded) return
    taskParamProcessed.current = true
    if (task) {
      // §5: a quota does not open in the dashboard's QuickActionPanel — that
      // panel is a due date and a snooze grid, neither of which a quota has.
      // Its own editor is on the detail route, which already renders
      // QuotaDetail for a tracked row. This is the last path by which a quota
      // could still reach the panel now that it is out of every list.
      if (isTracked(task)) {
        router.push(`/tasks/${task.id}`)
      } else if (isHighlightLink) {
        // `taskGroups` is built from the FILTERED list (`tasks_`), so an
        // active filter/search hiding this task leaves no row to expand or
        // flash — the same silent no-op RemindersView falls back to when a
        // linked reminder isn't in the currently loaded view.
        const group = taskGroups.find((g) => g.tasks.some((t) => t.id === task.id))
        if (group) {
          if (isCollapsed(group.label)) expand(group.label)
          setHighlightTaskId(task.id)
        }
      } else {
        handleViewTask(task)
      }
    }
    // Strip the param with a raw history rewrite, NOT router.replace: a router
    // navigation issues an RSC fetch, and if that fetch fails (WebKit does
    // this under flaky transport) Next falls back to a full page navigation
    // that remounts this component and closes the just-opened panel. Same
    // pattern as AppLayout's ?action=create handling.
    window.history.replaceState(window.history.state, '', window.location.pathname)
  }, [
    searchParams,
    loading,
    tasks,
    handleViewTask,
    router,
    taskGroups,
    isCollapsed,
    expand,
    groupingLoaded,
  ])

  // Apply per-group sorting to match the visual order in TaskList.
  // Exclude tasks in collapsed groups so keyboard navigation skips them.
  const orderedIds = useMemo(
    () =>
      taskGroups.flatMap((g) => {
        if (isCollapsed(g.label)) return []
        return sortTasks(g.tasks, sortOption, reversed).map((t) => t.id)
      }),
    [taskGroups, sortOption, reversed, isCollapsed],
  )

  // Wrap toggleCollapse to deselect tasks in a group when collapsing it
  const handleToggleCollapse = useCallback(
    (label: string) => {
      if (!isCollapsed(label)) {
        // About to collapse — deselect tasks in this group
        const group = taskGroups.find((g) => g.label === label)
        if (group && selection.isSelectionMode) {
          const groupIds = group.tasks.map((t) => t.id)
          selection.removeAll(groupIds)
        }
      }
      toggleCollapse(label)
    },
    [isCollapsed, toggleCollapse, taskGroups, selection],
  )

  // Keyboard completion handler
  const handleKeyboardComplete = useCallback(
    async (taskIds: number[]) => {
      if (taskIds.length === 0) return

      if (taskIds.length === 1) {
        await actions.handleDone(taskIds[0])
      } else {
        // Bulk complete
        const count = taskIds.length
        try {
          const res = await fetch('/api/tasks/bulk/done', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids: taskIds }),
          })
          if (!res.ok) throw new Error('Bulk action failed')
          refreshAll()
          actions.bumpUndoCount()
          showToast({
            message: `${count} ${taskWord(count)} completed`,
            type: 'success',
            action: { label: 'Undo', onClick: actions.handleUndo },
          })
        } catch {
          showToast({ message: 'Action failed', type: 'error' })
        }
      }
    },
    [actions, refreshAll],
  )

  // Keyboard navigation hook - disabled when sheets/dialogs are open
  const keyboardNavEnabled =
    !showProjectPicker && !quickActionOpen && !showShortcutsDialog && !createPanelOpen
  const keyboard = useKeyboardNavigation({
    orderedIds,
    groups: taskGroups,
    keyboardFocusedId,
    setKeyboardFocusedId,
    selection,
    onComplete: handleKeyboardComplete,
    enabled: keyboardNavEnabled,
  })

  // Handler for desktop click: set keyboard focus (blue glow) without selecting
  const handleActivate = useCallback(
    (taskId: number) => {
      setKeyboardFocusedId(taskId)
      keyboard.enterKeyboardMode()
      // Sync browser focus to match the visual blue glow
      document.getElementById(`task-row-${taskId}`)?.focus()
      // Note: Does NOT call selection.selectOnly() - focus and selection are independent
    },
    [keyboard],
  )

  // Handler for desktop double-click: open QuickActionPopover for the task
  const handleDoubleClick = useCallback(
    (task: Task) => {
      setFocusedTask(task)
      setQuickActionOpen(true)
    },
    [setFocusedTask, setQuickActionOpen],
  )

  // Return focus to task list when keyboard shortcuts dialog closes (if there are selections).
  // Using onCloseAutoFocus ensures this fires AFTER Radix removes aria-hidden from main,
  // avoiding the "blocked aria-hidden on focused element" warning.
  const handleShortcutsDialogCloseAutoFocus = useCallback(
    (e: Event) => {
      if (selection.isSelectionMode) {
        const focusTarget = keyboardFocusedId ?? [...selection.selectedIds][0]
        if (focusTarget) {
          e.preventDefault()
          setKeyboardFocusedId(focusTarget)
          keyboard.enterKeyboardMode()
          document.getElementById(`task-row-${focusTarget}`)?.focus()
        }
      }
    },
    [selection.isSelectionMode, selection.selectedIds, keyboardFocusedId, keyboard],
  )

  // Exit keyboard/selection modes on click/touch outside (extracted to hook)
  useExitModes({ keyboard, selection })

  const handleSnoozeAllOverdue = useSnoozeOverdue({
    displayTasks,
    fetchTasks: refreshAll,
    handleUndo: actions.handleUndo,
    onUndoCountBump: actions.bumpUndoCount,
    timezone,
    defaultSnoozeOption,
    morningTime,
  })

  const bulk = useBulkActions(
    selection,
    refreshAll,
    actions.handleUndo,
    actions.bumpUndoCount,
    setShowProjectPicker,
    setSearchQuery,
    setSearchResults,
  )

  // Global keyboard shortcuts (extracted to hook)
  useDashboardKeyboard({
    keyboard,
    keyboardNavEnabled,
    orderedIds,
    keyboardFocusedId,
    setKeyboardFocusedId,
    selection,
    taskGroups,
    sortOption,
    reversed,
    timezone,
    projects,
    annotationMap: effectiveAnnotationMap,
    showAnnotations,
    setShowShortcutsDialog,
    searchFocusRef,
    onDeleteTask: handleQuickActionDelete,
    onBulkDelete: bulk.bulkDelete,
  })

  const { overdueCount, todayCount } = useTaskCounts(tasks_, timezone)
  // The nav's Tasks badges read a shared cache; this page is its source of
  // truth. Published from the unfiltered list (reminders excluded, nothing
  // else): a filter chip changes the view, not what is due.
  const navCounts = useTaskCounts(visibleTasks, timezone)
  useEffect(() => {
    publishTaskCounts({
      total: visibleTasks.length,
      overdue: navCounts.overdueCount,
      today: navCounts.todayCount,
    })
  }, [visibleTasks.length, navCounts.overdueCount, navCounts.todayCount])

  // Update browser tab title with overdue count
  useEffect(() => {
    document.title = overdueCount > 0 ? `(${overdueCount}) OpenTask` : 'OpenTask'
    return () => {
      document.title = 'OpenTask'
    }
  }, [overdueCount])

  // Update PWA dock badge with overdue count (Badging API)
  useEffect(() => {
    if (!navigator.setAppBadge) return
    if (overdueCount > 0) {
      navigator.setAppBadge(overdueCount)
    } else {
      navigator.clearAppBadge()
    }
    return () => {
      navigator.clearAppBadge?.()
    }
  }, [overdueCount])

  // Compute per-project today task counts for ProjectFilterBar
  const todayCounts = useMemo(() => {
    if (!timezone) return new Map<number, number>()
    const now = new Date()
    const boundaries = getTimezoneDayBoundaries(timezone)
    const counts = new Map<number, number>()
    for (const task of tasks_) {
      const buckets = classifyTaskDueDate(task, now, boundaries)
      if (buckets.includes('today')) {
        counts.set(task.project_id, (counts.get(task.project_id) || 0) + 1)
      }
    }
    return counts
  }, [tasks_, timezone])

  // Compute selected tasks for bulk operations
  // Reads `visibleTasks`, not the raw corpus: the selection can only ever hold
  // ids of rendered rows, and resolving it against rows this page deliberately
  // hides would let a reminder or a quota reach the bulk action sheet.
  const selectedTasks = useMemo(() => {
    return visibleTasks.filter((t) => selection.selectedIds.has(t.id))
  }, [visibleTasks, selection.selectedIds])

  // Fetch tasks on initial mount (skipped when server provides initialTasks)
  const hasInitialData = initialTasks !== undefined
  useEffect(() => {
    if (status === 'loading') return
    if (status === 'unauthenticated') {
      router.push(loginUrlFromLocation())
      return
    }
    if (!hasInitialData) {
      fetchTasks()
    }
  }, [status, router, fetchTasks, hasInitialData])

  // Refresh tasks when a new task is created (e.g., from the global CreateTaskPanel).
  // Only refreshes tasks here — ProjectsProvider handles its own project count refresh.
  useEffect(() => {
    const handler = () => fetchTasks()
    window.addEventListener('task-created', handler)
    return () => window.removeEventListener('task-created', handler)
  }, [fetchTasks])

  // Reset view when user taps Dashboard tab while already on the dashboard.
  // Clears all filters, search, selection, and scrolls to top (standard active-tab-tap UX).
  useEffect(() => {
    const handler = () => handleDashboardReset()
    window.addEventListener('dashboard-reset', handler)
    return () => window.removeEventListener('dashboard-reset', handler)
  }, [handleDashboardReset])

  // Prefetch QuickActionPopover chunk after initial load so first interaction is instant
  // (CreateTaskPanel is prefetched by AppLayout which wraps all pages)
  useEffect(() => {
    const timer = setTimeout(() => {
      import('@/components/QuickActionPopover')
    }, 2000)
    return () => clearTimeout(timer)
  }, [])

  if (status === 'loading' || (status === 'authenticated' && loading)) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="animate-pulse text-zinc-500">Loading...</div>
      </div>
    )
  }

  if (status === 'unauthenticated') return null

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-center">
          <div className="mb-4 text-red-500">{error}</div>
          <button
            onClick={() => {
              setError(null)
              setLoading(true)
              refreshAll()
            }}
            className="rounded-lg bg-zinc-100 px-4 py-2 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700"
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  return (
    <>
      <DemoTour />
      <DashboardView
        tasks={tasks_}
        allTasks={baseTasks}
        quotaSource={tasks}
        projects={projects}
        grouping={grouping}
        highlightTaskId={highlightTaskId}
        onHighlightDone={clearHighlight}
        onGroupingChange={(next) => {
          // Selecting a view explicitly turns off AI-sort's unified override —
          // otherwise the toggle would show a selection that isn't in effect.
          setAiSortUnified(false)
          setDefaultGrouping(next)
        }}
        timeSlots={timeSlots}
        searchQuery={searchQuery}
        searchResultCount={visibleSearchResults.length}
        overdueCount={overdueCount}
        todayCount={todayCount}
        selection={selection}
        selectedTasks={selectedTasks}
        showProjectPicker={showProjectPicker}
        actions={actions}
        selectedLabels={selectedLabels}
        onToggleLabel={toggleLabel}
        onClearFilters={handleClearFilters}
        selectedPriorities={selectedPriorities}
        onTogglePriority={togglePriority}
        onExclusivePriority={exclusivePriority}
        selectedDateFilters={selectedDateFilters}
        onToggleDateFilter={toggleDateFilter}
        onExclusiveDateFilter={exclusiveDateFilter}
        onExclusiveLabel={exclusiveLabel}
        attributeFilters={attributeFilters}
        onToggleAttribute={toggleAttribute}
        onExclusiveAttribute={exclusiveAttribute}
        selectedProjects={selectedProjects}
        onToggleProject={toggleProject}
        onExclusiveProject={exclusiveProject}
        excludedLabels={excludedLabels}
        excludedPriorities={excludedPriorities}
        excludedDateFilters={excludedDateFilters}
        excludedAttributes={excludedAttributes}
        excludedProjects={excludedProjects}
        onExcludeLabel={excludeLabel}
        onExcludePriority={excludePriority}
        onExcludeDateFilter={excludeDateFilter}
        onExcludeAttribute={excludeAttribute}
        onExcludeProject={excludeProject}
        todayCounts={todayCounts}
        timezone={timezone}
        onSearch={bulk.handleSearch}
        onSearchClear={() => {
          selection.clear()
          setSearchQuery(null)
          setSearchResults([])
        }}
        onBulkDone={bulk.bulkDone}
        onBulkSaveAll={bulk.bulkSaveAll}
        onBulkDelete={bulk.bulkDelete}
        onBulkMoveToProject={bulk.handleBulkMoveToProject}
        onShowProjectPicker={setShowProjectPicker}
        onSnoozeOverdue={handleSnoozeAllOverdue}
        focusedTask={focusedTask}
        quickActionOpen={quickActionOpen}
        onTaskFocus={setFocusedTask}
        onQuickActionClose={() => setQuickActionOpen(false)}
        onQuickActionSaveAll={actions.handleSaveAllChanges}
        onQuickActionNavigate={(taskId) => router.push(`/tasks/${taskId}`)}
        onNavigateToDetail={(taskId) => router.push(`/tasks/${taskId}`)}
        keyboardFocusedId={keyboardFocusedId}
        isKeyboardActive={keyboard.isKeyboardActive}
        onKeyDown={keyboard.handleKeyDown}
        onListFocus={keyboard.handleFocus}
        onListBlur={keyboard.handleBlur}
        sortOption={sortOption}
        reversed={reversed}
        setSortOption={setSortOption}
        isCollapsed={isCollapsed}
        toggleCollapse={handleToggleCollapse}
        onActivate={handleActivate}
        onDoubleClick={handleDoubleClick}
        showShortcutsDialog={showShortcutsDialog}
        onShortcutsDialogChange={setShowShortcutsDialog}
        onShortcutsDialogCloseAutoFocus={handleShortcutsDialogCloseAutoFocus}
        bulkSheetOpenRef={bulkSheetOpenRef}
        aiAvailable={aiAvailable}
        aiMode={aiMode}
        onAiModeChange={handleModeChange}
        showInsights={showInsights}
        onToggleInsights={handleInsightsChipToggle}
        wnCommentaryUnfiltered={wnCommentaryUnfiltered}
        onWnCommentaryUnfilteredChange={setWnCommentaryUnfiltered}
        wnHighlight={wnHighlight}
        onWnHighlightChange={setWnHighlight}
        insightsSignalChips={insightsSignalChips}
        onInsightsSignalChipsChange={setInsightsSignalChips}
        insightsScoreChips={insightsScoreChips}
        onInsightsScoreChipsChange={setInsightsScoreChips}
        enrichmentActive={enrichmentActive}
        onRefreshAnnotations={handleRefreshAnnotations}
        onRefreshInsights={handleRefreshInsights}
        aiInsights={aiInsights}
        insightsData={insightsData}
        aiFilterActive={aiFilterActive}
        onToggleAiFilter={() => setAiFilterActive((prev) => !prev)}
        effectiveAnnotationMap={effectiveAnnotationMap}
        effectiveCommentaryMap={effectiveCommentaryMap}
        showAnnotations={showAnnotations}
        showWnHighlight={showWnHighlight}
        selectedSignals={selectedSignals}
        onSignalClick={handleSignalClick}
        onSignalLongPress={handleSignalLongPress}
        onQuickActionDone={actions.handleDone}
        onQuickActionDelete={handleQuickActionDelete}
        onReprocess={handleReprocess}
        onQuickAdd={
          aiAvailable && aiQuickTakeMode !== 'off'
            ? handleQuickAddWithQuickTake
            : actions.handleQuickAdd
        }
        bannerState={bannerState}
        onQuickTakeDismiss={handleQuickTakeDismiss}
        onQuickTakeViewTask={
          bannerState?.taskId
            ? () => {
                const task = tasks.find((t) => t.id === bannerState.taskId)
                if (task) handleViewTask(task)
                else router.push(`/tasks/${bannerState.taskId}`)
              }
            : undefined
        }
        onTrackRefresh={refreshAll}
        onUnifiedChange={(unified) => {
          if (sortOption === 'ai_insights') {
            // During AI sort: only toggle local override, don't persist to DB
            setAiSortUnified(unified)
          } else if (unified) {
            // Manual unified on: save current grouping and persist
            if (defaultGrouping !== 'unified') prevNonUnifiedGrouping.current = defaultGrouping
            setDefaultGrouping('unified')
          } else {
            // Manual unified off: restore previous grouping
            setDefaultGrouping(prevNonUnifiedGrouping.current || 'project')
            prevNonUnifiedGrouping.current = null
          }
        }}
        searchFocusRef={searchFocusRef}
        remindersRefreshRef={remindersRefreshRef}
      />
    </>
  )
}

/**
 * `<main>`'s classes, and the reason the Tasks page has two shapes.
 *
 * THE TASKS PAGE IS TWO EQUAL COLUMNS FROM `xl` UP (Trent, 2026-09-15).
 *
 * Below `xl` this is exactly what it has always been: one centred column,
 * `max-w-2xl`, with Track inline above the list. From 1280px the page widens
 * and Track moves into a second column beside the day. The reason is that Track
 * had grown to 22 quotas — 350-500px of panel wedged between the filters and
 * the first task — while the window it was drawn in had a wide empty gutter
 * down BOTH sides.
 *
 * Four things here are load-bearing:
 *
 * - THE TWO COLUMNS ARE THE SAME WIDTH (`xl:grid-cols-2`, i.e. two
 *   `minmax(0, 1fr)` tracks). The first cut gave the task column a fixed 40rem
 *   and let Track take everything left over, to keep the task column
 *   pixel-identical so its filter chip rows could not reflow. On Trent's window
 *   "uncapped" came out at roughly 1060px of Track against 570px of tasks —
 *   the secondary panel nearly twice the primary one — and he rejected it:
 *   "the left side is too skinny or the right too wide, it looks bizarre."
 *   Equal columns supersede the no-reflow constraint; the chip rows reflowing
 *   is expected and accepted.
 * - THERE IS A REAL SIDE MARGIN AT `xl` (`xl:px-10`, 40px, against `px-4`'s 16).
 *   The same complaint: with 16px the logo in the bar above sat hard against
 *   the sidebar's border. The bar carries the identical padding and cap so its
 *   contents stay lined up with the column beneath them — see `Header`'s
 *   `wideAtXl`.
 * - THE PAIR STOPS GROWING AT 86.5rem (`xl:max-w-[86.5rem]`), and the number is
 *   arithmetic, not taste: 2 × 40rem of column + 1.5rem of `gap-x-6` +
 *   2 × 2.5rem of `px-10` = 86.5rem. 40rem is the content width the single
 *   column has always had (`max-w-2xl` less `px-4`) and the width every filter
 *   chip row was tuned against, so each column tops out at exactly the column
 *   the page has always shown and an ultrawide display gets margins rather than
 *   two 900px columns. Below the cap `mx-auto` keeps centring, as it always has.
 * - THERE IS NO ROW GAP at any width. The vertical rhythm between the three
 *   blocks is still their own `mb-*`, exactly as when they were plain siblings;
 *   only the column gap is new, and it only exists at `xl`.
 *
 * `content-start` AND `xl:grid-rows-[auto_1fr]` ARE BOTH LOAD-BEARING, and a
 * fix with only one of them looks right until the page is short. `<main>` is
 * `flex-1` in a `min-h-screen` flex column, so it is always at least the
 * viewport tall. As a block, leftover height sat harmlessly at the bottom. As a
 * grid, `align-content` defaults to `normal`, which for a grid is STRETCH — the
 * leftover gets divided equally between the auto rows, opening a blank band
 * between the filters, Track and the list whenever the content is shorter than
 * the viewport (a search with no results, or every group folded). `content-start`
 * packs the rows at the top instead.
 *
 * That alone is not enough at `xl`, because Track is `row-span-2` there: a
 * spanning item contributes its height to the tracks it spans during intrinsic
 * sizing, so a tall Track inflates the filters row no matter what
 * `align-content` or `self-start` say. The fix is the explicit row template —
 * an item spanning a FLEXIBLE track is excluded from the intrinsic sizing of
 * the auto tracks it also spans, so a tall Track lands in the `1fr` row, which
 * is also where `flex-1`'s leftover goes. `items-start` keeps a short list from
 * stretching down that now-tall row.
 *
 * The grid is a grid at EVERY width, single-column below `xl`. That is what
 * lets Track be one element in one place in the DOM — see `TrackColumn`.
 */
function mainClass(twoColumn: boolean): string {
  return cn(
    'mx-auto grid w-full max-w-2xl flex-1 grid-cols-1 content-start items-start px-4 py-6',
    twoColumn && 'xl:max-w-[86.5rem] xl:grid-cols-2 xl:grid-rows-[auto_1fr] xl:gap-x-6 xl:px-10',
  )
}

/**
 * §5: the quotas' instrument panel — above the list on every view of the Tasks
 * page ("wherever they go, it can't be buried"), unaffected by list filters.
 * Hidden while searching so results stay results. Fed the UNFILTERED corpus,
 * not `allTasks`: quotas are exactly what `allTasks` now drops, so passing it
 * would empty this panel.
 *
 * ITS OWN GRID CHILD, RENDERED EXACTLY ONCE. Below `xl` the grid is a single
 * column and this is simply the second of three blocks — the same place in the
 * same order it has always been, between the filters and the list. At `xl` it is
 * placed into column two spanning both rows. Placement, rather than a second
 * copy behind a `xl:hidden`/`hidden xl:block` pair, is the whole trick: one
 * instance means one set of fold state, one set of `data-track-chip` nodes for
 * a test to find, and a DOM order for a screen reader that does not change with
 * the width.
 *
 * Sticky needs `self-start`: a grid child stretches to the row's height by
 * default, and a full-height box has nothing to stick within. `<main>` now sets
 * `items-start` for every child, so this repeats it rather than introducing it —
 * kept explicit because it is this element that would silently stop sticking if
 * the container's alignment ever changed. The top offset clears the sticky
 * header, and the max-height keeps a tall panel's bottom reachable rather than
 * stranded below the fold.
 *
 * It spans BOTH rows at `xl` (`row-span-2`), and the row template that makes
 * that safe is on `<main>` — see `mainClass`, which explains why a spanning
 * item and an `auto` row cannot be combined here.
 *
 * The column is RESERVED while a search is running rather than released, so
 * typing in the search box cannot re-centre the page under the user.
 *
 * The Reminders panel (`DashboardRemindersPanel`) lives here too now, ABOVE
 * `<TrackPanel>` — a second sibling INSIDE this same wrapper, not a second grid
 * child. Same reasoning as Track's own placement: one instance, one DOM
 * position, sticky and scrollable as part of this one column at every width.
 * It shares Track's `!searching` gate for the same reason Track has it —
 * "results stay results" while a task search is running — even though the
 * Reminders panel's own data has nothing to do with that search.
 */
function TrackColumn({
  quotaSource,
  twoColumn,
  searching,
  onRemindersUndo,
  onRemindersCompleted,
  onTrackUndo,
  onTrackCompleted,
  onTrackRefresh,
  remindersRefreshRef,
  timeSlots,
  timezone,
}: {
  quotaSource: Task[]
  twoColumn: boolean
  searching: boolean
  onRemindersUndo: () => void
  onRemindersCompleted: () => void
  /** Same underlying pipeline as `onRemindersUndo`/`onRemindersCompleted`
   *  (`actions.handleUndo`/`actions.bumpUndoCount`) — named for Track rather
   *  than shared, since `TrackPanel` and `DashboardRemindersPanel` are
   *  independent callers and one panel's props should not imply the other's. */
  onTrackUndo: () => void
  onTrackCompleted: () => void
  /** `TrackPanel` does not own its data (`quotaSource` is a prop) the way
   *  `DashboardRemindersPanel` owns its own `useReminders` fetch, so a save,
   *  create or delete through its modal needs an explicit way to refresh it. */
  onTrackRefresh: () => Promise<void>
  remindersRefreshRef: React.MutableRefObject<(() => void) | null>
  timeSlots: TimeSlot[]
  timezone: string
}) {
  return (
    <div
      className={cn(
        'min-w-0',
        twoColumn &&
          'xl:sticky xl:top-[4.5rem] xl:col-start-2 xl:row-span-2 xl:row-start-1 xl:max-h-[calc(100vh-6rem)] xl:self-start xl:overflow-y-auto',
      )}
    >
      {!searching && (
        <>
          <DashboardRemindersPanel
            onUndo={onRemindersUndo}
            onCompleted={onRemindersCompleted}
            refreshRef={remindersRefreshRef}
            timeSlots={timeSlots}
            timezone={timezone}
          />
          <TrackPanel
            tasks={quotaSource}
            onUndo={onTrackUndo}
            onCompleted={onTrackCompleted}
            onRefresh={onTrackRefresh}
          />
        </>
      )}
    </div>
  )
}

function DashboardView({
  tasks,
  allTasks,
  quotaSource,
  projects,
  grouping,
  highlightTaskId,
  onHighlightDone,
  onGroupingChange,
  timeSlots,
  searchQuery,
  searchResultCount,
  overdueCount,
  todayCount,
  selection,
  selectedTasks,
  showProjectPicker,
  actions,
  selectedLabels,
  onToggleLabel,
  onClearFilters,
  selectedPriorities,
  onTogglePriority,
  onExclusivePriority,
  selectedDateFilters,
  onToggleDateFilter,
  onExclusiveDateFilter,
  onExclusiveLabel,
  attributeFilters,
  onToggleAttribute,
  onExclusiveAttribute,
  selectedProjects,
  onToggleProject,
  onExclusiveProject,
  excludedLabels,
  excludedPriorities,
  excludedDateFilters,
  excludedAttributes,
  excludedProjects,
  onExcludeLabel,
  onExcludePriority,
  onExcludeDateFilter,
  onExcludeAttribute,
  onExcludeProject,
  todayCounts,
  timezone,
  onSearch,
  onSearchClear,
  onBulkDone,
  onBulkSaveAll,
  onBulkDelete,
  onBulkMoveToProject,
  onShowProjectPicker,
  onSnoozeOverdue,
  focusedTask,
  quickActionOpen,
  onTaskFocus,
  onQuickActionClose,
  onQuickActionSaveAll,
  onQuickActionNavigate,
  onNavigateToDetail,
  keyboardFocusedId,
  isKeyboardActive,
  onKeyDown,
  onListFocus,
  onListBlur,
  sortOption,
  reversed,
  setSortOption,
  isCollapsed,
  toggleCollapse,
  onActivate,
  onDoubleClick,
  showShortcutsDialog,
  onShortcutsDialogChange,
  onShortcutsDialogCloseAutoFocus,
  bulkSheetOpenRef,
  aiAvailable,
  aiMode,
  onAiModeChange,
  showInsights,
  onToggleInsights,
  wnCommentaryUnfiltered,
  onWnCommentaryUnfilteredChange,
  wnHighlight,
  onWnHighlightChange,
  insightsSignalChips,
  onInsightsSignalChipsChange,
  insightsScoreChips,
  onInsightsScoreChipsChange,
  enrichmentActive,
  onRefreshAnnotations,
  onRefreshInsights,
  aiInsights,
  insightsData,
  aiFilterActive,
  onToggleAiFilter,
  effectiveAnnotationMap,
  effectiveCommentaryMap,
  showAnnotations,
  showWnHighlight,
  selectedSignals,
  onSignalClick,
  onSignalLongPress,
  onQuickActionDone,
  onQuickActionDelete,
  onReprocess,
  onUnifiedChange,
  onQuickAdd,
  bannerState,
  onQuickTakeDismiss,
  onQuickTakeViewTask,
  searchFocusRef,
  remindersRefreshRef,
  onTrackRefresh,
}: {
  tasks: Task[]
  allTasks: Task[]
  /**
   * The unfiltered corpus, for the Track panel only. `allTasks` deliberately
   * has quotas removed (they are not tasks, §5), and the panel is the one
   * place on this page that needs them.
   */
  quotaSource: Task[]
  projects: Project[]
  grouping: GroupingMode
  /** `?task=<id>&highlight=1` — the widget's link. See `HomeContent`'s `?task=` effect. */
  highlightTaskId: number | null
  onHighlightDone: () => void
  onGroupingChange: (grouping: GroupingMode) => void
  /** §6.0 time slots, for `grouping === 'slot'`. Fetched once by the parent. */
  timeSlots: TimeSlot[]
  searchQuery: string | null
  searchResultCount: number
  overdueCount: number
  todayCount: number
  selection: ReturnType<typeof useSelection>
  selectedTasks: Task[]
  showProjectPicker: boolean
  actions: ReturnType<typeof useDashboardActions>
  selectedLabels: string[]
  onToggleLabel: (label: string) => void
  onClearFilters: () => void
  selectedPriorities: number[]
  onTogglePriority: (priority: number) => void
  onExclusivePriority: (priority: number) => void
  selectedDateFilters: DueDateFilter[]
  onToggleDateFilter: (filter: DueDateFilter) => void
  onExclusiveDateFilter: (filter: DueDateFilter) => void
  onExclusiveLabel: (label: string) => void
  attributeFilters: Set<string>
  onToggleAttribute: (key: string) => void
  onExclusiveAttribute: (key: string) => void
  selectedProjects: number[]
  onToggleProject: (projectId: number) => void
  onExclusiveProject: (projectId: number) => void
  excludedLabels: string[]
  excludedPriorities: number[]
  excludedDateFilters: DueDateFilter[]
  excludedAttributes: Set<string>
  excludedProjects: number[]
  onExcludeLabel: (label: string) => void
  onExcludePriority: (priority: number) => void
  onExcludeDateFilter: (filter: DueDateFilter) => void
  onExcludeAttribute: (key: string) => void
  onExcludeProject: (projectId: number) => void
  todayCounts: Map<number, number>
  timezone: string
  onSearch: (q: string) => void
  onSearchClear: () => void
  onBulkDone: () => Promise<void>
  onBulkSaveAll: (changes: QuickActionPanelChanges, dateTaskIds?: number[]) => Promise<void> | void
  onBulkDelete: () => Promise<void>
  onBulkMoveToProject: (projectId: number) => Promise<void>
  onShowProjectPicker: (show: boolean) => void
  onSnoozeOverdue: (until?: string) => void
  focusedTask: Task | null
  quickActionOpen: boolean
  onTaskFocus: (task: Task) => void
  onQuickActionClose: () => void
  onQuickActionSaveAll: (taskId: number, changes: QuickActionPanelChanges) => void
  onQuickActionDone: (taskId: number) => void
  onQuickActionDelete: (taskId: number) => void
  onQuickActionNavigate: (taskId: number) => void
  onNavigateToDetail: (taskId: number) => void
  keyboardFocusedId: number | null
  isKeyboardActive: boolean
  onKeyDown: (e: React.KeyboardEvent) => void
  onListFocus: (e: React.FocusEvent) => void
  onListBlur: (e: React.FocusEvent) => void
  sortOption: SortOption
  reversed: boolean
  setSortOption: (option: SortOption) => void
  isCollapsed: (groupLabel: string) => boolean
  toggleCollapse: (groupLabel: string) => void
  onActivate: (taskId: number) => void
  onDoubleClick: (task: Task) => void
  showShortcutsDialog: boolean
  onShortcutsDialogChange: (open: boolean) => void
  onShortcutsDialogCloseAutoFocus: (e: Event) => void
  bulkSheetOpenRef: React.MutableRefObject<(() => void) | null>
  aiAvailable: boolean
  aiMode: AiMode
  onAiModeChange: (mode: AiMode) => void
  showInsights: boolean
  onToggleInsights: () => void
  wnCommentaryUnfiltered: boolean
  onWnCommentaryUnfilteredChange: (show: boolean) => void
  wnHighlight: boolean
  onWnHighlightChange: (show: boolean) => void
  insightsSignalChips: boolean
  onInsightsSignalChipsChange: (show: boolean) => void
  insightsScoreChips: boolean
  onInsightsScoreChipsChange: (show: boolean) => void
  enrichmentActive: boolean
  onRefreshAnnotations: () => void
  onRefreshInsights: () => void
  aiInsights: UseAiInsightsReturn
  insightsData: UseInsightsDataReturn
  aiFilterActive: boolean
  onToggleAiFilter: () => void
  effectiveAnnotationMap: Map<number, string>
  effectiveCommentaryMap: Map<number, string>
  showAnnotations: boolean
  showWnHighlight: boolean
  selectedSignals: string[]
  onSignalClick: (key: string, e: React.MouseEvent) => void
  onSignalLongPress: (key: string) => void
  onReprocess: (taskId: number) => Promise<void>
  onUnifiedChange: (unified: boolean) => void
  onQuickAdd: (title: string) => Promise<void | number | null>
  bannerState: {
    taskId: number | null
    title: string
    quickTakeText: string | null
    loading: boolean
    enrichment: { title?: string; due_at?: string | null; priority?: number } | null
  } | null
  onQuickTakeDismiss: () => void
  onQuickTakeViewTask?: () => void
  searchFocusRef?: React.MutableRefObject<(() => void) | null>
  /** Threaded to `TrackColumn` → `DashboardRemindersPanel` — see the block
   * comment on `remindersRefreshRef` in `HomeContent`. */
  remindersRefreshRef: React.MutableRefObject<(() => void) | null>
  /** Threaded to `TrackColumn` → `TrackPanel`'s chip-opened editor, which has
   *  no fetch of its own to refresh after a save/create/delete — see
   *  `TrackColumn`'s own `onTrackRefresh`. */
  onTrackRefresh: () => Promise<void>
}) {
  // Filters that live inside the collapsible block (§7.3). Counted rather than
  // just flagged: the count is what the collapsed "Filters · 2" badge shows,
  // and what decides whether the block auto-expands.
  const activeFilterCount =
    selectedLabels.length +
    selectedPriorities.length +
    selectedDateFilters.length +
    attributeFilters.size +
    selectedProjects.length +
    excludedLabels.length +
    excludedPriorities.length +
    excludedDateFilters.length +
    excludedAttributes.size +
    excludedProjects.length

  const { expanded: filtersExpanded, toggleExpanded: onToggleFilters } =
    useFilterSection(activeFilterCount)

  // The AI chips stay visible in the collapsed control row, so they are not
  // part of the count — but they still narrow the list, so they still count
  // toward "is anything filtered".
  const anyFilterActive =
    activeFilterCount > 0 ||
    (aiMode !== 'off' && aiFilterActive) ||
    (aiMode !== 'off' && selectedSignals.length > 0)

  // Whether the page splits into task column + Track column at `xl` (see the
  // block comment on <main>). Gated on the user actually HAVING a quota: with
  // nothing to put in it, the second column is dead space, and the only visible
  // effect of the split would be that the task column stopped being centred.
  // Deliberately NOT gated on `searchQuery` — the column stays reserved while a
  // search runs, so typing cannot re-centre the page under the user.
  const twoColumn = quotaSource.some(isTracked)

  return (
    <div className="flex flex-1 flex-col">
      <Header
        taskCount={tasks.length}
        overdueCount={overdueCount}
        todayCount={todayCount}
        isSelectionMode={selection.isSelectionMode}
        onUndo={actions.handleUndo}
        onRedo={actions.handleRedo}
        undoCount={actions.undoCount}
        redoCount={actions.redoCount}
        onSearch={onSearch}
        onSearchClear={onSearchClear}
        onSnoozeOverdue={onSnoozeOverdue}
        onShowKeyboardShortcuts={() => onShortcutsDialogChange(true)}
        timezone={timezone}
        searchFocusRef={searchFocusRef}
        wideAtXl={twoColumn}
      />

      <main className={mainClass(twoColumn)}>
        <div className="min-w-0 xl:col-start-1 xl:row-start-1">
          {/* Quick add + AI chip row */}
          <div className="mb-4 flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <QuickAdd
                onAdd={async (title) => {
                  await onQuickAdd(title)
                }}
                onOpenAddForm={(title) => {
                  window.dispatchEvent(new CustomEvent('open-add-form', { detail: { title } }))
                }}
              />
            </div>
            {aiAvailable && (
              <AiControlArea
                mode={aiMode}
                onModeChange={onAiModeChange}
                wnCommentaryUnfiltered={wnCommentaryUnfiltered}
                onWnCommentaryUnfilteredChange={onWnCommentaryUnfilteredChange}
                wnHighlight={wnHighlight}
                onWnHighlightChange={onWnHighlightChange}
                insightsSignalChips={insightsSignalChips}
                onInsightsSignalChipsChange={onInsightsSignalChipsChange}
                insightsScoreChips={insightsScoreChips}
                onInsightsScoreChipsChange={onInsightsScoreChipsChange}
                annotationGeneratedAt={aiInsights.generatedAt}
                annotationDurationMs={aiInsights.durationMs}
                annotationFreshnessText={aiInsights.freshnessText}
                annotationRefreshLoading={aiInsights.loading}
                annotationError={aiInsights.error}
                onRefreshAnnotations={onRefreshAnnotations}
                insightsGeneratedAt={insightsData.generatedAt}
                insightsDurationMs={insightsData.durationMs}
                insightsGenerating={insightsData.generating}
                insightsProgress={insightsData.progress}
                insightsCompletedTasks={insightsData.completedTasks}
                insightsTotalTasks={insightsData.totalTasks}
                insightsSingleCall={insightsData.singleCall}
                insightsGenerationStartedAt={insightsData.generationStartedAt}
                insightsError={insightsData.error}
                onRefreshInsights={onRefreshInsights}
                enrichmentActive={enrichmentActive}
                timezone={timezone}
              />
            )}
          </div>

          {aiAvailable && bannerState && (
            <QuickTakeBanner
              title={bannerState.title}
              quickTakeText={bannerState.quickTakeText}
              loading={bannerState.loading}
              enrichment={bannerState.enrichment}
              timezone={timezone}
              onDismiss={onQuickTakeDismiss}
              onViewTask={onQuickTakeViewTask}
            />
          )}

          {/* §7.3: the front door is "Today", but the corpus stays reachable. */}
          <div className="mb-3 flex items-center justify-between gap-2">
            <ViewModeToggle grouping={grouping} onChange={onGroupingChange} />
          </div>

          <FilterBar
            tasks={allTasks}
            expanded={filtersExpanded}
            onToggleExpanded={onToggleFilters}
            activeFilterCount={activeFilterCount}
            selectedPriorities={selectedPriorities}
            selectedLabels={selectedLabels}
            selectedDateFilters={selectedDateFilters}
            onTogglePriority={onTogglePriority}
            onExclusivePriority={onExclusivePriority}
            onToggleLabel={onToggleLabel}
            onExclusiveLabel={onExclusiveLabel}
            onToggleDateFilter={onToggleDateFilter}
            onExclusiveDateFilter={onExclusiveDateFilter}
            attributeFilters={attributeFilters}
            onToggleAttribute={onToggleAttribute}
            onExclusiveAttribute={onExclusiveAttribute}
            projects={projects}
            selectedProjects={selectedProjects}
            onToggleProject={onToggleProject}
            onExclusiveProject={onExclusiveProject}
            excludedPriorities={excludedPriorities}
            excludedLabels={excludedLabels}
            excludedDateFilters={excludedDateFilters}
            excludedAttributes={excludedAttributes}
            excludedProjects={excludedProjects}
            onExcludePriority={onExcludePriority}
            onExcludeLabel={onExcludeLabel}
            onExcludeDateFilter={onExcludeDateFilter}
            onExcludeAttribute={onExcludeAttribute}
            onExcludeProject={onExcludeProject}
            todayCounts={todayCounts}
            timezone={timezone}
            aiAvailable={aiAvailable}
            aiMode={aiMode}
            aiInsightsCount={aiInsights.hasData ? aiInsights.aiTaskIds.size : undefined}
            aiFilterActive={aiFilterActive}
            aiFilterLoading={aiInsights.loading}
            onToggleAiFilter={onToggleAiFilter}
            insightsActive={showInsights}
            onToggleInsights={onToggleInsights}
            hasInsightsData={insightsData.hasResults}
            insightsGenerating={insightsData.generating}
            insightsSignalChipsVisible={insightsSignalChips}
            signalChips={
              aiMode !== 'off' && insightsData.hasResults
                ? insightsData.activeSignals.map((s) => ({
                    key: s.key,
                    label: s.label,
                    count: insightsData.signalCounts[s.key] || 0,
                    description: s.description,
                  }))
                : undefined
            }
            selectedSignals={selectedSignals}
            onSignalClick={onSignalClick}
            onSignalLongPress={onSignalLongPress}
          />

          {searchQuery && (
            <div className="mb-4 text-sm text-zinc-500">
              {searchResultCount} result{searchResultCount !== 1 ? 's' : ''} for &ldquo;
              {searchQuery}&rdquo;
            </div>
          )}

          {anyFilterActive && (
            <div className="text-muted-foreground mb-4 rounded-md bg-blue-50 px-3 py-2 text-sm dark:bg-blue-950/30">
              Showing {tasks.length} of {allTasks.length} tasks{' '}
              <span className="mx-1">&middot;</span>
              <button
                onClick={onClearFilters}
                className="text-foreground font-medium hover:underline"
              >
                Clear filter
              </button>
            </div>
          )}
        </div>

        <TrackColumn
          quotaSource={quotaSource}
          twoColumn={twoColumn}
          searching={!!searchQuery}
          onRemindersUndo={actions.handleUndo}
          onRemindersCompleted={actions.bumpUndoCount}
          onTrackUndo={actions.handleUndo}
          onTrackCompleted={actions.bumpUndoCount}
          onTrackRefresh={onTrackRefresh}
          remindersRefreshRef={remindersRefreshRef}
          timeSlots={timeSlots}
          timezone={timezone}
        />

        <div className="min-w-0 xl:col-start-1 xl:row-start-2">
          <TaskList
            tasks={tasks}
            projects={projects}
            grouping={grouping}
            timeSlots={timeSlots}
            highlightTaskId={highlightTaskId}
            onHighlightDone={onHighlightDone}
            onDone={actions.handleDone}
            onSnooze={actions.handleSnooze}
            onLabelClick={onToggleLabel}
            onTaskFocus={onTaskFocus}
            keyboardFocusedId={keyboardFocusedId}
            isKeyboardActive={isKeyboardActive}
            onKeyDown={onKeyDown}
            onListFocus={onListFocus}
            onListBlur={onListBlur}
            sortOption={sortOption}
            reversed={reversed}
            setSortOption={setSortOption}
            isCollapsed={isCollapsed}
            toggleCollapse={toggleCollapse}
            onActivate={onActivate}
            onDoubleClick={onDoubleClick}
            annotationMap={effectiveAnnotationMap}
            showAnnotations={showAnnotations}
            wnTaskIds={aiInsights.aiTaskIds}
            showWnHighlight={showWnHighlight}
            onReprocess={onReprocess}
            insightsScoreMap={
              showInsights && aiMode !== 'off' ? insightsData.insightsScoreMap : undefined
            }
            insightsSignalMap={
              showInsights && aiMode !== 'off' ? insightsData.insightsSignalMap : undefined
            }
            insightsCommentaryMap={
              effectiveCommentaryMap.size > 0 ? effectiveCommentaryMap : undefined
            }
            showAiInsights={insightsData.hasResults && aiMode !== 'off' && showInsights}
            aiScoreDisabled={!showInsights || aiMode === 'off'}
            headerLeft={
              tasks.length > 0 ? (
                <button
                  onClick={() => {
                    const allSelected =
                      tasks.length > 0 && tasks.every((t) => selection.selectedIds.has(t.id))
                    if (allSelected) {
                      selection.clear()
                    } else {
                      selection.selectAll(tasks.map((t) => t.id))
                    }
                  }}
                  className="text-muted-foreground hover:text-foreground text-xs transition-colors"
                >
                  {tasks.length > 0 && tasks.every((t) => selection.selectedIds.has(t.id))
                    ? 'Select None'
                    : 'Select All'}
                </button>
              ) : undefined
            }
            onUnifiedChange={onUnifiedChange}
          />
        </div>
      </main>

      <SelectionActionSheet
        selectedCount={selection.selectedIds.size}
        selectedTasks={selectedTasks}
        sheetOpenRef={bulkSheetOpenRef}
        onDone={onBulkDone}
        onSaveAll={onBulkSaveAll}
        onDelete={onBulkDelete}
        onMoveToProject={() => onShowProjectPicker(true)}
        onClear={selection.clear}
        onNavigateToDetail={onNavigateToDetail}
        projects={projects}
      />

      <SnoozeAllFab
        overdueCount={overdueCount}
        isSelectionMode={selection.isSelectionMode}
        onSnoozeOverdue={onSnoozeOverdue}
      />

      {showProjectPicker && (
        <ProjectPickerSheet
          projects={projects}
          onSelect={onBulkMoveToProject}
          onClose={() => onShowProjectPicker(false)}
        />
      )}

      <QuickActionPopover
        focusedTask={focusedTask}
        open={quickActionOpen}
        onClose={onQuickActionClose}
        onSaveAll={onQuickActionSaveAll}
        onDelete={onQuickActionDelete}
        onMarkDone={onQuickActionDone}
        onNavigateToDetail={onQuickActionNavigate}
        projects={projects}
        annotation={focusedTask ? effectiveAnnotationMap.get(focusedTask.id) : undefined}
        insightsCommentary={focusedTask ? effectiveCommentaryMap.get(focusedTask.id) : undefined}
      />

      <KeyboardShortcutsDialog
        open={showShortcutsDialog}
        onOpenChange={onShortcutsDialogChange}
        onCloseAutoFocus={onShortcutsDialogCloseAutoFocus}
      />
    </div>
  )
}
