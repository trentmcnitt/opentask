'use client'

import { RowPeekBody, RowPeekPopover } from '@/components/RowPeekPopover'
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
 * NOTES ARE THE POINT. Before this the only way to read a thought's note
 * from the dashboard was to open the full editor and then close it again.
 * (Since 2026-09-25 a panel row wears the surface's `NotesMarker` when it has
 * notes, so the row says there is one; this is still where it is read.) (Rows used to truncate too,
 * which gave this a second job; they wrap in full as of 2026-09-21, so notes
 * are now the whole reason it exists.) This reads and does not edit, exactly
 * as the quota bubble does; Open is the way through to `ReminderDetailModal`,
 * and this component neither knows nor decides what "open" means.
 *
 * The bubble's shell and body are `RowPeekPopover` / `RowPeekBody`, shared
 * with the task-segment rows' peek (2026-10-20) so the two stay one shape.
 */
export function ReminderRowPopover({
  reminder,
  timeSlots,
  timezone,
  open,
  onOpenChange,
  onOpen,
  onDelete,
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
  /** Move it to Trash. Soft, undoable, and asks nothing first — see
   *  `PopoverFooter`. */
  onDelete: (reminder: Task) => void
  /** The row this bubble points at. */
  children: React.ReactNode
}) {
  return (
    <RowPeekPopover
      open={open}
      onOpenChange={onOpenChange}
      contentProps={reminder ? { 'data-reminder-popover': reminder.id } : undefined}
      content={
        reminder && (
          <ReminderSummary
            reminder={reminder}
            timeSlots={timeSlots}
            timezone={timezone}
            onOpen={() => onOpen(reminder)}
            onDelete={() => onDelete(reminder)}
          />
        )
      }
    >
      {children}
    </RowPeekPopover>
  )
}

function ReminderSummary({
  reminder,
  timeSlots,
  timezone,
  onOpen,
  onDelete,
}: {
  reminder: Task
  timeSlots: TimeSlot[]
  timezone: string
  onOpen: () => void
  onDelete: () => void
}) {
  // The same two halves the editor's own summary line is built from, so the
  // bubble and the editor behind it can never describe one schedule
  // differently.
  const schedule = readSchedule(reminder, timezone)
  const cadence = describeCadence(schedule)
  const time = describeTimeOfDay(schedule.time, timeSlots)

  return (
    <RowPeekBody
      title={reminder.title}
      meta={
        <p className="text-muted-foreground text-xs">
          {cadence}
          {time ? ` · ${time}` : ''}
        </p>
      }
      notes={reminder.notes}
      onOpen={onOpen}
      onDelete={onDelete}
      deleteLabel={`Move "${reminder.title}" to Trash`}
    />
  )
}
