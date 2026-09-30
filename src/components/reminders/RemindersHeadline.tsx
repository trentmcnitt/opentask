'use client'

import { CheckCheck } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatClockTime } from '@/lib/time-utils'
import { slotGroupKey, slotLabel } from '@/lib/reminder-slots'
import type { RemindersSummary } from '@/lib/reminders-summary'
import { groupConsidered, groupWaiting } from '@/lib/quota-prompts'
import type { ReminderGroup } from '@/hooks/useReminders'
import { MIN_SEGMENT_PX } from '@/components/ReminderSlotBar'

/**
 * The headline: one short line for "what now" (never a breakdown — the slot
 * headers below ARE the breakdown, one per line), the one-tap "Considered all
 * so far", and the day's bar.
 *
 * The bar is segmented, one segment per slot in the same order as the groups
 * below and sized by how much each slot held today, so the shape of the day
 * is readable at a glance and every considered thought visibly moves it.
 * Slots that haven't started yet are drawn fainter: "not yet" must not read
 * as "not done". A segment turns green when its slot is finished — a small
 * win each time — and the number goes green when the day is.
 */
export function RemindersHeadline({
  summary,
  allWaitingDone,
  onConsiderSoFar,
  onGoToSlot,
}: {
  summary: RemindersSummary<ReminderGroup>
  allWaitingDone: boolean
  onConsiderSoFar: () => void
  /** A segment was tapped: open that slot and scroll to it (`goToSlot` in `RemindersView`). */
  onGoToSlot: (key: string) => void
}) {
  let line: React.ReactNode
  if (allWaitingDone) {
    line = <span className="text-foreground font-medium">All clear for today</span>
  } else if (summary.waitingSoFar === 0 && summary.nextUp) {
    line = (
      <>
        <span className="text-foreground font-medium">
          Caught up until {summary.nextUp.slot.label}
        </span>
        <span className="text-muted-foreground">
          {' '}
          &middot; {formatClockTime(summary.nextUp.slot.start_time)}
        </span>
      </>
    )
  } else {
    line = (
      <span className="text-foreground font-medium" data-waiting-so-far={summary.waitingSoFar}>
        {summary.waitingSoFar} waiting so far
      </span>
    )
  }

  const segments = [...summary.started, ...summary.later]
  const dayDone = summary.dayTotal > 0 && summary.consideredTotal >= summary.dayTotal

  return (
    <div className="mb-4 px-2" data-reminders-headline>
      <div className="flex items-center justify-between gap-3">
        <h1 className="min-w-0 text-sm">{line}</h1>
        {summary.waitingSoFar > 0 && (
          <button
            type="button"
            onClick={onConsiderSoFar}
            aria-label={`Mark all ${summary.waitingSoFar} waiting so far as considered`}
            className="text-muted-foreground hover:bg-foreground/5 hover:text-foreground inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors"
          >
            <CheckCheck className="size-3.5" strokeWidth={2.5} />
            <span className="hidden sm:inline">Considered all so far</span>
            <span className="sm:hidden">All so far</span>
          </button>
        )}
      </div>

      <div className="mt-3 flex items-center">
        {/* EACH SEGMENT GOES TO ITS PERIOD (2026-09-25) — the dashboard card's
            `ReminderSlotBar` pages to a slot on a tap, and this is the same
            idea on a page that scrolls: open the section if it was folded,
            then bring its header up under the top bar (`goToSlot`, the
            `?slot=` deep link's own move). So the segments are buttons in a
            group, and the day's progressbar semantics moved to the count
            beside them — a progressbar's children are presentational, so it
            cannot hold anything a keyboard or a screen reader can press.
            Every segment is at least the card bar's `MIN_SEGMENT_PX` wide (it
            was 6px while the bar was only a picture): a period holding 1 of
            the day's 60 must still be something a thumb can hit, Trent's own
            worry about that bar. The hit area is also taller than the 8px bar (padding, cancelled by the
            negative margin) so a thumb can land on it; hover only darkens the
            track a shade, since the fill is the thing to read. */}
        <div className="-my-1.5 flex w-full gap-[3px]" role="group" aria-label="Go to a period">
          {segments.map((g) => {
            const considered = groupConsidered(g)
            const slotTotal = groupWaiting(g) + considered
            const done = slotTotal > 0 && considered >= slotTotal
            const label = slotLabel(g)
            const started = summary.started.includes(g)
            const key = slotGroupKey(g)
            return (
              <button
                key={key}
                type="button"
                onClick={() => onGoToSlot(key)}
                data-day-segment={key}
                aria-label={`Go to ${label}, ${considered} of ${slotTotal} considered`}
                title={`${label} · ${considered} of ${slotTotal} considered`}
                style={{ flexGrow: slotTotal, flexBasis: 0, minWidth: MIN_SEGMENT_PX }}
                className="group rounded-full py-1.5 focus-visible:outline-none"
              >
                <span
                  className={cn(
                    'relative block h-2 overflow-hidden rounded-full transition-colors',
                    'group-focus-visible:ring-ring group-focus-visible:ring-offset-background group-focus-visible:ring-2 group-focus-visible:ring-offset-1',
                    started
                      ? 'bg-muted group-hover:bg-foreground/15'
                      : 'bg-muted/50 group-hover:bg-foreground/10',
                  )}
                >
                  <span
                    className={cn(
                      'block h-full rounded-full transition-[width,background-color] duration-500 ease-out',
                      // Blue while still filling, green the moment it's done —
                      // matches the dashboard's `ReminderSlotBar` (2026-09-22),
                      // so a slot reads the same way on both surfaces.
                      done ? 'bg-green-600' : 'bg-indigo-600',
                    )}
                    style={{ width: `${slotTotal > 0 ? (considered / slotTotal) * 100 : 0}%` }}
                  />
                </span>
              </button>
            )
          })}
        </div>
        <span
          className="ml-3 shrink-0 text-xs tabular-nums"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={summary.dayTotal}
          aria-valuenow={summary.consideredTotal}
          aria-label={`${summary.consideredTotal} of ${summary.dayTotal} considered today`}
        >
          {dayDone ? (
            <span className="text-green-700 dark:text-green-400">
              All {summary.dayTotal} considered today
            </span>
          ) : (
            <>
              <span className="text-foreground font-medium">{summary.consideredTotal}</span>
              <span className="text-muted-foreground hidden sm:inline">
                {' '}
                of {summary.dayTotal} considered
              </span>
              <span className="text-muted-foreground sm:hidden"> / {summary.dayTotal}</span>
            </>
          )}
        </span>
      </div>
    </div>
  )
}
