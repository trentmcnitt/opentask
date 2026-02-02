'use client'

import { Check, X, ChevronUp, Trash2, ArrowUp, ArrowDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'

interface FloatingActionBarProps {
  selectedCount: number
  onDone: () => void
  onSnooze1h: () => void
  onSnooze2h: () => void
  onSnoozeTomorrow: () => void
  onDelete: () => void
  onPriorityHigh: () => void
  onPriorityLow: () => void
  onClear: () => void
  onMoveToProject?: () => void
  onCustomSnooze?: () => void
}

export function FloatingActionBar({
  selectedCount,
  onDone,
  onSnooze1h,
  onSnooze2h,
  onSnoozeTomorrow,
  onDelete,
  onPriorityHigh,
  onPriorityLow,
  onClear,
  onMoveToProject,
  onCustomSnooze,
}: FloatingActionBarProps) {
  if (selectedCount === 0) return null

  return (
    <div className="animate-slide-up fixed bottom-20 left-1/2 z-50 max-w-[calc(100vw-2rem)] -translate-x-1/2 md:bottom-6">
      <div
        className="bg-primary text-primary-foreground flex items-center gap-2 rounded-xl px-4 py-3 shadow-xl"
        aria-live="polite"
      >
        <span className="mr-2 text-sm font-medium">{selectedCount} selected</span>

        <Button
          size="sm"
          variant="secondary"
          onClick={onDone}
          className="bg-green-600 text-white hover:bg-green-700"
        >
          <Check className="mr-1 size-4" />
          Done
        </Button>

        <Button
          size="sm"
          variant="secondary"
          onClick={onSnooze1h}
          className="hidden md:inline-flex"
        >
          +1h
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={onSnooze2h}
          className="hidden md:inline-flex"
        >
          +2h
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={onSnoozeTomorrow}
          className="hidden md:inline-flex"
        >
          9AM
        </Button>

        {/* Overflow menu */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="secondary" aria-label="More actions">
              <ChevronUp className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="top">
            <DropdownMenuItem onClick={onSnooze1h} className="md:hidden">
              +1h Snooze
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onSnooze2h} className="md:hidden">
              +2h Snooze
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onSnoozeTomorrow} className="md:hidden">
              9AM Tomorrow
            </DropdownMenuItem>
            <DropdownMenuSeparator className="md:hidden" />
            <DropdownMenuItem onClick={onPriorityHigh}>
              <ArrowUp className="size-4 text-orange-500" />
              Priority: High
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onPriorityLow}>
              <ArrowDown className="size-4 text-blue-500" />
              Priority: Low
            </DropdownMenuItem>

            {onMoveToProject && (
              <DropdownMenuItem onClick={onMoveToProject}>Move to Project</DropdownMenuItem>
            )}

            {onCustomSnooze && (
              <DropdownMenuItem onClick={onCustomSnooze}>Custom Snooze</DropdownMenuItem>
            )}

            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              <Trash2 className="size-4" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

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
  )
}
