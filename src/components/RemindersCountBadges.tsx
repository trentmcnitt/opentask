'use client'

import { useState } from 'react'
import { CountBadge } from '@/components/CountBadge'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { useRemindersSummary } from '@/hooks/useReminders'

/**
 * The Reminders page's top-bar pills, in the slot where the Tasks page shows
 * its task counts.
 *
 * Two numbers, the same two the headline below keeps: waiting so far (the
 * nav badge's number, neutral — reminders are never debt, so never red) and
 * considered today (green, the day's score). A pill only appears when its
 * number is above zero, so a finished day reads as a single green pill and a
 * day with nothing in it shows none. Tap opens a popover that spells them
 * out, with "later today" — the slots that haven't started — as the third
 * line, since it is context rather than a call to act.
 */
export function RemindersCountBadges({ timezone }: { timezone: string }) {
  const summary = useRemindersSummary(timezone)
  const [popoverOpen, setPopoverOpen] = useState(false)
  if (!summary || summary.dayTotal === 0) return null

  const { waitingSoFar, waitingLater, consideredTotal } = summary
  return (
    <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
      <PopoverTrigger asChild>
        <div
          className="flex flex-shrink-0 cursor-pointer items-center gap-1"
          role="group"
          aria-label="Reminder counts"
          tabIndex={0}
          data-reminders-counts
        >
          {waitingSoFar > 0 && (
            <CountBadge
              count={waitingSoFar}
              tooltip={popoverOpen ? undefined : `${waitingSoFar} waiting so far`}
              className="inline-flex items-center justify-center select-none"
            />
          )}
          {consideredTotal > 0 && (
            <CountBadge
              count={consideredTotal}
              variant="done"
              tooltip={popoverOpen ? undefined : `${consideredTotal} considered today`}
              className="inline-flex items-center justify-center select-none"
            />
          )}
        </div>
      </PopoverTrigger>
      <PopoverContent className="w-auto px-3 py-2 text-xs" sideOffset={6}>
        <div className="flex flex-col gap-1">
          <span>{waitingSoFar} waiting so far</span>
          {waitingLater > 0 && (
            <span className="text-muted-foreground">{waitingLater} later today</span>
          )}
          <span className="text-green-700 dark:text-green-400">
            {consideredTotal} considered today
          </span>
        </div>
      </PopoverContent>
    </Popover>
  )
}
