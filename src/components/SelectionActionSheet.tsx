'use client'

import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import {
  Check,
  X,
  FileText,
  Repeat,
  Timer,
  Bell,
  Trash2,
  MoreHorizontal,
  FolderInput,
  Info,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from '@/components/ui/dropdown-menu'
import { QuickActionPanel } from '@/components/QuickActionPanel'
import { RecurrencePicker } from '@/components/RecurrencePicker'
import { useTimezone } from '@/hooks/useTimezone'
import { formatBulkRecurrence } from '@/lib/format-rrule'
import { PRIORITY_OPTIONS } from '@/lib/priority'
import { cn } from '@/lib/utils'
import type { Task } from '@/types'

interface SelectionActionSheetProps {
  selectedCount: number
  /** The actual selected tasks (for showing their due dates in QuickActionPanel) */
  selectedTasks: Task[]
  onDone: () => void
  /** Called with absolute UTC time for preset operations */
  onSnooze: (until: string) => void
  /** Called with delta minutes for increment operations */
  onSnoozeRelative: (deltaMinutes: number) => void
  onDelete: () => void
  /** Called with absolute priority value (0-4) */
  onPriorityChange: (priority: number) => void
  onMoveToProject?: () => void
  onClear: () => void
  /** Called when user wants to navigate to task detail (single task only) */
  onNavigateToDetail?: (taskId: number) => void
  /** Called when recurrence changes for selected tasks */
  onRecurrenceChange?: (rrule: string | null) => void
}

export function SelectionActionSheet({
  selectedCount,
  selectedTasks,
  onDone,
  onSnooze,
  onSnoozeRelative,
  onDelete,
  onPriorityChange,
  onMoveToProject,
  onClear,
  onNavigateToDetail,
  onRecurrenceChange,
}: SelectionActionSheetProps) {
  const timezone = useTimezone()
  const [sheetOpen, setSheetOpen] = useState(false)
  const [isMobile, setIsMobile] = useState(true)
  const [showRecurrencePicker, setShowRecurrencePicker] = useState(false)
  const [pendingRrule, setPendingRrule] = useState<string | null | undefined>(undefined)

  // Track pending date change
  const pendingDateRef = useRef<
    { type: 'absolute'; until: string } | { type: 'relative'; deltaMinutes: number } | null
  >(null)

  // Compute bulk recurrence summary for display
  const recurrenceSummary = useMemo(() => {
    return formatBulkRecurrence(selectedTasks)
  }, [selectedTasks])

  // Get the effective rrule for the recurrence picker
  // If all tasks have same rrule, use that; otherwise null
  const effectiveRrule = useMemo(() => {
    const rrules = selectedTasks.map((t) => t.rrule).filter(Boolean) as string[]
    const unique = [...new Set(rrules)]
    return unique.length === 1 ? unique[0] : null
  }, [selectedTasks])

  // Detect mobile vs desktop
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 640)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  const openSheet = useCallback(() => {
    pendingDateRef.current = null
    setPendingRrule(undefined)
    setShowRecurrencePicker(false)
    setSheetOpen(true)
  }, [])

  // Track date changes but don't apply immediately
  const handleDateChange = useCallback((isoUtc: string) => {
    pendingDateRef.current = { type: 'absolute', until: isoUtc }
  }, [])

  const handleDateChangeRelative = useCallback((deltaMinutes: number) => {
    pendingDateRef.current = { type: 'relative', deltaMinutes }
  }, [])

  // Save button: apply pending changes, close, exit selection mode
  const handleSave = useCallback(() => {
    if (pendingDateRef.current) {
      if (pendingDateRef.current.type === 'absolute') {
        onSnooze(pendingDateRef.current.until)
      } else {
        onSnoozeRelative(pendingDateRef.current.deltaMinutes)
      }
    }
    // Apply pending recurrence change if any
    if (pendingRrule !== undefined && onRecurrenceChange) {
      onRecurrenceChange(pendingRrule)
    }
    setSheetOpen(false)
    onClear() // Exit selection mode
  }, [onSnooze, onSnoozeRelative, onClear, pendingRrule, onRecurrenceChange])

  // Cancel button: discard changes, close, keep selection
  const handleCancel = useCallback(() => {
    pendingDateRef.current = null
    setPendingRrule(undefined)
    setShowRecurrencePicker(false)
    setSheetOpen(false)
    // Keep selection mode active (don't call onClear)
  }, [])

  const handleDelete = useCallback(() => {
    onDelete()
    setSheetOpen(false)
    onClear() // Exit selection mode
  }, [onDelete, onClear])

  // Done button on floating bar (outside sheet)
  const handleFloatingDone = useCallback(() => {
    onDone()
  }, [onDone])

  const handleMoveToProject = useCallback(() => {
    onMoveToProject?.()
    setSheetOpen(false)
    onClear() // Exit selection mode
  }, [onMoveToProject, onClear])

  // On dismiss without explicit save/cancel: keep selection, don't apply changes
  const handleOpenChange = useCallback((open: boolean) => {
    if (!open) {
      pendingDateRef.current = null
      setPendingRrule(undefined)
      setShowRecurrencePicker(false)
    }
    setSheetOpen(open)
  }, [])

  // Toggle recurrence picker
  const handleRecurrenceToggle = useCallback(() => {
    setShowRecurrencePicker((prev) => !prev)
  }, [])

  // Handle recurrence change from picker
  const handleRecurrenceChange = useCallback((rrule: string | null) => {
    setPendingRrule(rrule)
  }, [])

  // Navigate to task detail (single task only)
  const handleNavigateToDetail = useCallback(() => {
    if (selectedCount === 1 && selectedTasks[0] && onNavigateToDetail) {
      onNavigateToDetail(selectedTasks[0].id)
    }
  }, [selectedCount, selectedTasks, onNavigateToDetail])

  if (selectedCount === 0) return null

  // Modal title: show task title for single task, count for multiple
  const modalTitle =
    selectedCount === 1 && selectedTasks[0]
      ? selectedTasks[0].title
      : `${selectedCount} tasks selected`

  // Quick-links component to render in modal header
  const quickLinks = (
    <div className="flex items-center gap-0.5">
      {/* Recurrence button - opens picker inline */}
      {onRecurrenceChange && (
        <IconButton
          icon={<Repeat className="size-4" />}
          label="Recurrence"
          onClick={handleRecurrenceToggle}
          active={showRecurrencePicker}
        />
      )}
      {/* Disabled stubs */}
      <IconButton icon={<Timer className="size-4" />} label="Auto-snooze interval" disabled />
      <IconButton icon={<Bell className="size-4" />} label="Critical alert" disabled />
      {/* Delete button */}
      <IconButton
        icon={<Trash2 className="size-4" />}
        label="Delete"
        onClick={handleDelete}
        destructive
      />
      {/* More menu with priority, move to project, task details */}
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
          {onMoveToProject && (
            <DropdownMenuItem onClick={handleMoveToProject}>
              <FolderInput className="mr-2 size-4" />
              Move to Project
            </DropdownMenuItem>
          )}
          {selectedCount === 1 && onNavigateToDetail && (
            <DropdownMenuItem onClick={handleNavigateToDetail}>
              <Info className="mr-2 size-4" />
              Task Details
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )

  const panelContent = (
    <div className="space-y-3">
      <QuickActionPanel
        task={null}
        selectedTasks={selectedTasks}
        selectedCount={selectedCount}
        timezone={timezone}
        mode="sheet"
        onDateChange={handleDateChange}
        onDateChangeRelative={handleDateChangeRelative}
        onSave={handleSave}
        onCancel={handleCancel}
        recurrenceSummary={recurrenceSummary}
      />
      {/* Expandable recurrence picker */}
      {showRecurrencePicker && onRecurrenceChange && (
        <div className="rounded-lg border p-3">
          <RecurrencePicker
            value={pendingRrule !== undefined ? pendingRrule : effectiveRrule}
            onChange={handleRecurrenceChange}
          />
        </div>
      )}
    </div>
  )

  return (
    <>
      {/* Floating trigger button */}
      <div className="animate-slide-up fixed bottom-20 left-1/2 z-50 max-w-[calc(100vw-2rem)] -translate-x-1/2 md:bottom-6">
        <div
          className="bg-primary text-primary-foreground flex items-center gap-2 rounded-xl px-4 py-3 shadow-xl"
          aria-live="polite"
        >
          {/* Show count only when multiple tasks selected */}
          {selectedCount > 1 && (
            <span className="mr-2 text-sm font-medium">{selectedCount} selected</span>
          )}

          <Button
            size="sm"
            variant="secondary"
            onClick={handleFloatingDone}
            className="bg-green-600 text-white hover:bg-green-700"
          >
            <Check className="mr-1 size-4" />
            Done
          </Button>

          {/* Details button - only show for single task selection */}
          {selectedCount === 1 && onNavigateToDetail && (
            <Button size="sm" variant="secondary" onClick={handleNavigateToDetail}>
              <FileText className="mr-1 size-4" />
              Details
            </Button>
          )}

          <Button size="sm" variant="secondary" onClick={openSheet}>
            More
          </Button>

          <Button
            variant="ghost"
            size="icon"
            onClick={onClear}
            aria-label="Clear selection"
            className="text-primary-foreground/60 hover:text-primary-foreground hover:bg-primary-foreground/10 ml-2"
          >
            <X className="size-4" />
          </Button>
        </div>
      </div>

      {/* Mobile: bottom sheet */}
      {isMobile ? (
        <Sheet open={sheetOpen} onOpenChange={handleOpenChange}>
          <SheetContent side="bottom" className="rounded-t-2xl" showCloseButton>
            <SheetHeader className="flex-row items-center justify-between gap-2 pr-10">
              <SheetTitle className="truncate">{modalTitle}</SheetTitle>
              {quickLinks}
              <SheetDescription className="sr-only">
                Adjust date, priority, and other settings for selected tasks
              </SheetDescription>
            </SheetHeader>
            <div className="px-4 pb-4">{panelContent}</div>
            <div className="h-6 sm:hidden" />
          </SheetContent>
        </Sheet>
      ) : (
        /* Desktop: centered dialog */
        <Dialog open={sheetOpen} onOpenChange={handleOpenChange}>
          <DialogContent className="w-[28rem] max-w-[calc(100%-2rem)] p-4">
            <DialogHeader className="flex-row items-center justify-between gap-2 pr-8">
              <DialogTitle className="truncate">{modalTitle}</DialogTitle>
              {quickLinks}
              <DialogDescription className="sr-only">
                Adjust date, priority, and other settings for selected tasks
              </DialogDescription>
            </DialogHeader>
            {panelContent}
          </DialogContent>
        </Dialog>
      )}
    </>
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
