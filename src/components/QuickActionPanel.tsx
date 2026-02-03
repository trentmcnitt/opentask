'use client'

import { useCallback, useEffect, useRef } from 'react'
import { ArrowUp, ArrowDown, Repeat, Timer, Bell, FolderInput, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useQuickSelectDate } from '@/hooks/useQuickSelectDate'
import { PRESET_TIMES, INCREMENTS, DECREMENTS } from '@/lib/quick-select-dates'
import type { Task } from '@/types'

export interface QuickActionPanelProps {
  /** Task(s) being acted on. Single task or null for bulk. */
  task: Task | null
  /** Number of selected tasks (for bulk mode header) */
  selectedCount?: number
  /** User's IANA timezone */
  timezone: string
  /** "inline" shows Apply button; "popover"/"sheet" auto-saves on dismiss */
  mode: 'inline' | 'popover' | 'sheet'
  /** Called with the final date when saving */
  onDateChange: (isoUtc: string) => void
  /** Called on priority change (fires immediately) */
  onPriorityChange?: (delta: 1 | -1) => void
  /** Called to open recurrence editor */
  onRecurrence?: () => void
  /** Called to open project picker */
  onMoveToProject?: () => void
  /** Called to delete task(s) */
  onDelete?: () => void
  /** Whether the panel is open (used for auto-save on close in popover/sheet modes) */
  open?: boolean
  /** Hide recurrence icon (e.g. in bulk mode) */
  hideRecurrence?: boolean
}

export function QuickActionPanel({
  task,
  selectedCount,
  timezone,
  mode,
  onDateChange,
  onPriorityChange,
  onRecurrence,
  onMoveToProject,
  onDelete,
  open = true,
  hideRecurrence = false,
}: QuickActionPanelProps) {
  const dueAt = task?.due_at ?? null
  const { workingDate, isDirty, headerText, relativeText, isPast, applyPreset, applyIncrement } =
    useQuickSelectDate({ dueAt, timezone })

  const handleApply = useCallback(() => {
    onDateChange(workingDate)
  }, [onDateChange, workingDate])

  // Auto-save on dismiss for popover/sheet modes:
  // When `open` transitions from true to false, fire onDateChange if dirty.
  const workingDateRef = useRef(workingDate)
  const isDirtyRef = useRef(isDirty)
  useEffect(() => {
    workingDateRef.current = workingDate
    isDirtyRef.current = isDirty
  }, [workingDate, isDirty])

  const prevOpenRef = useRef(open)
  useEffect(() => {
    if (
      prevOpenRef.current &&
      !open &&
      isDirtyRef.current &&
      (mode === 'popover' || mode === 'sheet')
    ) {
      onDateChange(workingDateRef.current)
    }
    prevOpenRef.current = open
  }, [open, mode, onDateChange])

  const title = selectedCount
    ? `${selectedCount} task${selectedCount !== 1 ? 's' : ''} selected`
    : (task?.title ?? 'Set date')

  return (
    <div className="space-y-3">
      {/* Header row */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{title}</p>
          <p className="text-muted-foreground text-xs">
            <span>{headerText}</span>
            <span className="mx-1">&middot;</span>
            <span className={cn(isPast && 'text-destructive font-medium')}>{relativeText}</span>
          </p>
        </div>

        {/* Action icons */}
        <div className="flex items-center gap-0.5">
          {onPriorityChange && (
            <>
              <IconButton
                icon={<ArrowUp className="size-4" />}
                label="Priority up"
                onClick={() => onPriorityChange(1)}
              />
              <IconButton
                icon={<ArrowDown className="size-4" />}
                label="Priority down"
                onClick={() => onPriorityChange(-1)}
              />
            </>
          )}
          {!hideRecurrence && onRecurrence && (
            <IconButton
              icon={<Repeat className="size-4" />}
              label="Recurrence"
              onClick={onRecurrence}
            />
          )}
          {/* Disabled stubs */}
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
