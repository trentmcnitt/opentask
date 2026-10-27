'use client'

import { OVERDUE_WORD, OVERDUE_LOWER } from '@/lib/task-model-words'
import { useState, useEffect, useCallback, useMemo, useRef, Suspense } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter, useSearchParams } from 'next/navigation'
import { TaskList } from '@/components/TaskList'
import {
  applyNowFolds,
  buildTaskGroups,
  effectiveSort,
  nowFoldKey,
  orderedTaskIds,
  sortTaskGroups,
  withDeckSection,
  type SortOption,
  type SortedTaskGroup,
} from '@/lib/task-grouping'
import { useNowFolds } from '@/hooks/useNowFolds'
import { inDeckSection, isRelevantNow } from '@/lib/now-view'
import { NowSummary, type NowSummaryState } from '@/components/NowSummary'
import type { GroupingMode } from '@/lib/grouping'
import { resolveTaskLink, missingTaskMessage } from '@/lib/task-link'
import { useTimeSlots } from '@/hooks/useTimeSlots'
import { useJustAddedClock } from '@/hooks/useJustAddedClock'
import { useStickyColumn } from '@/hooks/useStickyColumn'
import { isTracked } from '@/lib/track'
import { publishTaskCounts } from '@/hooks/useTaskNavCounts'
import { TrackPanel } from '@/components/TrackPanel'
import { DashboardRemindersPanel } from '@/components/DashboardRemindersPanel'
import { ViewModeToggle } from '@/components/ViewModeToggle'
import type { TimeSlot } from '@/lib/time-slot-assign'
import { useCollapsedGroups } from '@/hooks/useCollapsedGroups'
import { useKeyboardNavigation } from '@/hooks/useKeyboardNavigation'
import { useTimezone } from '@/hooks/useTimezone'
import { Header, type HeaderPillFilter } from '@/components/Header'
import { FOCUS_QUICK_ADD_EVENT, QUICK_ADD_ACTION, QuickAdd } from '@/components/QuickAdd'
import { JustAddedCard } from '@/components/JustAddedCard'
import { justAddedEntryKey, selectJustAddedEntries } from '@/lib/just-added'
import { DemoTour } from '@/components/DemoTour'
import { QuickTakeBanner } from '@/components/QuickTakeBanner'
import { FilterBar } from '@/components/FilterBar'
import { AiControlArea } from '@/components/AiControlArea'
import { SelectionProvider, useSelection } from '@/components/SelectionProvider'
import { SelectionActionSheet } from '@/components/SelectionActionSheet'
import { SnoozeOverdueTrigger } from '@/components/SnoozeOverdueTrigger'
import { OverdueJumpFab } from '@/components/OverdueJumpFab'
import { JumpToTasksFab } from '@/components/JumpToTasksFab'
import { ViewModeFab } from '@/components/ViewModeFab'
import { DashboardFabStack } from '@/components/DashboardFabStack'
import { useQuickActionShortcut } from '@/hooks/useQuickActionShortcut'
import {
  showToast,
  showSaveError,
  showSuccessToastWithAction,
  showAiSuccessToastWithAction,
} from '@/lib/toast'
import dynamic from 'next/dynamic'

const QuickActionPopover = dynamic(() =>
  import('@/components/QuickActionPopover').then((mod) => ({ default: mod.QuickActionPopover })),
)
const KeyboardShortcutsDialog = dynamic(() =>
  import('@/components/KeyboardShortcutsDialog').then((mod) => ({
    default: mod.KeyboardShortcutsDialog,
  })),
)

import {
  useSnoozePreferences,
  useDefaultGrouping,
  useDefaultSort,
  useAiAvailable,
  useAiPreferences,
  useAiUnshelved,
  useTaskQueue,
  useDayStart,
} from '@/components/PreferencesProvider'
import { useProjects } from '@/components/ProjectsProvider'
import type { Task, Project } from '@/types'
import type { QuickActionPanelChanges } from '@/components/QuickActionPanel'
import { saveQuickPanelChanges } from '@/lib/save-quick-panel-changes'
import { runSkipUntil } from '@/lib/skip-until'
import { useTaskActions } from '@/hooks/useTaskActions'
import type { ListTaskActionsReturn } from '@/hooks/useTaskActions'
import { useUndoRedoShortcuts } from '@/hooks/useUndoRedoShortcuts'
import { useFilterState, type TaskFilterCriteria } from '@/hooks/useFilterState'
import { useJumpToTaskList } from '@/hooks/useJumpToTaskList'
import { useFilterSection } from '@/hooks/useFilterSection'
import { useTaskCounts, useDateFacetCounts } from '@/hooks/useTaskCounts'
import { useDashboardNow, useAutoClearOverdueFilter } from '@/hooks/useDashboardNow'
import { useSnoozeOverdue } from '@/hooks/useSnoozeOverdue'
import type { DueDateFilter } from '@/components/DueDateFilterBar'
import { cn, taskWord } from '@/lib/utils'
import { useAiInsights, type UseAiInsightsReturn } from '@/hooks/useAiInsights'
import { useAiMode, type AiMode } from '@/hooks/useAiMode'
import { useInsightsData, type UseInsightsDataReturn } from '@/hooks/useInsightsData'
import { useDashboardKeyboard } from '@/hooks/useDashboardKeyboard'
import { useExitModes } from '@/hooks/useExitModes'
import { useSyncStream } from '@/hooks/useSyncStream'
import { loginUrlFromLocation } from '@/lib/login-redirect'
import { createLatestRequestGuard } from '@/lib/refresh-guards'
import { NAV_FILTER_EVENT, type NavFilter } from '@/lib/nav-filter'
import {
  activePending,
  addPending,
  applyRowChanges,
  dropPending,
  nextPendingToken,
  settlePending,
  type PendingMap,
  type RowChange,
  type RowPending,
} from '@/lib/pending-overlay'
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

  // Overlapping fetches (a focus refresh and a sync-event refresh, say) can
  // resolve out of order; only the most recently STARTED one may set state,
  // so an older payload never overwrites a newer one.
  const [requestGuard] = useState(createLatestRequestGuard)
  /**
   * Each row tap's change (done, defer, deck, a save), drawn over every
   * payload until one requested after its write answered lands
   * (`src/lib/pending-overlay.ts`, 2026-10-26). Without it a refresh started
   * before the next tap's write — landing after that tap took its row off —
   * put the row back for a moment, and a quick next tap hit it.
   */
  const pendingRef = useRef<PendingMap<number, RowChange<Task>>>(new Map())
  const pending = useMemo<RowPending<Task>>(
    () => ({
      add(id, change) {
        const token = nextPendingToken()
        // A factory: a row change is itself a function.
        pendingRef.current = addPending(pendingRef.current, [id], () => change, token)
        return token
      },
      settle(id, token) {
        pendingRef.current = settlePending(pendingRef.current, [id], token, requestGuard.latest())
      },
      drop(id, token) {
        pendingRef.current = dropPending(pendingRef.current, [id], token)
      },
    }),
    [requestGuard],
  )

  const fetchTasks = useCallback(async () => {
    const seq = requestGuard.begin()
    try {
      const res = await fetch('/api/tasks?limit=1000')
      if (res.status === 401) {
        router.push(loginUrlFromLocation())
        return
      }
      if (!res.ok) throw new Error('Failed to fetch tasks')
      const data = await res.json()
      if (!requestGuard.isLatest(seq)) return
      const changes = activePending(pendingRef.current, seq)
      setTasks(applyRowChanges<Task>(data.data?.tasks || [], changes))
      setError(null)
    } catch (err) {
      if (!requestGuard.isLatest(seq)) return
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [router, requestGuard])

  return {
    tasks,
    setTasks,
    pending,
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
  pending: RowPending<Task>,
  onViewTask: (task: Task) => void,
  onCreated?: (task: Task) => void,
): ListTaskActionsReturn & { handleQuickAdd: (title: string) => Promise<number | null> } {
  const actions = useTaskActions({
    mode: 'list',
    onRefresh: fetchTasks,
    tasks,
    setTasks,
    pending,
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
  setSearchQuery: (q: string | null) => void,
  setSearchResults: React.Dispatch<React.SetStateAction<Task[]>>,
) {
  // Completing several tasks at once: the floating selection action bar's
  // Done (`bulkDone`, which clears the selection) and keyboard Cmd+D on a
  // multi-selection (`useKeyboardNavigation` clears the selection itself, so
  // it passes `clearSelection: false`). `completeMany` and `bulkDelete` are the
  // only remaining direct bulk endpoint calls from the dashboard — all
  // panel-driven mutations (date, priority, labels, project, recurrence) flow
  // through `bulkSaveAll` → `saveQuickPanelChanges`, which keeps the mobile
  // selection sheet and the desktop quick-action popover on exactly one save
  // path.
  const completeMany = useCallback(
    async (ids: number[], { clearSelection }: { clearSelection: boolean }) => {
      const count = ids.length
      try {
        const res = await fetch('/api/tasks/bulk/done', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids }),
        })
        if (!res.ok) throw new Error('Bulk action failed')
        if (clearSelection) selection.clear()
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
    },
    [selection, bumpUndoCount, fetchTasks, handleUndo],
  )

  const bulkDone = () => completeMany([...selection.selectedIds], { clearSelection: true })

  /**
   * Unified save path for the SelectionActionSheet. Routes single-task saves
   * through PATCH /api/tasks/:id and multi-task saves through ONE bulk
   * request (with `include_task_ids` so explicit selections bypass the
   * server's P3/P4 (High/Urgent) skip filter) — see `planQuickPanelSave`.
   *
   * `dateTaskIds` scopes the date part of the change to a subset of the
   * selection — used when the snooze confirmation dialog opts some tasks out
   * of the date change. Non-date fields still apply to the full selection, in
   * the same request, so the whole save is one Undo (Trent, 2026-09-27).
   *
   * A failure toasts the server's reason and rejects, so the sheet stays open
   * with the staged edits and the selection intact (SelectionActionSheet
   * closes and clears only after this resolves).
   */
  const bulkSaveAll = async (changes: QuickActionPanelChanges, dateTaskIds?: number[]) => {
    const allIds = [...selection.selectedIds]
    if (allIds.length === 0) return
    try {
      const result = await saveQuickPanelChanges(allIds, changes, dateTaskIds)
      bumpUndoCount()
      fetchTasks()
      // A task held back by a passed deadline (the High tier, 2026-10-12) is
      // never skipped silently. Explicit picks (`include_task_ids`) are not
      // held, so this is rare here; the wording matches the sweep toast.
      const kept = result.skippedDeadline
        ? ` · ${result.skippedDeadline} past deadline skipped`
        : ''
      showToast({
        message:
          (result.description ||
            `${result.tasksAffected} ${taskWord(result.tasksAffected)} updated`) + kept,
        type: 'success',
        action: { label: 'Undo', onClick: handleUndo },
      })
    } catch (err) {
      showSaveError(err)
      throw err
    }
  }

  const bulkDelete = async () => {
    const count = selection.selectedIds.size
    try {
      const res = await fetch('/api/tasks/bulk/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [...selection.selectedIds] }),
      })
      if (!res.ok) throw new Error('Delete failed')
      // The search hit set is deliberately NOT trimmed here: the refetch drops
      // the rows from `tasks`, which drops them from the results, and leaving
      // the ids in place is what lets Undo bring them back. See
      // `visibleSearchResults`.
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

  /**
   * Skip until (task queue PR 4) — the selection sheet's button and the quick
   * popover's More menu. The server skips the repeating tasks and counts the
   * rest; the toast says both, with Undo when anything moved.
   */
  const skipUntil = async (ids: number[], until: string | null) => {
    await runSkipUntil(ids, until, {
      onUndo: handleUndo,
      afterSkip: (result) => {
        if (result.tasks_affected > 0) bumpUndoCount()
        fetchTasks()
      },
    })
  }

  return { completeMany, bulkDone, bulkSaveAll, bulkDelete, skipUntil, handleSearch }
}

/**
 * The toast for a notification tap whose task has no row to show: done, in
 * the trash, or gone. One `GET` for the wording; any failure (a 404, someone
 * else's task, offline) reads as "no longer exists".
 */
async function toastForUnshownTask(taskId: number): Promise<void> {
  let task: Task | null = null
  try {
    const res = await fetch(`/api/tasks/${taskId}`)
    if (res.ok) task = (await res.json()).data as Task
  } catch {
    // Network failure: the generic wording below.
  }
  showToast({ message: missingTaskMessage(task) })
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
  const { timeSlots, refresh: refreshTimeSlots } = useTimeSlots(initialTimeSlots)
  const data = useFetchData(router, initialTasks)
  const {
    tasks,
    setTasks,
    pending,
    loading: tasksLoading,
    error,
    setError,
    setLoading,
    fetchTasks,
  } = data
  const { projects, projectsLoaded, refreshProjects } = useProjects()
  // The page counts as loading until the projects are in too: All names each
  // group after its project, and a notification link unfolds a group by that
  // name, so rendering before the projects arrive would show "Project 12"
  // headings for a moment and could unfold the wrong group.
  const loading = tasksLoading || !projectsLoaded
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
    // Slots too: a Settings edit to a reminder period emits a sync event.
    onSync: () => {
      void refreshAll()
      void refreshTimeSlots()
    },
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
  // A task added into a project group the user has collapsed stays there
  // folded; the Just now card lists it, and a tap on that entry opens the
  // group (and Now's fold) to show it.
  const { isCollapsed, toggleCollapse, expand } = useCollapsedGroups()
  // `?task=<id>&highlight=1` — the widget's task deep link. Mirrors
  // RemindersView's `highlightId`/`clearHighlight`; see the `?task=` effect
  // below for the full rationale.
  const [highlightTaskId, setHighlightTaskId] = useState<number | null>(null)
  const clearHighlight = useCallback(() => setHighlightTaskId(null), [])
  const actions = useDashboardActions(refreshAll, tasks, setTasks, pending, handleViewTask)

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
        // No trim of the search hit set — see `bulkDelete` and `visibleSearchResults`.
        refreshAll()
        // The delete is an undo entry like any other, so the top bar's undo
        // badge counts it (this was the one dashboard action that didn't).
        actions.bumpUndoCount()
        showToast({
          message: 'Task moved to trash',
          type: 'success',
          action: { label: 'Undo', onClick: actions.handleUndo },
        })
      } catch {
        showToast({ message: 'Delete failed', type: 'error' })
      }
    },
    [refreshAll, actions],
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
  const { defaultSnoozeOption, bulkSnoozeDefault, morningTime } = useSnoozePreferences()

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

  // SHELVED (2026-10-22; src/core/ai/shelved.ts): What's Next, Insights and
  // Quick Take are shelved unless the server runs with OPENTASK_AI_UNSHELVE=1.
  // Shelved, this dashboard READS every one of their preferences as off — the
  // AI mode, the Insights chip, a saved AI Score sort — and hides their UI,
  // but never writes a preference: each user's saved values come back as they
  // were when the switch is turned on.
  const aiUnshelved = useAiUnshelved()

  // Sort state — persisted via PreferencesProvider (single source of truth)
  const {
    defaultSort: savedSort,
    defaultSortReversed: reversed,
    setSortPreference,
  } = useDefaultSort()
  // The AI Score sort needs Insights scores: shelved, a saved 'ai_insights'
  // reads as the default sort (not rewritten — see `aiUnshelved` above).
  const sortOption: SortOption = !aiUnshelved && savedSort === 'ai_insights' ? 'horizon' : savedSort
  const setSortOption = useCallback(
    (option: SortOption) => {
      const newReversed = sortOption === option ? !reversed : false
      setSortPreference(option, newReversed)
    },
    [sortOption, reversed, setSortPreference],
  )
  const { defaultGrouping, setDefaultGrouping, groupingLoaded } = useDefaultGrouping()

  // AI sort auto-switches to unified as a local override (not persisted to DB).
  // This preserves the user's real grouping preference for when AI sort is disabled.
  const [aiSortUnified, setAiSortUnified] = useState(false)
  const grouping: GroupingMode = aiSortUnified ? 'unified' : defaultGrouping
  // Now's "Show all" (`src/lib/now-view.ts`): lifts every fold for the visit.
  // Plain state, not saved — the next load (and the Dashboard tab) is Now again.
  const [nowShowAll, setNowShowAll] = useState(false)
  // Which project folds are open: per project, for the browser session.
  const { isFoldOpen, toggleFold, openFold } = useNowFolds()
  // The order the list is DRAWN in: New pins newest-added first over the saved
  // sort (`effectiveSort`). Keyboard order and the group math below use this;
  // the sort dropdown and the saved preference keep `sortOption`/`reversed`.
  const { sortOption: listSort, reversed: listReversed } = effectiveSort(
    grouping,
    sortOption,
    reversed,
  )

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
  // The page's one clock: every overdue/today count, filter and group below
  // reads THIS instant, and it advances exactly when a task crosses its due
  // time (or at midnight, or when the app comes back to the foreground) — see
  // `src/lib/dashboard-clock.ts`. Reminders and quotas are never overdue, so
  // `visibleTasks` is the population whose due times matter.
  const now = useDashboardNow(visibleTasks, timezone)
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
   *
   * NOTHING BUT A NEW SEARCH (OR CLEARING ONE) WRITES `searchResults`. The two
   * delete handlers used to trim it as well, and that trim is what broke Undo:
   * the restored task came back into `tasks`, but its id was no longer a hit,
   * so it stayed missing from the results until the query was re-run. Every
   * other mutation already relied on the derivation alone; delete now does too.
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

  // `?filter=overdue` — the dashboard filtered to the Overdue chip. Two callers:
  // the overdue Web Push (`overdue-checker.ts`) and the iOS/macOS Tasks
  // widget's header while it shows its Overdue page (`opentask://overdue`,
  // `handleWidgetLink`). Both arrive as a FULL page load (WKWebView `load`,
  // the service worker's `client.navigate`), so the param only has to seed
  // the initial state of the ordinary date-filter chips — the same state the
  // Overdue chip toggles, not a parallel one. The pinned Overdue chip in the
  // control row turns solid red and the "Showing N of M · Clear filter" banner
  // shows, so the filter is visibly on and one tap clears it. (Since
  // 2026-09-26 an Overdue selection no longer auto-expands the chip section —
  // the pinned chip already shows it; see `hiddenActiveFilterCount` in
  // `DashboardView`. `?filter=today`, the today pill's fallback link, still
  // expands it.)
  //
  // Applied ONCE per mount: the ref stops a later render from re-seeding it,
  // and the param is stripped from the URL straight away, so a reload after
  // "Clear filter" stays cleared. Date filters are session state (never
  // written to preferences), so nothing about this outlives the page.
  //
  // Strip with a raw history rewrite, NOT router.replace — same reason as the
  // `?project=` and `?task=` effects below: a router navigation issues an RSC
  // fetch, and losing that race (WebKit especially — the widget's path)
  // remounts this component with a fresh ref and a URL that no longer carries
  // the param, so the filter never visibly applied.
  const filterParamProcessed = useRef(false)
  const initialDateFilters = useMemo(() => {
    if (filterParamProcessed.current) return undefined
    filterParamProcessed.current = true
    const filter = searchParams.get('filter')
    // `today`: the top bar's today pill's fallback link (Header's
    // `TaskCountBadges`), same once-per-mount seeding as `overdue`.
    if (filter === 'overdue' || filter === 'today') return [filter] as DueDateFilter[]
    return undefined
  }, [searchParams])
  useEffect(() => {
    if (searchParams.get('filter')) {
      window.history.replaceState(window.history.state, '', window.location.pathname)
    }
  }, [searchParams])

  useFocusQuickAddOnArrival(status, loading, error)

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
    deselectDateFilter,
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
    criteria: filterCriteria,
    activeFilterCount,
  } = useFilterState({
    tasks: baseTasks,
    onLabelToggle,
    timezone,
    now,
    initialDateFilters,
  })

  // Support ?project=<id> from sidebar/project list links AND the widget's
  // dashboard-header deep link (`WidgetLink`-style, ios/AGENTS.md) — set the
  // project filter exclusively, scroll to top, then clear the URL.
  // Uses useEffect (not useMemo+ref) because sidebar links navigate within the already-mounted dashboard.
  //
  // `setSelectedProjects([projectId])` (not `exclusiveProject`, which TOGGLES
  // — a second visit to the same link would clear the filter instead of
  // reapplying it) always REPLACES the selection with exactly this one
  // project, which is the exclusive filter useFilterState's other exclusive
  // setters produce. `window.scrollTo` is explicit rather than relying on the
  // browser's own scroll-to-top-on-navigation: this effect also fires from
  // the sidebar link case, where the dashboard is already mounted and may
  // already be scrolled down — a fresh widget-link page load starts at the
  // top regardless, but nothing here can tell the two apart.
  //
  // Strip the param with a raw history rewrite, NOT router.replace: same
  // reason as the `?task=` effect below — a router navigation issues an RSC
  // fetch, and losing that race (found here by a flaky E2E run, not just
  // WebKit) remounts this component and drops the `setSelectedProjects` call
  // this same effect just made, so the filter never visibly applies.
  useEffect(() => {
    const projectParam = searchParams.get('project')
    if (!projectParam) return
    const projectId = parseInt(projectParam, 10)
    if (!isNaN(projectId)) {
      setSelectedProjects([projectId])
      window.scrollTo({ top: 0, behavior: 'smooth' })
    }
    window.history.replaceState(window.history.state, '', window.location.pathname)
  }, [searchParams, setSelectedProjects])

  // AI mode: Off / On toggle + feature preferences
  const {
    mode: savedAiMode,
    setMode: setAiMode,
    showInsights: savedShowInsights,
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
  // Shelved (see `aiUnshelved`): the dashboard's AI mode — which drives only
  // What's Next and Insights — and the Insights chip read as off, so every
  // overlay, chip, score and highlight below stays hidden.
  const aiMode: AiMode = aiUnshelved ? savedAiMode : 'off'
  const showInsights = aiUnshelved && savedShowInsights

  // AI enrichment: true when any task has the ai-to-process label
  const enrichmentActive = tasks.some((t) => t.labels.includes('ai-to-process'))

  // Server-side AI availability flag — gates all AI UI and prevents wasted requests
  const aiAvailable = useAiAvailable()
  const { aiQuickTakeMode } = useAiPreferences()

  // AI What's Next: fetch recommendations and resolve against current task list
  const aiInsights = useAiInsights(baseTasks, aiAvailable && aiUnshelved)

  // AI Insights: fetch/generate insights results
  const insightsData = useInsightsData(baseTasks, aiAvailable && aiUnshelved)

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

  // Sort fallback: if Insights chip off and sorting by AI score, revert to the default
  useEffect(() => {
    if (!showInsights && sortOption === 'ai_insights') {
      setSortOption('horizon')
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

  // Everything that narrows the list — search, filter chips, AI filter and
  // signal chips — and the selection. The dashboard tab's reset below, and a
  // notification tap on a task they hide (the `?task=` effect).
  const clearListNarrowing = useCallback(() => {
    selection.clear()
    setAiFilterActive(false)
    setSelectedSignals([])
    clearAllFilters()
    setSearchQuery(null)
    setSearchResults([])
  }, [selection, clearAllFilters])

  // Full view reset: clears everything including search (triggered by tapping Dashboard tab)
  const handleDashboardReset = useCallback(() => {
    clearListNarrowing()
    setNowShowAll(false)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }, [clearListNarrowing])

  // Build task groups for keyboard navigation.
  const taskGroups = useMemo(
    () => buildTaskGroups(tasks_, projects, grouping),
    [tasks_, projects, grouping],
  )
  /**
   * The top bar's "N total tasks" pill counts what the list holds: every
   * group's tasks. Reminders, quotas, search, filter chips and AI chips are
   * already out of `tasks_`. A collapsed group, a row behind Now's fold, or
   * one past a group's "Show all" preview cap still counts: it is on the page
   * one tap away, and the group says so.
   */
  const shownTaskCount = useMemo(
    () => taskGroups.reduce((n, g) => n + g.tasks.length, 0),
    [taskGroups],
  )

  // Now's folds are on in Now, unless Show all is, or anything narrows the
  // list — search, filter chips, the AI filter or signal chips: the user
  // asked for exactly those rows, and a match behind "+ N more" would read
  // as no match (see `src/lib/now-view.ts`).
  const taskQueue = useTaskQueue()
  const listNarrowed =
    !!searchQuery ||
    activeFilterCount > 0 ||
    (aiMode !== 'off' && (aiFilterActive || selectedSignals.length > 0))
  const nowAvailable = grouping === 'project' && !listNarrowed
  // The task queue switch: with it on, a queued undated High folds (A8).
  const queueOn = taskQueue.enabled
  // Now's options: the switch, and the user's day boundary ("Day starts at"
  // PR 2) — Now's "today", Upcoming's heads-ups, today's decks and the
  // deadlines page's safety net are OpenTask days. One object for every Now rule.
  const dayStart = useDayStart()
  const nowOpts = useMemo(() => ({ queue: queueOn, dayStart }), [queueOn, dayStart])
  // Now's On deck section (D2, `withDeckSection`): today's decks, with the
  // task queue on — part of what Now shows, so part of its count.
  const deckSection = nowAvailable && queueOn
  // "N of M now": the rows relevant now, out of the whole list.
  const nowRelevantCount = useMemo(
    () =>
      nowAvailable
        ? tasks_.filter(
            (t) =>
              (deckSection && inDeckSection(t, timezone, now, nowOpts)) ||
              isRelevantNow(t, timezone, now, nowOpts),
          ).length
        : 0,
    [nowAvailable, deckSection, tasks_, timezone, now, nowOpts],
  )
  // Something is folded. When nothing is (every row relevant, or no rows),
  // there is no fold to lift: the strip hides, and Show all — which would
  // only bring the preview cap back — has no effect.
  const nowHasFolds = nowAvailable && nowRelevantCount < shownTaskCount
  const nowFolds = nowAvailable && !(nowShowAll && nowHasFolds)

  // THE visual order, computed once (`src/lib/task-grouping.ts`): TaskList
  // draws these groups, and the keyboard, shift-click ranges and Cmd+C read
  // the same order — including the AI sort, which needs the score map the
  // rows show, and Now's split (relevant rows, then the fold). Collapsed
  // groups and shut folds drop out of `orderedIds` so navigation skips them.
  const listScoreMap = showInsights && aiMode !== 'off' ? insightsData.insightsScoreMap : undefined
  const sortedGroups = useMemo(() => {
    const sorted = sortTaskGroups(taskGroups, listSort, listReversed, listScoreMap)
    if (!nowFolds) return sorted
    const withDecks = deckSection ? withDeckSection(sorted, timezone, now, nowOpts) : sorted
    return applyNowFolds(withDecks, timezone, now, nowOpts)
  }, [
    taskGroups,
    listSort,
    listReversed,
    listScoreMap,
    nowFolds,
    deckSection,
    timezone,
    now,
    nowOpts,
  ])
  const orderedIds = useMemo(
    () => orderedTaskIds(sortedGroups, isCollapsed, isFoldOpen),
    [sortedGroups, isCollapsed, isFoldOpen],
  )

  /**
   * Support `?task=<id>` — two shapes, sharing one URL:
   *
   * - `?task=<id>` alone: a NOTIFICATION tap — the iPhone and Mac apps
   *   (`WebViewManager.navigateToTask`, i.e. `DeepLinkRouter.notificationTaskPath`)
   *   and every Web Push click (`overdue-checker.ts`, `enrichment-notify.ts`,
   *   `enrichment-failed-notify.ts`, `notifications/test/route.ts`). Brings the row into view, flashes it and
   *   SELECTS it, so the action bar is up for the task the notification was
   *   about. Opens nothing (Trent, 2026-09-29; it used to open the quick
   *   panel). If a search or filter hides the task, that is undone first,
   *   and a row behind Now's fold has its fold opened — see `resolveTaskLink`
   *   (`src/lib/task-link.ts`) for the steps. A reminder goes to `/reminders?reminder=<id>&select=1`, a quota to
   *   `/quotas?quota=<id>`; a task that is done, deleted or gone gets a toast.
   * - `?task=<id>&highlight=1`: the widget's deep link
   *   (`WidgetLink.task`/`OpenTaskApp.handleWidgetLink`). Brings the row into
   *   view and flashes it once; selects nothing, and quietly does nothing if
   *   the current view hides it — mirrors RemindersView's `?reminder=<id>`.
   *
   * WHY THE BARE PARAM CHANGED MEANING rather than a new one being added: every
   * producer of the bare shape is a notification (nothing in the app links to
   * `/?task=` to open an editor), and the installed iPhone and Mac builds load
   * exactly this URL — so the new behavior reached them with a server deploy,
   * no app update. The URL shape is also what the login redirect and
   * dashboardPath() already pass through (`src/lib/login-redirect.ts`,
   * `src/app/page.tsx`).
   *
   * The param is consumed (and stripped from the URL) only once resolution is
   * DEFINITIVE: the task was found and shown, or the list is non-empty and
   * provably doesn't contain it. `loading === false` alone is not proof the
   * list is ready — on WebKit (iOS webview, Safari) the initial fetch can fail
   * transiently during hydration, flipping `loading` false with zero tasks;
   * consuming the param then means a notification tap opens the app but never
   * the task. With an empty list we leave the param in place and let the
   * effect re-run when a retry/sync populates tasks. The notification path
   * also stays unconsumed across its corrective steps (clear the filters,
   * switch the view): each takes a render to land, and this effect re-runs on
   * the new `tasks_`/`taskGroups`.
   */
  const taskParamProcessed = useRef(false)
  const taskLinkTried = useRef({ narrowing: false })
  // Unfold the row's group — and its Now fold, if the row is behind one — and
  // flash it. `TaskList` lifts the group's "Show all" cap for the highlighted
  // row, and `TaskRow` scrolls it into view — the reveal the Just now card's
  // tap uses, minus its quick-panel fallback.
  const revealRow = useCallback(
    (taskId: number, groupLabel: string) => {
      if (isCollapsed(groupLabel)) expand(groupLabel)
      const group = sortedGroups.find((g) => g.label === groupLabel)
      if (group && !group.deck) openFold(nowFoldKey(group))
      setHighlightTaskId(taskId)
    },
    [isCollapsed, expand, sortedGroups, openFold],
  )
  useEffect(() => {
    if (taskParamProcessed.current || loading) return
    const taskIdParam = searchParams.get('task')
    if (!taskIdParam) return
    const taskId = parseInt(taskIdParam, 10)
    // Strip the param with a raw history rewrite, NOT router.replace: a router
    // navigation issues an RSC fetch, and if that fetch fails (WebKit does
    // this under flaky transport) Next falls back to a full page navigation
    // that remounts this component and loses what was just done. Same
    // pattern as AppLayout's ?action=create handling.
    const consume = () => {
      taskParamProcessed.current = true
      window.history.replaceState(window.history.state, '', window.location.pathname)
    }
    if (isNaN(taskId)) return consume()
    if (tasks.length === 0) return
    const step = resolveTaskLink({
      taskId,
      tasks,
      listed: tasks_,
      // The groups as drawn: a task in Now's On deck section is shown there.
      groups: sortedGroups,
      tried: taskLinkTried.current,
    })
    // The row's group depends on the view, and `defaultGrouping` starts at a
    // hardcoded fallback until `PreferencesProvider`'s own fetch resolves (see
    // `useDefaultGrouping`'s doc comment) — resolving against the fallback
    // expanded the wrong group, or switched views for nothing. Found by
    // browser-verifying against Trent's dev account, whose real default
    // (`slot`) differed from the fallback of the day.
    if (!groupingLoaded && step.kind !== 'missing' && step.kind !== 'quota') return

    if (searchParams.get('highlight') === '1') {
      // The widget's link: flash the row if the view shows it, else nothing.
      // §5: a quota's editor is its detail route (the widget links quotas via
      // `/quotas?quota=` anyway; this is the last path to the old one).
      if (step.kind === 'quota') router.push(`/tasks/${step.task.id}`)
      if (step.kind === 'show') revealRow(step.task.id, step.groupLabel)
      return consume()
    }

    switch (step.kind) {
      case 'clear-narrowing':
        taskLinkTried.current.narrowing = true
        clearListNarrowing()
        return
      case 'show':
        revealRow(step.task.id, step.groupLabel)
        // `selectAll([id])`, not `selectOnly`: that one TOGGLES, so a second
        // tap on the same notification would deselect the row.
        selection.selectAll([step.task.id])
        break
      case 'reminder':
        router.push(`/reminders?reminder=${step.task.id}&select=1`)
        break
      case 'quota':
        router.push(`/quotas?quota=${step.task.id}`)
        break
      case 'missing':
        void toastForUnshownTask(taskId)
        break
      case 'unreachable':
        showToast({ message: `Couldn’t show “${step.task.title}”` })
        break
    }
    consume()
  }, [
    searchParams,
    loading,
    tasks,
    tasks_,
    sortedGroups,
    grouping,
    router,
    revealRow,
    groupingLoaded,
    selection,
    clearListNarrowing,
  ])

  // Just now (`src/lib/just-added.ts`): each task created — or targeted from
  // a task segment — in the last 15 minutes is listed in the Just now card
  // under the add field, and its real row wears a "New" (or "Targeted") tag. Drawn from `visibleTasks` — unfiltered on
  // purpose — and off while searching. The clock advances itself at each
  // minute and age-out, so entries count up and leave without a reload. The
  // card is not part of the list: nothing here (keyboard order, counts,
  // Select All) sees it.
  const justAddedNow = useJustAddedClock(visibleTasks)
  const justAddedSource = searchQuery ? null : visibleTasks

  // Shutting a fold deselects the rows it hides, as collapsing a group does.
  const handleToggleFold = useCallback(
    (key: string) => {
      if (isFoldOpen(key) && selection.isSelectionMode) {
        const group = sortedGroups.find((g) => nowFoldKey(g) === key)
        if (group?.now) selection.removeAll(group.now.more.map((t) => t.id))
      }
      toggleFold(key)
    },
    [isFoldOpen, toggleFold, sortedGroups, selection],
  )

  // Wrap toggleCollapse to deselect tasks in a group when collapsing it
  const handleToggleCollapse = useCallback(
    (label: string) => {
      if (!isCollapsed(label)) {
        // About to collapse — deselect tasks in this group
        const group = sortedGroups.find((g) => g.label === label)
        if (group && selection.isSelectionMode) {
          const groupIds = group.tasks.map((t) => t.id)
          selection.removeAll(groupIds)
        }
      }
      toggleCollapse(label)
    },
    [isCollapsed, toggleCollapse, sortedGroups, selection],
  )

  const bulk = useBulkActions(
    selection,
    refreshAll,
    actions.handleUndo,
    actions.bumpUndoCount,
    setSearchQuery,
    setSearchResults,
  )

  // Keyboard completion handler (Cmd+D): one task goes through the same
  // `handleDone` as a row's checkbox; several go through the selection bar's
  // bulk path. `useKeyboardNavigation` clears the selection itself.
  const { completeMany } = bulk
  const handleKeyboardComplete = useCallback(
    async (taskIds: number[]) => {
      if (taskIds.length === 0) return
      if (taskIds.length === 1) {
        await actions.handleDone(taskIds[0])
      } else {
        await completeMany(taskIds, { clearSelection: false })
      }
    },
    [actions, completeMany],
  )

  // Keyboard navigation hook - disabled when sheets/dialogs are open
  const keyboardNavEnabled = !quickActionOpen && !showShortcutsDialog && !createPanelOpen
  const keyboard = useKeyboardNavigation({
    orderedIds,
    // The groups as drawn, Now's On deck section included.
    groups: sortedGroups,
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

  // Compute selected tasks for bulk operations (the action bar and the Defer
  // button). Reads `visibleTasks`, not the raw corpus: the selection can only
  // ever hold ids of rendered rows, and resolving it against rows this page
  // deliberately hides would let a reminder or a quota reach a bulk action.
  const selectedTasks = useMemo(() => {
    return visibleTasks.filter((t) => selection.selectedIds.has(t.id))
  }, [visibleTasks, selection.selectedIds])

  // The Defer button (clock and FAB): the selection when there is one, every
  // overdue task otherwise — see `useSnoozeOverdue`.
  const { snoozeOverdue: handleSnoozeAllOverdue, snoozeSelected: handleSnoozeSelected } =
    useSnoozeOverdue({
      displayTasks,
      selectedTasks,
      onSelectedDone: selection.clear,
      fetchTasks: refreshAll,
      handleUndo: actions.handleUndo,
      onUndoCountBump: actions.bumpUndoCount,
      timezone,
      defaultSnoozeOption,
      bulkSnoozeDefault,
      timeSlots,
      morningTime,
    })

  // Global keyboard shortcuts (extracted to hook)
  useDashboardKeyboard({
    keyboard,
    keyboardNavEnabled,
    orderedIds,
    keyboardFocusedId,
    setKeyboardFocusedId,
    selection,
    sortedGroups,
    sortOption: listSort,
    reversed: listReversed,
    timezone,
    projects,
    annotationMap: effectiveAnnotationMap,
    showAnnotations,
    setShowShortcutsDialog,
    searchFocusRef,
    onDeleteTask: handleQuickActionDelete,
    onBulkDelete: bulk.bulkDelete,
  })

  // The tab title and the PWA dock badge count the list as it stands (every
  // filter applied). The top bar's pills count something else on purpose —
  // see `useDateFacetCounts` in `DashboardView`.
  const { overdueCount } = useTaskCounts(tasks_, timezone, now)
  // The snooze-all clock and FAB count what a press sweeps: `displayTasks`,
  // the list `useSnoozeOverdue` acts on (no What's Next / signal filter), with
  // the same `isOverdue`. Counting anything else made the badge and the
  // "Deferred N" toast disagree.
  const { overdueCount: sweepOverdueCount } = useTaskCounts(displayTasks, timezone, now)
  // The nav's Tasks badges read a shared cache; this page is its source of
  // truth. Published from the unfiltered list (reminders excluded, nothing
  // else): a filter chip changes the view, not what is due.
  const navCounts = useTaskCounts(visibleTasks, timezone, now)
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

  // Cmd+S: the selection, then the keyboard-focused row, then the hovered row
  // (see the hook for why the order matters).
  useQuickActionShortcut(focusedTask, setQuickActionOpen, quickActionOpen, {
    isSelectionMode: selection.isSelectionMode,
    selectedCount: selection.selectedIds.size,
    openBulkSheet: () => bulkSheetOpenRef.current?.(),
    getKeyboardFocusedTask: () => {
      if (!keyboard.isKeyboardActive || keyboardFocusedId === null) return null
      return visibleTasks.find((t) => t.id === keyboardFocusedId) ?? null
    },
    setFocusedTask,
  })

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

  // Quick Take is shelved with What's Next and Insights (`aiUnshelved`):
  // shelved, a quick add is the plain create — the same path as Quick Take
  // set to Off. Enrichment is untouched either way: the server queues it on
  // create, and its result arrives over the sync stream (`onEnrichmentComplete`).
  const quickAdd =
    aiAvailable && aiUnshelved && aiQuickTakeMode !== 'off'
      ? handleQuickAddWithQuickTake
      : actions.handleQuickAdd

  return (
    <>
      <DemoTour />
      <DashboardView
        tasks={tasks_}
        sortedGroups={sortedGroups}
        orderedIds={orderedIds}
        allTasks={baseTasks}
        quotaSource={tasks}
        projects={projects}
        grouping={grouping}
        highlightTaskId={highlightTaskId}
        onHighlightDone={clearHighlight}
        justAddedSource={justAddedSource}
        justAddedNow={justAddedNow}
        onGroupingChange={(next) => {
          // Selecting a view explicitly turns off AI-sort's unified override —
          // otherwise the toggle would show a selection that isn't in effect.
          // Picking Now (even again) puts its folds back.
          setAiSortUnified(false)
          setNowShowAll(false)
          setDefaultGrouping(next)
        }}
        nowSummary={
          nowHasFolds
            ? {
                relevant: nowRelevantCount,
                total: shownTaskCount,
                showAll: nowShowAll,
                onShowAllChange: setNowShowAll,
              }
            : null
        }
        isFoldOpen={isFoldOpen}
        onToggleFold={handleToggleFold}
        timeSlots={timeSlots}
        searchQuery={searchQuery}
        searchHits={searchResults}
        searchResultCount={visibleSearchResults.length}
        shownTaskCount={shownTaskCount}
        sweepOverdueCount={sweepOverdueCount}
        selection={selection}
        selectedTasks={selectedTasks}
        actions={actions}
        selectedLabels={selectedLabels}
        onToggleLabel={toggleLabel}
        onClearFilters={handleClearFilters}
        selectedPriorities={selectedPriorities}
        onTogglePriority={togglePriority}
        onExclusivePriority={exclusivePriority}
        selectedDateFilters={selectedDateFilters}
        onToggleDateFilter={toggleDateFilter}
        onDeselectDateFilter={deselectDateFilter}
        onExclusiveDateFilter={exclusiveDateFilter}
        now={now}
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
        filterCriteria={filterCriteria}
        activeFilterCount={activeFilterCount}
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
        onSkipUntil={bulk.skipUntil}
        onSnoozeOverdue={handleSnoozeAllOverdue}
        onSnoozeSelected={handleSnoozeSelected}
        focusedTask={focusedTask}
        quickActionOpen={quickActionOpen}
        onTaskFocus={setFocusedTask}
        onQuickActionClose={() => setQuickActionOpen(false)}
        onQuickActionSaveAll={actions.handleSaveAllChanges}
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
        onQuickAdd={quickAdd}
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
            // Manual unified off: restore previous grouping. With nothing to
            // restore (Unified was the saved view on load), land on Now — the
            // grouped view.
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
/**
 * `?action=quick-add`: the phone `+` tab pressed on another page (see
 * `AppLayout`'s `handleAddTabClick`). Waits for the data to load, because the
 * add field isn't mounted until then; the field's listener is registered by
 * the time this runs (a child's effects run before its parent's). The param
 * is stripped with a raw history rewrite, like `?filter=`.
 */
function useFocusQuickAddOnArrival(status: string, loading: boolean, error: string | null) {
  const searchParams = useSearchParams()
  const ready = status === 'authenticated' && !loading && !error
  // Once per mount, so a later reload of the data (Retry) can't focus it again.
  const handled = useRef(false)
  useEffect(() => {
    if (handled.current || !ready || searchParams.get('action') !== QUICK_ADD_ACTION) return
    handled.current = true
    window.history.replaceState(window.history.state, '', window.location.pathname)
    window.dispatchEvent(new CustomEvent(FOCUS_QUICK_ADD_EVENT))
  }, [ready, searchParams])
}

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
 * header. The column never scrolls on its own — no height cap, no inner
 * scrollbar ("It can't have two scrollbars shown", Trent 09-28); instead
 * `useStickyColumn` lowers `top` when the column is taller than the viewport,
 * so it rides the page scroll until its bottom is in view and sticks there.
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
 * position, sticky as part of this one column at every width.
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
  const stickyRef = useStickyColumn<HTMLDivElement>(twoColumn)
  return (
    <div
      ref={stickyRef}
      className={cn(
        'min-w-0',
        twoColumn &&
          'xl:sticky xl:top-[4.5rem] xl:col-start-2 xl:row-span-2 xl:row-start-1 xl:self-start',
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

/**
 * The Overdue auto-clear's toast. Plain and action-less: it only explains why
 * the list just widened. The snooze/done that emptied the filter has already
 * raised its own toast with Undo, so this one offers nothing to click.
 */
function notifyOverdueFilterCleared() {
  showToast({ message: `Nothing ${OVERDUE_LOWER} left — ${OVERDUE_WORD} filter cleared` })
}

/**
 * The sidebar's Dashboard count badges (`src/lib/nav-filter.ts`, 2026-10-27):
 * on the dashboard a badge asks for its filter through a window event — the
 * top bar's pill filter, but always ON (a badge never clears it), then the
 * same jump to the list.
 */
function useNavFilterRequests(
  activePillFilter: HeaderPillFilter | null,
  onExclusiveDateFilter: (filter: HeaderPillFilter) => void,
  requestJump: () => void,
) {
  useEffect(() => {
    const onRequest = (e: Event) => {
      const filter = (e as CustomEvent<NavFilter>).detail
      if (activePillFilter !== filter) onExclusiveDateFilter(filter)
      requestJump()
    }
    window.addEventListener(NAV_FILTER_EVENT, onRequest)
    return () => window.removeEventListener(NAV_FILTER_EVENT, onRequest)
  }, [activePillFilter, onExclusiveDateFilter, requestJump])
}
function DashboardView({
  tasks,
  sortedGroups,
  orderedIds,
  allTasks,
  quotaSource,
  projects,
  grouping,
  highlightTaskId,
  onHighlightDone,
  justAddedSource,
  justAddedNow,
  onGroupingChange,
  nowSummary,
  isFoldOpen,
  onToggleFold,
  timeSlots,
  searchQuery,
  searchHits,
  searchResultCount,
  shownTaskCount,
  sweepOverdueCount,
  selection,
  selectedTasks,
  actions,
  selectedLabels,
  onToggleLabel,
  onClearFilters,
  selectedPriorities,
  onTogglePriority,
  onExclusivePriority,
  selectedDateFilters,
  onToggleDateFilter,
  onDeselectDateFilter,
  onExclusiveDateFilter,
  now,
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
  filterCriteria,
  activeFilterCount,
  timezone,
  onSearch,
  onSearchClear,
  onBulkDone,
  onBulkSaveAll,
  onBulkDelete,
  onSkipUntil,
  onSnoozeOverdue,
  onSnoozeSelected,
  focusedTask,
  quickActionOpen,
  onTaskFocus,
  onQuickActionClose,
  onQuickActionSaveAll,
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
  /** The list's groups in drawn order, and its reachable ids — see HomeContent. */
  sortedGroups: SortedTaskGroup[]
  orderedIds: number[]
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
  /** Just-added previews' population; null while searching. See `src/lib/just-added.ts`. */
  justAddedSource: Task[] | null
  /** Just-added previews' clock. See `useJustAddedClock`. */
  justAddedNow: number
  onGroupingChange: (grouping: GroupingMode) => void
  /** Now's "N of M now · Show all" strip; null outside Now or while the list is narrowed. */
  nowSummary: NowSummaryState | null
  /** Whether a project's Now fold is open (`useNowFolds`, keyed by `nowFoldKey`). */
  isFoldOpen: (key: string) => boolean
  onToggleFold: (key: string) => void
  /** §6.0 time slots (periods), for "Next period" snoozes. Fetched once by the parent. */
  timeSlots: TimeSlot[]
  searchQuery: string | null
  /**
   * The raw search hit list (HomeContent's `searchResults`), only as a view
   * identity for the Overdue auto-clear: hits arrive AFTER `searchQuery`
   * changes, and only a new search or a clear writes this array.
   */
  searchHits: Task[]
  searchResultCount: number
  /** What the list renders — see `shownTaskCount` in `HomeContent`. */
  shownTaskCount: number
  /** Overdue tasks the snooze-all clock and FAB would sweep (`displayTasks`). */
  sweepOverdueCount: number
  selection: ReturnType<typeof useSelection>
  selectedTasks: Task[]
  actions: ReturnType<typeof useDashboardActions>
  selectedLabels: string[]
  onToggleLabel: (label: string) => void
  onClearFilters: () => void
  selectedPriorities: number[]
  onTogglePriority: (priority: number) => void
  onExclusivePriority: (priority: number) => void
  selectedDateFilters: DueDateFilter[]
  onToggleDateFilter: (filter: DueDateFilter) => void
  /** Remove a date filter if selected (never adds) — the Overdue auto-clear. */
  onDeselectDateFilter: (filter: DueDateFilter) => void
  onExclusiveDateFilter: (filter: DueDateFilter) => void
  /** The page's one clock (`useDashboardNow` in `HomeContent`). */
  now: Date
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
  /** Every filter group's state as one memoized object (`useFilterState`) —
   *  stable until a filter changes. */
  filterCriteria: TaskFilterCriteria
  /** Active include/exclude selections across every group (`useFilterState`). */
  activeFilterCount: number
  timezone: string
  onSearch: (q: string) => void
  onSearchClear: () => void
  onBulkDone: () => Promise<void>
  onBulkSaveAll: (changes: QuickActionPanelChanges, dateTaskIds?: number[]) => Promise<void>
  onBulkDelete: () => Promise<void>
  /** Skip until (PR 4): the selection sheet and the quick popover. */
  onSkipUntil: (ids: number[], until: string | null) => Promise<void>
  onSnoozeOverdue: (until?: string) => void
  /** The Defer button with a selection: defers `selectedTasks` (`useSnoozeOverdue`). */
  onSnoozeSelected: (until?: string) => void
  focusedTask: Task | null
  quickActionOpen: boolean
  onTaskFocus: (task: Task) => void
  onQuickActionClose: () => void
  onQuickActionSaveAll: (taskId: number, changes: QuickActionPanelChanges) => Promise<void>
  onQuickActionDone: (taskId: number) => void
  onQuickActionDelete: (taskId: number) => void
  /** Open a task's full page — from the selection bar's Details and the quick-action popover. */
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
  // Filters that live inside the collapsible block (§7.3). `activeFilterCount`
  // (from `useFilterState`) is counted rather than just flagged: the count is
  // what the collapsed "Filters · 2" badge shows, and what decides whether the
  // block auto-expands.
  //
  // The pinned Overdue chip in FilterBar's control row shows the Overdue date
  // filter's state on its own (solid red when selected), in the row that never
  // collapses. So an Overdue selection is not a filter the collapsed section
  // would hide, and it must not pop the section open: Trent's ask was "just
  // the overdue tasks" in one tap WITHOUT the chip stack (on a phone it is
  // most of a screen — `useFilterSection` rule 5). `useFilterSection`'s rule 3
  // ("an active filter is never invisible") therefore gets the count of
  // filters the collapsed row does NOT show; the "Filters · N" badge keeps the
  // full count. Any other date filter (Today from the gray pill included)
  // still auto-expands as before.
  const hiddenActiveFilterCount =
    activeFilterCount - (selectedDateFilters.includes('overdue') ? 1 : 0)
  const { expanded: filtersExpanded, toggleExpanded: onToggleFilters } =
    useFilterSection(hiddenActiveFilterCount)

  // Top bar pills + pinned Overdue chip: one memo, one population (the date
  // facet) — see `useDateFacetCounts` for why not the filtered list. The
  // criteria object is `useFilterState`'s own memo, so its identity changes
  // only when a filter does (the auto-clear scope below depends on that).
  const headerCounts = useDateFacetCounts(allTasks, filterCriteria, timezone, now)
  // SHELVED (2026-10-22): hides the AI chip and the Quick Take banner below.
  const aiUnshelved = useAiUnshelved()
  // The Overdue filter switches itself off when its last task stops being
  // overdue (done, snoozed, rescheduled — here or via sync), counted with the
  // same facet number the pill and pinned chip show. Rules and the deep-link
  // exception: `shouldAutoClearOverdueFilter` in src/lib/dashboard-clock.ts.
  const clearOverdueFilter = useCallback(
    () => onDeselectDateFilter('overdue'),
    [onDeselectDateFilter],
  )
  const overdueAutoClearScope = useMemo(
    () => [filterCriteria, searchQuery, searchHits, grouping],
    [filterCriteria, searchQuery, searchHits, grouping],
  )
  useAutoClearOverdueFilter(
    headerCounts.overdueCount,
    selectedDateFilters.includes('overdue'),
    overdueAutoClearScope,
    clearOverdueFilter,
    notifyOverdueFilterCleared,
  )
  // `aria-pressed` for the pills: on only when that filter is the SOLE date
  // filter, i.e. exactly what a tap on the pill produces (and a second tap
  // clears — `exclusiveDateFilter` toggles off an exclusive selection).
  const activePillFilter =
    selectedDateFilters.length === 1 &&
    (selectedDateFilters[0] === 'overdue' || selectedDateFilters[0] === 'today')
      ? selectedDateFilters[0]
      : null

  // Overdue FAB + top-bar pills: filter, then scroll the first task group up
  // under the top bar (`useJumpToTaskList`). A pill tap scrolls only when it
  // turns its filter ON — i.e. when it is not already the sole date filter,
  // which is exactly when `exclusiveDateFilter` sets it rather than clearing
  // it. Tapping the lit pill just clears the filter and leaves the page where
  // it is.
  const { listRef: taskListRef, requestJump } = useJumpToTaskList()
  // The zero-height marker at the top of the list wrapper that
  // `JumpToTasksFab` watches to know whether the page is above its landing.
  const taskListLandingRef = useRef<HTMLDivElement>(null)
  const onPillFilter = (filter: HeaderPillFilter) => {
    if (activePillFilter !== filter) requestJump()
    onExclusiveDateFilter(filter)
  }
  useNavFilterRequests(activePillFilter, onExclusiveDateFilter, requestJump)
  // The jump button is a toggle: lit (Overdue among the date filters — the
  // pinned chip's own "on"), a tap just takes Overdue off and leaves the page
  // where it is, like tapping the lit pill.
  const overdueFilterOn = selectedDateFilters.includes('overdue')
  const onOverdueJump = () => {
    if (overdueFilterOn) return onToggleDateFilter('overdue')
    onExclusiveDateFilter('overdue')
    requestJump()
  }

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

  // The Just now card: its entries, what "Clear" has hidden (in-memory, keyed
  // by task AND event time — a task added, or re-targeted, after a Clear is a
  // new event and shows again), and the list's reveal function for a tap
  // (`TaskList`'s `revealRef`).
  const [clearedJustAdded, setClearedJustAdded] = useState<Set<string>>(new Set())
  const justAddedEntries = justAddedSource
    ? selectJustAddedEntries(justAddedSource, justAddedNow).filter(
        (e) => !clearedJustAdded.has(justAddedEntryKey(e)),
      )
    : []
  const revealTaskRef = useRef<((task: Task) => void) | null>(null)
  // NOW'S ON DECK SECTION AT THE TOP (D2 review, 2026-10-20, provisional):
  // the list is drawn in two parts — the section under the filter row,
  // above the task-segment panel and the project groups; the rest in its
  // usual place (`TaskList`'s `part`). One set of props for both.
  const deckRevealRef = useRef<((task: Task) => void) | null>(null)
  const renderTaskList = (part: 'deck' | 'rest') => (
    <TaskList
      part={part}
      deckRevealRef={deckRevealRef}
      tasks={tasks}
      timeSlots={timeSlots}
      uncapped={overdueFilterOn}
      sortedGroups={sortedGroups}
      orderedIds={orderedIds}
      projects={projects}
      grouping={grouping}
      now={now}
      highlightTaskId={highlightTaskId}
      onHighlightDone={onHighlightDone}
      justAddedSource={justAddedSource}
      justAddedNow={justAddedNow}
      revealRef={revealTaskRef}
      onDone={actions.handleDone}
      onSnooze={actions.handleSnooze}
      // Remove target (2026-10-10): back to its horizon's task segment — or,
      // a deadline task (2026-10-22, when "Back to auto" went), onto the
      // deadlines page from its lead day.
      onRemoveTarget={(task) =>
        void actions.handleSaveAllChanges(task.id, { due_at: null }).catch(() => undefined)
      }
      // The row's horizon dot menu and its hover Today (and the Today
      // hold's Target menu) — on every row, the ones inside an open Now
      // fold included.
      onSetHorizon={(task, horizon) =>
        void actions.handleSaveAllChanges(task.id, { horizon }).catch(() => undefined)
      }
      onTargetAt={(task, at) => void actions.handleTargetAt(task, at)}
      onDeck={(task, day) => void actions.handleDeck(task, day)}
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
      isFoldOpen={isFoldOpen}
      onToggleFold={onToggleFold}
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
      insightsCommentaryMap={effectiveCommentaryMap.size > 0 ? effectiveCommentaryMap : undefined}
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
  )

  return (
    <div className="flex flex-1 flex-col">
      <Header
        taskCount={shownTaskCount}
        overdueCount={headerCounts.overdueCount}
        todayCount={headerCounts.todayCount}
        onPillFilter={onPillFilter}
        activePillFilter={activePillFilter}
        onUndo={actions.handleUndo}
        onRedo={actions.handleRedo}
        undoCount={actions.undoCount}
        redoCount={actions.redoCount}
        onSearch={onSearch}
        onSearchClear={onSearchClear}
        onSnoozeOverdue={onSnoozeOverdue}
        onSnoozeSelected={onSnoozeSelected}
        snoozeSelectedCount={selectedTasks.length}
        snoozeOverdueCount={sweepOverdueCount}
        hasPeriods={timeSlots.length > 0}
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
              {/* Rendered in every view (Now / Newest) and at every
                  scroll position, so the phone `+` always has it to focus. */}
              <QuickAdd
                focusOnEvent
                onAdd={async (title) => {
                  await onQuickAdd(title)
                }}
                onOpenAddForm={(title) => {
                  window.dispatchEvent(new CustomEvent('open-add-form', { detail: { title } }))
                }}
              />
            </div>
            {/* The AI chip holds only What's Next and Insights: hidden while
                they are shelved (`aiUnshelved`). AI Status stays in the top bar. */}
            {aiAvailable && aiUnshelved && (
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
                insightsUnscoredTasks={insightsData.unscoredTasks}
                onRefreshInsights={onRefreshInsights}
                enrichmentActive={enrichmentActive}
                timezone={timezone}
              />
            )}
          </div>

          <JustAddedCard
            entries={justAddedEntries}
            projects={projects}
            now={justAddedNow}
            timezone={timezone}
            onShow={(task) => revealTaskRef.current?.(task)}
            onClear={() =>
              setClearedJustAdded(
                (prev) => new Set([...prev, ...justAddedEntries.map(justAddedEntryKey)]),
              )
            }
          />

          {aiAvailable && aiUnshelved && bannerState && (
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

          {/* The front door is Now; Show all and Newest keep the corpus one tap away.
              Wraps: at the iOS app's largest text sizes (a 24px root at 150%,
              ios/OpenTask/WebView.swift) the toggle and "20 of 134 now · Show
              all 134" are wider than a phone, and the row ran 12px off it. */}
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <ViewModeToggle grouping={grouping} onChange={onGroupingChange} />
            {nowSummary && <NowSummary {...nowSummary} />}
          </div>

          <FilterBar
            tasks={allTasks}
            expanded={filtersExpanded}
            onToggleExpanded={onToggleFilters}
            activeFilterCount={activeFilterCount}
            pinnedOverdueCount={headerCounts.overdueCount}
            now={now}
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

          {/* Now's On deck section (D2): under the filter row, at the top. */}
          {renderTaskList('deck')}
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

        <div
          ref={taskListRef}
          className="scroll-below-header min-w-0 xl:col-start-1 xl:row-start-2"
        >
          <div ref={taskListLandingRef} aria-hidden data-task-list-landing className="h-0" />
          {renderTaskList('rest')}
        </div>
      </main>

      <SelectionActionSheet
        selectedCount={selection.selectedIds.size}
        selectedTasks={selectedTasks}
        sheetOpenRef={bulkSheetOpenRef}
        onDone={onBulkDone}
        onSaveAll={onBulkSaveAll}
        onDelete={onBulkDelete}
        onSkipUntil={onSkipUntil}
        onClear={selection.clear}
        onNavigateToDetail={onNavigateToDetail}
        projects={projects}
      />

      {/* Top to bottom, as they stack on screen — see `DashboardFabStack`. */}
      <DashboardFabStack selectionBarUp={selection.selectedIds.size > 0}>
        <JumpToTasksFab
          listRef={taskListRef}
          landingRef={taskListLandingRef}
          isSelectionMode={selection.isSelectionMode}
          searching={!!searchQuery}
          onJump={() => requestJump('list')}
        />
        <ViewModeFab
          grouping={grouping}
          isSelectionMode={selection.isSelectionMode}
          onShowAll={() => onGroupingChange('project')}
        />
        {/* Counts the date facet (`headerCounts`), like the red pill and the
            pinned chip it acts like — not `sweepOverdueCount` below. "On" is
            `includes`, the pinned chip's own solid state, not "sole filter". */}
        <OverdueJumpFab
          placement="phone"
          overdueCount={headerCounts.overdueCount}
          overdueFilterOn={overdueFilterOn}
          isSelectionMode={selection.isSelectionMode}
          onJump={onOverdueJump}
        />
        <OverdueJumpFab
          placement="desktop"
          overdueCount={headerCounts.overdueCount}
          overdueFilterOn={overdueFilterOn}
          isSelectionMode={selection.isSelectionMode}
          onJump={onOverdueJump}
        />
        {/* Stays in selection mode (Trent, 2026-10-26): it then defers the
            selection, with the selected count on it. */}
        <SnoozeOverdueTrigger
          variant="fab"
          overdueCount={sweepOverdueCount}
          selectedCount={selectedTasks.length}
          hasPeriods={timeSlots.length > 0}
          onSnoozeOverdue={onSnoozeOverdue}
          onSnoozeSelected={onSnoozeSelected}
        />
      </DashboardFabStack>

      <QuickActionPopover
        focusedTask={focusedTask}
        open={quickActionOpen}
        onClose={onQuickActionClose}
        onSaveAll={onQuickActionSaveAll}
        onDelete={onQuickActionDelete}
        onMarkDone={onQuickActionDone}
        onSkipUntil={(taskId, until) => onSkipUntil([taskId], until)}
        onNavigateToDetail={onNavigateToDetail}
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
