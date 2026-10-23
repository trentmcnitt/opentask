'use client'

import { useState } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { TargetMenu } from '@/components/TargetMenu'
import { REMOVE_TARGET } from '@/lib/task-model-words'
import { targetTimeMenu } from '@/lib/row-corner'
import type { Task } from '@/types'

/**
 * The dashboard row's TARGET TIME ("3h ago · 9:00 AM") as a control
 * (2026-10-14). A tap — phone or desktop — opens a small menu:
 *
 *   Remove target   (a deadline task too, 2026-10-22: it goes on the
 *                    deadlines page; never on a repeating task —
 *                    `targetTimeMenu`)
 *   Move…           → the Target menu (`TargetMenu`), anchored on the time
 *
 * On desktop, hovering the row also shows a small × right after the time
 * that removes the target in one click (tooltip "Remove target"). Every action goes through the dashboard's own paths — Remove target
 * through `onRemoveTarget` (a PATCH), Move… through `onMove` (the row's
 * snooze) — so each one toasts with Undo.
 *
 * Presses never act on the row: clicks and keys (from the portalled menus
 * too) are stopped by the wrapper, as on the Today button, and
 * `data-no-row-press` keeps the row's long-press (selection) from starting
 * here. Pointerdown itself is NOT stopped: the row's swipe (use-gesture with
 * `filterTaps`) swallows any click whose pointerdown it never saw — the menu's
 * items and the × would never fire.
 */
export function TargetTimeText({
  task,
  timezone,
  relative,
  absolute,
  relativeClassName,
  onMove,
  onRemoveTarget,
}: {
  task: Task
  timezone: string
  relative: string
  absolute: string | null
  relativeClassName?: string
  onMove: (at: string) => void
  onRemoveTarget?: (task: Task) => void
}) {
  const [moveOpen, setMoveOpen] = useState(false)
  const { reset } = targetTimeMenu(task)
  const resetWord = onRemoveTarget && reset ? REMOVE_TARGET : null
  const label = absolute ? `${relative} · ${absolute}` : relative
  return (
    <span
      className="contents"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <TargetMenu
        task={task}
        timezone={timezone}
        open={moveOpen}
        onOpenChange={setMoveOpen}
        onPick={onMove}
        current={task.due_at}
      >
        <span className="inline-flex items-center">
          <DropdownMenu>
            <DropdownMenuTrigger
              data-target-time
              data-no-row-press
              onClick={(e) => e.stopPropagation()}
              aria-label={`Target ${label}. Options`}
              className="hover:bg-foreground/5 data-[state=open]:bg-foreground/10 -mx-1 -my-0.5 inline-flex touch-manipulation items-center gap-1 rounded px-1 py-0.5 whitespace-nowrap"
            >
              <span className={relativeClassName}>{relative}</span>
              {absolute && (
                <>
                  <span className="text-muted-foreground/50">·</span>
                  <span>{absolute}</span>
                </>
              )}
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              data-no-row-press
              onClick={(e) => e.stopPropagation()}
            >
              {resetWord && (
                <DropdownMenuItem data-remove-target onSelect={() => onRemoveTarget?.(task)}>
                  {resetWord}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem data-move-target onSelect={() => setMoveOpen(true)}>
                Move…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {resetWord && (
            <button
              type="button"
              data-remove-target-x
              data-no-row-press
              onClick={(e) => {
                e.stopPropagation()
                onRemoveTarget?.(task)
              }}
              title={resetWord}
              aria-label={`${resetWord}: "${task.title}"`}
              className={cn(
                // Desktop hover only (a finger has the menu above): hidden
                // without a fine pointer, invisible until the row is hovered
                // or this has keyboard focus.
                'text-muted-foreground hover:text-foreground hover:bg-foreground/10 ml-0.5 hidden size-4 items-center justify-center rounded-sm opacity-0 transition-opacity pointer-fine:inline-flex',
                'group-hover:opacity-100 focus-visible:opacity-100',
              )}
            >
              <X className="size-3" strokeWidth={2.5} />
            </button>
          )}
        </span>
      </TargetMenu>
    </span>
  )
}
