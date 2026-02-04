'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import { Repeat, Timer, Bell, Trash2, MoreHorizontal, Info, FolderInput } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { useQuickSelectDate } from '@/hooks/useQuickSelectDate'
import { useBulkQuickSelectDate } from '@/hooks/useBulkQuickSelectDate'
import { formatRRuleCompact, formatBulkRecurrence } from '@/lib/format-rrule'
import { PRESET_TIMES, INCREMENTS, DECREMENTS } from '@/lib/quick-select-dates'
import { RecurrencePicker } from '@/components/RecurrencePicker'
import { PRIORITY_OPTIONS } from '@/lib/priority'
import type { Task } from '@/types'

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
  onRruleChange?: (rrule: string | null) => void
  /** Called to open project picker */
  onMoveToProject?: () => void
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
  onMoveToProject,
  onDelete,
  open = true,
  onCancel,
  onSave,
  onNavigateToDetail,
  recurrenceSummary,
  titleVariant = 'compact',
  onTitleChange,
  showCompletedBadge = false,
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

  // Single task mode hook
  const dueAt = effectiveTask?.due_at ?? null
  const singleHook = useQuickSelectDate({ dueAt, timezone })

  // Bulk mode hook
  const bulkHook = useBulkQuickSelectDate({
    tasks: selectedTasks ?? [],
    timezone,
  })

  // Use the appropriate hook based on mode
  const isDirty = isBulkMode ? bulkHook.isDirty : singleHook.isDirty
  const headerText = isBulkMode ? bulkHook.headerText : singleHook.headerText
  const relativeText = isBulkMode ? bulkHook.relativeText : singleHook.relativeText
  const isPast = isBulkMode ? bulkHook.isPast : singleHook.isPast
  const deltaDisplay = isBulkMode ? bulkHook.deltaDisplay : singleHook.deltaDisplay
  const applyPreset = isBulkMode ? bulkHook.applyPreset : singleHook.applyPreset
  const applyIncrement = isBulkMode ? bulkHook.applyIncrement : singleHook.applyIncrement
  const reset = isBulkMode ? bulkHook.reset : singleHook.reset
  const workingDate = singleHook.workingDate

  const handleApply = useCallback(() => {
    if (isBulkMode) {
      const result = bulkHook.getResult()
      if (result?.type === 'absolute') {
        onDateChange(result.until)
      } else if (result?.type === 'relative' && onDateChangeRelative) {
        onDateChangeRelative(result.deltaMinutes)
      }
    } else {
      onDateChange(workingDate)
    }
  }, [isBulkMode, bulkHook, workingDate, onDateChange, onDateChangeRelative])

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
    if (isDirty) {
      handleApply()
    }
    onSave?.()
  }, [isDirty, handleApply, onSave])

  const handleCancel = useCallback(() => {
    reset()
    onCancel?.()
  }, [reset, onCancel])

  // In sheet mode with selectedCount, SelectionActionSheet owns title and quick-links
  // (SnoozeSheet also uses sheet mode but doesn't pass selectedCount, so it still shows the title)
  const isSelectionSheetMode = mode === 'sheet' && selectedCount !== undefined

  // Compute title:
  // - SelectionActionSheet (sheet mode with selectedCount): hide title, modal shows it
  // - SnoozeSheet (sheet mode without selectedCount): show task title
  // - inline/popover: show count for bulk or task title
  const title = isSelectionSheetMode
    ? null
    : selectedCount && selectedCount > 1
      ? `${selectedCount} tasks selected`
      : (effectiveTask?.title ?? 'Set date')

  // Compute recurrence text for header display
  // In SelectionActionSheet (sheet mode with selectedCount), use the recurrenceSummary prop
  // In other modes, compute from effectiveTask or selectedTasks
  const recurrenceText = (() => {
    if (isSelectionSheetMode) {
      return recurrenceSummary ?? null
    }
    if (isBulkMode) {
      return formatBulkRecurrence(selectedTasks ?? [])
    }
    const rrule = effectiveTask?.rrule
    if (!rrule) return null
    return formatRRuleCompact(rrule)
  })()

  // Toggle recurrence picker (for inline mode)
  const handleRecurrenceToggle = useCallback(() => {
    setEditingRecurrence((prev) => !prev)
  }, [])

  // Handle title editing
  const handleTitleSave = useCallback(() => {
    if (titleDraft.trim() && titleDraft.trim() !== effectiveTask?.title) {
      onTitleChange?.(titleDraft.trim())
    }
    setEditingTitle(false)
  }, [titleDraft, effectiveTask?.title, onTitleChange])

  const handleTitleClick = useCallback(() => {
    if (onTitleChange && effectiveTask) {
      setTitleDraft(effectiveTask.title)
      setEditingTitle(true)
    }
  }, [onTitleChange, effectiveTask])

  // In SelectionActionSheet mode, the modal header renders quick-links
  // In SnoozeSheet mode (sheet without selectedCount), we still show quick-links here
  const showQuickLinks = !isSelectionSheetMode

  return (
    <div className="space-y-3">
      {/* Header row */}
      <div className={cn('flex justify-between gap-2', title ? 'items-start' : 'items-center')}>
        <div className="min-w-0 flex-1">
          {/* Title: editable when onTitleChange provided, otherwise static */}
          {title && (
            <>
              {onTitleChange && editingTitle ? (
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
                <p
                  className={cn(
                    'truncate font-medium',
                    titleVariant === 'prominent' ? 'text-lg' : 'text-sm',
                    onTitleChange && 'hover:text-primary cursor-pointer transition-colors',
                  )}
                  onClick={handleTitleClick}
                >
                  {title}
                </p>
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
          <p className="text-muted-foreground text-xs">
            <span>{headerText}</span>
            <span className="mx-1">&middot;</span>
            <span className={cn(isPast && 'text-destructive font-medium')}>{relativeText}</span>
          </p>
          {/* Recurrence summary line (with icon) - only in SelectionActionSheet mode */}
          {isSelectionSheetMode && recurrenceText && (
            <p className="text-muted-foreground mt-0.5 text-xs">
              <Repeat className="mr-1 inline size-3" />
              {recurrenceText}
            </p>
          )}
          {/* Recurrence inline (without icon) - for non-SelectionActionSheet modes */}
          {!isSelectionSheetMode && recurrenceText && (
            <p className="text-muted-foreground text-xs">
              <span className="mr-1">&middot;</span>
              <span>{recurrenceText}</span>
            </p>
          )}
          {/* Staged delta indicator - show in blue when dirty with delta operation */}
          {deltaDisplay && (
            <p className="mt-0.5 text-xs font-medium text-blue-500">{deltaDisplay}</p>
          )}
        </div>

        {/* Action icons - only show when not in sheet mode */}
        {showQuickLinks && (
          <div className="flex items-center gap-0.5">
            {/* Recurrence button - only show for single task in inline mode with onRruleChange */}
            {isSingleTask && mode === 'inline' && onRruleChange && (
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

            {/* More menu - show when priority, move to project, or task details available */}
            {(onPriorityChange || onMoveToProject || (isSingleTask && onNavigateToDetail)) && (
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
                  {onPriorityChange && (
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger>Priority</DropdownMenuSubTrigger>
                      <DropdownMenuSubContent>
                        {PRIORITY_OPTIONS.map((opt) => (
                          <DropdownMenuItem
                            key={opt.value}
                            onClick={() => onPriorityChange(opt.value)}
                            className={opt.color}
                          >
                            {opt.label}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  )}
                  {onMoveToProject && (
                    <DropdownMenuItem onClick={onMoveToProject}>
                      <FolderInput className="mr-2 size-4" />
                      Move to Project
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
      </div>

      {/* Expandable recurrence section (inline mode, single task only) */}
      {mode === 'inline' && isSingleTask && editingRecurrence && onRruleChange && (
        <div className="rounded-lg border p-3">
          <RecurrencePicker value={effectiveTask?.rrule} onChange={onRruleChange} />
        </div>
      )}

      {/* Apply button (inline mode only) */}
      {mode === 'inline' && (
        <Button onClick={handleApply} disabled={!isDirty} className="w-full" size="sm">
          Apply
        </Button>
      )}

      {/* Bottom action bar - Save/Reset/Cancel (popover/sheet with explicit handlers) */}
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
            onClick={reset}
            disabled={!isDirty}
            className="flex-1"
          >
            Reset
          </Button>
          <Button variant="outline" size="sm" onClick={handleCancel} className="flex-1">
            Cancel
          </Button>
        </div>
      )}
    </div>
  )
}

/** Internal ref-forwarding wrapper for auto-save on dismiss */
QuickActionPanel.displayName = 'QuickActionPanel'

function GridButton({
  label,
  onClick,
  variant = 'preset',
}: {
  label: string
  onClick: () => void
  variant?: 'preset' | 'increment' | 'decrement'
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
        variant === 'preset' && 'bg-card hover:bg-accent border-border',
        variant === 'increment' &&
          'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-400 dark:hover:bg-emerald-950/50',
        variant === 'decrement' &&
          'border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-400 dark:hover:bg-amber-950/50',
      )}
    >
      {label}
    </button>
  )
}

function IconButton({
  icon,
  label,
  onClick,
  disabled = false,
  destructive = false,
  active = false,
}: {
  icon: React.ReactNode
  label: string
  onClick?: () => void
  disabled?: boolean
  destructive?: boolean
  active?: boolean
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn(
        'size-8',
        disabled && 'text-muted-foreground/40 cursor-not-allowed',
        destructive && 'hover:text-destructive',
        active && 'bg-accent text-accent-foreground',
      )}
      onClick={disabled ? undefined : onClick}
      aria-label={label}
      title={label}
      disabled={disabled}
    >
      {icon}
    </Button>
  )
}
