'use client'

import { CheckCheck } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatClockTime } from '@/lib/time-utils'
import { slotGroupKey, slotLabel } from '@/lib/reminder-slots'
import type { RemindersSummary } from '@/lib/reminders-summary'
import { groupConsidered, groupWaiting } from '@/lib/quota-prompts'
import type { ReminderGroup } from '@/hooks/useReminders'
import { MIN_SEGMENT_PX, SegmentDivider } from '@/components/ReminderSlotBar'
import { DayBarFill, DayBarTrack } from '@/components/DayBar'
import { segmentColor, segmentCounts, segmentKey, segmentLabel } from '@/components/TaskSegmentRow'
import type { SegmentView } from '@/hooks/useTaskSegments'

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
 *
 * The task segments follow the slots (2026-10-11), after a faint divider, in
 * their teal — the dashboard strip's bars, so a segment reads the same on
 * both surfaces; a tap scrolls to its section. They are NOT in the line or
 * the count: task rows never count in "N waiting so far" or "X of Y
 * considered" (docs/TASK-MODEL.md § Task segments).
 */
export function RemindersHeadline({
  summary,
  allWaitingDone,
  onConsiderSoFar,
  onGoToSlot,
  taskSegments = [],
}: {
  summary: RemindersSummary<ReminderGroup>
  allWaitingDone: boolean
  onConsiderSoFar: () => void
  /** A segment was tapped: open that slot and scroll to it (`goToSlot` in `RemindersView`). */
  onGoToSlot: (key: string) => void
  /** Today's task segments, drawn after the slots (never counted). */
  taskSegments?: SegmentView[]
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
            const key = slotGroupKey(g)
            return (
              <DayBarButton
                key={key}
                id={key}
                label={slotLabel(g)}
                considered={considered}
                total={groupWaiting(g) + considered}
                started={summary.started.includes(g)}
                onClick={() => onGoToSlot(key)}
              />
            )
          })}
          {taskSegments.length > 0 && segments.length > 0 && (
            <span className="flex items-center self-center">
              <SegmentDivider />
            </span>
          )}
          {taskSegments.map((segment) => {
            const { handled, total } = segmentCounts(segment)
            const key = segmentKey(segment)
            return (
              <DayBarButton
                key={key}
                id={key}
                label={segmentLabel(segment)}
                considered={handled}
                total={total}
                started
                color={segmentColor(segment.horizon)}
                onClick={() => onGoToSlot(key)}
              />
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

/**
 * One segment of the day bar: a slot, or a task segment in its teal. Blue (a
 * task segment: its teal) while still filling, green the moment it's done —
 * matches the dashboard's `ReminderSlotBar` (2026-09-22), so a segment reads
 * the same way on both surfaces.
 */
function DayBarButton({
  id,
  label,
  considered,
  total,
  started,
  color,
  onClick,
}: {
  id: string
  label: string
  considered: number
  total: number
  started: boolean
  color?: string
  onClick: () => void
}) {
  const done = total > 0 && considered >= total
  return (
    <button
      type="button"
      onClick={onClick}
      data-day-segment={id}
      aria-label={`Go to ${label}, ${considered} of ${total} considered`}
      title={`${label} · ${considered} of ${total} considered`}
      style={{ flexGrow: total, flexBasis: 0, minWidth: MIN_SEGMENT_PX }}
      className="group rounded-full py-1.5 focus-visible:outline-none"
    >
      <DayBarTrack
        className={cn(
          'transition-colors',
          'group-focus-visible:ring-ring group-focus-visible:ring-offset-background group-focus-visible:ring-2 group-focus-visible:ring-offset-1',
          started ? 'group-hover:bg-foreground/15' : 'bg-muted/50 group-hover:bg-foreground/10',
        )}
      >
        <DayBarFill fraction={total > 0 ? considered / total : 0} done={done} color={color} />
      </DayBarTrack>
    </button>
  )
}
