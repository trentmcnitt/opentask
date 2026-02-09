'use client'

import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import {
  Repeat,
  Timer,
  TimerOff,
  Bell,
  Trash2,
  MoreHorizontal,
  Info,
  Check,
  X,
  Plus,
  ChevronDown,
  XCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { cn } from '@/lib/utils'
import { useQuickSelectDate } from '@/hooks/useQuickSelectDate'
import { useBulkQuickSelectDate } from '@/hooks/useBulkQuickSelectDate'
import { formatRRuleCompact, formatBulkRecurrence } from '@/lib/format-rrule'
import {
  PRESET_TIMES,
  INCREMENTS,
  DECREMENTS,
  SMART_BUTTONS,
  snapToNearestFiveMinutes,
  snapToNextHour,
} from '@/lib/quick-select-dates'
import { RecurrencePicker } from '@/components/RecurrencePicker'
import { computeRecurrencePreview } from '@/lib/recurrence-preview'
import { DateTime } from 'luxon'
import { PRIORITY_OPTIONS, getPriorityOption } from '@/lib/priority'
import { useLabelConfig, useAutoSnoozeDefault } from '@/components/PreferencesProvider'
import { getLabelClasses } from '@/lib/label-colors'
import { formatDateTime, formatTimeInTimezone } from '@/lib/format-date'
import { IconButton } from '@/components/ui/icon-button'
import { AutoSnoozePicker, formatAutoSnoozeLabel } from '@/components/AutoSnoozePicker'
import { computeCommonLabels, computeCommonPriority, hasLabelVariations } from '@/lib/bulk-utils'
import type { Task, Project } from '@/types'

/**
 * Staged changes architecture:
 * All field changes (priority, labels, recurrence, project) are staged locally
 * until the user clicks Save. This provides a consistent UX where:
 * - All changes show in the UI immediately (optimistic display)
 * - Nothing is committed to the server until Save is clicked
 * - Reset discards all pending changes
 * - The isDirty indicator (blue left border + enabled Save button) shows when changes exist
 */

/**
 * Changes object for batched save - all fields that can be changed in the panel.
 * Used by onSaveAll to send all changes in a single API call.
 */
export interface QuickActionPanelChanges {
  title?: string
  priority?: number
  labels?: string[]
  rrule?: string | null
  recurrence_mode?: 'from_due' | 'from_completion'
  project_id?: number
  due_at?: string | null
  auto_snooze_minutes?: number | null
}

export interface QuickActionPanelProps {
  /** Task(s) being acted on. Single task or null for bulk. */
  task: Task | null
  /** Selected tasks for bulk mode (required when task is null and selectedCount > 0) */
  selectedTasks?: Task[]
  /** Number of selected tasks (for bulk mode header) */
  selectedCount?: number
  /** User's IANA timezone */
  timezone: string
  /** "inline" shows Apply button; "popover"/"sheet" show Save/Cancel when dirty */
  mode: 'inline' | 'popover' | 'sheet'
  /** Called with the final date when saving (absolute mode) */
  onDateChange?: (isoUtc: string) => void
  /** Called with delta minutes when saving (relative mode, bulk only) */
  onDateChangeRelative?: (deltaMinutes: number) => void
  /** Called with absolute priority value (0=none, 1=low, 2=medium, 3=high, 4=urgent) */
  onPriorityChange?: (priority: number) => void
  /** Called when rrule changes (inline mode with RecurrencePicker) */
  onRruleChange?: (rrule: string | null, recurrenceMode?: 'from_due' | 'from_completion') => void
  /** Available projects for project picker popover (use with onProjectChange) */
  projects?: Project[]
  /** Called when project is changed via popover picker (requires projects prop) */
  onProjectChange?: (projectId: number) => void
  /** Called to open external project picker (alternative to projects+onProjectChange) */
  onMoveToProject?: () => void
  /** Called when labels are changed via inline editor */
  onLabelsChange?: (labels: string[]) => void
  /** Called to delete task(s) */
  onDelete?: () => void
  /** Whether the panel is open (used for auto-save on close in popover/sheet modes) */
  open?: boolean
  /** Called when user clicks Cancel (resets changes, closes without saving) */
  onCancel?: () => void
  /** Called when user clicks Save (applies changes, closes) */
  onSave?: () => void
  /** Called when user wants to navigate to task detail (single task only) */
  onNavigateToDetail?: () => void
  /**
   * Recurrence summary to display (for sheet mode where SelectionActionSheet
   * computes it). If not provided, computes from task/selectedTasks.
   */
  recurrenceSummary?: string | null
  /** Title size: 'compact' (default) or 'prominent' (larger for page context) */
  titleVariant?: 'compact' | 'prominent'
  /** Called when title is edited (makes title editable when provided) */
  onTitleChange?: (title: string) => void
  /** Show Completed badge when task.done is true */
  showCompletedBadge?: boolean
  /** Called when user marks task as done (single task only, popover mode) */
  onMarkDone?: () => void
  /** Project name to display as badge next to title */
  projectName?: string
  /** Called when dirty state changes (for navigation protection in parent) */
  onDirtyChange?: (isDirty: boolean) => void
  /** Ref populated with save function for external triggering (e.g., from navigation dialog) */
  saveRef?: React.MutableRefObject<(() => Promise<void> | void) | null>
  /**
   * Batched save callback - when provided, all changes are collected and sent
   * in a single call instead of individual callbacks. This enables atomic saves
   * with a single undo entry. Falls back to individual callbacks if not provided.
   */
  onSaveAll?: (changes: QuickActionPanelChanges) => void | Promise<void>
  /** Enables create mode — panel is used for new task creation instead of editing */
  createMode?: boolean
  /** Pre-fills title in create mode (from QuickAdd "+" button) */
  initialTitle?: string
  /** Called on submit in create mode with all staged fields including title */
  onCreate?: (fields: QuickActionPanelChanges & { title: string }) => void | Promise<void>
}

/**
 * Tiered text sizing for the detail page (prominent) title.
 * The detail page has more room than the dashboard, so thresholds are higher.
 * For extreme lengths (501+), also adds a scrollable container.
 */
function getDetailTitleClasses(title: string): { sizeClass: string; scrollable: boolean } {
  const len = title.length
  if (len <= 200) return { sizeClass: 'text-lg md:text-lg', scrollable: false }
  if (len <= 500) return { sizeClass: 'text-base md:text-base', scrollable: false }
  return { sizeClass: 'text-sm', scrollable: true }
}

export function QuickActionPanel({
  task,
  selectedTasks,
  selectedCount,
  timezone,
  mode,
  onDateChange,
  onDateChangeRelative,
  onPriorityChange,
  onRruleChange,
  projects,
  onProjectChange,
  onMoveToProject,
  onLabelsChange,
  onDelete,
  open = true,
  onCancel,
  onSave,
  onNavigateToDetail,
  recurrenceSummary,
  titleVariant = 'compact',
  onTitleChange,
  showCompletedBadge = false,
  onMarkDone,
  projectName,
  onDirtyChange,
  saveRef,
  onSaveAll,
  createMode = false,
  initialTitle,
  onCreate,
}: QuickActionPanelProps) {
  // Effective task: either passed directly, or single selected task via bulk path
  const effectiveTask = task ?? (selectedTasks?.length === 1 ? selectedTasks[0] : null)

  // Bulk mode = multiple tasks selected (not single task via bulk path)
  const isBulkMode = !effectiveTask && (selectedTasks?.length ?? 0) > 0

  // Create mode = panel is used for new task creation
  const isCreateMode = createMode

  // Focus the title input after mount in create mode.
  //
  // Desktop/popover: focus immediately (no animation to wait for).
  // Sheet mode (mobile): Radix auto-focus handles it — the sheet's first
  // focusable element (the textarea) receives focus automatically, which
  // keeps the keyboard activation within the user gesture chain on iOS.
  const createTitleRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (!isCreateMode) return
    if (mode !== 'sheet') {
      createTitleRef.current?.focus()
    }
  }, [isCreateMode, mode])

  // Single task mode (either direct or via bulk selection)
  const isSingleTask = !!effectiveTask

  // State for expandable recurrence picker (inline mode only)
  const [editingRecurrence, setEditingRecurrence] = useState(false)

  // State for title editing
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')

  // State for create-mode title (always-visible input, not click-to-edit)
  const [createTitle, setCreateTitle] = useState(initialTitle ?? '')

  // State for Mark Done confirmation dialog
  const [showDoneConfirm, setShowDoneConfirm] = useState(false)

  // State for popover pickers
  const [priorityPopoverOpen, setPriorityPopoverOpen] = useState(false)
  const [projectPopoverOpen, setProjectPopoverOpen] = useState(false)

  // State for label editing
  const [labelInput, setLabelInput] = useState('')
  const [showLabelDropdown, setShowLabelDropdown] = useState(false)
  const labelWrapperRef = useRef<HTMLDivElement>(null)
  const { labelConfig } = useLabelConfig()
  const { autoSnoozeDefault } = useAutoSnoozeDefault()

  // Staged changes state - all changes are staged until Save is clicked
  // undefined means "no change" for rrule (to distinguish from null = "remove recurrence")
  const [pendingPriority, setPendingPriority] = useState<number | null>(null)
  const [pendingLabels, setPendingLabels] = useState<string[] | null>(null)
  const [pendingRrule, setPendingRrule] = useState<string | null | undefined>(undefined)
  const [pendingRecurrenceMode, setPendingRecurrenceMode] = useState<
    'from_due' | 'from_completion' | null
  >(null)
  const [pendingProject, setPendingProject] = useState<number | null>(null)
  // pendingTitle stages title changes (previously auto-saved on blur)
  const [pendingTitle, setPendingTitle] = useState<string | null>(null)
  // pendingDueAt stages date changes for batched save (only used when onSaveAll provided)
  const [pendingDueAt, setPendingDueAt] = useState<string | null>(null)
  // pendingDueAtCleared tracks when user wants to clear the due date (and recurrence)
  const [pendingDueAtCleared, setPendingDueAtCleared] = useState(false)
  // pendingAutoSnooze: undefined = no change, null = default, 0 = off, positive = custom
  const [pendingAutoSnooze, setPendingAutoSnooze] = useState<number | null | undefined>(undefined)
  const [autoSnoozePopoverOpen, setAutoSnoozePopoverOpen] = useState(false)

  // Single task mode hook
  const dueAt = effectiveTask?.due_at ?? null
  const singleHook = useQuickSelectDate({ dueAt, timezone })

  // Bulk mode hook
  const bulkHook = useBulkQuickSelectDate({
    tasks: selectedTasks ?? [],
    timezone,
  })

  // Tick state for updating smart button times (every 15 seconds)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 15000)
    return () => clearInterval(interval)
  }, [])

  // Compute smart button labels with time preview
  const smartButtonLabels = useMemo(() => {
    void tick // Force recalculation on tick
    const nowTime = formatTimeInTimezone(snapToNearestFiveMinutes(), timezone)
    const nextHourTime = formatTimeInTimezone(snapToNextHour(), timezone)
    return {
      now: `Now · ${nowTime}`,
      nextHour: `Next Hour · ${nextHourTime}`,
    }
  }, [timezone, tick])

  // Bulk common value computations - intersection of values across selected tasks
  const bulkCommonLabels = useMemo(
    () => (isBulkMode ? computeCommonLabels(selectedTasks ?? []) : []),
    [isBulkMode, selectedTasks],
  )
  const bulkCommonPriority = useMemo(
    () => (isBulkMode ? computeCommonPriority(selectedTasks ?? []) : null),
    [isBulkMode, selectedTasks],
  )

  // Mixed-value indicators for bulk mode
  const isMixedPriority = isBulkMode && bulkCommonPriority === null && pendingPriority === null
  const isMixedLabels = useMemo(
    () => (isBulkMode ? hasLabelVariations(selectedTasks ?? []) : false),
    [isBulkMode, selectedTasks],
  )

  // Computed display values - show pending changes or fall back to current task values
  // In bulk mode, fall through to bulk common values when no pending change and no effectiveTask
  // useMemo for displayLabels to avoid triggering re-renders in useCallback dependencies
  const displayPriority =
    pendingPriority ?? effectiveTask?.priority ?? (isBulkMode ? (bulkCommonPriority ?? 0) : 0)
  const displayLabels = useMemo(
    () => pendingLabels ?? effectiveTask?.labels ?? (isBulkMode ? bulkCommonLabels : []),
    [pendingLabels, effectiveTask?.labels, isBulkMode, bulkCommonLabels],
  )
  const displayRrule = pendingRrule !== undefined ? pendingRrule : effectiveTask?.rrule
  const displayProject = pendingProject ?? effectiveTask?.project_id

  // Preview of new due_at when changing recurrence for non-overdue tasks
  // This helps users understand what date the task will move to with the new schedule
  const previewDueAt = useMemo(() => {
    // Only show preview when user is actively changing recurrence
    if (pendingRrule === undefined || !pendingRrule || !effectiveTask) return null

    // Don't preview for overdue tasks - they stay overdue until dealt with
    const isOverdue = effectiveTask.due_at && new Date(effectiveTask.due_at) < new Date()
    if (isOverdue) return null

    // Use timezone-aware preview computation (mirrors server-side "naive local" approach)
    return computeRecurrencePreview(pendingRrule, timezone)
  }, [pendingRrule, effectiveTask, timezone])

  // Compute RRULE day abbreviation from task's due date for auto-selecting in RecurrencePicker
  const defaultDayOfWeek = useMemo(() => {
    if (!effectiveTask?.due_at) return undefined
    const RRULE_DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const
    const weekday = DateTime.fromISO(effectiveTask.due_at).setZone(timezone).weekday // 1=Mon..7=Sun
    return RRULE_DAYS[weekday - 1]
  }, [effectiveTask, timezone])

  // Use the appropriate hook based on mode
  // When onSaveAll is provided, date changes can be staged via pendingDueAt OR tracked via hook
  const hasDateChanges = onSaveAll
    ? pendingDueAt !== null || singleHook.isDirty
    : isBulkMode
      ? bulkHook.isDirty
      : singleHook.isDirty
  const hasPendingChanges =
    pendingPriority !== null ||
    pendingLabels !== null ||
    pendingRrule !== undefined ||
    pendingRecurrenceMode !== null ||
    pendingProject !== null ||
    pendingTitle !== null ||
    pendingDueAtCleared ||
    pendingAutoSnooze !== undefined
  // In create mode, dirty means the user has changed something from the initial defaults:
  // typed a title (different from initialTitle), changed any field, or picked a date.
  const createModeDirty = isCreateMode
    ? createTitle.trim() !== (initialTitle ?? '').trim() ||
      pendingPriority !== null ||
      pendingLabels !== null ||
      pendingRrule !== undefined ||
      pendingProject !== null ||
      hasDateChanges ||
      pendingAutoSnooze !== undefined
    : false
  const isDirty = isCreateMode ? createModeDirty : hasDateChanges || hasPendingChanges

  // Recurrence is invalid when FREQ=WEEKLY has no BYDAY in from_due mode.
  // Only check when the user has the recurrence picker open or modified the rrule,
  // so existing legacy data without BYDAY doesn't block unrelated edits.
  const isRecurrenceInvalid = useMemo(() => {
    if (!editingRecurrence && pendingRrule === undefined) return false
    const rruleToCheck = pendingRrule !== undefined ? pendingRrule : (effectiveTask?.rrule ?? null)
    if (!rruleToCheck) return false
    const mode = pendingRecurrenceMode ?? effectiveTask?.recurrence_mode ?? 'from_due'
    if (mode === 'from_completion') return false
    return rruleToCheck.includes('FREQ=WEEKLY') && !rruleToCheck.includes('BYDAY=')
  }, [
    editingRecurrence,
    pendingRrule,
    pendingRecurrenceMode,
    effectiveTask?.rrule,
    effectiveTask?.recurrence_mode,
  ])

  // Notify parent of dirty state changes for navigation protection
  useEffect(() => {
    onDirtyChange?.(isDirty)
  }, [isDirty, onDirtyChange])

  const headerText = isBulkMode ? bulkHook.headerText : singleHook.headerText
  const relativeText = isBulkMode ? bulkHook.relativeText : singleHook.relativeText
  const isPast = isBulkMode ? bulkHook.isPast : singleHook.isPast
  const deltaDisplay = isBulkMode ? bulkHook.deltaDisplay : singleHook.deltaDisplay

  // Whether the date specifically has changed (separate from overall isDirty which includes
  // priority, labels, etc.). Used for blue styling on the due date line.
  const isDateDirty = isBulkMode ? bulkHook.isDirty : singleHook.isDirty

  // Per-field dirty booleans — used for blue "modified" indicators on each field
  const isTitleDirty = pendingTitle !== null
  const isPriorityDirty = pendingPriority !== null
  const isLabelsDirty = pendingLabels !== null
  // Track which labels are newly added (not in original set) for per-label dirty indicators
  const newLabels = useMemo(() => {
    if (!isLabelsDirty) return new Set<string>()
    const origLabels = effectiveTask?.labels ?? (isBulkMode ? bulkCommonLabels : [])
    const origSet = new Set(origLabels.map((l) => l.toLowerCase()))
    return new Set(displayLabels.filter((l) => !origSet.has(l.toLowerCase())))
  }, [isLabelsDirty, effectiveTask?.labels, isBulkMode, bulkCommonLabels, displayLabels])
  const isRruleDirty = pendingRrule !== undefined
  const isProjectDirty = pendingProject !== null

  // Whether ALL tasks genuinely have no due date — used for the "No due date" display.
  // In bulk mode, only show "No due date" when every task lacks a date.
  const allNoDueDate = isBulkMode
    ? (selectedTasks ?? []).every((t) => !t.due_at)
    : !effectiveTask?.due_at

  // Only show delta when task originally had a due date. When due_at is null,
  // initWorkingDate generates a near-now default (5-min snap) and showing a delta
  // from that would be confusing. Also suppress in bulk mixed-date delta mode since
  // relativeText already shows "+Xh from each".
  const hadOriginalDueAt = isBulkMode
    ? (selectedTasks ?? []).some((t) => t.due_at !== null)
    : !!effectiveTask?.due_at
  const isMixedDateDelta =
    isBulkMode && bulkHook.hasMixedDates && bulkHook.operationType === 'delta'
  const effectiveDeltaDisplay = hadOriginalDueAt && !isMixedDateDelta ? deltaDisplay : null
  const applyPreset = isBulkMode ? bulkHook.applyPreset : singleHook.applyPreset
  const applyIncrement = isBulkMode ? bulkHook.applyIncrement : singleHook.applyIncrement
  const reset = isBulkMode ? bulkHook.reset : singleHook.reset
  const workingDate = singleHook.workingDate

  // Handler for smart buttons (Now, Next Hour)
  const handleSmartButton = useCallback(
    (type: 'now' | 'nextHour') => {
      const isoUtc = type === 'now' ? snapToNearestFiveMinutes() : snapToNextHour()
      if (isBulkMode) {
        bulkHook.setAbsoluteTarget(isoUtc)
      } else {
        singleHook.setAbsoluteTarget(isoUtc)
      }
    },
    [isBulkMode, bulkHook, singleHook],
  )

  // Wrapper handlers that clear pendingDueAtCleared before delegating to date buttons.
  // Without this, clicking "Clear due date" then a preset/increment button leaves
  // pendingDueAtCleared=true, causing collectPendingChanges() to short-circuit and
  // ignore the new date selection.
  const handlePresetClick = useCallback(
    (hour: number, minute: number) => {
      setPendingDueAtCleared(false)
      applyPreset(hour, minute)
    },
    [applyPreset],
  )

  const handleIncrementClick = useCallback(
    (inc: { minutes: number | null; days?: number }) => {
      setPendingDueAtCleared(false)
      applyIncrement(inc)
    },
    [applyIncrement],
  )

  const handleSmartButtonClick = useCallback(
    (type: 'now' | 'nextHour') => {
      setPendingDueAtCleared(false)
      handleSmartButton(type)
    },
    [handleSmartButton],
  )

  // Apply date changes - when onSaveAll provided, stage the change for batched save
  const handleApply = useCallback(() => {
    if (isBulkMode) {
      const result = bulkHook.getResult()
      if (result?.type === 'absolute') {
        onDateChange?.(result.until)
      } else if (result?.type === 'relative' && onDateChangeRelative) {
        onDateChangeRelative(result.deltaMinutes)
      }
    } else if (onSaveAll) {
      // Stage date change for batched save (single task mode with onSaveAll)
      setPendingDueAt(workingDate)
    } else {
      onDateChange?.(workingDate)
    }
  }, [isBulkMode, bulkHook, workingDate, onDateChange, onDateChangeRelative, onSaveAll])

  // Auto-save on dismiss for popover/sheet modes when NOT using explicit save/cancel
  // (legacy behavior when onSave/onCancel are not provided)
  const workingDateRef = useRef(workingDate)
  const isDirtyRef = useRef(isDirty)
  useEffect(() => {
    workingDateRef.current = workingDate
    isDirtyRef.current = isDirty
  }, [workingDate, isDirty])

  const prevOpenRef = useRef(open)
  useEffect(() => {
    // Only auto-save if no explicit save/cancel handlers (legacy mode)
    if (
      !onSave &&
      !onCancel &&
      prevOpenRef.current &&
      !open &&
      isDirtyRef.current &&
      (mode === 'popover' || mode === 'sheet')
    ) {
      onDateChange?.(workingDateRef.current)
    }
    prevOpenRef.current = open
  }, [open, mode, onDateChange, onSave, onCancel])

  // Collect all pending changes into a single QuickActionPanelChanges object.
  // Used by both handleSave and handleSaveAndDone to avoid duplicating the collection logic.
  const collectPendingChanges = useCallback((): QuickActionPanelChanges => {
    const changes: QuickActionPanelChanges = {}
    if (pendingTitle !== null) changes.title = pendingTitle
    if (pendingPriority !== null) changes.priority = pendingPriority
    if (pendingLabels !== null) changes.labels = pendingLabels
    if (pendingDueAtCleared) {
      changes.due_at = null
      changes.rrule = null
    } else {
      if (pendingRrule !== undefined) changes.rrule = pendingRrule
      if (pendingDueAt !== null) {
        changes.due_at = pendingDueAt
      } else if (singleHook.isDirty) {
        changes.due_at = singleHook.workingDate
      }
    }
    if (pendingRecurrenceMode !== null) changes.recurrence_mode = pendingRecurrenceMode
    if (pendingProject !== null) changes.project_id = pendingProject
    if (pendingAutoSnooze !== undefined) changes.auto_snooze_minutes = pendingAutoSnooze
    return changes
  }, [
    pendingTitle,
    pendingPriority,
    pendingLabels,
    pendingDueAtCleared,
    pendingRrule,
    pendingDueAt,
    singleHook.isDirty,
    singleHook.workingDate,
    pendingRecurrenceMode,
    pendingProject,
    pendingAutoSnooze,
  ])

  // Reset all pending state back to initial values.
  // Used by handleSave, handleCancel, and handleReset to avoid duplicating the reset logic.
  const resetAllPending = useCallback(() => {
    setPendingTitle(null)
    setPendingPriority(null)
    setPendingLabels(null)
    setPendingRrule(undefined)
    setPendingRecurrenceMode(null)
    setPendingProject(null)
    setPendingDueAt(null)
    setPendingDueAtCleared(false)
    setPendingAutoSnooze(undefined)
  }, [])

  // Create mode handler: collects all staged fields + title, calls onCreate, then resets
  const handleCreate = useCallback(async () => {
    if (!onCreate) return
    const changes = collectPendingChanges()
    // Include date from hook if user picked one
    if (!changes.due_at && singleHook.isDirty) {
      changes.due_at = singleHook.workingDate
    }
    await onCreate({ ...changes, title: createTitle.trim() })
    resetAllPending()
    setCreateTitle('')
    singleHook.reset()
  }, [onCreate, collectPendingChanges, createTitle, resetAllPending, singleHook])

  // Shared save logic: applies all pending changes via either batched or individual callbacks.
  // Used by both handleSave and handleSaveAndDone to avoid duplicating the dispatch logic.
  const applyAllPendingChanges = useCallback(async () => {
    if (onSaveAll) {
      const changes = collectPendingChanges()
      if (Object.keys(changes).length > 0) {
        await onSaveAll(changes)
      }
    } else {
      // Individual callbacks mode (backward compatibility)
      if (hasDateChanges) {
        handleApply()
      }
      if (pendingPriority !== null) {
        onPriorityChange?.(pendingPriority)
      }
      if (pendingLabels !== null) {
        onLabelsChange?.(pendingLabels)
      }
      if (pendingRrule !== undefined || pendingRecurrenceMode !== null) {
        const rrule = pendingRrule !== undefined ? pendingRrule : (effectiveTask?.rrule ?? null)
        const resolvedRecurrenceMode = pendingRecurrenceMode ?? effectiveTask?.recurrence_mode
        onRruleChange?.(rrule, resolvedRecurrenceMode)
      }
      if (pendingProject !== null) {
        onProjectChange?.(pendingProject)
      }
    }
  }, [
    onSaveAll,
    collectPendingChanges,
    pendingPriority,
    pendingLabels,
    pendingRrule,
    pendingRecurrenceMode,
    pendingProject,
    hasDateChanges,
    handleApply,
    effectiveTask?.rrule,
    effectiveTask?.recurrence_mode,
    onPriorityChange,
    onLabelsChange,
    onRruleChange,
    onProjectChange,
  ])

  const handleSave = useCallback(async () => {
    await applyAllPendingChanges()
    resetAllPending()
    singleHook.reset()
    onSave?.()
  }, [applyAllPendingChanges, resetAllPending, singleHook, onSave])

  // Expose handleSave to parent via saveRef for external triggering (e.g., navigation dialog)
  const handleSaveRef = useRef(handleSave)
  useEffect(() => {
    handleSaveRef.current = handleSave
  }, [handleSave])

  useEffect(() => {
    if (saveRef) {
      saveRef.current = () => handleSaveRef.current()
      return () => {
        saveRef.current = null
      }
    }
  }, [saveRef])

  const handleCancel = useCallback(() => {
    reset()
    resetAllPending()
    if (isCreateMode) setCreateTitle(initialTitle ?? '')
    onCancel?.()
  }, [reset, resetAllPending, onCancel, isCreateMode, initialTitle])

  // Reset handler for the Reset button - clears all pending changes
  const handleReset = useCallback(() => {
    reset()
    resetAllPending()
  }, [reset, resetAllPending])

  // In sheet mode with selectedCount, SelectionActionSheet owns title and quick-links
  const isSelectionSheetMode = mode === 'sheet' && selectedCount !== undefined

  // Compute title:
  // - SelectionActionSheet (sheet mode with selectedCount): hide title, modal shows it
  // - sheet mode without selectedCount: show task title
  // - inline/popover: show count for bulk or task title
  // When pendingTitle exists, show it instead of the task's current title
  const displayTitle = pendingTitle ?? effectiveTask?.title
  const title = isSelectionSheetMode
    ? null
    : selectedCount && selectedCount > 1
      ? `${selectedCount} tasks selected`
      : (displayTitle ?? 'Set date')

  // Compute recurrence text for header display
  // In SelectionActionSheet (sheet mode with selectedCount), use the recurrenceSummary prop
  // In other modes, compute from displayRrule (pending or current) or selectedTasks
  // For single non-recurring tasks, show "One time" indicator
  const recurrenceText = (() => {
    if (isSelectionSheetMode) {
      return recurrenceSummary ?? null
    }
    if (isBulkMode) {
      return formatBulkRecurrence(selectedTasks ?? [])
    }
    if (!displayRrule) return 'One time'
    return formatRRuleCompact(displayRrule, effectiveTask?.anchor_time)
  })()

  // Determine if recurrence is "One time" for styling purposes
  const isOneTime = !isBulkMode && !isSelectionSheetMode && !displayRrule

  // Toggle recurrence picker (for inline mode)
  const handleRecurrenceToggle = useCallback(() => {
    setEditingRecurrence((prev) => !prev)
  }, [])

  // Handle title editing - stages the change when onSaveAll is provided,
  // otherwise falls back to immediate save via onTitleChange
  const handleTitleSave = useCallback(() => {
    const trimmed = titleDraft.trim()
    if (trimmed && trimmed !== effectiveTask?.title) {
      if (onSaveAll) {
        // Stage the title change for batched save
        setPendingTitle(trimmed)
      } else {
        // Fall back to immediate save
        onTitleChange?.(trimmed)
      }
    }
    setEditingTitle(false)
  }, [titleDraft, effectiveTask?.title, onTitleChange, onSaveAll])

  const handleTitleClick = useCallback(() => {
    if ((onTitleChange || onSaveAll) && effectiveTask) {
      // Use pendingTitle if it exists, otherwise use task's current title
      setTitleDraft(pendingTitle ?? effectiveTask.title)
      setEditingTitle(true)
    }
  }, [onTitleChange, onSaveAll, effectiveTask, pendingTitle])

  // Mark Done handlers
  const handleDoneClick = useCallback(() => {
    if (isDirty) {
      // Show confirmation dialog when there are unsaved changes
      setShowDoneConfirm(true)
    } else {
      // No changes, mark done directly
      onMarkDone?.()
    }
  }, [isDirty, onMarkDone])

  const handleDiscardAndDone = useCallback(() => {
    setShowDoneConfirm(false)
    resetAllPending()
    reset()
    onMarkDone?.()
  }, [resetAllPending, reset, onMarkDone])

  const handleSaveAndDone = useCallback(async () => {
    setShowDoneConfirm(false)
    await applyAllPendingChanges()
    onMarkDone?.()
  }, [applyAllPendingChanges, onMarkDone])

  // Label editing handlers - stage changes instead of applying immediately
  const addLabel = useCallback(
    (label: string) => {
      const trimmed = label.trim()
      const currentLabels = displayLabels
      if (trimmed && !currentLabels.some((l) => l.toLowerCase() === trimmed.toLowerCase())) {
        setPendingLabels([...currentLabels, trimmed])
      }
      setLabelInput('')
      setShowLabelDropdown(false)
    },
    [displayLabels],
  )

  const removeLabel = useCallback(
    (label: string) => {
      setPendingLabels(displayLabels.filter((l) => l !== label))
    },
    [displayLabels],
  )

  // Close label dropdown on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (labelWrapperRef.current && !labelWrapperRef.current.contains(e.target as Node)) {
        setShowLabelDropdown(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  // Filter predefined labels for dropdown suggestions (exclude already-selected labels)
  const labelSuggestions = labelConfig.filter(
    (c) =>
      !displayLabels.some((l) => l.toLowerCase() === c.name.toLowerCase()) &&
      c.name.toLowerCase().includes(labelInput.toLowerCase()),
  )

  // Browser beforeunload protection - warn when leaving page with unsaved changes
  useEffect(() => {
    if (!isDirty) return
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      // Modern browsers ignore custom messages but still show a generic prompt
      e.returnValue = 'You have unsaved changes. Are you sure you want to leave?'
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [isDirty])

  return (
    <div className="space-y-3">
      {/* Header section — stacked: metadata on top (full width), priority+actions row below */}
      <div>
        <div className="min-w-0">
          {/* Title: create mode shows always-visible input; edit mode uses click-to-edit */}
          {isCreateMode ? (
            <Textarea
              value={createTitle}
              onChange={(e) => setCreateTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  if (createTitle.trim()) handleCreate()
                }
              }}
              placeholder="What needs to be done?"
              aria-label="Task title"
              className={`-mx-2 max-h-48 min-h-0 resize-none overflow-y-auto px-2 py-1 ${getDetailTitleClasses(createTitle).sizeClass} hover:bg-muted/50 focus:bg-muted/50 rounded-sm border-transparent bg-transparent font-medium shadow-none focus-visible:border-transparent focus-visible:ring-0`}
              rows={1}
              ref={createTitleRef}
            />
          ) : (
            title && (
              <>
                {(onTitleChange || onSaveAll) && editingTitle ? (
                  titleVariant === 'prominent' ? (
                    <Textarea
                      value={titleDraft}
                      onChange={(e) => setTitleDraft(e.target.value)}
                      onBlur={handleTitleSave}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault()
                          handleTitleSave()
                        }
                        if (e.key === 'Escape') setEditingTitle(false)
                      }}
                      className={`-mx-2 max-h-48 min-h-0 resize-none overflow-y-auto px-2 py-1 ${getDetailTitleClasses(titleDraft).sizeClass} hover:bg-muted/50 focus:bg-muted/50 rounded-sm border-transparent bg-transparent font-medium shadow-none focus-visible:border-transparent focus-visible:ring-0`}
                      autoFocus
                    />
                  ) : (
                    <Input
                      type="text"
                      value={titleDraft}
                      onChange={(e) => setTitleDraft(e.target.value)}
                      onBlur={handleTitleSave}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleTitleSave()
                        if (e.key === 'Escape') setEditingTitle(false)
                      }}
                      className="hover:bg-muted/50 focus:bg-muted/50 -mx-2 h-auto rounded-sm border-transparent bg-transparent px-2 py-1 text-sm font-medium shadow-none focus-visible:border-transparent focus-visible:ring-0"
                      autoFocus
                    />
                  )
                ) : (
                  <div className="flex min-w-0 items-start gap-1">
                    {(() => {
                      const detailClasses =
                        titleVariant === 'prominent' ? getDetailTitleClasses(title) : null
                      return (
                        <p
                          className={cn(
                            'font-medium',
                            titleVariant === 'prominent' ? detailClasses!.sizeClass : 'text-sm',
                            detailClasses?.scrollable && 'max-h-32 overflow-y-auto',
                            isTitleDirty
                              ? 'text-blue-500'
                              : onTitleChange || onSaveAll
                                ? 'hover:text-primary cursor-pointer transition-colors'
                                : 'select-text',
                          )}
                          onClick={onTitleChange || onSaveAll ? handleTitleClick : undefined}
                        >
                          {title}
                        </p>
                      )
                    })()}
                  </div>
                )}
              </>
            )
          )}
          {/* Completed badge - shown in popover/inline modes when task is done (hidden in create mode) */}
          {!isCreateMode && showCompletedBadge && effectiveTask?.done && (
            <Badge
              variant="secondary"
              className="mt-1 bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
            >
              Completed
            </Badge>
          )}
          <p className="text-xs select-text">
            {pendingDueAtCleared || (allNoDueDate && !isDateDirty && pendingDueAt === null) ? (
              <span
                className={cn(
                  'font-medium',
                  pendingDueAtCleared ? 'text-blue-500' : 'text-muted-foreground',
                )}
              >
                No due date
              </span>
            ) : (
              <>
                <span
                  className={cn(isDateDirty ? 'font-bold text-blue-500' : 'text-muted-foreground')}
                >
                  {headerText}
                </span>
                <span
                  className={cn(isDateDirty ? 'mx-1 text-blue-500' : 'text-muted-foreground mx-1')}
                >
                  &middot;
                </span>
                <span
                  className={cn(
                    isDateDirty
                      ? 'font-bold text-blue-500'
                      : isPast
                        ? 'text-destructive font-medium'
                        : 'text-muted-foreground',
                  )}
                >
                  {relativeText}
                </span>
                {effectiveDeltaDisplay && (
                  <span className="ml-1 font-medium text-blue-500">({effectiveDeltaDisplay})</span>
                )}
              </>
            )}
          </p>
          {/* Preview of new due_at when changing recurrence - shows what date the task will move to */}
          {previewDueAt && (
            <p className="mt-0.5 text-xs font-medium text-blue-500">
              → {formatDateTime(previewDueAt, timezone)}
            </p>
          )}
          {/* Recurrence summary line (with icon) - only in SelectionActionSheet mode */}
          {isSelectionSheetMode && recurrenceText && (
            <p
              className={cn(
                'mt-0.5 text-xs select-text',
                isRruleDirty ? 'font-medium text-blue-500' : 'text-muted-foreground',
              )}
            >
              <Repeat className="mr-1 inline size-3" />
              {recurrenceText}
            </p>
          )}
          {/* Recurrence inline - for non-SelectionActionSheet modes */}
          {/* Shows "One time" in muted color for non-recurring, or recurrence pattern with icon for recurring */}
          {!isSelectionSheetMode && recurrenceText && (
            <p
              className={cn(
                'mt-1 text-xs select-text',
                isRruleDirty
                  ? 'font-medium text-blue-500'
                  : isOneTime
                    ? 'text-muted-foreground/60'
                    : 'text-muted-foreground',
              )}
            >
              {!isOneTime && <Repeat className="mr-1 inline size-3" />}
              {recurrenceText}
            </p>
          )}
          {/* Project + Priority row */}
          {(effectiveTask || isBulkMode || isCreateMode) && (
            <div className="mt-1 flex items-center gap-1.5">
              {/* Project badge/picker — left-aligned */}
              {(() => {
                const displayProjectObj = projects?.find((p) => p.id === displayProject)
                const displayProjectName =
                  displayProjectObj?.name ?? projectName ?? (isCreateMode ? 'Inbox' : undefined)
                return displayProjectName &&
                  (onProjectChange || onSaveAll || isCreateMode) &&
                  projects &&
                  projects.length > 0 ? (
                  <Popover open={projectPopoverOpen} onOpenChange={setProjectPopoverOpen}>
                    <PopoverTrigger asChild>
                      <button
                        type="button"
                        className={cn(
                          'flex shrink-0 items-center gap-0.5 rounded px-2 py-0.5 text-xs transition-colors',
                          isProjectDirty
                            ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400'
                            : 'bg-muted text-muted-foreground hover:bg-accent active:bg-accent',
                        )}
                      >
                        {displayProjectName}
                        <ChevronDown className="size-3 opacity-50" />
                      </button>
                    </PopoverTrigger>
                    <PopoverContent className="w-48 p-1" align="start">
                      {projects.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          className={cn(
                            'flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm transition-colors',
                            'hover:bg-accent active:bg-accent',
                            displayProject === p.id && 'bg-accent',
                          )}
                          onClick={() => {
                            setPendingProject(p.id)
                            setProjectPopoverOpen(false)
                          }}
                        >
                          <span className="bg-primary size-2 rounded-full" />
                          {p.name}
                        </button>
                      ))}
                    </PopoverContent>
                  </Popover>
                ) : displayProjectName && onMoveToProject ? (
                  <button
                    type="button"
                    onClick={onMoveToProject}
                    className={cn(
                      'flex shrink-0 items-center gap-0.5 rounded px-2 py-0.5 text-xs transition-colors',
                      isProjectDirty
                        ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400'
                        : 'bg-muted text-muted-foreground hover:bg-accent active:bg-accent',
                    )}
                  >
                    {displayProjectName}
                    <ChevronDown className="size-3 opacity-50" />
                  </button>
                ) : displayProjectName ? (
                  <span
                    className={cn(
                      'shrink-0 rounded px-2 py-0.5 text-xs',
                      isProjectDirty
                        ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400'
                        : 'bg-muted text-muted-foreground',
                    )}
                  >
                    {displayProjectName}
                  </span>
                ) : null
              })()}
              {/* Priority picker — after project badge */}
              {onPriorityChange || onSaveAll || isCreateMode ? (
                <Popover open={priorityPopoverOpen} onOpenChange={setPriorityPopoverOpen}>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className={cn(
                        'flex items-center gap-0.5 text-xs font-medium',
                        isMixedPriority
                          ? 'text-muted-foreground'
                          : getPriorityOption(displayPriority).color,
                      )}
                    >
                      {isPriorityDirty && <span className="mr-0.5 text-blue-500">●</span>}
                      {isMixedPriority ? '—' : getPriorityOption(displayPriority).label}
                      <ChevronDown className="size-3 opacity-50" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent className="w-32 p-1" align="start">
                    {PRIORITY_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        className={cn(
                          'flex w-full items-center rounded px-2 py-1.5 text-sm transition-colors',
                          'hover:bg-accent active:bg-accent',
                          opt.color,
                          displayPriority === opt.value && 'bg-accent',
                        )}
                        onClick={() => {
                          setPendingPriority(opt.value)
                          setPriorityPopoverOpen(false)
                        }}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </PopoverContent>
                </Popover>
              ) : (
                <span
                  className={cn(
                    'text-xs font-medium',
                    isMixedPriority
                      ? 'text-muted-foreground'
                      : getPriorityOption(displayPriority).color,
                  )}
                >
                  {isPriorityDirty && <span className="mr-0.5 text-blue-500">●</span>}
                  {isMixedPriority ? '—' : getPriorityOption(displayPriority).label}
                </span>
              )}
            </div>
          )}
          {/* Labels + action icons row */}
          {(effectiveTask || isBulkMode || isCreateMode) && (
            <div className="mt-2 flex flex-wrap items-center gap-1">
              {onLabelsChange || onSaveAll || isCreateMode ? (
                <div ref={labelWrapperRef} className="relative flex flex-wrap items-center gap-1">
                  {displayLabels.map((label) => {
                    const colorClasses = getLabelClasses(label, labelConfig)
                    const isNew = newLabels.has(label)
                    return (
                      <Badge
                        key={label}
                        variant={colorClasses ? undefined : 'secondary'}
                        className={cn(
                          'gap-0.5 pr-1 text-xs',
                          colorClasses && `${colorClasses} border-0`,
                          isNew && 'animate-pulse ring-2 ring-blue-400',
                        )}
                      >
                        {label}
                        <button
                          type="button"
                          onClick={() => removeLabel(label)}
                          className="hover:text-destructive ml-0.5"
                        >
                          <X className="size-3" />
                        </button>
                      </Badge>
                    )
                  })}
                  {isMixedLabels && (
                    <span className="text-muted-foreground text-xs font-medium">—</span>
                  )}
                  <div className="relative">
                    <button
                      type="button"
                      onClick={() => setShowLabelDropdown(true)}
                      className="border-muted-foreground/30 text-muted-foreground/50 hover:border-muted-foreground/50 hover:text-muted-foreground flex size-5 items-center justify-center rounded border border-dashed transition-colors"
                    >
                      <Plus className="size-3" />
                    </button>
                    {showLabelDropdown && (
                      <div className="bg-popover text-popover-foreground absolute top-full left-0 z-50 mt-1 w-40 rounded-md border p-2 shadow-md">
                        <Input
                          type="text"
                          value={labelInput}
                          onChange={(e) => setLabelInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault()
                              if (labelInput.trim()) addLabel(labelInput)
                            }
                            if (e.key === 'Escape') setShowLabelDropdown(false)
                          }}
                          className="h-7 text-xs"
                          placeholder="Add label..."
                          autoFocus
                        />
                        {labelSuggestions.length > 0 && (
                          <div className="mt-1 max-h-32 overflow-y-auto">
                            {labelSuggestions.map((c) => {
                              const colorClasses = getLabelClasses(c.name, labelConfig)
                              return (
                                <button
                                  key={c.name}
                                  type="button"
                                  className="hover:bg-accent active:bg-accent flex w-full items-center gap-2 rounded px-2 py-1 text-sm"
                                  onClick={() => addLabel(c.name)}
                                >
                                  <Badge
                                    variant={colorClasses ? undefined : 'secondary'}
                                    className={cn(
                                      'text-xs',
                                      colorClasses && `${colorClasses} border-0`,
                                    )}
                                  >
                                    {c.name}
                                  </Badge>
                                </button>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <>
                  {displayLabels.map((label) => {
                    const colorClasses = getLabelClasses(label, labelConfig)
                    return (
                      <Badge
                        key={label}
                        variant={colorClasses ? undefined : 'secondary'}
                        className={cn('text-xs', colorClasses && `${colorClasses} border-0`)}
                      >
                        {label}
                      </Badge>
                    )
                  })}
                  {isMixedLabels && (
                    <span className="text-muted-foreground text-xs font-medium">—</span>
                  )}
                </>
              )}
              {/* Action icons — right-aligned */}
              <div className="ml-auto flex shrink-0 items-center gap-1.5">
                {/* Recurrence button - show when onRruleChange, onSaveAll, or createMode is active */}
                {/* Blue pill when recurrence is set (matching auto-snooze style), gray icon when unset */}
                {(onRruleChange || onSaveAll || isCreateMode) &&
                  (displayRrule ? (
                    <button
                      type="button"
                      onClick={handleRecurrenceToggle}
                      className={cn(
                        'flex h-8 shrink-0 items-center rounded-md px-1.5 text-xs transition-colors',
                        editingRecurrence
                          ? 'bg-blue-600 text-white'
                          : 'bg-blue-500 text-white hover:bg-blue-600 active:bg-blue-600',
                      )}
                      aria-label="Recurrence"
                      title="Recurrence"
                    >
                      <Repeat className="size-4" />
                    </button>
                  ) : (
                    <IconButton
                      icon={<Repeat className="size-4" />}
                      label="Recurrence"
                      onClick={handleRecurrenceToggle}
                      active={editingRecurrence}
                    />
                  ))}
                {/* Auto-snooze picker — per-task notification repeat interval */}
                {(() => {
                  const effectiveAutoSnooze =
                    pendingAutoSnooze !== undefined
                      ? pendingAutoSnooze
                      : (effectiveTask?.auto_snooze_minutes ?? null)
                  const isOff = effectiveAutoSnooze === 0
                  const isDefault = effectiveAutoSnooze === null
                  const effectiveMinutes = isDefault
                    ? autoSnoozeDefault
                    : (effectiveAutoSnooze ?? autoSnoozeDefault)
                  // In bulk mode with mixed values, show dash indicator
                  const isMixedAutoSnooze =
                    isBulkMode &&
                    pendingAutoSnooze === undefined &&
                    selectedTasks &&
                    selectedTasks.length > 1 &&
                    !selectedTasks.every(
                      (t) => t.auto_snooze_minutes === selectedTasks[0].auto_snooze_minutes,
                    )

                  return (
                    <AutoSnoozePicker
                      value={effectiveAutoSnooze}
                      userDefault={autoSnoozeDefault}
                      onChange={setPendingAutoSnooze}
                      open={autoSnoozePopoverOpen}
                      onOpenChange={setAutoSnoozePopoverOpen}
                    >
                      {isOff ? (
                        <div>
                          <IconButton
                            icon={<TimerOff className="size-4" />}
                            label="Auto-snooze off"
                            onClick={() => setAutoSnoozePopoverOpen(true)}
                          />
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setAutoSnoozePopoverOpen(true)}
                          className={cn(
                            'flex h-8 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs transition-colors',
                            isDefault
                              ? 'text-muted-foreground/60 hover:bg-accent active:bg-accent'
                              : 'bg-blue-500 text-white hover:bg-blue-600 active:bg-blue-600',
                          )}
                          title={`Auto-snooze: ${isMixedAutoSnooze ? 'mixed' : formatAutoSnoozeLabel(effectiveMinutes)}`}
                        >
                          <Timer className="size-4" />
                          <span>
                            {isMixedAutoSnooze ? '\u2014' : formatAutoSnoozeLabel(effectiveMinutes)}
                          </span>
                        </button>
                      )}
                    </AutoSnoozePicker>
                  )
                })()}
                <IconButton icon={<Bell className="size-4" />} label="Critical alert" disabled />
                {!isCreateMode && onDelete && (
                  <IconButton
                    icon={<Trash2 className="size-4" />}
                    label="Delete"
                    onClick={onDelete}
                    destructive
                  />
                )}

                {/* More menu - consolidates disabled features and task details (hidden in create mode) */}
                {!isCreateMode && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8"
                        aria-label="More options"
                        title="More options"
                      >
                        <MoreHorizontal className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" onCloseAutoFocus={(e) => e.preventDefault()}>
                      {/* Clear due date - only for single task with due_at or rrule */}
                      {isSingleTask &&
                        (effectiveTask?.due_at || effectiveTask?.rrule) &&
                        !pendingDueAtCleared && (
                          <DropdownMenuItem
                            onClick={() => {
                              setPendingDueAtCleared(true)
                              if (effectiveTask?.rrule) {
                                setPendingRrule(null)
                              }
                            }}
                          >
                            <XCircle className="mr-2 size-4" />
                            Clear due date{effectiveTask?.rrule ? ' & recurrence' : ''}
                          </DropdownMenuItem>
                        )}
                      {isSingleTask && onNavigateToDetail && (
                        <DropdownMenuItem onClick={onNavigateToDetail}>
                          <Info className="mr-2 size-4" />
                          Task Details
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 4x3 Date grid */}
      <div className="grid grid-cols-4 gap-1.5">
        {/* Row 1: Preset times */}
        {PRESET_TIMES.map((preset) => (
          <GridButton
            key={preset.label}
            label={preset.label}
            onClick={() => handlePresetClick(preset.hour, preset.minute)}
          />
        ))}

        {/* Row 2: Increments */}
        {INCREMENTS.map((inc) => (
          <GridButton
            key={inc.label}
            label={inc.label}
            onClick={() => handleIncrementClick(inc)}
            variant="increment"
          />
        ))}

        {/* Row 3: Decrements */}
        {DECREMENTS.map((dec) => (
          <GridButton
            key={dec.label}
            label={dec.label}
            onClick={() => handleIncrementClick(dec)}
            variant="decrement"
          />
        ))}

        {/* Row 4: Smart buttons */}
        {SMART_BUTTONS.map((btn) => (
          <GridButton
            key={btn.type}
            label={smartButtonLabels[btn.type]}
            onClick={() => handleSmartButtonClick(btn.type)}
            variant="smart"
            span={2}
          />
        ))}
      </div>

      {/* Expandable recurrence section - shown when recurrence button is clicked */}
      {/* Uses displayRrule (pending or current) and stages changes via setPendingRrule */}
      {editingRecurrence && (onRruleChange || onSaveAll || isCreateMode) && (
        <div className="rounded-lg border p-3">
          <RecurrencePicker
            value={displayRrule}
            recurrenceMode={pendingRecurrenceMode ?? effectiveTask?.recurrence_mode}
            initialTime={effectiveTask?.anchor_time}
            defaultDayOfWeek={defaultDayOfWeek}
            onChange={(rrule, mode) => {
              setPendingRrule(rrule)
              if (mode) setPendingRecurrenceMode(mode)
            }}
          />
        </div>
      )}

      {/* Apply button (inline mode only) */}
      {mode === 'inline' && (
        <Button
          onClick={handleApply}
          disabled={!isDirty || isRecurrenceInvalid}
          className="w-full"
          size="sm"
        >
          Apply
        </Button>
      )}

      {/* Bottom action bar - Save/Reset/Done/Cancel (popover/sheet with explicit handlers) */}
      {mode !== 'inline' && onSave && onCancel && (
        <div className="flex gap-2 border-t pt-3 select-none">
          {isCreateMode ? (
            <Button
              variant="default"
              size="sm"
              onClick={handleCreate}
              disabled={!createTitle.trim() || isRecurrenceInvalid}
              className="flex-1"
            >
              Create Task
            </Button>
          ) : (
            <Button
              variant="default"
              size="sm"
              onClick={handleSave}
              disabled={!isDirty || isRecurrenceInvalid}
              className="flex-1"
            >
              Save
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              handleReset()
              if (isCreateMode) setCreateTitle(initialTitle ?? '')
            }}
            disabled={isCreateMode ? !isDirty && createTitle === (initialTitle ?? '') : !isDirty}
            className="flex-1"
          >
            Reset
          </Button>
          {!isCreateMode && isSingleTask && onMarkDone && !effectiveTask?.done && (
            <Button
              size="sm"
              onClick={handleDoneClick}
              className="flex-1 bg-green-600 text-white hover:bg-green-700 active:bg-green-700"
            >
              <Check className="mr-1 size-4" />
              Done
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={handleCancel} className="flex-1">
            Cancel
          </Button>
        </div>
      )}

      {/* Mark Done confirmation dialog */}
      <AlertDialog open={showDoneConfirm} onOpenChange={setShowDoneConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unsaved Changes</AlertDialogTitle>
            <AlertDialogDescription>
              You have unsaved changes. What would you like to do?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="outline" onClick={handleDiscardAndDone}>
              Discard & Mark Done
            </AlertDialogAction>
            <AlertDialogAction onClick={handleSaveAndDone}>Save & Mark Done</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/** Internal ref-forwarding wrapper for auto-save on dismiss */
QuickActionPanel.displayName = 'QuickActionPanel'

function GridButton({
  label,
  onClick,
  variant = 'preset',
  span = 1,
}: {
  label: string
  onClick: () => void
  variant?: 'preset' | 'increment' | 'decrement' | 'smart'
  span?: 1 | 2
}) {
  // Tiered text sizing: use smaller text for longer labels to prevent overflow.
  // Single-span buttons are narrower and need smaller text sooner.
  const textSize =
    span === 2
      ? label.length <= 20
        ? 'text-sm'
        : 'text-xs'
      : label.length <= 8
        ? 'text-sm'
        : 'text-xs'

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center justify-center rounded-lg border px-2 py-2.5 text-center leading-tight font-medium transition-colors',
        textSize,
        'min-h-[44px]', // Apple HIG touch target
        'active:scale-[0.97]',
        span === 2 && 'col-span-2',
        variant === 'preset' && 'bg-card hover:bg-accent active:bg-accent border-border',
        variant === 'increment' &&
          'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 active:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-400 dark:hover:bg-emerald-950/50 dark:active:bg-emerald-950/50',
        variant === 'decrement' &&
          'border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100 active:bg-amber-100 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-400 dark:hover:bg-amber-950/50 dark:active:bg-amber-950/50',
        variant === 'smart' &&
          'border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 active:bg-blue-100 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-400 dark:hover:bg-blue-950/50 dark:active:bg-blue-950/50',
      )}
    >
      {label}
    </button>
  )
}
