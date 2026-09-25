'use client'

import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { PopoverFooter } from '@/components/ReminderRowPopover'
import { periodLabel, type TrackState } from '@/lib/track'
import { formatRRule } from '@/lib/format-rrule'
import { cn } from '@/lib/utils'
import type { TimeSlot } from '@/lib/time-slot-assign'
import type { Task } from '@/types'

/**
 * A quota PROMPT's period chips (2026-09-25). Only a prompt's bubble passes
 * this — a Track chip has no one period to show.
 */
export interface PromptPeriods {
  /** The user's periods, by start time. */
  slots: TimeSlot[]
  /** The period the prompt is in now. */
  currentId: number | null
  /** What the chips place: "Reminds me in", or a daily row's own numbers. */
  label: string
  onPick: (slot: TimeSlot) => void
}

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
 * It reads and does not edit ("I don't want an editable field"). Editing is
 * one tap further in, behind the Open button — which opens `QuotaDetailModal`
 * IN PLACE rather than navigating to the task page (Trent, 2026-09-21:
 * "whenever I do things with tasks it opens a modal for me to do my work...
 * that's how I like to work: with a modal"). This component only tells its
 * caller the Open button was pressed; it does not know or decide what "open"
 * means, which is also the answer to "how do I even edit the Track items" —
 * a quota is an ordinary task, edited the same way any other one is.
 *
 * ONE EXCEPTION, for a quota PROMPT (2026-09-25): its bubble also carries the
 * period chips (`periods`). Trent wanted a faster way to move a prompt for
 * good than Open → the editor's period picker, and the bubble is where a
 * prompt's hold already lands. One tap is the editor's own write (a PATCH of
 * `quota_prompt_config`) with an Undo toast, so it earns its place here
 * without making this an editor: nothing is typed, nothing is staged.
 */
export function TrackChipPopover({
  task,
  state,
  open,
  onOpenChange,
  onOpen,
  onDelete,
  periods,
  children,
}: {
  task: Task | null
  /** The chip's own live count, so the bubble cannot disagree with the chip it
   *  points at while a tap is still in flight. */
  state: TrackState
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The popover's own "Open" button was pressed — the caller decides what
   *  that means (opening `QuotaDetailModal`, as `TrackPanel` does it). */
  onOpen: (task: Task) => void
  /** Move it to Trash. Soft, undoable, and asks nothing first — see
   *  `PopoverFooter`. */
  onDelete: (task: Task) => void
  /** A prompt's bubble only: its period chips. */
  periods?: PromptPeriods
  /** The chip this bubble points at. */
  children: React.ReactNode
}) {
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
          <QuotaSummary
            task={task}
            state={state}
            onOpen={() => onOpen(task)}
            onDelete={() => onDelete(task)}
            periods={periods}
          />
        </PopoverContent>
      )}
    </Popover>
  )
}

function QuotaSummary({
  task,
  state,
  onOpen,
  onDelete,
  periods,
}: {
  task: Task
  state: TrackState
  onOpen: () => void
  onDelete: () => void
  periods?: PromptPeriods
}) {
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

      {periods && periods.slots.length > 0 && <PeriodChips periods={periods} />}

      <PopoverFooter
        onOpen={onOpen}
        onDelete={onDelete}
        deleteLabel={`Move "${task.title}" to Trash`}
      />
    </div>
  )
}

/**
 * The period chips: the quota editor's own (`QuotaPromptField`), one row of
 * the user's periods in start order with the current one pressed, in a
 * section of its own like the bubble's others. A tap on the pressed chip does
 * nothing — the prompt is already there.
 */
function PeriodChips({ periods }: { periods: PromptPeriods }) {
  return (
    <div className="space-y-1.5 border-t pt-2.5" data-prompt-periods>
      <p className="text-muted-foreground text-xs">{periods.label}</p>
      <div className="flex flex-wrap gap-1.5">
        {periods.slots.map((slot) => {
          const pressed = slot.id === periods.currentId
          return (
            <button
              key={slot.id}
              type="button"
              onClick={() => !pressed && periods.onPick(slot)}
              aria-pressed={pressed}
              data-prompt-period={slot.id}
              className={cn(
                'rounded-full border px-3 py-1 text-sm transition-colors',
                pressed
                  ? 'border-foreground bg-foreground text-background'
                  : 'hover:border-foreground/40',
              )}
            >
              {slot.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** "March 2026" — the month is the useful grain for a quota's history. */
function formatMonth(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}
