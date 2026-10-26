'use client'

import { useState } from 'react'
import { DateTime } from 'luxon'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { formatDateTime } from '@/lib/format-date'
import { occurrenceTarget, skipUntilFirstDay } from '@/lib/task-segments'
import { useDayStart } from '@/components/PreferencesProvider'
import { taskWord } from '@/lib/utils'
import type { Task } from '@/types'

/**
 * THE SKIP UNTIL PICKER (task queue PR 4; spec rule 10), shared by the Quick
 * panel's More menu (one task) and the selection sheet (several).
 *
 * "A tap with the default skips this occurrence; a date skips every
 * occurrence before it (the vacation case)." So the first button is the
 * default — skip this one — and the calendar below is the vacation case: pick
 * a day and every occurrence before it goes, each task landing on its first
 * one on or after that day.
 *
 * The calendar starts at tomorrow in the user's timezone (today would skip
 * nothing on a task already due later today, and the API refuses the past).
 * Its days are the browser's local dates, read back as the user's calendar
 * day (`yyyy-MM-dd`) — the date the user tapped, whatever the browser's zone.
 *
 * `onSkip` does the request and the toast (`runSkipUntil`); it rejects on a
 * failure, which keeps the picker open for a retry.
 */
export function SkipUntilDialog({
  open,
  onOpenChange,
  tasks,
  leftAlone = 0,
  timezone,
  onSkip,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The tasks it applies to (repeating, not reminders or quotas). */
  tasks: Task[]
  /** Selected tasks it does not apply to, said in the description. */
  leftAlone?: number
  timezone: string
  onSkip: (until: string | null) => Promise<void>
}) {
  const [picked, setPicked] = useState<Date | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  const dayStart = useDayStart()
  // The first pickable day: the OpenTask day after today's (`skipUntilFirstDay`,
  // the server's floor too) — at 00:30 with a 3:00 AM start, the calendar today.
  const tomorrow = DateTime.fromISO(skipUntilFirstDay(timezone, new Date(), dayStart))
  const firstDay = new Date(tomorrow.year, tomorrow.month - 1, tomorrow.day)
  const pickedDay = picked
    ? DateTime.fromObject({
        year: picked.getFullYear(),
        month: picked.getMonth() + 1,
        day: picked.getDate(),
      })
    : null

  // Every way out — Cancel, Escape, the overlay, a done skip — goes through
  // here, so the next open starts with no day picked.
  const close = () => {
    setPicked(undefined)
    onOpenChange(false)
  }

  const run = async (until: string | null) => {
    setBusy(true)
    try {
      await onSkip(until)
      close()
    } catch {
      // Toasted by the host; the picker stays open.
    } finally {
      setBusy(false)
    }
  }

  const single = tasks.length === 1 ? tasks[0] : null
  // The occurrence's own TARGET day (2026-10-21): on a deadline-anchored
  // repeat the occurrence is its deadline, and the words name when it nags.
  const occurrence = single ? occurrenceTarget(single, timezone) : null
  const others = leftAlone > 0 ? ` · ${leftAlone} other ${taskWord(leftAlone)} left as is` : ''

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) onOpenChange(true)
        else if (!busy) close()
      }}
    >
      <DialogContent className="w-[22rem] max-w-[calc(100%-2rem)] p-4" data-skip-until-dialog>
        <DialogHeader>
          <DialogTitle className="truncate pr-6">
            {single ? `Skip "${single.title}"` : 'Skip until…'}
          </DialogTitle>
          <DialogDescription>
            {single
              ? occurrence
                ? `This occurrence: ${formatDateTime(occurrence, timezone)}`
                : 'Skip this occurrence, or every one before a day'
              : `${tasks.length} repeating ${taskWord(tasks.length)}${others}`}
          </DialogDescription>
        </DialogHeader>

        <Button
          type="button"
          disabled={busy}
          onClick={() => void run(null)}
          data-skip-this-one
          className="w-full"
        >
          Skip this occurrence
        </Button>

        <div className="border-t pt-3">
          <p className="text-muted-foreground mb-1 text-xs">
            Or skip every occurrence before a day:
          </p>
          <div className="flex justify-center">
            <Calendar
              mode="single"
              selected={picked}
              onSelect={setPicked}
              defaultMonth={firstDay}
              disabled={{ before: firstDay }}
            />
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button type="button" variant="outline" disabled={busy} onClick={close}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={!pickedDay || busy}
            onClick={() => pickedDay && void run(pickedDay.toFormat('yyyy-MM-dd'))}
            data-skip-until-submit
          >
            {pickedDay ? `Skip until ${pickedDay.toFormat('ccc, LLL d')}` : 'Pick a day'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
