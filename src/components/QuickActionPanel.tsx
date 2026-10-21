'use client'

import { targetReset, type HorizonValue } from '@/lib/task-segments'
import { HorizonPicker } from '@/components/HorizonDot'
import { BACK_TO_AUTO, TARGET_WORD } from '@/lib/task-model-words'
import { TaskModelFields } from '@/components/TaskModelFields'
import { OnDeckLine } from '@/components/quick-panel/OnDeckLine'
import { deckLimit } from '@/lib/deck-menu'
import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import {
  Repeat,
  Timer,
  TimerOff,
  Trash2,
  MoreHorizontal,
  Info,
  Check,
  X,
  Plus,
  ChevronDown,
  XCircle,
  RotateCcw,
  Sparkles,
  CalendarDays,
  Mic,
  Lightbulb,
  SkipForward,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
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
import { showToast } from '@/lib/toast'
import { useQuickSelectDate } from '@/hooks/useQuickSelectDate'
import { useBulkQuickSelectDate } from '@/hooks/useBulkQuickSelectDate'
import { useSpeechRecognition } from '@/hooks/useSpeechRecognition'
import { useStagedEditor } from '@/hooks/useStagedEditor'
import { formatRRuleCompact, formatBulkRecurrence } from '@/lib/format-rrule'
import {
  PRESET_TIMES,
  INCREMENTS,
  DECREMENTS,
  SMART_BUTTONS,
  snapToNearestFiveMinutes,
  snapToNextHour,
  formatQuickSelectHeader,
} from '@/lib/quick-select-dates'
import { RecurrencePicker } from '@/components/RecurrencePicker'
import { computeRecurrencePreview } from '@/lib/recurrence-preview'
import { DateTime } from 'luxon'
import { PRIORITY_OPTIONS, getPriorityOption } from '@/lib/priority'
import {
  useLabelConfig,
  useAutoSnoozeDefault,
  useSnoozePreferences,
  useTaskQueue,
} from '@/components/PreferencesProvider'
import { getLabelClasses } from '@/lib/label-colors'
import { formatDateTime, formatTaskSince, formatTimeInTimezone } from '@/lib/format-date'
import { IconButton } from '@/components/ui/icon-button'
import { AutoSnoozePicker, formatAutoSnoozeLabel } from '@/components/AutoSnoozePicker'
import { computeCommonLabels, computeCommonPriority, hasLabelVariations } from '@/lib/bulk-utils'
import { DateTimePicker } from '@/components/DateTimePicker'
import { isPickedReschedule } from '@/lib/picked-reschedule'
import { isTracked } from '@/lib/track'
import { GridButton } from '@/components/quick-panel/GridButton'
import { SinceAge } from '@/components/quick-panel/SinceAge'
import { NotesInlineSection } from '@/components/quick-panel/NotesInlineSection'
import {
  RecurrenceSummaryLine,
  RECURRENCE_EDITOR_ID,
} from '@/components/quick-panel/RecurrenceSummaryLine'
import { AutoTargetText } from '@/components/quick-panel/AutoTargetText'
import { SkipUntilDialog } from '@/components/SkipUntilDialog'
import { canSkipUntil } from '@/lib/skip-until'
import {
  deadlineDayPick,
  deadlineRepeatLabel,
  movedOccurrenceLabel,
  pickerBaseDueAt,
  queuedRepeatOccurrence,
  repeatButtonState,
  stagedAutoTarget,
} from '@/lib/editor-target-labels'
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
 *
 * Bulk-only fields (emitted when the panel is mounted in multi-select bulk mode):
 * - `delta_minutes`: relative snooze in minutes, used with bulk snooze endpoint.
 *   The panel converts relative deltas to an absolute `due_at` for single-task
 *   saves, so `delta_minutes` is only ever produced when `selectedTasks.length > 1`.
 * - `labels_add` / `labels_remove`: additive label diffs, used by bulk edit so
 *   labels not in the common intersection are preserved on individual tasks.
 */
export interface QuickActionPanelChanges {
  title?: string
  priority?: number
  labels?: string[]
  labels_add?: string[]
  labels_remove?: string[]
  rrule?: string | null
  recurrence_mode?: 'from_due' | 'from_completion'
  project_id?: number
  due_at?: string | null
  delta_minutes?: number
  auto_snooze_minutes?: number | null
  reset_original_due_at?: boolean
  notes?: string | null
  /** §6: move this item on/off the Reminders surface. Single-task only. */
  is_reminder?: boolean
  /** Task model (2026-10-10). Single-task only. */
  deadline_at?: string | null
  horizon?: HorizonValue | null
  /** On deck (D2): a yyyy-MM-dd day, or null = off deck. Single-task only. */
  on_deck_day?: string | null
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
  /** Layout host: a desktop popover/dialog or a mobile sheet. Both show the Save/Reset/Cancel footer. */
  mode: 'popover' | 'sheet'
  /** Available projects for the project picker popover */
  projects?: Project[]
  /** Called to delete task(s) */
  onDelete?: () => void
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
  /** Show Completed badge when task.done is true */
  showCompletedBadge?: boolean
  /** Called when user marks task as done (single task only, popover mode) */
  onMarkDone?: () => void
  /**
   * Skip until (task queue PR 4): skip this occurrence (`until` null) or every
   * one before a day. Single repeating task only; offered in the More menu
   * when provided. An action, like Done — not a staged field. Rejects on a
   * failure (already toasted), which keeps the picker open.
   */
  onSkipUntil?: (until: string | null) => Promise<void>
  /** Project name to display as badge next to title */
  projectName?: string
  /** Called when dirty state changes (for navigation protection in parent) */
  onDirtyChange?: (isDirty: boolean) => void
  /** Ref populated with save function for external triggering (e.g., from navigation dialog) */
  saveRef?: React.MutableRefObject<(() => Promise<void> | void) | null>
  /**
   * Batched save callback: all staged changes are collected and sent in a single
   * call, so the save is atomic with a single undo entry. Editing an existing task
   * needs it; without it (and outside create mode) the fields render read-only.
   */
  onSaveAll?: (changes: QuickActionPanelChanges) => void | Promise<void>
  /** AI annotation text to display (e.g., What's Next recommendation reason) */
  annotation?: string
  /** AI Insights commentary text to display */
  insightsCommentary?: string
  /** Enables create mode — panel is used for new task creation instead of editing */
  createMode?: boolean
  /** Pre-fills title in create mode (from QuickAdd "+" button) */
  initialTitle?: string
  /** Called on submit in create mode with all staged fields including title */
  onCreate?: (fields: QuickActionPanelChanges & { title: string }) => void | Promise<void>
}

/** The panel's staged fields, one dirty flag each (see `fieldDirty` in QuickActionPanel). */
type DirtyField =
  | 'date'
  | 'title'
  | 'priority'
  | 'labels'
  | 'rrule'
  | 'recurrenceMode'
  | 'project'
  | 'dueAtCleared'
  | 'autoSnooze'
  | 'isReminder'
  | 'notes'
  | 'deadline'
  | 'horizon'
  | 'deck'

/**
 * The fields that make create mode dirty (besides the title, which is compared
 * against initialTitle on its own). recurrenceMode, isReminder and dueAtCleared
 * are deliberately left out: create mode has never counted them as a
 * change from its defaults, and this list keeps that membership as it was.
 */
const CREATE_MODE_DIRTY_FIELDS: readonly DirtyField[] = [
  'deadline',
  'horizon',
  'priority',
  'labels',
  'rrule',
  'project',
  'date',
  'autoSnooze',
  'notes',
]

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
  projects,
  onDelete,
  onCancel,
  onSave,
  onNavigateToDetail,
  recurrenceSummary,
  titleVariant = 'compact',
  showCompletedBadge = false,
  onMarkDone,
  onSkipUntil,
  projectName,
  onDirtyChange,
  saveRef,
  onSaveAll,
  annotation,
  insightsCommentary,
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

  // Whether the fields are editable: a batched-save host (onSaveAll) or create mode.
  // Otherwise project, priority, labels and recurrence render read-only.
  const canEdit = !!onSaveAll || isCreateMode

  // State for expandable recurrence picker
  const [editingRecurrence, setEditingRecurrence] = useState(false)

  // State for title editing
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')

  // State for create-mode title (always-visible input, not click-to-edit)
  const [createTitle, setCreateTitle] = useState(initialTitle ?? '')

  // Speech recognition for create mode title dictation.
  // Base title is snapshotted in the mic button click handler (not in the effect).
  const speech = useSpeechRecognition()
  const speechPrevListeningRef = useRef(false)
  const titleBeforeSpeechRef = useRef('')

  useEffect(() => {
    if (!isCreateMode) return

    if (speech.isListening && speech.transcript) {
      const base = titleBeforeSpeechRef.current
      const separator = base && !base.endsWith(' ') ? ' ' : ''
      setCreateTitle(base + separator + speech.transcript)
    }

    if (!speech.isListening && speechPrevListeningRef.current) {
      createTitleRef.current?.focus()
    }

    speechPrevListeningRef.current = speech.isListening
  }, [speech.isListening, speech.transcript, isCreateMode])

  // Surface speech recognition errors as toasts
  useEffect(() => {
    if (speech.error) {
      showToast({ message: speech.error, type: 'error' })
    }
  }, [speech.error])

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
  const { morningTime } = useSnoozePreferences()

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
  // pendingDueAt is set only in create mode: an explicit override where the hook's dirty
  // detection fails (see handleSmartButtonClick). Edit mode stages the date in the hook.
  const [pendingDueAt, setPendingDueAt] = useState<string | null>(null)
  // pendingDueAtCleared tracks when user wants to clear the due date (and recurrence)
  const [pendingDueAtCleared, setPendingDueAtCleared] = useState(false)
  // pendingAutoSnooze: undefined = no change, null = default, 0 = off, positive = custom
  const [pendingAutoSnooze, setPendingAutoSnooze] = useState<number | null | undefined>(undefined)
  const [autoSnoozePopoverOpen, setAutoSnoozePopoverOpen] = useState(false)
  // pendingDatePicked: the staged date came from the date PICKER, not a snooze
  // button. The save sends reset_original_due_at with it. Since 2026-10-12 (§6)
  // the server ignores that on a task — a move is a move — but a REMINDER still
  // needs it: a picked date is its explicit reschedule (a bare date move of a
  // dated reminder is refused). Any preset / increment / Now / Next Hour tap
  // after the pick clears it.
  const [pendingDatePicked, setPendingDatePicked] = useState(false)
  // pendingIsReminder: null = no change, boolean = staged flag (§6 Reminders surface)
  const [pendingIsReminder, setPendingIsReminder] = useState<boolean | null>(null)
  // pendingNotes: undefined = no change, null = clear, string = new value
  const [pendingNotes, setPendingNotes] = useState<string | null | undefined>(undefined)
  const [notesExpanded, setNotesExpanded] = useState(false)
  // Task model (2026-10-10): undefined = no change, null = clear.
  const [pendingDeadline, setPendingDeadline] = useState<string | null | undefined>(undefined)
  const [pendingHorizon, setPendingHorizon] = useState<HorizonValue | null | undefined>(undefined)
  // On deck (D2, `OnDeckLine`): undefined = no change, null = off deck, else a day.
  const [pendingDeck, setPendingDeck] = useState<string | null | undefined>(undefined)

  // Single task mode hook. A repeating task waiting in the task queue
  // (2026-10-20, `queuedRepeatOccurrence`, with the queue switch on) has no
  // live target: its label is the occurrence it stands for, but the controls
  // (increments, the "(+N)" delta, the pickers) start from NOW, as for a task
  // with no target (`pickerBaseDueAt`) — never from the missed occurrence
  // ("+1 day" would stage a past date) or the moved target. Any staged date
  // is a picked target, which takes the task out of the queue.
  const { enabled: queueEnabled, attemptsRolloverTime: rolloverTime } = useTaskQueue()
  const queuedOccurrence =
    effectiveTask && !isCreateMode && queueEnabled ? queuedRepeatOccurrence(effectiveTask) : null
  const dueAt = effectiveTask ? pickerBaseDueAt(effectiveTask, queueEnabled) : null
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
  // §6 Reminders flag — staged value wins, otherwise the task's stored flag.
  const displayIsReminder = pendingIsReminder ?? effectiveTask?.is_reminder ?? false
  // Reminders and quotas carry no deadline or horizon (2026-10-10).
  const isReminderLike = displayIsReminder || (effectiveTask ? isTracked(effectiveTask) : false)

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

  // The recurrence picker's starting time — the server's own order for a rule
  // sent without one (`ruleTimeFor`, 2026-10-12): the task's anchor, else its
  // date's time (a one-off at 3 PM made repeating keeps 3 PM), else the user's
  // Morning time. Every repeating task has a time; the picker always writes one.
  const recurrenceInitialTime =
    effectiveTask?.anchor_time ??
    (effectiveTask?.due_at
      ? DateTime.fromISO(effectiveTask.due_at).setZone(timezone).toFormat('HH:mm')
      : morningTime)

  // Per-field dirty flags, one per staged field. Each drives that field's blue
  // "modified" indicator; fieldDirty below combines them into the panel's dirty
  // state (Save and Reset enablement, and the unsaved-changes guards).
  //
  // They stay plain locals (not reads off fieldDirty) on purpose: the React
  // Compiler can't tell a property read is a primitive, so a flag read off the
  // object and then passed to cn() in the JSX would count as a possible mutation
  // of the object and make it skip the useMemo/useCallback hooks that depend on
  // these flags.
  //
  // Date: in bulk mode (multi-select OR single-task-via-selection-sheet), the bulk
  // hook owns staging. In create mode a date can also be staged via pendingDueAt,
  // the explicit override for when the hook's dirty detection misses it (see
  // handleSmartButtonClick); in edit mode the hook alone tracks the date.
  const hasDateChanges = isBulkMode
    ? bulkHook.isDirty
    : isCreateMode
      ? pendingDueAt !== null || singleHook.isDirty
      : singleHook.isDirty
  // Title is dirty if staged (pendingTitle) OR if the user is mid-edit with changes.
  // Without the mid-edit check, clicking outside the dialog while typing in the title
  // field bypasses the unsaved-changes confirmation because pendingTitle is only set on
  // blur. (Create mode's title is createTitle, compared separately below.)
  const isTitleDirty =
    pendingTitle !== null || (editingTitle && titleDraft.trim() !== (effectiveTask?.title ?? ''))
  const isPriorityDirty = pendingPriority !== null
  const isLabelsDirty = pendingLabels !== null
  const isRruleDirty = pendingRrule !== undefined
  const isProjectDirty = pendingProject !== null
  const isReminderDirty = pendingIsReminder !== null
  const fieldDirty: Record<DirtyField, boolean> = {
    date: hasDateChanges,
    title: isTitleDirty,
    priority: isPriorityDirty,
    labels: isLabelsDirty,
    rrule: isRruleDirty,
    recurrenceMode: pendingRecurrenceMode !== null,
    project: isProjectDirty,
    dueAtCleared: pendingDueAtCleared,
    autoSnooze: pendingAutoSnooze !== undefined,
    isReminder: isReminderDirty,
    notes: pendingNotes !== undefined,
    deadline: pendingDeadline !== undefined,
    horizon: pendingHorizon !== undefined,
    deck: pendingDeck !== undefined,
  }
  // Edit mode: any staged field at all.
  const hasPendingChanges = Object.values(fieldDirty).some(Boolean)
  // Create mode, non-title fields only (see CREATE_MODE_DIRTY_FIELDS) — controls the
  // Reset button, since the title is preserved on reset.
  const createModeNonTitleDirty =
    isCreateMode && CREATE_MODE_DIRTY_FIELDS.some((field) => fieldDirty[field])
  // In create mode, dirty means the user has changed something from the initial defaults:
  // typed a title (different from initialTitle), changed any field, or picked a date.
  const createModeDirty =
    isCreateMode && (createTitle.trim() !== (initialTitle ?? '').trim() || createModeNonTitleDirty)
  const isDirty = isCreateMode ? createModeDirty : hasPendingChanges

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

  const headerText = isBulkMode ? bulkHook.headerText : singleHook.headerText
  const relativeText = isBulkMode ? bulkHook.relativeText : singleHook.relativeText
  // §6: a reminder is never late. Its time of day says where the thought
  // belongs, not a deadline it can miss — so the editor never paints one in the
  // overdue red that the Reminders surface itself refuses to use. The time is
  // still shown; only the alarm is dropped.
  const isPast = (isBulkMode ? bulkHook.isPast : singleHook.isPast) && !displayIsReminder
  const deltaDisplay = isBulkMode ? bulkHook.deltaDisplay : singleHook.deltaDisplay

  // Whether the date specifically has changed — used for blue styling on the due date line.
  // Same rule as hasDateChanges: create mode also honors the pendingDueAt override, while
  // edit mode reads the hook, whose dirty detection works there (initial = task's due_at).
  const isDateDirty = isCreateMode
    ? pendingDueAt !== null || singleHook.isDirty
    : isBulkMode
      ? bulkHook.isDirty
      : singleHook.isDirty

  // Track which labels are newly added (not in original set) for per-label dirty indicators
  const newLabels = useMemo(() => {
    if (!isLabelsDirty) return new Set<string>()
    const origLabels = effectiveTask?.labels ?? (isBulkMode ? bulkCommonLabels : [])
    const origSet = new Set(origLabels.map((l) => l.toLowerCase()))
    return new Set(displayLabels.filter((l) => !origSet.has(l.toLowerCase())))
  }, [isLabelsDirty, effectiveTask?.labels, isBulkMode, bulkCommonLabels, displayLabels])

  // Whether ALL tasks genuinely have no due date — used for the "No due date" display.
  // In bulk mode, only show "No due date" when every task lacks a date.
  const allNoDueDate = isBulkMode
    ? (selectedTasks ?? []).every((t) => !t.due_at)
    : !effectiveTask?.due_at

  // The target line's "no target" state: a target staged for removal, or none
  // stored and none picked.
  // ON DECK (D2, rule 1): a deck staged with no target staged after it
  // (`deckShadowed`) drops a picked target on Save, so the line shows it gone.
  const deckShadowed = isDateDirty || pendingDueAtCleared
  const deckStaged = typeof pendingDeck === 'string' && !deckShadowed
  const showsNoTarget =
    pendingDueAtCleared || deckStaged || (allNoDueDate && !isDateDirty && pendingDueAt === null)

  // A DEADLINE ALWAYS HAS A VISIBLE TARGET (§8, 2026-10-12): the target line
  // labels a deadline's automatic target "auto · Tue, Oct 20, 9:00 AM (3 days
  // before deadline)", read with the STAGED values so it shows what Save would
  // produce — see `stagedAutoTarget`.
  const { label: autoTarget, staged: autoTargetStaged } =
    isBulkMode || isReminderLike || displayRrule
      ? { label: null, staged: false }
      : stagedAutoTarget(
          effectiveTask,
          {
            pendingDeadline,
            targetCleared: pendingDueAtCleared || deckStaged,
            datePicked: isDateDirty,
          },
          timezone,
        )
  // The … menu's target reset (§8.3, ruling Q9): "Remove target", "Back to
  // auto" (a deadline one-off whose target the user picked), or nothing (an
  // automatic target, or no target). A repeating task's target goes with its
  // recurrence ("Remove target & recurrence").
  // The target picker's "Deadline day" (ruling Q8): single task, deadline ahead.
  const pickerDeadlineDay = isBulkMode
    ? null
    : deadlineDayPick(
        pendingDeadline !== undefined ? pendingDeadline : effectiveTask?.deadline_at,
        { timezone, morningTime },
      )
  const movedOccurrence =
    !isBulkMode && !isCreateMode && effectiveTask && !isDateDirty && !isRruleDirty
      ? movedOccurrenceLabel(effectiveTask, timezone)
      : null
  const singleTargetReset: 'auto' | 'remove' | null = !effectiveTask
    ? null
    : effectiveTask.rrule
      ? 'remove'
      : targetReset(effectiveTask)

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

  // ON DECK (D2): staging a deck drops a staged target (rule 1 — a task has
  // one or the other); a target staged after it wins (`deckShadowed`). A
  // repeating task shows the line too (2026-10-20: the deck is for its current
  // occurrence) — but never while a recurrence change is staged: a new rule
  // schedules its own date, and the server refuses a rule with a deck.
  const showDeckLine =
    queueEnabled &&
    !isBulkMode &&
    !isCreateMode &&
    !isReminderLike &&
    !isRruleDirty &&
    !!effectiveTask &&
    !effectiveTask.done
  // A deck staged while the line is shown, then hidden (a recurrence or the
  // Reminder toggle staged after it): the deck goes too — never sent for a
  // task that can't be on deck, nor with a rule (adjusted during render, not
  // in an effect).
  if (!showDeckLine && pendingDeck !== undefined) setPendingDeck(undefined)
  // `clearTarget`: the deck wins over a staged target (a tap on the line, or
  // the hold menu's stored day, after a target was staged — review #3).
  const stageDeck = useCallback(
    (day: string | null | undefined, clearTarget: boolean) => {
      if (clearTarget) {
        setPendingDueAt(null)
        setPendingDueAtCleared(false)
        setPendingDatePicked(false)
        reset()
      }
      setPendingDeck(day)
    },
    [reset],
  )
  // The hold menu's A1 limit from a STAGED deadline (`deckLimit`); with none
  // staged, the button works it out from the task.
  const stagedDeckLimit =
    pendingDeadline !== undefined && effectiveTask
      ? deckLimit(
          { deadline_at: pendingDeadline, due_at: null, rrule: effectiveTask.rrule },
          timezone,
          new Date(),
          null,
          rolloverTime,
        )
      : undefined

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
      setPendingDueAt(null)
      setPendingDatePicked(false)
      applyPreset(hour, minute)
    },
    [applyPreset],
  )

  const handleIncrementClick = useCallback(
    (inc: { minutes: number | null; days?: number }) => {
      setPendingDueAtCleared(false)
      setPendingDueAt(null)
      setPendingDatePicked(false)
      applyIncrement(inc)
    },
    [applyIncrement],
  )

  const handleSmartButtonClick = useCallback(
    (type: 'now' | 'nextHour') => {
      setPendingDueAtCleared(false)
      setPendingDatePicked(false)
      // In create mode, "Now" can produce the same value as initWorkingDate(null)
      // (both call snapToNearestFiveMinutes), so the hook's isDirty stays false.
      // Explicitly set pendingDueAt to ensure the date is staged and displayed.
      if (isCreateMode) {
        const isoUtc = type === 'now' ? snapToNearestFiveMinutes() : snapToNextHour()
        setPendingDueAt(isoUtc)
      }
      handleSmartButton(type)
    },
    [handleSmartButton, isCreateMode],
  )

  // Single-task date picker: a picked date is a reschedule (pendingDatePicked →
  // reset_original_due_at on save); Clear drops the date and any recurrence.
  const handleSinglePickerChange = useCallback(
    (isoUtc: string | null) => {
      if (isoUtc === null) {
        setPendingDueAtCleared(true)
        setPendingDueAt(null)
        setPendingDatePicked(false)
        if (effectiveTask?.rrule || pendingRrule) {
          setPendingRrule(null)
        }
      } else {
        setPendingDueAtCleared(false)
        // In create mode, the hook's initial date is a synthetic snap-to-now value,
        // so a calendar pick matching it would leave isDirty false. Use pendingDueAt
        // as an explicit override (same pattern as smart buttons).
        setPendingDueAt(isCreateMode ? isoUtc : null)
        setPendingDatePicked(true)
        singleHook.setWorkingDate(isoUtc)
      }
    },
    [effectiveTask?.rrule, pendingRrule, isCreateMode, singleHook],
  )

  // Multi-task "clear due date" (the date picker's Clear and the "…" menu item).
  // collectPendingChanges sends `{ due_at: null, rrule: null }` — a cleared date
  // takes the recurrence with it, as in single mode — which bulk/edit applies to
  // every selected task in one undo entry. Not offered when:
  // - a quota is selected: a quota must keep its period, so `rrule: null` would
  //   make the server refuse the WHOLE batch (QUOTA_PERIOD_MESSAGE);
  // - no selected task has a date or a recurrence: there is nothing to clear.
  const bulkTasks = selectedTasks ?? []
  const canBulkClearDueDate =
    isBulkMode &&
    !bulkTasks.some((t) => isTracked(t)) &&
    bulkTasks.some((t) => t.due_at !== null || t.rrule !== null)
  const bulkHasRecurrence = isBulkMode && bulkTasks.some((t) => t.rrule !== null)

  // The "…" menu's items: Clear due date (single or multi), Reminder and Task
  // Details (single only). The menu renders only when at least one applies.
  const showBulkClearItem = canBulkClearDueDate && !pendingDueAtCleared
  const hasMoreMenuItems = isSingleTask || showBulkClearItem

  // Skip until (task queue PR 4): a single repeating task, when the host offers it.
  const [skipUntilOpen, setSkipUntilOpen] = useState(false)
  const showSkipUntil =
    !isCreateMode && !!onSkipUntil && !!effectiveTask && canSkipUntil(effectiveTask)

  const handleBulkClearDueDate = useCallback(() => {
    bulkHook.reset()
    setPendingDueAtCleared(true)
  }, [bulkHook])

  // Multi-task date picker: the picked moment becomes every selected task's due
  // date — an absolute target staged in the bulk hook, saved exactly like the
  // grid's absolute presets (9:00 AM, Now…). Deliberately NOT a reschedule
  // (no reset_original_due_at, unlike single mode): bulk/edit would apply that
  // flag to every selected task, including ones the "Confirm date change"
  // dialog opted out of the date, resetting their origin to a date they kept.
  const handleBulkPickerChange = useCallback(
    (isoUtc: string | null) => {
      if (isoUtc === null) {
        handleBulkClearDueDate()
        return
      }
      setPendingDueAtCleared(false)
      bulkHook.setAbsoluteTarget(isoUtc)
    },
    [bulkHook, handleBulkClearDueDate],
  )

  // Collect all pending changes into a single QuickActionPanelChanges object.
  // Used by both save and handleSaveAndDone to avoid duplicating the collection logic.
  //
  // Bulk-mode note: for multi-task selections we emit `delta_minutes` for relative
  // snoozes and additive `labels_add`/`labels_remove` for labels. For single-task
  // selections (including the case where SelectionActionSheet mounts the panel in
  // bulk mode with one task) we always emit an absolute `due_at` and a full
  // `labels` list, so the single-task PATCH path never has to interpret deltas
  // or diff labels.
  const collectPendingChanges = useCallback((): QuickActionPanelChanges => {
    const changes: QuickActionPanelChanges = {}
    // Include staged title OR in-progress title edit (user is still typing)
    if (pendingTitle !== null) {
      changes.title = pendingTitle
    } else if (editingTitle && titleDraft.trim() && titleDraft.trim() !== effectiveTask?.title) {
      changes.title = titleDraft.trim()
    }
    if (pendingPriority !== null) changes.priority = pendingPriority
    if (pendingLabels !== null) {
      // Multi-task bulk: emit additive diff against the bulk common labels so
      // tasks keep labels that only appear on some of them.
      if (isBulkMode && (selectedTasks?.length ?? 0) > 1) {
        const origSet = new Set(bulkCommonLabels.map((l) => l.toLowerCase()))
        const newSet = new Set(pendingLabels.map((l) => l.toLowerCase()))
        const toAdd = pendingLabels.filter((l) => !origSet.has(l.toLowerCase()))
        const toRemove = bulkCommonLabels.filter((l) => !newSet.has(l.toLowerCase()))
        if (toAdd.length > 0) changes.labels_add = toAdd
        if (toRemove.length > 0) changes.labels_remove = toRemove
      } else {
        changes.labels = pendingLabels
      }
    }
    if (pendingDueAtCleared) {
      changes.due_at = null
      changes.rrule = null
    } else {
      if (pendingRrule !== undefined) changes.rrule = pendingRrule
      if (isBulkMode) {
        // Bulk mode: read the staged date op from bulkHook and emit either an
        // absolute `due_at` or a relative `delta_minutes`. For single-task bulk
        // selections we convert relative deltas to absolute so the downstream
        // single PATCH path can handle it with no delta awareness.
        const result = bulkHook.getResult()
        if (result?.type === 'absolute') {
          changes.due_at = result.until
        } else if (result?.type === 'relative') {
          const singleBulkTask = selectedTasks?.length === 1 ? (selectedTasks[0] ?? null) : null
          if (singleBulkTask?.due_at) {
            const newTimeMs =
              new Date(singleBulkTask.due_at).getTime() + result.deltaMinutes * 60_000
            changes.due_at = new Date(newTimeMs).toISOString()
          } else {
            changes.delta_minutes = result.deltaMinutes
          }
        }
      } else if (pendingDueAt !== null) {
        changes.due_at = pendingDueAt
      } else if (singleHook.isDirty) {
        changes.due_at = singleHook.workingDate
      }
    }
    if (pendingRecurrenceMode !== null) changes.recurrence_mode = pendingRecurrenceMode
    if (pendingProject !== null) changes.project_id = pendingProject
    if (pendingAutoSnooze !== undefined) changes.auto_snooze_minutes = pendingAutoSnooze
    // A picked date is a reminder's explicit reschedule (see pendingDatePicked;
    // ignored on a task). Single-task only — a bulk pick is staged in the bulk
    // hook as an absolute target and saves like a preset (see
    // handleBulkPickerChange) — and create mode has no origin to reset.
    if (isPickedReschedule(pendingDatePicked, isBulkMode, isCreateMode, changes.due_at)) {
      changes.reset_original_due_at = true
    }
    if (pendingIsReminder !== null) changes.is_reminder = pendingIsReminder
    if (pendingNotes !== undefined) changes.notes = pendingNotes
    if (pendingDeadline !== undefined) changes.deadline_at = pendingDeadline
    if (pendingHorizon !== undefined) changes.horizon = pendingHorizon
    // On deck (D2): unless a target staged after it overrides it — the pick
    // takes the task off deck on the server (`deck-clear.ts`).
    if (showDeckLine && pendingDeck !== undefined && !isDateDirty && !pendingDueAtCleared) {
      changes.on_deck_day = pendingDeck
    }
    // A cleared target on a task with a deadline is "Back to auto" (§8.3): the
    // server puts the deadline's automatic target back. Nothing extra to send.
    return changes
  }, [
    pendingDeadline,
    pendingHorizon,
    pendingDeck,
    showDeckLine,
    isDateDirty,
    pendingTitle,
    editingTitle,
    titleDraft,
    effectiveTask?.title,
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
    pendingDatePicked,
    isCreateMode,
    pendingIsReminder,
    pendingNotes,
    isBulkMode,
    bulkHook,
    selectedTasks,
    bulkCommonLabels,
  ])

  // Reset all pending state back to initial values.
  // Used by save, handleCancel, and handleReset to avoid duplicating the reset logic.
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
    setPendingDatePicked(false)
    setPendingIsReminder(null)
    setPendingNotes(undefined)
    setNotesExpanded(false)
    setPendingDeadline(undefined)
    setPendingHorizon(undefined)
    setPendingDeck(undefined)
  }, [])

  // Create mode handler: collects all staged fields + title, calls onCreate, then resets.
  // A host that rejects has already reported the failure (CreateTaskPanel
  // toasts the server's reason); the title and staged fields stay so the
  // create can be retried instead of being wiped as if it had worked.
  const handleCreate = useCallback(async () => {
    if (!onCreate) return
    const changes = collectPendingChanges()
    try {
      await onCreate({ ...changes, title: createTitle.trim() })
    } catch {
      return
    }
    resetAllPending()
    setCreateTitle('')
    singleHook.reset()
  }, [onCreate, collectPendingChanges, createTitle, resetAllPending, singleHook])

  // Shared save logic: sends all pending changes in one batched onSaveAll call.
  // Used by both save and handleSaveAndDone to avoid duplicating the dispatch logic.
  const applyAllPendingChanges = useCallback(async () => {
    if (!onSaveAll) return
    const changes = collectPendingChanges()
    if (Object.keys(changes).length > 0) {
      await onSaveAll(changes)
    }
  }, [onSaveAll, collectPendingChanges])

  const save = useCallback(async () => {
    try {
      await applyAllPendingChanges()
    } catch {
      // A host that rejects has already reported the failure (the dashboard's
      // popover and selection sheet, the task page: each toasts the server's
      // reason). The staged edits stay so the save can be retried, and onSave
      // (which closes or leaves) is not called.
      return
    }
    resetAllPending()
    // Reset whichever date hook is active (bulk or single) so the panel's
    // staged state clears on save — otherwise a re-open of the same selection
    // would show stale delta/absolute indicators.
    reset()
    onSave?.()
  }, [applyAllPendingChanges, resetAllPending, reset, onSave])

  // Dirty report (and clean on unmount), beforeunload while dirty, the saveRef
  // a host's unsaved-changes dialog commits through, and the in-flight guard
  // that disables Save until the request settles — see useStagedEditor.
  const { saving, runSave: handleSave } = useStagedEditor({
    dirty: isDirty,
    onDirtyChange,
    saveRef,
    save,
  })

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
  // - otherwise: show count for bulk or task title
  // When pendingTitle exists, show it instead of the task's current title
  const displayTitle = pendingTitle ?? effectiveTask?.title
  const title = isSelectionSheetMode
    ? null
    : selectedCount && selectedCount > 1
      ? `${selectedCount} tasks selected`
      : (displayTitle ?? 'Set date')

  // "Originally: …" — the raw text the task was created from (usually dictated),
  // kept in `original_title` when enrichment rewrites the title. Read-only and
  // outside the form state, so it never makes the panel dirty. Shown only for a
  // single saved task whose original differs from its saved title (trimmed);
  // never in create mode, bulk mode or the selection sheet (no title there).
  const savedOriginal = effectiveTask?.original_title?.trim() ?? ''
  const originalTitle =
    !isCreateMode &&
    !isBulkMode &&
    !isSelectionSheetMode &&
    savedOriginal !== '' &&
    savedOriginal !== effectiveTask?.title.trim()
      ? savedOriginal
      : null

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

  // Whether the Repeat button reads active: the (staged) rule is set — in a
  // multi-selection, every selected task repeats (or a rule is staged for
  // them all). See the button for why it is a tint, not a toggle.
  const { repeatActive, repeatButtonLabel } = repeatButtonState({
    rule: isBulkMode && pendingRrule === undefined ? undefined : displayRrule,
    selectedTasks: isBulkMode ? selectedTasks : undefined,
    recurrenceText,
    editing: editingRecurrence,
  })

  // Task age — "since X" text shown on the recurrence line, for a single
  // existing task only. The anchor rules live in formatTaskSince. The text is
  // computed when the task or timezone changes, not on a clock tick.
  const sinceInfo = useMemo(() => {
    if (!effectiveTask || isBulkMode || isSelectionSheetMode || isCreateMode) return null
    return formatTaskSince(effectiveTask, timezone)
  }, [effectiveTask, isBulkMode, isSelectionSheetMode, isCreateMode, timezone])

  // Toggle the expandable recurrence picker
  const handleRecurrenceToggle = useCallback(() => {
    setEditingRecurrence((prev) => !prev)
  }, [])

  // Handle title editing - stages the change for the batched save
  const handleTitleSave = useCallback(() => {
    const trimmed = titleDraft.trim()
    if (trimmed && trimmed !== effectiveTask?.title) {
      setPendingTitle(trimmed)
    }
    setEditingTitle(false)
  }, [titleDraft, effectiveTask?.title])

  const handleTitleClick = useCallback(() => {
    if (onSaveAll && effectiveTask) {
      // Use pendingTitle if it exists, otherwise use task's current title
      setTitleDraft(pendingTitle ?? effectiveTask.title)
      setEditingTitle(true)
    }
  }, [onSaveAll, effectiveTask, pendingTitle])

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
    try {
      await applyAllPendingChanges()
    } catch {
      // Reported by the host; don't complete a task whose edits didn't save.
      return
    }
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

  return (
    <div className="space-y-3">
      {/* Header section — stacked: metadata on top (full width), priority+actions row below */}
      <div>
        <div className="min-w-0">
          {/* Title: create mode shows always-visible input; edit mode uses click-to-edit */}
          {isCreateMode ? (
            <div className="flex items-start gap-1">
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
                className={`-mx-2 max-h-48 min-h-0 flex-1 resize-none overflow-y-auto px-2 py-1 ${getDetailTitleClasses(createTitle).sizeClass} hover:bg-muted/50 focus:bg-muted/50 rounded-sm border-transparent bg-transparent font-medium shadow-none focus-visible:border-transparent focus-visible:ring-0`}
                rows={1}
                ref={createTitleRef}
              />
              {speech.isSupported && (
                <button
                  type="button"
                  onClick={() => {
                    if (speech.isListening) {
                      speech.stopListening()
                    } else {
                      titleBeforeSpeechRef.current = createTitle
                      speech.startListening()
                    }
                  }}
                  className={cn(
                    'mt-1 flex-shrink-0 rounded p-0.5 transition-colors active:scale-90',
                    speech.isListening
                      ? 'text-red-500 hover:text-red-600'
                      : 'text-muted-foreground hover:text-primary hover:bg-accent active:bg-accent',
                  )}
                  aria-label={speech.isListening ? 'Stop dictation' : 'Start dictation'}
                >
                  <Mic className={cn('size-4', speech.isListening && 'animate-pulse')} />
                </button>
              )}
            </div>
          ) : (
            title && (
              <>
                {onSaveAll && editingTitle ? (
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
                              : onSaveAll
                                ? 'hover:text-primary cursor-pointer transition-colors'
                                : 'select-text',
                          )}
                          onClick={onSaveAll ? handleTitleClick : undefined}
                        >
                          {title}
                        </p>
                      )
                    })()}
                  </div>
                )}
                {originalTitle && (
                  <p
                    data-quick-panel-original-title
                    className="text-muted-foreground mt-0.5 text-xs break-words whitespace-pre-wrap select-text"
                  >
                    Originally: {originalTitle}
                  </p>
                )}
              </>
            )
          )}
          {/* Completed badge - shown when task is done (hidden in create mode) */}
          {!isCreateMode && showCompletedBadge && effectiveTask?.done && (
            <Badge
              variant="secondary"
              className="mt-1 bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
            >
              Completed
            </Badge>
          )}
          {/*
            Date display — tapping it opens the calendar/time picker, in single
            and multi-task mode alike. In bulk mode a picked date stages an
            ABSOLUTE target for every selected task (bulkHook.setAbsoluteTarget),
            exactly like the 9:00 AM / Now presets, so it saves through the same
            path: bulk/snooze (or bulk/edit alongside other fields) with
            include_task_ids, behind the same "Confirm date change" dialog.
          */}
          <DateTimePicker
            value={
              isBulkMode
                ? (bulkHook.presetTime ?? bulkHook.earliestDueAt)
                : (pendingDueAt ?? workingDate ?? effectiveTask?.due_at ?? null)
            }
            timezone={timezone}
            // A deadline task's Clear is "Back to auto" (§8.3), and an
            // automatic target has nothing to clear (ruling Q9).
            allowClear={
              isBulkMode ? canBulkClearDueDate : singleTargetReset !== null || !autoTarget
            }
            clearLabel={singleTargetReset === 'auto' ? BACK_TO_AUTO : undefined}
            quickPick={pickerDeadlineDay}
            emptyDefault={isBulkMode ? 'now' : 'tomorrow'}
            onChange={isBulkMode ? handleBulkPickerChange : handleSinglePickerChange}
          >
            <p
              data-quick-panel-date
              className="inline-flex cursor-pointer flex-wrap items-center gap-x-1 text-xs select-text"
            >
              <CalendarDays className="text-muted-foreground/50 size-3 shrink-0" />
              {queuedOccurrence && !isDateDirty ? (
                // A waiting repeating task: the occurrence's date alone — no
                // "Target", no "in 3 days" (see `queuedOccurrence`).
                <span data-queued-occurrence className="text-muted-foreground">
                  {formatQuickSelectHeader(queuedOccurrence, timezone)}
                </span>
              ) : (
                <span className="text-muted-foreground/70">{TARGET_WORD}</span>
              )}
              {queuedOccurrence && !isDateDirty ? null : autoTarget ? (
                <AutoTargetText label={autoTarget} timezone={timezone} dirty={autoTargetStaged} />
              ) : showsNoTarget ? (
                <span
                  className={cn(
                    'font-medium',
                    pendingDueAtCleared || (deckStaged && !allNoDueDate)
                      ? 'text-blue-500'
                      : 'text-muted-foreground',
                  )}
                >
                  No target
                </span>
              ) : (
                <>
                  <span
                    className={cn(
                      isDateDirty ? 'font-bold text-blue-500' : 'text-muted-foreground',
                    )}
                  >
                    {headerText}
                  </span>
                  <span
                    className={cn(
                      isDateDirty ? 'mx-1 text-blue-500' : 'text-muted-foreground mx-1',
                    )}
                  >
                    &middot;
                  </span>
                  <span
                    className={cn(
                      isDateDirty
                        ? 'font-bold text-blue-500'
                        : isPast
                          ? 'text-over-target font-medium'
                          : 'text-muted-foreground',
                    )}
                  >
                    {relativeText}
                  </span>
                  {effectiveDeltaDisplay && (
                    <span className="ml-1 font-medium text-blue-500">
                      ({effectiveDeltaDisplay})
                    </span>
                  )}
                </>
              )}
            </p>
          </DateTimePicker>
          {/* A repeating task whose target was moved off its scheduled
              occurrence (§6, 2026-10-12) names the occurrence under the
              target, so a moved target never reads as a changed schedule:
              done still brings the next one round from the occurrence. */}
          {movedOccurrence && (
            <p data-occurrence-line className="text-muted-foreground/70 mt-0.5 text-xs">
              Occurrence {movedOccurrence} · target moved
            </p>
          )}
          {/* Deadline + horizon (2026-10-10): their own lines, never moved by a
              snooze button. Ordinary tasks only — a reminder or a quota has
              neither — and one task at a time (Process sets horizons in bulk). */}
          {!isBulkMode && !isReminderLike && (
            <TaskModelFields
              deadline={
                pendingDeadline !== undefined
                  ? pendingDeadline
                  : (effectiveTask?.deadline_at ?? null)
              }
              deadlineDirty={pendingDeadline !== undefined}
              timezone={timezone}
              onDeadline={setPendingDeadline}
              repeatLabel={deadlineRepeatLabel({
                rrule: displayRrule,
                repeat_anchor: effectiveTask?.repeat_anchor ?? null,
                target_days_before: effectiveTask?.target_days_before ?? null,
                target_time: effectiveTask?.target_time ?? null,
              })}
              showHorizon={!displayRrule}
              // A one-off with a target the user picked is quiet until its
              // date (spec §1/§8.5, 2026-10-12): its horizon decides nothing
              // until the target is removed, so the row is greyed and says so.
              // An automatic deadline target keeps the horizon working. Read
              // from the target line's own (staged) value, so Remove target or
              // Back to auto staged brings the horizon back at once.
              // Only a REAL target: `workingDate` is the picker's working
              // value and is set even with no target, so it counts only once
              // a date is staged (`isDateDirty`) — it made a task with no
              // target read "quiet until <today>" (2026-10-15).
              quietUntil={
                displayRrule || autoTarget || showsNoTarget
                  ? null
                  : (pendingDueAt ??
                    (isDateDirty ? workingDate : null) ??
                    effectiveTask?.due_at ??
                    null)
              }
              emptyAnchor={
                displayRrule ? (pendingDueAt ?? effectiveTask?.due_at ?? workingDate) : null
              }
            />
          )}
          {/* ON DECK (D2, spec rule 8): not a reminder or quota (rule 6), one
              task at a time, with the task queue on, no recurrence change
              staged. */}
          {showDeckLine && effectiveTask && (
            <OnDeckLine
              task={effectiveTask}
              timezone={timezone}
              staged={pendingDeck}
              shadowed={deckShadowed}
              limit={stagedDeckLimit}
              onStage={stageDeck}
            />
          )}
          {/* Preview of new due_at when changing recurrence - shows what date the task will move to */}
          {previewDueAt && (
            <p className="mt-0.5 text-xs font-medium text-blue-500">
              → {formatDateTime(previewDueAt, timezone)}
            </p>
          )}
          {/* Recurrence summary line: "One time", the rule ("Target Sundays at
              9:00 AM") or the selection's summary, plus the "since X" age when
              there is one. Tapping it opens the recurrence editor — see
              RecurrenceSummaryLine for why the text, not the Repeat button, is
              the way in. */}
          {recurrenceText && (
            <RecurrenceSummaryLine
              text={recurrenceText}
              isRecurring={!isBulkMode && !!displayRrule}
              isOneTime={isOneTime}
              dirty={isRruleDirty}
              canEdit={canEdit}
              expanded={editingRecurrence}
              onToggle={handleRecurrenceToggle}
              className={isSelectionSheetMode ? 'mt-0.5' : 'mt-1'}
              since={
                sinceInfo &&
                !isRruleDirty && (
                  <SinceAge
                    label={sinceInfo.label}
                    timeAgo={sinceInfo.timeAgo}
                    fullDate={sinceInfo.fullDate}
                  />
                )
              }
            />
          )}
          {/* Project + Priority row */}
          {(effectiveTask || isBulkMode || isCreateMode) && (
            <div className="mt-1 flex items-center gap-1.5">
              {/* Project badge/picker — left-aligned */}
              {(() => {
                const displayProjectObj = projects?.find((p) => p.id === displayProject)
                const displayProjectName =
                  displayProjectObj?.name ?? projectName ?? (isCreateMode ? 'Inbox' : undefined)
                return displayProjectName && canEdit && projects && projects.length > 0 ? (
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
              {canEdit ? (
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
              {/* Horizon (2026-10-15): always settable on a one-off, beside
                  project and priority — see `HorizonPicker`. Not on a
                  recurring task, a reminder or a quota (no horizon), nor in
                  bulk (Process sets horizons in bulk). */}
              {canEdit && !isBulkMode && !isReminderLike && !displayRrule && (
                <HorizonPicker
                  value={
                    pendingHorizon !== undefined ? pendingHorizon : (effectiveTask?.horizon ?? null)
                  }
                  dirty={pendingHorizon !== undefined}
                  onChange={setPendingHorizon}
                />
              )}
              {/*
                §6: a reminder behaves differently from a task (no debt, no
                badge, cannot be snoozed), so the panel says so where the other
                kind-of-thing metadata lives, rather than leaving the state
                visible only inside the More menu.
              */}
              {displayIsReminder && (
                <span
                  className={cn(
                    'flex shrink-0 items-center gap-1 rounded px-2 py-0.5 text-xs',
                    isReminderDirty
                      ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400'
                      : 'bg-muted text-muted-foreground',
                  )}
                  title="On the Reminders surface — never overdue, never notified individually"
                >
                  <Lightbulb className="size-3" />
                  Reminder
                </span>
              )}
            </div>
          )}
          {/* Labels + action icons row */}
          {(effectiveTask || isBulkMode || isCreateMode) && (
            <div className="mt-2 flex flex-wrap items-center gap-1">
              {canEdit ? (
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
                {/* Recurrence button (when editable). Two states:
                    - whether a rule is set (`repeatActive`): the panel's own
                      neutral "selected" look — the light grey fill and full
                      foreground of the recurrence line when it is open
                      (RecurrenceSummaryLine) — and the label leads with the
                      rule ("Repeats: Fridays at 4:00 PM · Edit recurrence");
                      no rule: the muted icon;
                    - whether the editor is open: `aria-expanded`, the same
                      fill, and the label says what a tap does ("Close
                      recurrence editor").
                    Rulings: SOLID blue whenever the task recurred read as an
                    on/off toggle a tap would switch off (Trent, 2026-10-12),
                    so it lost any rule state and then looked the same on a
                    one-off and a repeating task (Trent, 2026-10-20). Neutral,
                    not blue (designer, 2026-10-20): blue in this panel means
                    "unsaved change", and Trent's one-accent-hue rule wins. No
                    `aria-pressed`: a tap opens the editor, never switches the
                    rule off. */}
                {canEdit && (
                  <Button
                    variant="ghost"
                    size="icon"
                    data-repeat-active={repeatActive ? '' : undefined}
                    className={cn(
                      'size-8',
                      repeatActive || editingRecurrence
                        ? 'bg-accent text-foreground dark:bg-accent'
                        : 'text-muted-foreground',
                    )}
                    onClick={handleRecurrenceToggle}
                    aria-expanded={editingRecurrence}
                    aria-controls={RECURRENCE_EDITOR_ID}
                    aria-label={repeatButtonLabel}
                    title={repeatButtonLabel}
                  >
                    <Repeat className="size-4" />
                  </Button>
                )}
                {/* Auto-snooze picker — per-task notification repeat interval */}
                {(() => {
                  // In bulk mode, compute common auto-snooze across selected tasks
                  const bulkCommonAutoSnooze =
                    isBulkMode &&
                    selectedTasks &&
                    selectedTasks.length > 1 &&
                    selectedTasks.every(
                      (t) => t.auto_snooze_minutes === selectedTasks[0].auto_snooze_minutes,
                    )
                      ? (selectedTasks[0].auto_snooze_minutes ?? null)
                      : null
                  const effectiveAutoSnooze =
                    pendingAutoSnooze !== undefined
                      ? pendingAutoSnooze
                      : (effectiveTask?.auto_snooze_minutes ??
                        (isBulkMode ? bulkCommonAutoSnooze : null))
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
                {!isCreateMode && onDelete && (
                  <IconButton
                    icon={<Trash2 className="size-4" />}
                    label="Delete"
                    onClick={onDelete}
                    destructive
                  />
                )}

                {/*
                  More menu - consolidates disabled features and task details.
                  Rendered only when it has at least one item: hidden in create
                  mode, and in multi-task mode unless "Clear due date" applies
                  (Reminder and Task Details are single-task only) — an empty
                  menu used to open as a blank sliver.
                */}
                {!isCreateMode && hasMoreMenuItems && (
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
                      {/* Clear the target — single task. A one-off with a
                          deadline never loses its target (§8.3): its picked
                          target goes "Back to auto", and an automatic target
                          offers neither (ruling Q9). A repeating task's goes
                          with its recurrence. */}
                      {isSingleTask && singleTargetReset && !pendingDueAtCleared && (
                        <DropdownMenuItem
                          // `inset` matches the left padding DropdownMenuCheckboxItem
                          // reserves for its tick, so the icons and labels in this
                          // mixed menu sit on one line (Trent, 2026-09-06: "reminder
                          // and due date are not aligned right").
                          inset
                          data-target-reset={singleTargetReset}
                          onClick={() => {
                            setPendingDueAtCleared(true)
                            if (effectiveTask?.rrule) {
                              setPendingRrule(null)
                            }
                          }}
                        >
                          {singleTargetReset === 'auto' ? (
                            <RotateCcw className="mr-2 size-4" />
                          ) : (
                            <XCircle className="mr-2 size-4" />
                          )}
                          {singleTargetReset === 'auto'
                            ? BACK_TO_AUTO
                            : `Remove target${effectiveTask?.rrule ? ' & recurrence' : ''}`}
                        </DropdownMenuItem>
                      )}
                      {/* Skip until (task queue PR 4; spec rule 10). An
                          action, not a staged edit, so it waits for unsaved
                          edits to be saved or reset rather than dropping them
                          (the selection sheet's Remove target does the same). */}
                      {showSkipUntil && (
                        <DropdownMenuItem
                          inset
                          disabled={isDirty}
                          title={isDirty ? 'Save or reset your changes first' : undefined}
                          onClick={() => setSkipUntilOpen(true)}
                          data-skip-until-item
                        >
                          <SkipForward className="mr-2 size-4" />
                          Skip until…
                        </DropdownMenuItem>
                      )}
                      {/* Clear due date - multi-task: applies to every selected task on Save */}
                      {showBulkClearItem && (
                        <DropdownMenuItem inset onClick={handleBulkClearDueDate}>
                          <XCircle className="mr-2 size-4" />
                          Remove targets{bulkHasRecurrence ? ' & recurrence' : ''}
                        </DropdownMenuItem>
                      )}
                      {/*
                        §6: flag this item onto the Reminders surface.
                        A checkbox item rather than a button because the flag is
                        a state of the task, not an action on it — and because
                        the surface it moves the item to is elsewhere, so the
                        check is the only feedback the user gets here until
                        Save.

                        Single-task only: the flag changes what KIND of thing an
                        item is, and applying that to a mixed selection in one
                        tap is the sort of bulk mistake §6 exists to avoid.
                      */}
                      {isSingleTask && (
                        <DropdownMenuCheckboxItem
                          checked={displayIsReminder}
                          onCheckedChange={(checked) =>
                            setPendingIsReminder(
                              checked === (effectiveTask?.is_reminder ?? false) ? null : checked,
                            )
                          }
                          onSelect={(e) => e.preventDefault()}
                        >
                          <Lightbulb
                            className={cn('mr-2 size-4', isReminderDirty && 'text-blue-500')}
                          />
                          Reminder
                        </DropdownMenuCheckboxItem>
                      )}
                      {isSingleTask && onNavigateToDetail && (
                        <DropdownMenuItem inset onClick={onNavigateToDetail}>
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

      {/* Expandable recurrence editor, opened from the summary line or the
          Repeat button. It opens right under them, ABOVE the snooze grid, so
          a tap visibly opens something where the finger is (2026-10-12: below
          the grid it could land off-screen on a phone, and the tap looked like
          it did nothing). Uses displayRrule (pending or current) and stages
          changes via setPendingRrule. */}
      {editingRecurrence && canEdit && (
        <div id={RECURRENCE_EDITOR_ID} className="rounded-lg border p-3">
          <RecurrencePicker
            value={displayRrule}
            recurrenceMode={pendingRecurrenceMode ?? effectiveTask?.recurrence_mode}
            initialTime={recurrenceInitialTime}
            defaultDayOfWeek={defaultDayOfWeek}
            onChange={(rrule, mode) => {
              setPendingRrule(rrule)
              if (mode) setPendingRecurrenceMode(mode)
            }}
          />
        </div>
      )}

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

      {/* AI annotation — shown between date grid and action buttons */}
      {annotation && (
        <p className="mt-2 text-xs text-blue-600/80 dark:text-blue-400/80">
          <Sparkles className="mr-1 inline-block size-3 align-text-bottom" />
          {annotation}
        </p>
      )}

      {/* AI Insights commentary */}
      {insightsCommentary && !annotation && (
        <p className="mt-2 text-xs text-indigo-600/80 dark:text-indigo-400/80">
          <Sparkles className="mr-1 inline-block size-3 align-text-bottom" />
          {insightsCommentary}
        </p>
      )}

      {/* Bottom action bar - Save/Reset/Done/Cancel (Create Task/Reset/Cancel in create mode) */}
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
            onClick={() => void handleSave()}
            disabled={!isDirty || isRecurrenceInvalid || saving}
            className="flex-1"
          >
            Save
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={handleReset}
          disabled={isCreateMode ? !createModeNonTitleDirty : !isDirty}
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

      {/* Notes section — inline editing below action buttons (single-task only) */}
      {!isBulkMode && (
        <NotesInlineSection
          isCreateMode={isCreateMode}
          currentNotes={effectiveTask?.notes ?? null}
          pendingNotes={pendingNotes}
          expanded={notesExpanded}
          onExpand={() => setNotesExpanded(true)}
          onCollapse={() => setNotesExpanded(false)}
          onChange={setPendingNotes}
        />
      )}

      {showSkipUntil && effectiveTask && onSkipUntil && (
        <SkipUntilDialog
          open={skipUntilOpen}
          onOpenChange={setSkipUntilOpen}
          tasks={[effectiveTask]}
          timezone={timezone}
          onSkip={onSkipUntil}
        />
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
