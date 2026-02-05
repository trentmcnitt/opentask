'use client'

import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import {
  Repeat,
  Timer,
  Bell,
  Trash2,
  MoreHorizontal,
  Info,
  Check,
  X,
  Plus,
  ChevronDown,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
  formatSmartButtonTime,
} from '@/lib/quick-select-dates'
import { RRule } from 'rrule'
import { RecurrencePicker } from '@/components/RecurrencePicker'
import { PRIORITY_OPTIONS, getPriorityOption } from '@/lib/priority'
import { useLabelConfig } from '@/components/LabelConfigProvider'
import { getLabelClasses } from '@/lib/label-colors'
import { formatDateTime } from '@/lib/format-date'
import { IconButton } from '@/components/ui/icon-button'
import { computeCommonLabels, computeCommonPriority } from '@/lib/bulk-utils'
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
  due_at?: string
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
  onDateChange: (isoUtc: string) => void
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
  saveRef?: React.MutableRefObject<(() => void) | null>
  /**
   * Batched save callback - when provided, all changes are collected and sent
   * in a single call instead of individual callbacks. This enables atomic saves
   * with a single undo entry. Falls back to individual callbacks if not provided.
   */
  onSaveAll?: (changes: QuickActionPanelChanges) => void
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
}: QuickActionPanelProps) {
  // Effective task: either passed directly, or single selected task via bulk path
  const effectiveTask = task ?? (selectedTasks?.length === 1 ? selectedTasks[0] : null)

  // Bulk mode = multiple tasks selected (not single task via bulk path)
  const isBulkMode = !effectiveTask && (selectedTasks?.length ?? 0) > 0

  // Single task mode (either direct or via bulk selection)
  const isSingleTask = !!effectiveTask

  // State for expandable recurrence picker (inline mode only)
  const [editingRecurrence, setEditingRecurrence] = useState(false)

  // State for title editing
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')

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
    const nowTime = formatSmartButtonTime(snapToNearestFiveMinutes(), timezone)
    const nextHourTime = formatSmartButtonTime(snapToNextHour(), timezone)
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

    try {
      // Compute next occurrence using the pending rrule
      const rule = RRule.fromString(pendingRrule)
      const next = rule.after(new Date())
      return next?.toISOString() ?? null
    } catch {
      // Invalid rrule - don't show preview
      return null
    }
  }, [pendingRrule, effectiveTask])

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
    pendingTitle !== null
  const isDirty = hasDateChanges || hasPendingChanges

  // Notify parent of dirty state changes for navigation protection
  useEffect(() => {
    onDirtyChange?.(isDirty)
  }, [isDirty, onDirtyChange])

  const headerText = isBulkMode ? bulkHook.headerText : singleHook.headerText
  const relativeText = isBulkMode ? bulkHook.relativeText : singleHook.relativeText
  const isPast = isBulkMode ? bulkHook.isPast : singleHook.isPast
  const deltaDisplay = isBulkMode ? bulkHook.deltaDisplay : singleHook.deltaDisplay
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

  // Apply date changes - when onSaveAll provided, stage the change for batched save
  const handleApply = useCallback(() => {
    if (isBulkMode) {
      const result = bulkHook.getResult()
      if (result?.type === 'absolute') {
        onDateChange(result.until)
      } else if (result?.type === 'relative' && onDateChangeRelative) {
        onDateChangeRelative(result.deltaMinutes)
      }
    } else if (onSaveAll) {
      // Stage date change for batched save (single task mode with onSaveAll)
      setPendingDueAt(workingDate)
    } else {
      onDateChange(workingDate)
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
      onDateChange(workingDateRef.current)
    }
    prevOpenRef.current = open
  }, [open, mode, onDateChange, onSave, onCancel])

  const handleSave = useCallback(() => {
    if (onSaveAll) {
      // Batched save mode: collect all changes and send in one call
      const changes: QuickActionPanelChanges = {}

      if (pendingTitle !== null) {
        changes.title = pendingTitle
      }
      if (pendingPriority !== null) {
        changes.priority = pendingPriority
      }
      if (pendingLabels !== null) {
        changes.labels = pendingLabels
      }
      if (pendingRrule !== undefined) {
        changes.rrule = pendingRrule
      }
      if (pendingRecurrenceMode !== null) {
        changes.recurrence_mode = pendingRecurrenceMode
      }
      if (pendingProject !== null) {
        changes.project_id = pendingProject
      }
      // For date changes, use pendingDueAt if staged, otherwise check hook state
      if (pendingDueAt !== null) {
        changes.due_at = pendingDueAt
      } else if (singleHook.isDirty) {
        // Date was changed via hook but not yet staged - include it
        changes.due_at = singleHook.workingDate
      }

      // Only call onSaveAll if there are actual changes
      if (Object.keys(changes).length > 0) {
        onSaveAll(changes)
      }

      // Clear all pending state
      setPendingTitle(null)
      setPendingPriority(null)
      setPendingLabels(null)
      setPendingRrule(undefined)
      setPendingRecurrenceMode(null)
      setPendingProject(null)
      setPendingDueAt(null)
      singleHook.reset()
    } else {
      // Individual callbacks mode (backward compatibility)
      // Apply date changes if any
      if (hasDateChanges) {
        handleApply()
      }
      // Apply all pending field changes
      if (pendingPriority !== null) {
        onPriorityChange?.(pendingPriority)
        setPendingPriority(null)
      }
      if (pendingLabels !== null) {
        onLabelsChange?.(pendingLabels)
        setPendingLabels(null)
      }
      if (pendingRrule !== undefined || pendingRecurrenceMode !== null) {
        // Pass both rrule and recurrence mode - use pending values if set, else current task values
        const rrule = pendingRrule !== undefined ? pendingRrule : (effectiveTask?.rrule ?? null)
        const mode = pendingRecurrenceMode ?? effectiveTask?.recurrence_mode
        onRruleChange?.(rrule, mode)
        setPendingRrule(undefined)
        setPendingRecurrenceMode(null)
      }
      if (pendingProject !== null) {
        onProjectChange?.(pendingProject)
        setPendingProject(null)
      }
    }
    onSave?.()
  }, [
    onSaveAll,
    pendingTitle,
    pendingPriority,
    pendingLabels,
    pendingRrule,
    pendingRecurrenceMode,
    pendingProject,
    pendingDueAt,
    singleHook,
    hasDateChanges,
    handleApply,
    effectiveTask?.rrule,
    effectiveTask?.recurrence_mode,
    onPriorityChange,
    onLabelsChange,
    onRruleChange,
    onProjectChange,
    onSave,
  ])

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
    // Clear all pending changes
    setPendingTitle(null)
    setPendingPriority(null)
    setPendingLabels(null)
    setPendingRrule(undefined)
    setPendingRecurrenceMode(null)
    setPendingProject(null)
    setPendingDueAt(null)
    onCancel?.()
  }, [reset, onCancel])

  // Reset handler for the Reset button - clears all pending changes
  const handleReset = useCallback(() => {
    reset()
    setPendingTitle(null)
    setPendingPriority(null)
    setPendingLabels(null)
    setPendingRrule(undefined)
    setPendingRecurrenceMode(null)
    setPendingProject(null)
    setPendingDueAt(null)
  }, [reset])

  // In sheet mode with selectedCount, SelectionActionSheet owns title and quick-links
  // (SnoozeSheet also uses sheet mode but doesn't pass selectedCount, so it still shows the title)
  const isSelectionSheetMode = mode === 'sheet' && selectedCount !== undefined

  // Compute title:
  // - SelectionActionSheet (sheet mode with selectedCount): hide title, modal shows it
  // - SnoozeSheet (sheet mode without selectedCount): show task title
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
    reset()
    onMarkDone?.()
  }, [reset, onMarkDone])

  const handleSaveAndDone = useCallback(() => {
    setShowDoneConfirm(false)
    if (onSaveAll) {
      // Batched save mode
      const changes: QuickActionPanelChanges = {}
      if (pendingTitle !== null) changes.title = pendingTitle
      if (pendingPriority !== null) changes.priority = pendingPriority
      if (pendingLabels !== null) changes.labels = pendingLabels
      if (pendingRrule !== undefined) changes.rrule = pendingRrule
      if (pendingRecurrenceMode !== null) changes.recurrence_mode = pendingRecurrenceMode
      if (pendingProject !== null) changes.project_id = pendingProject
      if (pendingDueAt !== null) {
        changes.due_at = pendingDueAt
      } else if (singleHook.isDirty) {
        changes.due_at = singleHook.workingDate
      }
      if (Object.keys(changes).length > 0) {
        onSaveAll(changes)
      }
    } else {
      // Individual callbacks mode
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
        const mode = pendingRecurrenceMode ?? effectiveTask?.recurrence_mode
        onRruleChange?.(rrule, mode)
      }
      if (pendingProject !== null) {
        onProjectChange?.(pendingProject)
      }
    }
    onMarkDone?.()
  }, [
    onSaveAll,
    pendingTitle,
    pendingPriority,
    pendingLabels,
    pendingRrule,
    pendingRecurrenceMode,
    pendingProject,
    pendingDueAt,
    singleHook,
    hasDateChanges,
    handleApply,
    effectiveTask?.rrule,
    effectiveTask?.recurrence_mode,
    onPriorityChange,
    onLabelsChange,
    onRruleChange,
    onProjectChange,
    onMarkDone,
  ])

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

  // In SelectionActionSheet mode, the modal header renders quick-links
  // In SnoozeSheet mode (sheet without selectedCount), we still show quick-links here
  const showQuickLinks = !isSelectionSheetMode

  return (
    <div className="space-y-3">
      {/* Header row */}
      <div className={cn('flex justify-between gap-2', title ? 'items-start' : 'items-center')}>
        <div className="min-w-0 flex-1">
          {/* Title: editable when onTitleChange or onSaveAll provided, otherwise static */}
          {title && (
            <>
              {(onTitleChange || onSaveAll) && editingTitle ? (
                <Input
                  type="text"
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onBlur={handleTitleSave}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleTitleSave()
                    if (e.key === 'Escape') setEditingTitle(false)
                  }}
                  className={cn(
                    'h-auto py-1',
                    titleVariant === 'prominent' ? 'text-lg font-semibold' : 'text-sm font-medium',
                  )}
                  autoFocus
                />
              ) : (
                <div className="flex items-center gap-1">
                  <p
                    className={cn(
                      'truncate font-medium',
                      titleVariant === 'prominent' ? 'text-lg' : 'text-sm',
                      onTitleChange || onSaveAll
                        ? 'hover:text-primary cursor-pointer transition-colors'
                        : 'select-text',
                    )}
                    onClick={onTitleChange || onSaveAll ? handleTitleClick : undefined}
                  >
                    {title}
                  </p>
                  {/* Recurring indicator icon next to title (only for single recurring tasks) */}
                  {effectiveTask?.rrule && (
                    <span className="text-muted-foreground flex-shrink-0" title="Recurring">
                      <Repeat className="size-3.5" />
                    </span>
                  )}
                </div>
              )}
            </>
          )}
          {/* Completed badge - shown in popover/inline modes when task is done */}
          {showCompletedBadge && effectiveTask?.done && (
            <Badge
              variant="secondary"
              className="mt-1 bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
            >
              Completed
            </Badge>
          )}
          <p className="text-muted-foreground text-xs select-text">
            <span>{headerText}</span>
            <span className="mx-1">&middot;</span>
            <span className={cn(isPast && 'text-destructive font-medium')}>{relativeText}</span>
          </p>
          {/* Preview of new due_at when changing recurrence - shows what date the task will move to */}
          {previewDueAt && (
            <p className="mt-0.5 text-xs font-medium text-blue-500">
              → {formatDateTime(previewDueAt, timezone)}
            </p>
          )}
          {/* Recurrence summary line (with icon) - only in SelectionActionSheet mode */}
          {isSelectionSheetMode && recurrenceText && (
            <p className="text-muted-foreground mt-0.5 text-xs select-text">
              <Repeat className="mr-1 inline size-3" />
              {recurrenceText}
            </p>
          )}
          {/* Recurrence inline (without icon) - for non-SelectionActionSheet modes */}
          {/* Shows "One time" in muted color for non-recurring, or recurrence pattern for recurring */}
          {!isSelectionSheetMode && recurrenceText && (
            <p
              className={cn(
                'mt-1 text-xs select-text',
                isOneTime ? 'text-muted-foreground/60' : 'text-muted-foreground',
              )}
            >
              {recurrenceText}
            </p>
          )}
          {/* Staged delta indicator - show in blue when dirty with delta operation */}
          {deltaDisplay && (
            <p className="mt-0.5 text-xs font-medium text-blue-500">{deltaDisplay}</p>
          )}
          {/* Priority & Labels row - show for single task and bulk mode */}
          {(effectiveTask || isBulkMode) && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {/* Priority picker (clickable) - plain text styling for alignment */}
              {/* Show picker when onPriorityChange OR onSaveAll is provided */}
              {onPriorityChange || onSaveAll ? (
                <Popover open={priorityPopoverOpen} onOpenChange={setPriorityPopoverOpen}>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className={cn(
                        'flex items-center gap-0.5 text-xs font-medium',
                        getPriorityOption(displayPriority).color,
                      )}
                    >
                      {getPriorityOption(displayPriority).label}
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
                          'hover:bg-accent',
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
                  className={cn('text-xs font-medium', getPriorityOption(displayPriority).color)}
                >
                  {getPriorityOption(displayPriority).label}
                </span>
              )}

              {/* Labels with inline editing - uses displayLabels (pending or current) */}
              {/* Show editable labels when onLabelsChange OR onSaveAll is provided */}
              {onLabelsChange || onSaveAll ? (
                <div ref={labelWrapperRef} className="relative flex flex-wrap items-center gap-1">
                  {displayLabels.map((label) => {
                    const colorClasses = getLabelClasses(label, labelConfig)
                    return (
                      <Badge
                        key={label}
                        variant={colorClasses ? undefined : 'secondary'}
                        className={cn(
                          'gap-0.5 pr-1 text-xs',
                          colorClasses && `${colorClasses} border-0`,
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
                  {/* Add label button with inline input */}
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
                                  className="hover:bg-accent flex w-full items-center gap-2 rounded px-2 py-1 text-sm"
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
                /* Read-only labels - use displayLabels for consistency */
                displayLabels.map((label) => {
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
                })
              )}
            </div>
          )}
        </div>

        {/* Action icons - only show when not in sheet mode */}
        {showQuickLinks && (
          <div className="flex items-center gap-1.5">
            {/* Project badge with optional picker - inline popover or external picker */}
            {/* Show display project name (pending or current from prop) */}
            {(() => {
              const displayProjectObj = projects?.find((p) => p.id === displayProject)
              const displayProjectName = displayProjectObj?.name ?? projectName
              return displayProjectName && onProjectChange && projects && projects.length > 0 ? (
                // Inline popover with project list
                <Popover open={projectPopoverOpen} onOpenChange={setProjectPopoverOpen}>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className="bg-muted text-muted-foreground hover:bg-accent flex shrink-0 items-center gap-0.5 rounded px-2 py-0.5 text-xs transition-colors"
                    >
                      {displayProjectName}
                      <ChevronDown className="size-3 opacity-50" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent className="w-48 p-1" align="end">
                    {projects.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        className={cn(
                          'flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm transition-colors',
                          'hover:bg-accent',
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
                // Clickable badge that opens external picker
                <button
                  type="button"
                  onClick={onMoveToProject}
                  className="bg-muted text-muted-foreground hover:bg-accent flex shrink-0 items-center gap-0.5 rounded px-2 py-0.5 text-xs transition-colors"
                >
                  {displayProjectName}
                  <ChevronDown className="size-3 opacity-50" />
                </button>
              ) : displayProjectName ? (
                // Read-only badge
                <span className="bg-muted text-muted-foreground shrink-0 rounded px-2 py-0.5 text-xs">
                  {displayProjectName}
                </span>
              ) : null
            })()}
            {/* Recurrence button - show when onRruleChange or onSaveAll is provided */}
            {(onRruleChange || onSaveAll) && (
              <IconButton
                icon={<Repeat className="size-4" />}
                label="Recurrence"
                onClick={handleRecurrenceToggle}
                active={editingRecurrence}
              />
            )}
            {/* Disabled stubs - always visible as separate buttons */}
            <IconButton icon={<Timer className="size-4" />} label="Auto-snooze interval" disabled />
            <IconButton icon={<Bell className="size-4" />} label="Critical alert" disabled />
            {onDelete && (
              <IconButton
                icon={<Trash2 className="size-4" />}
                label="Delete"
                onClick={onDelete}
                destructive
              />
            )}

            {/* More menu - show when task details available */}
            {isSingleTask && onNavigateToDetail && (
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
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={onNavigateToDetail}>
                    <Info className="mr-2 size-4" />
                    Task Details
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        )}
      </div>

      {/* 4x3 Date grid */}
      <div className="grid grid-cols-4 gap-1.5">
        {/* Row 1: Preset times */}
        {PRESET_TIMES.map((preset) => (
          <GridButton
            key={preset.label}
            label={preset.label}
            onClick={() => applyPreset(preset.hour, preset.minute)}
          />
        ))}

        {/* Row 2: Increments */}
        {INCREMENTS.map((inc) => (
          <GridButton
            key={inc.label}
            label={inc.label}
            onClick={() => applyIncrement(inc)}
            variant="increment"
          />
        ))}

        {/* Row 3: Decrements */}
        {DECREMENTS.map((dec) => (
          <GridButton
            key={dec.label}
            label={dec.label}
            onClick={() => applyIncrement(dec)}
            variant="decrement"
          />
        ))}

        {/* Row 4: Smart buttons */}
        {SMART_BUTTONS.map((btn) => (
          <GridButton
            key={btn.type}
            label={smartButtonLabels[btn.type]}
            onClick={() => handleSmartButton(btn.type)}
            variant="smart"
            span={2}
          />
        ))}
      </div>

      {/* Expandable recurrence section - shown when recurrence button is clicked */}
      {/* Uses displayRrule (pending or current) and stages changes via setPendingRrule */}
      {editingRecurrence && (onRruleChange || onSaveAll) && (
        <div className="rounded-lg border p-3">
          <RecurrencePicker
            value={displayRrule}
            recurrenceMode={pendingRecurrenceMode ?? effectiveTask?.recurrence_mode}
            initialTime={effectiveTask?.anchor_time}
            onChange={(rrule, mode) => {
              setPendingRrule(rrule)
              if (mode) setPendingRecurrenceMode(mode)
            }}
          />
        </div>
      )}

      {/* Apply button (inline mode only) */}
      {mode === 'inline' && (
        <Button onClick={handleApply} disabled={!isDirty} className="w-full" size="sm">
          Apply
        </Button>
      )}

      {/* Bottom action bar - Save/Reset/Done/Cancel (popover/sheet with explicit handlers) */}
      {mode !== 'inline' && onSave && onCancel && (
        <div className="flex gap-2 border-t pt-3">
          <Button
            variant="default"
            size="sm"
            onClick={handleSave}
            disabled={!isDirty}
            className="flex-1"
          >
            Save
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleReset}
            disabled={!isDirty}
            className="flex-1"
          >
            Reset
          </Button>
          {isSingleTask && onMarkDone && !effectiveTask?.done && (
            <Button
              size="sm"
              onClick={handleDoneClick}
              className="flex-1 bg-green-600 text-white hover:bg-green-700"
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
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-lg border px-2 py-2.5 text-center text-sm font-medium transition-colors',
        'min-h-[44px]', // Apple HIG touch target
        'whitespace-nowrap', // Prevent "12:00 PM" from wrapping on narrow screens
        'active:scale-[0.97]',
        span === 2 && 'col-span-2',
        variant === 'preset' && 'bg-card hover:bg-accent border-border',
        variant === 'increment' &&
          'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-400 dark:hover:bg-emerald-950/50',
        variant === 'decrement' &&
          'border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-400 dark:hover:bg-amber-950/50',
        variant === 'smart' &&
          'border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-400 dark:hover:bg-blue-950/50',
      )}
    >
      {label}
    </button>
  )
}
