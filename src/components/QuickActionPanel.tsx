'use client'

import { useCallback, useEffect, useRef } from 'react'
import { Repeat, Timer, Bell, FolderInput, Trash2, MoreHorizontal, Info } from 'lucide-react'
import { Button } from '@/components/ui/button'
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
import { formatRRuleCompact } from '@/lib/format-rrule'
import { PRESET_TIMES, INCREMENTS, DECREMENTS } from '@/lib/quick-select-dates'
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
  /** Called to open recurrence editor */
  onRecurrence?: () => void
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
  /** Hide recurrence icon (e.g. in bulk mode) */
  hideRecurrence?: boolean
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
  onRecurrence,
  onMoveToProject,
  onDelete,
  open = true,
  onCancel,
  onSave,
  onNavigateToDetail,
  hideRecurrence = false,
}: QuickActionPanelProps) {
  // Determine if we're in bulk mode (no single task, but multiple selected)
  const isBulkMode = !task && (selectedTasks?.length ?? 0) > 0

  // Single task mode hook
  const dueAt = task?.due_at ?? null
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

  // Compute title: multiple tasks shows count, single task in bulk mode hides title (modal shows it)
  // For inline/popover mode with single task, show the title
  const title =
    selectedCount && selectedCount > 1
      ? `${selectedCount} tasks selected`
      : selectedCount === 1
        ? null // Single task in sheet mode - modal title shows task name
        : (task?.title ?? 'Set date')

  // Compute recurrence text for header (only show if task has rrule, not just "always visible")
  const recurrenceText = (() => {
    if (isBulkMode) return null // No recurrence display in bulk mode
    const rrule = task?.rrule
    if (!rrule) return null
    return formatRRuleCompact(rrule)
  })()

  // Is this a single task? (not bulk mode)
  const isSingleTask = !isBulkMode && !!task

  return (
    <div className="space-y-3">
      {/* Header row */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          {title && <p className="truncate text-sm font-medium">{title}</p>}
          <p className="text-muted-foreground text-xs">
            <span>{headerText}</span>
            <span className="mx-1">&middot;</span>
            <span className={cn(isPast && 'text-destructive font-medium')}>{relativeText}</span>
            {recurrenceText && (
              <>
                <span className="mx-1">&middot;</span>
                <span>{recurrenceText}</span>
              </>
            )}
          </p>
        </div>

        {/* Action icons */}
        <div className="flex items-center gap-0.5">
          {!hideRecurrence && onRecurrence && (
            <IconButton
              icon={<Repeat className="size-4" />}
              label="Recurrence"
              onClick={onRecurrence}
            />
          )}
          {/* Disabled stubs - always visible as separate buttons */}
          <IconButton icon={<Timer className="size-4" />} label="Auto-snooze interval" disabled />
          <IconButton icon={<Bell className="size-4" />} label="Critical alert" disabled />
          {onMoveToProject && (
            <IconButton
              icon={<FolderInput className="size-4" />}
              label="Move to project"
              onClick={onMoveToProject}
            />
          )}
          {onDelete && (
            <IconButton
              icon={<Trash2 className="size-4" />}
              label="Delete"
              onClick={onDelete}
              destructive
            />
          )}

          {/* More menu - show when priority or task details available */}
          {(onPriorityChange || (isSingleTask && onNavigateToDetail)) && (
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
                      <DropdownMenuItem onClick={() => onPriorityChange(0)}>None</DropdownMenuItem>
                      <DropdownMenuItem onClick={() => onPriorityChange(1)}>Low</DropdownMenuItem>
                      <DropdownMenuItem onClick={() => onPriorityChange(2)}>
                        Medium
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => onPriorityChange(3)}>High</DropdownMenuItem>
                      <DropdownMenuItem onClick={() => onPriorityChange(4)}>
                        Urgent
                      </DropdownMenuItem>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
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
}: {
  icon: React.ReactNode
  label: string
  onClick?: () => void
  disabled?: boolean
  destructive?: boolean
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn(
        'size-8',
        disabled && 'text-muted-foreground/40 cursor-not-allowed',
        destructive && 'hover:text-destructive',
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
