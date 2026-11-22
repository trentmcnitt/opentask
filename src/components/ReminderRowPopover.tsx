'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { RowPeekBody, RowPeekPopover } from '@/components/RowPeekPopover'
import type { PeekTextChanges, PeekTextEdit } from '@/components/PeekText'
import { useDayStart } from '@/components/PreferencesProvider'
import { reminderInListHref } from '@/lib/show-in-list'
import { describeCadence, describeTimeOfDay, readSchedule } from '@/lib/reminder-rule'
import { laterPeriodsToday } from '@/lib/reminder-move'
import { assignSlot, type TimeSlot } from '@/lib/time-slot-assign'
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
 *
 * LATER TODAY (2026-11-21, the one-day move): under the meta, a chip per
 * period the reminder can still move to today (`laterPeriodsToday`) — a tap
 * moves it there for today only (`useReminders().moveForToday`), with the
 * usual Undo toast. The meta keeps naming its HOME period (its schedule);
 * once moved, the line says where it is now: "Later today (now Afternoon):".
 * No later period, no line.
 */
export function ReminderRowPopover({
  reminder,
  timeSlots,
  timezone,
  slot,
  open,
  onOpenChange,
  onOpen,
  onDelete,
  onMove,
  onEdit,
  children,
}: {
  reminder: Task | null
  timeSlots: TimeSlot[]
  timezone: string
  /** The period the reminder is in today — its home one, or the one it was moved to. */
  slot: TimeSlot | null
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The bubble's own "Open" button was pressed — the caller decides what that
   *  means (opening `ReminderDetailModal`, as the panel does it). */
  onOpen: (reminder: Task) => void
  /** Move it to Trash. Soft, undoable, and asks nothing first — see
   *  `PopoverFooter`. */
  onDelete: (reminder: Task) => void
  /** A Later today chip: move it to that period for today. */
  onMove: (reminder: Task, to: TimeSlot) => void
  /** Saves an edit of the title or note in place (`PeekText`). */
  onEdit?: (reminder: Task, changes: PeekTextChanges) => Promise<unknown> | void
  /** The row this bubble points at. */
  children: React.ReactNode
}) {
  const router = useRouter()
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
            slot={slot}
            onMove={(to) => onMove(reminder, to)}
            onOpen={() => onOpen(reminder)}
            // Its row in its period on the Reminders tab (`reminderInListHref`).
            onShowInList={() => {
              onOpenChange(false)
              router.push(reminderInListHref(reminder.id))
            }}
            onDelete={() => onDelete(reminder)}
            onEdit={onEdit && ((changes) => onEdit(reminder, changes))}
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
  slot,
  onMove,
  onOpen,
  onShowInList,
  onDelete,
  onEdit,
}: {
  reminder: Task
  timeSlots: TimeSlot[]
  timezone: string
  slot: TimeSlot | null
  onMove: (to: TimeSlot) => void
  onOpen: () => void
  onShowInList: () => void
  onDelete: () => void
  onEdit?: PeekTextEdit
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
        <>
          <p className="text-muted-foreground text-xs">
            {cadence}
            {time ? ` · ${time}` : ''}
          </p>
          <LaterToday
            reminder={reminder}
            slot={slot}
            timeSlots={timeSlots}
            timezone={timezone}
            onMove={onMove}
          />
        </>
      }
      notes={reminder.notes}
      onOpen={onOpen}
      onShowInList={onShowInList}
      onDelete={onDelete}
      onEdit={onEdit}
      deleteLabel={`Move "${reminder.title}" to Trash`}
    />
  )
}

/**
 * "Later today:" and a chip per later period (the one-day move). The chips
 * are the quota bubble's period chips (`TrackChipPopover`), at their compact
 * size, so a bubble has one kind of period chip; none is pressed — where the
 * reminder is now is never offered.
 *
 * `now` is the moment the bubble opened (it mounts with each opening): a
 * period that starts while it is open is refused by the server with a toast
 * that says so, and the next opening no longer offers it.
 */
function LaterToday({
  reminder,
  slot,
  timeSlots,
  timezone,
  onMove,
}: {
  reminder: Task
  slot: TimeSlot | null
  timeSlots: TimeSlot[]
  timezone: string
  onMove: (to: TimeSlot) => void
}) {
  const dayStart = useDayStart()
  const [openedAt] = useState(() => new Date())
  const later = laterPeriodsToday(slot, timeSlots, openedAt, timezone, dayStart)
  if (later.length === 0) return null
  // Moved: it is not in the period its schedule says (the meta's).
  const home = assignSlot(reminder, timeSlots, timezone)
  const moved = slot !== null && slot.id !== home?.id
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1" data-reminder-later>
      <span className="text-muted-foreground mr-0.5 text-xs" data-reminder-later-label>
        {moved ? `Later today (now ${slot.label}):` : 'Later today:'}
      </span>
      {later.map((to) => (
        <button
          key={to.id}
          type="button"
          onClick={() => onMove(to)}
          data-reminder-later-period={to.id}
          aria-label={`Move to ${to.label} for today`}
          className="hover:border-foreground/40 rounded-full border px-2 py-0.5 text-xs transition-colors"
        >
          {to.label}
        </button>
      ))}
    </div>
  )
}
