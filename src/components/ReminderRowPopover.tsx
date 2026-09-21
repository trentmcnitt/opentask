'use client'

import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { describeCadence, describeTimeOfDay, readSchedule } from '@/lib/reminder-rule'
import type { TimeSlot } from '@/lib/time-slot-assign'
import type { Task } from '@/types'

/**
 * What a reminder is, in a bubble anchored to its own row.
 *
 * The quota chips' `TrackChipPopover`, applied to the reminders panel — same
 * gesture, same shape, same two steps. Trent, 2026-09-21: "Can we do the same
 * thing that we do for quotas, where if I press and hold I can get the details
 * and then press Open to trigger the modal? I feel like there are some times
 * I'm going to want notes."
 *
 * NOTES ARE THE POINT. A panel row is one clamped line and carries no note
 * indicator at all, so before this the only way to read a thought's note from
 * the dashboard was to open the full editor and then close it again. This
 * reads and does not edit, exactly as the quota bubble does; Open is the way
 * through to `ReminderDetailModal`, and this component neither knows nor
 * decides what "open" means.
 *
 * `PopoverAnchor` rather than `PopoverTrigger`, for the same reason the quota
 * bubble uses it: the row already owns this pointer (a long press), and a
 * trigger would fight that gesture for it.
 *
 * Deliberately NOT on hover. Trent, same message: "if you hover for a while on
 * an item, it'll show the notes in a little popover. It might be a little
 * messy though. Let's not do that just yet."
 */
export function ReminderRowPopover({
  reminder,
  timeSlots,
  timezone,
  open,
  onOpenChange,
  onOpen,
  children,
}: {
  reminder: Task | null
  timeSlots: TimeSlot[]
  timezone: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The bubble's own "Open" button was pressed — the caller decides what that
   *  means (opening `ReminderDetailModal`, as the panel does it). */
  onOpen: (reminder: Task) => void
  /** The row this bubble points at. */
  children: React.ReactNode
}) {
  return (
    <Popover open={open && reminder !== null} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>{children}</PopoverAnchor>
      {reminder && (
        <PopoverContent
          align="start"
          sideOffset={8}
          // Never wider than the phone it is on, and never wider than it needs.
          className="w-[min(20rem,calc(100vw-2rem))] p-0"
          data-reminder-popover={reminder.id}
          // The row owns the pointer that opened this. Without this, the long
          // press's own pointerup lands on the popover's outside-press handler
          // and closes it in the same gesture that opened it.
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <ReminderSummary
            reminder={reminder}
            timeSlots={timeSlots}
            timezone={timezone}
            onOpen={() => onOpen(reminder)}
          />
        </PopoverContent>
      )}
    </Popover>
  )
}

function ReminderSummary({
  reminder,
  timeSlots,
  timezone,
  onOpen,
}: {
  reminder: Task
  timeSlots: TimeSlot[]
  timezone: string
  onOpen: () => void
}) {
  // The same two halves the editor's own summary line is built from, so the
  // bubble and the editor behind it can never describe one schedule
  // differently.
  const schedule = readSchedule(reminder, timezone)
  const cadence = describeCadence(schedule)
  const time = describeTimeOfDay(schedule.time, timeSlots)

  return (
    <div className="space-y-3 p-3">
      <div>
        {/* Unclamped: the row it points at is the clamped one, and reading the
            whole thought is half of why this bubble exists. */}
        <p className="text-sm leading-snug font-medium">{reminder.title}</p>
        <p className="text-muted-foreground text-xs">
          {cadence}
          {time ? ` · ${time}` : ''}
        </p>
      </div>

      <div className="border-t pt-2.5">
        {reminder.notes ? (
          <p className="text-[13px] leading-relaxed whitespace-pre-wrap">{reminder.notes}</p>
        ) : (
          <p className="text-muted-foreground text-xs italic">
            No note yet — open it to say what this one is for.
          </p>
        )}
      </div>

      <Button size="sm" className="w-full" onClick={onOpen}>
        Open
      </Button>
    </div>
  )
}
