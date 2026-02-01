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
    <div className="fixed bottom-20 md:bottom-6 left-1/2 -translate-x-1/2 z-50 animate-slide-up">
      <div className="flex items-center gap-2 px-4 py-3 bg-primary text-primary-foreground rounded-xl shadow-xl">
        <span className="text-sm font-medium mr-2">
          {selectedCount} selected
        </span>

        <Button
          size="sm"
          variant="secondary"
          onClick={onDone}
          className="bg-green-600 hover:bg-green-700 text-white"
        >
          <Check className="size-4 mr-1" />
          Done
        </Button>

        <Button size="sm" variant="secondary" onClick={onSnooze1h}>
          +1h
        </Button>
        <Button size="sm" variant="secondary" onClick={onSnooze2h}>
          +2h
        </Button>
        <Button size="sm" variant="secondary" onClick={onSnoozeTomorrow}>
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
            <DropdownMenuItem onClick={onPriorityHigh}>
              <ArrowUp className="size-4 text-orange-500" />
              Priority: High
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onPriorityLow}>
              <ArrowDown className="size-4 text-blue-500" />
              Priority: Low
            </DropdownMenuItem>

            {onMoveToProject && (
              <DropdownMenuItem onClick={onMoveToProject}>
                Move to Project
              </DropdownMenuItem>
            )}

            {onCustomSnooze && (
              <DropdownMenuItem onClick={onCustomSnooze}>
                Custom Snooze
              </DropdownMenuItem>
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
          className="ml-2 text-primary-foreground/60 hover:text-primary-foreground hover:bg-primary-foreground/10"
        >
          <X className="size-4" />
        </Button>
      </div>
    </div>
  )
}
