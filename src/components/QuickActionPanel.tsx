'use client'

import { isDeadlineAnchored, targetReset, type HorizonValue } from '@/lib/task-segments'
import { HorizonPicker } from '@/components/HorizonDot'
import { REMOVE_TARGET } from '@/lib/task-model-words'
import { OnDeckLine } from '@/components/quick-panel/OnDeckLine'
import { deckLimit } from '@/lib/deck-menu'
import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import {
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
  Sparkles,
  Mic,
  Lightbulb,
  SkipForward,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { LabelName } from '@/components/LabelName'
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
import { useEveryTime } from '@/hooks/useEveryTime'
import { useLinkableSlots, useRelativeTarget } from '@/hooks/useRelativeTarget'
import { pickAt, pickFields, type RelativePick } from '@/lib/relative-target-ui'
import { formatClockTime } from '@/lib/time-utils'
import {
  INCREMENTS,
  DECREMENTS,
  SMART_BUTTONS,
  snapToNearestFiveMinutes,
  snapToNextHour,
} from '@/lib/quick-select-dates'
import { PRIORITY_OPTIONS, getPriorityOption } from '@/lib/priority'
import {
  useLabelConfig,
  useAutoSnoozeDefault,
  useSnoozePreferences,
  usePadPresets,
  useTaskQueue,
  useDayStart,
} from '@/components/PreferencesProvider'
import { getLabelClasses } from '@/lib/label-colors'
import { formatTaskSince, formatTimeInTimezone } from '@/lib/format-date'
import { IconButton } from '@/components/ui/icon-button'
import { AutoSnoozePicker, formatAutoSnoozeLabel } from '@/components/AutoSnoozePicker'
import { computeCommonLabels, computeCommonPriority, hasLabelVariations } from '@/lib/bulk-utils'
import { isPickedReschedule } from '@/lib/picked-reschedule'
import { isTracked } from '@/lib/track'
import { GridButton } from '@/components/quick-panel/GridButton'
import { SinceAge } from '@/components/quick-panel/SinceAge'
import { NotesInlineSection } from '@/components/quick-panel/NotesInlineSection'
import { ThisOneFields } from '@/components/quick-panel/ThisOneFields'
import { EveryTimePanel } from '@/components/quick-panel/EveryTimePanel'
import {
  deadlineRowFor,
  derivedTargetFor,
  leadRowFor,
  repeatLinkFor,
  scrollParentToTop,
  stagedUpcomingAnchor,
  targetValueFor,
} from '@/components/quick-panel/this-one-props'
import { SkipUntilDialog } from '@/components/SkipUntilDialog'
import { canSkipUntil } from '@/lib/skip-until'
import {
  occurrenceDiffers,
  pickerBaseDueAt,
  queuedRepeatOccurrence,
  relativeTargetWords,
} from '@/lib/editor-target-labels'
import { draftRule, draftToCreateFields } from '@/lib/every-time'
import type { Task, Project, RepeatAnchor } from '@/types'

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
  /**
   * The deadlines page's lead override (2026-10-22, the Lead row): local days
   * before the deadline; null = the default table. Single-task only.
   */
  lead_days?: number | null
  horizon?: HorizonValue | null
  /** On deck (D2): a yyyy-MM-dd day, or null = off deck. Single-task only. */
  on_deck_day?: string | null
  /**
   * Every-time mode (editor plan §5; `draftToPatch` in src/lib/every-time.ts):
   * what the rule repeats, and a deadline-anchored target's place before its
   * deadline. Single-task only — a bulk save never sends them (`editFields`).
   */
  repeat_anchor?: RepeatAnchor
  target_days_before?: number
  target_time?: string
  /**
   * The period the target's time follows (relative targets, 2026-10-24),
   * sent instead of `target_time`. With `target_days_before` it is also a
   * ONE-OFF's relative target (the target picker's "Before the deadline").
   */
  target_slot_id?: number
  /** Repeat ends (every-time mode's Ends row): "After N times" / "On date". Single-task only. */
  repeat_count?: number | null
  repeat_until?: string | null
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
  | 'everyTime'
  | 'project'
  | 'dueAtCleared'
  | 'autoSnooze'
  | 'isReminder'
  | 'notes'
  | 'deadline'
  | 'leadDays'
  | 'horizon'
  | 'deck'
  | 'relative'

/**
 * The fields that make create mode dirty (besides the title, which is compared
 * against initialTitle on its own). isReminder and dueAtCleared are
 * deliberately left out: create mode has never counted them as a change from
 * its defaults. 'everyTime' is a schedule staged by every-time mode's Done.
 */
const CREATE_MODE_DIRTY_FIELDS: readonly DirtyField[] = [
  'deadline',
  'horizon',
  'priority',
  'labels',
  'everyTime',
  'project',
  'date',
  'autoSnooze',
  'notes',
  'relative',
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

/** The Nag trigger's words: the cadence, or a dash for a mixed selection. */
function nagTriggerText(
  isMixed: boolean | undefined,
  minutes: number,
): { label: string; title: string } {
  if (isMixed) return { label: '\u2014', title: 'Nag: mixed' }
  const label = formatAutoSnoozeLabel(minutes)
  return { label, title: `Nag every ${label}` }
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
  // The pad's four preset buttons are a setting (anchor times, 2026-10-21):
  // each a custom time or a reminder period's start, resolved by the server.
  const padPresets = usePadPresets()

  // Staged changes state - all changes are staged until Save is clicked.
  // The schedule (the rule, its anchor, its end) is not staged here: it is
  // every-time mode's own draft (`useEveryTime`, below).
  const [pendingPriority, setPendingPriority] = useState<number | null>(null)
  const [pendingLabels, setPendingLabels] = useState<string[] | null>(null)
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
  // The deadlines page's lead override (the Lead row): undefined = no change, null = default.
  const [pendingLeadDays, setPendingLeadDays] = useState<number | null | undefined>(undefined)
  const [pendingHorizon, setPendingHorizon] = useState<HorizonValue | null | undefined>(undefined)
  // On deck (D2, `OnDeckLine`): undefined = no change, null = off deck, else a day.
  const [pendingDeck, setPendingDeck] = useState<string | null | undefined>(undefined)
  // A RELATIVE target picked in the target picker's "Before the deadline"
  // block (2026-10-24, `useRelativeTarget`): null = none staged.
  const [pendingRelative, setPendingRelative] = useState<RelativePick | null>(null)
  // The periods a target may follow (the user's own, on their own task).
  const linkable = useLinkableSlots(effectiveTask, isCreateMode)

  // Single task mode hook. A repeating task waiting in the task queue
  // (2026-10-20, `queuedRepeatOccurrence`, with the queue switch on) has no
  // live target: its label is the occurrence it stands for, but the controls
  // (increments, the "(+N)" delta, the pickers) start from NOW, as for a task
  // with no target (`pickerBaseDueAt`) — never from the missed occurrence
  // ("+1 day" would stage a past date) or the moved target. Any staged date
  // is a picked target, which takes the task out of the queue.
  const { enabled: queueEnabled, attemptsRolloverTime: rolloverTime } = useTaskQueue()
  const dayStart = useDayStart()
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
  const displayProject = pendingProject ?? effectiveTask?.project_id
  // §6 Reminders flag — staged value wins, otherwise the task's stored flag.
  const displayIsReminder = pendingIsReminder ?? effectiveTask?.is_reminder ?? false
  // Reminders and quotas carry no deadline or horizon (2026-10-10).
  const isReminderLike = displayIsReminder || (effectiveTask ? isTracked(effectiveTask) : false)

  // THE TWO MODES (2026-10-22, editor plan §2; PR 4c): THIS ONE (this
  // occurrence: the rows below, the pad, the chips) and EVERY TIME (the
  // schedule: `EveryTimePanel`), each with its own staged changes — one Save
  // is one mode's one PATCH. See `useEveryTime`.
  const everyTime = useEveryTime({
    variant: isCreateMode ? 'create' : isBulkMode ? 'bulk' : 'single',
    task: effectiveTask,
    selectedTasks: selectedTasks ?? [],
    createStaged: {
      dueAt:
        pendingRelative && pendingDeadline
          ? pickAt(pendingRelative, pendingDeadline, timezone)
          : (pendingDueAt ?? (singleHook.isDirty ? singleHook.workingDate : null)),
      deadlineAt: pendingDeadline ?? null,
      relative: pendingRelative,
    },
    timezone,
    morningTime,
    morningSlotId: linkable.morningSlotId,
    leads: queueEnabled,
  })
  // Create mode: the schedule Done staged in every-time mode, and what Create
  // Task sends for it (`draftToCreateFields`).
  const stagedSchedule = isCreateMode ? everyTime.staged : null
  const stagedCreateFields = stagedSchedule
    ? draftToCreateFields(
        {
          dueAt: pendingDueAt ?? (singleHook.isDirty ? singleHook.workingDate : null),
          deadlineAt: pendingDeadline ?? null,
        },
        stagedSchedule.draft,
        stagedSchedule.ctx,
      )
    : null
  // The rule shown: the task's (a saved one), or create mode's staged one.
  const displayRrule = stagedSchedule
    ? draftRule(stagedSchedule.draft)
    : (effectiveTask?.rrule ?? null)
  // A repeat whose rule walks its DEADLINE (2026-10-21): this occurrence's
  // deadline is a picker that reschedules it, and has no Clear.
  const deadlineAnchored = stagedSchedule
    ? stagedSchedule.draft.anchor === 'deadline'
    : !!effectiveTask?.rrule && isDeadlineAnchored(effectiveTask)

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
  const isProjectDirty = pendingProject !== null
  const isReminderDirty = pendingIsReminder !== null
  const fieldDirty: Record<DirtyField, boolean> = {
    date: hasDateChanges,
    title: isTitleDirty,
    priority: isPriorityDirty,
    labels: isLabelsDirty,
    // Every-time mode's unsaved draft, or create mode's staged schedule.
    everyTime: everyTime.dirty || stagedSchedule !== null,
    project: isProjectDirty,
    dueAtCleared: pendingDueAtCleared,
    autoSnooze: pendingAutoSnooze !== undefined,
    isReminder: isReminderDirty,
    notes: pendingNotes !== undefined,
    deadline: pendingDeadline !== undefined,
    leadDays: pendingLeadDays !== undefined,
    horizon: pendingHorizon !== undefined,
    deck: pendingDeck !== undefined,
    relative: pendingRelative !== null,
  }
  // Edit mode: any staged field at all.
  const hasPendingChanges = Object.values(fieldDirty).some(Boolean)
  // This-one mode's own staged edits (everything but the every-time draft):
  // while there are any, the way into every-time mode is disabled (§2.3).
  const thisOneDirty = Object.entries(fieldDirty).some(([k, v]) => k !== 'everyTime' && v)
  // Create mode, non-title fields only (see CREATE_MODE_DIRTY_FIELDS) — controls the
  // Reset button, since the title is preserved on reset.
  const createModeNonTitleDirty =
    isCreateMode && CREATE_MODE_DIRTY_FIELDS.some((field) => fieldDirty[field])
  // In create mode, dirty means the user has changed something from the initial defaults:
  // typed a title (different from initialTitle), changed any field, or picked a date.
  const createModeDirty =
    isCreateMode && (createTitle.trim() !== (initialTitle ?? '').trim() || createModeNonTitleDirty)
  const isDirty = isCreateMode ? createModeDirty : hasPendingChanges

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
    pendingDueAtCleared ||
    deckStaged ||
    (allNoDueDate && !isDateDirty && pendingDueAt === null && pendingRelative === null)

  // "THIS IS THE FRI OCT 16 ONE" (§7, A4): which occurrence the rows edit,
  // when it differs from what its rule alone says (decked, moved, queued,
  // rescheduled off its rule).
  const occurrenceLine =
    !isBulkMode && !isCreateMode && effectiveTask && !isDateDirty
      ? occurrenceDiffers(effectiveTask, timezone, queueEnabled)
      : null
  // The … menu's target reset: "Remove target" — a deadline task too since
  // 2026-10-22 (it goes on the deadlines page; "Back to auto" is gone) — or
  // nothing (no target; with the task queue off, an automatic target). Never
  // on a repeating task (§3): its target can't be cleared, and nothing in
  // this mode removes its rule — that is every-time mode's "Stop repeating".
  const singleTargetReset: 'remove' | null =
    !effectiveTask || displayRrule ? null : targetReset(effectiveTask)

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
  // repeating task shows the row too (2026-10-20: the deck is for its current
  // occurrence). A schedule change is every-time mode's, never staged with a
  // deck (RT-4): the way in is disabled while a deck is staged.
  const showDeckLine =
    queueEnabled &&
    !isBulkMode &&
    !isCreateMode &&
    !isReminderLike &&
    !!effectiveTask &&
    !effectiveTask.done
  // A deck staged while the row is shown, then hidden (the Reminder toggle
  // staged after it): the deck goes too — never sent for a task that can't be
  // on deck (adjusted during render, not in an effect).
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
      // A deck has no target: a staged relative one goes (a 400 together).
      if (typeof day === 'string') setPendingRelative(null)
      setPendingDeck(day)
    },
    [reset],
  )
  // A relative pick replaces a staged date and deck (`useRelativeTarget`).
  const dropStagedDate = useCallback(() => {
    setPendingDueAt(null)
    setPendingDueAtCleared(false)
    setPendingDatePicked(false)
    setPendingDeck(undefined)
    reset()
  }, [reset])
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
  // RULING 1 (relative targets, 2026-10-24): every pad tap, Set Date, Now and
  // Next Hour makes the target FIXED — a staged relative pick goes, and the
  // server drops a stored one when the date is sent.
  const handlePresetClick = useCallback(
    (hour: number, minute: number) => {
      setPendingDueAtCleared(false)
      setPendingDueAt(null)
      setPendingDatePicked(false)
      setPendingRelative(null)
      applyPreset(hour, minute)
    },
    [applyPreset],
  )

  // An increment counts from what the Target row shows: a relative target's
  // (staged, or re-derived from a staged deadline) moment, where it has one.
  const relativeBaseRef = useRef<string | null>(null)
  const handleIncrementClick = useCallback(
    (inc: { minutes: number | null; days?: number }) => {
      setPendingDueAtCleared(false)
      setPendingDueAt(null)
      setPendingDatePicked(false)
      setPendingRelative(null)
      if (!isBulkMode && relativeBaseRef.current) singleHook.setWorkingDate(relativeBaseRef.current)
      applyIncrement(inc)
    },
    [applyIncrement, isBulkMode, singleHook],
  )

  const handleSmartButtonClick = useCallback(
    (type: 'now' | 'nextHour') => {
      setPendingDueAtCleared(false)
      setPendingDatePicked(false)
      setPendingRelative(null)
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
  // reset_original_due_at on save); Clear drops the target. Clear NEVER
  // removes a rule (PR 4c — it used to: the "Clear deletes the repeat" bug): a
  // repeating task's picker has no Clear at all.
  const handleSinglePickerChange = useCallback(
    (isoUtc: string | null) => {
      setPendingRelative(null)
      if (isoUtc === null) {
        setPendingDueAtCleared(true)
        setPendingDueAt(null)
        setPendingDatePicked(false)
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
    [isCreateMode, singleHook],
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
      // Only the multi-task "Remove targets & recurrence" takes the rules too
      // (§9). A single task's cleared target never removes its rule.
      if (isBulkMode && (selectedTasks?.length ?? 0) > 1) changes.rrule = null
    } else {
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
    if (pendingLeadDays !== undefined) changes.lead_days = pendingLeadDays
    if (pendingHorizon !== undefined) changes.horizon = pendingHorizon
    // On deck (D2): unless a target staged after it overrides it — the pick
    // takes the task off deck on the server (`deck-clear.ts`).
    if (showDeckLine && pendingDeck !== undefined && !isDateDirty && !pendingDueAtCleared) {
      changes.on_deck_day = pendingDeck
    }
    // A relative target (2026-10-24): the offsets and the period, never with
    // a date (the handlers drop the pick when one is staged; ruling 7).
    if (pendingRelative && changes.due_at === undefined)
      Object.assign(changes, pickFields(pendingRelative))
    // A cleared target on a task with a deadline puts it on the deadlines page
    // from its lead day (2026-10-22). Nothing extra to send.
    return changes
  }, [
    pendingDeadline,
    pendingLeadDays,
    pendingHorizon,
    pendingDeck,
    pendingRelative,
    showDeckLine,
    isDateDirty,
    pendingTitle,
    editingTitle,
    titleDraft,
    effectiveTask?.title,
    pendingPriority,
    pendingLabels,
    pendingDueAtCleared,
    pendingDueAt,
    singleHook.isDirty,
    singleHook.workingDate,
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
    setPendingProject(null)
    setPendingDueAt(null)
    setPendingDueAtCleared(false)
    setPendingAutoSnooze(undefined)
    setPendingDatePicked(false)
    setPendingIsReminder(null)
    setPendingNotes(undefined)
    setNotesExpanded(false)
    setPendingDeadline(undefined)
    setPendingLeadDays(undefined)
    setPendingHorizon(undefined)
    setPendingDeck(undefined)
    setPendingRelative(null)
  }, [])

  // Create mode handler: collects all staged fields + title, calls onCreate, then resets.
  // A host that rejects has already reported the failure (CreateTaskPanel
  // toasts the server's reason); the title and staged fields stay so the
  // create can be retried instead of being wiped as if it had worked.
  const handleCreate = useCallback(async () => {
    if (!onCreate) return
    const changes = collectPendingChanges()
    if (stagedSchedule && stagedCreateFields) {
      // A schedule staged in every-time mode (§8): the rule and its fields.
      // Deadline-anchored: the offsets set the target (no `due_at`), the
      // first deadline comes from the draft. Target-anchored: a repeat with
      // no deadline (L9). Never a deck with a rule (create mode has none).
      if (stagedSchedule.draft.anchor === 'deadline') delete changes.due_at
      else delete changes.deadline_at
      Object.assign(changes, stagedCreateFields)
    }
    try {
      await onCreate({ ...changes, title: createTitle.trim() })
    } catch {
      return
    }
    resetAllPending()
    everyTime.setStaged(null)
    setCreateTitle('')
    singleHook.reset()
  }, [
    onCreate,
    collectPendingChanges,
    createTitle,
    resetAllPending,
    singleHook,
    stagedSchedule,
    stagedCreateFields,
    everyTime,
  ])

  // Shared save logic: sends all pending changes in one batched onSaveAll call.
  // Used by both save and handleSaveAndDone to avoid duplicating the dispatch logic.
  const applyAllPendingChanges = useCallback(async () => {
    if (!onSaveAll) return
    const changes = collectPendingChanges()
    if (Object.keys(changes).length > 0) {
      await onSaveAll(changes)
    }
  }, [onSaveAll, collectPendingChanges])

  // EVERY-TIME MODE'S SAVE: one PATCH (`draftToPatch`), or one bulk/edit
  // (`draftToBulkChanges`) — never with this-one's fields (RT-4). No
  // optimistic patch (the server derives the dates, §13); the host's toast
  // carries the server's description and Undo. A refusal (a race) keeps the
  // panel in every-time with the draft.
  const saveEveryTime = useCallback(async () => {
    const changes = isBulkMode ? everyTime.bulkChanges : everyTime.patch
    if (onSaveAll && changes && Object.keys(changes).length > 0) {
      await onSaveAll(changes as QuickActionPanelChanges)
    }
  }, [isBulkMode, everyTime.bulkChanges, everyTime.patch, onSaveAll])

  const save = useCallback(async () => {
    // Every-time mode declines a draft with a problem (the inline line says
    // why) — the host's save-and-leave too: nothing is sent, nothing closes.
    if (everyTime.session && !everyTime.saveable) return
    try {
      if (everyTime.session) await saveEveryTime()
      else await applyAllPendingChanges()
    } catch {
      // A host that rejects has already reported the failure (the dashboard's
      // popover and selection sheet, the task page: each toasts the server's
      // reason). The staged edits stay so the save can be retried, and onSave
      // (which closes or leaves) is not called.
      return
    }
    everyTime.leave()
    resetAllPending()
    // Reset whichever date hook is active (bulk or single) so the panel's
    // staged state clears on save — otherwise a re-open of the same selection
    // would show stale delta/absolute indicators.
    reset()
    onSave?.()
  }, [everyTime, saveEveryTime, applyAllPendingChanges, resetAllPending, reset, onSave])

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
    everyTime.leave()
    everyTime.setStaged(null)
    if (isCreateMode) setCreateTitle(initialTitle ?? '')
    onCancel?.()
  }, [reset, resetAllPending, everyTime, onCancel, isCreateMode, initialTitle])

  // Reset handler for the Reset button - clears all pending changes (create
  // mode: a staged schedule too)
  const handleReset = useCallback(() => {
    reset()
    resetAllPending()
    everyTime.setStaged(null)
  }, [reset, resetAllPending, everyTime])

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

  // THE WAY INTO EVERY-TIME MODE (§2.2, A8): "↻ Repeats — <rule> · edit
  // every time ›" or "↻ Make it repeat ›" — the only way in (the grey
  // recurrence box and the Repeat button are gone). Not for a reminder or a
  // quota (A12: their own editors own their schedules), nor a done task.
  // Disabled while this mode has unsaved edits (§2.3), and in bulk unless
  // every selected task can take one rule (A11, `bulkEveryTimeGate`).
  const editingBlocked = thisOneDirty && !isCreateMode
  const repeatLink = repeatLinkFor({
    canEdit,
    isBulkMode,
    isCreateMode,
    task: effectiveTask,
    isReminderLike,
    selectedTasks: selectedTasks ?? [],
    bulkSummary: isSelectionSheetMode ? (recurrenceSummary ?? null) : null,
    staged: stagedSchedule,
    editingBlocked,
    onOpen: () => everyTime.enter(),
  })

  // Task age — "since X" text shown beside "↻ Make it repeat ›", for a single
  // existing ONE-OFF only. The anchor rules live in formatTaskSince. The text
  // is computed when the task or timezone changes, not on a clock tick.
  // A REPEATING task has none (2026-10-24): beside "↻ Repeats — <rule> · edit
  // every time ›" it wrapped onto a line of its own, and what it said — when
  // this occurrence arrived — the rows above already say ("This is the Fri
  // Oct 16 one", or the Target row's date and "· 7 days ago").
  const sinceInfo = useMemo(() => {
    if (!effectiveTask || isBulkMode || isSelectionSheetMode || isCreateMode) return null
    if (effectiveTask.rrule) return null
    return formatTaskSince(effectiveTask, timezone, dayStart)
  }, [effectiveTask, isBulkMode, isSelectionSheetMode, isCreateMode, timezone, dayStart])

  // THE DEADLINE ROW and THE TARGET ROW's value (§3) — see `ThisOneFields`.
  const stagedDeadlineValue =
    pendingDeadline !== undefined ? pendingDeadline : (effectiveTask?.deadline_at ?? null)
  const deadlineRow = deadlineRowFor({
    hidden: isBulkMode || isReminderLike,
    canEdit,
    task: effectiveTask,
    stagedAnchor: stagedSchedule?.draft.anchor ?? null,
    stagedFirstDeadline: stagedCreateFields?.deadline_at ?? null,
    rule: displayRrule,
    deadlineAnchored,
    editingBlocked,
    value: stagedDeadlineValue,
    dirty: pendingDeadline !== undefined,
    onChange: setPendingDeadline,
    onOpenEveryTime: () => everyTime.enter({ focusDeadline: true }),
    targetSlotLabel:
      linkable.slots.find((slot) => slot.id === effectiveTask?.target_slot_id)?.label ?? null,
  })
  // A ONE-OFF'S RELATIVE TARGET (2026-10-24): see `useRelativeTarget`.
  const relativeOneOff = !isBulkMode && !isReminderLike && !displayRrule
  const relativeOffered =
    canEdit &&
    relativeOneOff &&
    !stagedSchedule &&
    (isCreateMode || (!!effectiveTask && !effectiveTask.done))
  // A pick staged, then no longer possible (the deadline removed — ruling 5 —
  // or the Reminder toggle staged after it): it goes, never sent (adjusted
  // during render, as the deck's and the lead's are).
  if (pendingRelative && (!relativeOffered || !stagedDeadlineValue)) setPendingRelative(null)
  const relativeTarget = useRelativeTarget({
    task: effectiveTask,
    pending: pendingRelative,
    setPending: setPendingRelative,
    onStage: dropStagedDate,
    offered: relativeOffered,
    oneOff: relativeOneOff,
    deadline: stagedDeadlineValue,
    deadlineStaged: pendingDeadline !== undefined,
    fixedStaged: isDateDirty || pendingDueAtCleared || deckStaged,
    slots: linkable.slots,
    morning: linkable.morning,
    timezone,
    dayStart,
  })
  const relativeAt = relativeTarget.preview?.at ?? null
  useEffect(() => {
    relativeBaseRef.current = relativeAt
  })
  const derivedTarget = deadlineAnchored
    ? derivedTargetFor(effectiveTask, pendingDeadline, { timezone, morningTime, dayStart })
    : null
  const targetValue = targetValueFor({
    timezone,
    queued: !!queuedOccurrence,
    dateDirty: isDateDirty,
    none: showsNoTarget ? { dirty: pendingDueAtCleared || (deckStaged && !allNoDueDate) } : null,
    header: headerText,
    relative: relativeText,
    past: isPast,
    delta: effectiveDeltaDisplay,
    staged: isBulkMode ? null : (pendingDueAt ?? (isDateDirty ? workingDate : null)),
    deadline: stagedDeadlineValue,
    derived: derivedTarget,
    relativeTarget: relativeTarget.targetValue,
  })
  // THE LEAD TIME ROW (the deadlines page, 2026-10-22; Upcoming's form,
  // 2026-10-25): see `leadRowFor` and `stagedUpcomingAnchor`.
  const leadRow = leadRowFor({
    show: !isBulkMode && !isCreateMode && !isReminderLike && !effectiveTask?.done,
    task: effectiveTask,
    queueEnabled,
    showsNoTarget,
    upcomingAnchor: stagedUpcomingAnchor({
      queued: !!queuedOccurrence && !isDateDirty,
      deck: deckStaged ? (pendingDeck as string) : null,
      cleared: pendingDueAtCleared,
      fixed: isBulkMode ? null : (pendingDueAt ?? (isDateDirty ? workingDate : null)),
      deadline: stagedDeadlineValue,
      relative: relativeTarget.targetValue?.dirty ? relativeAt : null,
      derived: derivedTarget,
    }),
    restamp:
      pendingDeadline !== undefined && pendingDeadline !== (effectiveTask?.deadline_at ?? null),
    pendingDeadline,
    pendingLeadDays,
    timezone,
    rolloverTime,
    dayStart,
    onLeadDays: setPendingLeadDays,
    disabled: !canEdit,
  })
  // A lead staged while the row was shown, then hidden (a target, a cleared
  // deadline or the Reminder toggle staged after it): the lead goes too —
  // never sent for a row the panel no longer shows (adjusted during render,
  // as the deck's is).
  if (!leadRow && pendingLeadDays !== undefined) setPendingLeadDays(undefined)
  // Create mode with a staged deadline-anchored repeat: the offsets set the
  // target (`draftToCreateFields` sends no `due_at`) — said in words, no pad.
  const targetText =
    stagedSchedule?.draft.anchor === 'deadline'
      ? relativeTargetWords(stagedSchedule.draft.daysBefore, stagedSchedule.draft.targetTime)
      : null

  // Focus and scroll when the mode changes (§11, §12): into every-time, the
  // banner heading takes focus and a scrolled sheet goes back to its top;
  // back, the link takes it again. A polite live region names the mode.
  const everyTimeHeadingRef = useRef<HTMLHeadingElement>(null)
  const repeatLinkRef = useRef<HTMLButtonElement>(null)
  const inEveryTime = everyTime.mode === 'everyTime'
  const wasEveryTime = useRef(false)
  // Read in the effect below without making it re-run on every draft change.
  const focusDeadlineRef = useRef(false)
  useEffect(() => {
    focusDeadlineRef.current = !!everyTime.session?.focusDeadline
  })
  useEffect(() => {
    if (inEveryTime === wasEveryTime.current) return
    wasEveryTime.current = inEveryTime
    if (inEveryTime) {
      const heading = everyTimeHeadingRef.current
      scrollParentToTop(heading)
      // Opened from the Deadline row, "+ Add" keeps the focus it took on mount.
      if (!focusDeadlineRef.current) heading?.focus({ preventScroll: true })
    } else {
      repeatLinkRef.current?.focus({ preventScroll: true })
    }
  }, [inEveryTime])

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

  // EVERY-TIME MODE replaces the whole body (mock E): the teal banner and the
  // schedule's rows on the same surface (no frame of its own), with no pad,
  // no chip row and no notes. See `EveryTimePanel`.
  if (everyTime.session) {
    const s = everyTime.session
    const everyTimeTitle = isCreateMode ? createTitle.trim() || 'New task' : title
    return (
      <div className="space-y-3">
        <span className="sr-only" aria-live="polite">
          {everyTime.announce}
        </span>
        <EveryTimePanel
          variant={isCreateMode ? 'create' : isBulkMode ? 'bulk' : 'single'}
          title={
            everyTimeTitle ? (
              <p
                className={cn(
                  'font-medium break-words',
                  titleVariant === 'prominent' ? 'text-lg' : 'text-sm',
                )}
              >
                {everyTimeTitle}
              </p>
            ) : null
          }
          task={s.task}
          initial={s.initial}
          draft={s.draft}
          dispatch={everyTime.dispatch}
          ctx={s.ctx}
          bulkCount={selectedTasks?.length ?? 0}
          focusDeadline={s.focusDeadline}
          canStop={
            isCreateMode
              ? !!stagedSchedule
              : isBulkMode
                ? (selectedTasks ?? []).some((t) => !!t.rrule)
                : !!effectiveTask?.rrule
          }
          saveable={everyTime.saveable}
          saving={saving}
          headingRef={everyTimeHeadingRef}
          onBack={everyTime.back}
          onSave={isCreateMode ? everyTime.stage : () => void handleSave()}
          onReset={everyTime.reset}
          // Create mode: Cancel leaves every time (the draft dropped), never
          // the whole add form. Editing: the discard question when changed.
          onCancel={isCreateMode ? everyTime.leave : () => everyTime.cancel(handleCancel)}
          locked={everyTime.locked}
          problem={everyTime.problem}
          slots={linkable.slots}
        />
        <AlertDialog
          open={everyTime.confirm !== null}
          onOpenChange={(open) => !open && everyTime.setConfirm(null)}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Discard changes to every time?</AlertDialogTitle>
              <AlertDialogDescription>
                Your changes to the schedule haven&apos;t been saved.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep editing</AlertDialogCancel>
              <AlertDialogAction
                variant="outline"
                onClick={everyTime.confirm === 'cancel' ? handleCancel : everyTime.leave}
              >
                Discard
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {/* The mode's live region (§12): the same element as every-time's, at
          the same place, so it stays mounted and "Back to this one" is read. */}
      <span className="sr-only" aria-live="polite">
        {everyTime.announce}
      </span>
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
            THIS ONE (§3): the Target / Deadline / On deck rows, the "This is
            the … one" line and the way into every-time mode — see
            `ThisOneFields`. The Target row's picker works in single and
            multi-task mode alike: in bulk mode a picked date stages an
            ABSOLUTE target for every selected task (bulkHook.setAbsoluteTarget),
            exactly like the 9:00 AM / Now presets, so it saves through the
            same path: bulk/snooze (or bulk/edit alongside other fields) with
            include_task_ids, behind the same "Confirm date change" dialog.
          */}
          <ThisOneFields
            timezone={timezone}
            occurrence={occurrenceLine}
            target={{
              readonlyText: targetText,
              picker: {
                value: isBulkMode
                  ? (bulkHook.presetTime ?? bulkHook.earliestDueAt)
                  : (relativeAt ?? pendingDueAt ?? workingDate ?? effectiveTask?.due_at ?? null),
                timezone,
                // Clear is "Remove target", on a deadline task too
                // (2026-10-22). A repeating task's target has no Clear at
                // all (§3); with the task queue off, nor has an automatic one.
                allowClear: isBulkMode
                  ? canBulkClearDueDate
                  : !displayRrule && !effectiveTask?.target_auto,
                clearLabel: isBulkMode ? undefined : REMOVE_TARGET,
                // "Before the deadline" (relative targets, 2026-10-24): it
                // replaces the old "Morning of the deadline" pick (ruling 4).
                beforeCalendar: relativeTarget.beforeCalendar,
                emptyDefault: isBulkMode ? 'now' : 'tomorrow',
                onChange: isBulkMode ? handleBulkPickerChange : handleSinglePickerChange,
              },
              value: targetValue,
            }}
            deadline={deadlineRow}
            lead={leadRow}
            // A one-off with a target the user picked is quiet until its
            // date (spec §1/§8.5, 2026-10-12): its horizon decides nothing
            // until the target is removed, and the rows say so. An automatic
            // deadline target keeps the horizon working. Read from the target
            // row's own (staged) value, so Remove target
            // staged brings the horizon back at once. Only a REAL target:
            // `workingDate` is the picker's working value and is set even
            // with no target, so it counts only once a date is staged
            // (`isDateDirty`) — it made a task with no target read "quiet
            // until <today>" (2026-10-15).
            quietUntil={
              isBulkMode || isReminderLike || displayRrule || showsNoTarget
                ? null
                : (relativeAt ??
                  pendingDueAt ??
                  (isDateDirty ? workingDate : null) ??
                  effectiveTask?.due_at ??
                  null)
            }
            deck={
              // ON DECK (D2, spec rule 8): not a reminder or quota (rule 6),
              // one task at a time, with the task queue on.
              showDeckLine && effectiveTask ? (
                <OnDeckLine
                  task={effectiveTask}
                  timezone={timezone}
                  staged={pendingDeck}
                  shadowed={deckShadowed}
                  limit={stagedDeckLimit}
                  onStage={stageDeck}
                  showLabel={false}
                />
              ) : null
            }
            link={repeatLink}
            linkRef={repeatLinkRef}
            since={
              sinceInfo && (
                <SinceAge
                  label={sinceInfo.label}
                  timeAgo={sinceInfo.timeAgo}
                  fullDate={sinceInfo.fullDate}
                />
              )
            }
          />
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
                        <LabelName label={label} />
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
                                    <LabelName label={c.name} />
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
                        <LabelName label={label} />
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
                {/* Auto-snooze picker — per-task notification repeat interval.
                    Never for a reminder (Trent, 2026-10-26: "Turn off every
                    nag-specific option for reminders"): its priority alone
                    decides its pushes. Not shown while the Reminder switch
                    is on either; the stored value is left as it is. */}
                {!displayIsReminder &&
                  (() => {
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

                    const nagTrigger = nagTriggerText(isMixedAutoSnooze, effectiveMinutes)

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
                              label="Nag off"
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
                            title={nagTrigger.title}
                          >
                            <Timer className="size-4" />
                            <span>{nagTrigger.label}</span>
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
                      {/* Clear the target — a single one-off, a deadline one
                          too (2026-10-22: it goes on the deadlines page). Not
                          on a repeating task: nothing in this mode removes a
                          rule (§3). */}
                      {isSingleTask && singleTargetReset && !pendingDueAtCleared && (
                        <DropdownMenuItem
                          // `inset` matches the left padding DropdownMenuCheckboxItem
                          // reserves for its tick, so the icons and labels in this
                          // mixed menu sit on one line (Trent, 2026-09-06: "reminder
                          // and due date are not aligned right").
                          inset
                          data-target-reset={singleTargetReset}
                          onClick={() => setPendingDueAtCleared(true)}
                        >
                          <XCircle className="mr-2 size-4" />
                          {REMOVE_TARGET}
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

      {/* 4x3 Date grid — this occurrence's target. Not while a staged
          deadline-anchored repeat sets the target (create mode). */}
      {!targetText && (
        <div className="grid grid-cols-4 gap-1.5">
          {/* Row 1: Preset times (Settings → Number pad). Keyed by position:
            two buttons may resolve to the same time, and both still show. */}
          {padPresets.map((preset, index) => {
            const [hour, minute] = preset.time.split(':').map(Number)
            return (
              <GridButton
                key={index}
                label={formatClockTime(preset.time)}
                onClick={() => handlePresetClick(hour, minute)}
              />
            )
          })}

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
      )}

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
            disabled={!createTitle.trim()}
            className="flex-1"
          >
            Create Task
          </Button>
        ) : (
          <Button
            variant="default"
            size="sm"
            onClick={() => void handleSave()}
            disabled={!isDirty || saving}
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
