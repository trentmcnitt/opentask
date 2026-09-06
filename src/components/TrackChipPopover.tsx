'use client'

import { useRouter } from 'next/navigation'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { trackState, periodLabel } from '@/lib/track'
import { formatRRule } from '@/lib/format-rrule'
import type { Task } from '@/types'

/**
 * What a quota is, in a bubble anchored to its own chip.
 *
 * Trent, 2026-09-06: "I wanted a popover, kind of like what we have for when
 * you highlight the total tasks overdue and the today count up in the top nav
 * bar… Obviously we'd need something more substantial than that multi-line
 * bubble, still the same concept but not hover. You'd actually have to press
 * and hold." So: the Header's popover, wider, opened by a long press.
 *
 * `PopoverAnchor` rather than `PopoverTrigger`, deliberately — the chip's own
 * click is +1, and a trigger would fight it for the same gesture. The chip
 * stays a plain button and this is positioned against it.
 *
 * It reads and does not edit ("I don't want an editable field"). Editing lives
 * one tap away in the quota's editor, which is also the answer to "how do I
 * even edit the Track items" — a quota is an ordinary task and Open is the
 * route to it.
 */
export function TrackChipPopover({
  task,
  open,
  onOpenChange,
  children,
}: {
  task: Task | null
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The chip this bubble points at. */
  children: React.ReactNode
}) {
  const router = useRouter()

  return (
    <Popover open={open && task !== null} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>{children}</PopoverAnchor>
      {task && (
        <PopoverContent
          align="start"
          sideOffset={8}
          // Never wider than the phone it is on, and never wider than it needs.
          className="w-[min(20rem,calc(100vw-2rem))] p-0"
          data-track-popover={task.id}
          // The chip owns the pointer that opened this. Without these, the
          // long-press's own pointerup lands on the popover's outside-press
          // handler and closes it in the same gesture that opened it.
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <QuotaSummary task={task} onOpen={() => router.push(`/tasks/${task.id}`)} />
        </PopoverContent>
      )}
    </Popover>
  )
}

function QuotaSummary({ task, onOpen }: { task: Task; onOpen: () => void }) {
  const state = trackState(task)
  const period = periodLabel(task.rrule)
  const cadence = task.rrule ? formatRRule(task.rrule, task.anchor_time) : null

  return (
    <div className="space-y-3 p-3">
      <div>
        <p className="text-sm leading-snug font-medium">{task.title}</p>
        <p className="text-muted-foreground text-xs tabular-nums">
          {state.current} of {state.target}
          {period ? ` ${period}` : ''}
          {cadence ? ` · ${cadence}` : ''}
        </p>
      </div>

      <div className="border-t pt-2.5">
        {task.notes ? (
          <p className="text-[13px] leading-relaxed whitespace-pre-wrap">{task.notes}</p>
        ) : (
          <p className="text-muted-foreground text-xs italic">
            No note yet — open it to say what this one means.
          </p>
        )}
      </div>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 border-t pt-2.5 text-xs">
        <div>
          <dt className="text-muted-foreground">Periods met</dt>
          {/* "Never yet" is a real answer and usually the useful one. */}
          <dd className="tabular-nums">
            {task.completion_count > 0 ? `${task.completion_count}×` : 'Never yet'}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Tracking since</dt>
          <dd>{formatMonth(task.created_at)}</dd>
        </div>
      </dl>

      <Button size="sm" className="w-full" onClick={onOpen}>
        Open
      </Button>
    </div>
  )
}

/** "March 2026" — the month is the useful grain for a quota's history. */
function formatMonth(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}
